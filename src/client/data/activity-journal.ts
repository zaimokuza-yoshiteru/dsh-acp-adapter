import {
  RemoteJournalStream,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamFactory,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { AcpActivityJournalFrame, AcpActivityView } from '../../contract/remote.ts'
import type { AcpRemoteLike } from './acp-remote.ts'

/** Client-side projection of the unfiltered, contiguous host journal. */
export class AcpActivityJournalStore {
  private readonly rows = new Map<string, AcpActivityView>()
  private readonly rowsByAnchor = new Map<string, Map<string, AcpActivityView>>()
  private cursor = 0

  get head(): number { return this.cursor }

  apply(frame: AcpActivityJournalFrame): void {
    if (frame.type === 'opened') this.replace(frame.cursor, frame.activities)
    else this.append(frame.activity)
  }

  applyPage(activities: readonly AcpActivityView[], head?: number): void {
    for (const activity of activities) this.append(activity)
    if (head !== undefined && head < this.cursor) throw new Error('ACP activity journal head regressed')
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
      throw new Error(`ACP activity journal gap: expected ${this.cursor + 1}, received ${activity.revisionSeq}`)
    }
    this.cursor = activity.revisionSeq
    const previous = this.rows.get(activity.activityId)
    if (previous !== undefined && (previous.ownerDshSessionId !== activity.ownerDshSessionId || previous.promptAnchorMessageId !== activity.promptAnchorMessageId)) {
      this.rowsByAnchor.get(this.anchorKey(previous.ownerDshSessionId, previous.promptAnchorMessageId))?.delete(previous.activityId)
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
interface ActivityRequest { readonly limit: number }

function snapshotBatch(head: number, activities: readonly AcpActivityView[]): readonly ActivityBatch[] {
  return head === 0 ? [] : [{ firstRevision: 1, lastRevision: head, activities }]
}

/**
 * Alpha.2 owns reconnect and gap repair. One current-state snapshot covers all
 * revisions through its head; live batches still cover exactly one revision.
 */
class AcpActivityRemoteJournal extends RemoteJournalStream<ActivityWindowPage, ActivityBatch, number, ActivityRequest> {
  constructor(
    streamFactory: RemoteStreamFactory,
    private readonly remote: AcpRemoteLike,
    private readonly sessionId: string,
    publish: (change: RemoteJournalChange<ActivityWindowPage, ActivityBatch>) => void,
    carrierFailed: (error: unknown) => void,
    failed: (error: unknown) => void,
  ) {
    super(streamFactory, {
      name: 'dsh-acp activity journal',
      emptyCursor: 0,
      entries: page => page.batches,
      hasMore: () => false,
      first: batch => batch.firstRevision,
      last: batch => batch.lastRevision,
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
        if (activity.revisionSeq !== cursor + 1) {
          throw new Error(`ACP activity repair page skipped revision ${String(cursor + 1)}`)
        }
        current.set(activity.activityId, activity)
        cursor = activity.revisionSeq
      }
      if (cursor === before) throw new Error(`ACP activity repair ended before revision ${String(through)}`)
    }
    const activities = [...current.values()].sort((left, right) => left.activitySeq - right.activitySeq)
    return { head: through, batches: snapshotBatch(through, activities) }
  }

  protected override repairRequest(initial: ActivityRequest): ActivityRequest { return initial }
}

type HubEntry = {
  readonly store: AcpActivityJournalStore
  readonly listenersByAnchor: Map<string, Set<() => void>>
  readonly journal: AcpActivityRemoteJournal
  refs: number
  error?: unknown
}

/** One live ACP journal per DSH session. Nodes only subscribe to projections. */
export class AcpActivityJournalHub {
  private readonly entries = new Map<string, HubEntry>()

  constructor(
    private readonly remote: AcpRemoteLike,
    /** Root `ctx.remote`, not the mounted dshAcp namespace. */
    private readonly streamFactory: RemoteStreamFactory,
  ) {}

  acquire(sessionId: string, ownerDshSessionId: string, promptAnchorMessageId: string, listener: () => void): {
    readonly snapshot: () => readonly AcpActivityView[]
    readonly error: () => unknown
    readonly release: () => void
  } {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) entry = this.createEntry(sessionId)
    entry.refs += 1
    const anchorKey = this.anchorKey(ownerDshSessionId, promptAnchorMessageId)
    const anchorListeners = entry.listenersByAnchor.get(anchorKey) ?? new Set<() => void>()
    anchorListeners.add(listener)
    entry.listenersByAnchor.set(anchorKey, anchorListeners)
    let released = false
    return {
      snapshot: () => entry!.store.values(ownerDshSessionId, promptAnchorMessageId),
      error: () => entry!.error,
      release: () => {
        if (released) return
        released = true
        const listeners = entry!.listenersByAnchor.get(anchorKey)
        listeners?.delete(listener)
        if (listeners?.size === 0) entry!.listenersByAnchor.delete(anchorKey)
        entry!.refs -= 1
        if (entry!.refs === 0) {
          this.entries.delete(sessionId)
          void entry!.journal.dispose()
        }
      },
    }
  }

  private createEntry(sessionId: string): HubEntry {
    const store = new AcpActivityJournalStore()
    const listenersByAnchor = new Map<string, Set<() => void>>()
    let entry: HubEntry
    const notifyAll = (): void => {
      for (const listeners of listenersByAnchor.values()) for (const notify of listeners) notify()
    }
    const journal = new AcpActivityRemoteJournal(
      this.streamFactory,
      this.remote,
      sessionId,
      change => {
        if (change.type === 'append') {
          for (const activity of change.entry.activities) store.append(activity)
          entry.error = undefined
          this.notifyActivities(entry, change.entry.activities)
          return
        }
        if (change.type === 'prepend') return
        const [baseline, ...tail] = change.entries
        store.replace(baseline?.lastRevision ?? 0, baseline?.activities ?? [])
        for (const batch of tail) for (const activity of batch.activities) store.append(activity)
        entry.error = undefined
        notifyAll()
      },
      error => { entry.error = error; notifyAll() },
      error => { entry.error = error; notifyAll() },
    )
    entry = { store, listenersByAnchor, journal, refs: 0 }
    this.entries.set(sessionId, entry)
    void journal.open({ limit: 200 }).catch(error => {
      if (this.entries.get(sessionId) !== entry) return
      entry.error = error
      notifyAll()
    })
    return entry
  }

  private notifyActivities(entry: HubEntry, activities: readonly AcpActivityView[]): void {
    const keys = new Set(activities.map(activity => this.anchorKey(activity.ownerDshSessionId, activity.promptAnchorMessageId)))
    for (const key of keys) {
      const listeners = entry.listenersByAnchor.get(key)
      if (listeners !== undefined) for (const listener of listeners) listener()
    }
  }

  private anchorKey(ownerDshSessionId: string, promptAnchorMessageId: string): string {
    return `${ownerDshSessionId}\u0000${promptAnchorMessageId}`
  }
}
