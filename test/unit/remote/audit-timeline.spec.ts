import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'

describe('ACP audit timeline Remote', () => {
  it('provides authorized snapshot/page/follow activity views with revision cursors', async () => {
    const rows = [
      { dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1', activityId: 'tool-1', activitySeq: 1, revisionSeq: 1, time: 1, kind: 'tool' as const, status: 'running' as const, presentation: 'Read' },
      { dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1', activityId: 'tool-1', activitySeq: 1, revisionSeq: 2, time: 2, kind: 'tool' as const, status: 'completed' as const, presentation: 'Read complete' },
    ]
    const source = {
      snapshot: async () => [rows[1]!],
      page: async (_id: string, after: number, limit: number) => rows.filter((row) => row.revisionSeq > after).slice(0, limit),
      head: async () => 2,
      subscribe: (_id: string, _filter: unknown, _subscriber: (row: typeof rows[number]) => void) => () => undefined,
    }
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined }) },
      resolveLiveAgent: () => undefined,
      activityTimeline: source,
      activityAccess: (sessionId) => sessionId === 'session-1',
    })
    await expect(service.activitySnapshot('session-1', { filter: { ownerDshSessionId: 'session-1' } })).resolves.toMatchObject({ head: 2, activities: [rows[1]] })
    await expect(service.activityPage('session-1', { afterRevision: 0, limit: 1 })).resolves.toMatchObject({ head: 2, nextCursor: 1, hasMore: true, activities: [rows[0]] })
    const abort = new AbortController()
    const follow = service.activityFollow('session-1', undefined, abort.signal)
    const iterator = follow[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'opened', cursor: 2, activities: [rows[1]], head: 2 }, done: false })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await expect(service.activitySnapshot('other-session')).rejects.toThrow('not authorized')
  })

  it('subscribes before opening and emits only durable revisions after the opening head', async () => {
    const opening: typeof rowsForStream = []
    let listener: ((row: typeof rowsForStream[number]) => void) | undefined
    let disposed = false
    const source = {
      snapshot: async () => {
        // This revision races with the opening read and must be covered by the
        // opening cursor rather than delivered a second time.
        listener?.(rowsForStream[0]!)
        return opening
      },
      page: async () => [],
      head: async () => 1,
      subscribe: (_id: string, _filter: unknown, subscriber: (row: typeof rowsForStream[number]) => void) => {
        listener = subscriber
        return () => { disposed = true }
      },
    }
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined }) },
      resolveLiveAgent: () => undefined,
      activityTimeline: source,
      activityAccess: () => true,
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', undefined, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'opened', cursor: 1 }, done: false })
    const next = iterator.next()
    listener?.({ ...rowsForStream[0]!, revisionSeq: 2 })
    await expect(next).resolves.toMatchObject({ value: { type: 'entry', activity: { revisionSeq: 2 } }, done: false })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(disposed).toBe(true)
  })

  it('folds every current activity across bounded opening pages without losing row 201+', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1',
      activityId: `tool-${String(index + 1)}`, activitySeq: index + 1, revisionSeq: index + 1,
      time: index + 1, kind: 'tool' as const, status: 'completed' as const,
      presentation: `Tool ${String(index + 1)}`,
    }))
    let listener: ((row: typeof rows[number]) => void) | undefined
    const source = {
      snapshot: async () => rows.slice(0, 200),
      page: async (_id: string, after: number, limit: number) => rows.filter(row => row.revisionSeq > after).slice(0, limit),
      head: async () => 205,
      subscribe: (_id: string, _filter: unknown, subscriber: (row: typeof rows[number]) => void) => {
        listener = subscriber
        return () => undefined
      },
    }
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined }) },
      resolveLiveAgent: () => undefined,
      activityTimeline: source,
      activityAccess: () => true,
    })
    const abort = new AbortController()
    const iterator = service.activityFollow('session-1', { limit: 200 }, abort.signal)[Symbol.asyncIterator]()
    const opened = await iterator.next()
    expect(opened.value).toMatchObject({ type: 'opened', cursor: 205, head: 205 })
    expect(opened.value?.type === 'opened' ? opened.value.activities : []).toHaveLength(205)
    const next = iterator.next()
    listener?.({ ...rows[204]!, activityId: 'tool-206', activitySeq: 206, revisionSeq: 206 })
    await expect(next).resolves.toMatchObject({ value: { type: 'entry', activity: { revisionSeq: 206 } } })
    abort.abort()
    await iterator.next()
  })

  it('returns a bounded cursor page without exposing raw persistence payloads', async () => {
    const rows = [
      { seq: 1, time: 100, kind: 'binding', category: 'agent' as const, summaryCode: 'binding.established' as const, subject: 'codex', status: null, detail: null },
      { seq: 2, time: 200, kind: 'permission', category: 'permission' as const, summaryCode: 'permission.decided' as const, subject: 'call-1', status: 'selected', detail: '{"optionId":"allow_once"}' },
      { seq: 3, time: 300, kind: 'filesystem', category: 'files' as const, summaryCode: 'filesystem.operation' as const, subject: '/tmp/file', status: 'ok', detail: '{"path":"/tmp/file"}' },
    ]
    const service = new AcpRemoteService(new Context(), {
      registry: {
        agents: () => new Map(),
        probeCacheFor: () => ({
          probeSnapshot: () => undefined,
          invalidateProbe: () => undefined,
          listModels: async () => undefined,
        }),
      },
      resolveLiveAgent: () => undefined,
      auditTimeline: {
        list: async (_sessionId, afterSeq, limit) => rows.filter((row) => row.seq > afterSeq).slice(0, limit),
        hasMore: async (_sessionId, seq) => rows.some((row) => row.seq > seq),
      },
      ownedSessionReadGate: () => true,
    })

    await expect(service.auditTimeline('session-1', { limit: 2 })).resolves.toEqual({
      sessionId: 'session-1',
      entries: rows.slice(0, 2),
      nextCursor: 2,
      hasMore: true,
    })
    await expect(service.auditTimeline('session-1', { afterSeq: 2, limit: 2 })).resolves.toMatchObject({
      entries: [rows[2]],
      nextCursor: null,
      hasMore: false,
    })
  })

  it('rejects unbounded or invalid page sizes', async () => {
    const service = new AcpRemoteService(new Context(), {
      registry: {
        agents: () => new Map(),
                probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined }),
      },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => true,
      auditTimeline: { list: async () => [], hasMore: async () => false },
    })
    await expect(service.auditTimeline('session-1', { limit: 101 })).rejects.toThrow('page size')
    await expect(service.auditTimeline('session-1', { afterSeq: -1 })).rejects.toThrow('cursor')
  })

  it('拒绝未拥有的 native/unknown/超长 session，且在 list/hasMore 前拒绝', async () => {
    let lists = 0
    let more = 0
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => undefined },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => false,
      auditTimeline: {
        list: async () => { lists += 1; return [] },
        hasMore: async () => { more += 1; return false },
      },
    })
    for (const id of ['native-session', 'unknown-session', 'x'.repeat(257)]) {
      await expect(service.auditTimeline(id)).rejects.toThrow(/not authorized|invalid/)
    }
    expect(lists).toBe(0)
    expect(more).toBe(0)
  })

  it('fails clearly when the sidecar audit seam is unavailable', async () => {
    const service = new AcpRemoteService(new Context(), {
      registry: {
        agents: () => new Map(),
        probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined }),
      },
      resolveLiveAgent: () => undefined,
    })
    await expect(service.auditTimeline('session-1')).rejects.toThrow('unavailable')
  })
})

const rowsForStream = [{
  dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1',
  activityId: 'tool-1', activitySeq: 1, revisionSeq: 1, time: 1,
  kind: 'tool' as const, status: 'completed' as const, presentation: 'Read',
}]
