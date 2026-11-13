import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativeElicitationHandler,
  type AcpNativeUserQuestionService,
} from '../../../src/domain/policy/elicitation.ts'

const form = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
  message = 'Please provide the release settings.',
): acp.CreateElicitationRequest =>
  ({
    mode: 'form',
    message,
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

  it.each([
    { enabled: true, label: 'Yes', ratio: 1.5, count: 2 },
    { enabled: false, label: 'No', ratio: 0, count: 0 },
  ])('maps typed answers to ACP content, preserving false and zero: %j', async ({ enabled, label, ratio, count }) => {
    const agent = { id: 'root-agent' }
    const requests: unknown[] = []
    const userQuestions: AcpNativeUserQuestionService = {
      ask: async (request) => {
        requests.push(request)
        return {
          answers: [
            { id: 'name', selected: [], custom: 'release-1' },
            { id: 'channel', selected: ['stable'] },
            { id: 'enabled', selected: [label] },
            { id: 'ratio', selected: [], custom: String(ratio) },
            { id: 'count', selected: [], custom: String(count) },
            { id: 'tags', selected: ['one', 'two'] },
          ],
        }
      },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => agent })
    const response = await handler(
      form({
        name: { type: 'string' },
        channel: { type: 'string', enum: ['stable', 'canary'] },
        enabled: { type: 'boolean' },
        ratio: { type: 'number', minimum: 0, maximum: 2 },
        count: { type: 'integer', minimum: 0, maximum: 3 },
        tags: { type: 'array', items: { type: 'string', enum: ['one', 'two', 'three'] }, minItems: 1 },
      }),
    )
    expect(response).toEqual({
      action: 'accept',
      content: {
        name: 'release-1',
        channel: 'stable',
        enabled,
        ratio,
        count,
        tags: ['one', 'two'],
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ agent })
    const questions = (requests[0] as { questions: { id: string; detail?: string; multiSelect?: boolean }[] }).questions
    expect(questions.map((item) => item.id)).toEqual(['name', 'channel', 'enabled', 'ratio', 'count', 'tags'])
    expect(questions[0]).toMatchObject({ id: 'name', detail: 'Please provide the release settings.' })
    expect(questions.at(-1)).toMatchObject({ id: 'tags', multiSelect: true })
  })

  it('removes only exact trimmed duplicates from question detail and preserves other fields', async () => {
    const message = '请确认本地改动应该如何处理，并说明选择依据。'
    const questions: { id: string; question: string; detail?: string }[] = []
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions: requested }) => {
          questions.push(...requested)
          return {
            answers: requested.map((item) => ({ id: item.id, selected: [], custom: `value:${item.id}` })),
          }
        },
      },
      getAgent: () => ({}),
    })

    const response = await handler(
      form(
        {
          local_action: {
            type: 'string',
            title: '本地改动',
            description: `  ${message}\n`,
          },
          follow_up: {
            type: 'string',
            title: '补充说明',
            description: '第二项的独立说明必须保留。',
          },
        },
        ['local_action', 'follow_up'],
        message,
      ),
    )

    expect(questions).toEqual([
      { id: 'local_action', question: '本地改动', detail: message },
      { id: 'follow_up', question: '补充说明', detail: '第二项的独立说明必须保留。' },
    ])
    expect(response).toEqual({
      action: 'accept',
      content: { local_action: `value:local_action`, follow_up: `value:follow_up` },
    })
  })

  it('does not repeat detail that matches the question title after trimming', async () => {
    const sameText = '本地改动应该如何处理？'
    let requested: { id: string; question: string; detail?: string } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          requested = questions[0]
          return { answers: [{ id: 'local_action', selected: [], custom: '保留' }] }
        },
      },
      getAgent: () => ({}),
    })

    const response = await handler(
      form(
        { local_action: { type: 'string', title: sameText, description: ` ${sameText} ` } },
        ['local_action'],
        sameText,
      ),
    )

    expect(requested).toEqual({ id: 'local_action', question: sameText })
    expect(response).toEqual({ action: 'accept', content: { local_action: '保留' } })
  })

  it('keeps distinct request and field details complete and ordered', async () => {
    const message = '请先说明本次操作的总体目标。'
    const description = `${message} 此字段还补充了不同的额外条件。`
    let requested: { id: string; question: string; detail?: string } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          requested = questions[0]
          return { answers: [{ id: 'reason', selected: [], custom: '已确认' }] }
        },
      },
      getAgent: () => ({}),
    })

    await handler(form({ reason: { type: 'string', title: message, description } }, ['reason'], message))

    expect(requested).toEqual({ id: 'reason', question: message, detail: description })
  })

  it('declines URL and unsupported, nested, sensitive or malformed schemas before asking', async () => {
    const ask = vi.fn(async () => ({ answers: [] }))
    const userQuestions = { ask } as unknown as AcpNativeUserQuestionService
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => ({}) })
    await expect(
      handler({ mode: 'url', message: 'login', url: 'https://example.com/login' } as acp.CreateElicitationRequest),
    ).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ secret: { type: 'string' } }))).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ nested: { type: 'object', properties: {} } }))).resolves.toEqual({ action: 'cancel' })
    await expect(
      handler(form({ value: { type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] } })),
    ).resolves.toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('fails closed without the host service/Agent and never opens a URL', async () => {
    const params = form({ value: { type: 'string' } })
    await expect(createAcpNativeElicitationHandler({ getAgent: () => ({}) })(params)).resolves.toEqual({
      action: 'cancel',
    })
    await expect(
      createAcpNativeElicitationHandler({
        userQuestions: { ask: async () => ({ answers: [] }) },
        getAgent: () => undefined,
      })(params),
    ).resolves.toEqual({ action: 'cancel' })
  })

  it('propagates the prompt signal, and abort/throw/no answerer become cancel', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const service: AcpNativeUserQuestionService = {
      ask: async (request) => {
        received = request.signal
        return { answers: [{ id: 'value', selected: [], custom: 'ok' }] }
      },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions: service, getAgent: () => ({}) })
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({
      action: 'accept',
      content: { value: 'ok' },
    })
    expect(received).toBe(controller.signal)
    controller.abort()
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({ action: 'cancel' })
    const throwing = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async () => {
          throw new Error('no provider')
        },
      },
      getAgent: () => ({}),
    })
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
  it.each(['zh-CN', 'en'])(
    'normalizes Codex scope labels in %s and returns the exact selected scope',
    async (locale) => {
      const params = {
        ...form({
          persist: {
            type: 'string',
            title: 'Approval scope',
            oneOf: [
              { const: 'once', title: 'Allow once' },
              { const: 'session', title: 'Allow for this session' },
              { const: 'always', title: "Allow and don't ask again" },
            ],
          },
        }),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }
      for (const [index, scope] of ['once', 'session', 'always'].entries()) {
        const handler = createAcpNativeElicitationHandler({
          locale,
          hostToolName: 'glob',
          getAgent: () => ({}),
          userQuestions: {
            ask: async ({ questions }) => {
              expect(questions[0]?.header).toBeUndefined()
              expect(questions[0]?.question).toBe(locale === 'en' ? 'Approval scope' : '授权范围')
              expect(questions[0]?.detail).toContain('glob')
              expect(questions[0]?.options?.map((option) => option.label)).not.toContain('persist')
              return { answers: [{ id: 'persist', selected: [questions[0]!.options![index]!.label] }] }
            },
          },
        })
        expect(await handler(params)).toEqual({ action: 'accept', content: { persist: scope } })
      }
    },
  )

  it('preserves titled options/descriptions, disambiguates collisions and maps arrays back to values', async () => {
    const oneOf = [
      { const: 'a', title: 'Same', description: 'First' },
      { const: 'b', title: 'Same' },
      { const: 'c', title: 'Same (a)' },
    ]
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      userQuestions: {
        ask: async ({ questions }) => {
          const options = questions[0]!.options!
          expect(new Set(options.map((option) => option.label)).size).toBe(3)
          expect(options[0]?.description).toBe('First')
          return { answers: [{ id: 'choices', selected: [options[0]!.label, options[2]!.label] }] }
        },
      },
    })
    expect(
      await handler(form({ choices: { type: 'array', title: 'Choose', items: { type: 'string', oneOf } } })),
    ).toEqual({ action: 'accept', content: { choices: ['a', 'c'] } })
  })

  it.each([{ selected: [], custom: 'always' }, { selected: ['always'] }, { selected: ['Allow once', 'Always allow'] }])(
    'does not guess enum values from free text or ambiguous selections: %j',
    async (answer) => {
      const handler = createAcpNativeElicitationHandler({
        getAgent: () => ({}),
        userQuestions: {
          ask: async () => ({ answers: [{ id: 'persist', ...answer }] }),
        },
      })
      expect(
        await handler(
          form({
            persist: {
              type: 'string',
              oneOf: [
                { const: 'once', title: 'Allow once' },
                { const: 'always', title: 'Always allow' },
              ],
            },
          }),
        ),
      ).toEqual({ action: 'cancel' })
    },
  )

  it.each([true, false])(
    'uses child-owned approval for a singleton once scope after delegated rejection (allowed=%s)',
    async (allowed) => {
      const controller = new AbortController()
      const approveDelegatedOnce = vi.fn(async (signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        return allowed
      })
      const handler = createAcpNativeElicitationHandler({
        getAgent: () => ({}),
        hostToolName: 'bash',
        approveDelegatedOnce,
        userQuestions: {
          ask: async () => {
            throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
          },
        },
      })
      const params = {
        ...form({ persist: { type: 'string', enum: ['once'] } }),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }
      expect(await handler(params, controller.signal)).toEqual(
        allowed ? { action: 'accept', content: { persist: 'once' } } : { action: 'cancel' },
      )
      expect(approveDelegatedOnce).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    'unverified',
    'ordinary-form',
    'extra-field',
    'persistent-only',
    'multiple-scopes',
    'other-error',
    'aborted',
    'approval-error',
    'late-abort',
  ])('fails closed for delegated approval: %s', async (scenario) => {
    const controller = new AbortController()
    const approveDelegatedOnce = vi.fn(async () => {
      if (scenario === 'approval-error') throw new Error('offline')
      if (scenario === 'late-abort') controller.abort()
      return true
    })
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      ...(scenario === 'unverified' ? {} : { hostToolName: 'bash' }),
      approveDelegatedOnce,
      userQuestions: {
        ask: async () => {
          if (scenario === 'aborted') controller.abort()
          throw Object.assign(new Error('question rejected'), {
            code: scenario === 'other-error' ? 'NO_PROVIDER' : 'DELEGATED_CALLER',
          })
        },
      },
    })
    const params = {
      ...form({
        persist: {
          type: 'string',
          enum:
            scenario === 'persistent-only'
              ? ['session', 'always']
              : scenario === 'multiple-scopes'
                ? ['once', 'always']
                : ['once'],
        },
        ...(scenario === 'extra-field' ? { note: { type: 'string' } } : {}),
      }),
      ...(scenario === 'ordinary-form' ? {} : { _meta: { codex_approval_kind: 'mcp_tool_call' } }),
    }
    expect(await handler(params, controller.signal)).toEqual({ action: 'cancel' })
    expect(approveDelegatedOnce).toHaveBeenCalledTimes(['approval-error', 'late-abort'].includes(scenario) ? 1 : 0)
  })

  describe('optional fields without inferred companion relationships (#75)', () => {
    type Answer = { id: string; selected: string[]; custom?: string }
    const ask = (answers: (ids: readonly string[]) => Answer[]) => {
      const seen: Parameters<AcpNativeUserQuestionService['ask']>[0]['questions'][] = []
      const handler = createAcpNativeElicitationHandler({
        getAgent: () => ({}),
        userQuestions: {
          ask: async ({ questions }) => {
            seen.push([...questions])
            return { answers: answers(questions.map((question) => question.id)) }
          },
        },
      })
      return { handler, seen }
    }
    // opencode's `question` tool: an enum plus an optional "(other)" text field.
    const single = (required: string[] = []) =>
      form(
        {
          pick: {
            type: 'string',
            title: 'Repro',
            oneOf: [
              { const: 'a', title: 'Option A' },
              { const: 'b', title: 'Option B' },
            ],
          },
          pick_custom: { type: 'string', title: 'Repro (other)', description: 'Type your own answer' },
        },
        required,
      )

    it.each([
      ['a listed choice', ['Option A'], undefined, { pick: 'a' }],
      ['the independent text answer', [], 'my own', { pick_custom: 'my own' }],
      ['both fields', ['Option B'], 'deployment notes', { pick: 'b', pick_custom: 'deployment notes' }],
      ['Skip', [], undefined, {}],
    ] as const)('preserves both questions and accepts %s', async (_name, selected, custom, content) => {
      const { handler, seen } = ask(() => [
        { id: 'pick', selected: [...selected] },
        { id: 'pick_custom', selected: [], ...(custom === undefined ? {} : { custom }) },
      ])
      await expect(handler(single())).resolves.toEqual({ action: 'accept', content })
      expect(seen[0]!.map((question) => question.id)).toEqual(['pick', 'pick_custom'])
      expect(seen[0]!.map((question) => question.header)).toEqual(['Optional', 'Optional'])
      expect(seen[0]![1]).toMatchObject({ question: 'Repro (other)', detail: 'Type your own answer' })
    })

    it('preserves an independent optional field whose name ends in _custom', async () => {
      const { handler, seen } = ask(() => [
        { id: 'plan', selected: ['pro'] },
        { id: 'plan_custom', selected: [], custom: 'Use our existing deployment' },
      ])
      await expect(
        handler(
          form(
            {
              plan: { type: 'string', enum: ['basic', 'pro'] },
              plan_custom: {
                type: 'string',
                title: 'Custom deployment notes',
                description: 'Describe changes needed for the selected plan',
              },
            },
            [],
          ),
        ),
      ).resolves.toEqual({ action: 'accept', content: { plan: 'pro', plan_custom: 'Use our existing deployment' } })
      expect(seen[0]![1]).toMatchObject({
        id: 'plan_custom',
        question: 'Custom deployment notes',
        detail: 'Describe changes needed for the selected plan',
      })
    })

    it('parses a titled anyOf multi-select and preserves the separate text field', async () => {
      const { handler, seen } = ask(() => [
        { id: 'tags', selected: ['One', 'Two'] },
        { id: 'tags_custom', selected: [], custom: 'three' },
      ])
      const params = form(
        {
          tags: {
            type: 'array',
            items: {
              anyOf: [
                { const: 'one', title: 'One' },
                { const: 'two', title: 'Two' },
              ],
            },
          },
          tags_custom: { type: 'string', description: 'Add your own answer' },
        },
        [],
      )
      await expect(handler(params)).resolves.toEqual({
        action: 'accept',
        content: { tags: ['one', 'two'], tags_custom: 'three' },
      })
      expect(seen[0]).toHaveLength(2)
      expect(seen[0]![0]!.multiSelect).toBe(true)
    })

    it('rejects a multi-select declaring both oneOf and anyOf', async () => {
      const { handler, seen } = ask(() => [])
      const choices = [{ const: 'one', title: 'One' }]
      await expect(
        handler(form({ tags: { type: 'array', items: { oneOf: choices, anyOf: choices } } })),
      ).resolves.toEqual({ action: 'cancel' })
      expect(seen).toHaveLength(0)
    })

    it('preserves a required choice and omits the skipped optional text field', async () => {
      const { handler, seen } = ask(() => [
        { id: 'pick', selected: ['Option B'] },
        { id: 'pick_custom', selected: [] },
      ])
      await expect(handler(single(['pick']))).resolves.toEqual({ action: 'accept', content: { pick: 'b' } })
      expect(seen[0]!.map((question) => question.id)).toEqual(['pick', 'pick_custom'])
      expect(seen[0]!.map((question) => question.header)).toEqual([undefined, 'Optional'])
    })

    it.each([
      ['a required companion', { a: { type: 'string', enum: ['x'] }, a_custom: { type: 'string' } }, ['a_custom']],
      [
        'a companion that is not adjacent',
        { a: { type: 'string', enum: ['x'] }, note: { type: 'string' }, a_custom: { type: 'string' } },
        [],
      ],
      ['a text field without choices', { a: { type: 'string' }, a_custom: { type: 'string' } }, []],
    ] as const)('does not merge %s', async (_name, properties, required) => {
      const { handler, seen } = ask((ids) => ids.map((id) => ({ id, selected: [] })))
      await handler(form(properties, [...required]))
      expect(seen[0]!.map((question) => question.id)).toEqual(Object.keys(properties))
    })

    it.each([false, true])('refuses enum free text regardless of a following _custom field: %s', async (withCustom) => {
      const { handler } = ask(() => [{ id: 'pick', selected: [], custom: 'anything' }])
      await expect(
        handler(
          form(
            { pick: { type: 'string', enum: ['a', 'b'] }, ...(withCustom ? { pick_custom: { type: 'string' } } : {}) },
            [],
          ),
        ),
      ).resolves.toEqual({ action: 'cancel' })
    })

    it('omits skipped optional enum, number, boolean and constrained text fields', async () => {
      const { handler } = ask((ids) => ids.map((id) => ({ id, selected: [] })))
      const params = form(
        {
          choice: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'integer', minimum: 1 },
          enabled: { type: 'boolean' },
          code: { type: 'string', minLength: 3 },
          tags: { type: 'array', minItems: 1, items: { enum: ['one'] } },
        },
        [],
      )
      await expect(handler(params)).resolves.toEqual({ action: 'accept', content: {} })
    })

    it.each([
      { type: 'string' },
      { type: 'string', enum: ['a', 'b'] },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: { enum: ['a'] } },
    ])('cancels when a required field is missing or skipped: %j', async (field) => {
      for (const answers of [[], [{ id: 'value', selected: [] }]]) {
        const { handler } = ask(() => answers)
        await expect(handler(form({ value: field }))).resolves.toEqual({ action: 'cancel' })
      }
    })

    it('validates the independent text field constraints', async () => {
      const { handler } = ask(() => [{ id: 'pick_custom', selected: [], custom: 'x' }])
      const params = single()
      ;(params as any).requestedSchema.properties.pick_custom.minLength = 3
      await expect(handler(params)).resolves.toEqual({ action: 'cancel' })
    })
  })

  it.each([
    ['missing', []],
    ['skipped', [{ id: 'persist', selected: [] }]],
    ['blank', [{ id: 'persist', selected: [], custom: '  ' }]],
  ] as const)('cancels an optional permission scope when its answer is %s', async (_name, answers) => {
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      hostToolName: 'bash',
      userQuestions: { ask: async () => ({ answers }) },
    })
    for (const choices of [['once'], ['once', 'session', 'always']]) {
      const params = {
        ...form({ persist: { type: 'string', enum: choices } }, []),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }
      await expect(handler(params)).resolves.toEqual({ action: 'cancel' })
    }
  })

  it('accepts an explicitly selected optional permission scope without answering it on the user behalf', async () => {
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      hostToolName: 'bash',
      userQuestions: {
        ask: async ({ questions }) => {
          expect(questions[0]?.header).toBeUndefined()
          return { answers: [{ id: 'persist', selected: [questions[0]!.options![1]!.label] }] }
        },
      },
    })
    await expect(
      handler({
        ...form({ persist: { type: 'string', enum: ['once', 'session', 'always'] } }, []),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
    ).resolves.toEqual({ action: 'accept', content: { persist: 'session' } })
  })
})
