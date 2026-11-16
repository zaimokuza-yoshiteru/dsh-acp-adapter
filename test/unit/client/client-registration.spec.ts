import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { independentSessionNavigation } from '../../../src/client/coordinator/native-session-navigation.ts'
import { apply, inject } from '../../../src/client/index.ts'

describe('client contribution', () => {
  it('declares the plugin detail, audit, and conversation seams', () => {
    expect(inject).toEqual([
      'uiConversation',
      'slots',
      'locale',
      'remote',
      'remoteAccess',
      'sessions',
      'workspaces',
      'uiWorkspace',
      'sidebarRight',
      'configForms',
      'remote.settings',
      'remote.session',
      'remote.workspace',
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
      ['conversation.input.model', [{ name: 'conversation.input.model', priority: 0, id: 'native-model-selector' }]],
    ])
    const lifecycle: string[] = []
    const child = Promise.withResolvers<SessionId>()
    const openSession = vi.fn()
    let mayReadChild = false
    const sessions = {
      create: vi.fn(() => child.promise),
      binding: () => undefined,
      list: {
        getSnapshot: () => ({
          byId: { source: { id: 'source', projectionValues: { agentPreset: 'cordis' } } },
          projectionsBySession: {},
        }),
        subscribe: () => () => {},
      },
    }
    const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', sessionIds: ['source'] }] }) } }
    const ctx = {
      on: () => () => {},
      remote: {
        $on: () => () => {},
        $mount: async () => {
          lifecycle.push('mount')
          return async () => {
            lifecycle.push('dispose')
          }
        },
        settings: { mutate: async () => ({ ok: true, value: null }) },
        dshAcp: {
          ownedProviderRoutes: async () => ({ ok: true, value: { providers: [], historicalProviders: [] } }),
        },
      },
      uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
      uiConversation: {
        events: {
          register: (definition: unknown) => {
            definitions.push(definition)
          },
        },
      },
      locale: { register: () => undefined, bind: () => (key: string) => key },
      configForms: {
        get: () => ({
          getSnapshot: () => ({ status: 'ready', value: { agents: {} }, revision: 1, writable: true }),
          subscribe: () => () => {},
        }),
      },
      sessions,
      remoteAccess: { source: () => ({ getSnapshot: () => mayReadChild }) },
      workspaces,
      uiWorkspace: { openSession },
      effect: (fn: () => unknown) => {
        void fn()
      },
      slots: {
        subscribe: () => () => {},
        entriesOfSlot: () => [],
        entries: () => [],
        inject: (name: string, factory: () => unknown) => {
          const entry = factory()
          injections.push(entry)
          slotEntries.set(name, [...(slotEntries.get(name) ?? []), entry])
        },
        register: (value: unknown) => value,
        registerFactory: () => () => {},
      },
      get: (name: string) =>
        name === 'sessions'
          ? sessions
          : name === 'workspaces'
            ? workspaces
            : name === 'remoteAccess'
              ? ctx.remoteAccess
              : undefined,
    }
    const uiInjects: string[][] = []
    Object.assign(ctx, {
      inject: (deps: readonly string[], callback: (scope: typeof ctx) => void | Promise<void>) => {
        uiInjects.push([...deps])
        // Model search and selection remain owned by the host's native composer.
        const started = Promise.resolve(callback(ctx))
        return Object.assign(started, {
          dispose: async () => {
            lifecycle.push('ui-dispose')
          },
        })
      },
    })
    const dispose = await apply(ctx as never)
    expect(lifecycle).toEqual(['mount'])
    expect(uiInjects).toEqual(
      expect.arrayContaining([
        [...inject, 'remote.dshAcp'],
        ['modelDirectories'],
        ['remote.subagents', 'uiSession'],
        ['uiSession'],
      ]),
    )
    expect(uiInjects).toHaveLength(4)
    expect(definitions).toHaveLength(4)
    expect(injections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'plugins.bundle.config', key: '@zaimokuza/dsh-acp-adapter' }),
        expect.objectContaining({ key: 'acp-activity' }),
        expect.objectContaining({ key: 'acp-inline-activity' }),
        expect.objectContaining({ id: 'dsh-acp-agent-control' }),
        expect.objectContaining({ name: 'conversation.input.dock', id: 'dsh-acp-unrouted-history' }),
      ]),
    )
    expect(injections).not.toContainEqual(expect.objectContaining({ name: 'settings.section' }))
    // No native Team contribution is mounted in this fixture. Child approvals
    // still register once; only Team management follows that optional surface.
    expect(injections.filter((entry) => (entry as { id?: string }).id === 'acp-team-approvals')).toHaveLength(1)
    expect(injections).not.toContainEqual(expect.objectContaining({ id: 'acp-team-management' }))
    expect(slotEntries.get('shell.overlay')).toEqual([
      { name: 'shell.overlay', id: 'third-party-overlay' },
      expect.objectContaining({ id: 'dsh-acp-native-fork-recovery' }),
      expect.objectContaining({ id: 'dsh-acp-cross-backend-confirmation' }),
      expect.objectContaining({ id: 'dsh-acp-operation-outcomes' }),
    ])
    expect(slotEntries.get('conversation.input.model')).toEqual([
      { name: 'conversation.input.model', priority: 0, id: 'native-model-selector' },
    ])
    const recovery = injections.find((entry) => (entry as { id?: string }).id === 'dsh-acp-recovery') as {
      inject(): { createNewSession: ReturnType<typeof independentSessionNavigation> }
    }
    const { createNewSession } = recovery.inject()
    let selected = true
    const create = createNewSession(SessionId('source'), () => selected, 'create')
    selected = false
    child.resolve(SessionId('published'))
    await create
    expect(openSession).not.toHaveBeenCalled()
    expect(await createNewSession(SessionId('source'), () => true, 'create')).toBe('open-failed')
    expect(openSession).not.toHaveBeenCalled()
    mayReadChild = true
    await createNewSession(SessionId('source'), () => true, 'create')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('published')
    expect(sessions.create).toHaveBeenCalledExactlyOnceWith({
      sessionId: expect.any(String),
      workspaceId: 'w',
      agentPreset: 'cordis',
    })
    await dispose()
    expect(lifecycle).toEqual(['mount', 'ui-dispose', 'dispose'])
  })

  it('does not register a partial contribution when Remote mounting fails', async () => {
    const ctx = {
      on: () => () => {},
      remote: {
        $mount: async () => {
          throw new Error('mount failed')
        },
      },
      uiConversation: {
        events: {
          register: () => {
            throw new Error('must not register')
          },
        },
      },
    } as never
    await expect(apply(ctx)).rejects.toThrow('mount failed')
  })
})
