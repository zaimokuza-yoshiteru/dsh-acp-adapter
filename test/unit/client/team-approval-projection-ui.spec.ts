import { expect, it, vi } from 'vitest'

vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type, props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
  }),
  useEffect: () => undefined,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

import { AcpTeamApprovals } from '../../../src/client/ui/AcpTeamApprovals.ts'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (value: string) => value as SessionId
const pending = (id: string) => ({ key: `request:${id}`, sessionId: sid(id), kind: 'approval', toolName: 'bash', answer: vi.fn(async () => {}) })
function statusSnapshot(entries: readonly [string, ReturnType<typeof pending>][]): SessionStatusSnapshot {
  return new Map(entries.map(([id, interaction]) => [sid(id), { running: false, pendingInteraction: interaction, completionUnread: false }])) as never
}
function projection(members: readonly { id: string; name: string; role: 'lead' | 'teammate'; phase: 'active' }[], failure?: string): TeamProjection {
  return { members: members.map(member => ({ ...member, id: sid(member.id) })), tasks: [], ...(failure === undefined ? {} : { failure }) }
}
function textContent(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(textContent)
  if (typeof node !== 'object' || node === null) return []
  const element = node as { props?: { children?: unknown } }
  return textContent(element.props?.children)
}
function renderApprovals(team: TeamProjection | undefined, statuses: SessionStatusSnapshot) {
  const props = {
    sessionId: sid('lead'),
    useSession: (selector: (state: { openState: string; subagent?: undefined }) => unknown) => selector({ openState: 'ready' }),
    useSessions: (selector: (state: { phase: string }) => unknown) => selector({ phase: 'ready' }),
    useProjection: (key: string) => key === 'modelSelection'
      ? { lastUsed: { provider: 'acp-devin' }, next: { provider: 'acp-devin' } } : team,
    t: (key: string) => key,
    status: { subscribe: () => () => {}, getSnapshot: () => statuses },
    ownsRoute: (provider: string | undefined) => provider === 'acp-devin',
    loadMembers: async () => [],
    isCurrent: () => true,
    openMember: async () => {},
  }
  return AcpTeamApprovals(props as never)
}

it('does not show another Team’s pending request on an ordinary ACP session with no Team projection', () => {
  const tree = renderApprovals(undefined, statusSnapshot([['other-team-member', pending('other-team-member')]]))
  expect(tree).toBeNull()
})

it('shows a failed projection warning without rendering stale member approval actions', () => {
  const team = projection([
    { id: 'lead', name: 'Lead', role: 'lead', phase: 'active' },
    { id: 'member', name: 'Member', role: 'teammate', phase: 'active' },
  ], 'invalid persisted team record')
  const tree = renderApprovals(team, statusSnapshot([['member', pending('member')]]))
  const content = textContent(tree)
  expect(content).toContain('teamProjectionFailed')
  expect(content).not.toContain('teamAllowOnce')
  expect(content).not.toContain('teamAllowAll')
})

it('does not use unrelated pending requests to surface a failed Team projection', () => {
  const team = projection([{ id: 'lead', name: 'Lead', role: 'lead', phase: 'active' }], 'invalid persisted team record')
  const tree = renderApprovals(team, statusSnapshot([['other-team-member', pending('other-team-member')]]))
  expect(tree).toBeNull()
})
