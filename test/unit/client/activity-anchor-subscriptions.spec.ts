import { describe, expect, it } from 'vitest'
import { AcpActivityJournalHub } from '../../../src/client/data/activity-journal.ts'
import { ActivityAnchorSubscriptions } from '../../../src/client/ui/activity-anchor-subscriptions.ts'

type Listener = () => void

function fakeHub() {
  const bySession = new Map<string, { refs: number; listeners: Set<Listener> }>()
  const listenerByAnchor = new Map<string, Listener>()
  let opens = 0
  let disposals = 0
  let acquisitions = 0
  const hub = {
    acquire(sessionId: string, _owner: string, anchor: string, listener: Listener) {
      acquisitions++
      let entry = bySession.get(sessionId)
      if (entry === undefined) {
        entry = { refs: 0, listeners: new Set() }
        bySession.set(sessionId, entry)
      }
      if (entry.refs === 0) opens++
      entry.refs++
      entry.listeners.add(listener)
      listenerByAnchor.set(anchor, listener)
      // Match the hub's synchronous-safe contract: callers can be notified
      // before acquire returns its handle.
      listener()
      let released = false
      return {
        snapshot: () => [],
        ready: () => true,
        error: () => undefined,
        canRetry: () => false,
        retrying: () => false,
        loading: () => false,
        retry: () => {},
        release: () => {
          if (released) return
          released = true
          entry!.listeners.delete(listener)
          entry!.refs--
          if (entry!.refs === 0) {
            bySession.delete(sessionId)
            disposals++
          }
        },
      }
    },
  }
  return {
    hub,
    notify(anchor: string) {
      listenerByAnchor.get(anchor)?.()
    },
    counts: () => ({ opens, disposals, acquisitions }),
  }
}

const anchor = (key: string, ownerDshSessionId = 'session-1') => ({
  key,
  ownerDshSessionId,
  promptAnchorMessageId: key,
})

describe('ACP activity anchor subscriptions', () => {
  it('keeps the real session journal open when a new prompt anchor is added', async () => {
    let starts = 0
    let disposals = 0
    let active: (() => void) | undefined
    const remote = {
      async *activityFollow(_sessionId: string, _request: unknown, signal: AbortSignal) {
        starts++
        yield { type: 'opened' as const, cursor: 0, head: 0, activities: [] }
        await new Promise<void>((resolve) => {
          active = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const factory = {
      $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) {
        const controller = new AbortController()
        const stream = (async function* () {
          for await (const value of options.open(controller.signal))
            yield {
              generation: 1,
              value,
              signal: controller.signal,
              accept: () => {},
            }
        })()
        return {
          signal: controller.signal,
          restart: () => controller.abort(),
          [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
          dispose: async () => {
            disposals++
            controller.abort()
            active?.()
          },
        }
      },
    }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    const subscriptions = new ActivityAnchorSubscriptions()
    const updates: Array<[string, boolean]> = []
    const publish = (key: string, handle: { ready(): boolean }) => updates.push([key, handle.ready()])

    subscriptions.reconcile(hub, 'session-1', 'scope', [anchor('a')], publish)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(starts).toBe(1)
    expect(updates).toContainEqual(['a', true])

    subscriptions.reconcile(hub, 'session-1', 'scope', [anchor('a'), anchor('b')], publish)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(starts).toBe(1)
    expect(disposals).toBe(0)
    expect(updates).toContainEqual(['b', true])

    subscriptions.reconcile(hub, 'session-1', 'scope', [anchor('b')], publish)
    expect(disposals).toBe(0)
    subscriptions.dispose()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(disposals).toBe(1)
  })

  it('retains existing leases as anchors are added or removed and ignores late callbacks', () => {
    const subscriptions = new ActivityAnchorSubscriptions()
    const fake = fakeHub()
    const received: string[] = []
    const publish = (key: string) => (leaseKey: string) => received.push(`${key}:${leaseKey}`)

    subscriptions.reconcile(fake.hub, 'session-1', 'scope', [anchor('a')], publish('first'))
    expect(received).toEqual(['first:a'])
    expect(fake.counts()).toEqual({ opens: 1, disposals: 0, acquisitions: 1 })

    subscriptions.reconcile(fake.hub, 'session-1', 'scope', [anchor('a'), anchor('b')], publish('second'))
    expect(received).toEqual(['first:a', 'second:b'])
    expect(fake.counts()).toEqual({ opens: 1, disposals: 0, acquisitions: 2 })
    fake.notify('a')
    expect(received.at(-1)).toBe('second:a')

    const lateA = fake.notify
    subscriptions.reconcile(fake.hub, 'session-1', 'scope', [anchor('b')], publish('third'))
    const afterRemoval = received.length
    lateA('a')
    expect(received).toHaveLength(afterRemoval)
    expect(fake.counts()).toEqual({ opens: 1, disposals: 0, acquisitions: 2 })

    subscriptions.dispose()
    expect(fake.counts()).toEqual({ opens: 1, disposals: 1, acquisitions: 2 })
  })

  it('releases old listeners when the session, scope, or hub changes', () => {
    const subscriptions = new ActivityAnchorSubscriptions()
    const first = fakeHub()
    const second = fakeHub()
    const received: string[] = []
    const publish = (key: string) => (leaseKey: string) => received.push(`${key}:${leaseKey}`)

    subscriptions.reconcile(first.hub, 'session-1', 'scope-1', [anchor('a')], publish('first'))
    subscriptions.reconcile(first.hub, 'session-2', 'scope-1', [anchor('a', 'session-2')], publish('session'))
    expect(first.counts()).toEqual({ opens: 2, disposals: 1, acquisitions: 2 })
    expect(second.counts()).toEqual({ opens: 0, disposals: 0, acquisitions: 0 })

    subscriptions.reconcile(second.hub, 'session-2', 'scope-1', [anchor('a', 'session-2')], publish('hub'))
    expect(first.counts()).toEqual({ opens: 2, disposals: 2, acquisitions: 2 })
    expect(second.counts()).toEqual({ opens: 1, disposals: 0, acquisitions: 1 })
    subscriptions.reconcile(second.hub, 'session-2', 'scope-2', [anchor('a', 'session-2')], publish('scope'))
    expect(second.counts()).toEqual({ opens: 2, disposals: 1, acquisitions: 2 })

    first.notify('a')
    expect(received.at(-1)).toBe('scope:a')
    subscriptions.dispose()
    expect(second.counts()).toEqual({ opens: 2, disposals: 2, acquisitions: 2 })
  })
})
