import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpAgentSessionSnapshotView, AcpRecoveryView } from '../../../src/contract/remote.ts'

const snapshot = (): AcpAgentSessionSnapshotView => ({
  sessionId: 'session',
  profileId: 'kimi',
  freshness: 'live',
  editable: false,
  configOptions: [],
  modes: [{ id: 'plan', name: 'Plan' }],
  currentModeId: 'plan',
  contextUsage: null,
  note: null,
})

function setup() {
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
  const service = new AcpRemoteService(new Context(), {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    resolveLiveAgent: () => undefined,
    backendFacts: {
      readBindingProvider: async () => (bound ? 'acp-kimi' : undefined),
      peekHeaderProvider: async () => undefined,
      hasLiveAgent: () => true,
    },
    ownedSessionReadGate: async (id) => id === 'session',
    recoveryStateStore: { read: readRecovery },
    agentSessionControl: () => ({ agentSessionSnapshot: read, setAgentSessionOption: async () => current }),
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
