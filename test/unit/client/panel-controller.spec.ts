import { describe, expect, it, vi } from 'vitest'
import { AcpPanelController, type AcpPanelControllerDeps } from '../../../src/client/data/controller.ts'
import { createAcpPanelStore } from '../../../src/client/data/stores/panel-store.ts'
import { emptyDraft, type AcpAgentConfig, type AcpProviderHealth } from '../../../src/client/data/logic.ts'
import type { AcpHealthRequest, AcpHealthView } from '../../../src/contract/remote.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function row(id: string, version: string): AcpProviderHealth {
  return {
    id,
    name: id,
    command: id,
    args: [],
    loginHint: null,
    executable: true,
    version,
    state: 'saved-unverified',
    probe: { status: 'never', at: null },
  }
}

function view(rows: readonly AcpProviderHealth[]): AcpHealthView {
  return { providers: rows, liveSessions: null }
}

function panel(health: (request?: AcpHealthRequest) => Promise<unknown>) {
  const existing = { name: 'Existing', command: 'existing-acp', args: [], env: {} }
  let agents: Record<string, AcpAgentConfig> = { devin: existing, generic: existing }
  const mutate = vi.fn<AcpPanelControllerDeps['mutate']>().mockResolvedValue(true)
  let changed: (() => void) | undefined
  const controller = new AcpPanelController({
    scope: {
      getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: { agents } }),
      subscribe(listener) {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    },
    mutate,
    refusedMessage: () => 'refused',
    remote: { health } as AcpPanelControllerDeps['remote'],
  })
  const store = createAcpPanelStore().create()
  controller.attach(store.actions)
  return {
    controller,
    store,
    mutate,
    publishAgent(id: string, config?: AcpAgentConfig) {
      agents = { ...agents }
      if (config) agents[id] = config
      else delete agents[id]
      changed?.()
    },
  }
}

describe('AcpPanelController targeted health checks', () => {
  it('allows different agents concurrently, deduplicates the same agent, and merges only its row', async () => {
    const devin = deferred<{ ok: true; value: AcpHealthView }>()
    const generic = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi.fn((request?: { recheck?: boolean; agentId?: string }) => {
      if (request?.agentId === 'devin') return devin.promise
      if (request?.agentId === 'generic') return generic.promise
      return Promise.resolve({ ok: true as const, value: view([row('devin', 'old'), row('generic', 'old')]) })
    })
    const { controller, store } = panel(health)

    const initial = controller.refreshHealth()
    await initial
    const first = controller.refreshAgentHealth('devin')
    const duplicate = controller.refreshAgentHealth('devin')
    const second = controller.refreshAgentHealth('generic')
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['devin', 'generic'])
    expect(health).toHaveBeenCalledTimes(3)

    generic.resolve({ ok: true, value: view([row('devin', 'stale-from-generic'), row('generic', 'new-generic')]) })
    await second
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['devin'])
    devin.resolve({ ok: true, value: view([row('devin', 'new-devin'), row('generic', 'stale-from-devin')]) })
    await Promise.all([first, duplicate])

    expect(store.getSnapshot().health.checkingAgentIds).toEqual([])
    expect(store.getSnapshot().health.rows.map((entry) => [entry.id, entry.version])).toEqual([
      ['devin', 'new-devin'],
      ['generic', 'new-generic'],
    ])
    expect(health).toHaveBeenNthCalledWith(2, { recheck: true, agentId: 'devin' })
    expect(health).toHaveBeenNthCalledWith(3, { recheck: true, agentId: 'generic' })
    controller.dispose()
  })

  it('carries a Host version mismatch into the panel and clears it when the Host no longer reports one', async () => {
    const responses = [
      { ...view([]), hostVersion: { required: '0.2.2-rc.1', running: '0.2.2-rc.2' } },
      { ...view([]), hostVersion: { required: 1 } },
    ]
    const { controller, store } = panel(async () => ({ ok: true, value: responses.shift() }))
    await controller.refreshHealth()
    expect(store.getSnapshot().health.hostVersion).toEqual({ required: '0.2.2-rc.1', running: '0.2.2-rc.2' })
    await controller.refreshHealth()
    expect(store.getSnapshot().health.hostVersion).toBeUndefined()
    controller.dispose()
  })

  it('keeps a saved Agent after its first check fails and retries only that Agent', async () => {
    const config = { name: 'New agent', command: 'manual-acp', args: [], env: {} }
    const draft = { ...emptyDraft(), id: ' new-agent ', name: config.name, command: config.command }
    const write = deferred<boolean>()
    const probe = deferred<{ ok: false; error: { message: string } }>()
    const health = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: view([row('generic', '1')]) })
      .mockReturnValueOnce(probe.promise)
      .mockResolvedValueOnce({ ok: true, value: view([row('new-agent', '2')]) })
    const { controller, store, mutate, publishAgent } = panel(health)
    await controller.refreshHealth()
    mutate.mockReturnValueOnce(write.promise)
    const saving = controller.saveAgent(undefined, draft)
    expect(health.mock.calls).toEqual([[undefined]])
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['agents', 'new-agent'], value: config }], 1)
    publishAgent('new-agent', config)
    write.resolve(true)
    expect(await saving).toBeUndefined()
    const target = { recheck: true, agentId: 'new-agent' }
    expect(health.mock.calls).toEqual([[undefined], [target]])
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['new-agent'])

    probe.resolve({ ok: false, error: { message: 'Connection failed' } })
    await vi.waitFor(() => expect(store.getSnapshot().health.agentErrors).toEqual({ 'new-agent': 'Connection failed' }))
    expect(store.getSnapshot().health.status).toBe('ready')
    expect(store.getSnapshot().settings.agents['new-agent']).toEqual(config)
    await controller.refreshAgentHealth('new-agent')
    expect(store.getSnapshot().health.agentErrors).toEqual({})
    expect(store.getSnapshot().health.rows.map(({ id, version }) => [id, version])).toEqual([
      ['generic', '1'],
      ['new-agent', '2'],
    ])
    expect(health.mock.calls).toEqual([[undefined], [target], [target]])
    expect(mutate).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('runs the first check even when an earlier panel-wide check is still pending', async () => {
    const pending = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, value: view([row('new-agent', 'checked')]) })
    const { controller, store, mutate, publishAgent } = panel(health)
    const initial = controller.refreshHealth(true)
    const config = { name: 'New agent', command: 'manual-acp', args: [], env: {} }
    mutate.mockImplementationOnce(async () => {
      publishAgent('new-agent', config)
      return true
    })
    expect(await controller.saveAgent(undefined, { ...emptyDraft(), id: 'new-agent', ...config })).toBeUndefined()
    pending.resolve({ ok: true, value: view([row('generic', 'older')]) })
    await initial
    await vi.waitFor(() =>
      expect(store.getSnapshot().health.rows.map(({ id }) => id)).toEqual(['generic', 'new-agent']),
    )
    expect(health.mock.calls).toEqual([[{ recheck: true }], [{ recheck: true, agentId: 'new-agent' }]])
    controller.dispose()
  })

  it('keeps the replacement check when a deleted Agent with the same ID responds late', async () => {
    const previous = deferred<{ ok: true; value: AcpHealthView }>()
    const replacement = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(replacement.promise)
    const { controller, store, publishAgent } = panel(health)
    const id = 'same-agent'
    const original = { name: 'Original', command: 'first-acp', args: [], env: {} }
    const updated = { ...original, name: 'Replacement', command: 'replacement-acp' }
    const add = async (config: AcpAgentConfig) => {
      expect(
        await controller.saveAgent(undefined, { ...emptyDraft(), id, name: config.name, command: config.command }),
      ).toBeUndefined()
      publishAgent(id, config)
    }
    await add(original)
    expect(await controller.deleteAgent(id)).toBeUndefined()
    publishAgent(id)
    await add(updated)
    const target = { recheck: true, agentId: id }
    expect(health.mock.calls).toEqual([[target], [target]])

    replacement.resolve({ ok: true, value: view([row(id, 'replacement')]) })
    await vi.waitFor(() => expect(store.getSnapshot().health.rows[0]?.version).toBe('replacement'))
    previous.resolve({ ok: true, value: view([row(id, 'deleted')]) })
    await new Promise<void>((done) => setImmediate(done))
    expect(store.getSnapshot().health.rows.map(({ version }) => version)).toEqual(['replacement'])
    expect(store.getSnapshot().health.checkingAgentIds).toEqual([])
    controller.dispose()
  })

  it.each(['delete', 'rename', 'dispose'] as const)('drops a queued first check after %s', async (action) => {
    const pending = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi.fn(() => pending.promise)
    const { controller, publishAgent } = panel(health)
    const initial = controller.refreshHealth()
    const draft = { ...emptyDraft(), id: 'new-agent', name: 'New agent', command: 'manual-acp' }
    expect(await controller.saveAgent(undefined, draft)).toBeUndefined()
    publishAgent(draft.id, { name: draft.name, command: draft.command, args: [], env: {} })
    if (action === 'delete') expect(await controller.deleteAgent(draft.id)).toBeUndefined()
    if (action === 'rename') expect(await controller.saveAgent(draft.id, { ...draft, id: 'renamed' })).toBeUndefined()
    if (action === 'dispose') controller.dispose()
    pending.resolve({ ok: true, value: view([]) })
    await initial
    expect(health.mock.calls).toEqual([[undefined]])
    if (action !== 'dispose') controller.dispose()
  })

  it('does not start a check for a refused add or a display-name edit', async () => {
    const health = vi.fn()
    const { controller, mutate } = panel(health)
    const draft = { ...emptyDraft(), id: 'new-agent', name: 'New agent', command: 'manual-acp' }
    mutate.mockResolvedValueOnce(false)
    expect(await controller.saveAgent(undefined, draft)).toBe('refused')
    expect(await controller.saveAgent('generic', { ...draft, id: 'generic', command: 'existing-acp' })).toBeUndefined()
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(health).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('rechecks an edited launch and discards a late result after the same ID is edited elsewhere', async () => {
    const probe = deferred<{ ok: true; value: AcpHealthView }>()
    const checked: AcpProviderHealth = {
      ...row('generic', '1'),
      command: 'existing-acp',
      state: 'ready',
      probe: {
        status: 'ok',
        at: 1,
        modelCount: 1,
        authMethods: null,
        agentInfo: null,
        capabilities: null,
        cleanup: null,
        capabilityHash: null,
        protocolVersion: 1,
        versionCompatibility: null,
        matrix: [],
      },
    }
    const health = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: view([checked]) })
      .mockReturnValueOnce(probe.promise)
    const { controller, store, mutate, publishAgent } = panel(health)
    await controller.refreshHealth()
    expect(store.getSnapshot().health.rows[0]?.state).toBe('ready')
    const updated = { name: 'Edited', command: 'new-program', args: [], env: { MODE: 'new' } }
    mutate.mockImplementationOnce(async () => {
      publishAgent('generic', updated)
      return true
    })
    expect(
      await controller.saveAgent('generic', {
        ...emptyDraft(),
        id: 'generic',
        name: updated.name,
        command: updated.command,
        envText: 'MODE=new',
      }),
    ).toBeUndefined()
    expect(store.getSnapshot().health.rows).toEqual([])
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['generic'])
    publishAgent('generic', { ...updated, name: 'Just a new label' })
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['generic'])
    publishAgent('generic', { ...updated, env: { MODE: 'third' } })
    probe.resolve({ ok: true, value: view([{ ...checked, command: updated.command }]) })
    await new Promise<void>((done) => setImmediate(done))
    expect(store.getSnapshot().health.rows).toEqual([])
    expect(store.getSnapshot().health.checkingAgentIds).toEqual([])
    expect(health.mock.calls).toEqual([[undefined], [{ recheck: true, agentId: 'generic' }]])
    controller.dispose()
  })

  it('discards obsolete rows from a panel-wide read while keeping unaffected rows', async () => {
    const pending = deferred<{ ok: true; value: AcpHealthView }>()
    const { controller, publishAgent, store } = panel(() => pending.promise)
    const read = controller.refreshHealth()
    publishAgent('generic', { name: 'Existing', command: 'existing-acp', args: ['--changed'], env: {} })
    pending.resolve({ ok: true, value: view([row('generic', 'previous'), row('devin', 'unchanged')]) })
    await read
    expect(store.getSnapshot().health.rows.map((row) => row.id)).toEqual(['devin'])
    controller.dispose()
  })
})
