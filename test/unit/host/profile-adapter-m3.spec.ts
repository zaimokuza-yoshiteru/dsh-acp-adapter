import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { createUserMessage, LlmError, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { profileLaunchIdentityHash, acpLaunchFingerprint } from '../../../src/domain/session/launch-fingerprint.ts'
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'

const profile = (): AcpAgentConfig => ({ name: 'Test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const session = (message: ReturnType<typeof user>) => {
  const events = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: message },
  ]
  return { header: { cwd: os.tmpdir() }, inheritedEventCount: 0, events, snapshotEvents: () => [...events] }
}
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
        inheritedEventCount: 0,
        events,
        snapshotEvents: () => [...events],
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
        { type: 'sandbox/mode', seq: 3, data: { mode: 'danger-full-access' } },
        { type: 'approval/policy', seq: 4, data: { policy: 'ask' } },
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
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({
        header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events],
      }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('restart-session', message)))
      expect(first.prompts).toBe(1)
      const initialBinding = await sidecar.readLatestBinding('restart-session' as never)
      expect(initialBinding?.status === 'ok' ? initialBinding.binding.dshCommittedSeq : undefined).toBe(2)
      const second = { starts: 0, prompts: 0, restores: 0 }
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: continuation }]
      const liveSession = {
        header: { cwd: os.tmpdir() },
        inheritedEventCount: 0,
        events,
        snapshotEvents: () => [...events],
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
        { type: 'sandbox/mode', seq: 5, data: { mode: 'danger-full-access' } },
      ])
      expect(events.filter(event => event.type === 'approval/policy')).toEqual([
        { type: 'approval/policy', seq: 6, data: { policy: 'ask' } },
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
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({
        header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events],
      }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('continuation', firstMessage)))
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: secondMessage }]
      const second = { starts: 0, prompts: 0, restores: 0 }
      const restarted = new AcpProfileAdapter('test', profile, seam(), () => ({
        header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events],
      }), ledgerFor(sidecar), undefined, runtimeFactory(second), sidecar)
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
      const initial = new AcpProfileAdapter('test', profile, seam(), () => ({
        header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events],
      }), ledgerFor(sidecar), undefined, runtimeFactory(first), sidecar)
      await drain(initial.stream(request('load-session', message)))
      const second = { starts: 0, prompts: 0, restores: 0 }
      events = [...events, { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: continuation }]
      const loaded = new AcpProfileAdapter('test', profile, seam(), () => ({
        header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events],
      }), ledgerFor(sidecar), undefined, () => ({
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
        () => ({ header: { cwd: os.tmpdir() }, inheritedEventCount: 0, snapshotEvents: () => [...events] }),
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

      const failure = await drain(adapter.stream(request('auth-rejected', message))).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(LlmError)
      expect(failure).toMatchObject({ code: 'ACP_AUTH_REQUIRED' })
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


describe('runtime failure and host disposal ownership', () => {
  it.each(['recovery', 'outdated', 'read-error'])('closes initialized runtimes on %s gates and removes their cache entry', async gate => {
    const initialize = vi.fn(async () => {}), close = vi.fn(async () => {})
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
    const factory = vi.fn(() => ({ initialize, close, prompt, start: async () => {} }))
    const sidecar = {
      readRecoveryState: async () => {
        if (gate === 'read-error') throw new Error('read failed')
        return gate === 'recovery' ? { kind: 'reconnect-required' } : undefined
      },
      readLatestBinding: async () => gate === 'outdated' ? { status: 'outdated' } : undefined,
      writeRecoveryState: async () => {},
    } as unknown as AcpSidecar
    const message = user('hello')
    const subject = new AcpProfileAdapter('test', profile, seam(), () => session(message), new Ledger(), undefined, factory, sidecar)
    for (let i = 0; i < 2; i++) await expect(drain(subject.stream(request('gate', message)))).rejects.toThrow()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(prompt).not.toHaveBeenCalled()
    await subject.close()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it.each(['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'legacy'])('blocks incompatible %s environment identity after restart without rewriting old bindings', async key => {
    const { sidecar, root } = sidecarAt()
    const message = user('first')
    const initial = new AcpProfileAdapter('test', profile, seam(), () => session(message), ledgerFor(sidecar), undefined, runtimeFactory({ starts: 0, prompts: 0, restores: 0 }), sidecar)
    let restarted: AcpProfileAdapter | undefined
    try {
      vi.stubEnv(key === 'legacy' ? 'HOME' : key, '/test/home-a')
      await drain(initial.stream(request('drift', message)))
      await initial.close()
      const lookup = await sidecar.readLatestBinding('drift' as never)
      if (lookup?.status !== 'ok') throw new Error('missing binding')
      expect(lookup.binding.launchFingerprint).toEqual(acpLaunchFingerprint({ profileId: 'test', config: profile(), descriptor: undefined }))
      if (key === 'legacy') {
        // Old releases fingerprinted only explicit config.env, losing inherited HOME.
        await sidecar.append('drift' as never, { kind: 'binding', data: {
          ...lookup.binding,
          launchFingerprint: acpLaunchFingerprint({ profileId: 'test', config: profile(), descriptor: undefined, env: {} }),
        } })
      } else vi.stubEnv(key, '/test/home-b')
      const saved = await sidecar.readLatestBinding('drift' as never)
      const next = user('continue'), records = { starts: 0, prompts: 0, restores: 0 }
      const close = vi.fn(async () => {})
      const factory = () => ({ ...runtimeFactory(records)({}), initialize: async () => {}, close })
      restarted = new AcpProfileAdapter('test', profile, seam(), () => session(next), ledgerFor(sidecar), undefined, factory, sidecar)
      await expect(drain(restarted.stream(request('drift', next)))).rejects.toMatchObject({ code: 'ACP_RECONCILIATION_REQUIRED' })
      expect(records).toEqual({ starts: 0, prompts: 0, restores: 0 })
      expect(close).toHaveBeenCalledOnce()
      expect((await sidecar.readRecoveryState('drift' as never))?.cause).toBe('profile-changed')
      expect(await sidecar.readLatestBinding('drift' as never)).toEqual(saved)
    } finally {
      vi.unstubAllEnvs(); await initial.close(); await restarted?.close(); await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps normal turns and unrelated jobs live, releasing only the disposed session incarnation', async () => {
    const { sidecar, root } = sidecarAt()
    const message = user('first')
    let current = { ...session(message), id: 'owned' }
    const other = { ...session(message), id: 'other' }
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const records = { starts: 0, prompts: 0, restores: 0 }
    const factory = () => { const close = vi.fn(async () => {}); closes.push(close); return { ...runtimeFactory(records)({}), close } }
    const subject = new AcpProfileAdapter('test', profile, seam(), id => id === 'owned' ? current : other, ledgerFor(sidecar), undefined, factory, sidecar)
    try {
      await drain(subject.stream(request('owned', message)))
      const next = user('second')
      current.events.push({ type: 'step/start', seq: 3, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 4, data: next })
      await drain(subject.stream(request('owned', next)))
      await drain(subject.stream(request('other', message)))
      expect(closes).toHaveLength(2)
      expect(closes.every(close => close.mock.calls.length === 0)).toBe(true)
      const old = current
      await subject.disposeSession(old)
      expect(closes[0]).toHaveBeenCalledOnce()
      expect(closes[1]).not.toHaveBeenCalled()
      const resumed = user('resumed')
      current = { ...session(resumed), id: 'owned' }
      await drain(subject.stream(request('owned', resumed)))
      await subject.disposeSession(old)
      expect(closes[2]).not.toHaveBeenCalled()
      await subject.disposeSession(current)
      expect(closes[2]).toHaveBeenCalledOnce()
      expect((await sidecar.readLatestBinding('owned' as never))?.status).toBe('ok')
    } finally { await subject.close(); await sidecar.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})


it('does not resurrect an explicitly retried runtime after its host session is disposed', async () => {
  const { sidecar, root } = sidecarAt()
  const message = user('original'), live = { ...session(message), id: 'retry-disposed' }
  const records = { starts: 0, prompts: 0, restores: 0 }
  const initial = new AcpProfileAdapter('test', profile, seam(), () => live, ledgerFor(sidecar), undefined, runtimeFactory(records), sidecar)
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const close = vi.fn(async () => {})
  const subject = new AcpProfileAdapter('test', profile, seam(), () => live, ledgerFor(sidecar), undefined, () => ({
    ...runtimeFactory(records)({}), close, restore: async () => { entered.resolve(); await finish.promise; return 'resumed' },
  }), sidecar)
  try {
    await drain(initial.stream(request(live.id, message)))
    await initial.close()
    const retry = subject.retryOriginal(live.id)
    const rejected = expect(retry).rejects.toThrow('disposed during recovery')
    await entered.promise
    await subject.disposeSession(live)
    expect(close).toHaveBeenCalledOnce()
    finish.resolve()
    await rejected
    await subject.close()
    expect(close).toHaveBeenCalledOnce()
    expect((await sidecar.readLatestBinding(live.id as never))?.status).toBe('ok')
  } finally { finish.resolve(); await initial.close(); await subject.close(); await sidecar.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

it('does not evict a replacement runtime when an older initialization fails late', async () => {
  const { sidecar, root } = sidecarAt()
  const first = user('first'), second = user('second')
  let live = { ...session(first), id: 'same-id' }
  const entered = Promise.withResolvers<void>(), fail = Promise.withResolvers<void>()
  const oldClose = vi.fn(async () => {}), newClose = vi.fn(async () => {})
  let created = 0
  const records = { starts: 0, prompts: 0, restores: 0 }
  const subject = new AcpProfileAdapter('test', profile, seam(), () => live, ledgerFor(sidecar), undefined, () => ({
    ...runtimeFactory(records)({}),
    ...(created++ === 0 ? {
      initialize: async () => { entered.resolve(); await fail.promise; throw new Error('old initialization failed') }, close: oldClose,
    } : { initialize: async () => {}, close: newClose }),
  }), sidecar)
  try {
    const pending = drain(subject.stream(request(live.id, first)))
    const rejected = expect(pending).rejects.toThrow('old initialization failed')
    await entered.promise
    await subject.disposeSession(live)
    live = { ...session(second), id: live.id }
    await drain(subject.stream(request(live.id, second)))
    fail.resolve()
    await rejected
    expect(oldClose).toHaveBeenCalledOnce()
    expect(newClose).not.toHaveBeenCalled()
    await subject.disposeSession(live)
    expect(newClose).toHaveBeenCalledOnce()
  } finally { fail.resolve(); await subject.close(); await sidecar.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})
