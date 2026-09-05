import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExternalSubagentProjector } from '../../../src/host/subagent/external-projector.ts'
import { SessionAlreadyExistsError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'

function handleStorage(records = new Map<string, { meta: never; events: never[] }>(), order: string[] = []) {
  const handle = (id: string, access: 'read' | 'write') => ({
    id, header: records.get(id)!.meta, access, inheritedEventCount: 0,
    read: async () => records.get(id)!.events,
    append: async (events: never[]) => { order.push('append'); records.get(id)!.events.push(...events) },
    flush: async () => { order.push('child-flush') },
    close: async () => { order.push(`${access}-close`) },
    [Symbol.asyncDispose]: async () => { order.push(`${access}-close`) },
  })
  return {
    open: vi.fn(async (id: string, access: 'read' | 'write') => {
      if (!records.has(id)) throw new SessionPersistenceNotFoundError(SessionId(id))
      return handle(id, access)
    }),
    create: vi.fn(async (meta: never) => {
      const id = (meta as { id: string }).id
      if (records.has(id)) throw new SessionAlreadyExistsError(SessionId(id))
      order.push('create'); records.set(id, { meta, events: [] })
      return handle(id, 'write')
    }),
  }
}

const observation = {
  profileKind: 'claude', vendorDelegationKey: 'child-1', vendorChildId: 'child-1', label: 'Code inspection',
  task: { text: 'Inspect code', source: 'structured-tool-input' as const },
  result: { text: 'Done', source: 'verbatim-child-final' as const, completeness: 'final-output' as const },
  status: 'completed' as const,
  timing: { observedStartedAt: 100, observedCompletedAt: 250, source: 'client-observed' as const },
  projectionEligible: true,
}

describe('external subagent projector', () => {
  it('ignores failed or evidence-incomplete delegations even when projection is automatic', async () => {
    const persistence = handleStorage()
    const sidecar = { upsertActivity: vi.fn() }
    const projector = new ExternalSubagentProjector(persistence as never, sidecar as never)
    const context = {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: vi.fn(async () => true),
    }

    await expect(projector.project({ ...observation, projectionEligible: false }, context)).resolves.toBeUndefined()
    await expect(projector.project({ ...observation, status: 'failed' }, context)).resolves.toBeUndefined()
    expect(context.flushParent).not.toHaveBeenCalled()
    expect(persistence.create).not.toHaveBeenCalled()
    expect(sidecar.upsertActivity).not.toHaveBeenCalled()
  })

  it('publishes a native read-only task/result transcript after the parent durability barrier', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    const order: string[] = []
    const persistence = handleStorage(records, order)
    const activities: Array<{ status: string; rawDetail?: string }> = []
    const projector = new ExternalSubagentProjector(persistence as never, {
      upsertActivity: vi.fn(async (row) => { activities.push(row); return row as never }),
    })
    const result = await projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'session-parent', parentCwd: '/tmp',
      flushParent: async () => { order.push('flush'); return true },
    })
    expect(order).toEqual(['flush', 'create', 'append', 'child-flush', 'write-close'])
    expect(result?.childSessionId).toMatch(/^session-dsh-acp-/)
    const stored = records.get(result!.childSessionId)!
    expect(stored.events.map(event => (event as { type: string }).type)).toEqual(['subagent/descriptor', 'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    expect(JSON.stringify(stored.events)).toContain('Inspect code')
    expect(JSON.stringify(stored.events)).toContain('Done')
    expect(activities.map(row => row.status)).toEqual(['running', 'completed'])
  })

  it('is idempotent for the same evidence and rejects when the parent has no durability seam', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    const persistence = handleStorage(records)
    const projector = new ExternalSubagentProjector(persistence as never, { upsertActivity: async row => row as never })
    const context = { profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true }
    const first = await projector.project(observation, context)
    const second = await projector.project(observation, context)
    expect(second).toEqual({ childSessionId: first?.childSessionId, created: false })
    await expect(projector.project(observation, { ...context, rootAcpSessionId: 'other', flushParent: async () => false })).rejects.toThrow('PARENT_NOT_DURABLE')
  })

  it('persists a stream whose content and usage reproduce the reported result', async () => {
    const records = new Map<string, { meta: never; events: never[] }>()
    const projector = new ExternalSubagentProjector(handleStorage(records) as never, { upsertActivity: async row => row as never })
    const result = await projector.project({ ...observation, usage: { inputTokens: 10, outputTokens: 3, source: 'agent-structured-live' } }, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    })
    const events = records.get(result!.childSessionId)!.events as import('@deepseek-ai/dsh-session').SessionEvent[]
    const event = events.find(event => event.type === 'assistant/message')!
    if (event.type !== 'assistant/message') throw new Error('missing assistant settlement')
    const assembler = new BlockAssembler()
    for (const { chunk, time } of expandAssistantStream(event.data.stream)) {
      expect(time).toBe(250)
      assembler.push(chunk)
    }
    expect(assembler.blocks()).toEqual(event.data.message.content)
    expect(assembler.usage).toEqual(event.data.usage)
  })

  it.each(['flush', 'dispose'])('does not publish completion when %s fails', async stage => {
    const order: string[] = []
    const storage = handleStorage(undefined, order)
    const create = storage.create.getMockImplementation()!
    storage.create.mockImplementation(async header => {
      const handle = await create(header)
      return {
        ...handle,
        ...(stage === 'flush'
          ? { flush: async () => { throw new Error('disk unavailable') } }
          : { [Symbol.asyncDispose]: async () => { await handle[Symbol.asyncDispose](); throw new Error('disk unavailable') } }),
      }
    })
    const statuses: string[] = []
    const projector = new ExternalSubagentProjector(storage as never, { upsertActivity: async row => { statuses.push(row.status); return row as never } })
    await expect(projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    })).rejects.toThrow('disk unavailable')
    expect(statuses).toEqual(['running', 'failed'])
    expect(order.at(-1)).toBe('write-close')
  })

  it.each([0, 4, 7])('recovers an interrupted released-v1 projection with %s existing events', async length => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/external-subagent-v1.json', import.meta.url), 'utf8'))
    const records = new Map<string, { meta: never; events: never[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    if (length > 0) records.set(fixture.detail.childSessionId, {
      meta: { ...fixture.detail.projectionHeader, version: 2 } as never,
      events: fixture.events.slice(0, length).map((event: { type: string; data: object }) => event.type === 'assistant/message'
        ? { ...event, data: { ...event.data, stream: [] } } : event),
    })
    const row = { dshSessionId: fixture.detail.childSessionId, rawDetail: JSON.stringify(fixture.detail) }
    const projector = new ExternalSubagentProjector(handleStorage(records) as never, {
      upsertActivity: async row => row as never,
      listProjectedSubagentActivities: async () => [row] as never,
    })
    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: length === 7 ? 0 : 1, conflicted: 0 })
    expect(records.get(row.dshSessionId)!.events).toEqual(fixture.events.map((event: { type: string; data: object }) =>
      event.type === 'assistant/message' ? { ...event, data: { ...event.data, stream: [] } } : event))
    expect(JSON.parse(row.rawDetail)).toEqual(fixture.detail)
    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 0, conflicted: 0 })
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
    const persistence = handleStorage(records)
    const projector = new ExternalSubagentProjector(persistence as never, sidecar as never)
    const context = {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => false,
    }

    await expect(projector.project(observation, context)).rejects.toThrow('PARENT_NOT_DURABLE')
    const [staged] = [...activities.values()]
    expect(staged?.status).toBe('failed')
    const stagedDetail = JSON.parse(staged?.rawDetail as string) as { version: number; projectionHeader: { parentSession: string }; projectionLabel: string; projectionDigest: string }
    expect(stagedDetail.version).toBe(4)
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
    const persistence = handleStorage(records)
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
