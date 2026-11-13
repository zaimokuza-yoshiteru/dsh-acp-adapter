import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-control-owner-'))
  const sidecar = createAcpSidecar({ root })
  const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const makeSession = () =>
    withSessionFacts({
      id: 'controls',
      header: { cwd: root },
      inheritedEventCount: 0,
      snapshotEvents: () => [
        { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
        { type: 'user/message', seq: 2, data: message },
      ],
    })
  let session = makeSession()
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let value = true
  let mode = 'code'
  const close = vi.fn(async () => undefined)
  const set = vi.fn(async (_id: string, next: string | boolean) => {
    entered.resolve()
    await finish.promise
    value = Boolean(next)
  })
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'remote-controls',
    get configOptions() {
      return [{ type: 'boolean' as const, id: 'auto_compact', name: 'Auto compact', currentValue: value }]
    },
    get modes() {
      return {
        currentModeId: mode,
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      }
    },
    setMode: vi.fn(async (id) => {
      mode = id
    }),
    start: async () => undefined,
    prompt: async () => ({ stopReason: 'end_turn' }),
    setConfigOption: set,
    close,
  }
  const adapter = new AcpProfileAdapter(
    'test',
    () => ({ name: 'Test', command: 'agent', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    () => session,
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    undefined,
    () => runtime,
    sidecar,
  )
  for await (const _ of adapter.stream(
    markAgentLoopRequest({
      provider: 'acp-test',
      model: ACP_CURRENT_CONFIG_MODEL_ID,
      sessionId: 'controls' as never,
      messages: [message],
    }),
  )) {
    /* Establish a real binding and terminal snapshot before editing controls. */
  }
  return {
    adapter,
    runtime,
    sidecar,
    entered,
    finish,
    close,
    set,
    replaceSession: () => {
      const previous = session
      session = makeSession()
      return previous
    },
    async cleanup() {
      finish.resolve()
      await adapter.close()
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('session control owner lifecycle', () => {
  it('does not dispatch a saved Team mode to the old runtime when its Host owner changes during a storage read', async () => {
    const f = await fixture()
    const readEntered = Promise.withResolvers<void>()
    const readFinish = Promise.withResolvers<void>()
    const originalRead = f.sidecar.readModeIntent.bind(f.sidecar)
    let reads = 0
    vi.spyOn(f.sidecar, 'readModeIntent').mockImplementation(async (...args) => {
      if (++reads === 2) {
        readEntered.resolve()
        await readFinish.promise
      }
      return await originalRead(...args)
    })
    try {
      const change = f.adapter.setTeamMemberMode('controls', 'plan')
      const rejected = expect(change).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      await readEntered.promise
      f.replaceSession()
      readFinish.resolve()
      await rejected
      expect(f.runtime.setMode).not.toHaveBeenCalled()
    } finally {
      readFinish.resolve()
      await f.cleanup()
    }
  })

  it('keeps the runtime and snapshot writer alive until the admitted control finishes during close', async () => {
    const f = await fixture()
    const snapshotEntered = Promise.withResolvers<void>()
    const snapshotFinish = Promise.withResolvers<void>()
    const originalWrite = f.sidecar.writeOptionSnapshot.bind(f.sidecar)
    vi.spyOn(f.sidecar, 'writeOptionSnapshot').mockImplementation(async (...args) => {
      snapshotEntered.resolve()
      await snapshotFinish.promise
      await originalWrite(...args)
    })
    try {
      const active = f.adapter.setAgentSessionOption('controls', { kind: 'config', id: 'auto_compact', value: false })
      await f.entered.promise
      const queued = f.adapter.setAgentSessionOption('controls', { kind: 'config', id: 'auto_compact', value: true })
      const queuedRejection = expect(queued).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      let closed = false
      const closing = f.adapter.close().then(() => {
        closed = true
      })
      await expect(
        f.adapter.setAgentSessionOption('controls', { kind: 'config', id: 'auto_compact', value: true }),
      ).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      expect(f.close).not.toHaveBeenCalled()
      f.finish.resolve()
      await snapshotEntered.promise
      expect(closed).toBe(false)
      expect(f.close).not.toHaveBeenCalled()
      snapshotFinish.resolve()
      await active
      await queuedRejection
      await closing
      expect(f.set).toHaveBeenCalledOnce()
      expect(f.close).toHaveBeenCalledOnce()
      expect((await f.sidecar.readOptionSnapshot('controls' as never))?.options[0]?.value).toBe(false)
    } finally {
      snapshotFinish.resolve()
      await f.cleanup()
    }
  })

  it('retires queued writes with their old Host identity without configuring that runtime for a replacement', async () => {
    const f = await fixture()
    try {
      const active = f.adapter.setAgentSessionOption('controls', { kind: 'config', id: 'auto_compact', value: false })
      const activeRejection = expect(active).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      await f.entered.promise
      const queued = f.adapter.setAgentSessionOption('controls', { kind: 'config', id: 'auto_compact', value: true })
      const queuedRejection = expect(queued).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      const previous = f.replaceSession()
      const disposing = f.adapter.disposeSession(previous)
      const replacement = f.adapter.setAgentSessionOption('controls', {
        kind: 'config',
        id: 'auto_compact',
        value: true,
      })
      const replacementRejection = expect(replacement).rejects.toMatchObject({ code: 'ACP_SESSION_OPTIONS_READ_ONLY' })
      expect(f.close).not.toHaveBeenCalled()
      f.finish.resolve()
      await activeRejection
      await queuedRejection
      await replacementRejection
      await disposing
      expect(f.set).toHaveBeenCalledOnce()
      expect(f.close).toHaveBeenCalledOnce()
    } finally {
      await f.cleanup()
    }
  })
})
