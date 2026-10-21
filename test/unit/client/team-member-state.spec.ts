import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => vi.unstubAllGlobals())
const state = vi.hoisted(() => ({ index: 0 }))
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, children },
  }),
  useState: (initial: unknown) => [
    state.index++ === 0 ? true : typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => {},
  ],
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
}))
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  StateDot: 'StateDot',
  MenuSurface: 'MenuSurface',
  IconCloseOutlineMedium: 'Close',
  IconRefreshOutlineMedium: 'Refresh',
  IconUsersOutlineMedium: 'Users',
  useAnchoredPosition: () => ({}),
  useDismissOnOutsidePointer: () => {},
  focusWithoutRing: () => {},
}))
vi.mock('../../../src/client/ui/AgentSessionMenu.ts', () => ({ AgentSessionMenu: 'AgentSessionMenu' }))
vi.mock('../../../src/client/ui/TeamMemberModelControl.ts', () => ({
  TeamMemberModelControl: 'TeamMemberModelControl',
}))
import { AcpTeamManagement } from '../../../src/client/ui/AcpTeamManagement.ts'
type Node = { type: string | ((props: unknown) => unknown); props: Record<string, unknown> }
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}
function flatten(value: unknown): Node[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (!isNode(value)) return []
  if (typeof value.type === 'function') return flatten(value.type(value.props))
  return [value, ...flatten(value.props.children)]
}
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).join(' ')
  if (!isNode(value)) return ''
  return text(value.props.children)
}
function render(phase: 'active' | 'failed' | 'provisioning') {
  state.index = 0
  vi.stubGlobal('document', { body: {} })
  const row = {
    id: 'member',
    name: 'Worker',
    role: 'teammate',
    phase,
    error: phase === 'failed' ? 'NATIVE_CREATION_ERROR' : undefined,
  }
  return AcpTeamManagement({
    sessionId: 'lead',
    useSession: (fn: (snapshot: unknown) => unknown) => fn({ openState: 'ready' }),
    useSessions: (fn: (snapshot: unknown) => unknown) =>
      fn({ phase: 'ready', byId: { member: { running: false } }, projectionsBySession: {} }),
    useProjection: (key: string) =>
      key === 'modelSelection' ? { next: { provider: 'acp-devin' } } : { members: [row], tasks: [] },
    useRemoteAccess: () => true,
    useSessionAccess: () => true,
    ownsRoute: (provider: string) => provider === 'acp-devin',
    status: { subscribe: () => () => {}, getSnapshot: () => new Map([['member', { running: false }]]) },
    t: (key: string) => key,
    remote: {},
    streamFactory: {},
    isCurrent: () => true,
    interruptMember: async () => {},
    loadMembers: async () => [],
    openMember: async () => {},
    sessionAccessSource: () => ({ subscribe: () => () => {}, getSnapshot: () => true }),
  } as never)
}
it('keeps inactive neutral and unavailable member navigation disabled with the native diagnostic', () => {
  const results = (['active', 'failed', 'provisioning'] as const).map((phase) => {
    const nodes = flatten(render(phase))
    const entry = nodes.find((node) => node.props['aria-label'] === 'teamMemberOpen')!
    return {
      phase,
      stateDot: nodes.find((node) => node.type === 'StateDot')?.props.state,
      openDisabled: entry.props.disabled === true,
      diagnosticVisible: nodes.some((node) => text(node).includes('NATIVE_CREATION_ERROR')),
    }
  })
  expect(results).toEqual([
    { phase: 'active', stateDot: 'idle', openDisabled: false, diagnosticVisible: false },
    { phase: 'failed', stateDot: 'error', openDisabled: true, diagnosticVisible: true },
    { phase: 'provisioning', stateDot: 'ongoing', openDisabled: true, diagnosticVisible: false },
  ])
})
