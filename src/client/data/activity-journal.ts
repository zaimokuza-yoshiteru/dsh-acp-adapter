import type { AcpActivityJournalFrame, AcpActivityView } from '../../contract/remote.ts'
import type { AcpActivityStreamFactory, AcpRemoteLike } from './acp-remote.ts'

/** Client-side projection of the unfiltered, contiguous host journal. */
export class AcpActivityJournalStore {
  private readonly rows = new Map<string, AcpActivityView>()
  private readonly rowsByAnchor = new Map<string, Map<string, AcpActivityView>>()
  private cursor = 0

  get head(): number { return this.cursor }

  /** Apply one host opening or durable revision. Stale reconnect overlap is ignored. */
  apply(frame: AcpActivityJournalFrame): void {
    if (frame.type === 'opened') {
      this.rows.clear()
      this.rowsByAnchor.clear()
      this.cursor = frame.cursor
      for (const row of frame.activities) this.insert(row)
      return
    }
    if (frame.activity.revisionSeq <= this.cursor) return
    if (frame.activity.revisionSeq !== this.cursor + 1) {
      throw new Error(`ACP activity journal gap: expected ${this.cursor + 1}, received ${frame.activity.revisionSeq}`)
    }
    this.cursor = frame.activity.revisionSeq
    const previous = this.rows.get(frame.activity.activityId)
    if (previous !== undefined && (previous.ownerDshSessionId !== frame.activity.ownerDshSessionId || previous.promptAnchorMessageId !== frame.activity.promptAnchorMessageId)) {
      const oldKey = this.anchorKey(previous.ownerDshSessionId, previous.promptAnchorMessageId)
      this.rowsByAnchor.get(oldKey)?.delete(previous.activityId)
    }
    this.insert(frame.activity)
  }

  /** Apply an unfiltered page returned during reconnect/gap repair. */
  applyPage(activities: readonly AcpActivityView[], head?: number): void {
    for (const activity of activities) this.apply({ type: 'entry', activity })
    if (head !== undefined && head < this.cursor) throw new Error('ACP activity journal head regressed')
  }

  /** Return one turn's activities without asking the host for a filtered cursor. */
  values(ownerDshSessionId: string, promptAnchorMessageId: string): readonly AcpActivityView[] {
    const rows = this.rowsByAnchor.get(this.anchorKey(ownerDshSessionId, promptAnchorMessageId))
    if (rows === undefined) return []
    return [...rows.values()]
      .sort((left, right) => left.activitySeq - right.activitySeq)
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

type HubEntry = {
  readonly store: AcpActivityJournalStore
  readonly listenersByAnchor: Map<string, Set<() => void>>
  readonly abort: AbortController
  refs: number
  running: boolean
  error?: unknown
}

/** One live ACP journal per DSH session. Nodes only subscribe to projections. */
export class AcpActivityJournalHub {
  private readonly entries = new Map<string, HubEntry>()

  constructor(
    private readonly remote: AcpRemoteLike,
    /** Root `ctx.remote`, not the mounted dshAcp namespace. */
    private readonly streamFactory: AcpActivityStreamFactory,
  ) {}

  acquire(sessionId: string, ownerDshSessionId: string, promptAnchorMessageId: string, listener: () => void): {
    readonly snapshot: () => readonly AcpActivityView[]
    readonly error: () => unknown
    readonly release: () => void
  } {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { store: new AcpActivityJournalStore(), listenersByAnchor: new Map(), abort: new AbortController(), refs: 0, running: false }
      this.entries.set(sessionId, entry)
    }
    entry.refs += 1
    const anchorKey = this.anchorKey(ownerDshSessionId, promptAnchorMessageId)
    const anchorListeners = entry.listenersByAnchor.get(anchorKey) ?? new Set<() => void>()
    anchorListeners.add(listener)
    entry.listenersByAnchor.set(anchorKey, anchorListeners)
    if (!entry.running) {
      entry.running = true
      void this.run(sessionId, entry)
    }
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
          entry!.abort.abort()
          this.entries.delete(sessionId)
        }
      },
    }
  }

  private async run(sessionId: string, entry: HubEntry): Promise<void> {
    const follow = this.remote.activityFollow
    while (!entry.abort.signal.aborted) {
      const stream = this.streamFactory.$stream<AcpActivityJournalFrame>({
      name: 'dsh-acp activity journal',
      open: signal => follow(sessionId, { limit: 200 }, signal),
      ended: accepted => accepted
        ? new Error('dsh-acp activity journal ended unexpectedly')
        : new Error('dsh-acp activity journal ended before opening'),
      })
      let stopping: Promise<void> | undefined
      const dispose = stream.dispose
      const stop = (): Promise<void> => {
        if (stopping !== undefined) return stopping
        stopping = dispose.call(stream)
        return stopping
      }
      const abort = (): void => { void stop() }
      entry.abort.signal.addEventListener('abort', abort, { once: true })
      try {
        for await (const item of stream) {
          try {
            await this.applyFrame(sessionId, entry, item.value)
            item.accept()
            entry.error = undefined
            this.notify(entry, item.value)
          } catch (error) {
            // A failed repair is handled by reopening the authoritative stream;
            // this keeps the existing React tree mounted and avoids rendering a
            // partial journal. The bounded retry is inside applyFrame.
            if (!entry.abort.signal.aborted) entry.error = error
            throw error
          }
        }
      } catch (error) {
        if (!entry.abort.signal.aborted) {
          entry.error = error
          this.notify(entry)
          await this.delay(100, entry.abort.signal)
        }
      } finally {
        entry.abort.signal.removeEventListener('abort', abort)
        await stop()
      }
    }
  }

  private async applyFrame(sessionId: string, entry: HubEntry, frame: AcpActivityJournalFrame): Promise<void> {
    if (frame.type === 'opened') {
      entry.store.apply(frame)
      return
    }
    try {
      entry.store.apply(frame)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('activity journal gap')) throw error
      const match = /expected (\d+), received (\d+)/.exec(error.message)
      const expected = match === null ? entry.store.head + 1 : Number(match[1])
      await this.repair(sessionId, entry, expected - 1)
      entry.store.apply(frame)
    }
  }

  private async repair(sessionId: string, entry: HubEntry, afterRevision: number): Promise<void> {
    if (this.remote.activityPage === undefined) throw new Error('ACP activity gap repair is unavailable')
    let cursor = afterRevision
    let failures = 0
    while (failures < 4) {
      if (entry.abort.signal.aborted) throw new Error('ACP activity repair aborted')
      try {
        const result = await this.remote.activityPage(sessionId, { afterRevision: cursor, limit: 200 })
        if (!result.ok) throw new Error(result.error.message)
        const page = result.value
        if (page.activities.length === 0) {
          if (page.head <= cursor) return
          throw new Error(`ACP activity repair returned an empty page before head ${page.head}`)
        }
        entry.store.applyPage(page.activities, page.head)
        cursor = entry.store.head
        if (cursor >= page.head) return
        if (page.nextCursor === null) throw new Error(`ACP activity repair ended before head ${page.head}`)
        failures = 0
      } catch (error) {
        failures += 1
        if (failures >= 4) throw error
        await this.delay(50 * (2 ** (failures - 1)), entry.abort.signal)
      }
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  private notify(entry: HubEntry, frame?: AcpActivityJournalFrame): void {
    if (frame?.type === 'entry') {
      const listeners = entry.listenersByAnchor.get(this.anchorKey(frame.activity.ownerDshSessionId, frame.activity.promptAnchorMessageId))
      if (listeners !== undefined) for (const listener of listeners) listener()
      return
    }
    for (const listeners of entry.listenersByAnchor.values()) for (const listener of listeners) listener()
  }

  private anchorKey(ownerDshSessionId: string, promptAnchorMessageId: string): string {
    return `${ownerDshSessionId}\u0000${promptAnchorMessageId}`
  }
}
