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
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'
import type * as acp from '@agentclientprotocol/sdk'

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

it.each(['ask', 'never'] as const)(
  'cancels the ACP wait, rejects late answers, and never grants to a replaced Agent under %s',
  async (policy) => {
    const f = await fixture()
    if (policy === 'ask') f.session.append('approval/policy', { policy })
    const gate = Promise.withResolvers<'allowed-once'>()
    const called = Promise.withResolvers<void>()
    f.ctx.on('approval/request', () => {
      called.resolve()
      return gate.promise
    })
    try {
      const abort = new AbortController()
      const request = {
        agent: f.agent,
        toolName: 'external',
        toolArgs: { command: 'printf pending' },
        commandLine: 'printf pending',
      }
      const pending = f.approval.request({ ...request, signal: abort.signal })
      await called.promise
      abort.abort()
      expect(await pending).toBe('cancelled')
      gate.resolve('allowed-once')
      const next = f.approval.request(request)
      f.disposeAgent()
      expect(await next).toBe('cancelled')
      expect(await f.approval.request(request)).toBe('unavailable')
    } finally {
      await f.ctx.fiber.dispose()
    }
  },
)

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

// Preserve input shapes from the approval-handler boundary through the published
// Host service. Runtime presentTool normalization happens before this boundary.
// Paths/content are portable fixtures, not user workspaces or secrets.
const approvalInputs: readonly {
  name: string
  kind: acp.ToolKind
  rawInput?: unknown
  commandLine?: string
}[] = [
  {
    name: 'Antigravity file arguments',
    kind: 'edit',
    rawInput: {
      TargetFile: '/workspace/probe.txt',
      CodeContent: 'approval probe\n',
      Description: 'Create disposable approval test file',
      Overwrite: true,
    },
  },
  {
    name: 'Antigravity command arguments',
    kind: 'execute',
    rawInput: { CommandLine: 'printf APPROVAL_PROBE', Cwd: '/workspace', WaitMsBeforeAsync: 5000 },
    commandLine: 'printf APPROVAL_PROBE',
  },
  {
    name: 'command with unknown scope',
    kind: 'execute',
    rawInput: { command: 'printf exact', cwd: '/workspace', permissions: { network: ['example.test'] } },
    commandLine: 'printf exact',
  },
  {
    name: 'string command',
    kind: 'execute',
    rawInput: 'printf "literal; argument"',
    commandLine: 'printf "literal; argument"',
  },
  { name: 'argv without shell synthesis', kind: 'execute', rawInput: { argv: ['printf', 'two words', '$HOME'] } },
  { name: 'non-command string', kind: 'edit', rawInput: 'file body, not a command' },
  { name: 'non-command command field', kind: 'other', rawInput: { command: 'a requested policy value' } },
  { name: 'array scope', kind: 'other', rawInput: ['scope-a', { path: '/workspace/probe.txt' }] },
  { name: 'null input', kind: 'read', rawInput: null },
  { name: 'absent input', kind: 'read' },
]

for (const policy of ['ask', 'never'] as const) {
  it.each(approvalInputs)(`forwards exact $name to native answerers under ${policy}`, async (input) => {
    const f = await fixture()
    if (policy === 'ask') f.session.append('approval/policy', { policy })
    const audit: AcpPermissionAuditRecord[] = []
    const answer = vi.fn(async (_request: unknown) => 'allowed-once' as const)
    f.ctx.on('approval/request', answer)
    const controller = new AbortController()
    try {
      const response = await createAcpNativePermissionHandler({
        getAgent: () => f.agent,
        approval: f.approval,
        audit: { append: async (record) => void audit.push(record) },
      })(
        {
          sessionId: 'acp-metadata-session',
          toolCall: {
            toolCallId: 'metadata-call',
            title: input.name,
            kind: input.kind,
            ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput }),
          },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
          ],
        },
        controller.signal,
      )
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
      expect(answer).toHaveBeenCalledOnce()
      const event = answer.mock.calls[0]![0] as unknown as {
        agent: Agent
        callId: string
        signal: AbortSignal
        toolArgs?: unknown
        commandLine?: string
      }
      expect(event.agent).toBe(f.agent)
      expect(event.callId).toBe('metadata-call')
      expect(event.signal).toBe(controller.signal)
      if (input.rawInput === undefined) expect(event).not.toHaveProperty('toolArgs')
      else expect(event.toolArgs).toEqual(input.rawInput)
      if (input.commandLine === undefined) expect(event).not.toHaveProperty('commandLine')
      else expect(event.commandLine).toBe(input.commandLine)
      expect(audit.at(-1)?.data).toMatchObject({
        decisionVia: 'native-approval',
        optionId: 'allow',
        selectedOptionKind: 'allow_once',
      })
      expect(f.ctx.approval.overrideOf(f.session)).toBe(policy)
      expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
      const nativeAsked = f.session.snapshotEvents().filter((event) => event.type === 'approval/asked')
      expect(nativeAsked).toHaveLength(policy === 'ask' ? 1 : 0)
      for (const event of nativeAsked) {
        expect(event.data).not.toHaveProperty('toolArgs')
        expect(event.data).not.toHaveProperty('commandLine')
      }
      if (policy === 'never') {
        // External facts do not relax the child's separate DSH execution policy.
        expect(await f.ctx.approval.request({ agent: f.agent, toolName: 'bash' })).toBe('rejected')
        expect(answer).toHaveBeenCalledOnce()
      }
    } finally {
      await f.ctx.fiber.dispose()
    }
  })

  it.each([
    { optionId: 'allow_always', name: 'Allow Always (risky)', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ] as const)(`keeps Antigravity $kind selectable without binary approval under ${policy}`, async (selected) => {
    const f = await fixture()
    if (policy === 'ask') f.session.append('approval/policy', { policy })
    const nativeAnswer = vi.fn(async () => 'allowed-once' as const)
    const audit: AcpPermissionAuditRecord[] = []
    f.ctx.on('approval/request', nativeAnswer)
    const options: acp.PermissionOption[] = [
      { optionId: 'allow_always', name: 'Allow Always (risky)', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ agent, questions }) => {
      expect(agent).toBe(f.agent)
      expect(questions[0]!.options).toEqual(options.map(({ name }) => ({ label: name })))
      expect(questions[0]!.question).toContain('printf APPROVAL_PROBE')
      expect(questions[0]!.question).toContain('/workspace')
      return { answers: [{ id: questions[0]!.id, selected: [selected.name] }] }
    })
    try {
      const response = await createAcpNativePermissionHandler({
        getAgent: () => f.agent,
        approval: f.approval,
        userQuestions: { ask },
        nativeQuestionProfile: 'antigravity',
        audit: { append: async (record) => void audit.push(record) },
      })({
        sessionId: 'acp-complete-options',
        toolCall: {
          toolCallId: 'antigravity-command',
          kind: 'execute',
          rawInput: { CommandLine: 'printf APPROVAL_PROBE', Cwd: '/workspace', WaitMsBeforeAsync: 5000 },
        },
        options,
      })
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: selected.optionId } })
      expect(ask).toHaveBeenCalledOnce()
      expect(nativeAnswer).not.toHaveBeenCalled()
      expect(audit.at(-1)?.data).toMatchObject({
        decisionVia: 'native-question',
        optionId: selected.optionId,
        selectedOptionKind: selected.kind,
      })
      expect(f.ctx.approval.overrideOf(f.session)).toBe(policy)
      expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
    } finally {
      await f.ctx.fiber.dispose()
    }
  })
}
