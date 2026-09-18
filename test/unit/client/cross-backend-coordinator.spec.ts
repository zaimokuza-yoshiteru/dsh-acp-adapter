import { describe, expect, it, vi } from 'vitest'
import {
  CrossBackendCoordinator,
  shouldConfirmBackendTransition,
} from '../../../src/client/coordinator/cross-backend-coordinator.ts'

type Selection = { provider: string; model: string; reasoningEffort?: string }
const owns = (provider: string | undefined): boolean => provider?.startsWith('acp-') === true
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
  }
}

function fixture(options: {
  sessionId?: string
  row?: { blank: boolean; cwd?: string | null }
  projection?: { lastUsed: Selection | null; next: Selection | null }
} = {}) {
  const sessionId = options.sessionId ?? 'session-1'
  const projection = observable(options.projection ?? {
    lastUsed: { provider: 'native', model: 'model-a' },
    next: { provider: 'native', model: 'model-a' },
  })
  const list = observable({
    byId: { [sessionId]: {
      id: sessionId,
      blank: options.row?.blank ?? false,
      cwd: options.row?.cwd === null ? undefined : options.row?.cwd ?? '/tmp',
    } },
  })
  const bindings = new Map([[sessionId, { session: { projections: { faceOf: () => projection } } }]])
  const sessionBinding = (id: string) => bindings.get(id)
  const sessions = {
    list,
    binding: sessionBinding,
    create: vi.fn(async () => 'destination'),
    open: vi.fn(),
  }
  const remote = {
    session: {
      selectModel: vi.fn(async (): Promise<{ ok: boolean; error?: { message: string }; value?: unknown }> => ({ ok: true })),
    },
  }
  const modelDirectories = vi.fn(() => { throw new Error('modelDirectories must not be read') })
  const ctx = {
    uiWorkspace: { openSession: sessions.open },
    get(name: string) {
      if (name === 'sessions') return sessions
      if (name === 'modelDirectories') return { directoryFor: modelDirectories }
      if (name === 'workspaces') return { list: observable({ items: [] }) }
      return undefined
    },
    remote,
  } as never
  return { ctx, remote, modelDirectories, sessions, bindings, list, projection, coordinator: new CrossBackendCoordinator(ctx, owns) }
}

describe('cross-backend coordinator', () => {
  it('keeps native-to-native selection entirely outside the ACP path', () => {
    expect(shouldConfirmBackendTransition({
      lastUsed: { provider: 'native-a', model: 'a' },
      next: { provider: 'native-b', model: 'b' },
      blank: false,
    }, owns)).toBe(false)
  })

  it('returns an identity-stable external snapshot', () => {
    const f = fixture()
    expect(f.coordinator.getSnapshot()).toBe(f.coordinator.getSnapshot())
  })

  it('adopts ACP directly for a blank session and does not open a modal', () => {
    const f = fixture({ row: { blank: true }, projection: { lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } } })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('keeps same-profile ACP model changes in the current session', () => {
    const f = fixture({ projection: {
      lastUsed: { provider: 'acp-codex', model: 'old' },
      next: { provider: 'acp-codex', model: 'new' },
    } })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('cancels a later cross-profile switch back to the latest visible selection', async () => {
    const f = fixture({ projection: {
      lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      next: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
    } })
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      next: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'medium' },
    })
    f.projection.set({
      lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      next: { provider: 'acp-devin', model: 'Devin' },
    })
    await settle()
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSelection).toEqual({
      provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'medium',
    })
    await f.coordinator.cancel()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1', provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'medium',
    })
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('restores the source before exposing one pending decision and keeps it across navigation', async () => {
    const f = fixture({ projection: {
      lastUsed: { provider: 'native', model: 'old' },
      next: { provider: 'acp-codex', model: 'new' },
    } })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    await settle()
    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.ticket.sourceSessionId).toBe('session-1')
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1', provider: 'native', model: 'old',
    })
    f.list.set({
      byId: { 'session-2': { id: 'session-2', blank: true, cwd: '/tmp' } },
    })
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('session-1')
    stop()
  })

  it('does not read modelDirectories while observing a native or ACP transition', () => {
    const f = fixture({ projection: {
      lastUsed: { provider: 'native', model: 'old' },
      next: { provider: 'acp-codex', model: 'new' },
    } })
    const stop = f.coordinator.start()
    expect(f.modelDirectories).not.toHaveBeenCalled()
    stop()
  })

  it('restores a no-location transition before exposing a non-confirmable decision', async () => {
    const f = fixture({ row: { blank: false, cwd: null }, projection: {
      lastUsed: { provider: 'native', model: 'old' },
      next: { provider: 'acp-codex', model: 'new' },
    } })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.confirmable).toBe(false)
    await f.coordinator.confirm()
    expect(f.sessions.create).not.toHaveBeenCalled()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1', provider: 'native', model: 'old',
    })
    stop()
  })

  it('does not leave a second decision after a failed source rollback', async () => {
    const f = fixture({ projection: {
      lastUsed: { provider: 'native', model: 'old' },
      next: { provider: 'acp-codex', model: 'new' },
    } })
    const selectModel = f.remote.session.selectModel
    selectModel.mockResolvedValueOnce({ ok: false, error: { message: 'rollback failed' } })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.error).toBe('rollback failed')
    expect(selectModel).toHaveBeenCalledTimes(1)
    stop()
  })

  it('observes a retained sidebar independently and queues simultaneous decisions without mixing their sources', async () => {
    const f = fixture()
    const child = observable({ lastUsed: { provider: 'native', model: 'child-old' }, next: { provider: 'native', model: 'child-old' } })
    f.bindings.set('child', { session: { projections: { faceOf: () => child } } })
    f.list.set({ byId: { ...f.list.getSnapshot().byId, child: { id: 'child', blank: false, cwd: '/child' } } })
    const stop = f.coordinator.start()
    child.set({ lastUsed: { provider: 'native', model: 'child-old' }, next: { provider: 'acp-devin', model: 'child-new' } })
    f.projection.set({ lastUsed: { provider: 'native', model: 'model-a' }, next: { provider: 'acp-codex', model: 'parent-new' } })
    await settle()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({ sessionId: 'child', provider: 'native', model: 'child-old' })
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({ sessionId: 'session-1', provider: 'native', model: 'model-a' })
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('child')
    await f.coordinator.cancel()
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('session-1')
    await f.coordinator.confirm()
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('does not reopen a released sidebar or publish a late decision from its old binding', async () => {
    const f = fixture()
    let restore!: (value: { ok: boolean }) => void
    f.remote.session.selectModel.mockImplementationOnce(() => new Promise(resolve => { restore = resolve }))
    const stop = f.coordinator.start()
    f.projection.set({ lastUsed: { provider: 'native', model: 'model-a' }, next: { provider: 'acp-codex', model: 'new' } })
    f.bindings.clear()
    f.list.set({ ...f.list.getSnapshot() })
    restore({ ok: true })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    f.projection.set({ lastUsed: { provider: 'native', model: 'model-a' }, next: { provider: 'acp-devin', model: 'another' } })
    expect(f.remote.session.selectModel).toHaveBeenCalledTimes(1)
    stop()
  })
})
