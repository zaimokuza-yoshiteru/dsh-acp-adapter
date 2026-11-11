import { SessionForkError, type ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpNativeForkRejection } from '../../contract/remote.ts'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import { NativeForkJournalError, type NativeForkJournal } from './native-fork-journal.ts'

export type NativeForkFailure = 'workspace-attach' | 'storage' | 'access-denied' | AcpNativeForkRejection

export interface NativeForkRecovery {
  readonly kind: 'unknown' | 'abandoned' | 'cleanup'
  readonly scope: string
  readonly source: SessionId
  readonly atSeq: number
  readonly child?: SessionId
  readonly storageFailed?: boolean
}

interface NativeForkDependencies {
  readonly sessions: Pick<ISessions, 'fork'>
  readonly scope: AcpRemoteLike['nativeForkScope']
  readonly register: AcpRemoteLike['registerNativeFork']
  readonly journal: (scope: string, source: string, atSeq: number) => NativeForkJournal
  readonly open: (child: SessionId) => void
  readonly failed: (source: SessionId, child?: SessionId, reason?: NativeForkFailure) => void
}

/** Native creation/catalog/title ownership, with recoverable ACP provenance registration. */
export class AcpNativeForkCoordinator {
  private disposed = false
  private readonly pending = new Map<string, Promise<void>>()
  private recovery: NativeForkRecovery | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: NativeForkDependencies) {}

  readonly getSnapshot = (): NativeForkRecovery | null => this.recovery
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly dismissRecovery = (): void => this.publishRecovery(null)

  private publishRecovery(recovery: NativeForkRecovery | null): void {
    if (this.disposed) return
    this.recovery = recovery
    for (const listener of this.listeners) listener()
  }

  abandon(expected: NativeForkRecovery): void {
    if (this.disposed || this.recovery !== expected || expected.kind !== 'unknown') return
    try {
      this.deps.journal(expected.scope, expected.source, expected.atSeq).abandon()
      this.publishRecovery({ ...expected, kind: 'abandoned', storageFailed: false })
    } catch {
      this.publishRecovery({ ...expected, storageFailed: true })
    }
  }

  /** A separate explicit confirmation starts a new operation; abandonment itself never dispatches. */
  restart(expected: NativeForkRecovery): Promise<void> {
    if (this.disposed || this.recovery !== expected || expected.kind !== 'abandoned') return Promise.resolve()
    this.publishRecovery(null)
    return this.admit(expected.source, expected.atSeq, expected.scope)
  }

  retryCleanup(expected: NativeForkRecovery): void {
    if (this.disposed || this.recovery !== expected || expected.kind !== 'cleanup') return
    try {
      this.deps.journal(expected.scope, expected.source, expected.atSeq).clear()
      this.publishRecovery(null)
    } catch {
      this.publishRecovery({ ...expected, storageFailed: true })
    }
  }

  /**
   * Stop admission and await native calls already sent. Host/Remote withdrawal can
   * happen concurrently; the journal, rather than that Remote's availability,
   * preserves a returned child for an explicit retry after reactivation.
   */
  readonly dispose = async (): Promise<void> => {
    this.disposed = true
    await Promise.allSettled(this.pending.values())
    this.listeners.clear()
  }

  fork(source: SessionId, atSeq: number): Promise<void> {
    return this.admit(source, atSeq)
  }

  private admit(source: SessionId, atSeq: number, restartScope?: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const key = JSON.stringify([source, atSeq])
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending
    const operation = this.perform(source, atSeq, restartScope).finally(() => {
      this.pending.delete(key)
    })
    this.pending.set(key, operation)
    return operation
  }

  private async perform(source: SessionId, atSeq: number, restartScope?: string): Promise<void> {
    let child: SessionId | undefined
    let reason: NativeForkFailure | undefined
    let outcomeUnknown = false
    const failed = (reason?: NativeForkFailure): void => {
      if (!this.disposed) this.deps.failed(source, child, reason)
    }
    try {
      const scope = await this.deps.scope(source)
      if (!scope.ok) {
        failed(
          scope.error.code === 'remote-access/denied' || scope.error.code === 'dsh-acp/user-rejected'
            ? 'access-denied'
            : 'unavailable',
        )
        return
      }
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(scope.value)) {
        failed('unavailable')
        return
      }
      if (this.disposed) return
      const journal = this.deps.journal(scope.value, source, atSeq)
      const intent = journal.read()
      if (intent?.phase === 'creating' || (intent?.phase === 'abandoned' && restartScope !== scope.value)) {
        this.publishRecovery({
          kind: intent.phase === 'creating' ? 'unknown' : 'abandoned',
          scope: scope.value,
          source,
          atSeq,
        })
        return
      }
      if (restartScope !== undefined && (restartScope !== scope.value || intent?.phase !== 'abandoned')) return
      if (intent !== undefined && 'child' in intent) child = intent.child as SessionId
      if (intent?.phase === 'workspace-attach') {
        failed('workspace-attach')
        return
      }
      if (child === undefined) {
        // A lost native response cannot be retried as another creation. Persist
        // uncertainty before dispatch, then refine it as soon as Native names a child.
        journal.write({ phase: 'creating' })
        try {
          child = await this.deps.sessions.fork({
            sessionId: source,
            atSeq,
            increaseTitle: true,
            onCreated: (id) => {
              child = id
              journal.write({ phase: 'created', child: id })
            },
          })
          journal.write({ phase: 'created', child })
        } catch (error) {
          if (
            error instanceof SessionForkError &&
            error.sourceSessionId === source &&
            error.rpcError.code === 'session/workspace-attach-failed'
          ) {
            child = error.rpcError.details.sessionId
            journal.write({ phase: 'workspace-attach', child })
            reason = 'workspace-attach'
          } else if (child === undefined) {
            // These native refusals occur before creation. An internal/transport
            // failure has no such guarantee and leaves the intent unresolved.
            const rejected =
              error instanceof SessionForkError &&
              error.sourceSessionId === source &&
              [
                'gateway/bad-request',
                'remote-access/denied',
                'session/not-found',
                'session/fork-unavailable',
                'session/migration-required',
              ].includes(error.rpcError.code)
            if (rejected) {
              journal.clear()
              if (error.rpcError.code === 'remote-access/denied') reason = 'access-denied'
            } else {
              outcomeUnknown = true
              this.publishRecovery({ kind: 'unknown', scope: scope.value, source, atSeq })
            }
          }
          throw error
        }
      }
      if (this.disposed) return
      const registered = await this.deps.register(child, source, atSeq)
      if (!registered.ok) {
        reason =
          registered.error.code === 'dsh-acp/native-fork-rejected'
            ? registered.error.details.reason
            : registered.error.code === 'remote-access/denied' || registered.error.code === 'dsh-acp/user-rejected'
              ? 'access-denied'
              : undefined
        throw registered.error
      }
      if (this.disposed) return
      this.deps.open(child)
      try {
        journal.clear()
      } catch {
        // Creation, durable provenance and navigation already succeeded. Only
        // recovery-record cleanup remains; retrying it must not create or open.
        this.publishRecovery({ kind: 'cleanup', scope: scope.value, source, atSeq, child })
      }
    } catch (error) {
      if (error instanceof NativeForkJournalError) reason = 'storage'
      if (!outcomeUnknown) failed(reason)
    }
  }
}
