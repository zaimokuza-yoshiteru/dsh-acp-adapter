import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar, modeIntentBindingKey } from '../../../src/persistence/sidecar.ts'
import { withSessionFacts } from '../../support/session-facts.ts'
import {
  beginFirstTurnIntent,
  confirmsFirstTurnIntent,
  finishFirstTurnIntent,
  firstTurnIntentKey,
  readFirstTurnIntent,
} from '../../../src/client/data/first-turn-intent.ts'

async function fixture(cold = false) {
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
  const changed = vi.fn<(sessionId: string) => void>()
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
  const makeAdapter = () =>
    new AcpProfileAdapter(
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      changed,
    )
  let adapter = makeAdapter()
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
  if (cold) {
    await adapter.close()
    adapter = makeAdapter()
  }
  return {
    adapter,
    runtime,
    sidecar,
    entered,
    finish,
    close,
    changed,
    set,
    session: () => session,
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
  it('releases a disconnected composer’s first-turn guard from a committed cold binding', async () => {
    const key = firstTurnIntentKey('controls', 'acp-test')
    const local = beginFirstTurnIntent(key, 0, { kind: 'mode', id: 'plan' })
    const f = await fixture(true)
    try {
      const snapshot = await f.adapter.agentSessionSnapshot('controls')
      expect(snapshot).toMatchObject({ freshness: 'stale', editable: false, firstPromptCommitted: true })
      expect(confirmsFirstTurnIntent(snapshot, local)).toBe(true)
      finishFirstTurnIntent(key, local)
      expect(readFirstTurnIntent(key)).toBeNull()
      expect(f.runtime.setMode).not.toHaveBeenCalled()
    } finally {
      finishFirstTurnIntent(key, local)
      await f.cleanup()
    }
  })

  it.each(['unchanged', 'withdrawn'] as const)(
    'reports an unconfirmed live permission choice and saves the Agent reply (%s)',
    async (reply) => {
      const f = await fixture()
      const option = {
        type: 'select' as const,
        id: 'permission_mode',
        name: 'Permissions',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'ask', name: 'Ask' },
        ],
      }
      let offered = [option]
      vi.spyOn(f.runtime, 'configOptions', 'get').mockImplementation(() => offered)
      f.set.mockImplementation(async () => {
        if (reply === 'withdrawn') offered = []
      })
      try {
        await expect(
          f.adapter.setAgentSessionOption('controls', { kind: 'config', id: option.id, value: 'ask' }),
        ).rejects.toMatchObject({ code: 'ACP_CONFIG_SYNC_FAILED' })
        expect(f.set).toHaveBeenCalledOnce()
        expect((await f.adapter.agentSessionSnapshot('controls')).configOptions).toEqual(offered)
        const saved = await f.sidecar.readOptionSnapshot('controls' as never)
        expect(saved?.options.map(({ id, value }) => [id, value])).toEqual(
          reply === 'withdrawn' ? [] : [[option.id, 'auto']],
        )
      } finally {
        await f.cleanup()
      }
    },
  )

  it('keeps a pending member mode until the replacement choice is confirmed', async () => {
    const f = await fixture()
    const id = 'controls' as never
    try {
      const bound = await f.sidecar.readLatestBinding(id)
      if (bound?.status !== 'ok') throw new Error('Expected a live fixture binding')
      const pending = { bindingKey: modeIntentBindingKey(bound.binding), modeId: 'plan' }
      await f.sidecar.writeModeIntent(id, pending)
      vi.mocked(f.runtime.setMode!).mockResolvedValueOnce(undefined)
      await expect(f.adapter.setAgentSessionOption(id, { kind: 'mode', id: 'plan' })).rejects.toMatchObject({
        code: 'ACP_CONFIG_SYNC_FAILED',
      })
      expect(await f.sidecar.readModeIntent(id)).toEqual(pending)
      await f.adapter.setAgentSessionOption(id, { kind: 'mode', id: 'plan' })
      expect(await f.sidecar.readModeIntent(id)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  })

  it('allows dormant modes after runtime disposal while keeping its retained Host session read-only during cleanup', async () => {
    const f = await fixture()
    const closeEntered = Promise.withResolvers<void>()
    const closeFinish = Promise.withResolvers<void>()
    f.close.mockImplementation(async () => {
      closeEntered.resolve()
      await closeFinish.promise
    })
    try {
      const disposing = f.adapter.disposeSession(f.session())
      await closeEntered.promise
      expect(await f.adapter.agentSessionSnapshot('controls')).toMatchObject({
        freshness: 'stale',
        editable: false,
        modeWritable: false,
      })
      const closeNotifications = f.changed.mock.calls.length
      // A second cleanup sees no registered runtime, but must not reopen
      // controls while the first cleanup still owns the process close.
      await f.adapter.disposeSession(f.session())
      expect(f.changed).toHaveBeenCalledTimes(closeNotifications)
      await expect(f.adapter.setTeamMemberMode('controls', 'plan')).rejects.toMatchObject({
        code: 'ACP_SESSION_OPTIONS_READ_ONLY',
      })
      closeFinish.resolve()
      await disposing
      expect(f.changed).toHaveBeenCalledTimes(closeNotifications + 1)
      expect(await f.adapter.agentSessionSnapshot('controls')).toMatchObject({
        freshness: 'stale',
        modeWritable: true,
      })
      expect(await f.adapter.setTeamMemberMode('controls', 'plan')).toMatchObject({
        freshness: 'stale',
        pendingModeId: 'plan',
      })
      expect((await f.sidecar.readModeIntent('controls' as never))?.modeId).toBe('plan')
      expect(f.runtime.setMode).not.toHaveBeenCalled()
      expect(f.close).toHaveBeenCalledOnce()
    } finally {
      closeFinish.resolve()
      await f.cleanup()
    }
  })

  it('does not save a dormant Team mode for a replacement Host owner after an admitted storage read', async () => {
    const f = await fixture(true)
    const readEntered = Promise.withResolvers<void>()
    const readFinish = Promise.withResolvers<void>()
    const originalRead = f.sidecar.readLatestBinding.bind(f.sidecar)
    const writeIntent = vi.spyOn(f.sidecar, 'writeModeIntent')
    let reads = 0
    vi.spyOn(f.sidecar, 'readLatestBinding').mockImplementation(async (...args) => {
      if (++reads === 1) {
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
      expect(writeIntent).not.toHaveBeenCalled()
      expect(await f.sidecar.readModeIntent('controls' as never)).toBeUndefined()
      expect(f.runtime.setMode).not.toHaveBeenCalled()
    } finally {
      readFinish.resolve()
      await f.cleanup()
    }
  })

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

  it('drains an admitted dormant Team mode write during close while its Host owner remains unchanged', async () => {
    const f = await fixture(true)
    const readEntered = Promise.withResolvers<void>()
    const readFinish = Promise.withResolvers<void>()
    const originalRead = f.sidecar.readLatestBinding.bind(f.sidecar)
    let reads = 0
    vi.spyOn(f.sidecar, 'readLatestBinding').mockImplementation(async (...args) => {
      if (++reads === 1) {
        readEntered.resolve()
        await readFinish.promise
      }
      return await originalRead(...args)
    })
    try {
      const change = f.adapter.setTeamMemberMode('controls', 'plan')
      await readEntered.promise
      let closed = false
      const closing = f.adapter.close().then(() => {
        closed = true
      })
      await expect(f.adapter.setTeamMemberMode('controls', 'code')).rejects.toMatchObject({
        code: 'ACP_SESSION_OPTIONS_READ_ONLY',
      })
      expect(closed).toBe(false)
      readFinish.resolve()
      expect(await change).toMatchObject({ pendingModeId: 'plan' })
      await closing
      expect((await f.sidecar.readModeIntent('controls' as never))?.modeId).toBe('plan')
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
