import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { agyPreToolPolicy } from '../../../src/host/composition/agy-pre-tool-policy.ts'
import AcpPermissionPolicy from '../../../src/host/composition/external-permission-policy.ts'
import { auditTimelineRowOf } from '../../../src/host/composition/audit-row.ts'
import type { AcpPreToolDenialAuditData } from '../../../src/domain/policy/events.ts'
import type { AcpPreToolPolicyDecision } from '../../../src/contract/permission-policy.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AcpPermissionPolicy)
  const session = Session.create(SessionId('pre-tool-test'))
  const agent = { ctx, session, id: session.id, status: 'running' } as Agent
  let owner = agent
  ctx.provide('agents', { get: () => owner } as never)
  const append = vi.fn(async (_event: AcpPreToolDenialAuditData) => {})
  const handlers = agyPreToolPolicy(ctx, session.id, append)
  const controller = new AbortController()
  const call = { toolCallId: 'call-1', kind: 'execute' as const, rawInput: { CommandLine: 'echo test' } }
  const evaluate = () => handlers.onAgyPreToolUse!('acp-id', call, controller.signal)
  return {
    ctx,
    agent,
    append,
    has: handlers.hasAgyPreToolPolicy!,
    evaluate,
    controller,
    replace: () => {
      owner = { ...agent } as Agent
    },
  }
}

it('enables only matching scoped providers; isolates native approval and durably records the one-time denial', async () => {
  const f = await setup()
  const native = vi.fn(async () => 'not-applicable' as const)
  f.ctx.on('dsh-acp/binary-permission-policy', native)
  const sibling = { ...f.agent, id: SessionId('another-session') } as Agent
  createScope(f.ctx, sibling).ctx.on('dsh-acp/pre-tool-policy', async () => ({
    decision: 'deny-once',
    reason: 'other',
  }))
  expect(f.has()).toBe(false)
  expect(await f.evaluate()).toEqual({ decision: 'delegate' })
  const remove = f.ctx.on('dsh-acp/pre-tool-policy', async (req) => {
    expect(req.agent).toBe(f.agent)
    expect(req.profile).toBe('antigravity')
    expect(req).not.toHaveProperty('requestId')
    expect(req.params).not.toHaveProperty('options')
    expect(Object.isFrozen(req.params.toolCall.rawInput)).toBe(true)
    return { decision: 'deny-once', reason: 'POL-abc123 password=private' }
  })
  expect(f.has()).toBe(true)
  const denied = await f.evaluate()
  expect(denied).toMatchObject({ decision: 'deny', reason: expect.stringContaining('POL-abc123') })
  expect(JSON.stringify(denied)).not.toContain('private')
  expect(f.append).toHaveBeenCalledTimes(1)
  const data = f.append.mock.calls[0]![0]
  expect(data).toMatchObject({
    phase: 'pre-tool',
    source: 'agy-pre-tool-use',
    outcome: 'deny-once',
    agentSessionId: 'acp-id',
    toolCallId: 'call-1',
    reason: denied.decision === 'deny' && denied.reason,
  })
  expect(data).not.toHaveProperty('requestId')
  expect(data).not.toHaveProperty('optionId')
  expect(
    auditTimelineRowOf({
      kind: 'permission',
      schemaVersion: 2,
      dshSessionId: f.agent.id,
      recordId: 'row-1',
      time: 1,
      seq: 1,
      data,
    }),
  ).toMatchObject({
    category: 'permission',
    summaryCode: 'permission.pre-tool-denied',
  })
  expect(native).not.toHaveBeenCalled()
  remove()
  expect(f.has()).toBe(false)
})

it('delegates ordinary abstention and refuses a grant or unavailable policy without routing a native answer', async () => {
  const f = await setup()
  const remove = f.ctx.on('dsh-acp/pre-tool-policy', async (_req, next) => next())
  expect(await f.evaluate()).toEqual({ decision: 'delegate' })
  remove()
  f.ctx.on('dsh-acp/pre-tool-policy', async () => 'allow-once' as AcpPreToolPolicyDecision)
  expect(await f.evaluate()).toMatchObject({ decision: 'deny' })
  expect(f.append).not.toHaveBeenCalled()
})

it('withholds the policy reason if durable audit fails or the owner is replaced during the append', async () => {
  const f = await setup()
  f.ctx.on('dsh-acp/pre-tool-policy', async () => ({ decision: 'deny-once', reason: 'private-reference' }))
  f.append.mockRejectedValueOnce(new Error('audit offline'))
  expect(await f.evaluate()).toMatchObject({
    decision: 'deny',
    reason: expect.not.stringContaining('private-reference'),
  })
  f.append.mockImplementationOnce(async () => {
    f.replace()
  })
  expect(await f.evaluate()).toMatchObject({
    decision: 'deny',
    reason: expect.not.stringContaining('private-reference'),
  })
})

it('cancels an outstanding provider before committing its answer for a stopped prompt', async () => {
  const f = await setup()
  const entered = Promise.withResolvers<void>()
  const done = Promise.withResolvers<AcpPreToolPolicyDecision>()
  f.ctx.on('dsh-acp/pre-tool-policy', async (req) => {
    entered.resolve()
    req.signal.addEventListener('abort', () => done.resolve({ decision: 'deny-once', reason: 'late' }), { once: true })
    return done.promise
  })
  const pending = f.evaluate()
  await entered.promise
  f.controller.abort()
  expect(await pending).toMatchObject({ decision: 'deny', reason: expect.not.stringContaining('late') })
  expect(f.append).not.toHaveBeenCalled()
})
