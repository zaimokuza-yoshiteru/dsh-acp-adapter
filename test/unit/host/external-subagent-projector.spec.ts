import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXTERNAL_SUBAGENT_ACTIVITY_ANCHOR, ExternalSubagentProjector } from '../../../src/host/subagent/external-projector.ts'
import { SessionAlreadyExistsError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence'
import { SessionId, SessionLogOffset, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'

function handleStorage(records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>(), order: string[] = [], eventState: SessionSeedEventState = 'detached') {
  const handle = (id: string, access: 'read' | 'write'): SessionHandle => ({
    id: SessionId(id), header: records.get(id)!.meta, access, inheritedEventCount: SessionLogOffset(0),
    read: async (): Promise<SessionHandleReadResult> => ({ eventState, events: eventState === 'detached' ? structuredClone(records.get(id)!.events) : [...records.get(id)!.events] }),
    append: async (events: readonly SessionEvent[]) => { order.push('append'); records.get(id)!.events.push(...events.map(event => snapshotSessionEvent(event))) },
    flush: async () => { order.push('child-flush') },
    close: async () => { order.push(`${access}-close`) },
    [Symbol.asyncDispose]: async () => { order.push(`${access}-close`) },
  })
  return {
    open: vi.fn(async (id: string, access: 'read' | 'write') => {
      if (!records.has(id)) throw new SessionPersistenceNotFoundError(SessionId(id))
      return handle(id, access)
    }),
    create: vi.fn(async (meta: SessionHeader) => {
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
    const projector = new ExternalSubagentProjector(persistence, sidecar as never)
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

  it.each(['detached', 'shared-frozen'] as const)('publishes a native transcript after the parent barrier with %s events', async eventState => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    const order: string[] = []
    const persistence = handleStorage(records, order, eventState)
    const activities: Array<{ status: string; rawDetail?: string }> = []
    const projector = new ExternalSubagentProjector(persistence, {
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
    expect(stored.events.map(event => (event as { type: string }).type)).toEqual(['subagent/descriptor', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    expect(JSON.stringify(stored.events)).toContain('Inspect code')
    expect(JSON.stringify(stored.events)).toContain('Done')
    expect(activities.map(row => row.status)).toEqual(['running', 'completed'])
  })

  it('is idempotent for the same evidence and rejects when the parent has no durability seam', async () => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    const persistence = handleStorage(records)
    const projector = new ExternalSubagentProjector(persistence, { upsertActivity: async row => row as never })
    const context = { profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true }
    const first = await projector.project(observation, context)
    const second = await projector.project(observation, context)
    expect(second).toEqual({ childSessionId: first?.childSessionId, created: false })
    await expect(projector.project(observation, { ...context, rootAcpSessionId: 'other', flushParent: async () => false })).rejects.toThrow('PARENT_NOT_DURABLE')
  })

  it('persists a stream whose content and usage reproduce the reported result', async () => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    const projector = new ExternalSubagentProjector(handleStorage(records), { upsertActivity: async row => row as never })
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

  it.each(['missing stream', 'mismatched stream', 'mismatched usage'])('rejects a stored current projection with %s', async corruption => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    const projector = new ExternalSubagentProjector(handleStorage(records), { upsertActivity: async row => row as never })
    const context = { profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true }
    const result = await projector.project(observation, context)
    const record = records.get(result!.childSessionId)!
    const corrupted = structuredClone(record.events)
    const event = corrupted.find(event => event.type === 'assistant/message')!
    if (event.type !== 'assistant/message') throw new Error('missing settlement')
    if (corruption === 'missing stream') event.data.stream = []
    else if (corruption === 'mismatched stream') event.data.stream = [{ type: 'chunk', time: 250, chunk: { type: 'text-delta', index: 0, text: 'foreign content' } }]
    else event.data.usage = { inputTokens: 100, outputTokens: 200 }
    record.events = corrupted
    await expect(projector.project(observation, context)).rejects.toThrow('PROJECTION_CONFLICT')
    expect(record.events).toEqual(corrupted)
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
    const projector = new ExternalSubagentProjector(storage, { upsertActivity: async row => { statuses.push(row.status); return row as never } })
    await expect(projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    })).rejects.toThrow('disk unavailable')
    expect(statuses).toEqual(['running', 'failed'])
    expect(order.at(-1)).toBe('write-close')
  })

  it.each(['external-subagent-v1.json', 'external-subagent-v2.json'])('leaves unsupported historical evidence untouched: %s', async filename => {
    const fixture = JSON.parse(fs.readFileSync(new URL(`../../fixtures/${filename}`, import.meta.url), 'utf8'))
    const row = { dshSessionId: fixture.detail.childSessionId, rawDetail: JSON.stringify(fixture.detail) }
    const original = structuredClone(row)
    const storage = handleStorage()
    const update = vi.fn(async row => row)
    const projector = new ExternalSubagentProjector(storage, {
      upsertActivity: update,
      listProjectedSubagentActivities: async () => [row] as never,
    })
    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 0, repaired: 0, conflicted: 0 })
    expect(row).toEqual(original)
    expect(storage.create).not.toHaveBeenCalled()
    expect(storage.open).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('repairs a staged transaction from its canonical payload and fails closed on a conflicting child', async () => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
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
    const projector = new ExternalSubagentProjector(persistence, sidecar as never)
    const context = {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => false,
    }

    await expect(projector.project(observation, context)).rejects.toThrow('PARENT_NOT_DURABLE')
    const [staged] = [...activities.values()]
    expect(staged?.status).toBe('failed')
    const stagedDetail = JSON.parse(staged?.rawDetail as string) as { version: number; projectionHeader: { parentSession: string }; projectionLabel: string; projectionDigest: string }
    expect(stagedDetail.version).toBe(5)
    expect(stagedDetail.projectionHeader.parentSession).toBe('parent')
    expect(stagedDetail.projectionLabel).toBe('Code inspection')
    expect(stagedDetail.projectionDigest).toMatch(/^[a-f0-9]{64}$/)

    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 1, conflicted: 0 })
    expect(activities.get(staged!.dshSessionId as string)?.status).toBe('completed')

    records.set(staged!.dshSessionId as string, { meta: { id: staged!.dshSessionId, cwd: '/different' } as never, events: [] })
    await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 0, repaired: 0, conflicted: 1 })
    expect(activities.get(staged!.dshSessionId as string)?.status).toBe('failed')
  })

  it('migrates authenticated V3 sidecar transactions through the released catalog and publishes discovery after commit', async () => {
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    let row: Record<string, unknown> | undefined
    const sidecar = {
      upsertActivity: async (value: Record<string, unknown>) => { row = value; return value as never },
      listProjectedSubagentActivities: async () => row === undefined ? [] : [row] as never,
    }
    const projector = new ExternalSubagentProjector(handleStorage(records), sidecar)
    const result = await projector.project(observation, {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root', parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    })
    const detail = JSON.parse(row!.rawDetail as string)
    detail.projectionHeader.version = 3
    const original = { header: detail.projectionHeader, events: records.get(result!.childSessionId)!.events }
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : value !== null && typeof value === 'object'
        ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
        : JSON.stringify(value)
    detail.projectionDigest = createHash('sha256').update(canonical(original)).digest('hex')
    row = { ...row, rawDetail: JSON.stringify(detail) }
    records.delete(result!.childSessionId)
    const publish = vi.fn(async (header: SessionHeader, label: string) => {
      expect(records.get(header.id)?.events).toHaveLength(7)
      expect(header.version).toBe(4)
      expect(label).toBe('Code inspection')
    })
    const repair = new ExternalSubagentProjector(handleStorage(records), sidecar, publish)
    expect(await repair.repairInterrupted()).toEqual({ committed: 1, repaired: 1, conflicted: 0 })
    expect(publish).toHaveBeenCalledOnce()
    expect(await repair.repairInterrupted()).toEqual({ committed: 1, repaired: 0, conflicted: 0 })
    detail.projectionDigest = 'tampered'
    row = { ...row, rawDetail: JSON.stringify(detail) }
    expect(await repair.repairInterrupted()).toEqual({ committed: 0, repaired: 0, conflicted: 0 })
  })

  it('keeps the repair payload valid after real Activity redaction and long Agent text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-projection-'))
    const sidecar = createAcpSidecar({ root })
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    const persistence = handleStorage(records)
    try {
      const projector = new ExternalSubagentProjector(persistence, sidecar)
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
      expect(JSON.parse(stored!.rawDetail!)).toMatchObject({ projectionLabel: 'Inspect token=<redacted>' })
      expect(records.get(result!.childSessionId)?.events[0]).toMatchObject({ data: { label: 'Inspect token=<redacted>' } })
      await expect(projector.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 0, conflicted: 0 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts text before digesting and restores numeric usage after a real sidecar close/reopen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-projection-reopen-'))
    let sidecar = createAcpSidecar({ root })
    const records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    records.set('parent', { meta: { id: 'parent', cwd: '/tmp' } as never, events: [] })
    const persistence = handleStorage(records)
    persistence.create.mockRejectedValueOnce(new Error('simulated projection commit failure'))
    const context = {
      profileId: 'claude', bindingGeneration: 1, rootAcpSessionId: 'root',
      parentDshSessionId: 'parent', parentCwd: '/tmp', flushParent: async () => true,
    }
    const input = {
      ...observation,
      label: 'Inspect token=label-secret',
      task: { ...observation.task, text: 'Read apiKey=task-secret' },
      result: { ...observation.result, text: 'Bearer result-secret-value' },
      model: { id: 'provider/apiKey=model-secret', source: 'agent-structured-live' as const },
      usage: { inputTokens: 17, outputTokens: 4, cacheReadTokens: 8, totalTokens: 21, source: 'agent-structured-live' as const },
    }
    try {
      const first = new ExternalSubagentProjector(persistence, sidecar)
      await expect(first.project(input, context)).rejects.toThrow('simulated projection commit failure')
      const [staged] = await sidecar.listProjectedSubagentActivities()
      const stagedDetail = JSON.parse(staged!.rawDetail!) as { task: { text: string }; result: { text: string }; model: { id: string }; usage: Record<string, unknown>; projectionLabel: string }
      expect(stagedDetail.task.text).toBe('Read apiKey=<redacted>')
      expect(stagedDetail.result.text).toBe('Bearer <redacted>')
      expect(stagedDetail.projectionLabel).toBe('Inspect token=<redacted>')
      expect(stagedDetail.model.id).toBe('provider/apiKey=<redacted>')
      expect(stagedDetail.usage).toMatchObject({ inputTokens: 17, outputTokens: 4, cacheReadTokens: 8, totalTokens: 21 })

      await sidecar.dispose()
      sidecar = createAcpSidecar({ root })
      const reopened = new ExternalSubagentProjector(persistence, sidecar)
      await expect(reopened.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 1, conflicted: 0 })
      const [restored] = await sidecar.listProjectedSubagentActivities()
      expect(restored?.status).toBe('completed')
      const child = records.get(restored!.dshSessionId)!
      const assistant = child.events.find(event => event.type === 'assistant/message')
      expect(assistant?.type === 'assistant/message' ? assistant.data.usage : undefined).toMatchObject({ inputTokens: 17, outputTokens: 4 })
      expect(assistant?.type === 'assistant/message' ? assistant.data.message.source : undefined).toMatchObject({ model: 'provider/apiKey=<redacted>' })
      expect(JSON.stringify(child.events)).not.toContain('task-secret')
      expect(JSON.stringify(child.events)).not.toContain('result-secret-value')

      const brokenChildId = 'session-dsh-acp-broken-v5'
      const broken = { ...stagedDetail, childSessionId: brokenChildId, projectionHeader: { ...JSON.parse(staged!.rawDetail!).projectionHeader, id: brokenChildId }, usage: { ...stagedDetail.usage, inputTokens: '[redacted]' } }
      const unsupportedChildId = 'session-dsh-acp-unsupported-header'
      const unsupported = { ...broken, childSessionId: unsupportedChildId, projectionHeader: { ...broken.projectionHeader, id: unsupportedChildId, version: 999 } }
      const activity = (dshSessionId: string, detail: unknown) => ({
        dshSessionId, ownerDshSessionId: dshSessionId,
        promptAnchorMessageId: EXTERNAL_SUBAGENT_ACTIVITY_ANCHOR,
        activityId: 'external-subagent-record', time: 300, kind: 'delegated' as const,
        status: 'running' as const, presentation: 'test', rawDetail: JSON.stringify(detail),
      })
      await sidecar.upsertActivity(activity(brokenChildId, broken))
      await sidecar.upsertActivity(activity(unsupportedChildId, unsupported))
      await expect(reopened.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 0, conflicted: 1 })
      const afterRepair = await sidecar.listProjectedSubagentActivities()
      expect(afterRepair.find(row => row.dshSessionId === brokenChildId)?.status).toBe('failed')
      expect(afterRepair.find(row => row.dshSessionId === unsupportedChildId)?.status).toBe('running')
      expect(JSON.parse(afterRepair.find(row => row.dshSessionId === brokenChildId)!.rawDetail!)).toMatchObject({ childSessionId: brokenChildId })
      await expect(reopened.repairInterrupted()).resolves.toEqual({ committed: 1, repaired: 0, conflicted: 0 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
