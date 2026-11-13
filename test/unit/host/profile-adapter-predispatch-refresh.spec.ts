import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { AcpHostContinuity } from '../../../src/host/composition/host-continuity.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

type Refresh = 'directory' | 'key' | 'lease'
interface WireRequest {
  readonly method: string
  readonly sessionId?: string
}

async function harness(refresh: Refresh = 'directory') {
  const root = mkdtempSync(join(tmpdir(), 'acp-predispatch-refresh-'))
  const wirePath = join(root, 'wire.jsonl')
  const sidecar = createAcpSidecar({ root: join(root, 'sidecar') })
  let stale = false
  let promptsEntered = 0
  let leaseCount = 0
  let armed = true
  const script = `
    let session;
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line), reply = result => send({ jsonrpc: '2.0', id: request.id, result });
      require('node:fs').appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ method: request.method, sessionId: request.params?.sessionId }) + '\\n');
      if (request.method === 'initialize') reply({ protocolVersion: 1, agentInfo: { name: 'refresh-fixture', version: '1' }, agentCapabilities: { sessionCapabilities: { resume: {} } } });
      if (request.method === 'session/new') { session = 'original-' + process.pid; reply({ sessionId: session }); }
      if (request.method === 'session/resume') { session = request.params.sessionId; reply({}); }
      if (request.method === 'session/prompt') {
        if (request.params.prompt.some(block => block.text === 'crash after dispatch')) process.exit(7);
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: session } } } });
        reply({ stopReason: 'end_turn' });
      }
    });`
  const argv = [process.execPath, '-e', script]
  const config = { name: 'Refresh fixture', command: argv[0]!, args: argv.slice(1), env: {} }
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  const session = withSessionFacts({
    header: { cwd: root },
    inheritedEventCount: 0,
    snapshotEvents: () => [...events],
  })
  const dispatches: DispatchRecord[] = []
  let invalidateLease = (): void => undefined
  const continuity = new AcpHostContinuity()
  const adapters: AcpProfileAdapter[] = []
  const sidecars = [sidecar]
  const subprocess = (await sharedTestSubprocess()).seam
  const createAdapter = (store = sidecar): AcpProfileAdapter => {
    const adapter = new AcpProfileAdapter(
      'refresh-fixture',
      () => config,
      { ok: true, seam: subprocess },
      () => session,
      {
        begin: async (record) => {
          dispatches.push(record)
          await store.beginDispatch(record)
        },
        settle: (id, key) => store.settleDispatch(id as never, key),
        read: (id, key) => store.readDispatch(id as never, key),
      },
      undefined,
      (options) => {
        const runtime = new AcpSessionRuntime({
          ...options,
          prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
          mcpKey: () => (refresh === 'key' && stale ? 'new-key' : 'original-key'),
          createMcpLease: async () => {
            const first = ++leaseCount === 1
            const controller = new AbortController()
            if (first) invalidateLease = () => controller.abort()
            return {
              signal: controller.signal,
              servers: [],
              needsRefresh: () => first && refresh === 'directory' && stale,
              beginPrompt() {},
              endPrompt() {},
              permission: () => undefined,
              async close() {},
            }
          },
        })
        const prompt = runtime.prompt.bind(runtime)
        runtime.prompt = (...args) => {
          // Invalidate after the profile's restore/configuration/WAL, before RPC admission.
          if (++promptsEntered === 2 && armed) {
            stale = true
            if (refresh === 'lease') invalidateLease()
          }
          return prompt(...args)
        }
        return runtime
      },
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      continuity,
    )
    adapters.push(adapter)
    return adapter
  }
  const adapter = createAdapter()
  const request = (text: string, signal?: AbortSignal) => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    events.push({ type: 'step/start', seq: events.length, data: { turn: events.length + 1, step: 0 } })
    events.push({ type: 'user/message', seq: events.length, data: message })
    return markAgentLoopRequest({
      provider: 'acp-refresh-fixture',
      model: ACP_CURRENT_CONFIG_MODEL_ID,
      sessionId: 'refresh-session' as never,
      messages: [message],
      ...(signal === undefined ? {} : { signal }),
    })
  }
  const wire = (): WireRequest[] =>
    readFileSync(wirePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as WireRequest)
  return {
    adapter,
    sidecar,
    dispatches,
    request,
    wire,
    replacement: () => {
      const store = createAcpSidecar({ root: join(root, 'sidecar') })
      sidecars.push(store)
      return { sidecar: store, adapter: createAdapter(store) }
    },
    disarm: () => {
      armed = false
    },
    async close() {
      try {
        await Promise.all(adapters.map((owner) => owner.close()))
        await continuity.close()
      } finally {
        await Promise.all(sidecars.map((store) => store.dispose()))
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* consume */
  }
}

const sessionId = 'refresh-session' as never

describe('known pre-dispatch connection refresh', () => {
  it.each<Refresh>(['directory', 'key', 'lease'])(
    'retries the same input against its original binding after %s invalidation',
    async (refresh) => {
      const h = await harness(refresh)
      try {
        await drain(h.adapter.stream(h.request('first')))
        const binding = await h.sidecar.readLatestBinding(sessionId)
        expect(binding?.status).toBe('ok')
        const original = binding?.status === 'ok' ? binding.binding.agentSessionId : undefined
        const second = h.request('continue original conversation')
        await expect(drain(h.adapter.stream(second))).rejects.toMatchObject({ code: 'ACP_PROMPT_NOT_DISPATCHED' })
        expect(h.wire().filter((r) => r.method === 'session/new')).toHaveLength(1)
        expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(1)
        expect(await h.sidecar.readLatestBinding(sessionId)).toEqual(binding)
        expect(await h.sidecar.readDispatch(sessionId, h.dispatches.at(-1)!.key)).toBeUndefined()
        expect((await h.sidecar.readRecoveryState(sessionId))?.kind).not.toBe('outcome-unknown')
        expect(h.adapter.localSettlementStatus(sessionId)).toBeUndefined()

        // No explicit retryOriginal, changed input ID, or blank-session recovery.
        await drain(h.adapter.stream(second))
        expect(h.wire().filter((r) => r.method === 'session/new')).toHaveLength(1)
        expect(h.wire().filter((r) => r.method === 'session/resume')).toEqual([
          { method: 'session/resume', sessionId: original },
        ])
        expect(h.wire().filter((r) => r.method === 'session/prompt')).toEqual([
          { method: 'session/prompt', sessionId: original },
          { method: 'session/prompt', sessionId: original },
        ])
      } finally {
        await h.close()
      }
    },
  )

  it('retains failed local cleanup and gates new dispatch until the exact guard is cleared', async () => {
    const h = await harness()
    const clear = h.sidecar.clearDispatch.bind(h.sidecar)
    let failStorage = true
    const clearSpy = vi.spyOn(h.sidecar, 'clearDispatch').mockImplementation(async (id, key) => {
      if (failStorage) throw new Error('controlled storage outage')
      await clear(id, key)
    })
    try {
      await drain(h.adapter.stream(h.request('first')))
      const binding = await h.sidecar.readLatestBinding(sessionId)
      const second = h.request('continue original conversation')
      await expect(drain(h.adapter.stream(second))).rejects.toMatchObject({ code: 'ACP_LOCAL_SETTLEMENT_FAILED' })
      expect(h.adapter.localSettlementStatus(sessionId)).toBe('storage-error')
      expect(await h.sidecar.readDispatch(sessionId, h.dispatches.at(-1)!.key)).toMatchObject({
        state: 'dispatch-uncertain',
      })
      expect(await h.sidecar.readLatestBinding(sessionId)).toEqual(binding)
      expect((await h.sidecar.readRecoveryState(sessionId))?.kind).not.toBe('outcome-unknown')
      const abort = new AbortController()
      const retry = drain(h.adapter.stream({ ...second, signal: abort.signal }))
      await vi.waitFor(() => expect(clearSpy.mock.calls.length).toBeGreaterThan(3))
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(1)
      abort.abort(new Error('stop waiting for local storage'))
      await expect(retry).rejects.toThrow('stop waiting for local storage')
      failStorage = false
      await drain(h.adapter.stream(second))
      expect(h.adapter.localSettlementStatus(sessionId)).toBeUndefined()
      expect(h.wire().filter((r) => r.method === 'session/new')).toHaveLength(1)
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(2)
    } finally {
      failStorage = false
      clearSpy.mockRestore()
      await h.close()
    }
  })

  it('keeps an actual post-dispatch transport failure behind the unknown-outcome gate', async () => {
    const h = await harness()
    h.disarm()
    try {
      await drain(h.adapter.stream(h.request('first')))
      const second = h.request('crash after dispatch')
      await expect(drain(h.adapter.stream(second))).rejects.toMatchObject({ code: 'ACP_CRASH' })
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(2)
      expect(await h.sidecar.readRecoveryState(sessionId)).toMatchObject({ kind: 'outcome-unknown' })
      await expect(drain(h.adapter.stream(second))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  it('waits for an entered clear on unload and lets only the replacement sink finish its retained task', async () => {
    const h = await harness()
    const oldEntered = Promise.withResolvers<void>()
    const releaseOld = Promise.withResolvers<void>()
    const newEntered = Promise.withResolvers<void>()
    const releaseNew = Promise.withResolvers<void>()
    const oldClear = vi.spyOn(h.sidecar, 'clearDispatch').mockImplementation(async () => {
      oldEntered.resolve()
      await releaseOld.promise
      throw new Error('old storage owner cannot finish this write')
    })
    let replacement: ReturnType<typeof h.replacement> | undefined
    let newClear: ReturnType<typeof vi.spyOn> | undefined
    let oldTurn: Promise<unknown> | undefined
    let newTurn: Promise<unknown> | undefined
    let closing: Promise<void> | undefined
    try {
      await drain(h.adapter.stream(h.request('first')))
      const binding = await h.sidecar.readLatestBinding(sessionId)
      const original = binding?.status === 'ok' ? binding.binding.agentSessionId : undefined
      const second = h.request('continue original conversation')
      oldTurn = drain(h.adapter.stream(second)).catch((error: unknown) => ({ error }))
      await oldEntered.promise
      let oldClosed = false
      closing = h.adapter.close().then(() => {
        oldClosed = true
      })
      replacement = h.replacement()
      const clear = replacement.sidecar.clearDispatch.bind(replacement.sidecar)
      newClear = vi.spyOn(replacement.sidecar, 'clearDispatch').mockImplementation(async (id, key) => {
        newEntered.resolve()
        await releaseNew.promise
        await clear(id, key)
      })
      newTurn = drain(replacement.adapter.stream(second))
      void newTurn.catch(() => undefined)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(oldClosed).toBe(false)
      expect(newClear).not.toHaveBeenCalled()
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(1)

      releaseOld.resolve()
      await newEntered.promise
      await closing
      expect(await oldTurn).toHaveProperty('error')
      expect(oldClosed).toBe(true)
      const oldCallCount = oldClear.mock.calls.length
      await h.sidecar.dispose()
      expect(await replacement.sidecar.readLatestBinding(sessionId)).toEqual(binding)
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(1)

      releaseNew.resolve()
      await newTurn
      expect(oldClear).toHaveBeenCalledTimes(oldCallCount)
      expect(newClear).toHaveBeenCalledTimes(1)
      expect(replacement.adapter.localSettlementStatus(sessionId)).toBeUndefined()
      expect(h.wire().filter((r) => r.method === 'session/new')).toHaveLength(1)
      expect(h.wire().filter((r) => r.method === 'session/resume')).toEqual([
        { method: 'session/resume', sessionId: original },
      ])
      expect(h.wire().filter((r) => r.method === 'session/prompt')).toHaveLength(2)
    } finally {
      releaseOld.resolve()
      releaseNew.resolve()
      oldClear.mockRestore()
      newClear?.mockRestore()
      await Promise.allSettled([oldTurn, newTurn, closing])
      await h.close()
    }
  })
})
