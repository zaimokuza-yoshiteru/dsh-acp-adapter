import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpAuditTimelineEntry } from '../../../src/contract/remote.ts'

describe('ACP audit timeline Remote', () => {
  it('finds errors beyond routine pages and resumes bounded scans without losing rows', async () => {
    const rows: AcpAuditTimelineEntry[] = Array.from({ length: 1204 }, (_, index) => ({
      seq: index + 1,
      time: 1,
      kind: 'replay-assessment',
      severity: 'info',
      category: 'recovery',
      summaryCode: 'replay.not-compared',
      subject: null,
      status: null,
      detail: null,
    }))
    rows[1201] = {
      ...rows[1201]!,
      kind: 'filesystem',
      severity: 'error',
      category: 'files',
      summaryCode: 'filesystem.read',
    }
    rows[1203] = {
      ...rows[1203]!,
      kind: 'terminal',
      severity: 'error',
      category: 'files',
      summaryCode: 'terminal.operation',
    }
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => undefined },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => true,
      auditTimeline: {
        list: async (_id, after, limit) => rows.filter((row) => row.seq > after).slice(0, limit),
        hasMore: async (_id, after) => rows.some((row) => row.seq > after),
        head: async () => rows.at(-1)?.seq ?? 0,
        scanPage: async (_id, after, limit, through) => {
          const entries = rows.filter((row) => row.seq > after && row.seq <= through).slice(0, limit)
          const scannedThrough = entries.at(-1)?.seq ?? after
          return {
            entries,
            scannedThrough,
            scannedRecords: entries.length,
            unreadableRecords: 0,
            hasMore: rows.some((row) => row.seq > scannedThrough && row.seq <= through),
          }
        },
      },
    })
    expect(await service.auditTimeline('session', { view: 'issues', limit: 1 })).toMatchObject({
      entries: [],
      nextCursor: 1000,
      hasMore: true,
    })
    expect(await service.auditTimeline('session', { view: 'issues', afterSeq: 1000, limit: 1 })).toMatchObject({
      entries: [{ seq: 1202 }],
      nextCursor: 1202,
      hasMore: true,
    })
    expect(await service.auditTimeline('session', { view: 'issues', afterSeq: 1202, limit: 1 })).toMatchObject({
      entries: [{ seq: 1204 }],
      nextCursor: null,
      hasMore: false,
    })
    expect(
      (await service.auditTimeline('session', { view: 'technical', limit: 2 })).entries.map((row) => row.seq),
    ).toEqual([1, 2])
    expect(
      (await service.auditTimeline('session', { view: 'operations', afterSeq: 1000 })).entries.map((row) => row.seq),
    ).toEqual([1202, 1204])
  })
  it('provides authorized snapshot/page/follow activity views with revision cursors', async () => {
    const rows = [
      {
        dshSessionId: 'session-1',
        ownerDshSessionId: 'session-1',
        promptAnchorMessageId: 'user-1',
        activityId: 'tool-1',
        activitySeq: 1,
        revisionSeq: 1,
        time: 1,
        kind: 'tool' as const,
        status: 'running' as const,
        presentation: 'Read',
      },
      {
        dshSessionId: 'session-1',
        ownerDshSessionId: 'session-1',
        promptAnchorMessageId: 'user-1',
        activityId: 'tool-1',
        activitySeq: 1,
        revisionSeq: 2,
        time: 2,
        kind: 'tool' as const,
        status: 'completed' as const,
        presentation: 'Read complete',
      },
    ]
    const source = {
      snapshot: async () => [rows[1]!],
      page: async (_id: string, after: number, limit: number) =>
        rows.filter((row) => row.revisionSeq > after).slice(0, limit),
      head: async () => 2,
      subscribe: (_id: string, _filter: unknown, _subscriber: (row: (typeof rows)[number]) => void) => () => undefined,
    }
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
      activityTimeline: source,
      activityAccess: (sessionId) => sessionId === 'session-1',
    })
    await expect(
      service.activitySnapshot('session-1', { filter: { ownerDshSessionId: 'session-1' } }),
    ).resolves.toMatchObject({ head: 2, activities: [rows[1]] })
    await expect(service.activityPage('session-1', { afterRevision: 0, limit: 1 })).resolves.toMatchObject({
      head: 2,
      nextCursor: 1,
      hasMore: true,
      activities: [rows[0]],
    })
    const abort = new AbortController()
    const follow = service.activityFollow('session-1', undefined, abort.signal)
    const iterator = follow[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'opened', cursor: 2, activities: [rows[1]], head: 2 },
      done: false,
    })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await expect(service.activitySnapshot('other-session')).rejects.toMatchObject({
      code: 'dsh-acp/user-rejected',
      message: 'ACP activity access is not authorized for this DSH session',
      details: { kind: null, correlationId: null },
    })
  })

  it('pins explicit support-export watermarks without changing live paging defaults', async () => {
    const auditRows = [1, 2, 3].map((seq) => ({
      seq,
      time: seq,
      kind: 'filesystem',
      severity: 'error' as const,
      category: 'files' as const,
      summaryCode: 'filesystem.read' as const,
      subject: null,
      status: 'error',
      detail: null,
    }))
    const auditList = vi.fn(async (_id: string, after: number, limit: number, through?: number) =>
      auditRows.filter((row) => row.seq > after && (through === undefined || row.seq <= through)).slice(0, limit),
    )
    const auditHasMore = vi.fn(async (_id: string, after: number, through?: number) =>
      auditRows.some((row) => row.seq > after && (through === undefined || row.seq <= through)),
    )
    const auditHead = vi.fn(async () => 3)
    const auditScanPage = vi.fn(async (_id: string, after: number, limit: number, through: number) => {
      const entries = auditRows.filter((row) => row.seq > after && row.seq <= through).slice(0, limit)
      const scannedThrough = entries.at(-1)?.seq ?? after
      return {
        entries,
        scannedThrough,
        scannedRecords: entries.length,
        unreadableRecords: 0,
        hasMore: auditRows.some((row) => row.seq > scannedThrough && row.seq <= through),
      }
    })
    const activityRows = [1, 2, 3].map((revisionSeq) => ({
      dshSessionId: 'session-1',
      ownerDshSessionId: 'session-1',
      promptAnchorMessageId: 'user-1',
      activityId: `activity-${String(revisionSeq)}`,
      activitySeq: revisionSeq,
      revisionSeq,
      time: revisionSeq,
      kind: 'tool' as const,
      status: 'completed' as const,
      presentation: 'safe summary',
    }))
    const activityPage = vi.fn(async (_id: string, after: number, limit: number, _filter?: unknown, through?: number) =>
      activityRows
        .filter((row) => row.revisionSeq > after && (through === undefined || row.revisionSeq <= through))
        .slice(0, limit),
    )
    const activityHead = vi.fn(async () => 3)
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => undefined },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => true,
      auditTimeline: {
        list: auditList,
        hasMore: auditHasMore,
        head: auditHead,
        scanPage: auditScanPage,
      },
      activityAccess: () => true,
      activityTimeline: {
        snapshot: async () => [],
        page: activityPage,
        head: activityHead,
        subscribe: () => () => undefined,
      },
    })

    await expect(service.auditTimeline('session-1', { captureSnapshot: true, limit: 2 })).resolves.toMatchObject({
      snapshotHead: 3,
      entries: auditRows.slice(0, 2),
      hasMore: true,
    })
    auditRows.push({ ...auditRows[0]!, seq: 4 })
    await expect(service.auditTimeline('session-1', { snapshotHead: 3, afterSeq: 2, limit: 2 })).resolves.toMatchObject(
      {
        snapshotHead: 3,
        entries: [auditRows[2]],
        hasMore: false,
      },
    )
    expect(auditScanPage).toHaveBeenNthCalledWith(1, 'session-1', 0, 2, 3)
    expect(auditScanPage).toHaveBeenNthCalledWith(2, 'session-1', 2, 2, 3)
    expect(auditList).not.toHaveBeenCalled()
    expect(auditHead).toHaveBeenCalledTimes(1)

    await expect(service.activityPage('session-1', { captureSnapshot: true, limit: 2 })).resolves.toMatchObject({
      head: 3,
      activities: activityRows.slice(0, 2),
      hasMore: true,
    })
    activityRows.push({ ...activityRows[0]!, revisionSeq: 4, activitySeq: 4 })
    await expect(
      service.activityPage('session-1', { snapshotHead: 3, afterRevision: 2, limit: 2 }),
    ).resolves.toMatchObject({
      head: 3,
      activities: [activityRows[2]],
      hasMore: false,
    })
    expect(activityPage).toHaveBeenLastCalledWith('session-1', 2, 2, undefined, 3)
    expect(activityHead).toHaveBeenCalledTimes(1)
  })

  it('subscribes before opening and emits only durable revisions after the opening head', async () => {
    const opening: typeof rowsForStream = []
    let listener: ((row: (typeof rowsForStream)[number]) => void) | undefined
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
      subscribe: (_id: string, _filter: unknown, subscriber: (row: (typeof rowsForStream)[number]) => void) => {
        listener = subscriber
        return () => {
          disposed = true
        }
      },
    }
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
      dshSessionId: 'session-1',
      ownerDshSessionId: 'session-1',
      promptAnchorMessageId: 'user-1',
      activityId: `tool-${String(index + 1)}`,
      activitySeq: index + 1,
      revisionSeq: index + 1,
      time: index + 1,
      kind: 'tool' as const,
      status: 'completed' as const,
      presentation: `Tool ${String(index + 1)}`,
    }))
    let listener: ((row: (typeof rows)[number]) => void) | undefined
    const source = {
      snapshot: async () => rows.slice(0, 200),
      page: async (_id: string, after: number, limit: number) =>
        rows.filter((row) => row.revisionSeq > after).slice(0, limit),
      head: async () => 205,
      subscribe: (_id: string, _filter: unknown, subscriber: (row: (typeof rows)[number]) => void) => {
        listener = subscriber
        return () => undefined
      },
    }
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
      {
        seq: 1,
        time: 100,
        kind: 'binding',
        severity: 'info' as const,
        category: 'agent' as const,
        summaryCode: 'binding.established' as const,
        subject: 'codex',
        status: null,
        detail: null,
      },
      {
        seq: 2,
        time: 200,
        kind: 'permission',
        severity: 'info' as const,
        category: 'permission' as const,
        summaryCode: 'permission.decided' as const,
        subject: 'call-1',
        status: 'selected',
        detail: '{"optionId":"allow_once"}',
      },
      {
        seq: 3,
        time: 300,
        kind: 'filesystem',
        severity: 'info' as const,
        category: 'files' as const,
        summaryCode: 'filesystem.operation' as const,
        subject: '/tmp/file',
        status: 'ok',
        detail: '{"path":"/tmp/file"}',
      },
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
        head: async () => rows.at(-1)?.seq ?? 0,
        scanPage: async (_id, after, limit, through) => {
          const entries = rows.filter((row) => row.seq > after && row.seq <= through).slice(0, limit)
          const scannedThrough = entries.at(-1)?.seq ?? after
          return {
            entries,
            scannedThrough,
            scannedRecords: entries.length,
            unreadableRecords: 0,
            hasMore: rows.some((row) => row.seq > scannedThrough && row.seq <= through),
          }
        },
      },
      ownedSessionReadGate: () => true,
    })

    await expect(service.auditTimeline('session-1', { limit: 2 })).resolves.toEqual({
      sessionId: 'session-1',
      snapshotHead: null,
      scannedThrough: 2,
      scannedRecords: null,
      unreadableRecords: 0,
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
        probeCacheFor: () => ({
          probeSnapshot: () => undefined,
          invalidateProbe: () => undefined,
          listModels: async () => undefined,
        }),
      },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => true,
      auditTimeline: {
        list: async () => [],
        hasMore: async () => false,
        head: async () => 0,
        scanPage: async (_id, after) => ({
          entries: [],
          scannedThrough: after,
          scannedRecords: 0,
          unreadableRecords: 0,
          hasMore: false,
        }),
      },
    })
    await expect(service.auditTimeline('session-1', { limit: 101 })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      message: 'ACP audit page size is invalid',
      details: {},
    })
    await expect(service.auditTimeline('session-1', { afterSeq: -1 })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      message: 'ACP audit cursor is invalid',
      details: {},
    })
  })

  it('拒绝未拥有的 native/unknown/超长 session，且在 list/hasMore 前拒绝', async () => {
    let lists = 0
    let more = 0
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map(), probeCacheFor: () => undefined },
      resolveLiveAgent: () => undefined,
      ownedSessionReadGate: () => false,
      auditTimeline: {
        list: async () => {
          lists += 1
          return []
        },
        hasMore: async () => {
          more += 1
          return false
        },
        head: async () => {
          throw new Error('must not read head without authorization')
        },
        scanPage: async () => {
          throw new Error('must not scan before authorization')
        },
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
        probeCacheFor: () => ({
          probeSnapshot: () => undefined,
          invalidateProbe: () => undefined,
          listModels: async () => undefined,
        }),
      },
      resolveLiveAgent: () => undefined,
    })
    await expect(service.auditTimeline('session-1')).rejects.toMatchObject({
      code: 'dsh-acp/config',
      message: 'ACP audit history is unavailable on this host',
      details: { kind: null, correlationId: null },
    })
  })
})

const rowsForStream = [
  {
    dshSessionId: 'session-1',
    ownerDshSessionId: 'session-1',
    promptAnchorMessageId: 'user-1',
    activityId: 'tool-1',
    activitySeq: 1,
    revisionSeq: 1,
    time: 1,
    kind: 'tool' as const,
    status: 'completed' as const,
    presentation: 'Read',
  },
]
