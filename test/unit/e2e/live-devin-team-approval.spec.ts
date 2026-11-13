import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'
import { summarizeRawInputForAudit } from '../../../src/domain/policy/events.ts'
import { createAcpNativePermissionHandler } from '../../../src/domain/policy/permissions.ts'
import { installLiveDevinTeamApprovals } from '../../e2e/live-devin-team-approval.ts'
import { devinManualPermission } from '../../fixtures/devin-manual-permission.ts'

const audit = vi.hoisted(() => ({ asked: [] as unknown[], bridge: [] as unknown[], decided: [] as unknown[] }))
vi.mock('../../e2e/acp-permission-audit.ts', () => ({
  acpPermissionAudit: (_host: unknown, phase: keyof typeof audit) => audit[phase],
}))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  audit.asked = []
  audit.bridge = []
  audit.decided = []
})

function fixture(
  options: {
    recorded?: typeof devinManualPermission
    manualTitle?: Parameters<typeof installLiveDevinTeamApprovals>[0]['manualTitle']
  } = {},
) {
  const lead = {
    id: SessionId('lead'),
    options: { provider: 'acp-devin', model: 'swe-2-high' },
    session: { header: { cwd: '/synthetic-workspace' } },
  } as Agent
  const foreign = { ...lead, id: SessionId('foreign') } as Agent
  const choices = options.recorded?.asked.options ?? [
    { optionId: 'once', kind: 'allow_once' as const, name: 'Allow' },
    ...['tool-session', 'tool-always', 'server-session', 'server-always', 'bypass'].map((id) => ({
      optionId: id,
      kind: 'allow_always' as const,
      name: id,
    })),
    { optionId: 'deny', kind: 'reject_once' as const, name: 'Reject' },
  ]
  const answers: ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<AcpNativeUserQuestionService['ask']>>>>[] =
    []
  const whenAsked = Promise.withResolvers<Parameters<AcpNativeUserQuestionService['ask']>[0]>()
  const nativeQuestions: AcpNativeUserQuestionService = {
    ask: (request) => {
      const answer = Promise.withResolvers<Awaited<ReturnType<AcpNativeUserQuestionService['ask']>>>()
      answers.push(answer)
      whenAsked.resolve(request)
      return answer.promise
    },
  }
  type Guard = Parameters<Context['tools']['guard']>[0]
  type Execution = Parameters<Guard>[0]
  let guard: Guard | undefined
  let result: ((execution: Execution, result: { isError: boolean }) => void) | undefined
  const tasks: { id: string; subject: string; status: string; revision: number; ready: boolean }[] = []
  const host = {
    ctx: {
      get: () => nativeQuestions,
      agents: {
        get: (id: string) => (id === lead.id ? lead : id === foreign.id ? foreign : undefined),
        list: () => [lead, foreign],
      },
      subagents: { rootOf: (agent: Agent) => (agent === foreign ? foreign : lead), namesOf: () => ({ self: 'lead' }) },
      agentTeams: { listTasks: () => tasks },
      tools: {
        guard: (value: Guard) => {
          guard = value
          return () => {}
        },
      },
      on: (_event: string, value: unknown) => {
        result = value as typeof result
        return () => {}
      },
    },
  } as unknown as { ctx: Context }
  const clicks: string[] = []
  const card = {
    filter: () => card,
    count: async () => 1,
    screenshot: vi.fn(async () => {}),
    getByRole: (role: string, options?: { name?: string | RegExp }) => ({
      count: async () => choices.length,
      waitFor: async () => {},
      click: async () => {
        clicks.push(`${role}:${String(options?.name)}`)
      },
    }),
  }
  const page = { locator: () => card } as unknown as Parameters<typeof installLiveDevinTeamApprovals>[0]['page']
  const evidence: Record<string, unknown> = {}
  const driver = installLiveDevinTeamApprovals({
    host,
    page,
    token: 'TEAM_test',
    memberName: 'calculator',
    model: 'swe-2-high',
    getLead: () => lead,
    evidence,
    directory: '/synthetic-no-file-written',
    manualTitle: options.manualTitle,
  })
  cleanups.push(() => {
    driver.dispose()
    for (const answer of answers) answer.resolve({ answers: [] })
  })
  const ask = (
    requestId = 'request',
    tool = 'team_task_create',
    input: unknown = { subject: 'Compute TEAM_test', description: 'Calculate 1+1' },
    options: { source?: string; owner?: Agent; summary?: string } = {},
  ) => {
    const raw = summarizeRawInputForAudit(input)
    const owner = options.owner ?? lead
    audit.asked.push({
      sessionId: owner.id,
      data: {
        phase: 'asked',
        requestId,
        agentSessionId: 'acp',
        toolCall: { toolCallId: requestId, rawInputSummary: options.summary ?? raw.summary, rawInputHash: raw.hash },
        options: choices,
        optionCount: choices.length,
        omittedOptionCount: 0,
      },
    })
    audit.bridge.push({
      sessionId: owner.id,
      data: {
        phase: 'bridge',
        agentSessionId: 'acp',
        toolCallId: requestId,
        reason: 'approval-required',
        identitySource: options.source ?? 'devin-meta',
        structuredIdentityPresent: true,
        toolName: tool,
      },
    })
    void nativeQuestions.ask({
      agent: lead,
      questions: [
        {
          id: `acp-permission:${requestId}`,
          question: requestId,
          options: choices.map((option) => ({ label: option.name })),
        },
      ],
    })
    return input
  }
  const admit = (callId: string, tool: string, input: unknown) => {
    const execution = { agent: lead, callId: ToolCallId(callId), name: tool, arguments: input } as Execution
    return { execution, denial: guard!(execution) }
  }
  return {
    driver,
    ask,
    clicks,
    evidence,
    admit,
    tasks,
    foreign,
    result: (execution: Execution) => result!(execution, { isError: false }),
    whenAsked: whenAsked.promise,
    answer: (id: string) => answers[0]!.resolve({ answers: [{ id, selected: ['Allow'] }] }),
    askWithRealBuilder(input: unknown) {
      const captured = options.recorded
      const toolCall = captured?.asked.toolCall ?? { toolCallId: 'real-call', title: 'team_task_create' }
      audit.bridge.push({
        sessionId: lead.id,
        data: captured?.bridge ?? {
          phase: 'bridge',
          agentSessionId: 'acp',
          toolCallId: 'real-call',
          reason: 'approval-required',
          identitySource: 'devin-meta',
          structuredIdentityPresent: true,
          toolName: 'team_task_create',
        },
      })
      return createAcpNativePermissionHandler({
        userQuestions: nativeQuestions,
        getAgent: () => lead,
        permissionProfile: 'devin',
        audit: {
          append: async (entry) => {
            audit[entry.data.phase].push({ sessionId: lead.id, data: entry.data })
          },
        },
      })({
        sessionId: 'acp',
        toolCall: {
          toolCallId: toolCall.toolCallId,
          title: toolCall.title ?? 'team_task_create',
          kind: 'other',
          rawInput: input,
        },
        options: [...choices],
      })
    },
  }
}

it('answers the captured title-only request only through the known CLI isolated manual once boundary', async () => {
  const isolated = vi.fn(async () => {})
  const f = fixture({
    recorded: devinManualPermission,
    manualTitle: { cliVersion: '3000.12.43', assertIsolatedDshRegistration: isolated },
  })
  const response = f.askWithRealBuilder({})
  const native = await f.whenAsked
  expect(audit.asked[0]).toMatchObject({
    sessionId: 'lead',
    data: { ...devinManualPermission.asked, requestId: expect.any(String) },
  })
  await f.driver.answerPending()
  expect(isolated).toHaveBeenCalledExactlyOnceWith('/synthetic-workspace')
  expect(f.clicks).toEqual(['radio:Allow', 'button:/^(Submit|Send)$/'])
  f.answer(native.questions[0]!.id)
  await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  const admitted = f.admit('host-captured', 'list_agents', {})
  expect(admitted.denial).toBeUndefined()
  f.result(admitted.execution)
  await f.driver.answerPending()
  f.driver.assertComplete()
  expect(f.evidence.devinPermissions).toMatchObject([
    {
      identity: 'known-cli-manual',
      scope: 'once',
      optionId: 'allow_once',
      status: 'allowed-once',
      rawInputHash: '44136fa355b3678a',
      effects: [{ callId: 'host-captured', isError: false }],
    },
  ])
})

it.each([
  'missing-context',
  'unknown-version',
  'foreign-registration',
  'foreign-server',
  'wrong-tool',
  'mixed-kind',
  'truncated-options',
  'title-mismatch',
  'unknown-source',
  'private-tool',
  'altered-input',
])('does not click the title-only request with %s', async (kind) => {
  const captured = structuredClone(devinManualPermission)
  if (kind === 'foreign-server' || kind === 'wrong-tool' || kind === 'mixed-kind')
    captured.asked = {
      ...captured.asked,
      options: captured.asked.options.map((option, index) =>
        index !== 1
          ? option
          : {
              ...option,
              name:
                kind === 'foreign-server'
                  ? option.name.replace('dsh', 'foreign')
                  : kind === 'wrong-tool'
                    ? option.name.replace('list_agents', 'team_task_create')
                    : option.name,
              kind: kind === 'mixed-kind' ? 'allow_once' : option.kind,
            },
      ),
    }
  if (kind === 'truncated-options') captured.asked = { ...captured.asked, options: captured.asked.options.slice(0, -1) }
  if (kind === 'title-mismatch') captured.bridge = { ...captured.bridge, titleMatchesCurrentTool: false }
  if (kind === 'unknown-source') captured.bridge = { ...captured.bridge, identitySource: 'antigravity-title' }
  if (kind === 'private-tool') {
    captured.bridge = { ...captured.bridge, toolName: 'bash' }
    captured.asked = {
      ...captured.asked,
      toolCall: { ...captured.asked.toolCall, title: 'bash' },
      options: captured.asked.options.map((option) => ({
        ...option,
        name: option.name.replace('list_agents', 'bash'),
      })),
    }
  }
  const f = fixture({
    recorded: captured,
    ...(kind === 'missing-context'
      ? {}
      : {
          manualTitle: {
            cliVersion: kind === 'unknown-version' ? '3000.12.44' : '3000.12.43',
            assertIsolatedDshRegistration: async () => {
              if (kind === 'foreign-registration') throw new Error('LIVE_DEVIN_MANUAL_CONFIG_NOT_ISOLATED')
            },
          },
        }),
  })
  void f.askWithRealBuilder(kind === 'altered-input' ? { task_id: 'foreign' } : {})
  await f.whenAsked
  await expect(f.driver.answerPending()).rejects.toThrow()
  expect(f.clicks).toEqual([])
})

it('uses the real question builder to approve an exact input whose Token prose was redacted only in audit', async () => {
  const f = fixture()
  const input = {
    subject: 'Compute TEAM_test',
    description: 'Compute the value of 1+1 and record the result. Token: TEAM_test.',
  }
  const response = f.askWithRealBuilder(input)
  const native = await f.whenAsked
  expect(summarizeRawInputForAudit(input).summary).toContain('Token: <redacted>')
  expect(native.questions[0]?.detail).toContain(input.description)
  await f.driver.answerPending()
  expect(f.clicks).toEqual(['radio:Allow', 'button:/^(Submit|Send)$/'])
  f.answer(native.questions[0]!.id)
  await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  const admitted = f.admit('host-real-producer', 'team_task_create', input)
  expect(admitted.denial).toBeUndefined()
  f.result(admitted.execution)
  await f.driver.answerPending()
  f.driver.assertComplete()
  expect(f.evidence.devinPermissions).toMatchObject([{ input, scope: 'once', status: 'allowed-once' }])
})

it('clicks only the original once option and correlates its decision with the scoped Host result', async () => {
  const f = fixture()
  const input = f.ask()
  await f.driver.answerPending()
  expect(f.clicks).toEqual(['radio:Allow', 'button:/^(Submit|Send)$/'])
  await f.driver.answerPending()
  expect(f.clicks).toHaveLength(2)
  audit.decided.push({
    sessionId: 'lead',
    data: {
      phase: 'decided',
      requestId: 'request',
      agentSessionId: 'acp',
      toolCallId: 'request',
      outcome: 'selected',
      selectedOptionKind: 'allow_once',
      optionId: 'once',
      decisionVia: 'native-question',
    },
  })
  const admitted = f.admit('host-call', 'team_task_create', input)
  expect(admitted.denial).toBeUndefined()
  f.result(admitted.execution)
  await f.driver.answerPending()
  f.driver.assertComplete()
  expect(f.evidence.devinPermissions).toMatchObject([
    {
      scope: 'once',
      requestId: 'request',
      optionId: 'once',
      status: 'allowed-once',
      effects: [{ callId: 'host-call', isError: false }],
    },
  ])
})

it.each(['title-only', 'foreign-owner', 'changed-input', 'private-tool'])(
  'does not click approval when %s lacks exact authorization',
  async (kind) => {
    const f = fixture()
    f.ask(
      'request',
      kind === 'private-tool' ? 'bash' : 'team_task_create',
      undefined,
      kind === 'title-only'
        ? { source: 'devin-title' }
        : kind === 'foreign-owner'
          ? { owner: f.foreign }
          : kind === 'changed-input'
            ? { summary: '{}' }
            : {},
    )
    await expect(f.driver.answerPending()).rejects.toThrow()
    expect(f.clicks).toEqual([])
  },
)

it('does not treat repeated admission of the identical call as another task or budget entry', () => {
  const f = fixture()
  const input = { subject: 'Compute TEAM_test', description: 'Calculate 1+1' }
  expect(f.admit('same', 'team_task_create', input).denial).toBeUndefined()
  expect(f.admit('same', 'team_task_create', input).denial).toBeUndefined()
  expect(f.evidence.devinToolAdmissions).toHaveLength(1)
  expect(f.admit('same', 'team_task_create', { ...input, description: 'Changed' }).denial).toMatchObject({
    info: { code: 'LIVE_TEAM_REUSED_CALL_ID_CHANGED' },
  })
})

it('rejects a distinct duplicate subject and preserves finite Host and task-operation budgets', () => {
  const duplicate = fixture()
  const input = { subject: 'Compute TEAM_test', description: 'Calculate 1+1' }
  expect(duplicate.admit('first', 'team_task_create', input).denial).toBeUndefined()
  expect(duplicate.admit('second', 'team_task_create', input).denial).toMatchObject({
    info: { code: 'LIVE_TEAM_DUPLICATE_TASK' },
  })
  const calls = fixture()
  for (let index = 0; index < 32; index++) expect(calls.admit(`${index}`, 'list_agents', {}).denial).toBeUndefined()
  expect(calls.admit('extra', 'list_agents', {}).denial).toMatchObject({
    info: { code: 'LIVE_TEAM_TOOL_BUDGET_EXCEEDED' },
  })
  const tasks = fixture()
  tasks.tasks.push({ id: 'compute', subject: 'Compute TEAM_test', status: 'pending', revision: 1, ready: true })
  for (let index = 0; index < 24; index++)
    expect(tasks.admit(`${index}`, 'team_task_get', { task_id: 'compute' }).denial).toBeUndefined()
  expect(tasks.admit('extra', 'team_task_get', { task_id: 'compute' }).denial).toMatchObject({
    info: { code: 'LIVE_TEAM_TOOL_BUDGET_EXCEEDED' },
  })
})

it('stops before a twenty-fifth permission instead of widening the scope', async () => {
  const f = fixture()
  for (let index = 0; index < 24; index++) {
    f.ask(`${index}`, 'list_agents', {})
    await f.driver.answerPending()
  }
  expect(f.clicks).toHaveLength(48)
  f.ask('extra', 'list_agents', {})
  await expect(f.driver.answerPending()).rejects.toThrow('PERMISSION_BUDGET_EXCEEDED')
  expect(f.clicks).toHaveLength(48)
})
