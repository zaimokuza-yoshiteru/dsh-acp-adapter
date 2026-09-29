import { withSessionFacts } from '../../support/session-facts.ts'
import { describe, expect, it } from 'vitest'
import { BlockAssembler, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { acpProbeConfigKey } from '../../../src/domain/session/agent-config.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { acpExecutionProjection, acpSessionView } from '../../../src/host/composition/session-facts.ts'

const profile = (command = 'agent', env: Record<string, string> = {}): AcpAgentConfig => ({
  name: 'Test',
  command,
  args: ['acp'],
  env,
})
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const request = (sessionId: string, messages: GenerateOptions['messages']) =>
  markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: sessionId as never, messages })
const session = (message: ReturnType<typeof user>, seq = 2) =>
  withSessionFacts({
    header: { cwd: '/workspace' },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq, data: message },
    ],
  })

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  failBegin = false
  async begin(record: DispatchRecord): Promise<void> {
    if (this.failBegin) throw new Error('WAL unavailable')
    if (this.records.some((entry) => entry.key === record.key || entry.state === 'dispatch-uncertain'))
      throw new Error('ACP_RECOVERY_REQUIRED')
    this.records = [record]
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const record = this.records.find((entry) => entry.key === key)
    if (record !== undefined) this.records = [{ ...record, state: 'settled' }]
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.records.find((entry) => entry.key === key)
  }
}

function seam(): { ok: true; seam: never } {
  return { ok: true, seam: undefined as never }
}

const durableSidecar = {
  append: async () => undefined,
  readLatestBinding: async () => undefined,
  readModeIntent: async () => undefined,
  readRecoveryState: async () => undefined,
  writeRecoveryState: async () => undefined,
} as unknown as AcpSidecar

describe('AcpProfileAdapter generation and dispatch boundaries', () => {
  it('shares one profile probe cache between picker and health, including recheck', async () => {
    const current = profile('shared-agent')
    let snapshot: unknown
    let spawns = 0
    let cacheValid = false
    const models = [{ id: 'model-a', name: 'Model A', provider: 'acp-shared' }]
    const adapter = new AcpProfileAdapter(
      'shared',
      () => current,
      seam(),
      () => undefined,
      new Ledger(),
      () => ({
        listModels: async () => {
          if (cacheValid) return models
          spawns += 1
          cacheValid = true
          snapshot = {
            key: acpProbeConfigKey(current),
            at: Date.now(),
            result: { kind: 'ok', models, agentInfo: { name: 'shared-agent', version: '1' }, agentCapabilities: {} },
          }
          return models
        },
        probeSnapshot: () => snapshot as never,
        invalidateProbe: () => {
          snapshot = undefined
          cacheValid = false
        },
      }),
      undefined,
      durableSidecar,
    )
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map([['shared', current]]), probeCacheFor: () => adapter },
      resolveLiveAgent: () => undefined,
      checkExecutable: async () => true,
      queryVersion: async () => null,
    })
    await expect(adapter.listModels('acp-shared')).resolves.toEqual(models)
    await expect(service.health()).resolves.toMatchObject({ providers: [{ id: 'shared', probe: { status: 'ok' } }] })
    expect(spawns).toBe(1)
    await expect(service.health({ recheck: true, agentId: 'shared' })).resolves.toMatchObject({
      providers: [{ id: 'shared', probe: { status: 'ok' } }],
    })
    await expect(adapter.listModels('acp-shared')).resolves.toEqual(models)
    expect(spawns).toBe(2)
  })

  it('forwards the V3 host system message while admitting only the current input', async () => {
    const message = user('current')
    const sent: unknown[] = []
    const adapter = new AcpProfileAdapter(
      'test',
      () => profile(),
      seam(),
      () => session(message),
      new Ledger(),
      undefined,
      () => ({
        acpSessionId: 'system-request',
        start: async () => undefined,
        prompt: async (prompt) => {
          sent.push(prompt)
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    const system = { ...user('HOST_SYSTEM_A'), role: 'system' as const, source: { kind: 'system-prompt' as const } }
    for await (const chunk of adapter.stream(request('system-request', [system, user('old history'), message]))) {
      void chunk
    }
    expect(JSON.stringify(sent)).toContain('HOST_SYSTEM_A')
    expect(JSON.stringify(sent)).toContain('current')
    expect(JSON.stringify(sent)).not.toContain('old history')
  })

  it.each(['native', 'ptc'] as const)(
    'projects the real DSH effective context through composition into a new ACP binding (%s)',
    async (mode) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)
      ctx.sessionProjections.register(acpExecutionProjection)
      try {
        const native = ctx.sessions.create(SessionId('native-before-acp'), { meta: { cwd: '/workspace' } })
        const appendContext = (kind: string, text: string) => {
          const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind,
              ...(kind === 'skill-catalog'
                ? { form: 'catalog', entries: [{ name: 'office-docx', description: 'Read and write Word documents.' }] }
                : {}),
            } as never,
          })
          native.append('user/message', message, { surfaceOp: 'append' })
        }
        appendContext(
          'skill-catalog',
          '<available_skills>\n- `office-docx`: Read and write Word documents.\n</available_skills>',
        )
        appendContext('runtime-context', 'Current DSH mode: read-only.')
        const agent = { id: native.header.id, session: native, inbox: { nextStep: [] } } as never
        ctx.provide('agents', { get: () => agent } as never)
        ctx.tools.register(
          defineTool({
            name: 'skill',
            description: 'Load a DSH skill.',
            parameters: { name: { type: 'string', required: true } },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            execute: () => Promise.resolve('loaded'),
          }),
        )
        native.append('turn/start', { turn: 1 })
        native.append('step/start', { turn: 1, step: 0 })
        const current = user('Current question')
        native.append('user/message', current, { surfaceOp: 'append' })
        const nativeView = acpSessionView(ctx, native)!
        const adapterView = Object.create(nativeView) as typeof nativeView
        Object.defineProperty(adapterView, 'permissions', { value: { sandbox: null, approval: null } })
        const sent: unknown[] = []
        const adapter = new AcpProfileAdapter(
          'test',
          () => profile(),
          seam(),
          () => adapterView,
          new Ledger(),
          undefined,
          () => ({
            acpSessionId: 'native-before-acp-remote',
            start: async () => undefined,
            prompt: async (prompt) => {
              sent.push(prompt)
              return { stopReason: 'end_turn' } as never
            },
            close: async () => undefined,
          }),
          durableSidecar,
        )
        const currentRouteTools =
          mode === 'native'
            ? [{ name: 'skill', description: 'Load DSH skill.', parameters: { type: 'object', properties: {} } }]
            : [{ name: 'run_code', description: 'Run DSH code.', parameters: { type: 'object', properties: {} } }]
        for await (const _chunk of adapter.stream({
          ...request('native-before-acp', [user('older native question'), current]),
          tools: currentRouteTools as never,
        })) {
          /* drain */
        }
        expect(JSON.stringify(sent)).toContain('Current DSH mode: read-only.')
        expect(JSON.stringify(sent)).toContain('office-docx')
        expect(JSON.stringify(sent)).not.toContain('older native question')
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('accepts the finalized request copy delivered by the DSH LLM runtime', async () => {
    const message = user('current')
    let prompts = 0
    const adapter = new AcpProfileAdapter(
      'test',
      () => profile(),
      seam(),
      () => session(message),
      new Ledger(),
      undefined,
      (_options) => ({
        acpSessionId: 'copied-request-session',
        start: async () => undefined,
        prompt: async () => {
          prompts += 1
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    const loopRequest = request('copied-request-session', [message])
    const finalizedCopy: GenerateOptions = { ...loopRequest, messages: [...loopRequest.messages] }
    for await (const _chunk of adapter.stream(finalizedCopy)) {
      /* drain */
    }
    expect(prompts).toBe(1)
  })

  it('passes only an admitted request’s model-facing schemas to the MCP lease factory', async () => {
    const message = user('current')
    let received: unknown
    const adapter = new AcpProfileAdapter(
      'test',
      () => profile(),
      seam(),
      () => session(message),
      new Ledger(),
      undefined,
      (runtimeOptions) => ({
        acpSessionId: 'visible-tools-session',
        initialize: async () => {
          runtimeOptions.mcpKey?.()
          await runtimeOptions.createMcpLease?.({})
        },
        start: async () => undefined,
        prompt: async () => ({ stopReason: 'end_turn' }) as never,
        close: async () => undefined,
      }),
      durableSidecar,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (_sessionId, _capabilities, _wireProfile, schemas) => {
        received = schemas
        return Promise.resolve(undefined)
      },
      (_sessionId, schemas) => JSON.stringify(schemas),
    )
    const options: GenerateOptions = {
      ...request('visible-tools-session', [message]),
      tools: [{ name: 'file_read', description: 'Read', parameters: { type: 'object' } }],
    }
    for await (const _chunk of adapter.stream(options)) {
      /* drain */
    }
    expect(received).toEqual(options.tools)
  })

  it('replaces the picker probe when an edited profile changes launch identity', async () => {
    let current = profile('old-agent')
    const created: string[] = []
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () => undefined,
      new Ledger(),
      (config) => {
        created.push(config.command)
        return { listModels: async (provider) => [{ id: config.command, name: config.command, provider }] }
      },
      undefined,
      durableSidecar,
    )
    await expect(adapter.listModels('acp-test')).resolves.toMatchObject([{ id: 'old-agent' }])
    current = profile('new-agent')
    await expect(adapter.listModels('acp-test')).resolves.toMatchObject([{ id: 'new-agent' }])
    expect(created).toEqual(['old-agent', 'new-agent'])
  })

  it('keeps ACP reasoning and visible text in distinct DSH content blocks', async () => {
    const current = profile()
    const ledger = new Ledger()
    const message = user('current')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () => session(message),
      ledger,
      undefined,
      (_options) => ({
        acpSessionId: 'stream-session',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          onUpdate({
            sessionId: 'stream-session',
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } },
          } as never)
          onUpdate({
            sessionId: 'stream-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'visible answer' } },
          } as never)
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    const chunks = []
    for await (const chunk of adapter.stream(request('stream-session', [message]))) chunks.push(chunk)
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
        { type: 'text-delta', index: 1, text: 'visible answer' },
      ]),
    )
  })

  const textChunk = (text: string, messageId?: string) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  })
  const thoughtChunk = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
  const toolChunk = (status: string, initial = false, toolCallId = 'tool-1') => ({
    sessionUpdate: initial ? 'tool_call' : 'tool_call_update',
    toolCallId,
    title: 'Check project',
    kind: 'read',
    status,
  })
  it.each([
    {
      name: 'alternating reasoning and answers',
      updates: [thoughtChunk('R1'), textChunk('A1'), thoughtChunk('R2'), textChunk('A2')],
      expected: [
        ['reasoning', 'R1'],
        ['text', 'A1'],
        ['reasoning', 'R2'],
        ['text', 'A2'],
      ],
    },
    {
      name: 'same-message tokens and changed message IDs',
      updates: [textChunk('Hel', 'a'), textChunk('lo', 'a'), textChunk('Next', 'b')],
      expected: [
        ['text', 'Hello'],
        ['text', 'Next'],
      ],
    },
    {
      name: 'optional IDs without invented boundaries',
      updates: [textChunk('H'), textChunk('e', 'a'), textChunk('l'), textChunk('lo', 'a')],
      expected: [['text', 'Hello']],
    },
    {
      name: 'tool invocation between replies',
      updates: [textChunk('Before'), toolChunk('in_progress', true), textChunk('After')],
      expected: [
        ['text', 'Before'],
        ['text', 'After'],
      ],
    },
    {
      name: 'late and repeated completion does not split an answer',
      updates: [
        toolChunk('in_progress', true),
        textChunk('Hel'),
        toolChunk('in_progress'),
        textChunk('lo'),
        toolChunk('completed'),
        textChunk('Do'),
        toolChunk('completed'),
        textChunk('ne'),
      ],
      expected: [['text', 'HelloDone']],
    },
    {
      name: 'late parallel tool completions keep same-message text contiguous',
      updates: [
        toolChunk('in_progress', true, 'tool-1'),
        toolChunk('in_progress', true, 'tool-2'),
        textChunk('Two teammates are ', 'answer-1'),
        toolChunk('completed', false, 'tool-1'),
        toolChunk('completed', false, 'tool-2'),
        toolChunk('completed', false, 'tool-1'),
        textChunk('processing the document.', 'answer-1'),
      ],
      expected: [['text', 'Two teammates are processing the document.']],
    },
    {
      name: 'a genuinely new tool start separates following answer text',
      updates: [textChunk('First answer.'), toolChunk('in_progress', true, 'tool-2'), textChunk('Second answer.')],
      expected: [
        ['text', 'First answer.'],
        ['text', 'Second answer.'],
      ],
    },
    {
      name: 'non-content metadata between tokens',
      updates: [textChunk('Hel'), { sessionUpdate: 'current_mode_update', currentModeId: 'code' }, textChunk('lo')],
      expected: [['text', 'Hello']],
    },
    {
      name: 'cancelled partial segments',
      updates: [thoughtChunk('R1'), textChunk('A1'), thoughtChunk('R2'), textChunk('A2')],
      expected: [
        ['reasoning', 'R1'],
        ['text', 'A1'],
        ['reasoning', 'R2'],
        ['text', 'A2'],
      ],
      stop: 'cancelled',
    },
  ])('preserves native content boundaries: $name', async ({ updates, expected, stop }) => {
    const message = user('Build a small project')
    const adapter = new AcpProfileAdapter(
      'test',
      () => profile(),
      seam(),
      () => session(message),
      new Ledger(),
      undefined,
      () => ({
        acpSessionId: 'stream-session',
        start: async () => undefined,
        close: async () => undefined,
        prompt: async (_content, onUpdate) => {
          for (const update of updates) onUpdate({ sessionId: 'stream-session', update } as never)
          return { stopReason: stop ?? 'end_turn' } as never
        },
      }),
      durableSidecar,
    )
    const assembler = new BlockAssembler()
    for await (const chunk of adapter.stream(request('stream-session', [message]))) assembler.push(chunk)
    expect(assembler.blocks()).toEqual(expected.map(([type, text]) => ({ type, text })))
  })

  it('prepareCall keeps metadata and dispatch on one immutable generation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let current = profile('old-agent', { TOKEN: 'old' })
    const ledger = new Ledger()
    const runtimes: Array<{ config: AcpAgentConfig; prompts: number }> = []
    const message = user('hello')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () =>
        withSessionFacts({
          header: { cwd: '/workspace' },
          inheritedEventCount: 0,
          snapshotEvents: () => [
            { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
            { type: 'user/message', seq: 2, data: message },
          ],
        }) as never,
      ledger,
      () => ({
        listModels: async () => {
          await gate
          return [{ id: 'model-a', name: 'Old model', provider: 'acp-test' }]
        },
      }),
      (options) => {
        const record = { config: options.config as AcpAgentConfig, prompts: 0 }
        runtimes.push(record)
        return {
          acpSessionId: 'test-session',
          start: async () => undefined,
          prompt: async () => {
            record.prompts += 1
            return { stopReason: 'end_turn' } as never
          },
          close: async () => undefined,
        }
      },
      durableSidecar,
    )
    const preparedPromise = adapter.prepareCall('acp-test', 'model-a')
    current = profile('new-agent', { TOKEN: 'new' })
    release()
    const prepared = await preparedPromise
    expect(prepared.model.name).toBe('Old model')
    for await (const _chunk of prepared.stream(request('session-a', [message]))) {
      /* drain */
    }
    expect(runtimes[0]?.config.command).toBe('old-agent')
    expect(runtimes[0]?.config.env).toEqual({ TOKEN: 'old' })
  })

  it('identity edit fails closed after an established generation, while a blank session uses the new one', async () => {
    let current = profile('old-agent', { TOKEN: 'old' })
    const ledger = new Ledger()
    const runtimes: AcpAgentConfig[] = []
    const first = user('one')
    const second = user('two')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      (id) => (id === 'old-session' ? session(first) : session(second)),
      ledger,
      undefined,
      (options) => {
        runtimes.push(options.config as AcpAgentConfig)
        return {
          acpSessionId: 'test-session',
          start: async () => undefined,
          prompt: async () => ({ stopReason: 'end_turn' }) as never,
          close: async () => undefined,
        }
      },
      durableSidecar,
    )
    for await (const _chunk of adapter.stream(request('old-session', [first]))) {
      /* drain */
    }
    current = profile('new-agent', { TOKEN: 'new' })
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(request('old-session', [first]))) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ACP_RECONCILIATION_REQUIRED' })
    for await (const _chunk of adapter.stream(request('blank-session', [second]))) {
      /* drain */
    }
    expect(runtimes.map((entry) => entry.command)).toEqual(['old-agent', 'new-agent'])
  })

  it('keeps the dispatch key short and never prompts when WAL begin fails', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () =>
        withSessionFacts({
          header: { cwd: '/workspace' },
          inheritedEventCount: 0,
          snapshotEvents: () => [
            { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
            { type: 'user/message', seq: 2, data: message },
          ],
        }),
      ledger,
      undefined,
      (_options) => ({
        acpSessionId: 'test-session',
        start: async () => undefined,
        prompt: async (_content, _onUpdate, _signal) => {
          prompts += 1
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    const longHistory = Array.from({ length: 1000 }, (_, index) => user(`history-${index}`))
    ledger.failBegin = true
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(request('long-session', [message, ...longHistory]))) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(0)
    ledger.failBegin = false
    for await (const _chunk of adapter.stream(request('long-session', [message]))) {
      /* drain */
    }
    expect(ledger.records[0]?.key.length).toBeLessThan(100)
  })

  it('does not prompt a second time when an uncertain dispatch blocks re-entry', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () =>
        withSessionFacts({
          header: { cwd: '/workspace' },
          inheritedEventCount: 0,
          snapshotEvents: () => [
            { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
            { type: 'user/message', seq: 2, data: message },
          ],
        }),
      ledger,
      undefined,
      (_options) => ({
        acpSessionId: 'test-session',
        start: async () => undefined,
        prompt: async (_content, _onUpdate, _signal) => {
          prompts += 1
          throw new Error('remote interrupted')
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(request('uncertain-session', [message]))) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('remote interrupted')
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(request('uncertain-session', [message]))) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(1)
  })

  it('also blocks a settled dispatch with the same canonical key', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () =>
        withSessionFacts({
          header: { cwd: '/workspace' },
          inheritedEventCount: 0,
          snapshotEvents: () => [
            { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
            { type: 'user/message', seq: 2, data: message },
          ],
        }),
      ledger,
      undefined,
      (_options) => ({
        acpSessionId: 'test-session',
        start: async () => undefined,
        prompt: async (_content, _onUpdate, _signal) => {
          prompts += 1
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      durableSidecar,
    )
    for await (const _chunk of adapter.stream(request('settled-session', [message]))) {
      /* drain */
    }
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(request('settled-session', [message]))) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(1)
  })

  it('rejects an image before session/new, WAL, or prompt when the Agent does not advertise image input', async () => {
    const current = profile()
    const ledger = new Ledger()
    const image = { attachmentId: 'image-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } })
    const calls = { initialize: 0, start: 0, prompt: 0, close: 0 }
    const adapter = new AcpProfileAdapter(
      'test',
      () => current,
      seam(),
      () =>
        withSessionFacts({
          header: { cwd: '/workspace' },
          inheritedEventCount: 0,
          snapshotEvents: () => [
            { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
            { type: 'user/message', seq: 2, data: message },
          ],
        }) as never,
      ledger,
      undefined,
      (_options) => ({
        acpSessionId: 'image-session',
        agentCapabilities: {},
        initialize: async () => {
          calls.initialize += 1
        },
        start: async () => {
          calls.start += 1
        },
        prompt: async () => {
          calls.prompt += 1
          return { stopReason: 'end_turn' } as never
        },
        close: async () => {
          calls.close += 1
        },
      }),
      durableSidecar,
      {
        imageLimits: {
          maxImageBytes: 1024,
          maxImagesPerMessage: 2,
          maxMessageImageBytes: 4096,
          maxImagePixels: 1024,
          maxImageDimension: 1024,
          mediaTypes: ['image/png'],
        },
        readImage: async () => ({ ref: image, data: Uint8Array.of(1, 2, 3) }),
      },
    )
    await expect(
      (async () => {
        for await (const _chunk of adapter.stream(
          markAgentLoopRequest({
            provider: 'acp-test',
            model: 'model-a',
            sessionId: 'image-session' as never,
            messages: [message],
          }),
        )) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ACP_INPUT_NOT_SUPPORTED' })
    expect(calls).toEqual({ initialize: 1, start: 0, prompt: 0, close: 1 })
    expect(ledger.records).toHaveLength(0)
  })
})
