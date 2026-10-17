import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { installLiveTeamApprovalPolicy } from '../../e2e/live-team-approval-policy.ts'

// Run the published native bash escalation implementation. The shell executor
// alone is a recorder, so no process/model/browser or host artifact is needed.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const NativeBash = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-bash')).href)
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const token = 'APPROVAL_policytest'
const command = `printf '${token}' > ${token}.txt`
const args = {
  command,
  description: 'Write the isolated approval marker',
  sandbox_permissions: 'danger-full-access',
  justification: `Allow the single temporary workspace marker ${token}`,
}

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const executed: { command: string; sandboxPolicy: { mode: string } }[] = []
  const shell = {
    sandboxMode: 'danger-full-access',
    resolve: (request: Record<string, unknown>) => ({
      ...request,
      workdir: process.cwd(),
      timeoutMs: 1000,
    }),
    execute: vi.fn(async (spec: { command: string; sandboxPolicy: { mode: string } }) => {
      executed.push(spec)
      return {
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 1000,
          stdout: { text: token, truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
        }),
      }
    }),
  }
  ctx.provide('shell', shell as never)
  ctx.provide('shellEnv', { collect: () => ({}) } as never)
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() } as never)
  await ctx.plugin(NativeBash, { enableRunInBackground: false })
  function agent(id: string): Agent {
    const session = Session.create(SessionId(id))
    session.append('turn/start', { turn: 1 })
    return { id: session.id, session, ctx, options: { provider: 'fixture' } } as unknown as Agent
  }
  const lead = agent('approval-lead')
  const member = agent('approval-member')
  const unrelated = agent('approval-unrelated')
  ctx.provide('agentTeams', {
    tryMembership: (candidate: Agent) =>
      candidate === member
        ? { role: 'teammate', root: lead, name: 'permission-review' }
        : { role: 'lead', root: candidate, name: 'lead' },
  } as never)
  const install = () => installLiveTeamApprovalPolicy(ctx, { lead, memberName: 'permission-review', command, token })
  const announce = (candidate = member) => ctx.serial('agent/created', { agent: candidate, source: 'startup' })
  const call = (candidate: Agent, callArgs: unknown = args, callId = 'native-bash') =>
    ctx.tools.execute({
      name: 'bash',
      arguments: callArgs,
      callId: ToolCallId(callId),
      agent: candidate,
      signal: new AbortController().signal,
    })
  return { ctx, lead, member, unrelated, shell, executed, install, announce, call }
}

describe('live Team approval native sandbox precondition', () => {
  it('does not confuse approval ask with a prompt for an ordinary full-access command', async () => {
    const f = await fixture()
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    f.ctx.on('approval/request', answer)
    const result = await f.call(f.member, { command, description: 'Write the isolated approval marker' })
    expect(result.isError).toBe(false)
    expect(f.executed).toHaveLength(1)
    expect(answer).not.toHaveBeenCalled()
    expect(f.member.session.snapshotEvents().filter((event) => event.type === 'approval/asked')).toEqual([])
  })

  it('uses native ask/decide before the only shell effect, without widening standing or other-session policy', async () => {
    const f = await fixture()
    const policy = f.install()
    await f.announce(f.unrelated)
    await f.announce()
    expect(policy.member).toBe(f.member)
    expect(f.ctx.sandboxPolicy.resolve({ session: f.member.session }).mode).toBe('danger-full-access')
    // ACP setup synchronizes the Lead policy after agent/created. The fixture
    // must establish strict widening at the actual tool boundary, not race it.
    setSandboxMode(f.member.session, 'read-only')
    setSandboxMode(f.member.session, 'danger-full-access')
    expect(f.ctx.sandboxPolicy.resolve({ session: f.lead.session }).mode).toBe('danger-full-access')
    expect(f.ctx.sandboxPolicy.resolve({ session: f.unrelated.session }).mode).toBe('danger-full-access')
    const requested = Promise.withResolvers<ApprovalRequest>()
    const decision = Promise.withResolvers<ApprovalOutcome>()
    cleanups.push(() => {
      decision.resolve('cancelled')
    })
    f.ctx.on('approval/request', (request) => {
      requested.resolve(request)
      return decision.promise
    })
    const pending = f.call(f.member)
    const request = await requested.promise
    expect(request.agent).toBe(f.member)
    expect(request).toMatchObject({
      toolName: 'bash',
      callId: 'native-bash',
      reason: expect.stringContaining(`escalate sandbox to danger-full-access: ${args.justification}`),
    })
    expect(f.executed).toEqual([])
    expect(policy.admissionPolicy).toEqual({ previous: 'danger-full-access', effective: 'read-only' })
    expect(f.ctx.sandboxPolicy.resolve({ session: f.member.session }).mode).toBe('read-only')
    expect(
      f.member.session
        .snapshotEvents()
        .filter((event) => event.type.startsWith('approval/'))
        .map((event) => event.type),
    ).toEqual(['approval/asked'])
    decision.resolve('allowed-once')
    expect((await pending).isError).toBe(false)
    expect(f.executed).toMatchObject([{ command, sandboxPolicy: { mode: 'danger-full-access' } }])
    const audit = f.member.session
      .snapshotEvents()
      .filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided')
    expect(audit).toHaveLength(2)
    expect(audit[1]).toMatchObject({
      type: 'approval/decided',
      data: { id: audit[0]?.data.id, outcome: 'allowed-once' },
    })
    expect(f.ctx.sandboxPolicy.resolve({ session: f.member.session }).mode).toBe('read-only')
    expect(f.lead.session.snapshotEvents().filter((event) => event.type.startsWith('approval/'))).toEqual([])
    expect(policy.violations).toEqual([])
    expect(policy.admittedCallId).toBe('native-bash')
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)(
    'keeps the shell untouched after native outcome %s',
    async (outcome) => {
      const f = await fixture()
      f.install()
      await f.announce()
      f.ctx.on('approval/request', async () => outcome)
      expect((await f.call(f.member)).isError).toBe(true)
      expect(f.executed).toEqual([])
      expect(f.member.session.snapshotEvents().filter((event) => event.type === 'approval/decided')).toMatchObject([
        { data: { outcome } },
      ])
    },
  )

  it('rejects missing escalation, alternate commands, workdir and background before any approval or shell effect', async () => {
    const f = await fixture()
    const policy = f.install()
    await f.announce()
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    f.ctx.on('approval/request', answer)
    for (const invalid of [
      { command, description: args.description },
      { ...args, command: 'printf unexpected' },
      { ...args, workdir: '..' },
      { ...args, run_in_background: true },
    ])
      expect((await f.call(f.member, invalid)).isError).toBe(true)
    expect(policy.violations).toHaveLength(4)
    expect(policy.admittedCallId).toBeUndefined()
    expect(answer).not.toHaveBeenCalled()
    expect(f.executed).toEqual([])
  })

  it('prevents Lead execution and repeat member dispatch instead of letting either satisfy the approval test', async () => {
    const f = await fixture()
    const policy = f.install()
    await f.announce()
    f.ctx.on('approval/request', async () => 'allowed-once' as const)
    expect((await f.call(f.lead)).isError).toBe(true)
    expect((await f.call(f.member)).isError).toBe(false)
    expect((await f.call(f.member, args, 'duplicate-call')).isError).toBe(true)
    expect(f.executed).toHaveLength(1)
    expect(policy.violations).toEqual(['wrong-command-owner', 'unexpected-member-call:bash'])
  })

  it('fails immediately without native sandbox bash and disposes only its fixture registrations', async () => {
    const f = await fixture()
    const policy = f.install()
    policy.dispose()
    await f.announce()
    expect(f.ctx.sandboxPolicy.resolve({ session: f.member.session }).mode).toBe('danger-full-access')
    expect((await f.call(f.member, { command, description: args.description })).isError).toBe(false)
    Reflect.deleteProperty(f.shell, 'sandboxMode')
    expect(f.install).toThrow('LIVE_TEAM_APPROVAL_REQUIRES_NATIVE_SANDBOX_BASH')
  })
})
