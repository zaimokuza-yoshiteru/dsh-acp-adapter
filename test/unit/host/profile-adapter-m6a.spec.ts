import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'

const profile: AcpAgentConfig = { name: 'Test', command: 'agent', args: ['acp'], env: {} }
const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
const request = (id: string, extra: Partial<GenerateOptions> = {}): GenerateOptions => markAgentLoopRequest({
  provider: 'acp-test', model: 'target-model', sessionId: id as never,
  messages: [message], ...extra,
})

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  async begin(record: DispatchRecord): Promise<void> { this.records = [record] }
  async settle(_sessionId: string, key: string): Promise<void> { this.records = this.records.map(record => record.key === key ? { ...record, state: 'settled' } : record) }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> { return this.records.find(record => record.key === key) }
}

const sidecar = {
  append: async () => undefined,
  readLatestBinding: async () => undefined,
  readRecoveryState: async () => undefined,
  writeRecoveryState: async () => undefined,
} as unknown as AcpSidecar

const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })
const session = () => ({ header: { cwd: '/workspace' }, events: [
  { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
  { type: 'user/message', seq: 2, data: message },
] })

function runtimeFor(calls: Array<[string, string | boolean]>, configOptions: NonNullable<AcpProfileRuntime['configOptions']>, promptCount: { value: number }, behavior: { throwOnSet?: boolean; confirm?: boolean; reasoningAfterModel?: string[]; failRollback?: boolean } = {}): AcpProfileRuntime {
  let currentOptions = configOptions
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'agent-session',
    get configOptions() { return currentOptions },
    initialize: async () => undefined,
    start: async () => undefined,
    setConfigOption: async (id, value, signal) => {
      signal?.throwIfAborted()
      if (behavior.throwOnSet || (behavior.failRollback && id === 'model' && value === 'old-model')) throw new Error('set_config_option failed')
      calls.push([id, value])
      if (behavior.confirm === false) return
      currentOptions = currentOptions.map(option => option.id !== id
        ? option
        : option.type === 'select' ? { ...option, currentValue: String(value) } : option)
      if (id === 'model' && behavior.reasoningAfterModel !== undefined) {
        currentOptions = currentOptions.map(option => option.id !== 'thinking' || option.type !== 'select'
          ? option
          : { ...option, currentValue: behavior.reasoningAfterModel![0]!, options: behavior.reasoningAfterModel!.map(item => ({ value: item, name: item })) })
      }
    },
    prompt: async () => { promptCount.value += 1; return { stopReason: 'end_turn' } as never },
    close: async () => undefined,
  }
  return runtime
}

function options(): NonNullable<AcpProfileRuntime['configOptions']> {
  return [
    { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'old-model', options: [
      { value: 'old-model', name: 'Old' }, { value: 'target-model', name: 'Target' },
    ] },
    { id: 'thinking', name: 'Thinking', type: 'select', category: 'thought_level', currentValue: 'low', options: [
      { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
    ] },
  ]
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

describe('ACP M6a session configuration convergence', () => {
  it('exposes Agent-owned controls and context usage without duplicating model controls', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const initial = [...options(), { id: 'auto_compact', name: 'Auto compact', type: 'boolean' as const, category: 'behavior', currentValue: true }]
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => {
      const runtime = runtimeFor(calls, initial, promptCount)
      Object.assign(runtime, {
        modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }] },
        contextUsage: { used: 25, size: 100, cost: { amount: 0.2, currency: 'USD' } },
        isBusy: false,
      })
      return runtime
    }, sidecar)
    await drain(adapter.stream(request('session-controls')))
    const snapshot = await adapter.agentSessionSnapshot('session-controls')
    expect(snapshot.freshness).toBe('live')
    expect(snapshot.contextUsage).toMatchObject({ used: 25, size: 100, percent: 25, cost: { amount: 0.2, currency: 'USD' } })
    expect(snapshot.modes?.map(mode => mode.id)).toEqual(['code', 'plan'])
    expect(snapshot.configOptions?.some(option => option.id === 'model')).toBe(true)
    expect(snapshot.configOptions?.some(option => option.id === 'auto_compact')).toBe(true)
    await adapter.setAgentSessionOption('session-controls', { kind: 'config', id: 'auto_compact', value: false })
    expect(calls).not.toContainEqual(['model', false])
  })

  it('converges model and reasoning before prompt', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, options(), promptCount), sidecar)
    await drain(adapter.stream(request('session-a', { reasoningEffort: ReasoningEffortId('high') })))
    expect(calls).toEqual([['model', 'target-model'], ['thinking', 'high']])
    expect(promptCount.value).toBe(1)
  })

  it('does not issue RPC for already selected values', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const initial = options().map(option => option.type !== 'select'
      ? option
      : { ...option, currentValue: option.id === 'model' ? 'target-model' : 'high' })
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, initial, promptCount), sidecar)
    await drain(adapter.stream(request('session-b', { reasoningEffort: ReasoningEffortId('high') })))
    expect(calls).toEqual([])
    expect(promptCount.value).toBe(1)
  })

  it('accepts Agent-confirmed legacy values that are no longer selectable after restore', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const initial = options().map(option => option.type !== 'select'
      ? option
      : option.id === 'model'
        ? { ...option, currentValue: 'target-model', options: [{ value: 'old-model', name: 'Old' }] }
        : { ...option, currentValue: 'high', options: [{ value: 'low', name: 'Low' }] })
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, initial, promptCount), sidecar)
    await drain(adapter.stream(request('session-legacy-current', { reasoningEffort: ReasoningEffortId('high') })))
    expect(calls).toEqual([])
    expect(promptCount.value).toBe(1)
  })

  it('accepts Kimi resumed `on` as the collapsed live form of a stale `high` route', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const kimiProfile: AcpAgentConfig = { name: 'Kimi', command: 'kimi', args: ['acp'], env: {}, runtime: 'kimi' }
    const resumed = options().map(option => option.type !== 'select'
      ? option
      : option.id === 'model'
        ? { ...option, currentValue: 'target-model' }
        : { ...option, currentValue: 'on', options: [{ value: 'on', name: 'Thinking On' }] })
    const adapter = new AcpProfileAdapter('kimi', () => kimiProfile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, resumed, promptCount), sidecar)
    await drain(adapter.stream(request('session-kimi-resume', { provider: 'acp-kimi', reasoningEffort: ReasoningEffortId('high') })))
    expect(calls).toEqual([])
    expect(promptCount.value).toBe(1)
  })

  it('does not apply Kimi reasoning aliases to an arbitrary ACP profile', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const resumed = options().map(option => option.type !== 'select'
      ? option
      : option.id === 'model'
        ? { ...option, currentValue: 'target-model' }
        : { ...option, currentValue: 'on', options: [{ value: 'on', name: 'Thinking On' }] })
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, resumed, promptCount), sidecar)
    await expect(drain(adapter.stream(request('session-generic-resume', { reasoningEffort: ReasoningEffortId('high') })))).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
    expect(calls).toEqual([])
    expect(promptCount.value).toBe(0)
  })

  it('fails closed before WAL and prompt for an unavailable target', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const ledger = new Ledger()
    const initial = options().map(option => option.id === 'model' && option.type === 'select' ? { ...option, currentValue: 'target-model' } : option)
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), ledger, undefined, () => runtimeFor(calls, initial, promptCount), sidecar)
    await expect(drain(adapter.stream(request('session-c', { reasoningEffort: ReasoningEffortId('xhigh') })))).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
    expect(calls).toEqual([])
    expect(promptCount.value).toBe(0)
    expect(ledger.records).toEqual([])
  })

  it.each([
    ['RPC failure', { throwOnSet: true }],
    ['unconfirmed response', { confirm: false }],
  ])('fails closed before WAL and prompt for %s', async (_label, behavior) => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const ledger = new Ledger()
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), ledger, undefined, () => runtimeFor(calls, options(), promptCount, behavior), sidecar)
    await expect(drain(adapter.stream(request(`session-${_label}`, { reasoningEffort: ReasoningEffortId('high') })))).rejects.toMatchObject({ code: 'ACP_CONFIG_SYNC_FAILED' })
    expect(promptCount.value).toBe(0)
    expect(ledger.records).toEqual([])
  })

  it('honors abort while converging and does not enter WAL', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const ledger = new Ledger()
    const controller = new AbortController()
    controller.abort()
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), ledger, undefined, () => runtimeFor(calls, options(), promptCount), sidecar)
    await expect(drain(adapter.stream(request('session-abort', { reasoningEffort: ReasoningEffortId('high'), signal: controller.signal })))).rejects.toThrow()
    expect(promptCount.value).toBe(0)
    expect(ledger.records).toEqual([])
  })

  it('uses the reasoning values returned after a model switch', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), new Ledger(), undefined, () => runtimeFor(calls, options(), promptCount, { reasoningAfterModel: ['low', 'ultra'] }), sidecar)
    await drain(adapter.stream(request('session-model-dependent', { reasoningEffort: ReasoningEffortId('ultra') })))
    expect(calls).toEqual([['model', 'target-model'], ['thinking', 'ultra']])
    expect(promptCount.value).toBe(1)
  })

  it('rolls back the model when the requested reasoning value is unavailable', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const ledger = new Ledger()
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), ledger, undefined, () => runtimeFor(calls, options(), promptCount, { reasoningAfterModel: ['low', 'ultra'] }), sidecar)
    await expect(drain(adapter.stream(request('session-rollback', { reasoningEffort: ReasoningEffortId('xhigh') })))).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
    expect(calls).toEqual([['model', 'target-model'], ['model', 'old-model']])
    expect(promptCount.value).toBe(0)
    expect(ledger.records).toEqual([])
  })

  it('fails clearly when a rejected reasoning change also prevents rollback', async () => {
    const calls: Array<[string, string | boolean]> = []
    const promptCount = { value: 0 }
    const ledger = new Ledger()
    const adapter = new AcpProfileAdapter('test', () => profile, seam(), () => session(), ledger, undefined, () => runtimeFor(calls, options(), promptCount, { reasoningAfterModel: ['low', 'ultra'], failRollback: true }), sidecar)
    await expect(drain(adapter.stream(request('session-rollback-failed', { reasoningEffort: ReasoningEffortId('xhigh') })))).rejects.toThrow('previous model could not be restored')
    expect(calls).toEqual([['model', 'target-model']])
    expect(promptCount.value).toBe(0)
    expect(ledger.records).toEqual([])
  })
})
