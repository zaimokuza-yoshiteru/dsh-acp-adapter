import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AcpRemoteService, type AcpAgentSessionControlLike } from '../../../src/remote/service.ts'
import type { AcpAgentSessionSnapshotView, AcpRecoveryView } from '../../../src/contract/remote.ts'

const snapshot = (): AcpAgentSessionSnapshotView => ({
  sessionId: 'session',
  profileId: 'generic',
  freshness: 'live',
  editable: false,
  configOptions: [],
  modes: [{ id: 'plan', name: 'Plan' }],
  currentModeId: 'plan',
  contextUsage: null,
  note: null,
})

function setup(
  ctx = new Context(),
  firstTurn?: Pick<AcpAgentSessionControlLike, 'firstTurnControls' | 'setFirstTurnOption'>,
) {
  let bound = false
  let current = snapshot()
  let recovery: AcpRecoveryView = {
    dshSessionId: 'session',
    kind: 'healthy',
    cause: null,
    detail: null,
    provider: null,
    acpSessionId: null,
    generation: null,
    interruptedTurnId: null,
    lastAttemptAt: null,
    lastUserAction: null,
    updatedAt: 1,
  }
  const listeners = new Set<() => void>()
  const read = vi.fn(async () => current)
  const readRecovery = vi.fn(async () => recovery)
  const service = new AcpRemoteService(ctx, {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    backendFacts: {
      readBindingProvider: async () => (bound ? 'acp-generic' : undefined),
      peekHeaderProvider: async () => undefined,
      hasLiveAgent: () => true,
    },
    ownedSessionReadGate: async (id) => id === 'session',
    recoveryStateStore: { read: readRecovery },
    agentSessionControl: () => ({
      ...firstTurn,
      agentSessionSnapshot: read,
      setAgentSessionOption: async () => current,
    }),
    agentSessionChanges: {
      canRead: (id) => id === 'session',
      subscribe: (_id, notify) => {
        listeners.add(notify)
        return () => {
          listeners.delete(notify)
        }
      },
    },
  })
  return {
    service,
    read,
    readRecovery,
    listeners,
    bind: () => {
      bound = true
    },
    update: (patch: Partial<AcpAgentSessionSnapshotView>) => {
      current = { ...current, ...patch }
      for (const notify of listeners) notify()
    },
    updateRecovery: (next: AcpRecoveryView) => {
      recovery = next
      for (const notify of listeners) notify()
    },
    notify: () => {
      for (const notify of listeners) notify()
    },
  }
}

describe('Agent controls snapshot stream', () => {
  it('waits for binding, follows changes, and unsubscribes a cancelled pending read', async () => {
    const state = setup()
    const abort = new AbortController()
    const stream = state.service.agentSessionFollow('session', abort.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual({ type: 'opened', snapshot: null })
    expect(state.read).not.toHaveBeenCalled()
    const first = stream.next()
    state.bind()
    state.update({})
    expect((await first).value).toMatchObject({ type: 'changed', snapshot: { currentModeId: 'plan', editable: false } })
    const changed = stream.next()
    state.update({ editable: true, currentModeId: 'ask' })
    expect((await changed).value).toMatchObject({ snapshot: { editable: true, currentModeId: 'ask' } })
    const pending = stream.next()
    abort.abort()
    expect((await pending).done).toBe(true)
    expect(state.listeners.size).toBe(0)
  })

  it('does not lose an update racing the opening read; reconnect uses the latest baseline', async () => {
    const state = setup()
    state.bind()
    const opened = Promise.withResolvers<AcpAgentSessionSnapshotView>()
    state.read.mockImplementationOnce(() => opened.promise)
    const abort = new AbortController()
    const stream = state.service.agentSessionFollow('session', abort.signal)[Symbol.asyncIterator]()
    const first = stream.next()
    await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce())
    state.update({ currentModeId: 'ask' })
    opened.resolve(snapshot())
    expect((await first).value).toMatchObject({ type: 'opened', snapshot: { currentModeId: 'plan' } })
    expect((await stream.next()).value).toMatchObject({ type: 'changed', snapshot: { currentModeId: 'ask' } })
    abort.abort()
    await stream.next()
    const reconnect = new AbortController()
    const second = state.service.agentSessionFollow('session', reconnect.signal)[Symbol.asyncIterator]()
    expect((await second.next()).value).toMatchObject({ type: 'opened', snapshot: { currentModeId: 'ask' } })
    reconnect.abort()
    await second.next()
    expect(state.listeners.size).toBe(0)
  })

  it('withholds the preselection receipt and reconnect frame after a failed checkpoint, then retries the buffered setting', async () => {
    const ctx = new Context()
    const release = Promise.withResolvers<void>()
    const bothEntered = Promise.withResolvers<void>()
    const target = { sessionId: 'session', provider: 'acp-generic', preselectionRevision: 0 }
    const choice = { kind: 'mode', id: 'plan' } as const
    const chosen = { ...snapshot(), preselection: true, preselectionRevision: 1, preselected: [choice] } as const
    const abort = new AbortController()
    try {
      await ctx.plugin(SessionStore)
      ctx.sessions.create(SessionId(target.sessionId))
      let entries = 0
      const failing = ctx.on('session/flush', async () => {
        if (++entries === 2) bothEntered.resolve()
        await release.promise
        throw new Error('storage is offline')
      })
      const state = setup(ctx, { firstTurnControls: () => chosen, setFirstTurnOption: () => chosen })
      const changed = state.service.setAgentSessionOption(target, choice)
      const stream = state.service.agentSessionFollow(target, abort.signal)[Symbol.asyncIterator]()
      const results = Promise.allSettled([changed, stream.next()])
      await bothEntered.promise
      const stillPending = Symbol()
      expect(await Promise.race([results, Promise.resolve(stillPending)])).toBe(stillPending)
      release.resolve()
      for (const result of await results)
        expect(result).toMatchObject({ status: 'rejected', reason: { code: 'dsh-acp/resume-conflict' } })
      failing()
      const flushed = vi.fn()
      ctx.on('session/flush', flushed)
      const recovered = state.service.agentSessionFollow(target, abort.signal)[Symbol.asyncIterator]()
      expect((await recovered.next()).value).toMatchObject({ type: 'opened', snapshot: chosen })
      expect(flushed).toHaveBeenCalledOnce()
      abort.abort()
      await recovered.next()
    } finally {
      release.resolve()
      abort.abort()
      await ctx.fiber.dispose()
    }
  })

  it('coalesces redundant updates, rejects unknown sessions, and surfaces real read failures', async () => {
    const state = setup()
    const denied = state.service.agentSessionFollow('foreign', new AbortController().signal)[Symbol.asyncIterator]()
    await expect(denied.next()).rejects.toThrow('not authorized')
    expect(state.listeners.size).toBe(0)
    state.bind()
    const abort = new AbortController()
    const stream = state.service.agentSessionFollow('session', abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    state.update({})
    await vi.waitFor(() => expect(state.read).toHaveBeenCalledTimes(2))
    state.update({ currentModeId: 'ask' })
    expect((await pending).value).toMatchObject({ snapshot: { currentModeId: 'ask' } })
    state.read.mockRejectedValueOnce(new Error('fixture storage failure'))
    const failed = stream.next()
    state.update({})
    await expect(failed).rejects.toThrow('fixture storage failure')
    expect(state.listeners.size).toBe(0)
  })
})

describe('recovery facts stream', () => {
  it('publishes local status changes even when the Agent controls snapshot is unchanged', async () => {
    const state = setup()
    const abort = new AbortController()
    const stream = state.service.recoveryFollow('session', abort.signal)[Symbol.asyncIterator]()
    const opened = await stream.next()
    expect(opened.value).toMatchObject({ type: 'opened', snapshot: { kind: 'healthy' } })

    const changed = stream.next()
    state.updateRecovery({ ...opened.value!.snapshot, localStatus: 'finishing-tools' })
    expect((await changed).value).toMatchObject({
      type: 'changed',
      snapshot: { kind: 'healthy', localStatus: 'finishing-tools', updatedAt: 1 },
    })
    expect(state.read).not.toHaveBeenCalled()

    const nextChange = stream.next()
    state.notify()
    await vi.waitFor(() => expect(state.readRecovery).toHaveBeenCalledTimes(3))
    state.updateRecovery({ ...opened.value!.snapshot, localStatus: 'saving-results' })
    expect((await nextChange).value).toMatchObject({
      type: 'changed',
      snapshot: { kind: 'healthy', localStatus: 'saving-results', updatedAt: 1 },
    })

    const cleared = stream.next()
    state.updateRecovery(opened.value!.snapshot)
    const clearedFrame = await cleared
    expect(clearedFrame.value).toMatchObject({ type: 'changed', snapshot: { kind: 'healthy', updatedAt: 1 } })
    expect(clearedFrame.value!.snapshot).not.toHaveProperty('localStatus')
    abort.abort()
    await stream.next()
    expect(state.listeners.size).toBe(0)
  })
})
