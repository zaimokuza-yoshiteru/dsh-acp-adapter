import { describe, expect, it, vi } from 'vitest'
import type { AcpAuditTimelineEntry, AcpActivityView, AcpRecoveryView } from '../../../src/contract/remote.ts'
import type { AcpRemoteLike } from '../../../src/client/data/acp-remote.ts'
import {
  ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS,
  collectAcpSupportExport,
  AcpSupportExportError,
} from '../../../src/client/data/acp-support-export.ts'

function auditRow(seq: number, overrides: Partial<AcpAuditTimelineEntry> = {}): AcpAuditTimelineEntry {
  return {
    seq,
    time: seq * 100,
    kind: 'filesystem',
    severity: 'error',
    category: 'files',
    summaryCode: 'filesystem.read',
    subject: '/private/secret-path',
    status: 'ok',
    detail: '{"command":"private-command","message":"PRIVATE_BODY"}',
    ...overrides,
  }
}

function activityRow(revision: number): AcpActivityView {
  return {
    dshSessionId: 'raw-session-id',
    ownerDshSessionId: 'raw-owner-id',
    promptAnchorMessageId: 'raw-message-id',
    activityId: 'raw-activity-id',
    activitySeq: revision,
    revisionSeq: revision,
    time: revision * 100,
    kind: 'tool',
    status: 'completed',
    presentation: 'PRIVATE_BODY /private/secret-path',
  }
}

const recovery: AcpRecoveryView = {
  dshSessionId: 'raw-session-id',
  kind: 'reconciliation-required',
  cause: 'replay-overflow',
  detail: 'PRIVATE_BODY /private/secret-path',
  provider: 'private-provider',
  acpSessionId: 'private-acp-session',
  generation: 2,
  interruptedTurnId: 'private-turn',
  lastAttemptAt: 120,
  lastUserAction: 'private-action',
  updatedAt: 150,
}

function remoteOf(
  overrides: Partial<AcpRemoteLike> = {},
): Pick<AcpRemoteLike, 'auditTimeline' | 'activityPage' | 'recoverySnapshot'> {
  return {
    auditTimeline: vi.fn(
      async (
        _session: string,
        request?: { afterSeq?: number; limit?: number; captureSnapshot?: boolean; snapshotHead?: number },
      ) => ({
        ok: true as const,
        value: {
          sessionId: 'raw-session-id',
          entries: [auditRow((request?.afterSeq ?? 0) + 1)],
          snapshotHead: request?.snapshotHead ?? 1,
          scannedThrough: (request?.afterSeq ?? 0) + 1,
          scannedRecords: 1,
          unreadableRecords: 0,
          nextCursor: null,
          hasMore: false,
        },
      }),
    ),
    activityPage: vi.fn(async () => ({
      ok: true as const,
      value: { sessionId: 'raw-session-id', activities: [activityRow(1)], head: 1, nextCursor: null, hasMore: false },
    })),
    recoverySnapshot: vi.fn(async () => ({ ok: true as const, value: recovery })),
    ...overrides,
  } as unknown as Pick<AcpRemoteLike, 'auditTimeline' | 'activityPage' | 'recoverySnapshot'>
}

describe('ACP content-free support export', () => {
  it('keeps fixed audit/activity watermarks while paging and excludes raw session content', async () => {
    const remote = remoteOf({
      auditTimeline: vi.fn(
        async (
          _session: string,
          request?: { afterSeq?: number; limit?: number; captureSnapshot?: boolean; snapshotHead?: number },
        ) => {
          const after = request?.afterSeq ?? 0
          const entries =
            after === 0
              ? [auditRow(1, { kind: 'PRIVATE_KIND', status: 'arbitrary-status-from-user' })]
              : after === 1
                ? [auditRow(2)]
                : []
          const last = entries.at(-1)?.seq ?? after
          return {
            ok: true as const,
            value: {
              sessionId: 'raw-session-id',
              entries,
              snapshotHead: 2,
              scannedThrough: last,
              scannedRecords: entries.length,
              unreadableRecords: 0,
              nextCursor: entries.length ? last : null,
              hasMore: last < 2,
            },
          }
        },
      ),
      activityPage: vi.fn(
        async (
          _session: string,
          request?: { afterRevision?: number; snapshotHead?: number; captureSnapshot?: boolean },
        ) => {
          const after = request?.afterRevision ?? 0
          const activities = after === 0 ? [activityRow(1)] : [activityRow(2)]
          return {
            ok: true as const,
            value: { sessionId: 'raw-session-id', activities, head: 2, nextCursor: after + 1, hasMore: after + 1 < 2 },
          }
        },
      ),
    })
    const result = await collectAcpSupportExport(
      remote,
      'raw-session-id',
      '0.2.0',
      () => true,
      () => 500,
    )
    expect(result.audit.snapshotHead).toBe(2)
    expect(result.audit.rows.map((row) => row.sequence)).toEqual([1, 2])
    expect(result.activity.rows).toHaveLength(2)
    expect(result.audit.storedRecordsReachedHead).toBe(true)
    expect(result.runtimeHostVersion).toBeNull()
    const serialized = JSON.stringify(result)
    for (const secret of [
      'raw-session-id',
      'raw-owner-id',
      'raw-message-id',
      'PRIVATE_BODY',
      'private-command',
      'secret-path',
      'private-provider',
      'PRIVATE_KIND',
      'arbitrary-status-from-user',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(result.audit.rows[0]?.kind).toBe('other')
    expect(result.audit.rows[0]?.status).toBeNull()
    expect(result.recovery).toMatchObject({
      status: 'available',
      kind: 'reconciliation-required',
      cause: 'replay-overflow',
    })
    expect(remote.auditTimeline).toHaveBeenNthCalledWith(
      1,
      'raw-session-id',
      expect.objectContaining({ captureSnapshot: true }),
    )
    expect(remote.auditTimeline).toHaveBeenNthCalledWith(
      2,
      'raw-session-id',
      expect.objectContaining({ snapshotHead: 2 }),
    )
    expect(remote.activityPage).toHaveBeenNthCalledWith(
      1,
      'raw-session-id',
      expect.objectContaining({ captureSnapshot: true }),
    )
    expect(remote.activityPage).toHaveBeenNthCalledWith(
      2,
      'raw-session-id',
      expect.objectContaining({ snapshotHead: 2 }),
    )
  })

  it('stops at the documented row cap and marks the snapshot truncated', async () => {
    const remote = remoteOf({
      auditTimeline: vi.fn(
        async (_session: string, request?: { afterSeq?: number; limit?: number; snapshotHead?: number }) => {
          const after = request?.afterSeq ?? 0
          const entries = Array.from({ length: Math.min(100, 5_001 - after) }, (_, index) =>
            auditRow(after + index + 1),
          )
          const last = entries.at(-1)?.seq ?? after
          return {
            ok: true as const,
            value: {
              sessionId: 'raw-session-id',
              entries,
              snapshotHead: 5_001,
              scannedThrough: last,
              scannedRecords: entries.length,
              unreadableRecords: 0,
              nextCursor: last,
              hasMore: last < 5_001,
            },
          }
        },
      ),
      activityPage: vi.fn(async () => ({
        ok: true as const,
        value: { sessionId: 'raw-session-id', activities: [], head: 0, nextCursor: null, hasMore: false },
      })),
    })
    const result = await collectAcpSupportExport(remote, 'raw-session-id', '0.2.0')
    expect(result.audit.rows).toHaveLength(ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS)
    expect(result.audit.truncated).toBe(true)
    expect(result.audit.storedRecordsReachedHead).toBe(false)
  })

  it('advances a snapshot cursor across a full physical page of malformed rows', async () => {
    const remote = remoteOf({
      auditTimeline: vi.fn(
        async (_session: string, request?: { afterSeq?: number; limit?: number; snapshotHead?: number }) => {
          const after = request?.afterSeq ?? 0
          if (after === 0) {
            return {
              ok: true as const,
              value: {
                sessionId: 'raw-session-id',
                entries: [],
                snapshotHead: 101,
                scannedThrough: 100,
                scannedRecords: 100,
                unreadableRecords: 100,
                nextCursor: 100,
                hasMore: true,
              },
            }
          }
          return {
            ok: true as const,
            value: {
              sessionId: 'raw-session-id',
              entries: [auditRow(101)],
              snapshotHead: 101,
              scannedThrough: 101,
              scannedRecords: 1,
              unreadableRecords: 0,
              nextCursor: null,
              hasMore: false,
            },
          }
        },
      ),
      activityPage: vi.fn(async () => ({
        ok: true as const,
        value: { sessionId: 'raw-session-id', activities: [], head: 0, nextCursor: null, hasMore: false },
      })),
    })
    const result = await collectAcpSupportExport(remote, 'raw-session-id', '0.2.0')
    expect(result.audit.rows.map((row) => row.sequence)).toEqual([101])
    expect(result.audit.unreadableRecords).toBe(100)
    expect(result.audit.storedRecordsReachedHead).toBe(true)
    expect(result.audit.truncated).toBe(false)
    expect(remote.auditTimeline).toHaveBeenNthCalledWith(
      2,
      'raw-session-id',
      expect.objectContaining({ afterSeq: 100 }),
    )
  })

  it('does not query recovery or activity when audit ownership is rejected', async () => {
    const remote = remoteOf({
      auditTimeline: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'dsh-acp/user-rejected', message: 'unsafe error text' },
      })) as unknown as AcpRemoteLike['auditTimeline'],
    })
    await expect(collectAcpSupportExport(remote, 'other-session', '0.2.0')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(remote.activityPage).not.toHaveBeenCalled()
    expect(remote.recoverySnapshot).not.toHaveBeenCalled()
  })

  it('exports only a whitelisted local settlement status and never recovery detail', async () => {
    const view: AcpRecoveryView = {
      ...recovery,
      kind: 'healthy',
      localStatus: 'storage-error',
    }
    const remote = remoteOf({
      recoverySnapshot: vi.fn(async () => ({ ok: true as const, value: view })),
    })
    const result = await collectAcpSupportExport(remote, 'raw-session-id', '0.2.0')
    expect(result.recovery.localStatus).toBe('storage-error')
    const serialized = JSON.stringify(result.recovery)
    expect(serialized).not.toContain('PRIVATE_BODY')
    expect(serialized).not.toContain('/private/secret-path')

    const invalidView = { ...view, localStatus: 'PRIVATE_STATUS' } as unknown as AcpRecoveryView
    const invalidRemote = remoteOf({
      recoverySnapshot: vi.fn(async () => ({ ok: true as const, value: invalidView })),
    })
    const invalidResult = await collectAcpSupportExport(invalidRemote, 'raw-session-id', '0.2.0')
    expect(invalidResult.recovery.localStatus).toBeNull()
    expect(JSON.stringify(invalidResult.recovery)).not.toContain('PRIVATE_STATUS')
  })

  it('rejects a response after the selected session changes', async () => {
    let finish!: (value: Awaited<ReturnType<AcpRemoteLike['auditTimeline']>>) => void
    const delayed = new Promise<Awaited<ReturnType<AcpRemoteLike['auditTimeline']>>>((resolve) => {
      finish = resolve
    })
    const remote = remoteOf({
      auditTimeline: vi.fn(() => delayed) as unknown as AcpRemoteLike['auditTimeline'],
    })
    let current = true
    const pending = collectAcpSupportExport(remote, 'first-session', '0.2.0', () => current)
    current = false
    finish({
      ok: true,
      value: {
        sessionId: 'first-session',
        entries: [],
        snapshotHead: 0,
        scannedThrough: 0,
        scannedRecords: 0,
        unreadableRecords: 0,
        nextCursor: null,
        hasMore: false,
      },
    })
    await expect(pending).rejects.toBeInstanceOf(AcpSupportExportError)
    await expect(pending).rejects.toMatchObject({ code: 'session-changed' })
  })

  it('retries transient audit and activity page reads with the same snapshot cursor', async () => {
    vi.useFakeTimers()
    try {
      let auditPage = 0
      let activityPage = 0
      const remote = remoteOf({
        auditTimeline: vi.fn(
          async (
            _session: string,
            request?: { afterSeq?: number; limit?: number; captureSnapshot?: boolean; snapshotHead?: number },
          ) => {
            auditPage += 1
            const after = request?.afterSeq ?? 0
            if (after === 1 && auditPage === 2) throw new Error('temporary gateway failure')
            const seq = after + 1
            return {
              ok: true as const,
              value: {
                sessionId: 'raw-session-id',
                entries: [auditRow(seq)],
                snapshotHead: 2,
                scannedThrough: seq,
                scannedRecords: 1,
                unreadableRecords: 0,
                nextCursor: seq,
                hasMore: seq < 2,
              },
            }
          },
        ),
        activityPage: vi.fn(
          async (
            _session: string,
            request?: { afterRevision?: number; limit?: number; captureSnapshot?: boolean; snapshotHead?: number },
          ) => {
            activityPage += 1
            const after = request?.afterRevision ?? 0
            if (after === 1 && activityPage === 2) throw new Error('temporary internal failure')
            const revision = after + 1
            return {
              ok: true as const,
              value: {
                sessionId: 'raw-session-id',
                activities: [activityRow(revision)],
                head: 2,
                nextCursor: revision,
                hasMore: revision < 2,
              },
            }
          },
        ),
      })
      const pending = collectAcpSupportExport(remote, 'raw-session-id', '0.2.0')
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result.audit.rows.map((row) => row.sequence)).toEqual([1, 2])
      expect(result.activity.rows.map((row) => row.revision)).toEqual([1, 2])
      expect(remote.auditTimeline).toHaveBeenCalledTimes(3)
      expect(remote.activityPage).toHaveBeenCalledTimes(3)
      expect(remote.auditTimeline).toHaveBeenNthCalledWith(2, 'raw-session-id', {
        afterSeq: 1,
        limit: 100,
        snapshotHead: 2,
      })
      expect(remote.auditTimeline).toHaveBeenNthCalledWith(3, 'raw-session-id', {
        afterSeq: 1,
        limit: 100,
        snapshotHead: 2,
      })
      expect(remote.activityPage).toHaveBeenNthCalledWith(2, 'raw-session-id', {
        afterRevision: 1,
        limit: 100,
        snapshotHead: 2,
      })
      expect(remote.activityPage).toHaveBeenNthCalledWith(3, 'raw-session-id', {
        afterRevision: 1,
        limit: 100,
        snapshotHead: 2,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying a transient page read when its export is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const remote = remoteOf({
        auditTimeline: vi.fn(async () => {
          throw new Error('temporary gateway failure')
        }) as unknown as AcpRemoteLike['auditTimeline'],
      })
      const pending = collectAcpSupportExport(
        remote,
        'raw-session-id',
        '0.2.0',
        () => !controller.signal.aborted,
        Date.now,
        controller.signal,
      )
      await Promise.resolve()
      await Promise.resolve()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'session-changed' })
      await vi.runAllTimersAsync()
      expect(remote.auditTimeline).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry stable authorization or request failures', async () => {
    vi.useFakeTimers()
    try {
      const remote = remoteOf({
        auditTimeline: vi.fn(async () => ({
          ok: false as const,
          error: { code: 'gateway/bad-request', message: 'invalid request' },
        })) as unknown as AcpRemoteLike['auditTimeline'],
      })
      await expect(collectAcpSupportExport(remote, 'raw-session-id', '0.2.0')).rejects.toMatchObject({
        code: 'unavailable',
      })
      expect(remote.auditTimeline).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
