import { describe, expect, it } from 'vitest'
import { apply, inject } from '../../../src/client/index.ts'

describe('alpha client contribution', () => {
  it('declares the additive settings, audit, and conversation seams', () => {
    expect(inject).toEqual([
      'uiConversation', 'slots', 'locale', 'remote',
      'sessions', 'workspaces', 'settingsScope', 'remote.settings', 'remote.session',
    ])
  })

  it('mounts the generated Remote before registering one keyed renderer', async () => {
    const definitions: unknown[] = []
    const injections: unknown[] = []
    // Model a live slot that another plugin already owns. The public slot
    // contract is additive: registering our entry must not replace or clear
    // the existing entry.
    const slotEntries = new Map<string, unknown[]>([
      ['shell.overlay', [{ name: 'shell.overlay', id: 'third-party-overlay' }]],
    ])
    const lifecycle: string[] = []
    const ctx = {
      remote: {
        $mount: async () => { lifecycle.push('mount'); return async () => { lifecycle.push('dispose') } },
        settings: { mutate: async () => ({ ok: true, value: null }) },
        dshAcp: {
          ownedProviderRoutes: async () => ({ ok: true, value: { providers: [] } }),
          projectedSubagentIds: async () => ({ ok: true, value: { sessionIds: [] } }),
        },
      },
      uiConversation: { events: { register: (definition: unknown) => { definitions.push(definition) } } },
      locale: { register: () => undefined, bind: () => (key: string) => key },
      settingsScope: {
        bind: () => ({
          getSnapshot: () => ({ status: 'ready', value: { agents: {} }, revision: 1, writable: true }),
          subscribe: () => () => {},
        }),
      },
      sessions: {},
      workspaces: {},
      effect: (fn: () => unknown) => { void fn() },
      slots: {
        inject: (name: string, factory: () => unknown) => {
          const entry = factory()
          injections.push(entry)
          slotEntries.set(name, [...(slotEntries.get(name) ?? []), entry])
        },
        register: (value: unknown) => value,
      },
      get: () => ({}),
    }
    const uiInjects: string[][] = []
    Object.assign(ctx, {
      inject: (deps: readonly string[], callback: (scope: typeof ctx) => void | Promise<void>) => {
        uiInjects.push([...deps])
        const started = Promise.resolve(callback(ctx))
        return Object.assign(started, {
          dispose: async () => { lifecycle.push('ui-dispose') },
        })
      },
    })
    const dispose = await apply(ctx as never)
    expect(lifecycle).toEqual(['mount'])
    expect(uiInjects).toEqual([[...inject, 'remote.dshAcp']])
    expect(definitions).toHaveLength(2)
    expect(injections).toHaveLength(7)
    expect(injections[0]).toMatchObject({ id: 'acp' })
    // The view injection installs a dynamic registrar rather than a global
    // tab; native sessions must keep the stock view roster.
    expect(injections[1]).toBeTypeOf('function')
    expect(injections[2]).toMatchObject({ id: 'dsh-acp-audit-visibility' })
    expect(injections[3]).toMatchObject({ key: 'acp-activity' })
    expect(injections[4]).toMatchObject({ id: 'dsh-acp-cross-backend-confirmation' })
    expect(injections[5]).toMatchObject({ id: 'dsh-acp-recovery' })
    expect(injections[6]).toMatchObject({ id: 'dsh-acp-agent-control' })
    expect(slotEntries.get('shell.overlay')).toEqual([
      { name: 'shell.overlay', id: 'third-party-overlay' },
      expect.objectContaining({ id: 'dsh-acp-cross-backend-confirmation' }),
    ])
    await dispose()
    expect(lifecycle).toEqual(['mount', 'ui-dispose', 'dispose'])
  })

  it('does not register a partial contribution when Remote mounting fails', async () => {
    const ctx = {
      remote: { $mount: async () => { throw new Error('mount failed') } },
      uiConversation: { events: { register: () => { throw new Error('must not register') } } },
    } as never
    await expect(apply(ctx)).rejects.toThrow('mount failed')
  })
})
