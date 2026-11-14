import { afterEach, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({
  active: false,
  index: 0,
  values: [] as unknown[],
  effects: [] as (() => unknown)[],
}))
const modalKeyboard = vi.hoisted(() => ({
  close: vi.fn(),
  guards: vi.fn(() => false),
  dispose: vi.fn(),
}))
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, ...(children.length === 0 ? {} : { children }) },
  }),
  useState: (initial: unknown) => {
    const value = typeof initial === 'function' ? (initial as () => unknown)() : initial
    if (!hooks.active) return [value, () => {}]
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = value
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] =
          typeof next === 'function' ? (next as (old: unknown) => unknown)(hooks.values[index]) : next
      },
    ]
  },
  useEffect: (effect: () => unknown) => {
    if (hooks.active) hooks.effects.push(effect)
  },
  useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  Modal: 'Modal',
  StateDot: 'StateDot',
  closeTopModal: modalKeyboard.close,
  observeComposition: () => ({ guards: modalKeyboard.guards, dispose: modalKeyboard.dispose }),
}))
vi.mock('../../../src/client/ui/AgentSessionMenu.ts', () => ({ AgentSessionMenu: 'AgentSessionMenu' }))
vi.mock('../../../src/client/ui/TeamMemberModelControl.ts', () => ({
  TeamMemberModelControl: 'TeamMemberModelControl',
}))
import {
  AcpTeamManagement,
  AcpTeamManagementAction,
  AcpTeamManagementOverlay,
} from '../../../src/client/ui/AcpTeamManagement.ts'
import { projectionRevision } from '../../../src/client/ui/team-projection.ts'
import type { AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'

afterEach(() => {
  hooks.active = false
  hooks.index = 0
  hooks.values = []
  hooks.effects = []
  modalKeyboard.close.mockClear()
  modalKeyboard.guards.mockReset().mockReturnValue(false)
  modalKeyboard.dispose.mockClear()
  vi.unstubAllGlobals()
})
type Node = { type: string | ((props: unknown) => unknown); props: Record<string, unknown> }
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}
function flatten(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (!isNode(value)) return []
  if (typeof value.type === 'function') return flatten(value.type(value.props))
  return [value, ...flatten(value.props.children), ...flatten(value.props.footer)]
}
const member: AcpTeamMemberView = {
  sessionId: 'member',
  name: 'worker/reviewer',
  profileId: 'codex',
  status: 'inactive',
  model: null,
  description: null,
}
function render(running: boolean | undefined, granted = true) {
  const state = { projectionsBySession: {}, byId: { member: { running } } }
  const runtimeFacts = JSON.stringify([['member', running, undefined]])
  hooks.active = true
  hooks.index = 0
  hooks.values = [
    0,
    {
      revision: projectionRevision('lead' as never, {}, () => [undefined, undefined]),
      runtimeRevision: JSON.stringify([runtimeFacts, ['member', undefined]]),
      members: [member],
    },
    false,
    false,
  ]
  const tree = AcpTeamManagement({
    sessionId: 'lead',
    useSessions: (select: (value: unknown) => unknown) => select(state),
    useSessionAccess: () => granted,
    status: { subscribe: () => () => {}, getSnapshot: () => new Map() },
    t: (key: string) => key,
    remote: {},
    streamFactory: {},
    isCurrent: () => true,
    interruptMember: vi.fn(),
    loadMembers: async () => [member],
    closeManagement: vi.fn(),
    sessionAccessSource: () => ({ subscribe: () => () => {}, getSnapshot: () => granted }),
  } as never)
  hooks.active = false
  return flatten(tree)
}

it('uses a native Modal and leaves member navigation and descriptions to the native catalog', () => {
  const nodes = render(false)
  expect(nodes[0]?.type).toBe('Modal')
  expect(nodes.some((node) => node.props['data-acp-team-panel'] === '')).toBe(true)
  expect(
    nodes.some(
      (node) =>
        node.type === 'Button' && Array.isArray(node.props.children) && node.props.children.includes(member.name),
    ),
  ).toBe(false)
  expect(nodes.find((node) => node.type === 'StateDot')?.props.state).toBe('idle')
  expect(nodes.find((node) => node.type === 'TeamMemberModelControl')?.props.member).toMatchObject({
    name: 'worker/reviewer',
  })
})

it('requires known runtime state and current target permission before offering interruption', () => {
  for (const [running, granted, expectedDisabled] of [
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [undefined, true, true],
  ] as const) {
    const nodes = render(running, granted)
    const interrupt = nodes.find(
      (node) => Array.isArray(node.props.children) && node.props.children.includes('teamInterruptAll'),
    )!
    expect(interrupt.props.disabled).toBe(expectedDisabled)
    expect(nodes.find((node) => node.type === 'StateDot')?.props.state).toBe(running ? 'ongoing' : 'idle')
    expect(
      nodes.some(
        (node) =>
          Array.isArray(node.props.children) &&
          node.props.children.includes(
            running === undefined ? 'teamStatusunknown' : running ? 'teamStatusrunning' : 'teamStatusinactive',
          ),
      ),
    ).toBe(true)
    expect(nodes.find((node) => node.type === 'TeamMemberModelControl')?.props.sessionReady).toBe(false)
  }
})

it('gives the native foreground Modal Escape before the catalog while preserving menus and IME', () => {
  const ownerDocument = {}
  vi.stubGlobal('document', ownerDocument)
  const modal = render(false)[0]!
  const releaseComposition = hooks.effects[0]!() as () => void
  const capture = modal.props.onKeyDownCapture as (event: unknown) => void
  const event = (overrides = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    nativeEvent: {},
    currentTarget: { ownerDocument },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  })
  const escape = event()
  capture(escape)
  expect(modalKeyboard.close).toHaveBeenCalledExactlyOnceWith(ownerDocument)
  expect(escape.preventDefault).toHaveBeenCalledOnce()
  expect(escape.stopPropagation).toHaveBeenCalledOnce()
  modalKeyboard.close.mockClear()

  for (const skipped of [
    event({ defaultPrevented: true }), // Native menu document-capture handler already owns it.
    event({ key: 'Tab' }),
    event({ ctrlKey: true }),
    event({ altKey: true }),
    event({ metaKey: true }),
    event({ shiftKey: true }),
  ]) {
    capture(skipped)
    expect(skipped.preventDefault).not.toHaveBeenCalled()
    expect(skipped.stopPropagation).not.toHaveBeenCalled()
  }
  // The native observer also guards a late closing key after compositionend,
  // when KeyboardEvent.isComposing alone would already be false.
  modalKeyboard.guards.mockReturnValue(true)
  const composing = event({ nativeEvent: { isComposing: false } })
  capture(composing)
  expect(composing.preventDefault).not.toHaveBeenCalled()
  modalKeyboard.guards.mockReturnValue(false)
  capture(event({ repeat: true }))
  expect(modalKeyboard.close).not.toHaveBeenCalled()
  releaseComposition()
  expect(modalKeyboard.dispose).toHaveBeenCalledOnce()
})

it('offers settings for ACP descendants under a native root without a Team enabled projection', async () => {
  hooks.active = true
  const openManagement = vi.fn()
  const loadMembers = vi.fn(async () => [member])
  const props = {
    sessionId: 'native-root',
    useSessions: (select: (value: unknown) => unknown) => select({ projectionsBySession: {} }),
    loadMembers,
    status: { subscribe: () => () => {}, getSnapshot: () => new Map() },
    openManagement,
    t: (key: string) => key,
  }
  const renderAction = () => {
    hooks.index = 0
    return AcpTeamManagementAction(props as never)
  }
  expect(renderAction()).toBeNull()
  hooks.effects.shift()!()
  await vi.waitFor(() => expect(hooks.values[0]).toEqual({ sessionId: 'native-root', visible: true }))
  const button = flatten(renderAction()).find((node) => node.type === 'Button')!
  ;(button.props.onClick as () => void)()
  expect(openManagement).toHaveBeenCalledExactlyOnceWith('native-root')
  expect(loadMembers).toHaveBeenCalledExactlyOnceWith('native-root')
})

it('does not publish an action after its catalog contribution has unmounted', async () => {
  hooks.active = true
  let finish!: (members: AcpTeamMemberView[]) => void
  AcpTeamManagementAction({
    sessionId: 'lead',
    useSessions: (select: (value: unknown) => unknown) => select({ projectionsBySession: {} }),
    status: { subscribe: () => () => {}, getSnapshot: () => new Map() },
    loadMembers: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    openManagement: vi.fn(),
    t: (key: string) => key,
  } as never)
  const cleanup = hooks.effects.shift()!() as () => void
  cleanup()
  finish([member])
  await Promise.resolve()
  expect(hooks.values[0]).toBeNull()
})

it('binds the dialog to its requested root independently of the menu contribution', () => {
  const props = { useManagementRequest: (select: (id: string | null) => unknown) => select('lead') }
  const node = AcpTeamManagementOverlay(props as never) as Node
  expect(node.type).toBe(AcpTeamManagement)
  expect(node.props.sessionId).toBe('lead')
  expect(
    AcpTeamManagementOverlay({ useManagementRequest: (select: (id: null) => unknown) => select(null) } as never),
  ).toBeNull()
})
