import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativePermissionHandler,
  type AcpPermissionAuditRecord,
  type AcpNativeApprovalService,
} from '../../../src/domain/policy/permissions.ts'
import {
  createAcpNativeElicitationHandler,
  type AcpNativeUserQuestionService,
} from '../../../src/domain/policy/elicitation.ts'
import { summarizeRawInputForAudit } from '../../../src/domain/policy/events.ts'
import { normalizeAntigravityPresentation } from '../../../src/host/tools/antigravity.ts'

const option = (optionId: string, name: string, kind: acp.PermissionOption['kind']): acp.PermissionOption => ({
  optionId,
  name,
  kind,
})
const request = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: 'external-session',
  toolCall: { toolCallId: 'call-options', kind: 'execute', rawInput: { command: 'echo selected' } },
  options,
})

describe('complete ACP permission choices', () => {
  it.each(['en', 'zh'] as const)(
    'summarizes Antigravity command aliases without exposing duplicate input (%s)',
    async (locale) => {
      for (const wait of [0, 5_000, 10_000]) {
        const wireInput = { CommandLine: 'printf exact-marker', Cwd: '/workspace/current', WaitMsBeforeAsync: wait }
        const input = normalizeAntigravityPresentation(wireInput, undefined, undefined, 'bash').rawInput
        const original = structuredClone(input)
        const fingerprint = summarizeRawInputForAudit(input).hash
        const options = [
          option('always-id', 'Allow Always (risky)', 'allow_always'),
          option('once-id', 'Allow', 'allow_once'),
          option('deny-id', 'Deny', 'reject_once'),
        ]
        const audit: AcpPermissionAuditRecord[] = []
        const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
          answers: [{ id: questions[0]!.id, selected: ['Allow'] }],
        }))
        const response = await createAcpNativePermissionHandler({
          userQuestions: { ask },
          getAgent: () => ({}),
          locale,
          nativeQuestionProfile: 'antigravity',
          audit: {
            append: async (entry) => {
              audit.push(entry)
            },
          },
        })({
          ...request(options),
          toolCall: {
            toolCallId: 'antigravity-aliases',
            kind: 'execute',
            title: wireInput.CommandLine,
            rawInput: input,
          },
        })
        const question = ask.mock.calls[0]![0].questions[0]!
        expect(question.question).toBe(
          [
            `${locale === 'zh' ? '命令' : 'Command'}: ${wireInput.CommandLine}`,
            `${locale === 'zh' ? '工作目录' : 'Working directory'}: ${wireInput.Cwd}`,
            locale === 'zh' ? `转入后台前等待: ${wait} 毫秒` : `Wait before backgrounding: ${wait} ms`,
          ].join('\n'),
        )
        expect(question.detail).toBe(`\`\`\`\n${JSON.stringify({ rawInput: original }, null, 2)}\n\`\`\``)
        expect(question.options!.map(({ label }) => label)).toEqual(options.map(({ name }) => name))
        expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'once-id' } })
        expect(wireInput).toEqual({
          CommandLine: 'printf exact-marker',
          Cwd: '/workspace/current',
          WaitMsBeforeAsync: wait,
        })
        expect(input).toEqual(original)
        expect(summarizeRawInputForAudit(input).hash).toBe(fingerprint)
        expect(audit.find(({ data }) => data.phase === 'asked')?.data).toMatchObject({
          toolCall: { rawInputHash: fingerprint },
        })
      }
    },
  )

  it.each(['en', 'zh'] as const)(
    'keeps conflicting Antigravity aliases and unknown permission scope visible (%s)',
    async (locale) => {
      const input = {
        command: 'printf canonical',
        CommandLine: 'rm conflicting-target',
        cwd: '/workspace/current',
        Cwd: '/other/workspace',
        WaitMsBeforeAsync: 5_000,
        permissions: { network: { domains: ['private.example'] } },
      }
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
      await createAcpNativePermissionHandler({
        userQuestions: { ask },
        getAgent: () => ({}),
        locale,
        nativeQuestionProfile: 'antigravity',
      })({
        ...request([option('once', 'Allow once', 'allow_once'), option('always', 'Always allow', 'allow_always')]),
        toolCall: { toolCallId: 'conflicting-aliases', kind: 'execute', rawInput: input },
      })
      const question = ask.mock.calls[0]![0].questions[0]!
      expect(question.question).toContain('printf canonical')
      expect(question.question).toContain('/workspace/current')
      expect(question.question).toContain('"CommandLine": "rm conflicting-target"')
      expect(question.question).toContain('"Cwd": "/other/workspace"')
      expect(question.question).toContain('"permissions"')
      expect(question.question).toContain('private.example')
      expect(question.detail).toBe(`\`\`\`\n${JSON.stringify({ rawInput: input }, null, 2)}\n\`\`\``)
    },
  )

  it.each([-1, 10_001, 1.5, '5000', null, { milliseconds: 5000 }])(
    'keeps unrecognized Antigravity wait value visible: %j',
    async (wait) => {
      const input = { command: 'printf exact-marker', cwd: '/workspace', WaitMsBeforeAsync: wait }
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
      await createAcpNativePermissionHandler({
        userQuestions: { ask },
        getAgent: () => ({}),
        nativeQuestionProfile: 'antigravity',
      })({
        ...request([option('once', 'Allow once', 'allow_once')]),
        toolCall: { toolCallId: 'unknown-wait-value', kind: 'execute', rawInput: input },
      })
      const question = ask.mock.calls[0]![0].questions[0]!
      expect(question.question).toContain(JSON.stringify({ WaitMsBeforeAsync: wait }, null, 2))
      expect(question.question).not.toContain('Wait before backgrounding')
    },
  )

  it('keeps Antigravity whitespace-different aliases, argv and unrelated equal values visible', async () => {
    const input = {
      command: 'printf exact',
      CommandLine: 'printf exact ',
      cwd: '/workspace',
      Cwd: '/workspace ',
      argv: ['printf', 'exact'],
      unrelated: 'printf exact',
    }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    await createAcpNativePermissionHandler({
      userQuestions: { ask },
      getAgent: () => ({}),
      nativeQuestionProfile: 'antigravity',
    })({
      ...request([option('once', 'Allow once', 'allow_once')]),
      toolCall: { toolCallId: 'distinct-facts', kind: 'execute', rawInput: input },
    })
    const text = ask.mock.calls[0]![0].questions[0]!.question
    expect(text).toContain('"CommandLine": "printf exact "')
    expect(text).toContain('"Cwd": "/workspace "')
    expect(text).toContain('"argv": [')
    expect(text).toContain('"unrelated": "printf exact"')
  })

  it.each(['other-profile', 'non-execute'] as const)(
    'keeps unrecognized Antigravity-shaped scope visible (%s)',
    async (scope) => {
      const input = {
        command: 'printf exact',
        CommandLine: 'printf exact',
        cwd: '/workspace',
        Cwd: '/workspace',
        WaitMsBeforeAsync: 5000,
      }
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
      await createAcpNativePermissionHandler({
        userQuestions: { ask },
        getAgent: () => ({}),
        ...(scope === 'non-execute' ? { nativeQuestionProfile: 'antigravity' as const } : {}),
      })({
        ...request([option('once', 'Allow once', 'allow_once')]),
        toolCall: {
          toolCallId: 'unrecognized-provider-facts',
          kind: scope === 'non-execute' ? 'other' : 'execute',
          rawInput: input,
        },
      })
      const text = ask.mock.calls[0]![0].questions[0]!.question
      expect(text).toContain('"CommandLine": "printf exact"')
      expect(text).toContain('"Cwd": "/workspace"')
      expect(text).toContain('"WaitMsBeforeAsync": 5000')
      expect(text).not.toContain('Wait before backgrounding')
    },
  )

  it('shows execute descriptions as prose while keeping command and unknown scope in a multi-choice request', async () => {
    const input = {
      command: 'find src -type f -print',
      description: 'List source files',
      unknown_scope: { network: ['internal.example'] },
    }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    await createAcpNativePermissionHandler({ getAgent: () => ({}), userQuestions: { ask } })({
      ...request([
        option('once', 'Allow Once', 'allow_once'),
        option('always', 'Always Allow', 'allow_always'),
        option('deny', 'Deny', 'reject_once'),
      ]),
      toolCall: { toolCallId: 'command-description', kind: 'execute', rawInput: input },
    })
    const question = ask.mock.calls[0]![0].questions[0]!
    expect(question.question).toContain('List source files')
    expect(question.question).not.toContain('"description"')
    expect(question.question).toContain(input.command)
    expect(question.question).toContain('"unknown_scope"')
    expect(question.question).toContain('internal.example')
    expect(question.detail).toContain('"description": "List source files"')
    expect(question.options!.map(({ label }) => label)).toEqual(['Allow Once', 'Always Allow', 'Deny'])
  })

  it('keeps the exact original choice meanings on an unambiguous native approval card', async () => {
    const allowName = `Permit ${'this exact directory '.repeat(20)}for this invocation\u001b[31m`
    const rejectName = 'Continue without granting access'
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    expect(
      await handler(
        request([
          option('precise-allow', allowName, 'allow_once'),
          option('precise-reject', rejectName, 'reject_once'),
        ]),
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'precise-allow' } })
    const reason = approval.request.mock.calls[0]?.[0]?.reason
    expect(reason).toContain(allowName.replace('\u001b', '\\x1b'))
    expect(reason).toContain(rejectName)
    expect(reason).not.toContain('\u001b')
    expect(ask).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'once and persistent grants',
      options: [option('once', 'Allow once', 'allow_once'), option('session', 'Allow this session', 'allow_always')],
    },
    {
      name: 'distinct one-time grants',
      options: [
        option('turn', 'Allow this turn', 'allow_once'),
        option('strict', 'Allow with strict review', 'allow_once'),
      ],
    },
    {
      name: 'distinct one-time rejections',
      options: [
        option('once', 'Allow once', 'allow_once'),
        option('retry', 'Reject and revise', 'reject_once'),
        option('stop', 'Reject and stop', 'reject_once'),
      ],
    },
    {
      name: 'persistent rejection',
      options: [option('once', 'Allow once', 'allow_once'), option('never', 'Never allow', 'reject_always')],
    },
    {
      name: 'identical labels with distinct decisions',
      options: [option('allow', 'Same', 'allow_once'), option('reject', 'Same', 'reject_once')],
    },
  ])('shows every $name and returns only the explicitly selected option id', async ({ options }) => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const agent = { id: 'original-child' }
    let selectedIndex = 0
    const audit: AcpPermissionAuditRecord[] = []
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions, agent: owner }) => {
      expect(owner).toBe(agent)
      expect(questions[0]?.options).toHaveLength(options.length)
      const labels = questions[0]!.options!.map((entry) => entry.label)
      expect(new Set(labels).size).toBe(options.length)
      return { answers: [{ id: questions[0]!.id, selected: [labels[selectedIndex]!] }] }
    })
    const handler = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => agent,
      audit: { append: async (record) => void audit.push(record) },
    })
    for (const [index, selected] of options.entries()) {
      selectedIndex = index
      await expect(handler(request(options))).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: selected.optionId },
      })
      expect(audit.at(-1)?.data).toMatchObject({
        decisionVia: 'native-question',
        optionId: selected.optionId,
        selectedOptionKind: selected.kind,
      })
    }
    expect(approval.request).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledTimes(options.length)
  })

  it('preserves long option scope and the full permission payload on the question', async () => {
    const target = `/workspace/${'deep/'.repeat(60)}specific-file.txt`
    const first = `Authorize ${'project directory '.repeat(15)}for this turn only`
    const second = `Authorize ${'project directory '.repeat(15)}for every future session`
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => {
      return { answers: [{ id: questions[0]!.id, selected: [second] }] }
    })
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    await expect(
      handler({
        ...request([option('turn', first, 'allow_once'), option('persistent', second, 'allow_always')]),
        toolCall: {
          toolCallId: 'additional-scope',
          title: 'Additional sandbox permissions',
          kind: 'other',
          rawInput: { permissions: { fileSystem: { write: [target] }, network: { enabled: true } } },
        },
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'persistent' } })
    const question = ask.mock.calls[0]![0].questions[0]!
    expect(question.options).toEqual([{ label: first }, { label: second }])
    expect(question.header).toBe('Permission request')
    expect(question.question).not.toContain('Details:')
    expect(question.question).toContain('fileSystem')
    expect(question.question).toContain(target)
    expect(question.question).toContain('"enabled": true')
    expect(question.detail).toContain(target)
    expect(question.detail).toContain('"enabled": true')
    expect(approval.request).not.toHaveBeenCalled()
  })

  it.each([
    ['read', 'native-approval'],
    ['read', 'native-question'],
    ['execute', 'native-approval'],
    ['execute', 'native-question'],
  ] as const)('preserves separate target locations and all %s input facts on %s', async (kind, surface) => {
    const target = '/workspace/actual-target.txt'
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: [questions[0]!.options![0]!.label] }],
    }))
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    const options = [option('once', 'Allow once', 'allow_once')]
    if (surface === 'native-question') options.push(option('session', 'Allow for this session', 'allow_always'))
    await expect(
      handler({
        ...request(options),
        toolCall: {
          toolCallId: 'location-and-input',
          kind,
          rawInput:
            kind === 'read' ? { offset: 1, limit: 10 } : { command: 'echo target', cwd: '/workspace/command-root' },
          locations: [{ path: target }],
        },
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    const text =
      surface === 'native-question'
        ? ask.mock.calls[0]![0].questions[0]!.question
        : approval.request.mock.calls[0]![0].reason!
    expect(text).toContain(target)
    expect(text).toContain(kind === 'read' ? '"limit": 10' : '/workspace/command-root')
    if (kind === 'execute') expect(text.match(/echo target/g)).toHaveLength(1)
    expect(approval.request).toHaveBeenCalledTimes(surface === 'native-approval' ? 1 : 0)
    expect(ask).toHaveBeenCalledTimes(surface === 'native-question' ? 1 : 0)
  })

  it('keeps exact command, title and directory visible without the raw-request disclosure', async () => {
    const command = `printf 'Authorization: Bearer exact-value'\nprintf '${'x'.repeat(220)}'\u001b[31m`
    const title = `Run ${'the explicitly named operation '.repeat(10)}`
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, locale: 'zh', getAgent: () => ({}) })
    await handler({
      ...request([option('once', 'Allow once', 'allow_once')]),
      toolCall: {
        toolCallId: 'complete-operation',
        title,
        kind: 'execute',
        rawInput: { command, cwd: '/workspace/current', timeout: 45 },
        locations: [{ path: '/workspace/report.txt', line: 7 }],
      },
    })
    const question = ask.mock.calls[0]![0].questions[0]!
    expect(question.header).toBe('授权请求')
    expect(question.question).toBe(
      `${title}\n命令: ${command.replace('\u001b', '\\x1b')}\n工作目录: /workspace/current\n位置: /workspace/report.txt:7\n输入: {\n  "timeout": 45\n}`,
    )
    expect(question.question).not.toContain('…')
    expect(question.question).not.toContain('\u001b')
    expect(question.detail).toContain('"rawInput"')
    expect(question.detail).toContain('"locations"')
  })

  it.each([
    { kind: 'execute' as const, input: { argv: ['sh', '-c', 'cat /private/input'] } },
    { kind: 'other' as const, input: { permissions: { network: { domains: ['example.test'] } } } },
    { kind: 'other' as const, input: ['scope-a', { scope: 'scope-b' }] },
  ])('does not hide an unrecognized $kind input behind raw details', async ({ kind, input }) => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    await createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })({
      ...request([option('once', 'Allow once', 'allow_once')]),
      toolCall: { toolCallId: 'unknown-input', kind, rawInput: input },
    })
    const question = ask.mock.calls[0]![0].questions[0]!
    expect(question.header).toBe('Permission request')
    expect(question.question).toContain(JSON.stringify(input, null, 2))
    if (kind === 'execute') expect(question.question).toContain('Command details were not provided')
  })

  it.each(['en', 'zh'] as const)(
    'shows file path and complete content directly without hiding extra scope (%s)',
    async (locale) => {
      const input = {
        file_path: '/workspace/review.md',
        content: 'first line\nsecond line\u001b',
        permissions: { network: true },
      }
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
      await createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}), locale })({
        ...request([option('once', 'Allow once', 'allow_once')]),
        toolCall: { toolCallId: 'file-facts', title: 'write', kind: 'other', rawInput: input },
      })
      const question = ask.mock.calls[0]![0].questions[0]!
      expect(question.question).toContain(`${locale === 'zh' ? '文件路径' : 'File path'}: ${input.file_path}`)
      expect(question.question).toContain(`${locale === 'zh' ? '内容' : 'Content'}: first line\nsecond line\\x1b`)
      expect(question.question).toContain('"network": true')
      expect(question.question).not.toContain('"file_path"')
      expect(question.detail).toContain('"file_path": "/workspace/review.md"')
      expect(question.detail).toContain('"content": "first line\\nsecond line\\u001b"')
    },
  )

  it('preserves null input without fabricating a location or a line number', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
    for (const locations of [null, [{ path: '/workspace/file', line: null }]]) {
      await handler({
        ...request([option('once', 'Allow once', 'allow_once')]),
        toolCall: { toolCallId: 'nullable-facts', kind: 'read', rawInput: null, locations },
      })
    }
    expect(ask.mock.calls[0]![0].questions[0]!.question).toBe('Read restricted content\nInput: null')
    expect(ask.mock.calls[1]![0].questions[0]!.question).toBe(
      'Read restricted content\nLocations: /workspace/file\nInput: null',
    )
    expect(ask.mock.calls[1]![0].questions[0]!.detail).toContain('"line": null')
  })

  it.each(['en', 'zh'] as const)(
    'reports unsupported delegated choices without defaulting to once (%s)',
    async (locale) => {
      const approval = { request: vi.fn(async () => 'allowed-once' as const) }
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => {
        throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
      })
      const onUnavailable = vi.fn()
      const audit: AcpPermissionAuditRecord[] = []
      const handler = createAcpNativePermissionHandler({
        approval,
        userQuestions: { ask },
        getAgent: () => ({}),
        locale,
        onUnavailable,
        audit: { append: async (record) => void audit.push(record) },
      })
      await expect(
        handler(
          request([option('once', 'Allow once', 'allow_once'), option('always', 'Always allow', 'allow_always')]),
        ),
      ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      expect(approval.request).not.toHaveBeenCalled()
      expect(ask).toHaveBeenCalledOnce()
      expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
        code: 'ACP_DELEGATED_QUESTION_UNAVAILABLE',
        message:
          locale === 'zh'
            ? '宿主暂不支持子会话的此类授权选项；本次未授权。'
            : 'The host does not yet support these authorization options for child sessions; no permission was granted.',
      })
      expect(audit.at(-1)?.data).toMatchObject({ outcome: 'cancelled', note: 'delegated-question-unavailable' })
      expect(audit.at(-1)?.data).not.toHaveProperty('selectedOptionKind')
    },
  )

  it('does not downgrade a delegated elicitation with unchosen persistence options to once', async () => {
    const approveDelegatedOnce = vi.fn(async () => true)
    const onUnavailable = vi.fn()
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      hostToolName: 'bash',
      approveDelegatedOnce,
      onUnavailable,
      locale: 'zh',
      userQuestions: {
        ask: async () => {
          throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
        },
      },
    })
    await expect(
      handler({
        mode: 'form',
        sessionId: 'external-session',
        message: 'Approve the tool',
        requestedSchema: {
          type: 'object',
          properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } },
          required: ['persist'],
        },
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
    ).resolves.toEqual({ action: 'cancel' })
    expect(approveDelegatedOnce).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
      code: 'ACP_DELEGATED_QUESTION_UNAVAILABLE',
      message: '宿主暂不支持子会话的此类授权选项；本次未授权。',
    })
  })

  it.each(['permission', 'elicitation'] as const)(
    'does not mistake cancelled %s requests for unsupported choices',
    async (kind) => {
      const controller = new AbortController()
      const onUnavailable = vi.fn()
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => {
        controller.abort()
        throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
      })
      const common = { getAgent: () => ({}), userQuestions: { ask }, onUnavailable }
      if (kind === 'permission') {
        const audit: AcpPermissionAuditRecord[] = []
        const handler = createAcpNativePermissionHandler({
          ...common,
          audit: { append: async (record) => void audit.push(record) },
        })
        expect(
          await handler(
            request([option('once', 'Allow once', 'allow_once'), option('always', 'Always allow', 'allow_always')]),
            controller.signal,
          ),
        ).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(audit.at(-1)?.data).toMatchObject({ outcome: 'cancelled', note: 'cancelled' })
      } else {
        const handler = createAcpNativeElicitationHandler(common)
        expect(
          await handler(
            {
              mode: 'form',
              sessionId: 'external-session',
              message: 'Choose a value',
              requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
            controller.signal,
          ),
        ).toEqual({ action: 'cancel' })
      }
      expect(onUnavailable).not.toHaveBeenCalled()
    },
  )

  it.each(['permission', 'elicitation'] as const)(
    'keeps %s cancellation fail-closed if unavailable feedback cannot be delivered',
    async (kind) => {
      const onUnavailable = vi.fn(async () => {
        throw new Error('feedback channel closed')
      })
      const log = vi.fn()
      const common = {
        getAgent: () => ({}),
        onUnavailable,
        log,
        userQuestions: {
          ask: async () => {
            throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
          },
        },
      }
      if (kind === 'permission') {
        const audit: AcpPermissionAuditRecord[] = []
        const handler = createAcpNativePermissionHandler({
          ...common,
          audit: { append: async (record) => void audit.push(record) },
        })
        expect(
          await handler(
            request([option('once', 'Allow once', 'allow_once'), option('always', 'Always allow', 'allow_always')]),
          ),
        ).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(audit.at(-1)?.data).toMatchObject({ outcome: 'cancelled', note: 'delegated-question-unavailable' })
      } else {
        const handler = createAcpNativeElicitationHandler(common)
        expect(
          await handler({
            mode: 'form',
            sessionId: 'external-session',
            message: 'Choose a value',
            requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          }),
        ).toEqual({ action: 'cancel' })
        expect(onUnavailable).toHaveBeenCalledWith({
          code: 'ACP_DELEGATED_QUESTION_UNAVAILABLE',
          message: 'The host does not yet support questions for child sessions; no answer was submitted.',
        })
      }
      expect(onUnavailable).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('reporting failed'))
    },
  )
})
