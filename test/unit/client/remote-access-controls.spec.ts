import type { AcpOwnedRoutesView } from '../../../src/contract/remote.ts'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteAccessFrame } from '@deepseek-ai/dsh-api-remote-access'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, ...(children.length === 0 ? {} : { children }) },
  }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    return [index < hooks.values.length ? hooks.values[index] : initial, () => {}]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

import { UnroutedHistoryDock } from '../../../src/client/ui/UnroutedHistoryDock.ts'
import { UnsentModelSwitchInput } from '../../../src/client/ui/UnsentModelSwitchInput.ts'
import { AcpAgentControl } from '../../../src/client/ui/AcpAgentControl.ts'
import { AcpRecoveryDock } from '../../../src/client/ui/AcpRecoveryDock.ts'
import { ManagedModelRecovery } from '../../../src/client/ui/ManagedModelRecovery.ts'
import type { IndependentSessionOutcome } from '../../../src/client/coordinator/native-session-navigation.ts'
import { TeamMemberModelControl } from '../../../src/client/ui/TeamMemberModelControl.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'

// Exercise selection handlers with the same grant updates used by a mounted DSH client.
const require = createRequire(import.meta.url)
type NativeAccess = {
  global(action: string): HostObservable<boolean>
  resource(kind: string, id: string, action: string): HostObservable<boolean>
  replace(frame: Extract<RemoteAccessFrame, { type: 'baseline' }>): void
  update(frame: Exclude<RemoteAccessFrame, { type: 'baseline' }>): void
}
const { ClientAccessState } = (await import(
  pathToFileURL(
    join(dirname(require.resolve('@deepseek-ai/dsh-api-remote-access/package.json')), 'lib/types/client/state.js'),
  ).href
)) as { ClientAccessState: new (frame: Extract<RemoteAccessFrame, { type: 'baseline' }>) => NativeAccess }

type Tree = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function nodes(value: unknown): Tree[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (typeof value !== 'object' || value === null || !('props' in value)) return []
  const node = value as Tree
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer)]
}
function seed(values: unknown[]) {
  hooks.values = values
  hooks.cursor = 0
}
function grants(state: NativeAccess, id: string, actions: string[]) {
  state.update({ type: 'upsert', grant: { resource: { kind: 'session', id: id as never }, actions } })
}
const snapshot: AcpAgentSessionSnapshotView = {
  sessionId: 'lead',
  profileId: 'codex',
  freshness: 'live',
  editable: true,
  modes: [
    { id: 'code', name: 'Code' },
    { id: 'plan', name: 'Plan' },
  ],
  currentModeId: 'code',
  configOptions: null,
  contextUsage: null,
  note: null,
}
function setup(owner = false, workspace = true) {
  const state = new ClientAccessState(
    owner ? { type: 'baseline', owner: true } : { type: 'baseline', owner: false, grants: [] },
  )
  const sessionAccessSource = (id: string, action: string) => state.resource('session', id, action)
  const remote = {
    setAgentSessionOption: vi.fn(async () => ({ ok: true, value: snapshot })),
    setToolApprovalPolicy: vi.fn(async () => ({ ok: true, value: null })),
    setTeamMemberModel: vi.fn(async () => ({ ok: true, value: null })),
    retryOriginal: vi.fn(async () => ({ ok: true, value: undefined })),
    rebindRecoveryBlank: vi.fn(async () => ({ ok: true, value: undefined })),
  }
  const createNewSession = vi.fn(async () => 'idle' as const)
  const managedRecovery = (model: NonNullable<AcpAgentSessionSnapshotView['managedModel']>) => {
    seed([
      {
        ...snapshot,
        managedModel: model,
        configOptions: [
          {
            type: 'select',
            id: 'engine',
            category: 'model',
            currentValue: 'b',
            options: [
              { value: 'a', name: 'Model A' },
              { value: 'b', name: 'Model B' },
            ],
          },
        ],
      },
    ])
    return ManagedModelRecovery({
      sessionId: 'lead',
      remote,
      t: (key: string) => key,
      writable: true,
      running: false,
      mayCreate: true,
      createNewSession,
      sessionAccessSource,
    } as never)
  }
  const common = {
    sessionId: 'lead',
    remote,
    sessionAccessSource,
    useAccess: (action: string) => sessionAccessSource('lead', action).getSnapshot(),
    useSessionAccess: (id: string, action: string) => sessionAccessSource(id, action).getSnapshot(),
    useRemoteAccess: (action: string) => state.global(action).getSnapshot(),
    useWorkspaceAccess: (id: string, action: string) => state.resource('workspace', id, action).getSnapshot(),
    useWorkspaces: (select: (value: object) => unknown) =>
      select({ items: workspace ? [{ workspaceId: 'workspace', sessionIds: ['lead'] }] : [] }),
    useSessions: (select: (value: object) => unknown) => select({ byId: { lead: { cwd: '/fixture' } } }),
    useSession: (select: (value: object) => unknown) => select({ running: false, openState: 'ready' }),
    useProjection: () => ({ lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } }),
    t: (key: string) => key,
    useRouteOwnership: (select: (value: AcpOwnedRoutesView) => unknown) =>
      select({ providers: ['acp-codex'], historicalProviders: [] }),
  }
  const control = () => {
    seed([
      undefined,
      0,
      snapshot,
      { sessionId: 'lead', policy: 'auto', source: 'session', editable: true },
      null,
      false,
      false,
      false,
      false,
      null,
      false,
      0,
    ])
    return AcpAgentControl({
      ...common,
      watchDefaultProvider: () => () => {},
      getDefaultProvider: async () => 'acp-codex',
      feedback: { report: vi.fn() },
    } as never) as Tree
  }
  const model = (status: 'inactive' | 'running' = 'inactive', blocked = false, memberBlocked = false) => {
    seed([
      false,
      {
        currentModel: 'a',
        pendingModel: null,
        writable: true,
        ...(blocked ? { unavailableReason: 'model-switch' } : {}),
        models: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      },
      false,
      false,
      null,
      0,
    ])
    return TeamMemberModelControl({
      ...common,
      lead: 'lead',
      member: {
        sessionId: 'child',
        profileId: 'codex',
        name: 'Child',
        model: 'a',
        modelWritable: true,
        ...(memberBlocked ? { modelUnavailableReason: 'model-switch' } : {}),
        status,
        description: null,
      },
      initialModel: 'a',
      sessionReady: true,
      isCurrent: () => true,
      onMenuOpen: () => {},
    } as never)
  }
  const recovery = (confirmRebind = false, navigation: IndependentSessionOutcome = 'idle') => {
    seed([
      { dshSessionId: 'lead', kind: 'outcome-unknown', cause: null, detail: null },
      true,
      null,
      null,
      false,
      false,
      false,
      false,
      0,
      confirmRebind,
      navigation,
    ])
    return AcpRecoveryDock({ ...common, createNewSession } as never)
  }
  const imported = (nativeModels: string[] = ['m']) => {
    seed([])
    return UnroutedHistoryDock({
      ...common,
      useSessionRetainInfo: (select: (value: object) => unknown) => select({ retainedBy: { mainView: 1 } }),
      useSession: (select: (value: object) => unknown) =>
        select({ openState: 'open', blank: false, running: false, removed: false, subagent: null }),
      useProjection: (id: string, select: (value: object) => unknown) =>
        select(id === 'acpExecution' ? { completedWithoutModel: true } : { next: null, lastUsed: null }),
      directory: {
        subscribe: () => () => {},
        getSnapshot: () => ({
          current: { provider: 'acp-codex', model: 'm' },
          status: 'ready',
          groups: [
            { id: 'acp-codex', models: ['m'] },
            { id: 'native', models: nativeModels },
          ],
        }),
      },
      openIndependent: createNewSession,
    } as never)
  }
  return { state, remote, control, model, recovery, managedRecovery, imported, createNewSession }
}
function groups(tree: Tree): { choices: { disabled: boolean; write: { kind: string } }[] }[] {
  return tree.props.groups as never
}
function select(tree: Tree, kind: string) {
  const choice = groups(tree)
    .flatMap((group) => group.choices)
    .find((item) => item.write.kind === kind)!
  ;(tree.props.onSelect as (choice: unknown) => void)(choice)
}
function modelMenu(value: unknown): Tree {
  return nodes(value).find((node) => Array.isArray(node.props.items))!
}
function recoveryButton(value: unknown, label: string): Tree {
  return nodes(value).find(
    (node) => typeof node.props.onClick === 'function' && (node.props.children as unknown[])?.includes(label),
  )!
}

it('recovers a possibly delivered message by changing only the model or opening a separate chat', async () => {
  const h = setup()
  const model = {
    optionId: 'engine',
    confirmed: 'b',
    lastSuccessfulModel: 'a',
    recovery: 'possibly-delivered' as const,
  }
  grants(h.state, 'lead', ['dshAcp/setAgentSessionOption', 'session/selectModel'])
  const view = h.managedRecovery(model)
  const labels = nodes(view).flatMap((node) => node.props.children ?? [])
  expect(labels).toContain('managedModelIncomplete')
  expect(labels).not.toContain('resendUnsentMessage')
  const switchBack = recoveryButton(view, 'managedModelRestore').props.onClick as () => void
  grants(h.state, 'lead', ['dshAcp/setAgentSessionOption'])
  switchBack()
  expect(h.remote.setAgentSessionOption).not.toHaveBeenCalled()
  grants(h.state, 'lead', ['dshAcp/setAgentSessionOption', 'session/selectModel'])
  switchBack()
  expect(h.remote.setAgentSessionOption).toHaveBeenCalledExactlyOnceWith('lead', {
    kind: 'config',
    id: 'engine',
    value: 'a',
  })
  const missing = h.managedRecovery({ ...model, lastSuccessfulModel: 'removed' })
  expect(nodes(missing).flatMap((node) => node.props.children ?? [])).not.toContain('managedModelRestore')
  ;(recoveryButton(missing, 'managedModelNew').props.onClick as () => void)()
  expect(h.createNewSession).toHaveBeenCalledExactlyOnceWith('lead', expect.any(Function), 'create')
  expect(h.managedRecovery({ optionId: 'engine', confirmed: 'b' })).toBeNull()
})

it('preserves owner mode and policy writes while read-only grants disable and block both handlers', async () => {
  for (const owner of [false, true]) {
    const h = setup(owner)
    const tree = h.control()
    expect(
      groups(tree)
        .flatMap((group) => group.choices)
        .every((item) => item.disabled === !owner),
    ).toBe(true)
    select(tree, 'mode')
    select(tree, 'tool-approval-policy')
    expect(h.remote.setAgentSessionOption).toHaveBeenCalledTimes(owner ? 1 : 0)
    expect(h.remote.setToolApprovalPolicy).toHaveBeenCalledTimes(owner ? 1 : 0)
    await Promise.resolve()
  }
})

it('rechecks actual grants in an already-open mode menu and updates after revocation and restoration', () => {
  const h = setup()
  const actions = ['dshAcp/setAgentSessionOption', 'dshAcp/setToolApprovalPolicy']
  grants(h.state, 'lead', actions)
  const opened = h.control()
  grants(h.state, 'lead', [])
  select(opened, 'mode')
  select(opened, 'tool-approval-policy')
  expect(h.remote.setAgentSessionOption).not.toHaveBeenCalled()
  expect(h.remote.setToolApprovalPolicy).not.toHaveBeenCalled()
  expect(
    groups(h.control())
      .flatMap((group) => group.choices)
      .every((item) => item.disabled),
  ).toBe(true)
  grants(h.state, 'lead', actions)
  const restored = h.control()
  expect(
    groups(restored)
      .flatMap((group) => group.choices)
      .some((item) => item.disabled),
  ).toBe(false)
  select(restored, 'mode')
  expect(h.remote.setAgentSessionOption).toHaveBeenCalledOnce()
})

it('requires both lead and child model-write grants and rechecks an open member menu before dispatch', () => {
  const h = setup()
  const action = ['dshAcp/setTeamMemberModel']
  grants(h.state, 'lead', action)
  expect((modelMenu(h.model()).props.items as { disabled: boolean }[]).every((item) => item.disabled)).toBe(true)
  grants(h.state, 'child', action)
  const opened = modelMenu(h.model())
  expect((opened.props.items as { disabled: boolean }[]).some((item) => item.disabled)).toBe(false)
  grants(h.state, 'lead', [])
  ;(opened.props.onSelect as (id: string) => void)('b')
  expect(h.remote.setTeamMemberModel).not.toHaveBeenCalled()
  grants(h.state, 'lead', action)
  ;(modelMenu(h.model()).props.onSelect as (id: string) => void)('b')
  expect(h.remote.setTeamMemberModel).toHaveBeenCalledExactlyOnceWith('lead', 'child', 'b')
})

it('keeps native owner model controls enabled without granting a busy member a write', () => {
  const h = setup(true)
  expect((modelMenu(h.model()).props.items as { disabled: boolean }[]).some((item) => item.disabled)).toBe(false)
  const busy = modelMenu(h.model('running'))
  expect((busy.props.items as { disabled: boolean }[]).every((item) => item.disabled)).toBe(true)
  ;(busy.props.onSelect as (id: string) => void)('b')
  expect(h.remote.setTeamMemberModel).not.toHaveBeenCalled()
})

it('explains member model-switch refusal and permits only restoring the current model', () => {
  for (const fromMember of [false, true]) {
    const h = setup(true)
    const menu = modelMenu(h.model('inactive', !fromMember, fromMember))
    expect(menu.props.items).toEqual([
      { id: 'a', label: 'A', disabled: false },
      { id: 'b', label: 'B', disabled: true },
    ])
    expect(menu.props.footer).toEqual([{ type: 'label', id: 'read-only', text: 'teamModelSwitchUnavailable' }])
    ;(menu.props.onSelect as (id: string) => void)('b')
    expect(h.remote.setTeamMemberModel).not.toHaveBeenCalled()
    ;(menu.props.onSelect as (id: string) => void)('a')
    expect(h.remote.setTeamMemberModel).toHaveBeenCalledExactlyOnceWith('lead', 'child', 'a')
  }
})

it('requires confirmation before blank rebind and rechecks grants at the final confirmation', () => {
  const h = setup()
  grants(h.state, 'lead', ['dshAcp/rebindRecoveryBlank'])
  ;(recoveryButton(h.recovery(), 'recoveryRebind').props.onClick as () => void)()
  expect(h.remote.rebindRecoveryBlank).not.toHaveBeenCalled()
  const confirmation = recoveryButton(h.recovery(true), 'recoveryRebindConfirm')
  grants(h.state, 'lead', [])
  ;(confirmation.props.onClick as () => void)()
  expect(h.remote.rebindRecoveryBlank).not.toHaveBeenCalled()
  grants(h.state, 'lead', ['dshAcp/rebindRecoveryBlank'])
  ;(recoveryButton(h.recovery(true), 'recoveryRebindConfirm').props.onClick as () => void)()
  expect(h.remote.rebindRecoveryBlank).toHaveBeenCalledExactlyOnceWith('lead')
})

it('disables ACP recovery writes for a reader and rechecks a previously opened recovery action', async () => {
  const h = setup()
  for (const [label, method] of [
    ['recoveryReconnect', 'retryOriginal'],
    ['recoveryRebind', 'rebindRecoveryBlank'],
  ] as const) {
    const button = recoveryButton(h.recovery(), label)
    expect(button.props.disabled).toBe(true)
    ;(button.props.onClick as () => void)()
    expect(h.remote[method]).not.toHaveBeenCalled()
  }
  grants(h.state, 'lead', ['dshAcp/retryOriginal', 'dshAcp/rebindRecoveryBlank'])
  const allowed = h.recovery()
  const reconnect = recoveryButton(allowed, 'recoveryReconnect')
  expect(reconnect.props.disabled).toBe(false)
  grants(h.state, 'lead', [])
  ;(reconnect.props.onClick as () => void)()
  expect(h.remote.retryOriginal).not.toHaveBeenCalled()
  grants(h.state, 'lead', ['dshAcp/retryOriginal'])
  ;(recoveryButton(h.recovery(), 'recoveryReconnect').props.onClick as () => void)()
  expect(h.remote.retryOriginal).toHaveBeenCalledOnce()
  await Promise.resolve()
})

it('uses the destination workspace or global create grant instead of the source session grant', () => {
  for (const workspace of [false, true]) {
    const h = setup(false, workspace)
    grants(h.state, 'lead', ['session/create'])
    const denied = recoveryButton(h.recovery(), 'recoveryNew')
    expect(denied.props.disabled).toBe(true)
    ;(denied.props.onClick as () => void)()
    expect(h.createNewSession).not.toHaveBeenCalled()
    h.state.update({
      type: 'upsert',
      grant: {
        resource: workspace ? { kind: 'workspace', id: 'workspace' as never } : { kind: 'global' },
        actions: ['session/create'],
      },
    })
    const allowed = recoveryButton(h.recovery(), 'recoveryNew')
    expect(allowed.props.disabled).toBe(false)
    ;(allowed.props.onClick as () => void)()
    expect(h.createNewSession).toHaveBeenCalledExactlyOnceWith('lead', expect.any(Function), 'create')
  }
})

it('offers opening the existing ungrouped session after a recovery attachment failure', () => {
  const h = setup(true)
  const view = h.recovery(false, 'ungrouped')
  const labels = nodes(view).flatMap((node) => node.props.children ?? [])
  expect(labels).toContain('unroutedHistoryUngrouped')
  expect(labels).not.toContain('recoveryNew')
  ;(recoveryButton(view, 'unroutedHistoryOpen').props.onClick as () => void)()
  expect(h.createNewSession).toHaveBeenCalledExactlyOnceWith('lead', expect.any(Function), 'open-existing')
})

it('offers the default mode as an explicit alternate recovery action when the original mode is unavailable', () => {
  const h = setup(true)
  const view = h.recovery(false, 'preset-unavailable')
  const button = recoveryButton(view, 'independentUseDefault')
  expect(nodes(view).flatMap((node) => node.props.children ?? [])).toContain('independentPresetUnavailable')
  ;(button.props.onClick as () => void)()
  expect(h.createNewSession).toHaveBeenCalledExactlyOnceWith('lead', expect.any(Function), 'use-default')
})

it('offers only available model and creation actions in an imported history', () => {
  const h = setup()
  const keys = (view: unknown) => nodes(view).flatMap((node) => node.props.children ?? [])
  expect(h.imported()).toBeNull()
  grants(h.state, 'lead', ['session/selectModel'])
  expect(keys(h.imported())).toContain('unroutedHistoryHint')
  expect(keys(h.imported())).not.toContain('crossBackendContinue')
  expect(h.imported([])).toBeNull()
  h.state.update({
    type: 'upsert',
    grant: {
      resource: { kind: 'workspace', id: 'workspace' as never },
      actions: ['session/create'],
    },
  })
  expect(keys(h.imported())).toContain('crossBackendContinue')
  expect(keys(h.imported([]))).toContain('unroutedHistoryCreateOnly')
  grants(h.state, 'lead', [])
  expect(keys(h.imported())).toContain('unroutedHistoryCreateOnly')
  expect(keys(h.imported())).toContain('crossBackendContinue')
})

it('shows a resend action only for a failed switch with permission to send, and submits its ticket once', async () => {
  const { state } = setup()
  const remote = { retryModelSwitchInput: vi.fn(async () => ({ ok: true })) }
  const render = (failureSeq?: number) => {
    seed([])
    return UnsentModelSwitchInput({
      sessionId: 'lead',
      useAccess: (action: string) => state.resource('session', 'lead', action).getSnapshot(),
      useProjection: (_key: string, select: (value: object) => unknown) =>
        select(failureSeq === undefined ? {} : { unsentModelSwitch: { failureSeq } }),
      useSession: (select: (value: object) => unknown) => select({ running: false }),
      remote,
      t: (key: string) => key,
    } as never)
  }
  for (const action of ['session/prompt', 'dshAcp/retryModelSwitchInput']) {
    grants(state, 'lead', [action])
    expect(render(42)).toBeNull()
  }
  grants(state, 'lead', ['session/prompt', 'dshAcp/retryModelSwitchInput'])
  expect(render()).toBeNull()
  const element = render(42) as Tree
  const button = recoveryButton((element.type as (props: object) => unknown)(element.props), 'resendUnsentMessage')
  const retry = button.props.onClick as () => Promise<void>
  await Promise.all([retry(), retry()])
  expect(remote.retryModelSwitchInput).toHaveBeenCalledExactlyOnceWith('lead', 42)
})
