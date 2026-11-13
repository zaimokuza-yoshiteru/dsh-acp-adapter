import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

const hooks = vi.hoisted(() => ({
  cursor: 0,
  cells: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
}))

// Drive actual asynchronous UI handlers with the direct namespace binding contract:
// one stable translator reads a different dictionary after a locale change.
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, ...(children.length ? { children } : {}) },
  }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === 'function' ? initial() : initial
    return [
      hooks.cells[index],
      (next: unknown) => {
        hooks.cells[index] = typeof next === 'function' ? next(hooks.cells[index]) : next
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = { current: initial }
    return hooks.cells[index]
  },
  useMemo: (read: () => unknown, dependencies: readonly unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.cells[index] as { dependencies: readonly unknown[]; value: unknown } | undefined
    if (
      previous !== undefined &&
      dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))
    )
      return previous.value
    const value = read()
    hooks.cells[index] = { dependencies, value }
    return value
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => (() => void) | undefined, dependencies: readonly unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.cells[index] as readonly unknown[] | undefined
    if (previous !== undefined && dependencies.every((value, position) => Object.is(value, previous[position]))) return
    hooks.cells[index] = dependencies
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.()
      const cleanup = effect()
      if (cleanup === undefined) hooks.cleanups.delete(index)
      else hooks.cleanups.set(index, cleanup)
    })
  },
}))

import { createAcpAuditView } from '../../../src/client/ui/AcpAuditHeaderAction.ts'
import { AcpTeamApprovals } from '../../../src/client/ui/AcpTeamApprovals.ts'
import { AcpSection, type AcpSectionWire } from '../../../src/client/ui/AcpSection.ts'
import type { AcpPanelSnapshot } from '../../../src/client/data/stores/panel-store.ts'
import { en, zh, type AcpLocaleKey } from '../../../src/client/ui/locales.ts'

type Element = { type: unknown; props: Record<string, unknown> }
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}
function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join(' ')
  return typeof node === 'object' && node !== null && 'props' in node ? text((node as Element).props.children) : ''
}
function render(component: () => unknown): unknown {
  let tree: unknown
  for (let pass = 0; pass < 2; pass++) {
    hooks.cursor = 0
    tree = component()
    for (const effect of hooks.effects.splice(0)) effect()
  }
  return tree
}
function unwrap(component: () => unknown): unknown {
  let tree = component() as Element
  while (typeof tree.type === 'function') tree = tree.type(tree.props) as Element
  return tree
}
function locale() {
  let dictionary = en
  return {
    t: (key: AcpLocaleKey, params?: Record<string, unknown>) => {
      let copy = dictionary[key]
      for (const [name, value] of Object.entries(params ?? {})) copy = copy.replaceAll(`{${name}}`, String(value))
      return copy
    },
    switch: () => {
      dictionary = zh
    },
  }
}
function reset() {
  for (const cleanup of hooks.cleanups.values()) cleanup()
  hooks.cursor = 0
  hooks.cells = []
  hooks.effects = []
  hooks.cleanups.clear()
}
afterEach(reset)

it('translates a retained diagnostic read failure without rereading or clearing the current view', async () => {
  const copy = locale()
  const remote = {
    auditTimeline: vi.fn(async () => ({ ok: false, error: { message: 'PRIVATE_HOST_FAILURE' } })),
    recoverySnapshot: vi.fn(async () => ({ ok: true, value: { kind: 'healthy' } })),
  }
  const view = createAcpAuditView(remote as never)
  const current = () => render(() => unwrap(() => view({ sessionId: 'session', t: copy.t } as never)))
  current()
  await vi.waitFor(() => expect(text(current())).toContain(en.auditUnavailable))
  copy.switch()
  const translated = text(current())
  expect(translated).toContain(zh.auditUnavailable)
  expect(translated).not.toContain(en.auditUnavailable)
  expect(translated).not.toContain('PRIVATE_HOST_FAILURE')
  expect(remote.auditTimeline).toHaveBeenCalledOnce()
  expect(remote.recoverySnapshot).toHaveBeenCalledOnce()
})

it('translates an existing team approval error without restarting the member read', async () => {
  const copy = locale()
  const pending = { key: 'request', kind: 'approval', sessionId: 'child', toolName: 'bash', answer: vi.fn() }
  const statuses = new Map([['child', { pendingInteraction: pending }]])
  const loadChildren = vi.fn(async () => {
    throw { code: 'remote-access/denied' }
  })
  const props = {
    sessionId: 'lead',
    t: copy.t,
    useSessions: (select: (state: unknown) => unknown) =>
      select({
        byId: { lead: {}, child: { parentId: 'lead', origin: 'subagent' } },
        projectionsBySession: {},
      }),
    status: { subscribe: () => () => {}, getSnapshot: () => statuses },
    loadChildren,
    isCurrent: () => true,
    openMember: vi.fn(),
    resolveReason: () => undefined,
  } as unknown as ComponentProps<typeof AcpTeamApprovals>
  const current = () => render(() => AcpTeamApprovals(props))
  current()
  await vi.waitFor(() => expect(text(current())).toContain(en.teamApprovalLoadFailed))
  copy.switch()
  expect(text(current())).toContain(zh.teamApprovalLoadFailed)
  expect(text(current())).not.toContain(en.teamApprovalLoadFailed)
  expect(loadChildren).toHaveBeenCalledOnce()
})

it.each(['save', 'delete'] as const)(
  'translates a retained %s failure while preserving the configured Agent',
  async (operation) => {
    const copy = locale()
    const snapshot: AcpPanelSnapshot = {
      settings: {
        status: 'ready',
        writable: true,
        agents: { custom: { name: 'Private Agent', command: 'my-agent', args: [], env: {} } },
        toolApprovalDefault: 'auto',
        revision: 1,
      },
      health: { status: 'ready', rows: [], fetchedAt: 1, message: undefined, checkingAgentIds: [], agentErrors: {} },
    }
    const panel: AcpSectionWire = {
      refreshHealth: vi.fn(),
      refreshAgentHealth: vi.fn(),
      saveAgent: vi.fn(async () => 'PRIVATE_HOST_FAILURE ACP_SAVE_FAILED'),
      deleteAgent: vi.fn(async () => 'PRIVATE_HOST_FAILURE ACP_DELETE_FAILED'),
      countBoundSessions: vi.fn(async () => 0),
      setToolApprovalDefault: vi.fn(),
    }
    const section = AcpSection({ t: copy.t, useStore: (select) => select(snapshot), panel }) as Element
    const loaded = () => (section.type as (props: unknown) => unknown)(section.props)
    const agent = elements(render(loaded)).find(
      (node) => typeof node.type === 'function' && node.props.id === 'custom',
    )!
    reset()
    const card = () => (agent.type as (props: unknown) => unknown)(agent.props)
    let current = () => render(card)
    if (operation === 'delete') {
      const remove = elements(current()).find(
        (node) => text(node) === en.remove && typeof node.props.onClick === 'function',
      )!
      ;(remove.props.onClick as () => void)()
      const confirm = elements(current())
        .filter((node) => text(node) === en.remove && typeof node.props.onClick === 'function')
        .at(-1)!
      ;(confirm.props.onClick as () => void)()
    } else {
      const edited = { ...agent.props, editing: true }
      const tree = render(() => (agent.type as (props: unknown) => unknown)(edited))
      const editor = elements(tree).find((node) => typeof node.type === 'function' && node.props.initial !== undefined)!
      reset()
      current = () => render(() => (editor.type as (props: unknown) => unknown)(editor.props))
      const save = elements(current()).find(
        (node) => text(node) === en.save && typeof node.props.onClick === 'function',
      )!
      ;(save.props.onClick as () => void)()
    }
    const key = operation === 'save' ? 'actionSaveFailed' : 'actionDeleteFailed'
    const reference = operation === 'save' ? 'ACP_SAVE_FAILED' : 'ACP_DELETE_FAILED'
    await vi.waitFor(() => expect(text(current())).toContain(en[key].replace('{reference}', ` (${reference})`)))
    copy.switch()
    const translated = text(current())
    expect(translated).toContain(zh[key].replace('{reference}', ` (${reference})`))
    expect(translated).not.toContain('PRIVATE_HOST_FAILURE')
    expect(snapshot.settings.status === 'ready' && snapshot.settings.agents.custom?.name).toBe('Private Agent')
    expect(operation === 'save' ? panel.saveAgent : panel.deleteAgent).toHaveBeenCalledOnce()
  },
)

it('recomputes diagnostic search against the current language with a stable translator', async () => {
  const copy = locale()
  const remote = {
    auditTimeline: vi.fn(async () => ({
      ok: true,
      value: {
        entries: [
          {
            seq: 1,
            time: 1,
            kind: 'filesystem',
            severity: 'error',
            category: 'files',
            summaryCode: 'filesystem.operation',
            subject: null,
            status: null,
            detail: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    })),
    recoverySnapshot: vi.fn(async () => ({ ok: true, value: { kind: 'healthy' } })),
  }
  const view = createAcpAuditView(remote as never)
  const current = () => render(() => unwrap(() => view({ sessionId: 'session', t: copy.t } as never)))
  current()
  await vi.waitFor(() => expect(text(current())).toContain('Filesystem operation recorded'))
  const search = elements(current()).find((node) => node.props.type === 'search')!
  ;(search.props.onChange as (event: unknown) => void)({ currentTarget: { value: 'Filesystem operation recorded' } })
  expect(elements(current()).filter((node) => node.type === 'tr')).toHaveLength(1)
  copy.switch()
  expect(elements(current()).filter((node) => node.type === 'tr')).toHaveLength(0)
  expect(text(current())).toContain(zh.auditNoMatch)
  expect(remote.auditTimeline).toHaveBeenCalledOnce()
})
