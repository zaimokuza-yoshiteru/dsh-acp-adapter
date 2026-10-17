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
  useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

import { AcpAgentControl } from '../../../src/client/ui/AcpAgentControl.ts'
import { AcpRecoveryDock } from '../../../src/client/ui/AcpRecoveryDock.ts'
import { TeamMemberModelControl } from '../../../src/client/ui/TeamMemberModelControl.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'

// Use the installed RC1 grant producer, not a hand-written boolean permission
// stub. Element-tree tests inspect choices and handlers; browser E2E owns React
// effects, native menus and the mounted owner experience.
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
  return [node, ...nodes(node.props.children)]
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
  const createNewSession = vi.fn(async () => {})
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
    ownsRoute: (value: string) => value === 'acp-codex',
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
  const model = (status: 'inactive' | 'running' = 'inactive') => {
    seed([
      false,
      {
        currentModel: 'a',
        pendingModel: null,
        writable: true,
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
        status,
        description: null,
      },
      initialModel: 'a',
      sessionReady: true,
      isCurrent: () => true,
      onMenuOpen: () => {},
    } as never)
  }
  const recovery = () => {
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
    ])
    return AcpRecoveryDock({ ...common, createNewSession } as never)
  }
  return { state, remote, control, model, recovery, createNewSession }
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
    expect(h.createNewSession).toHaveBeenCalledExactlyOnceWith('lead')
  }
})
