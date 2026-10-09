import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativePermissionHandler,
  type AcpNativeApprovalService,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

const params = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: 'acp-session',
  toolCall: {
    toolCallId: 'acp-call',
    title: 'Run command',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'echo hello' },
  },
  options,
})
const antigravityInteractionQuestion = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: 'acp-session',
  toolCall: {
    toolCallId: 'interaction_30c0e13e',
    status: 'pending',
    title: 'Which test label should we use?',
    rawInput: {},
  },
  options,
})
const option = (optionId: string, name: string, kind: acp.PermissionOption['kind']): acp.PermissionOption => ({
  optionId,
  name,
  kind,
})
function bridge(
  answer: string | undefined,
  custom?: string,
): { handler: ReturnType<typeof createAcpNativePermissionHandler>; ask: ReturnType<typeof vi.fn> } {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [
      {
        id: questions[0]!.id,
        selected: answer === undefined ? [] : [answer],
        ...(custom === undefined ? {} : { custom }),
      },
    ],
  }))
  return {
    handler: createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({ id: 'live-agent' }) }),
    ask,
  }
}

describe('native ACP permission bridge', () => {
  it.each([undefined, 'en', 'zh', 'zh-CN'])(
    'leaves native approval chrome to the client for locale %s',
    async (locale) => {
      const approval = { request: vi.fn(async () => 'allowed-once' as const) }
      const handler = createAcpNativePermissionHandler({
        approval,
        ...(locale === undefined ? {} : { locale }),
        getAgent: () => ({}),
      })
      await handler(params([option('exact-id', 'Allow', 'allow_once')]))
      expect(approval.request).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Run command\necho hello',
        }),
      )
    },
  )

  it('localizes question details and disambiguation while retaining Agent labels and option ids', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Same · 选项 2'] }],
    }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, locale: 'zh', getAgent: () => ({}) })
    await expect(
      handler(params([option('a', 'Same', 'allow_always'), option('r', 'Same', 'reject_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'r' } })
    expect(ask.mock.calls[0]?.[0].questions[0]).toMatchObject({
      question: 'ACP Agent 请求执行命令的权限。\n工具: Run command',
      detail: '命令:\n\n```\necho hello\n```',
      options: [{ label: 'Same · 选项 1' }, { label: 'Same · 选项 2' }],
    })
  })

  it('makes missing command details explicit on the native approval card', async () => {
    const approval = { request: vi.fn(async () => 'rejected' as const) }
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({}) })
    await handler({
      ...params([option('a', 'Allow', 'allow_once')]),
      toolCall: { toolCallId: 'unknown', kind: 'execute' },
    })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('could not be matched to this request') }),
    )
  })

  it('uses the native approval card for allow-once/reject decisions and keeps the complete command', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const command = `printf 'first'\nprintf '${'x'.repeat(400)}'`
    const handler = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => ({ id: 'live-agent' }),
    })
    await expect(
      handler({
        ...params([]),
        toolCall: { ...params([]).toolCall, rawInput: { command } },
        options: [
          option('once', 'Allow once', 'allow_once'),
          option('always', 'Always', 'allow_always'),
          option('reject', 'Reject', 'reject_once'),
        ],
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'acp-call',
        reason: expect.stringContaining(command),
      }),
    )
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps Codex additional permission scope on the approval path when two options are allow-once', async () => {
    const approvalRequest = vi.fn<AcpNativeApprovalService['request']>(async () => 'rejected' as const)
    const approval = { request: approvalRequest }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const request: acp.RequestPermissionRequest = {
      ...params([
        option('turn', 'Yes, grant these permissions for this turn', 'allow_once'),
        option('turn-strict', 'Yes, grant for this turn with strict auto review', 'allow_once'),
        option('session', 'Yes, grant these permissions for this session', 'allow_always'),
        option('reject', 'No, continue without permissions', 'reject_once'),
      ]),
      toolCall: {
        toolCallId: 'codex-additional-permissions',
        title: 'Additional sandbox permissions',
        kind: 'other',
        rawInput: {
          permissions: { fileSystem: { write: ['/workspace/private-report'] }, network: { enabled: true } },
          cwd: '/workspace',
        },
      },
    }
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })

    await expect(handler(request)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    expect(approvalRequest).toHaveBeenCalledOnce()
    expect(approvalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'codex-additional-permissions',
        toolName: 'other',
        reason: expect.stringContaining('Additional sandbox permissions'),
      }),
    )
    const reason = approvalRequest.mock.calls[0]?.[0].reason ?? ''
    expect(reason).toContain('/workspace/private-report')
    expect(reason).toContain('"enabled": true')
    expect(ask).not.toHaveBeenCalled()
  })

  it('routes the exact Antigravity interaction payload to DSH and returns the selected option id', async () => {
    const approval = { request: vi.fn(async () => 'rejected' as const) }
    const question: AcpNativeUserQuestionService['ask'] = vi.fn(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['BETA'] }],
    }))
    const records: AcpPermissionAuditRecord[] = []
    const handler = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval,
      userQuestions: { ask: question },
      getAgent: () => ({ id: 'live-agent' }),
      audit: { append: async (record) => void records.push(record) },
    })

    await expect(
      handler(antigravityInteractionQuestion([option('1', 'ALPHA', 'allow_once'), option('2', 'BETA', 'allow_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    expect(approval.request).not.toHaveBeenCalled()
    expect(question).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'Which test label should we use?',
            options: [{ label: 'ALPHA' }, { label: 'BETA' }],
          }),
        ],
      }),
    )
    expect(records.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
    expect(records.at(-1)?.data).toMatchObject({ selectedOptionKind: 'allow_once', decisionVia: 'native-question' })
  })

  it('routes an interaction with one allow-once option to DSH and disambiguates labels', async () => {
    const approval = { request: vi.fn(async () => 'rejected' as const) }
    const askOne = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Proceed'] }],
    }))
    const oneAllowOnce = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval,
      userQuestions: { ask: askOne },
      getAgent: () => ({}),
    })
    await expect(
      oneAllowOnce(antigravityInteractionQuestion([option('yes', 'Proceed', 'allow_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(approval.request).not.toHaveBeenCalled()

    const askDuplicate = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['ALPHA · option 2'] }],
    }))
    const duplicateLabels = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      userQuestions: { ask: askDuplicate },
      getAgent: () => ({}),
    })
    await expect(
      duplicateLabels(
        antigravityInteractionQuestion([
          option('first', 'ALPHA', 'allow_once'),
          option('second', 'ALPHA', 'allow_once'),
        ]),
      ),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'second' } })
    expect(askDuplicate.mock.calls[0]?.[0].questions[0]?.options).toEqual([
      { label: 'ALPHA · option 1' },
      { label: 'ALPHA · option 2' },
    ])
  })

  it('keeps Antigravity trust and deny options on approval instead of treating them as questions', async () => {
    const approvalRequest = vi.fn<AcpNativeApprovalService['request']>(async () => 'rejected' as const)
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const handler = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval: { request: approvalRequest },
      userQuestions: { ask },
      getAgent: () => ({ id: 'live-agent' }),
    })
    const request = antigravityInteractionQuestion([
      option('trust', 'Trust', 'allow_once'),
      option('deny', 'Deny', 'reject_once'),
    ])

    await expect(handler(request)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(approvalRequest).toHaveBeenCalledOnce()
    expect(ask).not.toHaveBeenCalled()

    const askWithoutApproval = vi.fn<AcpNativeUserQuestionService['ask']>()
    const noApproval = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      userQuestions: { ask: askWithoutApproval },
      getAgent: () => ({ id: 'live-agent' }),
    })
    await expect(noApproval(request)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(askWithoutApproval).not.toHaveBeenCalled()

    const askAfterApprovalError = vi.fn<AcpNativeUserQuestionService['ask']>()
    const failedApproval = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval: {
        request: async () => {
          throw new Error('approval service unavailable')
        },
      },
      userQuestions: { ask: askAfterApprovalError },
      getAgent: () => ({ id: 'live-agent' }),
    })
    await expect(failedApproval(request)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(askAfterApprovalError).not.toHaveBeenCalled()
  })

  it('cancels an unanswered Antigravity interaction and asks the user rather than auto-allowing', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval,
      userQuestions: { ask },
      getAgent: () => ({}),
    })
    await expect(handler(antigravityInteractionQuestion([option('1', 'ALPHA', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(ask).toHaveBeenCalledOnce()
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('keeps non-Antigravity profiles and MCP-shaped interaction impostors on native approval', async () => {
    const exactPayload = antigravityInteractionQuestion([
      option('yes', 'Proceed', 'allow_once'),
      option('no', 'Stop', 'reject_once'),
    ])
    const approval = { request: vi.fn(async () => 'rejected' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const genericProfile = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => ({}),
    })
    await genericProfile(exactPayload)
    expect(approval.request).toHaveBeenCalledOnce()
    expect(ask).not.toHaveBeenCalled()

    approval.request.mockClear()
    const antigravityProfile = createAcpNativePermissionHandler({
      nativeQuestionProfile: 'antigravity',
      approval,
      userQuestions: { ask },
      getAgent: () => ({}),
    })
    const impostors: acp.RequestPermissionRequest[] = [
      {
        ...exactPayload,
        toolCall: { ...exactPayload.toolCall, kind: 'execute', rawInput: { command: 'echo unsafe' } },
      },
      {
        ...exactPayload,
        toolCall: {
          ...exactPayload.toolCall,
          _meta: { is_mcp_tool_call: true, mcp: { server: 'foreign', tool: 'delete_file' } },
        },
      },
      {
        ...exactPayload,
        toolCall: { ...exactPayload.toolCall, _meta: { serverName: 'dshteam_foreign', toolName: 'unknown_tool' } },
      },
    ]
    for (const impostor of impostors) await antigravityProfile(impostor)
    expect(approval.request).toHaveBeenCalledTimes(impostors.length)
    expect(ask).not.toHaveBeenCalled()
  })

  it('extracts command details from Antigravity CommandLine property without unknownCommand copy', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const handler = createAcpNativePermissionHandler({
      approval,
      getAgent: () => ({ id: 'live-agent' }),
    })
    await handler({
      ...params([]),
      toolCall: {
        ...params([]).toolCall,
        kind: 'execute',
        title: 'git remote -v',
        rawInput: { CommandLine: 'git remote -v', Cwd: '/workspace' },
      },
      options: [option('allow', 'Allow', 'allow_once')],
    })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('git remote -v'),
      }),
    )
    const reason = (approval.request.mock.calls[0] as unknown as [{ reason: string }])[0].reason
    expect(reason).not.toContain('Command details were not provided')
  })

  it('omits an exactly duplicated execute title while keeping the complete command', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const command = 'printf ANTIGRAVITY_ALLOW_ONCE_MARKER'
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({ id: 'live-agent' }) })
    await handler({
      ...params([]),
      toolCall: { ...params([]).toolCall, kind: 'execute', title: command, rawInput: { CommandLine: command } },
      options: [option('allow', 'Allow once', 'allow_once')],
    })
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: command }))
  })

  it('keeps a distinct title and complete multiline execute command', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const command = 'printf first\nprintf second'
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({ id: 'live-agent' }) })
    await handler({
      ...params([]),
      toolCall: {
        ...params([]).toolCall,
        kind: 'execute',
        title: 'Run Antigravity command',
        rawInput: { CommandLine: command },
      },
      options: [option('allow', 'Allow once', 'allow_once')],
    })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: `Run Antigravity command\n${command}` }),
    )
  })

  it('preserves exact Agent option ids and all four kinds through native questions', async () => {
    for (const [kind, id] of [
      ['allow_once', 'a1'],
      ['allow_always', 'a2'],
      ['reject_once', 'r1'],
      ['reject_always', 'r2'],
    ] as const) {
      const name =
        kind === 'allow_once'
          ? 'Allow once'
          : kind === 'allow_always'
            ? 'Always allow'
            : kind === 'reject_once'
              ? 'Reject once'
              : 'Always reject'
      const { handler, ask } = bridge(name)
      await expect(handler(params([option(id, name, kind)]))).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: id },
      })
      expect(ask).toHaveBeenCalledOnce()
    }
  })

  it('records asked and decided sidecar facts before returning', async () => {
    const records: AcpPermissionAuditRecord[] = []
    // Use a real question seam so this test also verifies the audit ordering.
    const question: AcpNativeUserQuestionService = {
      ask: async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: ['Allow once'] }] }),
    }
    const real = createAcpNativePermissionHandler({
      userQuestions: question,
      getAgent: () => ({}),
      audit: {
        append: async (record) => {
          records.push(record)
        },
      },
      now: () => 100,
    })
    await expect(real(params([option('exact', 'Allow once', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'exact' },
    })
    expect(records.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
    expect(records[1]?.data).toMatchObject({ decisionVia: 'native-question' })
  })

  it('fails closed for cancel/custom/unknown answers and unavailable service', async () => {
    await expect(bridge(undefined).handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(bridge('Allow [a]', 'typed').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(bridge('Unknown [x]').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(
      createAcpNativePermissionHandler({ getAgent: () => ({}) })(params([option('a', 'Allow', 'allow_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('rejects oversized or duplicate identities before opening native UI', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
    await expect(handler(params([option('', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows names by default, uses short ordinal disambiguation, and bounds long names', async () => {
    const longName = 'x'.repeat(500)
    const { handler, ask } = bridge('Same · option 2')
    await expect(
      handler(
        params([option('first-secret-id', 'Same', 'allow_once'), option('second-secret-id', 'Same', 'reject_always')]),
      ),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'second-secret-id' } })
    const question = ask.mock.calls[0]?.[0]
    expect(question?.questions[0]?.options).toEqual([{ label: 'Same · option 1' }, { label: 'Same · option 2' }])
    const long = bridge(`${'x'.repeat(119)}…`)
    await expect(long.handler(params([option('long-id', longName, 'allow_always')]))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'long-id' },
    })
    expect(long.ask.mock.calls[0]?.[0].questions[0]?.options?.[0]?.label.length).toBeLessThan(130)
  })

  it.each(['en', 'zh'] as const)(
    'keeps adversarial disambiguated labels unique and maps them exactly (%s)',
    async (locale) => {
      const suffix = locale === 'zh' ? '选项' : 'option'
      const options = [
        option('allow-first', 'Run', 'allow_once'),
        option('reject-second', 'Run', 'reject_once'),
        option('allow-always-third', `Run · ${suffix} 1`, 'allow_always'),
        option('reject-always-fourth', `Run · ${suffix} 2`, 'reject_always'),
        option('allow-fifth', `Run · ${suffix} 1 · ${suffix} 3`, 'allow_once'),
      ]
      let labels: string[] = []
      let selectedIndex = 0
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => {
        labels = questions[0]!.options!.map((entry) => entry.label)
        const index = selectedIndex++
        return { answers: [{ id: questions[0]!.id, selected: [labels[index]!] }] }
      })
      const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}), locale })
      for (const candidate of options) {
        await expect(handler(params(options))).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: candidate.optionId },
        })
      }
      expect(new Set(labels).size).toBe(options.length)
      expect(labels).toEqual(
        locale === 'zh'
          ? ['1. Run · 选项 1', '2. Run · 选项 2', '3. Run · 选项 1', '4. Run · 选项 2', '5. Run · 选项 1 · 选项 3']
          : [
              '1. Run · option 1',
              '2. Run · option 2',
              '3. Run · option 1',
              '4. Run · option 2',
              '5. Run · option 1 · option 3',
            ],
      )
    },
  )

  it('cancels invalid, multiple, or custom answers even when labels collide before disambiguation', async () => {
    const options = [
      option('first', 'Run', 'allow_once'),
      option('second', 'Run', 'reject_once'),
      option('collision', 'Run · option 1', 'allow_always'),
    ]
    for (const selected of [['forged label'], ['Run · option 1', 'Run · option 2']]) {
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
        answers: [{ id: questions[0]!.id, selected }],
      }))
      const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
      await expect(handler(params(options))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    }
    const custom = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Run · option 1'], custom: 'Allow' }],
    }))
    await expect(
      createAcpNativePermissionHandler({ userQuestions: { ask: custom }, getAgent: () => ({}) })(params(options)),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('shows the complete command in the native multi-line detail without executing controls', async () => {
    const command = `printf '${'x'.repeat(600)}'\nprintf 'Authorization: Bearer visible-to-approver'\u001b[31m`
    const { handler, ask } = bridge('Allow once')
    await expect(
      handler({
        ...params([option('allow', 'Allow once', 'allow_once')]),
        toolCall: { ...params([]).toolCall, rawInput: { command } },
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })

    const question = ask.mock.calls[0]?.[0].questions[0]
    expect(question?.question).not.toContain(command)
    expect(question?.detail).toContain(command.slice(0, -5))
    expect(question?.detail).toContain('\\x1b[31m')
    expect(question?.detail).not.toContain('\u001b')
    expect(question?.detail).not.toContain('…')
  })
})

it.each([
  { rejectKind: 'reject_once' as const, expected: { outcome: 'selected', optionId: 'r' } },
  { rejectKind: 'reject_always' as const, expected: { outcome: 'cancelled' } },
])('never upgrades a native one-time rejection to $rejectKind', async ({ rejectKind, expected }) => {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
  const records: AcpPermissionAuditRecord[] = []
  const handler = createAcpNativePermissionHandler({
    approval: { request: async () => 'rejected' },
    userQuestions: { ask },
    getAgent: () => ({}),
    audit: {
      append: async (record) => {
        records.push(record)
      },
    },
  })
  await expect(
    handler(params([option('a', 'Allow once', 'allow_once'), option('r', 'Reject', rejectKind)])),
  ).resolves.toEqual({ outcome: expected })
  expect(ask).not.toHaveBeenCalled()
  expect(records.at(-1)?.data).not.toMatchObject({ selectedOptionKind: 'reject_always' })
})
