/** Additive coordinator for stock DSH model selection transitions. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import {
  CrossBackendTransactionController,
  resolveCrossBackendLocation,
} from '../data/cross-backend-controller.ts'
import type {
  CrossBackendModelSelection,
  CrossBackendTicket,
} from '../data/cross-backend-controller.ts'

type ModelProjection = {
  readonly lastUsed: CrossBackendModelSelection | null
  readonly next: CrossBackendModelSelection | null
}

export interface CrossBackendPending {
  readonly ticket: CrossBackendTicket
  readonly error: string | null
  readonly blockingReason?: 'no-location'
  readonly confirmable: boolean
  readonly busy: boolean
}

export interface CrossBackendCoordinatorSnapshot {
  readonly pending: CrossBackendPending | null
}

export type OwnsAcpRoute = (provider: string | undefined) => boolean

export function isAcpRoute(provider: string | undefined, ownsRoute: OwnsAcpRoute): boolean {
  return provider !== undefined && ownsRoute(provider)
}

function sameSelection(left: CrossBackendModelSelection | null | undefined, right: CrossBackendModelSelection | null | undefined): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort
}

/** Pure observation decision, independent of React and side effects. */
export function shouldConfirmBackendTransition(input: {
  readonly lastUsed: CrossBackendModelSelection | null
  readonly next: CrossBackendModelSelection | null
  readonly blank: boolean
}, ownsRoute: OwnsAcpRoute): boolean {
  if (input.next === null || sameSelection(input.lastUsed, input.next)) return false
  const fromAcp = isAcpRoute(input.lastUsed?.provider, ownsRoute)
  const toAcp = isAcpRoute(input.next.provider, ownsRoute)
  if (!fromAcp && !toAcp) return false
  if (input.blank && input.lastUsed === null && toAcp) return false
  if (fromAcp && toAcp && input.lastUsed?.provider === input.next.provider) return false
  return true
}

export class CrossBackendCoordinator {
  private readonly tx = new CrossBackendTransactionController()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribers: Array<() => void> = []
  private currentSessionId: SessionId | undefined
  private projectionUnsubscribe: (() => void) | undefined
  private lastProjection: ModelProjection | undefined
  private suppressedSelection: { readonly sessionId: SessionId; readonly selection: CrossBackendModelSelection } | undefined
  private staging = false
  private pending: CrossBackendPending | null = null
  private snapshot: CrossBackendCoordinatorSnapshot = { pending: null }
  private disposed = false

  constructor(private readonly ctx: Context, private readonly ownsRoute: OwnsAcpRoute) {}

  start(): () => void {
    // dsh-session also exposes a host-side `ctx.sessions` store. Resolve the
    // public client faces through Cordis by name so both packages can coexist
    // in one TypeScript program without merging incompatible Context fields.
    const sessions = this.ctx.get('sessions') as unknown as ISessions | undefined
    if (sessions === undefined || typeof sessions.list?.subscribe !== 'function') {
      return () => this.dispose()
    }
    const selectCurrent = (): void => {
      if (this.disposed) return
      const nextId = sessions.list.getSnapshot().current
      if (nextId === this.currentSessionId && this.projectionUnsubscribe !== undefined) return
      this.detachSession()
      this.currentSessionId = nextId
      if (nextId === undefined) return
      const binding = sessions.binding(nextId)
      const projection = binding?.session.projections.faceOf('modelSelection')
      if (projection === undefined) return
      this.projectionUnsubscribe = projection.subscribe(() => { this.observe(nextId) })
      this.observe(nextId)
    }
    this.unsubscribers.push(sessions.list.subscribe(selectCurrent))
    selectCurrent()
    return () => this.dispose()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): CrossBackendCoordinatorSnapshot {
    return this.snapshot
  }

  async confirm(): Promise<void> {
    const pending = this.pending
    if (pending === null || this.disposed || !pending.confirmable) return
    this.pending = { ...pending, busy: true, error: null }
    this.suppressSelection(pending.ticket.sourceSessionId, pending.ticket.sourceSelection)
    this.emit()
    const result = await this.tx.confirm(pending.ticket, this.operationsFor(pending.ticket))
    if (this.disposed) return
    if (result.ok) {
      this.pending = null
    } else {
      this.pending = { ...pending, busy: false, error: result.failure.message }
    }
    this.emit()
  }

  async cancel(): Promise<void> {
    const pending = this.pending
    if (pending === null || this.disposed || pending.busy) return
    const source = pending.ticket.sourceSelection
    if (source === undefined) {
      this.pending = null
      this.emit()
      return
    }
    this.pending = { ...pending, busy: true, error: null }
    this.suppressSelection(pending.ticket.sourceSessionId, source)
    this.emit()
    const result = await this.tx.cancel(pending.ticket, this.operationsFor(pending.ticket))
    if (this.disposed) return
    if (result.ok) this.pending = null
    else this.pending = { ...pending, busy: false, error: result.failure.message }
    this.emit()
  }

  private observe(sessionId: SessionId): void {
    if (this.disposed || sessionId !== this.currentSessionId) return
    const sessions = this.ctx.get('sessions') as unknown as ISessions
    const session = sessions.binding(sessionId)
    const value = session?.session.projections.faceOf('modelSelection').getSnapshot()
    const projection = value as ModelProjection | undefined
    if (projection === undefined || sameSelection(this.lastProjection?.next, projection.next)) return
    // `lastUsed` is the last committed turn model.  A stock picker change can
    // leave an uncommitted `next` selection in the projection (for example a
    // same-profile reasoning change); if the user immediately chooses another
    // backend, cancellation must restore that visible pre-transition choice,
    // not the older committed model.
    const sourceSelection = this.lastProjection?.next ?? projection.lastUsed
    this.lastProjection = projection
    if (this.suppressedSelection?.sessionId === sessionId
      && sameSelection(this.suppressedSelection.selection, projection.next)) {
      this.suppressedSelection = undefined
      return
    }
    if (this.staging || this.pending !== null) return
    const row = sessions.list.getSnapshot().byId[sessionId]
    if (!shouldConfirmBackendTransition({
      lastUsed: projection.lastUsed,
      next: projection.next,
      blank: row?.blank === true,
    }, this.ownsRoute)) return
    const workspaces = (this.ctx.get('workspaces') as IWorkspaces).list.getSnapshot()
    const location = resolveCrossBackendLocation(sessionId, workspaces.items, row?.cwd)
    if (location === undefined) {
      const ticket: CrossBackendTicket = {
          key: `${sessionId}\u0000${Date.now()}`,
          sourceSessionId: sessionId,
          sourceSelection: sourceSelection ?? undefined,
          targetSelection: projection.next!,
          location: {},
      }
      void this.stagePending(ticket, 'no-location')
      return
    }
    const ticket: CrossBackendTicket = {
        key: `${sessionId}\u0000${Date.now()}\u0000${projection.next!.provider}\u0000${projection.next!.model}`,
        sourceSessionId: sessionId,
        sourceSelection: sourceSelection ?? undefined,
        targetSelection: projection.next!,
        location,
    }
    // The stock picker has already written `next` by the time this additive
    // observer runs. Compensate immediately, before exposing the decision UI,
    // so refresh/close cannot commit an unconfirmed backend transition.
    void this.stagePending(ticket)
  }

  private async stagePending(ticket: CrossBackendTicket, blockingReason?: 'no-location'): Promise<void> {
    if (this.pending !== null || this.staging || this.disposed) return
    const source = ticket.sourceSelection
    if (source === undefined) return
    this.staging = true
    this.suppressSelection(ticket.sourceSessionId, source)
    const restored = await this.operationsFor(ticket).restoreSource(source)
    this.staging = false
    if (this.disposed || this.currentSessionId !== ticket.sourceSessionId) return
    this.pending = restored.ok
      ? {
          ticket: { ...ticket, sourceAlreadyRestored: true },
          error: null,
          ...(blockingReason === undefined ? {} : { blockingReason }),
          confirmable: blockingReason === undefined,
          busy: false,
        }
      : { ticket, error: restored.message ?? 'source model restore failed', confirmable: false, busy: false }
    this.emit()
  }

  private operationsFor(ticket: CrossBackendTicket) {
    const remote = this.ctx.remote as TypertClientRemote
    const sessions = this.ctx.get('sessions') as unknown as ISessions
    return {
      restoreSource: async (selection: CrossBackendModelSelection) => {
        try {
          const result = await remote.session.selectModel({ sessionId: ticket.sourceSessionId as SessionId, ...selection })
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      createDestination: async ({ sessionId, location }: { sessionId: string; location: { workspaceId?: string; cwd?: string } }) => {
        try {
          await sessions.create({
            sessionId: sessionId as SessionId,
            ...(location.cwd === undefined ? {} : { cwd: location.cwd }),
            ...(location.workspaceId === undefined ? {} : { workspaceId: location.workspaceId as never }),
          })
          return { published: true }
        } catch (error) {
          // A transport timeout can race a successful Host create. Reuse the
          // preallocated id when the authoritative list already contains it.
          if (sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined) return { published: true }
          return { published: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      selectDestination: async (sessionId: string, selection: CrossBackendModelSelection) => {
        try {
          const result = await remote.session.selectModel({ sessionId: sessionId as SessionId, ...selection })
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      openDestination: async (sessionId: string) => {
        try {
          sessions.open(sessionId as SessionId)
          return { ok: true }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }
  }

  private emit(): void {
    this.snapshot = { pending: this.pending }
    for (const listener of [...this.listeners]) listener()
  }

  private suppressSelection(sessionId: string, selection: CrossBackendModelSelection | undefined): void {
    if (selection === undefined) return
    this.suppressedSelection = { sessionId: sessionId as SessionId, selection }
  }

  private detachSession(): void {
    this.projectionUnsubscribe?.()
    this.projectionUnsubscribe = undefined
    this.lastProjection = undefined
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachSession()
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.listeners.clear()
  }
}
