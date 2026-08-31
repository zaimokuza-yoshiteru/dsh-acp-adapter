import { describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { profileLaunchIdentityHash } from '../../../src/domain/session/launch-fingerprint.ts'
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'

const profile = (): AcpAgentConfig => ({ name: 'Test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const session = (message: ReturnType<typeof user>) => ({ header: { cwd: os.tmpdir() }, events: [
  { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
  { type: 'user/message', seq: 2, data: message },
] })
const request = (id: string, message: ReturnType<typeof user>): GenerateOptions => markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: id as never, messages: [message] })
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  async begin(record: DispatchRecord): Promise<void> {
    if (this.records.some(item => item.state === 'dispatch-uncertain' || item.key === record.key)) throw new Error('ACP_RECOVERY_REQUIRED')
    this.records = [record]
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const item = this.records.find(record => record.key === key)
    if (item !== undefined) this.records = [{ ...item, state: 'settled' }]
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> { return this.records.find(record => record.key === key) }
}

function runtimeFactory(records: { starts: number; prompts: number; restores: number }, restoreError?: Error): (options: unknown) => AcpProfileRuntime {
  return () => ({
    acpSessionId: 'agent-session-1',
    agentInfo: { name: 'fake-agent', version: '1' },
    agentCapabilities: { sessionCapabilities: { resume: {} } },
    protocolVersion: 1,
    start: async () => { records.starts += 1 },
    restore: async () => { records.restores += 1; if (restoreError !== undefined) throw restoreError; return 'resumed' },
    prompt: async () => { records.prompts += 1; return { stopReason: 'end_turn' } as never },
    close: async () => undefined,
  })
}

function sidecarAt(): { sidecar: AcpSidecar; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-m3-'))
  return { root, sidecar: createAcpSidecar({ root }) }
}

function ledgerFor(sidecar: AcpSidecar): DispatchLedgerStore {
  return {
    begin: record => sidecar.beginDispatch(record as never),
    settle: (sessionId, key) => sidecar.settleDispatch(sessionId as never, key),
    read: (sessionId, key) => sidecar.readDispatch(sessionId as never, key),
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) { /* consume */ }
}

describe('M3a binding-first ACP provider', () => {
  it('fails closed before any ACP runtime work when the sidecar is absent', async () => {
    const records = { starts: 0, prompts: 0, restores: 0 }
    const message = user('hello')
    const adapter = new AcpProfileAdapter('test', profile, seam(), () => session(message), new Ledger(), undefined, runtimeFactory(records))
    await expect(drain(adapter.stream(request('no-sidecar', message)))).rejects.toMatchObject({ code: 'ACP_BINDING_UNAVAILABLE' })
    await expect(adapter.rebindBlank('no-sidecar')).rejects.toMatchObject({ code: 'ACP_BINDING_UNAVAILABLE' })
    expect(records.starts).toBe(0)
    expect(records.prompts).toBe(0)
  })

  it('does not prompt when the first durable binding write fails', async () => {
    const records = { starts: 0, prompts: 0, restores: 0 }
    const broken = {
      append: async () => { throw new Error('sidecar unavailable') },
      readLatestBinding: async () => undefined,
      readRecoveryState: async () => undefined,
      writeRecoveryState: async () => undefined,
    } as unknown as AcpSidecar
    const message = user('hello')
    const adapter = new AcpProfileAdapter('test', profile, seam(), () => session(message), new Ledger(), undefined, runtimeFactory(records), broken)
    await expect(drain(adapter.stream(request('binding-failure', message)))).rejects.toMatchObject({ code: 'ACP_BINDING_PERSIST_FAILED' })
    expect(records.starts).toBe(1)
    expect(records.prompts).toBe(0)
  })

  it('projects an established ACP session as DSH Custom without changing native sessions', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const records = { starts: 0, prompts: 0, restores: 0 }
      const message = user('hello')
      const events: Array<{ type: string; seq: number; data: unknown }> = [...session(message).events]
      const liveSession = {
        header: { cwd: os.tmpdir() },
        events,
        append: (type: string, data: unknown) => {
          const event = { type, seq: events.length + 1, data }
          events.push(event)
          return event
        },
      }
      const adapter = new AcpProfileAdapter('test', profile, seam(), () => liveSession, ledgerFor(sidecar), undefined, runtimeFactory(records), sidecar)
      await drain(adapter.stream(request('custom-permission', message)))
      expect(events.slice(0, 2)).toEqual(session(message).events)
      expect(events.slice(2)).toEqual([
        { type: 'sandbox/mode', seq: 3, data: { mode: 'danger-full-access', source: 'dsh-acp-native-agent-access' } },
        { type: 'approval/policy', seq: 4, data: { policy: 'ask', source: 'dsh-acp-native-agent-access' } },
      ])
      const binding = await sidecar.readLatestBinding('custom-permission' as never)
      expect(binding?.status === 'ok' ? binding.binding.dshCommittedSeq : undefined).toBe(4)
      expect(records.prompts).toBe(1)

      const nativeEvents = [...session(message).events]
      expect(nativeEvents.some(event => event.type === 'sandbox/mode' || event.type === 'approval/policy')).toBe(false)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the bound session after a restart without replay comparison', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const first = { starts: 0, prompts: 0, restores: 0 }
      const message = user('hello')
      const continuation = user('continue')
      let events: Array<{ type: string; seq: number; data: unknown }> = [...session(message).events]
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({ header: { cwd: os.tmpdir() }, events }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('restart-session', message)))
      expect(first.prompts).toBe(1)
      const initialBinding = await sidecar.readLatestBinding('restart-session' as never)
      expect(initialBinding?.status === 'ok' ? initialBinding.binding.dshCommittedSeq : undefined).toBe(2)
      const second = { starts: 0, prompts: 0, restores: 0 }
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: continuation }]
      const liveSession = {
        header: { cwd: os.tmpdir() },
        events,
        append: (type: string, data: unknown) => {
          const event = { type, seq: events.length + 1, data }
          events.push(event)
          return event
        },
      }
      const restarted = new AcpProfileAdapter('test', profile, seam(), () => liveSession, ledgerFor(sidecar), undefined, runtimeFactory(second), sidecar)
      await drain(restarted.stream(request('restart-session', continuation)))
      expect(second.restores).toBe(1)
      expect(second.starts).toBe(0)
      expect(second.prompts).toBe(1)
      expect(events.filter(event => event.type === 'sandbox/mode')).toEqual([
        { type: 'sandbox/mode', seq: 5, data: { mode: 'danger-full-access', source: 'dsh-acp-native-agent-access' } },
      ])
      expect(events.filter(event => event.type === 'approval/policy')).toEqual([
        { type: 'approval/policy', seq: 6, data: { policy: 'ask', source: 'dsh-acp-native-agent-access' } },
      ])
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not prompt again for the same settled step after restart', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('same step')
      const first = { starts: 0, prompts: 0, restores: 0 }
      const initial = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('same-step', message)))
      const second = { starts: 0, prompts: 0, restores: 0 }
      const restarted = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(second), sidecar)
      await expect(drain(restarted.stream(request('same-step', message)))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
      expect(second.restores).toBe(1)
      expect(second.prompts).toBe(0)
      expect((await sidecar.readRecoveryState('same-step' as never))?.kind).toBe('outcome-unknown')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores and prompts for a genuinely new DSH step with a new message id', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const firstMessage = user('first')
      const secondMessage = user('second')
      let events = session(firstMessage).events
      const first = { starts: 0, prompts: 0, restores: 0 }
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({ header: { cwd: os.tmpdir() }, events }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('continuation', firstMessage)))
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: secondMessage }]
      const second = { starts: 0, prompts: 0, restores: 0 }
      const restarted = new AcpProfileAdapter('test', profile, seam(), () => ({ header: { cwd: os.tmpdir() }, events }), ledgerFor(sidecar), undefined, runtimeFactory(second), sidecar)
      await drain(restarted.stream(request('continuation', secondMessage)))
      expect(second.restores).toBe(1)
      expect(second.prompts).toBe(1)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses load-only recovery as bounded staging/audit, never as DSH history', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('hello')
      const continuation = user('continue')
      let events = session(message).events
      const first = { starts: 0, prompts: 0, restores: 0 }
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({ header: { cwd: os.tmpdir() }, events }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('load-session', message)))
      const second = { starts: 0, prompts: 0, restores: 0 }
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: continuation }]
      const loaded = new AcpProfileAdapter('test', profile, seam(), () => ({ header: { cwd: os.tmpdir() }, events }), ledgerFor(sidecar), undefined, () => ({
        acpSessionId: 'agent-session-1', agentInfo: { name: 'fake-agent', version: '1' }, agentCapabilities: { loadSession: true }, protocolVersion: 1,
        start: async () => { second.starts += 1 },
        restore: async (_binding, _signal, onReplay) => { second.restores += 1; onReplay?.({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } } as never); return 'loaded' },
        prompt: async () => { second.prompts += 1; return { stopReason: 'end_turn' } as never }, close: async () => undefined,
      }), sidecar)
      await drain(loaded.stream(request('load-session', continuation)))
      expect(second.restores).toBe(1)
      const audit = await sidecar.list('load-session' as never)
      expect(audit.some(entry => entry.kind === 'replay-assessment' && entry.data.status === 'not-compared')).toBe(true)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a missing remote session and persists recovery state', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const first = { starts: 0, prompts: 0, restores: 0 }
      const message = user('hello')
      const initial = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('lost-session', message)))
      const second = { starts: 0, prompts: 0, restores: 0 }
      const restarted = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(second, new Error('session not found')), sidecar)
      await expect(drain(restarted.stream(request('lost-session', message)))).rejects.toMatchObject({ code: 'ACP_SESSION_NOT_FOUND' })
      expect(second.prompts).toBe(0)
      expect((await sidecar.readRecoveryState('lost-session' as never))?.kind).toBe('session-lost')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('turns a prompt transport failure into an outcome-unknown recovery gate', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const records = { starts: 0, prompts: 0, restores: 0 }
      const message = user('hello')
      const adapter = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, () => ({
        acpSessionId: 'agent-session-1', agentInfo: { name: 'fake-agent', version: '1' }, protocolVersion: 1,
        start: async () => { records.starts += 1 }, prompt: async () => { records.prompts += 1; throw new Error('transport closed') }, close: async () => undefined,
      }), sidecar)
      await expect(drain(adapter.stream(request('unknown-outcome', message)))).rejects.toThrow('transport closed')
      expect((await sidecar.readRecoveryState('unknown-outcome' as never))?.kind).toBe('outcome-unknown')
      await expect(drain(adapter.stream(request('unknown-outcome', message)))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
      expect(records.prompts).toBe(1)
      await adapter.rebindBlank('unknown-outcome')
      const rebound = { starts: 0, prompts: 0, restores: 0 }
      const blank = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(rebound), sidecar)
      await drain(blank.stream(request('unknown-outcome', message)))
      expect(rebound.prompts).toBe(1)
      const reboundBinding = await sidecar.readLatestBinding('unknown-outcome' as never)
      expect(reboundBinding?.status === 'ok' ? reboundBinding.binding.generation : undefined).toBe(2)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('waits for cancelled prompt settlement before an aborted consumer return allows session reuse', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const firstMessage = user('cancel me')
      const continuation = user('continue')
      let events = session(firstMessage).events
      const promptStarted = Promise.withResolvers<void>()
      const cancellationSettled = Promise.withResolvers<acp.PromptResponse>()
      let factoryCalls = 0
      let prompts = 0
      let restores = 0
      const runtime: AcpProfileRuntime = {
        acpSessionId: 'agent-session-1',
        agentInfo: { name: 'fake-agent', version: '1' },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        protocolVersion: 1,
        start: async () => undefined,
        restore: async () => { restores += 1; return 'resumed' },
        prompt: async (_content, onUpdate, signal) => {
          prompts += 1
          if (prompts > 1) return { stopReason: 'end_turn' } as never
          promptStarted.resolve()
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              onUpdate({
                sessionId: 'agent-session-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late cancellation update' } },
              } as never)
              resolve()
            }
            if (signal?.aborted === true) onAbort()
            else signal?.addEventListener('abort', onAbort, { once: true })
          })
          return await cancellationSettled.promise
        },
        close: async () => undefined,
      }
      const adapter = new AcpProfileAdapter(
        'test',
        profile,
        seam(),
        () => ({ header: { cwd: os.tmpdir() }, events }),
        ledgerFor(sidecar), undefined,
        () => { factoryCalls += 1; return runtime },
        sidecar,
      )
      const controller = new AbortController()
      const iterator = adapter.stream({ ...request('cancel-return', firstMessage), signal: controller.signal })[Symbol.asyncIterator]()
      const firstChunk = iterator.next()
      await promptStarted.promise

      controller.abort(new Error('user stopped'))
      await expect(firstChunk).resolves.toMatchObject({
        done: false,
        value: { type: 'text-delta', text: 'late cancellation update' },
      })
      const returning = iterator.return!(undefined)
      const returnState = await Promise.race([
        returning.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => { resolve('pending') }, 10)),
      ])
      expect(returnState).toBe('pending')

      cancellationSettled.resolve({ stopReason: 'cancelled' })
      await expect(returning).resolves.toMatchObject({ done: true })
      const firstDispatchKey = acpCanonicalHash16({
        provider: 'acp-test',
        model: 'model-a',
        generation: profileLaunchIdentityHash('test', profile()),
        acceptedMessageIds: [String(firstMessage.id)],
      })
      expect((await sidecar.readDispatch('cancel-return' as never, firstDispatchKey))?.state).toBe('settled')
      expect((await sidecar.readRecoveryState('cancel-return' as never))?.kind).toBe('healthy')

      events = [...events,
        { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 4, data: continuation },
      ]
      await drain(adapter.stream(request('cancel-return', continuation)))
      expect(prompts).toBe(2)
      expect(restores).toBe(1)
      expect(factoryCalls).toBe(1)
      expect((await sidecar.readRecoveryState('cancel-return' as never))?.kind).toBe('healthy')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('classifies a definitive ACP auth rejection as reconnect-required', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('hello')
      const adapter = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, () => ({
        acpSessionId: 'agent-session-1', agentInfo: { name: 'fake-agent', version: '1' }, protocolVersion: 1,
        start: async () => undefined,
        prompt: async () => { throw new AcpClientError('auth_required', 'agent login required') },
        close: async () => undefined,
      }), sidecar)

      await expect(drain(adapter.stream(request('auth-rejected', message)))).rejects.toMatchObject({ code: 'ACP_AUTH_REQUIRED' })
      await expect(sidecar.readRecoveryState('auth-rejected' as never)).resolves.toMatchObject({
        kind: 'reconnect-required',
        cause: 'auth-required',
      })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('retryOriginal restores the same ACP session and clears only the reviewed dispatch guard', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('hello')
      let mode: 'fail' | 'restore' = 'fail'
      let prompts = 0
      const adapter = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, () => ({
        acpSessionId: 'agent-session-1', agentInfo: { name: 'fake-agent', version: '1' }, agentCapabilities: { sessionCapabilities: { resume: {} } }, protocolVersion: 1,
        start: async () => undefined,
        restore: async () => { if (mode !== 'restore') throw new Error('not used') ; return 'resumed' },
        prompt: async () => { prompts += 1; if (mode === 'fail') throw new Error('transport closed'); return { stopReason: 'end_turn' } as never }, close: async () => undefined,
      }), sidecar)
      await expect(drain(adapter.stream(request('retry-session', message)))).rejects.toThrow('transport closed')
      const dispatchKey = acpCanonicalHash16({ provider: 'acp-test', model: 'model-a', generation: profileLaunchIdentityHash('test', profile()), acceptedMessageIds: [String(message.id)] })
      expect((await sidecar.readDispatch('retry-session' as never, dispatchKey))?.state).toBe('dispatch-uncertain')
      mode = 'restore'
      await adapter.retryOriginal('retry-session')
      expect(prompts).toBe(1)
      expect((await sidecar.readRecoveryState('retry-session' as never))?.kind).toBe('healthy')
      expect(await sidecar.readDispatch('retry-session' as never, dispatchKey)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires the original profile generation, then retries the original binding after the setting is restored', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('hello')
      let current = profile()
      const records = { starts: 0, prompts: 0, restores: 0 }
      const adapter = new AcpProfileAdapter('test', () => current, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(records), sidecar)
      await drain(adapter.stream(request('generation-retry', message)))
      current = { ...profile(), args: ['changed'] }
      await expect(drain(adapter.stream(request('generation-retry', message)))).rejects.toMatchObject({ code: 'ACP_RECONCILIATION_REQUIRED' })
      current = profile()
      await adapter.retryOriginal('generation-retry')
      expect(records.restores).toBe(1)
      expect((await sidecar.readRecoveryState('generation-retry' as never))?.kind).toBe('healthy')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('explicit rebindBlank clears only ACP continuity and allows a new binding', async () => {
    const { sidecar, root } = sidecarAt()
    try {
      const message = user('hello')
      const first = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory({ starts: 0, prompts: 0, restores: 0 }), sidecar)
      await drain(first.stream(request('rebind-session', message)))
      await first.rebindBlank('rebind-session')
      expect((await sidecar.readLatestBinding('rebind-session' as never))?.status).toBe('ok')
      const second = { starts: 0, prompts: 0, restores: 0 }
      const rebound = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory(second), sidecar)
      await drain(rebound.stream(request('rebind-session', message)))
      expect(second.starts).toBe(1)
      expect(second.restores).toBe(0)
      const reboundBinding = await sidecar.readLatestBinding('rebind-session' as never)
      expect(reboundBinding?.status === 'ok' ? reboundBinding.binding.generation : undefined).toBe(2)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
