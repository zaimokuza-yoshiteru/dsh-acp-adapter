import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpActivityRecord } from '../../../src/persistence/sidecar.ts'

function row(revisionSeq: number): AcpActivityRecord {
  return {
    dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1',
    activityId: `activity-${revisionSeq}`, activitySeq: revisionSeq, revisionSeq,
    time: revisionSeq, kind: 'tool', status: 'running', presentation: `Activity ${revisionSeq}`,
  }
}

const idle = () => new Promise<void>(resolve => setImmediate(resolve))
const abortListenerCount = (signal: AbortSignal) => getEventListeners(signal, 'abort').length

function createService(source: {
  page: (sessionId: string, after: number, limit: number) => Promise<readonly AcpActivityRecord[]>
  head: () => Promise<number>
  subscribe: (sessionId: string, filter: unknown, listener: (activity: AcpActivityRecord) => void) => () => void
}) {
  return new AcpRemoteService(new Context(), {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    resolveLiveAgent: () => undefined,
    ownedSessionReadGate: () => true,
    activityTimeline: {
      snapshot: async () => [],
      page: source.page,
      head: source.head,
      subscribe: source.subscribe,
    },
  })
}

describe('ACP activity follow lifecycle', () => {
  it('uses one abort listener for a long stream and releases it on iterator return', async () => {
    let listener: ((activity: AcpActivityRecord) => void) | undefined
    let unsubscribed = false
    const service = createService({
      page: async () => [],
      head: async () => 0,
      subscribe: (_sessionId, _filter, subscriber) => {
        listener = subscriber
        return () => { unsubscribed = true }
      },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'opened', cursor: 0 }, done: false })
    for (let revision = 1; revision <= 100; revision += 1) {
      const next = iterator.next()
      await idle()
      expect(abortListenerCount(abort.signal)).toBe(1)
      listener?.(row(revision))
      await expect(next).resolves.toMatchObject({ value: { type: 'entry', activity: { revisionSeq: revision } }, done: false })
    }

    await expect(iterator.return!()).resolves.toMatchObject({ done: true })
    expect(abortListenerCount(abort.signal)).toBe(0)
    expect(unsubscribed).toBe(true)
    abort.abort()
    expect(abortListenerCount(abort.signal)).toBe(0)
  })

  it('wakes a pending read on abort and cleans up its source subscription', async () => {
    let listener: ((activity: AcpActivityRecord) => void) | undefined
    let unsubscribed = false
    const service = createService({
      page: async () => [],
      head: async () => 0,
      subscribe: (_sessionId, _filter, subscriber) => {
        listener = subscriber
        return () => { unsubscribed = true }
      },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()

    await iterator.next()
    const pending = iterator.next()
    await idle()
    expect(abortListenerCount(abort.signal)).toBe(1)
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(abortListenerCount(abort.signal)).toBe(0)
    expect(unsubscribed).toBe(true)
    listener?.(row(1))
  })

  it('removes its abort listener and subscription when opening fails', async () => {
    let unsubscribed = false
    const failure = new Error('opening head failed')
    const service = createService({
      page: async () => [],
      head: async () => { throw failure },
      subscribe: () => () => { unsubscribed = true },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBe(failure)
    expect(abortListenerCount(abort.signal)).toBe(0)
    expect(unsubscribed).toBe(true)
  })

  it('cleans up when aborted while the opening head is pending', async () => {
    let resolveHead: ((head: number) => void) | undefined
    let unsubscribed = false
    const service = createService({
      page: async () => [],
      head: () => new Promise(resolve => { resolveHead = resolve }),
      subscribe: () => () => { unsubscribed = true },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    await idle()
    expect(abortListenerCount(abort.signal)).toBe(1)

    abort.abort()
    resolveHead?.(0)
    await expect(opening).resolves.toMatchObject({ done: true })
    expect(abortListenerCount(abort.signal)).toBe(0)
    expect(unsubscribed).toBe(true)
  })

  it('cleans up when aborted while an opening page is pending', async () => {
    let resolvePage: ((page: readonly AcpActivityRecord[]) => void) | undefined
    let unsubscribed = false
    const service = createService({
      page: () => new Promise(resolve => { resolvePage = resolve }),
      head: async () => 1,
      subscribe: () => () => { unsubscribed = true },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    await idle()
    expect(abortListenerCount(abort.signal)).toBe(1)

    abort.abort()
    resolvePage?.([row(1)])
    await expect(opening).resolves.toMatchObject({ done: true })
    expect(abortListenerCount(abort.signal)).toBe(0)
    expect(unsubscribed).toBe(true)
  })

  it('uses the ordered revision high-water mark to ignore a duplicate without skipping the next row', async () => {
    let listener: ((activity: AcpActivityRecord) => void) | undefined
    const service = createService({
      page: async () => [],
      head: async () => 0,
      subscribe: (_sessionId, _filter, subscriber) => {
        listener = subscriber
        return () => undefined
      },
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()
    await iterator.next()

    const first = iterator.next()
    listener?.(row(1))
    await expect(first).resolves.toMatchObject({ value: { type: 'entry', activity: { revisionSeq: 1 } }, done: false })
    const next = iterator.next()
    listener?.(row(1))
    listener?.(row(2))
    await expect(next).resolves.toMatchObject({ value: { type: 'entry', activity: { revisionSeq: 2 } }, done: false })

    await iterator.return!()
  })
})
