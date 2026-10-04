import {
  RemoteJournalStream,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamFactory,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { AcpActivityView } from '../../contract/remote.ts'
import type { AcpRemoteLike } from './acp-remote.ts'

class ActivityJournalProtocolError extends Error {
  readonly code = 'gateway/internal'
}

/** Client-side projection of the unfiltered, contiguous host journal. */
export class AcpActivityJournalStore {
  private readonly rows = new Map<string, AcpActivityView>()
  private readonly rowsByAnchor = new Map<string, Map<string, AcpActivityView>>()
  private cursor = 0

  get head(): number {
    return this.cursor
  }

  replace(head: number, activities: readonly AcpActivityView[]): void {
    this.rows.clear()
    this.rowsByAnchor.clear()
    this.cursor = head
    for (const row of activities) this.insert(row)
  }

  append(activity: AcpActivityView): void {
    if (activity.revisionSeq <= this.cursor) return
    if (activity.revisionSeq !== this.cursor + 1) {
      throw new ActivityJournalProtocolError(
        `ACP activity journal gap: expected ${this.cursor + 1}, received ${activity.revisionSeq}`,
      )
    }
    this.cursor = activity.revisionSeq
    const previous = this.rows.get(activity.activityId)
    if (
      previous !== undefined &&
      (previous.ownerDshSessionId !== activity.ownerDshSessionId ||
        previous.promptAnchorMessageId !== activity.promptAnchorMessageId)
    ) {
      this.rowsByAnchor
        .get(this.anchorKey(previous.ownerDshSessionId, previous.promptAnchorMessageId))
        ?.delete(previous.activityId)
    }
    this.insert(activity)
  }

  values(ownerDshSessionId: string, promptAnchorMessageId: string): readonly AcpActivityView[] {
    const rows = this.rowsByAnchor.get(this.anchorKey(ownerDshSessionId, promptAnchorMessageId))
    return rows === undefined ? [] : [...rows.values()].sort((left, right) => left.activitySeq - right.activitySeq)
  }

  private anchorKey(ownerDshSessionId: string, promptAnchorMessageId: string): string {
    return `${ownerDshSessionId}\u0000${promptAnchorMessageId}`
  }

  private insert(row: AcpActivityView): void {
    this.rows.set(row.activityId, row)
    const key = this.anchorKey(row.ownerDshSessionId, row.promptAnchorMessageId)
    const rows = this.rowsByAnchor.get(key) ?? new Map<string, AcpActivityView>()
    rows.set(row.activityId, row)
    this.rowsByAnchor.set(key, rows)
  }
}

interface ActivityBatch {
  readonly firstRevision: number
  readonly lastRevision: number
  readonly activities: readonly AcpActivityView[]
}
interface ActivityWindowPage {
  readonly head: number
  readonly batches: readonly ActivityBatch[]
}
interface ActivityRequest {
  readonly limit: number
}

function snapshotBatch(head: number, activities: readonly AcpActivityView[]): readonly ActivityBatch[] {
  return head === 0 ? [] : [{ firstRevision: 1, lastRevision: head, activities }]
}

/**
 * The host owns reconnect and gap repair. One current-state snapshot covers
 * all revisions through its head; live batches still cover exactly one revision.
 */
class AcpActivityRemoteJournal extends RemoteJournalStream<ActivityWindowPage, ActivityBatch, number, ActivityRequest> {
  constructor(
    streamFactory: RemoteStreamFactory,
    private readonly remote: AcpRemoteLike,
    private readonly sessionId: string,
    publish: (change: RemoteJournalChange<ActivityWindowPage, ActivityBatch>) => void,
    carrierFailed: (error: unknown) => void,
    failed: (error: unknown) => void,
    private readonly onHealthyRead: () => void,
  ) {
    super(streamFactory, {
      name: 'dsh-acp activity journal',
      emptyCursor: 0,
      entries: (page) => page.batches,
      hasMore: () => false,
      first: (batch) => batch.firstRevision,
      last: (batch) => batch.lastRevision,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish,
      carrierFailed,
      failed,
    })
  }

  protected override async *follow(
    request: ActivityRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<ActivityBatch, number, ActivityWindowPage>> {
    for await (const frame of this.remote.activityFollow(this.sessionId, { limit: request.limit }, signal)) {
      if (frame.type === 'opened') {
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: { head: frame.cursor, batches: snapshotBatch(frame.cursor, frame.activities) },
        }
      } else {
        yield {
          type: 'entry',
          entry: {
            firstRevision: frame.activity.revisionSeq,
            lastRevision: frame.activity.revisionSeq,
            activities: [frame.activity],
          },
        }
      }
    }
  }

  protected override async readPage(
    request: ActivityRequest,
    through: number,
    signal: AbortSignal,
  ): Promise<ActivityWindowPage> {
    const current = new Map<string, AcpActivityView>()
    let cursor = 0
    while (cursor < through) {
      signal.throwIfAborted()
      const result = await this.remote.activityPage(
        this.sessionId,
        { afterRevision: cursor, limit: request.limit },
        signal,
      )
      if (!result.ok) throw result.error
      const before = cursor
      for (const activity of result.value.activities) {
        if (activity.revisionSeq > through) break
        if (activity.revisionSeq !== cursor + 1)
          throw new ActivityJournalProtocolError(`ACP activity repair page skipped revision ${String(cursor + 1)}`)
        current.set(activity.activityId, activity)
        cursor = activity.revisionSeq
      }
      if (cursor === before)
        throw new ActivityJournalProtocolError(`ACP activity repair ended before revision ${String(through)}`)
    }
    const activities = [...current.values()].sort((left, right) => left.activitySeq - right.activitySeq)
    this.onHealthyRead()
    return { head: through, batches: snapshotBatch(through, activities) }
  }

  protected override repairRequest(initial: ActivityRequest): ActivityRequest {
    return initial
  }
}

type HubEntry = {
  readonly store: AcpActivityJournalStore
  readonly listenersByAnchor: Map<string, Set<() => void>>
  journal?: AcpActivityRemoteJournal
  opening?: Promise<void>
  refs: number
  ready: boolean
  error?: unknown
  cancelRetry?: () => void
  retiring?: Promise<void>
  retryExhausted: boolean
  retrying: boolean
  retryAttempts: number
  initialLoading: boolean
}

const INITIAL_OPEN_RETRY_BASE_MS = 100
const INITIAL_OPEN_RETRY_MAX_MS = 8_000

function waitForRetry(entry: HubEntry, delay: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      delete entry.cancelRetry
      resolve(true)
    }, delay)
    entry.cancelRetry = () => {
      clearTimeout(timer)
      delete entry.cancelRetry
      resolve(false)
    }
  })
}

/** One live ACP journal per DSH session. Nodes only subscribe to projections. */
export class AcpActivityJournalHub {
  private readonly entries = new Map<string, HubEntry>()

  constructor(
    private readonly remote: AcpRemoteLike,
    /** Root `ctx.remote`, not the mounted dshAcp namespace. */
    private readonly streamFactory: RemoteStreamFactory,
  ) {}

  /** In-flight deduplication only; full details live with the expanded component. */
  private readonly detailRequests = new Map<string, Promise<AcpActivityView>>()

  detail(row: AcpActivityView): Promise<AcpActivityView> {
    const key = JSON.stringify([row.dshSessionId, row.ownerDshSessionId, row.activityId, row.revisionSeq])
    const pending = this.detailRequests.get(key)
    if (pending !== undefined) return pending
    const request = this.remote
      .activityDetail(row.dshSessionId, {
        activityId: row.activityId,
        revisionSeq: row.revisionSeq,
        ownerDshSessionId: row.ownerDshSessionId,
      })
      .then((result) => {
        if (!result.ok) throw result.error
        const detail = result.value
        if (
          detail.dshSessionId !== row.dshSessionId ||
          detail.ownerDshSessionId !== row.ownerDshSessionId ||
          detail.activityId !== row.activityId ||
          detail.revisionSeq !== row.revisionSeq
        )
          throw new Error('ACP activity detail identity mismatch')
        return detail
      })
      .finally(() => {
        this.detailRequests.delete(key)
      })
    this.detailRequests.set(key, request)
    return request
  }

  acquire(
    sessionId: string,
    ownerDshSessionId: string,
    promptAnchorMessageId: string,
    listener: () => void,
  ): {
    readonly snapshot: () => readonly AcpActivityView[]
    readonly ready: () => boolean
    readonly error: () => unknown
    readonly canRetry: () => boolean
    readonly retrying: () => boolean
    readonly loading: () => boolean
    readonly retry: () => void
    readonly release: () => void
  } {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) entry = this.createEntry(sessionId)
    entry.refs += 1
    const anchorKey = this.anchorKey(ownerDshSessionId, promptAnchorMessageId)
    const anchorListeners = entry.listenersByAnchor.get(anchorKey) ?? new Set<() => void>()
    anchorListeners.add(listener)
    entry.listenersByAnchor.set(anchorKey, anchorListeners)
    this.startEntry(sessionId, entry)
    let released = false
    return {
      snapshot: () => entry!.store.values(ownerDshSessionId, promptAnchorMessageId),
      ready: () => entry!.ready,
      error: () => entry!.error,
      canRetry: () => entry!.retryExhausted,
      retrying: () => entry!.retrying,
      loading: () => entry!.initialLoading,
      retry: () => {
        if (
          this.entries.get(sessionId) !== entry ||
          entry!.refs === 0 ||
          !entry!.retryExhausted ||
          entry!.opening !== undefined ||
          entry!.journal !== undefined ||
          entry!.retiring !== undefined ||
          entry!.cancelRetry !== undefined
        )
          return
        entry!.retryExhausted = false
        entry!.retrying = true
        entry!.initialLoading = true
        entry!.error = undefined
        entry!.retryAttempts = 0
        this.notifyAll(entry!)
        this.startEntry(sessionId, entry!)
      },
      release: () => {
        if (released) return
        released = true
        const listeners = entry!.listenersByAnchor.get(anchorKey)
        listeners?.delete(listener)
        if (listeners?.size === 0) entry!.listenersByAnchor.delete(anchorKey)
        entry!.refs -= 1
        if (entry!.refs === 0) {
          this.entries.delete(sessionId)
          entry!.cancelRetry?.()
          void entry!.journal?.dispose()
        }
      },
    }
  }

  private createEntry(sessionId: string): HubEntry {
    const store = new AcpActivityJournalStore()
    const listenersByAnchor = new Map<string, Set<() => void>>()
    const entry: HubEntry = {
      store,
      listenersByAnchor,
      refs: 0,
      ready: false,
      retryExhausted: false,
      retrying: false,
      retryAttempts: 0,
      initialLoading: true,
    }
    this.entries.set(sessionId, entry)
    return entry
  }

  /**
   * The conversation node can mount before the Agent startup commits its
   * durable ACP binding. Retry transient open and terminal read failures for
   * as long as a node subscribes; the delay is bounded, the retry count is not.
   * Carrier reconnect remains owned by DSH's RemoteJournalStream.
   */
  private startEntry(sessionId: string, entry: HubEntry): void {
    if (
      entry.retryExhausted ||
      entry.opening !== undefined ||
      entry.journal !== undefined ||
      entry.retiring !== undefined ||
      entry.cancelRetry !== undefined
    )
      return
    entry.opening = (async () => {
      while (this.entries.get(sessionId) === entry && entry.refs > 0) {
        let opened = false
        let journal: AcpActivityRemoteJournal
        journal = new AcpActivityRemoteJournal(
          this.streamFactory,
          this.remote,
          sessionId,
          (change) => {
            if (this.entries.get(sessionId) !== entry || entry.journal !== journal) return
            opened = true
            if (change.type === 'append') {
              for (const activity of change.entry.activities) entry.store.append(activity)
              entry.error = undefined
              entry.retryAttempts = 0
              this.notifyActivities(entry, change.entry.activities)
              return
            }
            if (change.type === 'prepend') return
            const wasReady = entry.ready
            const [baseline, ...tail] = change.entries
            entry.store.replace(baseline?.lastRevision ?? 0, baseline?.activities ?? [])
            for (const batch of tail) for (const activity of batch.activities) entry.store.append(activity)
            entry.ready = true
            entry.initialLoading = false
            entry.error = undefined
            entry.retrying = false
            if (!wasReady) entry.retryAttempts = 0
            this.notifyAll(entry)
          },
          (error) => {
            if (!opened || this.entries.get(sessionId) !== entry || entry.journal !== journal) return
            entry.error = error
            this.notifyAll(entry)
          },
          (error) => {
            if (!opened) return
            this.terminalFailure(sessionId, entry, journal, error)
          },
          () => {
            if (this.entries.get(sessionId) === entry && entry.journal === journal) entry.retryAttempts = 0
          },
        )
        entry.journal = journal
        try {
          await journal.open({ limit: 200 })
          return
        } catch (error) {
          if (entry.journal === journal) delete entry.journal
          await journal.dispose()
          if (this.entries.get(sessionId) !== entry || entry.refs === 0) return
          if (!this.noteFailure(entry, error)) return
          const delay = nextRetryDelay(entry)
          if (!(await waitForRetry(entry, delay))) return
        }
      }
    })().finally(() => {
      if (this.entries.get(sessionId) === entry) {
        delete entry.opening
        if (entry.retryExhausted) this.notifyAll(entry)
      }
    })
  }

  private noteFailure(entry: HubEntry, error: unknown): boolean {
    entry.error = error
    entry.retrying = false
    if (isStableActivityFailure(error)) {
      entry.retryExhausted = true
      entry.initialLoading = false
      this.notifyAll(entry)
      return false
    }
    this.notifyAll(entry)
    return true
  }

  private terminalFailure(sessionId: string, entry: HubEntry, journal: AcpActivityRemoteJournal, error: unknown): void {
    if (this.entries.get(sessionId) !== entry || entry.journal !== journal) return
    delete entry.journal
    entry.error = error
    entry.retrying = false
    this.notifyAll(entry)

    const retiring = journal.dispose()
    entry.retiring = retiring
    const afterRetire = (): void => {
      if (entry.retiring !== retiring) return
      delete entry.retiring
      if (this.entries.get(sessionId) !== entry || entry.refs === 0) return
      if (!this.noteFailure(entry, error)) return
      const delay = nextRetryDelay(entry)
      void waitForRetry(entry, delay).then((retry) => {
        if (retry && this.entries.get(sessionId) === entry && entry.refs > 0) this.startEntry(sessionId, entry)
      })
    }
    void retiring.then(afterRetire, afterRetire)
  }

  private notifyActivities(entry: HubEntry, activities: readonly AcpActivityView[]): void {
    const keys = new Set(
      activities.map((activity) => this.anchorKey(activity.ownerDshSessionId, activity.promptAnchorMessageId)),
    )
    for (const key of keys) {
      const listeners = entry.listenersByAnchor.get(key)
      if (listeners !== undefined) for (const listener of listeners) listener()
    }
  }

  private notifyAll(entry: HubEntry): void {
    for (const listeners of entry.listenersByAnchor.values()) for (const notify of listeners) notify()
  }

  private anchorKey(ownerDshSessionId: string, promptAnchorMessageId: string): string {
    return `${ownerDshSessionId}\u0000${promptAnchorMessageId}`
  }
}

function nextRetryDelay(entry: HubEntry): number {
  entry.retryAttempts += 1
  const exponent = Math.min(entry.retryAttempts - 1, 10)
  return Math.min(INITIAL_OPEN_RETRY_BASE_MS * 2 ** exponent, INITIAL_OPEN_RETRY_MAX_MS)
}

/** Known authorization, configuration, validation, and protocol failures are not transient reads. */
function isStableActivityFailure(error: unknown): boolean {
  if (error instanceof ActivityJournalProtocolError) return true
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { readonly code?: unknown }).code
  return (
    code === 'gateway/bad-request' ||
    code === 'dsh-acp/user-rejected' ||
    code === 'dsh-acp/auth-required' ||
    code === 'dsh-acp/not-installed' ||
    code === 'dsh-acp/protocol-incompatible' ||
    code === 'dsh-acp/protocol-error' ||
    code === 'dsh-acp/config'
  )
}
