import { expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { createAcpNativePermissionHandler } from '../../../src/domain/policy/permissions.ts'
import { createAcpNativeElicitationHandler } from '../../../src/domain/policy/elicitation.ts'

const delegated = () => Object.assign(new Error('owned children cannot ask directly'), { code: 'DELEGATED_CALLER' })

it('uses the dedicated permission presenter without dropping persistent or ambiguous choices', async () => {
  const direct = vi.fn(async () => {
    throw delegated()
  })
  const present = vi.fn(
    async ({ questions }: { questions: readonly { id: string; options?: readonly { label: string }[] }[] }) => ({
      answers: [{ id: questions[0]!.id, selected: [questions[0]!.options![2]!.label] }],
    }),
  )
  const deps = {
    userQuestions: { ask: direct },
    permissionQuestions: { ask: present },
    getAgent: () => ({ id: 'child' }),
  }
  const response = await createAcpNativePermissionHandler(deps)({
    sessionId: 'external-child',
    toolCall: { toolCallId: 'call', kind: 'execute', rawInput: { command: 'echo permission' } },
    options: [
      { optionId: 'one', kind: 'allow_once', name: 'Once' },
      { optionId: 'other-once', kind: 'allow_once', name: 'Once' },
      { optionId: 'persistent-exact', kind: 'allow_always', name: 'For this session' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  })
  expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'persistent-exact' } })
  expect(present).toHaveBeenCalledOnce()
  expect(direct).not.toHaveBeenCalled()
})

it('uses the dedicated presenter for a verified Codex authorization scope without defaulting to once', async () => {
  const direct = vi.fn(async () => {
    throw delegated()
  })
  const present = vi.fn(
    async ({ questions }: { questions: readonly { id: string; options?: readonly { label: string }[] }[] }) => ({
      answers: [{ id: questions[0]!.id, selected: [questions[0]!.options![1]!.label] }],
    }),
  )
  const deps = {
    userQuestions: { ask: direct },
    permissionQuestions: { ask: present },
    hostToolName: 'bash',
    getAgent: () => ({ id: 'child' }),
  }
  const request = {
    requestId: 'scope-request',
    mode: 'form',
    message: 'Approve the requested tool?',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
    requestedSchema: {
      type: 'object',
      properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } },
      required: ['persist'],
    },
  } as acp.CreateElicitationRequest
  expect(await createAcpNativeElicitationHandler(deps)(request)).toEqual({
    action: 'accept',
    content: { persist: 'session' },
  })
  expect(present).toHaveBeenCalledOnce()
  expect(direct).not.toHaveBeenCalled()
})

it.each(['unverified', 'ordinary-form', 'additional-field', 'free-text-scope'] as const)(
  'does not route %s elicitation through permission presentation',
  async (kind) => {
    const direct = vi.fn(async () => {
      throw delegated()
    })
    const present = vi.fn(async () => ({ answers: [] }))
    const deps = {
      userQuestions: { ask: direct },
      permissionQuestions: { ask: present },
      getAgent: () => ({ id: 'child' }),
      ...(kind === 'unverified' ? {} : { hostToolName: 'bash' }),
    }
    const request = {
      sessionId: 'external-child',
      mode: 'form',
      message: 'Choose an answer',
      ...(kind === 'ordinary-form' ? {} : { _meta: { codex_approval_kind: 'mcp_tool_call' } }),
      requestedSchema: {
        type: 'object',
        properties: {
          persist: { type: 'string', ...(kind === 'free-text-scope' ? {} : { enum: ['once', 'session'] }) },
          ...(kind === 'additional-field' ? { detail: { type: 'string' } } : {}),
        },
        required: ['persist'],
      },
    } as acp.CreateElicitationRequest
    expect(await createAcpNativeElicitationHandler(deps)(request)).toEqual({ action: 'cancel' })
    expect(direct).toHaveBeenCalledOnce()
    expect(present).not.toHaveBeenCalled()
  },
)

it('preserves the existing singleton-once Codex approval carrier', async () => {
  const direct = vi.fn(async () => {
    throw delegated()
  })
  const present = vi.fn(async () => ({ answers: [] }))
  const approveDelegatedOnce = vi.fn(async () => true)
  const handler = createAcpNativeElicitationHandler({
    userQuestions: { ask: direct },
    permissionQuestions: { ask: present },
    getAgent: () => ({ id: 'child' }),
    hostToolName: 'bash',
    approveDelegatedOnce,
  })
  expect(
    await handler({
      mode: 'form',
      sessionId: 'external-child',
      message: 'Approve this invocation',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: {
        type: 'object',
        properties: { persist: { type: 'string', enum: ['once'] } },
        required: ['persist'],
      },
    }),
  ).toEqual({ action: 'accept', content: { persist: 'once' } })
  expect(approveDelegatedOnce).toHaveBeenCalledOnce()
  expect(present).not.toHaveBeenCalled()
})

it('keeps an ordinary Antigravity interaction on the original native question boundary', async () => {
  const direct = vi.fn(async () => {
    throw delegated()
  })
  const present = vi.fn(async () => ({ answers: [] }))
  const handler = createAcpNativePermissionHandler({
    userQuestions: { ask: direct },
    permissionQuestions: { ask: present },
    getAgent: () => ({ id: 'child' }),
    nativeQuestionProfile: 'antigravity',
  })
  expect(
    await handler({
      sessionId: 'external-child',
      toolCall: { toolCallId: 'interaction_1234abcd', title: 'Which plan?', rawInput: {} },
      options: [
        { optionId: 'a', kind: 'allow_once', name: 'Plan A' },
        { optionId: 'b', kind: 'allow_once', name: 'Plan B' },
      ],
    }),
  ).toEqual({ outcome: { outcome: 'cancelled' } })
  expect(direct).toHaveBeenCalledOnce()
  expect(present).not.toHaveBeenCalled()
})
