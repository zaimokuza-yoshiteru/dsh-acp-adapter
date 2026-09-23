import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativeElicitationHandler,
  type AcpNativeUserQuestionService,
} from '../../../src/domain/policy/elicitation.ts'

const form = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): acp.CreateElicitationRequest => ({
  mode: 'form',
  message: 'Please provide the release settings.',
  requestedSchema: { type: 'object', properties, required },
}) as acp.CreateElicitationRequest

describe('native ACP form elicitation bridge (M5c)', () => {
  it('uses DSH native optionless questions for free text and consumes the custom answer channel', async () => {
    let question: { readonly options?: readonly unknown[] } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          question = questions[0]
          return { answers: [{ id: 'summary', selected: [], custom: 'multi\nline' }] }
        },
      },
      getAgent: () => ({}),
    })

    await expect(handler(form({ summary: { type: 'string' } }))).resolves.toEqual({
      action: 'accept',
      content: { summary: 'multi\nline' },
    })
    expect(question?.options).toBeUndefined()
  })

  it('maps string/enum, boolean, number/integer and multi-select answers to ACP content', async () => {
    const agent = { id: 'root-agent' }
    const requests: unknown[] = []
    const userQuestions: AcpNativeUserQuestionService = {
      ask: async (request) => {
        requests.push(request)
        return { answers: [
          { id: 'name', selected: [], custom: 'release-1' },
          { id: 'channel', selected: ['stable'] },
          { id: 'enabled', selected: ['Yes'] },
          { id: 'ratio', selected: [], custom: '1.5' },
          { id: 'count', selected: [], custom: '2' },
          { id: 'tags', selected: ['one', 'two'] },
        ] }
      },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => agent })
    const response = await handler(form({
      name: { type: 'string' },
      channel: { type: 'string', enum: ['stable', 'canary'] },
      enabled: { type: 'boolean' },
      ratio: { type: 'number', minimum: 0, maximum: 2 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', items: { type: 'string', enum: ['one', 'two', 'three'] }, minItems: 1 },
    }))
    expect(response).toEqual({ action: 'accept', content: {
      name: 'release-1', channel: 'stable', enabled: true, ratio: 1.5, count: 2, tags: ['one', 'two'],
    } })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ agent })
    const questions = (requests[0] as { questions: { id: string; detail?: string; multiSelect?: boolean }[] }).questions
    expect(questions.map((item) => item.id)).toEqual(['name', 'channel', 'enabled', 'ratio', 'count', 'tags'])
    expect(questions[0]).toMatchObject({ id: 'name', detail: 'Please provide the release settings.' })
    expect(questions.at(-1)).toMatchObject({ id: 'tags', multiSelect: true })
  })

  it('declines URL and unsupported, nested, sensitive or malformed schemas before asking', async () => {
    const ask = vi.fn(async () => ({ answers: [] }))
    const userQuestions = { ask } as unknown as AcpNativeUserQuestionService
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => ({}) })
    await expect(handler({ mode: 'url', message: 'login', url: 'https://example.com/login' } as acp.CreateElicitationRequest)).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ secret: { type: 'string' } }))).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ nested: { type: 'object', properties: {} } }))).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ value: { type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] } }))).resolves.toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('fails closed without the host service/Agent and never opens a URL', async () => {
    const params = form({ value: { type: 'string' } })
    await expect(createAcpNativeElicitationHandler({ getAgent: () => ({}) })(params)).resolves.toEqual({ action: 'cancel' })
    await expect(createAcpNativeElicitationHandler({ userQuestions: { ask: async () => ({ answers: [] }) }, getAgent: () => undefined })(params)).resolves.toEqual({ action: 'cancel' })
  })

  it('propagates the prompt signal, and abort/throw/no answerer become cancel', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const service: AcpNativeUserQuestionService = {
      ask: async (request) => { received = request.signal; return { answers: [{ id: 'value', selected: [], custom: 'ok' }] } },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions: service, getAgent: () => ({}) })
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({ action: 'accept', content: { value: 'ok' } })
    expect(received).toBe(controller.signal)
    controller.abort()
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({ action: 'cancel' })
    const throwing = createAcpNativeElicitationHandler({ userQuestions: { ask: async () => { throw new Error('no provider') } }, getAgent: () => ({}) })
    await expect(throwing(form({ value: { type: 'string' } }))).resolves.toEqual({ action: 'cancel' })
  })

  it('keeps concurrent requests isolated', async () => {
    const answers = ['first', 'second']
    const service: AcpNativeUserQuestionService = {
      ask: vi.fn(async () => {
        const custom = answers.shift() ?? ''
        return { answers: [{ id: 'value', selected: [], custom }] }
      }),
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions: service, getAgent: () => ({}) })
    const [first, second] = await Promise.all([
      handler(form({ value: { type: 'string' } })),
      handler(form({ value: { type: 'string' } })),
    ])
    expect(first).toEqual({ action: 'accept', content: { value: 'first' } })
    expect(second).toEqual({ action: 'accept', content: { value: 'second' } })
    expect(service.ask).toHaveBeenCalledTimes(2)
  })
  it.each(['zh-CN', 'en'])('normalizes Codex scope labels in %s and returns the exact selected scope', async locale => {
    const params = { ...form({ persist: { type: 'string', title: 'Approval scope', oneOf: [
      { const: 'once', title: 'Allow once' }, { const: 'session', title: 'Allow for this session' }, { const: 'always', title: "Allow and don't ask again" },
    ] } }), _meta: { codex_approval_kind: 'mcp_tool_call' } }
    for (const [index, scope] of ['once', 'session', 'always'].entries()) {
      const handler = createAcpNativeElicitationHandler({ locale, hostToolName: 'glob', getAgent: () => ({}), userQuestions: {
        ask: async ({ questions }) => {
          expect(questions[0]?.header).toBeUndefined()
          expect(questions[0]?.question).toBe(locale === 'en' ? 'Approval scope' : '授权范围')
          expect(questions[0]?.detail).toContain('glob')
          expect(questions[0]?.options?.map(option => option.label)).not.toContain('persist')
          return { answers: [{ id: 'persist', selected: [questions[0]!.options![index]!.label] }] }
        },
      } })
      expect(await handler(params)).toEqual({ action: 'accept', content: { persist: scope } })
    }
  })

  it('preserves titled options/descriptions, disambiguates collisions and maps arrays back to values', async () => {
    const oneOf = [{ const: 'a', title: 'Same', description: 'First' }, { const: 'b', title: 'Same' }, { const: 'c', title: 'Same (a)' }]
    const handler = createAcpNativeElicitationHandler({ getAgent: () => ({}), userQuestions: {
      ask: async ({ questions }) => {
        const options = questions[0]!.options!
        expect(new Set(options.map(option => option.label)).size).toBe(3)
        expect(options[0]?.description).toBe('First')
        return { answers: [{ id: 'choices', selected: [options[0]!.label, options[2]!.label] }] }
      },
    } })
    expect(await handler(form({ choices: { type: 'array', title: 'Choose', items: { type: 'string', oneOf } } })))
      .toEqual({ action: 'accept', content: { choices: ['a', 'c'] } })
  })

  it.each([
    { selected: [], custom: 'always' }, { selected: ['always'] }, { selected: ['Allow once', 'Always allow'] },
  ])('does not guess enum values from free text or ambiguous selections: %j', async answer => {
    const handler = createAcpNativeElicitationHandler({ getAgent: () => ({}), userQuestions: {
      ask: async () => ({ answers: [{ id: 'persist', ...answer }] }),
    } })
    expect(await handler(form({ persist: { type: 'string', oneOf: [{ const: 'once', title: 'Allow once' }, { const: 'always', title: 'Always allow' }] } }))).toEqual({ action: 'cancel' })
  })

  it.each([true, false])('uses a child-owned native approval only after delegated rejection (allowed=%s)', async allowed => {
    const controller = new AbortController()
    const approveDelegatedOnce = vi.fn(async (signal?: AbortSignal) => { expect(signal).toBe(controller.signal); return allowed })
    const handler = createAcpNativeElicitationHandler({ getAgent: () => ({}), hostToolName: 'bash', approveDelegatedOnce,
      userQuestions: { ask: async () => { throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' }) } },
    })
    const params = { ...form({ persist: { type: 'string', enum: ['once', 'session', 'always'] } }),
      _meta: { codex_approval_kind: 'mcp_tool_call' } }
    expect(await handler(params, controller.signal)).toEqual(allowed ? { action: 'accept', content: { persist: 'once' } } : { action: 'cancel' })
    expect(approveDelegatedOnce).toHaveBeenCalledTimes(1)
  })

  it.each(['unverified', 'ordinary-form', 'extra-field', 'persistent-only', 'other-error', 'aborted', 'approval-error', 'late-abort'])('fails closed for delegated approval: %s', async scenario => {
    const controller = new AbortController()
    const approveDelegatedOnce = vi.fn(async () => {
      if (scenario === 'approval-error') throw new Error('offline')
      if (scenario === 'late-abort') controller.abort()
      return true
    })
    const handler = createAcpNativeElicitationHandler({ getAgent: () => ({}),
      ...(scenario === 'unverified' ? {} : { hostToolName: 'bash' }), approveDelegatedOnce,
      userQuestions: { ask: async () => {
        if (scenario === 'aborted') controller.abort()
        throw Object.assign(new Error('question rejected'), { code: scenario === 'other-error' ? 'NO_PROVIDER' : 'DELEGATED_CALLER' })
      } },
    })
    const params = { ...form({ persist: { type: 'string', enum: scenario === 'persistent-only' ? ['session', 'always'] : ['once', 'always'] },
      ...(scenario === 'extra-field' ? { note: { type: 'string' } } : {}) }),
      ...(scenario === 'ordinary-form' ? {} : { _meta: { codex_approval_kind: 'mcp_tool_call' } }) }
    expect(await handler(params, controller.signal)).toEqual({ action: 'cancel' })
    expect(approveDelegatedOnce).toHaveBeenCalledTimes(['approval-error', 'late-abort'].includes(scenario) ? 1 : 0)
  })

})
