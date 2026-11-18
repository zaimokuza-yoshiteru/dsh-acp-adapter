import { describe, expect, it, vi } from 'vitest'
import { AcpPanelController } from '../../../src/client/data/controller.ts'
import { createAcpPanelStore } from '../../../src/client/data/stores/panel-store.ts'
import type { AcpProviderHealth } from '../../../src/client/data/logic.ts'
import type { AcpHealthView } from '../../../src/contract/remote.ts'

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

describe('AcpPanelController targeted health checks', () => {
  it('allows different agents concurrently, deduplicates the same agent, and merges only its row', async () => {
    const devin = deferred<{ ok: true; value: AcpHealthView }>()
    const generic = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi.fn((request?: { recheck?: boolean; agentId?: string }) => {
      if (request?.agentId === 'devin') return devin.promise
      if (request?.agentId === 'generic') return generic.promise
      return Promise.resolve({ ok: true as const, value: view([row('devin', 'old'), row('generic', 'old')]) })
    })
    const scope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        revision: 1,
        value: {
          agents: {
            devin: { name: 'Devin', command: 'devin', args: ['acp'], env: {} },
            generic: { name: 'generic', command: 'generic', args: ['acp'], env: {} },
          },
        },
      }),
      subscribe: () => () => {},
    }
    const controller = new AcpPanelController({
      scope,
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health,
        backendOf: vi.fn(),
        boundSessions: vi.fn(),
        activityFollow: async function* () {},
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)

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
    const controller = new AcpPanelController({
      scope: {
        getSnapshot: () => ({ status: 'ready' as const, writable: true, revision: 1, value: { agents: {} } }),
        subscribe: () => () => {},
      },
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health: vi.fn(() => Promise.resolve({ ok: true as const, value: responses.shift() })),
        backendOf: vi.fn(),
        boundSessions: vi.fn(),
        activityFollow: async function* () {},
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)
    await controller.refreshHealth()
    expect(store.getSnapshot().health.hostVersion).toEqual({ required: '0.2.2-rc.1', running: '0.2.2-rc.2' })
    await controller.refreshHealth()
    expect(store.getSnapshot().health.hostVersion).toBeUndefined()
    controller.dispose()
  })

  it('keeps a targeted failure on that card without making the whole panel unreachable', async () => {
    const scope = {
      getSnapshot: () => ({ status: 'ready' as const, writable: true, revision: 1, value: { agents: {} } }),
      subscribe: () => () => {},
    }
    const controller = new AcpPanelController({
      scope,
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health: vi.fn((request?: { agentId?: string }) =>
          request?.agentId === 'devin'
            ? Promise.resolve({ ok: false as const, error: { message: 'devin probe failed' } })
            : Promise.resolve({ ok: true as const, value: view([]) }),
        ),
        backendOf: vi.fn(),
        boundSessions: vi.fn(),
        activityFollow: async function* () {},
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)
    await controller.refreshHealth()
    await controller.refreshAgentHealth('devin')
    expect(store.getSnapshot().health.status).toBe('ready')
    expect(store.getSnapshot().health.agentErrors).toEqual({ devin: 'devin probe failed' })
    controller.dispose()
  })
})
