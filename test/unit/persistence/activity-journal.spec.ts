import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { AcpActivityJournalStore } from '../../../src/client/data/activity-journal.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []
afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function store(now = 1_700_000_000_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-'))
  roots.push(root)
  const sidecar = createAcpSidecar({ root, now: () => now })
  sidecars.push(sidecar)
  return { root, sidecar }
}

function activity(id: string, time: number | undefined = 1_700_000_000_000, overrides: Record<string, unknown> = {}) {
  return {
    dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1', activityId: id,
    time, kind: 'tool' as const, status: 'running' as const, presentation: 'Run command', ...overrides,
  }
}

describe('ACP activity journal', () => {
  it('benchmarks 1000 current activities across 10000 durable revisions', async () => {
    const { sidecar } = store()
    const started = performance.now()
    for (let revision = 0; revision < 10_000; revision += 1) {
      const activityId = `bench:${String(revision % 1_000)}`
      await sidecar.upsertActivity(activity(activityId, 1_700_000_000_000 + revision, {
        promptAnchorMessageId: `bench-anchor-${String(revision % 5)}`,
        activitySeq: revision < 1_000 ? revision + 1 : undefined,
        status: revision % 10 === 9 ? 'completed' : 'running',
      }))
    }
    const snapshots = await Promise.all(Array.from({ length: 5 }, (_, anchor) => sidecar.activitySnapshot(SessionId('session-1'), 200, { promptAnchorMessageId: `bench-anchor-${String(anchor)}` })))
    const elapsedMs = performance.now() - started
    console.info(`[activity-benchmark] 1000 activities / 10000 revisions: ${elapsedMs.toFixed(1)}ms`)
    expect(snapshots.flat()).toHaveLength(1_000)
    expect(await sidecar.activityHead(SessionId('session-1'))).toBe(10_000)
    // Non-strict guard: this is evidence against an accidental quadratic path,
    // not a machine-specific performance contract.
    expect(elapsedMs).toBeLessThan(15_000)
  }, 30_000)

  it('assigns a durable monotonic sequence and upserts an activity in place', async () => {
    const { sidecar } = store()
    const first = await sidecar.upsertActivity(activity('tool:1'))
    const update = await sidecar.upsertActivity(activity('tool:1', first.time + 1, { status: 'completed', presentation: 'Command completed' }))
    const second = await sidecar.upsertActivity(activity('tool:2', first.time + 2, { kind: 'terminal', presentation: 'Terminal activity' }))
    expect(update.activitySeq).toBe(first.activitySeq)
    expect(update.revisionSeq).toBe(secondRevision(first))
    expect(second.activitySeq).toBe(first.activitySeq + 1)
    expect(await sidecar.activityHead(SessionId('session-1'))).toBe(3)
    expect((await sidecar.activitySnapshot(SessionId('session-1'))).map((item) => [item.activityId, item.status])).toEqual([['tool:1', 'completed'], ['tool:2', 'running']])
  })

  it('returns a terminal revision after an opening cursor without moving the activity', async () => {
    const { sidecar } = store()
    const first = await sidecar.upsertActivity(activity('tool:cursor'))
    const cursor = await sidecar.activityHead(SessionId('session-1'))
    const updated = await sidecar.upsertActivity(activity('tool:cursor', first.time + 1, { status: 'completed', presentation: 'Finished' }))
    expect(updated.activitySeq).toBe(first.activitySeq)
    expect(updated.revisionSeq).toBeGreaterThan(cursor)
    expect((await sidecar.activityPage(SessionId('session-1'), cursor)).map((item) => [item.activityId, item.status, item.activitySeq])).toEqual([['tool:cursor', 'completed', first.activitySeq]])
  })

  it('keeps every mutation in the revision stream while snapshot exposes latest rows', async () => {
    const { sidecar } = store()
    const a = await sidecar.upsertActivity(activity('a'))
    await sidecar.upsertActivity(activity('b', a.time + 1, { presentation: 'Second activity' }))
    const aDone = await sidecar.upsertActivity(activity('a', a.time + 2, { status: 'completed', presentation: 'First activity complete' }))
    expect((await sidecar.activityPage(SessionId('session-1'), 0, 2)).map((row) => [row.activityId, row.revisionSeq])).toEqual([['a', 1], ['b', 2]])
    expect((await sidecar.activityPage(SessionId('session-1'), 2, 2)).map((row) => [row.activityId, row.revisionSeq, row.status])).toEqual([['a', aDone.revisionSeq, 'completed']])
    expect((await sidecar.activitySnapshot(SessionId('session-1'))).map((row) => [row.activityId, row.activitySeq, row.status])).toEqual([['a', 1, 'completed'], ['b', 2, 'running']])
  })

  it('rejects immutable identity changes and terminal regressions', async () => {
    const { sidecar } = store()
    await sidecar.upsertActivity(activity('fixed'))
    await expect(sidecar.upsertActivity(activity('fixed', 1_700_000_000_001, { kind: 'diff' }))).rejects.toThrow('ACP_ACTIVITY_IMMUTABLE')
    await sidecar.upsertActivity(activity('fixed', 1_700_000_000_002, { status: 'completed' }))
    await expect(sidecar.upsertActivity(activity('fixed', 1_700_000_000_003, { status: 'running' }))).rejects.toThrow('ACP_ACTIVITY_STATE')
  })

  it('supports opening snapshots and after-sequence pagination', async () => {
    const { sidecar } = store()
    await sidecar.upsertActivity(activity('one'))
    await sidecar.upsertActivity(activity('two', 1_700_000_000_001))
    await sidecar.upsertActivity(activity('three', 1_700_000_000_002))
    expect((await sidecar.activitySnapshot(SessionId('session-1'), 2)).map((item) => item.activityId)).toEqual(['one', 'two'])
    expect((await sidecar.activityPage(SessionId('session-1'), 1, 10)).map((item) => item.activityId)).toEqual(['two', 'three'])
  })

  it('serializes concurrent activity inserts and updates without sequence collisions', async () => {
    const { sidecar } = store()
    await Promise.all([sidecar.upsertActivity(activity('parallel-a')), sidecar.upsertActivity(activity('parallel-b', 1_700_000_000_001))])
    const rows = await Promise.all([
      sidecar.upsertActivity(activity('parallel-a', 1_700_000_000_002, { status: 'completed' })),
      sidecar.upsertActivity(activity('parallel-b', 1_700_000_000_003, { status: 'failed' })),
    ])
    expect(new Set(rows.map((row) => row.revisionSeq)).size).toBe(2)
    expect((await sidecar.activitySnapshot(SessionId('session-1'))).map((row) => row.activitySeq)).toEqual([1, 2])
  })

  it('survives a cold reopen', async () => {
    const { root, sidecar } = store()
    await sidecar.upsertActivity(activity('cold'))
    await sidecar.dispose()
    const reopened = createAcpSidecar({ root })
    expect((await reopened.activitySnapshot(SessionId('session-1'))).map((item) => item.activityId)).toEqual(['cold'])
    expect(await reopened.activityHead(SessionId('session-1'))).toBe(1)
    await reopened.dispose()
  })

  it('proves durable ownership for cold reads and denies missing or unrelated sessions', async () => {
    const { root, sidecar } = store()
    expect(await sidecar.hasDurableActivityOwner(SessionId('session-1'))).toBe(false)
    await sidecar.append(SessionId('bound-parent'), {
      kind: 'binding', time: 1,
      data: {
        provider: 'acp-codex', agentSessionId: 'agent-1', profileId: 'codex', canonicalCwd: '/tmp/work',
        launchFingerprint: { command: 'codex-acp', args: [], envKeys: [] },
        agent: { name: 'codex-acp', version: '1.0.0' }, protocolVersion: 1,
        capabilityHash: 'cap', configHash: 'config', generation: 1, bindingEpoch: 1,
        committedPromptOrdinal: 0, historyBaseSeq: 0, establishedAt: 1, dshCommittedSeq: 0,
      },
    })
    expect(await sidecar.hasDurableActivityOwner(SessionId('bound-parent'))).toBe(true)
    await sidecar.upsertActivity(activity('owner-proof'))
    expect(await sidecar.hasDurableActivityOwner(SessionId('session-1'))).toBe(true)
    expect(await sidecar.hasDurableActivityOwner(SessionId('random-session'))).toBe(false)
    await sidecar.dispose()

    const reopened = createAcpSidecar({ root })
    expect(await reopened.hasDurableActivityOwner(SessionId('session-1'))).toBe(true)
    expect(await reopened.hasDurableActivityOwner(SessionId('random-session'))).toBe(false)
    await reopened.dispose()
  })

  it('bounds presentation and raw detail without allowing unbounded rows', async () => {
    const { sidecar } = store()
    const saved = await sidecar.upsertActivity(activity('bounded', undefined, { presentation: 'x'.repeat(10_000), rawDetail: 'y'.repeat(100_000), rawDetailRef: 'z'.repeat(1_000) }))
    expect(saved.presentation.length).toBeLessThanOrEqual(2_048)
    expect(saved.rawDetail?.length).toBeLessThanOrEqual(16_384)
    expect(saved.rawDetailRef?.length).toBeLessThanOrEqual(512)
  })

  it('redacts sensitive JSON fields and leaves a truncation marker', async () => {
    const { sidecar } = store()
    const saved = await sidecar.upsertActivity(activity('redacted', undefined, { rawDetail: JSON.stringify({ apiKey: 'do-not-store', output: 'x'.repeat(30_000) }) }))
    expect(saved.rawDetail).not.toContain('do-not-store')
    expect(saved.rawDetail).toContain('[truncated]')
    const nested = await sidecar.upsertActivity(activity('nested', undefined, { rawDetail: JSON.stringify({ output: 'Bearer nested-secret-value' }) }))
    expect(nested.rawDetail).toContain('Bearer <redacted>')
    const plain = await sidecar.upsertActivity(activity('plain', undefined, { rawDetail: 'authorization: Bearer plain-secret-value sk-abcdefghijklmnopqrstuvwxyz123456' }))
    expect(plain.rawDetail).not.toContain('plain-secret-value')
    expect(plain.rawDetail).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('filters snapshots, revisions, and heads by owner and prompt anchor', async () => {
    const { sidecar } = store()
    await sidecar.upsertActivity(activity('parent', undefined, { ownerDshSessionId: 'parent', promptAnchorMessageId: 'p-1' }))
    await sidecar.upsertActivity(activity('child', 1_700_000_000_001, { ownerDshSessionId: 'child', promptAnchorMessageId: 'c-1' }))
    expect((await sidecar.activitySnapshot(SessionId('session-1'), 100, { ownerDshSessionId: 'child', promptAnchorMessageId: 'c-1' })).map((row) => row.activityId)).toEqual(['child'])
    expect((await sidecar.activityPage(SessionId('session-1'), 0, 100, { ownerDshSessionId: 'parent' })).map((row) => row.activityId)).toEqual(['parent'])
    expect(await sidecar.activityHead(SessionId('session-1'), { promptAnchorMessageId: 'missing' })).toBe(0)
  })

  it('notifies subscribers only after a durable commit and honors the filter', async () => {
    const { sidecar } = store()
    const received: number[] = []
    const dispose = sidecar.subscribeActivity(SessionId('session-1'), { ownerDshSessionId: 'session-1', promptAnchorMessageId: 'wanted' }, (row) => {
      received.push(row.revisionSeq)
      expect(row.activityId).toBe('wanted')
    })
    await sidecar.upsertActivity(activity('other', undefined, { promptAnchorMessageId: 'other' }))
    const wanted = await sidecar.upsertActivity(activity('wanted', 1_700_000_000_001, { promptAnchorMessageId: 'wanted' }))
    expect(received).toEqual([wanted.revisionSeq])
    expect((await sidecar.activityPage(SessionId('session-1'), 0)).map((row) => row.revisionSeq)).toEqual([1, 2])
    dispose()
    await sidecar.upsertActivity(activity('wanted', 1_700_000_000_002, { promptAnchorMessageId: 'wanted', status: 'completed' }))
    expect(received).toEqual([wanted.revisionSeq])
  })
})

describe('ACP client activity journal cursor', () => {
  const row = (revisionSeq: number, activityId = 'tool-1', status: 'running' | 'completed' = 'running') => ({
    dshSessionId: 'session-1', ownerDshSessionId: 'session-1', promptAnchorMessageId: 'user-1',
    activityId, activitySeq: activityId === 'tool-1' ? 1 : 2, revisionSeq, time: revisionSeq,
    kind: 'tool' as const, status, presentation: activityId,
  })

  it('keeps opening state and applies contiguous reconnect revisions', () => {
    const store = new AcpActivityJournalStore()
    store.apply({ type: 'opened', cursor: 2, head: 2, activities: [row(2, 'tool-1', 'running')] })
    store.applyPage([row(3, 'tool-1', 'completed')], 3)
    expect(store.head).toBe(3)
    expect(store.values('session-1', 'user-1')[0]?.status).toBe('completed')
  })

  it('rejects a filtered/non-contiguous page so the caller must repair from its cursor', () => {
    const store = new AcpActivityJournalStore()
    store.apply({ type: 'opened', cursor: 2, head: 2, activities: [] })
    expect(() => store.apply({ type: 'entry', activity: row(4) })).toThrow('journal gap')
  })
})

function secondRevision(first: { revisionSeq: number }): number {
  return first.revisionSeq + 1
}
