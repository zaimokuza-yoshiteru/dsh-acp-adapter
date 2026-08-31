import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExternalSubagentProjector } from '../../../src/host/subagent/external-projector.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

const observation = {
  profileKind: 'claude', vendorDelegationKey: 'child-1', vendorChildId: 'child-1', label: 'Code inspection',
  task: { text: 'Inspect code', source: 'structured-tool-input' as const },
  result: { text: 'Done', source: 'verbatim-child-final' as const, completeness: 'final-output' as const },
  status: 'completed' as const,
  timing: { observedStartedAt: 100, observedCompletedAt: 250, source: 'client-observed' as const },
  projectionEligible: true,
}

describe('external subagent projector', () => {
  it('publishes a native read-only task/result transcript after the parent durability barrier', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    const order: string[] = []
    const persistence = {
      inspect: vi.fn(async (id: string) => {
        const value = records.get(id)
        if (value === undefined) throw new Error('not found')
        return value
      }),
      create: vi.fn(async (meta: never) => { order.push('create'); records.set((meta as { id: string }).id, { meta, events: [] }) }),
      append: vi.fn(async (id: string, events: never[]) => { order.push('append'); records.get(id)!.events = events }),
    }
    const activities: Array<{ status: string; rawDetail?: string }> = []
    const projector = new ExternalSubagentProjector(persistence as never, {
      upsertActivity: vi.fn(async (row) => { activities.push(row); return row as never }),
    })
    const result = await projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'session-parent', parentCwd: '/tmp',
      flushParent: async () => { order.push('flush'); return true },
    })
    expect(order).toEqual(['flush', 'create', 'append'])
    expect(result?.childSessionId).toMatch(/^session-dsh-acp-/)
    const stored = records.get(result!.childSessionId)!
    expect(stored.events.map(event => (event as { type: string }).type)).toEqual(['subagent/descriptor', 'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    expect(JSON.stringify(stored.events)).toContain('Inspect code')
    expect(JSON.stringify(stored.events)).toContain('Done')
    expect(activities.map(row => row.status)).toEqual(['running', 'completed'])
  })

  it('is idempotent for the same evidence and rejects when the parent has no durability seam', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    const persistence = {
      inspect: async (id: string) => { const row = records.get(id); if (row === undefined) throw new Error('not found'); return row },
      create: async (meta: never) => { records.set((meta as { id: string }).id, { meta, events: [] }) },
      append: async (id: string, events: never[]) => { records.get(id)!.events = events },
    }
    const projector = new ExternalSubagentProjector(persistence as never, { upsertActivity: async row => row as never })
    const context = { profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true }
    const first = await projector.project(observation, context)
    const second = await projector.project(observation, context)
    expect(second).toEqual({ childSessionId: first?.childSessionId, created: false })
    await expect(projector.project(observation, { ...context, rootAcpSessionId: 'other', flushParent: async () => false })).rejects.toThrow('PARENT_NOT_DURABLE')
  })

  it('accepts an exact decoded raw log when the immediate inspection still exposes a stale prepared view', async () => {
    let meta: Record<string, unknown> | undefined
    let events: Record<string, unknown>[] = []
    let created = false
    const persistence = {
      inspect: vi.fn(async () => {
        if (!created || meta === undefined) throw new Error('not found')
        return { meta, events: [] }
      }),
      create: vi.fn(async (value: Record<string, unknown>) => { meta = value; created = true }),
      append: vi.fn(async (_id: string, value: Record<string, unknown>[]) => { events = value }),
      readRaw: vi.fn(async () => ({
        meta,
        filename: 'session.jsonl',
        content: `${JSON.stringify({ type: 'session', ...meta })}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      })),
    }
    const projector = new ExternalSubagentProjector(persistence as never, { upsertActivity: async row => row as never })
    await expect(projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'raw-race',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    })).resolves.toMatchObject({ created: true })
    expect(persistence.readRaw).toHaveBeenCalledOnce()
  })

  it('repairs a staged transaction from its canonical payload and fails closed on a conflicting child', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    const activities = new Map<string, Record<string, unknown>>()
    const sidecar = {
      upsertActivity: vi.fn(async (row: Record<string, unknown>) => {
        const previous = activities.get(row.dshSessionId as string)
        const committed = { activitySeq: previous?.activitySeq ?? 1, revisionSeq: Number(previous?.revisionSeq ?? 0) + 1, ...previous, ...row }
        activities.set(row.dshSessionId as string, committed)
        return committed as never
      }),
      listProjectedSubagentActivities: vi.fn(async () => [...activities.values()] as never),
    }
    const persistence = {
      inspect: vi.fn(async (id: string) => {
        const value = records.get(id)
        if (value === undefined) throw new Error('not found')
        return value
      }),
      create: vi.fn(async (meta: never) => { records.set((meta as { id: string }).id, { meta, events: [] }) }),
      append: vi.fn(async (id: string, events: never[]) => { records.get(id)!.events = events }),
    }
    const projector = new ExternalSubagentProjector(persistence as never, sidecar as never)
    const context = {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => false,
    }

    await expect(projector.project(observation, context)).rejects.toThrow('PARENT_NOT_DURABLE')
    const [staged] = [...activities.values()]
    expect(staged?.status).toBe('failed')
    const stagedDetail = JSON.parse(staged?.rawDetail as string) as { version: number; projectionHeader: { parentSession: string }; projectionLabel: string; projectionDigest: string }
    expect(stagedDetail.version).toBe(3)
    expect(stagedDetail.projectionHeader.parentSession).toBe('parent')
    expect(stagedDetail.projectionLabel).toBe('Code inspection')
    expect(stagedDetail.projectionDigest).toMatch(/^[a-f0-9]{64}$/)

    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 1, conflicted: 0 })
    expect(activities.get(staged!.dshSessionId as string)?.status).toBe('completed')

    records.set(staged!.dshSessionId as string, { meta: { id: staged!.dshSessionId, cwd: '/different' } as never, events: [] })
    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 0, repaired: 0, conflicted: 1 })
    expect(activities.get(staged!.dshSessionId as string)?.status).toBe('failed')
  })

  it('keeps the repair payload valid after real Activity redaction and long Agent text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-projection-'))
    const sidecar = createAcpSidecar({ root })
    const records = new Map<string, { meta: never; events: never[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    const persistence = {
      inspect: async (id: string) => { const row = records.get(id); if (row === undefined) throw new Error('not found'); return row },
      create: async (meta: never) => { records.set((meta as { id: string }).id, { meta, events: [] }) },
      append: async (id: string, events: never[]) => { records.get(id)!.events = events },
    }
    try {
      const projector = new ExternalSubagentProjector(persistence as never, sidecar)
      const result = await projector.project({
        ...observation,
        label: 'Inspect token=sk-1234567890abcdefghijklmnop',
        task: { ...observation.task, text: 'T'.repeat(20_000) },
        result: { ...observation.result, text: 'R'.repeat(20_000) },
      }, {
        profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
        parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
      })
      const [stored] = await sidecar.listProjectedSubagentActivities()
      expect(stored?.rawDetail?.length).toBeLessThan(16_384)
      expect(() => JSON.parse(stored!.rawDetail!)).not.toThrow()
      expect(JSON.parse(stored!.rawDetail!)).toMatchObject({ projectionLabel: 'Inspect token=<redacted-token>' })
      expect(records.get(result!.childSessionId)?.events[0]).toMatchObject({ data: { label: 'Inspect token=<redacted-token>' } })
      await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 0, conflicted: 0 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
