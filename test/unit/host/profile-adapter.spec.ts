import { describe, expect, it } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { acpProbeConfigKey } from '../../../src/domain/session/agent-config.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'

const profile = (command = 'agent', env: Record<string, string> = {}): AcpAgentConfig => ({ name: 'Test', command, args: ['acp'], env })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const request = (sessionId: string, messages: GenerateOptions['messages']) => markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: sessionId as never, messages })
const session = (message: ReturnType<typeof user>, seq = 2) => ({ header: { cwd: '/workspace' }, events: [
  { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
  { type: 'user/message', seq, data: message },
] })

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  failBegin = false
  async begin(record: DispatchRecord): Promise<void> {
    if (this.failBegin) throw new Error('WAL unavailable')
    if (this.records.some(entry => entry.key === record.key || entry.state === 'dispatch-uncertain')) throw new Error('ACP_RECOVERY_REQUIRED')
    this.records = [record]
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const record = this.records.find(entry => entry.key === key)
    if (record !== undefined) this.records = [{ ...record, state: 'settled' }]
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> { return this.records.find(entry => entry.key === key) }
}

function seam(): { ok: true; seam: never } {
  return { ok: true, seam: undefined as never }
}

const durableSidecar = {
  append: async () => undefined,
  readLatestBinding: async () => undefined,
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
    const adapter = new AcpProfileAdapter('shared', () => current, seam(), () => undefined, new Ledger(), () => ({
      listModels: async () => {
        if (cacheValid) return models
        spawns += 1
        cacheValid = true
        snapshot = { key: acpProbeConfigKey(current), at: Date.now(), result: { kind: 'ok', models, agentInfo: { name: 'shared-agent', version: '1' }, agentCapabilities: {} } }
        return models
      },
      probeSnapshot: () => snapshot as never,
      invalidateProbe: () => { snapshot = undefined; cacheValid = false },
    }), undefined, durableSidecar)
    const service = new AcpRemoteService(new Context(), {
      registry: { agents: () => new Map([['shared', current]]), probeCacheFor: () => adapter },
      resolveLiveAgent: () => undefined,
      checkExecutable: async () => true,
      queryVersion: async () => null,
    })
    await expect(adapter.listModels('acp-shared')).resolves.toEqual(models)
    await expect(service.health()).resolves.toMatchObject({ providers: [{ id: 'shared', probe: { status: 'ok' } }] })
    expect(spawns).toBe(1)
    await expect(service.health({ recheck: true, agentId: 'shared' })).resolves.toMatchObject({ providers: [{ id: 'shared', probe: { status: 'ok' } }] })
    await expect(adapter.listModels('acp-shared')).resolves.toEqual(models)
    expect(spawns).toBe(2)
  })

  it('accepts the finalized request copy delivered by the DSH LLM runtime', async () => {
    const message = user('current')
    let prompts = 0
    const adapter = new AcpProfileAdapter('test', () => profile(), seam(), () => session(message), new Ledger(), undefined, _options => ({
        acpSessionId: 'copied-request-session',
        start: async () => undefined,
        prompt: async () => { prompts += 1; return { stopReason: 'end_turn' } as never },
        close: async () => undefined,
      }), durableSidecar)
    const loopRequest = request('copied-request-session', [message])
    const finalizedCopy: GenerateOptions = { ...loopRequest, messages: [...loopRequest.messages] }
    for await (const _chunk of adapter.stream(finalizedCopy)) { /* drain */ }
    expect(prompts).toBe(1)
  })

  it('replaces the picker probe when an edited profile changes launch identity', async () => {
    let current = profile('old-agent')
    const created: string[] = []
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => undefined, new Ledger(),
      config => {
        created.push(config.command)
        return { listModels: async provider => [{ id: config.command, name: config.command, provider }] }
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
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => session(message), ledger, undefined, _options => ({
        acpSessionId: 'stream-session',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          onUpdate({ sessionId: 'stream-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } } } as never)
          onUpdate({ sessionId: 'stream-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'visible answer' } } } as never)
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }), durableSidecar)
    const chunks = []
    for await (const chunk of adapter.stream(request('stream-session', [message]))) chunks.push(chunk)
    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
      { type: 'text-delta', index: 1, text: 'visible answer' },
    ]))
  })

  it('prepareCall keeps metadata and dispatch on one immutable generation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let current = profile('old-agent', { TOKEN: 'old' })
    const ledger = new Ledger()
    const runtimes: Array<{ config: AcpAgentConfig; prompts: number }> = []
    const message = user('hello')
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => ({ header: { cwd: '/workspace' }, events: [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } }, { type: 'user/message', seq: 2, data: message },
    ] }) as never, ledger,
      () => ({ listModels: async () => { await gate; return [{ id: 'model-a', name: 'Old model', provider: 'acp-test' }] } }),
      options => {
        const record = { config: options.config as AcpAgentConfig, prompts: 0 }
        runtimes.push(record)
        return { acpSessionId: 'test-session', start: async () => undefined, prompt: async () => { record.prompts += 1; return { stopReason: 'end_turn' } as never }, close: async () => undefined }
      }, durableSidecar,
    )
    const preparedPromise = adapter.prepareCall('acp-test', 'model-a')
    current = profile('new-agent', { TOKEN: 'new' })
    release()
    const prepared = await preparedPromise
    expect(prepared.model.name).toBe('Old model')
    for await (const _chunk of prepared.stream(request('session-a', [message]))) { /* drain */ }
    expect(runtimes[0]?.config.command).toBe('old-agent')
    expect(runtimes[0]?.config.env).toEqual({ TOKEN: 'old' })
  })

  it('identity edit fails closed after an established generation, while a blank session uses the new one', async () => {
    let current = profile('old-agent', { TOKEN: 'old' })
    const ledger = new Ledger()
    const runtimes: AcpAgentConfig[] = []
    const first = user('one')
    const second = user('two')
    const adapter = new AcpProfileAdapter('test', () => current, seam(), id => id === 'old-session' ? session(first) : session(second), ledger, undefined, options => {
        runtimes.push(options.config as AcpAgentConfig)
        return { acpSessionId: 'test-session', start: async () => undefined, prompt: async () => ({ stopReason: 'end_turn' } as never), close: async () => undefined }
      }, durableSidecar)
    for await (const _chunk of adapter.stream(request('old-session', [first]))) { /* drain */ }
    current = profile('new-agent', { TOKEN: 'new' })
    await expect((async () => { for await (const _chunk of adapter.stream(request('old-session', [first])) ) { /* drain */ } })()).rejects.toMatchObject({ code: 'ACP_RECONCILIATION_REQUIRED' })
    for await (const _chunk of adapter.stream(request('blank-session', [second]))) { /* drain */ }
    expect(runtimes.map(entry => entry.command)).toEqual(['old-agent', 'new-agent'])
  })

  it('keeps the dispatch key short and never prompts when WAL begin fails', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => ({ header: { cwd: '/workspace' }, events: [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: message },
    ] }), ledger, undefined, _options => ({
      acpSessionId: 'test-session',
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal) => { prompts += 1; return { stopReason: 'end_turn' } as never },
      close: async () => undefined,
    }), durableSidecar)
    const longHistory = Array.from({ length: 1000 }, (_, index) => user(`history-${index}`))
    ledger.failBegin = true
    await expect((async () => { for await (const _chunk of adapter.stream(request('long-session', [message, ...longHistory]))) { /* drain */ } })()).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(0)
    ledger.failBegin = false
    for await (const _chunk of adapter.stream(request('long-session', [message]))) { /* drain */ }
    expect(ledger.records[0]?.key.length).toBeLessThan(100)
  })

  it('does not prompt a second time when an uncertain dispatch blocks re-entry', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => ({ header: { cwd: '/workspace' }, events: [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } }, { type: 'user/message', seq: 2, data: message },
    ] }), ledger, undefined, _options => ({
      acpSessionId: 'test-session',
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal) => { prompts += 1; throw new Error('remote interrupted') },
      close: async () => undefined,
    }), durableSidecar)
    await expect((async () => { for await (const _chunk of adapter.stream(request('uncertain-session', [message]))) { /* drain */ } })()).rejects.toThrow('remote interrupted')
    await expect((async () => { for await (const _chunk of adapter.stream(request('uncertain-session', [message]))) { /* drain */ } })()).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(1)
  })

  it('also blocks a settled dispatch with the same canonical key', async () => {
    const current = profile()
    const ledger = new Ledger()
    let prompts = 0
    const message = user('current')
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => ({ header: { cwd: '/workspace' }, events: [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } }, { type: 'user/message', seq: 2, data: message },
    ] }), ledger, undefined, _options => ({
      acpSessionId: 'test-session',
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal) => { prompts += 1; return { stopReason: 'end_turn' } as never },
      close: async () => undefined,
    }), durableSidecar)
    for await (const _chunk of adapter.stream(request('settled-session', [message]))) { /* drain */ }
    await expect((async () => { for await (const _chunk of adapter.stream(request('settled-session', [message]))) { /* drain */ } })()).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(prompts).toBe(1)
  })

  it('rejects an image before session/new, WAL, or prompt when the Agent does not advertise image input', async () => {
    const current = profile()
    const ledger = new Ledger()
    const image = { attachmentId: 'image-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } })
    const calls = { initialize: 0, start: 0, prompt: 0, close: 0 }
    const adapter = new AcpProfileAdapter('test', () => current, seam(), () => ({ header: { cwd: '/workspace' }, events: [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } }, { type: 'user/message', seq: 2, data: message },
    ] }) as never, ledger, undefined, _options => ({
        acpSessionId: 'image-session',
        agentCapabilities: {},
        initialize: async () => { calls.initialize += 1 },
        start: async () => { calls.start += 1 },
        prompt: async () => { calls.prompt += 1; return { stopReason: 'end_turn' } as never },
        close: async () => { calls.close += 1 },
      }), durableSidecar,
      { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 4096, maxImagePixels: 1024, maxImageDimension: 1024, mediaTypes: ['image/png'] }, readImage: async () => ({ ref: image, data: Uint8Array.of(1, 2, 3) }) },
    )
    await expect((async () => { for await (const _chunk of adapter.stream(markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: 'image-session' as never, messages: [message] }))) { /* drain */ } })()).rejects.toMatchObject({ code: 'ACP_INPUT_NOT_SUPPORTED' })
    expect(calls).toEqual({ initialize: 1, start: 0, prompt: 0, close: 1 })
    expect(ledger.records).toHaveLength(0)
  })
})
