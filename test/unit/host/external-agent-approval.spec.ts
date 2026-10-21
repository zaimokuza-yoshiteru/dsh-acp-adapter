import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { externalAgentApproval } from '../../../src/host/composition/external-agent-approval.ts'
import { createAcpNativePermissionHandler } from '../../../src/domain/policy/permissions.ts'
import type { AcpPermissionAuditRecord } from '../../../src/domain/policy/permissions.ts'

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const session = Session.create(SessionId('external-approval'))
  session.append('turn/start', { turn: 1 })
  session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' })
  session.append('approval/policy', { policy: 'never', source: 'delegation' })
  const agent = { id: session.id, session, ctx, status: 'running' } as Agent
  let live: Agent | undefined = agent
  return {
    ctx,
    session,
    agent,
    approval: externalAgentApproval(ctx, () => live),
    disposeAgent: () => {
      live = undefined
    },
  }
}

it.each(['allowed-once', 'rejected'] as const)(
  'keeps native delegated DSH policy while ACP asks through the same UI: %s',
  async (outcome) => {
    const f = await fixture()
    const audit: AcpPermissionAuditRecord[] = []
    const answers = vi.fn(async (request: { agent: Agent }) => {
      expect(request.agent).toBe(f.agent)
      expect(audit.map((record) => record.data.phase)).toEqual(['asked'])
      return outcome
    })
    f.ctx.on('approval/request', answers)
    try {
      // The Host's own approval service still rejects sandbox escalation.
      expect(await f.ctx.approval.request({ agent: f.agent, toolName: 'bash' })).toBe('rejected')
      expect(answers).not.toHaveBeenCalled()
      const response = await createAcpNativePermissionHandler({
        approval: f.approval,
        getAgent: () => f.agent,
        audit: {
          append: async (record) => {
            audit.push(record)
          },
        },
      })({
        sessionId: 'acp-session',
        toolCall: {
          toolCallId: 'external-call',
          kind: 'execute',
          title: 'Agent command',
          rawInput: { command: 'test-command' },
        },
        options: [
          { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'no', kind: 'reject_once', name: 'Reject' },
        ],
      })
      expect(response).toEqual({
        outcome: { outcome: 'selected', optionId: outcome === 'allowed-once' ? 'yes' : 'no' },
      })
      expect(audit.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
      expect(answers).toHaveBeenCalledOnce()
      expect(f.ctx.approval.overrideOf(f.session)).toBe('never')
      expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
      expect(f.session.snapshotEvents().filter((event) => event.type === 'approval/asked')).toHaveLength(1)
    } finally {
      await f.ctx.fiber.dispose()
    }
  },
)

it('cancels the ACP wait, rejects late answers, and never grants to a replaced Agent', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<'allowed-once'>()
  const called = Promise.withResolvers<void>()
  f.ctx.on('approval/request', () => {
    called.resolve()
    return gate.promise
  })
  try {
    const abort = new AbortController()
    const pending = f.approval.request({ agent: f.agent, toolName: 'external', signal: abort.signal })
    await called.promise
    abort.abort()
    expect(await pending).toBe('cancelled')
    gate.resolve('allowed-once')
    const next = f.approval.request({ agent: f.agent, toolName: 'external' })
    f.disposeAgent()
    expect(await next).toBe('cancelled')
    expect(await f.approval.request({ agent: f.agent, toolName: 'external' })).toBe('unavailable')
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('fails closed without an answerer, for a throwing answerer or a foreign Agent', async () => {
  const f = await fixture()
  try {
    expect(await f.approval.request({ agent: f.agent, toolName: 'external' })).toBe('unavailable')
    f.ctx.on('approval/request', () => {
      throw new Error('answerer offline')
    })
    expect(await f.approval.request({ agent: f.agent, toolName: 'external' })).toBe('unavailable')
    expect(await f.approval.request({ agent: { ...f.agent }, toolName: 'external' })).toBe('unavailable')
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('does not open a card when cancelled before the answerer dispatches', async () => {
  const f = await fixture()
  const answer = vi.fn(async () => 'allowed-once' as const)
  f.ctx.on('approval/request', answer)
  try {
    const abort = new AbortController()
    const pending = f.approval.request({ agent: f.agent, toolName: 'external', signal: abort.signal })
    abort.abort()
    expect(await pending).toBe('cancelled')
    expect(answer).not.toHaveBeenCalled()
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('keeps native approval auditing when the Session admits interactive approval', async () => {
  const f = await fixture()
  f.session.append('approval/policy', { policy: 'ask' })
  f.ctx.on('approval/request', async () => 'allowed-once')
  try {
    expect(await f.approval.request({ agent: f.agent, toolName: 'external' })).toBe('allowed-once')
    expect(f.session.snapshotEvents().filter((event) => event.type === 'approval/asked')).toHaveLength(1)
    expect(f.session.snapshotEvents().filter((event) => event.type === 'approval/decided')).toHaveLength(1)
    expect(f.ctx.approval.overrideOf(f.session)).toBe('ask')
    expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('uses the same external approval path for configured and session-level never', async () => {
  const ctx = new Context()
  await ctx.plugin(ApprovalService, { policy: 'never' })
  const session = Session.create(SessionId('configured-never'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, status: 'running' } as Agent
  const answer = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', answer)
  try {
    const approval = externalAgentApproval(ctx, () => agent)
    expect(await approval.request({ agent, toolName: 'external' })).toBe('allowed-once')
    session.append('approval/policy', { policy: 'never', source: 'delegation' })
    expect(await approval.request({ agent, toolName: 'external' })).toBe('allowed-once')
    expect(answer).toHaveBeenCalledTimes(2)
    expect(await ctx.approval.request({ agent, toolName: 'bash' })).toBe('rejected')
    expect(answer).toHaveBeenCalledTimes(2)
  } finally {
    await ctx.fiber.dispose()
  }
})
