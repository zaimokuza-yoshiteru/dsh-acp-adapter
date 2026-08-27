import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'

describe('ACP audit timeline Remote', () => {
  it('returns a bounded cursor page without exposing raw persistence payloads', async () => {
    const rows = [
      { seq: 1, time: 100, kind: 'binding', category: 'agent' as const, summaryCode: 'binding.established' as const, subject: 'codex', status: null, detail: null },
      { seq: 2, time: 200, kind: 'permission', category: 'permission' as const, summaryCode: 'permission.decided' as const, subject: 'call-1', status: 'selected', detail: '{"optionId":"allow_once"}' },
      { seq: 3, time: 300, kind: 'filesystem', category: 'files' as const, summaryCode: 'filesystem.operation' as const, subject: '/tmp/file', status: 'ok', detail: '{"path":"/tmp/file"}' },
    ]
    const service = new AcpRemoteService(new Context(), {
      registry: {
        agents: () => new Map(),
        probeCache: {
          probeSnapshot: () => undefined,
          invalidateProbe: () => undefined,
          listModels: async () => undefined,
        },
      },
      resolveLiveAgent: () => undefined,
      auditTimeline: {
        list: async (_sessionId, afterSeq, limit) => rows.filter((row) => row.seq > afterSeq).slice(0, limit),
        hasMore: async (_sessionId, seq) => rows.some((row) => row.seq > seq),
      },
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
        probeCache: { probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined },
      },
      resolveLiveAgent: () => undefined,
      auditTimeline: { list: async () => [], hasMore: async () => false },
    })
    await expect(service.auditTimeline('session-1', { limit: 101 })).rejects.toThrow('page size')
    await expect(service.auditTimeline('session-1', { afterSeq: -1 })).rejects.toThrow('cursor')
  })

  it('fails clearly when the sidecar audit seam is unavailable', async () => {
    const service = new AcpRemoteService(new Context(), {
      registry: {
        agents: () => new Map(),
        probeCache: { probeSnapshot: () => undefined, invalidateProbe: () => undefined, listModels: async () => undefined },
      },
      resolveLiveAgent: () => undefined,
    })
    await expect(service.auditTimeline('session-1')).rejects.toThrow('unavailable')
  })
})
