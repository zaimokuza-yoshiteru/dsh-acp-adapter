import { afterEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  active: false,
  cursor: 0,
  values: [] as unknown[],
  effects: [] as (() => unknown)[],
}))

vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }),
  useEffect: (effect: () => unknown) => {
    if (hooks.active) hooks.effects.push(effect)
  },
  useRef: (current: unknown) => {
    if (!hooks.active) return { current }
    const slot = hooks.cursor++
    if (!(slot in hooks.values)) hooks.values[slot] = { current }
    return hooks.values[slot]
  },
  useState: (initial: unknown) => {
    const value = typeof initial === 'function' ? (initial as () => unknown)() : initial
    if (!hooks.active) return [value, () => {}]
    const slot = hooks.cursor++
    if (!(slot in hooks.values)) hooks.values[slot] = value
    return [
      hooks.values[slot],
      (next: unknown) => {
        hooks.values[slot] = next
      },
    ]
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

import { AcpTeamApprovals } from '../../../src/client/ui/AcpTeamApprovals.ts'
import type { AcpApprovalChildView } from '../../../src/client/data/acp-remote.ts'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (value: string) => value as SessionId
afterEach(() => {
  hooks.active = false
  hooks.cursor = 0
  hooks.values = []
  hooks.effects = []
})
const pending = (id: string) => ({
  key: `request:${id}`,
  sessionId: sid(id),
  kind: 'approval',
  toolName: 'bash',
  answer: vi.fn(async () => {}),
})
function statusSnapshot(entries: readonly (readonly [string, ReturnType<typeof pending>])[]): SessionStatusSnapshot {
  return new Map(
    entries.map(([id, interaction]) => [
      sid(id),
      { running: false, pendingInteraction: interaction, completionUnread: false },
    ]),
  ) as never
}
function projection(
  members: readonly { id: string; name: string; role: 'lead' | 'teammate'; phase: 'active' }[],
  failure?: string,
): TeamProjection {
  return {
    members: members.map((member) => ({ ...member, id: sid(member.id) })),
    tasks: [],
    ...(failure === undefined ? {} : { failure }),
  }
}
function textContent(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(textContent)
  if (typeof node !== 'object' || node === null) return []
  const element = node as { props?: { children?: unknown } }
  return textContent(element.props?.children)
}
function renderApprovals(
  team: TeamProjection | undefined,
  statuses: SessionStatusSnapshot,
  nativeChild = false,
  options: {
    children?: readonly AcpApprovalChildView[]
    openMember?: (parent: SessionId, child: AcpApprovalChildView) => Promise<void>
  } = {},
) {
  hooks.cursor = 0
  const children =
    options.children ??
    [...statuses.keys()].map((id) => ({
      sessionId: id,
      parentSessionId: 'lead',
      name: id,
      mode: 'continuable' as const,
      path: [{ sessionId: id, name: id }],
    }))
  const props = {
    sessionId: sid('lead'),
    useSession: (selector: (state: { openState: string; subagent?: undefined }) => unknown) =>
      selector({ openState: 'ready' }),
    useSessions: (selector: (state: unknown) => unknown) =>
      selector({
        phase: 'ready',
        byId: nativeChild
          ? {
              lead: { id: sid('lead') },
              ...Object.fromEntries(
                children.map((child) => [
                  child.sessionId,
                  { id: child.sessionId, parentId: sid('lead'), origin: 'subagent' },
                ]),
              ),
            }
          : {},
        projectionsBySession: {},
      }),
    useProjection: (key: string) =>
      key === 'modelSelection'
        ? {
            lastUsed: { provider: nativeChild ? 'native' : 'acp-devin' },
            next: { provider: nativeChild ? 'native' : 'acp-devin' },
          }
        : team,
    t: (key: string) => key,
    status: { subscribe: () => () => {}, getSnapshot: () => statuses },
    ownsRoute: (provider: string | undefined) => provider === 'acp-devin',
    loadChildren: async () => children,
    isCurrent: () => true,
    openMember: options.openMember ?? (async () => {}),
    resolveReason: () => undefined,
  }
  return AcpTeamApprovals(props as never)
}

it('does not hide a managed child request because its parent uses a native model and Teams is absent', () => {
  const tree = renderApprovals(undefined, statusSnapshot([['member', pending('member')]]), true)
  expect(textContent(tree)).toContain('teamPendingLoading')
})

it.each([1, 2])('shows batch actions only for multiple approvals (%i pending)', async (count) => {
  hooks.active = true
  const statuses = statusSnapshot(
    Array.from({ length: count }, (_, index) => {
      const id = `member-${index}`
      return [id, pending(id)] as const
    }),
  )
  renderApprovals(undefined, statuses, true)
  for (const effect of hooks.effects.splice(0)) effect()
  await vi.waitFor(() => {
    const content = textContent(renderApprovals(undefined, statuses, true))
    expect(content.filter((text) => text === 'teamAllowOnce')).toHaveLength(count)
    expect(content.filter((text) => text === 'teamReject')).toHaveLength(count)
    for (const batchContent of ['teamAllowAll', 'teamRejectAll', 'teamBatchHint'])
      expect(content.includes(batchContent)).toBe(count > 1)
  })
})

it('shows compact, distinct nested identities while retaining full accessible identities and navigation targets', async () => {
  hooks.active = true
  const parentId = '87654321-1111-4444-aaaa-000000000001'
  const ids = ['12345678-a111-4444-aaaa-000000000001', '12345678-b111-4444-aaaa-000000000002']
  const children = ids.map((id) => ({
    sessionId: id,
    parentSessionId: parentId,
    name: 'Worker',
    mode: 'continuable' as const,
    path: [
      { sessionId: parentId, name: 'Reviewer' },
      { sessionId: id, name: 'Worker' },
    ],
  }))
  const statuses = statusSnapshot(ids.map((id) => [id, pending(id)] as const))
  const openMember = vi.fn(async () => {})
  const render = () => renderApprovals(undefined, statuses, true, { children, openMember })
  type Element = { type: unknown; props: Record<string, unknown> }
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements)
    if (node === null || typeof node !== 'object' || !('props' in node)) return []
    const element = node as Element
    return [element, ...elements(element.props.children)]
  }
  render()
  for (const effect of hooks.effects.splice(0)) effect()
  await vi.waitFor(() => expect(textContent(render())).toContain('Reviewer · 87654321 › Worker · 12345678-a'))
  const tree = render()
  expect(textContent(tree)).toContain('Reviewer · 87654321 › Worker · 12345678-b')
  for (const id of ids) {
    const source = `Reviewer (${parentId}) › Worker (${id})`
    expect(elements(tree).some((element) => element.type === 'span' && element.props.title === source)).toBe(true)
    expect(elements(tree).some((element) => element.type === 'li' && element.props['aria-label'] === source)).toBe(true)
    expect(textContent(tree).some((text) => text.includes(id))).toBe(false)
  }
  const open = elements(tree).filter((element) => element.props['aria-label'] === 'teamApprovalEntry')[0]!
  ;(open.props.onClick as () => void)()
  await vi.waitFor(() => expect(openMember).toHaveBeenCalledExactlyOnceWith(sid('lead'), children[0]))
})

it('does not show another Team’s pending request on an ordinary ACP session with no Team projection', () => {
  const tree = renderApprovals(undefined, statusSnapshot([['other-team-member', pending('other-team-member')]]))
  expect(tree).toBeNull()
})

it('does not treat a stale Team roster as runtime child ownership', () => {
  const team = projection(
    [
      { id: 'lead', name: 'Lead', role: 'lead', phase: 'active' },
      { id: 'member', name: 'Member', role: 'teammate', phase: 'active' },
    ],
    'invalid persisted team record',
  )
  const tree = renderApprovals(team, statusSnapshot([['member', pending('member')]]))
  const content = textContent(tree)
  expect(tree).toBeNull()
  expect(content).not.toContain('teamAllowOnce')
  expect(content).not.toContain('teamAllowAll')
})

it('does not use unrelated pending requests to surface a failed Team projection', () => {
  const team = projection(
    [{ id: 'lead', name: 'Lead', role: 'lead', phase: 'active' }],
    'invalid persisted team record',
  )
  const tree = renderApprovals(team, statusSnapshot([['other-team-member', pending('other-team-member')]]))
  expect(tree).toBeNull()
})
