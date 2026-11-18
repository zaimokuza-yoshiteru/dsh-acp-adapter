import { describe, expect, it, vi } from 'vitest'
import { SessionCreateError } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AcpOwnedRoutesView } from '../../../src/contract/remote.ts'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
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
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function fixture(
  options: {
    sessionId?: string
    row?: { blank: boolean; cwd?: string | null; agentPreset?: string }
    livePreset?: string
    projection?: { lastUsed: Selection | null; next: Selection | null }
  } = {},
) {
  const sessionId = options.sessionId ?? 'session-1'
  const projection = observable(
    options.projection ?? {
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'native', model: 'model-a' },
    },
  )
  const list = observable({
    byId: {
      [sessionId]: {
        id: sessionId,
        blank: options.row?.blank ?? false,
        ...(options.row?.agentPreset ? { projectionValues: { agentPreset: options.row.agentPreset } } : {}),
        cwd: options.row?.cwd === null ? undefined : (options.row?.cwd ?? '/tmp'),
      },
    },
  })
  const preset = observable(options.livePreset)
  const bindings = new Map([
    [
      sessionId,
      { session: { projections: { faceOf: (key: string) => (key === 'agentPreset' ? preset : projection) } } },
    ],
  ])
  const sessionBinding = (id: string) => bindings.get(id)
  const main = observable({ retainedBy: { mainView: 1 } })
  const childReadable = observable(true)
  const sessions = {
    list: { subscribe: list.subscribe, getSnapshot: () => ({ ...list.getSnapshot(), phase: 'ready' }) },
    retainInfo: () => main,
    refresh: vi.fn(async () => {}),
    binding: sessionBinding,
    create: vi.fn(async () => 'destination'),
    open: vi.fn(),
  }
  const routes = observable<AcpOwnedRoutesView>({
    providers: ['acp-codex', 'acp-devin'],
    historicalProviders: [] as string[],
  })
  const remote = {
    dshAcp: {
      ownedProviderRoutes: vi.fn(async () => ({ ok: true, value: routes.getSnapshot() })),
      backendOf: vi.fn(
        async (): Promise<{ ok: true; value: { state: 'established'; provider: string; acpBinding?: true } }> => ({
          ok: true,
          value: { state: 'established', provider: 'acp-retired', acpBinding: true },
        }),
      ),
    },
    session: {
      list: vi.fn(
        async (): Promise<{
          ok: boolean
          value: { items: { sessionId: string; blank: boolean; cwd?: string }[] }
          error?: Error
        }> => ({ ok: true, value: { items: [] } }),
      ),
      projections: vi.fn(async () => ({ ok: true, value: null })),
      selectModel: vi.fn(async (): Promise<{ ok: boolean; error?: { message: string }; value?: unknown }> => ({
        ok: true,
      })),
    },
  }
  const modelDirectories = vi.fn(() => {
    throw new Error('modelDirectories must not be read')
  })
  const ctx = {
    uiWorkspace: { openSession: sessions.open },
    get(name: string) {
      if (name === 'remoteAccess')
        return {
          source: (_kind: string, _id: string, action: string) =>
            action === 'session/follow' ? childReadable : observable(true),
        }
      if (name === 'sessions') return sessions
      if (name === 'modelDirectories') return { directoryFor: modelDirectories }
      if (name === 'workspaces') return { list: observable({ items: [] }) }
      return undefined
    },
    remote,
  } as never
  return {
    ctx,
    main,
    childReadable,
    remote,
    modelDirectories,
    sessions,
    bindings,
    list,
    projection,
    routes,
    coordinator: new CrossBackendCoordinator(ctx, routes),
  }
}

function transactionStatesOf(coordinator: CrossBackendCoordinator): Map<string, unknown> {
  const { tx } = coordinator as unknown as { tx: { states: Map<string, unknown> } }
  return tx.states
}

describe('cross-backend coordinator', () => {
  it('keeps native-to-native selection entirely outside the ACP path', () => {
    expect(
      shouldConfirmBackendTransition(
        {
          lastUsed: { provider: 'native-a', model: 'a' },
          next: { provider: 'native-b', model: 'b' },
          blank: false,
        },
        owns,
      ),
    ).toBe(false)
  })

  it.each(['cancel', 'confirm'] as const)(
    'can %s a verified historical handoff without selecting a removed model',
    async (action) => {
      const previous = { provider: 'acp-retired', model: 'old' }
      const next = { provider: 'native', model: 'new' }
      const f = fixture({ projection: { lastUsed: previous, next: previous } })
      const history = { providers: [], historicalProviders: [previous.provider] }
      f.routes.set(history)
      const stop = f.coordinator.start()
      f.projection.set({ lastUsed: previous, next })
      await settle()
      expect(f.coordinator.getSnapshot().pending?.ticket).toMatchObject({
        sourceUnavailable: true,
        targetSelection: next,
      })
      expect(f.remote.session.selectModel).not.toHaveBeenCalled()
      await f.coordinator[action]()
      if (action === 'confirm') {
        expect(f.remote.session.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'destination', ...next })
        expect(f.sessions.open).toHaveBeenCalledOnce()
      } else {
        expect(f.sessions.create).not.toHaveBeenCalled()
        expect(f.remote.session.selectModel).not.toHaveBeenCalled()
      }
      f.routes.set(history)
      f.projection.set({ lastUsed: previous, next })
      expect(f.coordinator.getSnapshot().pending).toBeNull()
      stop()
      const returned = fixture({ projection: { lastUsed: previous, next } })
      returned.routes.set(history)
      const leave = returned.coordinator.start()
      await settle()
      expect(returned.coordinator.getSnapshot().pending).toBeNull()
      leave()
    },
  )

  it('does not claim a foreign session with a historical provider name or a superseded historical choice', async () => {
    const previous = { provider: 'acp-retired', model: 'old' }
    const f = fixture({ projection: { lastUsed: previous, next: previous } })
    f.routes.set({ providers: [], historicalProviders: [previous.provider] })
    const stop = f.coordinator.start()
    const proof = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.dshAcp.backendOf>>>()
    f.remote.dshAcp.backendOf.mockReturnValueOnce(proof.promise).mockResolvedValueOnce({
      ok: true,
      value: { state: 'established', provider: previous.provider },
    })
    f.projection.set({ lastUsed: previous, next: { provider: 'native', model: 'first' } })
    f.projection.set({ lastUsed: previous, next: { provider: 'native', model: 'second' } })
    proof.resolve({ ok: true, value: { state: 'established', provider: previous.provider, acpBinding: true } })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(f.remote.session.selectModel).not.toHaveBeenCalled()
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it.each(['before confirmation', 'while creating'] as const)(
    'revokes a handoff when the target changes owners %s',
    async (phase) => {
      const f = fixture()
      const stop = f.coordinator.start()
      f.projection.set({
        lastUsed: { provider: 'native', model: 'model-a' },
        next: { provider: 'acp-devin', model: 'new' },
      })
      await settle()
      expect(f.coordinator.getSnapshot().pending).not.toBeNull()
      const retired = { providers: ['acp-codex'], historicalProviders: ['acp-devin'] }
      const created = Promise.withResolvers<string>()
      if (phase === 'while creating') f.sessions.create.mockReturnValueOnce(created.promise)
      else f.remote.dshAcp.ownedProviderRoutes.mockResolvedValueOnce({ ok: true, value: retired })
      const confirming = f.coordinator.confirm()
      if (phase === 'while creating') {
        await vi.waitFor(() => expect(f.sessions.create).toHaveBeenCalledOnce())
        f.routes.set(retired)
      }
      created.resolve('published-child')
      await confirming
      expect(f.coordinator.getSnapshot().pending).toBeNull()
      expect(f.sessions.create).toHaveBeenCalledTimes(phase === 'while creating' ? 1 : 0)
      expect(f.remote.session.selectModel).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-1',
        provider: 'native',
        model: 'model-a',
      })
      expect(f.sessions.open).not.toHaveBeenCalled()
      const source = SessionId('session-1')
      const child = SessionId('published-child')
      const entry = { source, child }
      expect(f.coordinator.getSnapshot().created).toEqual(phase === 'while creating' ? [entry] : [])
      if (phase === 'while creating') {
        f.list.set({ byId: { ...f.list.getSnapshot().byId, [child]: { id: child, blank: true, cwd: '/tmp' } } })
        f.main.set({ retainedBy: { mainView: 0 } })
        expect(f.coordinator.openCreated(source, child, () => true)).toBe(false)
        f.main.set({ retainedBy: { mainView: 1 } })
        expect(f.coordinator.openCreated(source, child, () => false)).toBe(false)
        expect(f.coordinator.openCreated(SessionId('other'), child, () => true)).toBe(false)
        expect(f.sessions.open).not.toHaveBeenCalled()
        expect(f.coordinator.openCreated(source, child, () => true)).toBe(true)
        expect(f.coordinator.openCreated(source, child, () => true)).toBe(false)
        expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith(child)
        expect(f.sessions.create).toHaveBeenCalledOnce()
      }
      stop()
    },
  )

  it('abandons a selection when an Agent is replaced under the same provider id and offers the published child once', async () => {
    const f = fixture()
    f.routes.set({ ...f.routes.getSnapshot(), generations: { 'acp-devin': 'original' } })
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-devin', model: 'new' },
    })
    await settle()
    const select = Promise.withResolvers<{ ok: boolean }>()
    f.remote.session.selectModel.mockReturnValueOnce(select.promise)
    const confirming = f.coordinator.confirm()
    await vi.waitFor(() => expect(f.remote.session.selectModel).toHaveBeenCalledTimes(2))
    f.routes.set({ ...f.routes.getSnapshot(), generations: { 'acp-devin': 'replacement' } })
    expect(f.coordinator.getSnapshot()).toMatchObject({
      pending: null,
      created: [{ source: 'session-1', child: 'destination' }],
    })
    f.coordinator.dismissCreated('session-1', SessionId('destination'))
    select.resolve({ ok: true })
    await confirming
    expect(f.coordinator.getSnapshot().created).toEqual([])
    expect(f.sessions.open).not.toHaveBeenCalled()
    stop()
  })

  it('requires a new decision to switch with the default when the source preset disappears', async () => {
    const f = fixture({
      row: { blank: false, agentPreset: 'cordis' },
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    f.sessions.create.mockRejectedValueOnce(
      new SessionCreateError(
        new RemoteError('agent-preset/not-found', 'gone', { agentPreset: 'cordis', available: ['standard'] }),
        undefined,
      ),
    )
    const stop = f.coordinator.start()
    await settle()
    await f.coordinator.confirm()
    expect(f.coordinator.getSnapshot().pending?.failure?.phase).toBe('preset-unavailable')
    const key = f.coordinator.getSnapshot().pending!.ticket.key
    await f.coordinator.confirm(key)
    await f.coordinator.confirm('previous', true)
    expect(f.sessions.create).toHaveBeenCalledExactlyOnceWith({
      sessionId: expect.any(String),
      cwd: '/tmp',
      agentPreset: 'cordis',
    })
    await f.coordinator.confirm(key, true)
    expect(f.sessions.create).toHaveBeenLastCalledWith({ sessionId: expect.any(String), cwd: '/tmp' })
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('destination')
    stop()
  })

  it('retains the selected child if its follow grant is revoked before opening', async () => {
    const f = fixture({
      projection: { lastUsed: { provider: 'native', model: 'old' }, next: { provider: 'acp-codex', model: 'new' } },
    })
    const stop = f.coordinator.start()
    await settle()
    f.childReadable.set(false)
    await f.coordinator.confirm()
    expect(f.coordinator.getSnapshot().pending?.failure?.phase).toBe('open-destination')
    expect(f.sessions.open).not.toHaveBeenCalled()
    f.childReadable.set(true)
    await f.coordinator.confirm()
    expect(f.sessions.create).toHaveBeenCalledOnce()
    expect(f.remote.session.selectModel).toHaveBeenCalledTimes(2)
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('destination')
    stop()
  })

  it('recovers a late blank after withdrawal only once the Host confirms its requested identity', async () => {
    const f = fixture({
      projection: { lastUsed: { provider: 'native', model: 'old' }, next: { provider: 'acp-devin', model: 'new' } },
    })
    const stop = f.coordinator.start()
    await settle()
    let requested = ''
    const lost = Promise.withResolvers<string>()
    f.sessions.create.mockImplementationOnce(function (...args: unknown[]) {
      requested = (args[0] as { sessionId: string }).sessionId
      return lost.promise
    })
    const listing = f.remote.session.list
    listing.mockRejectedValueOnce(new Error('disconnected'))
    const confirming = f.coordinator.confirm()
    await vi.waitFor(() => expect(requested).not.toBe(''))
    f.routes.set({ providers: [], historicalProviders: ['acp-devin'] })
    lost.reject(new Error('no create response'))
    await confirming
    const entry = { id: requested, blank: true, cwd: '/tmp' }
    listing.mockRejectedValueOnce(new Error('still disconnected'))
    f.list.set({ byId: { ...f.list.getSnapshot().byId, [requested]: entry } })
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2))
    await settle()
    expect(f.coordinator.getSnapshot().created).toEqual([])
    listing.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: requested, blank: true }] } })
    f.list.set({ ...f.list.getSnapshot() })
    await vi.waitFor(() =>
      expect(f.coordinator.getSnapshot().created).toEqual([{ source: 'session-1', child: requested }]),
    )
    expect(f.sessions.create).toHaveBeenCalledOnce()
    expect(f.sessions.open).not.toHaveBeenCalled()
    stop()
  })

  it('does not display a stale decision after restoring the source', async () => {
    const f = fixture()
    const restored = Promise.withResolvers<{ ok: boolean }>()
    f.remote.session.selectModel.mockReturnValueOnce(restored.promise)
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-devin', model: 'new' },
    })
    f.routes.set({ providers: ['acp-codex'], historicalProviders: ['acp-devin'] })
    restored.resolve({ ok: true })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('returns an identity-stable external snapshot', () => {
    const f = fixture()
    expect(f.coordinator.getSnapshot()).toBe(f.coordinator.getSnapshot())
  })

  it('adopts ACP directly for a blank session and does not open a modal', () => {
    const f = fixture({
      row: { blank: true },
      projection: { lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('requires confirmation when historical state has no committed source model', async () => {
    const f = fixture({
      row: { blank: false },
      projection: { lastUsed: null, next: null },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()

    f.projection.set({ lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } })
    await settle()

    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.ticket.sourceSelection).toBeUndefined()
    expect(pending?.ticket.sourceAlreadyRestored).toBeUndefined()
    expect(pending?.ticket.targetSelection).toEqual({ provider: 'acp-codex', model: 'gpt' })
    expect(pending?.confirmable).toBe(true)
    expect(f.remote.session.selectModel).not.toHaveBeenCalled()

    await f.coordinator.confirm()

    expect(f.sessions.create).toHaveBeenCalledTimes(1)
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'destination',
      provider: 'acp-codex',
      model: 'gpt',
    })
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('destination')
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(transactionStatesOf(f.coordinator).has(pending!.ticket.key)).toBe(false)
    stop()
  })

  it('offers to open the published child outside its workspace after attachment fails', async () => {
    const f = fixture({ projection: { lastUsed: null, next: null } })
    const stop = f.coordinator.start()
    f.projection.set({ lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } })
    await settle()
    f.sessions.create.mockRejectedValueOnce(
      new SessionCreateError(
        new RemoteError('session/workspace-attach-failed', 'attachment failed', {
          sessionId: 'ungrouped' as never,
          workspaceId: 'workspace' as never,
        }),
        undefined,
      ),
    )
    await f.coordinator.confirm()
    expect(f.coordinator.getSnapshot().pending?.failure?.phase).toBe('ungrouped-destination')
    expect(f.remote.session.selectModel).not.toHaveBeenCalled()
    expect(f.sessions.open).not.toHaveBeenCalled()
    await f.coordinator.confirm()
    expect(f.sessions.create).toHaveBeenCalledOnce()
    expect(f.remote.session.selectModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'ungrouped',
      provider: 'acp-codex',
      model: 'gpt',
    })
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('ungrouped')
    stop()
  })

  it.each([false, true])(
    'can dismiss an unknown-source transition without inventing a rollback model (failed confirm: %s)',
    async (failConfirm) => {
      const f = fixture({
        row: { blank: false },
        projection: { lastUsed: null, next: null },
      })
      const stop = f.coordinator.start()
      f.projection.set({ lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } })
      await settle()

      const key = f.coordinator.getSnapshot().pending!.ticket.key
      if (failConfirm) {
        f.remote.session.selectModel.mockResolvedValueOnce({
          ok: false,
          error: { message: 'destination selection failed' },
        })
        await f.coordinator.confirm()
        expect(transactionStatesOf(f.coordinator).has(key)).toBe(true)
      }

      await f.coordinator.cancel()

      expect(f.coordinator.getSnapshot().pending).toBeNull()
      expect(transactionStatesOf(f.coordinator).has(key)).toBe(false)
      expect(f.remote.session.selectModel).toHaveBeenCalledTimes(failConfirm ? 1 : 0)
      expect(f.sessions.create).toHaveBeenCalledTimes(failConfirm ? 1 : 0)
      expect(f.sessions.open).not.toHaveBeenCalled()
      expect(f.projection.getSnapshot().next).toEqual({ provider: 'acp-codex', model: 'gpt' })
      stop()
    },
  )

  it('restores the used ACP model and waits for explicit independent-session confirmation', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'acp-codex', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.reason).toBe('model-switch')
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'acp-codex',
      model: 'old',
    })
    expect(f.sessions.create).not.toHaveBeenCalled()
    await f.coordinator.confirm()
    expect(f.sessions.create).toHaveBeenCalledTimes(1)
    expect(f.remote.session.selectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'acp-codex', model: 'new' }),
    )
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps the native pending selection until the ACP preset confirms a same-Agent switch', async () => {
    const used = { provider: 'acp-codex', model: 'old' }
    const next = { ...used, model: 'new' }
    const other = { provider: 'acp-devin', model: 'other' }
    const f = fixture({
      livePreset: 'acp-adapter',
      row: { blank: false, agentPreset: 'standard' },
      projection: { lastUsed: used, next: used },
    })
    const stop = f.coordinator.start()
    f.projection.set({ lastUsed: used, next })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(f.remote.session.selectModel).not.toHaveBeenCalled()
    expect(f.sessions.create).not.toHaveBeenCalled()
    f.projection.set({ lastUsed: used, next: other })
    await settle()
    expect(f.coordinator.getSnapshot().pending?.ticket).toMatchObject({ sourceSelection: next, targetSelection: other })
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({ sessionId: 'session-1', ...next })
    stop()
  })

  it('retains the independent-session handoff for non-ACP presets and unconfirmed model identities', () => {
    const route = { provider: 'acp-codex', model: 'a' }
    const next = { ...route, model: 'b' }
    for (const preset of [undefined, 'standard', 'cordis', 'ptc', 'minimal', 'custom'])
      expect(shouldConfirmBackendTransition({ lastUsed: route, next, blank: false, preset }, owns)).toBe(true)
    const current = { ...route, model: ACP_CURRENT_CONFIG_MODEL_ID }
    for (const [source, target] of [
      [route, current],
      [current, next],
    ] as const)
      expect(
        shouldConfirmBackendTransition({ lastUsed: source, next: target, blank: false, preset: 'acp-adapter' }, owns),
      ).toBe(true)
  })

  it('keeps reasoning-only changes and unowned routes outside the model-switch exit', () => {
    expect(
      shouldConfirmBackendTransition(
        {
          lastUsed: { provider: 'acp-codex', model: 'same' },
          next: { provider: 'acp-codex', model: 'same', reasoningEffort: 'high' },
          blank: false,
        },
        owns,
      ),
    ).toBe(false)
    expect(
      shouldConfirmBackendTransition(
        { lastUsed: { provider: 'acp-other', model: 'a' }, next: { provider: 'acp-other', model: 'b' }, blank: false },
        () => false,
      ),
    ).toBe(false)
  })

  it('does not restore a previously pending unsupported ACP model', async () => {
    const f = fixture({
      projection: { lastUsed: { provider: 'acp-codex', model: 'used' }, next: { provider: 'acp-codex', model: 'bad' } },
    })
    const stop = f.coordinator.start()
    await settle()
    await f.coordinator.cancel()
    f.projection.set({
      lastUsed: { provider: 'acp-codex', model: 'used' },
      next: { provider: 'acp-codex', model: 'another' },
    })
    await settle()
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSelection?.model).toBe('used')
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('cancels a later cross-profile switch back to the latest visible selection', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
        next: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      },
    })
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
      provider: 'acp-codex',
      model: 'GPT-5.4-Mini',
      reasoningEffort: 'medium',
    })
    await f.coordinator.cancel()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'acp-codex',
      model: 'GPT-5.4-Mini',
      reasoningEffort: 'medium',
    })
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('restores the source before exposing one pending decision and keeps it across navigation', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    await settle()
    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.ticket.sourceSessionId).toBe('session-1')
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'old',
    })
    f.list.set({
      byId: { 'session-2': { id: 'session-2', blank: true, cwd: '/tmp' } },
    })
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('session-1')
    stop()
  })

  it('does not read modelDirectories while observing a native or ACP transition', () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    expect(f.modelDirectories).not.toHaveBeenCalled()
    stop()
  })

  it('restores a no-location transition before exposing a non-confirmable decision', async () => {
    const f = fixture({
      row: { blank: false, cwd: null },
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.confirmable).toBe(false)
    await f.coordinator.confirm()
    expect(f.sessions.create).not.toHaveBeenCalled()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'old',
    })
    stop()
  })

  it('does not leave a second decision after a failed source rollback', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const selectModel = f.remote.session.selectModel
    selectModel.mockResolvedValueOnce({ ok: false, error: { message: 'rollback failed' } })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.failure).toEqual({
      phase: 'restore-source',
      message: 'rollback failed',
    })
    expect(selectModel).toHaveBeenCalledTimes(1)
    stop()
  })

  it.each([
    ['create-unknown', 'create'],
    ['select-destination', 'select'],
    ['open-destination', 'open'],
  ] as const)('retains the structured %s failure for localized UI handling', async (phase, failedStep) => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    if (failedStep === 'create') f.sessions.create.mockRejectedValueOnce(new Error('CREATE_DIAGNOSTIC'))
    if (failedStep === 'select')
      f.remote.session.selectModel
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: { message: 'SELECT_DIAGNOSTIC' } })
    if (failedStep === 'open')
      f.sessions.open.mockImplementationOnce(() => {
        throw new Error('OPEN_DIAGNOSTIC')
      })
    const stop = f.coordinator.start()
    await settle()
    await f.coordinator.confirm()
    expect(f.coordinator.getSnapshot().pending?.failure).toMatchObject({ phase })
    stop()
  })

  it('observes a retained sidebar independently and queues simultaneous decisions without mixing their sources', async () => {
    const f = fixture()
    const child = observable({
      lastUsed: { provider: 'native', model: 'child-old' },
      next: { provider: 'native', model: 'child-old' },
    })
    f.bindings.set('child', { session: { projections: { faceOf: () => child } } })
    f.list.set({ byId: { ...f.list.getSnapshot().byId, child: { id: 'child', blank: false, cwd: '/child' } } })
    const stop = f.coordinator.start()
    child.set({
      lastUsed: { provider: 'native', model: 'child-old' },
      next: { provider: 'acp-devin', model: 'child-new' },
    })
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'parent-new' },
    })
    await settle()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'child',
      provider: 'native',
      model: 'child-old',
    })
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'model-a',
    })
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
    f.remote.session.selectModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          restore = resolve
        }),
    )
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    f.bindings.clear()
    f.list.set({ ...f.list.getSnapshot() })
    restore({ ok: true })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-devin', model: 'another' },
    })
    expect(f.remote.session.selectModel).toHaveBeenCalledTimes(1)
    stop()
  })
})
