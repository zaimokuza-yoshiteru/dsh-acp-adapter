import type { AcpActivityJournalHub } from '../data/activity-journal.ts'

type Hub = Pick<AcpActivityJournalHub, 'acquire'>
type Handle = ReturnType<AcpActivityJournalHub['acquire']>

export interface ActivityAnchorSubscription {
  readonly key: string
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
}

interface Lease {
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
  handle?: Handle
}

/** Retain unchanged per-anchor leases when the chat gains or loses markers. */
export class ActivityAnchorSubscriptions {
  private hub: Hub | undefined
  private sessionId: string | undefined
  private scope: unknown
  private readonly leases = new Map<string, Lease>()
  private onChange: ((key: string, handle: Handle) => void) | undefined

  reconcile(
    hub: Hub,
    sessionId: string,
    scope: unknown,
    desired: readonly ActivityAnchorSubscription[],
    onChange: (key: string, handle: Handle) => void,
  ): void {
    this.onChange = onChange
    if (this.hub !== hub || this.sessionId !== sessionId || this.scope !== scope) {
      this.releaseAll()
      this.hub = hub
      this.sessionId = sessionId
      this.scope = scope
    }

    const next = new Map(desired.map((item) => [item.key, item]))
    for (const [key, lease] of this.leases) {
      const item = next.get(key)
      if (
        item !== undefined &&
        item.ownerDshSessionId === lease.ownerDshSessionId &&
        item.promptAnchorMessageId === lease.promptAnchorMessageId
      )
        continue
      this.leases.delete(key)
      lease.handle?.release()
    }

    for (const item of desired) {
      if (this.leases.has(item.key)) continue
      const lease: Lease = {
        ownerDshSessionId: item.ownerDshSessionId,
        promptAnchorMessageId: item.promptAnchorMessageId,
      }
      // Register before acquire: a hub is allowed to notify synchronously.
      this.leases.set(item.key, lease)
      const notify = (): void => {
        if (this.leases.get(item.key) !== lease || lease.handle === undefined) return
        this.onChange?.(item.key, lease.handle)
      }
      try {
        lease.handle = hub.acquire(item.ownerDshSessionId, item.ownerDshSessionId, item.promptAnchorMessageId, notify)
      } catch (error) {
        if (this.leases.get(item.key) === lease) this.leases.delete(item.key)
        throw error
      }
      // A synchronous notification during acquire is ignored until handle is
      // assigned; this read publishes the current snapshot immediately after.
      notify()
    }
  }

  dispose(): void {
    this.releaseAll()
    this.hub = undefined
    this.sessionId = undefined
    this.scope = undefined
    this.onChange = undefined
  }

  private releaseAll(): void {
    const leases = [...this.leases.values()]
    this.leases.clear()
    for (const lease of leases) lease.handle?.release()
  }
}
