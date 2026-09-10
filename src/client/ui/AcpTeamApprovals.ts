import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './AcpTeamApprovals.module.css'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import { projectionIsAcp } from './AcpRecoveryDock.ts'

export interface AcpTeamApprovalActions {
  readonly pending: HostObservable<SessionPendingInteractionSnapshot>
  readonly ownsRoute: OwnsAcpRoute
  loadMembers(sessionId: SessionId): Promise<readonly TeamMemberView[]>
  openMember(parent: SessionId, child: SessionId): Promise<void>
}

/** An entry to the original member-owned native interaction; never clone or decide a request. */
export function AcpTeamApprovals({ sessionId, useSession, useProjection, t, pending, ownsRoute, loadMembers, openMember }:
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'acpActivity'> & AcpTeamApprovalActions): ReactNode {
  const [expanded, setExpanded] = useState(true)
  const seen = useRef(new Set<string>())
  const snapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot)
  const selection = useProjection('modelSelection')
  const isChild = useSession(session => session.subagent?.address?.parentSessionId !== undefined)
  const enabled = !isChild && projectionIsAcp(selection, ownsRoute)
  const [roster, setRoster] = useState<{ sessionId: SessionId; members: readonly TeamMemberView[] } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setError(undefined)
    if (!enabled || snapshot.size === 0) setRoster(undefined)
    if (enabled && snapshot.size > 0) void loadMembers(sessionId).then(value => {
      if (!cancelled) setRoster({ sessionId, members: value })
    }).catch(() => { if (!cancelled) setError(t('teamApprovalLoadFailed')) })
    return () => { cancelled = true }
  }, [enabled, snapshot, sessionId, loadMembers, t])
  const waiting = (roster?.sessionId === sessionId ? roster.members : []).filter(member => member.role === 'teammate' && member.id !== sessionId && snapshot.has(member.id))
  const keys = waiting.map(member => snapshot.get(member.id)!.key)
  useEffect(() => {
    if (keys.some(key => !seen.current.has(key))) setExpanded(true)
    seen.current = new Set(keys)
  }, [keys.join('|')])
  if (!enabled || (waiting.length === 0 && error === undefined)) return null
  return h('section', { className: css.card, 'data-acp-team-approvals': '', 'aria-label': t('teamPendingTitle', { count: waiting.length }) },
    h('div', { className: css.header },
      h('span', { className: css.icon, 'aria-hidden': true }, '!'),
      h('strong', { role: 'status', 'aria-live': 'polite' }, t('teamPendingTitle', { count: waiting.length })),
      h(Button, { variant: 'ghost', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, t(expanded ? 'teamPendingCollapse' : 'teamPendingExpand')),
    ),
    expanded ? h('div', { className: css.body },
      h('p', { className: css.hint }, t('teamPendingHint')),
      h('ul', { className: css.members }, ...waiting.map(member => {
        const kind = snapshot.get(member.id)?.kind
        return h('li', { key: member.id, className: css.member, 'data-team-pending-member': member.name },
          h('span', { className: css.name }, member.name),
          h('span', { className: css.status }, t(kind === 'approval' ? 'teamPendingApproval' : kind === 'question' || kind === 'plan-review' ? 'teamPendingQuestion' : 'teamPendingOther')),
          h(Button, { variant: 'outline', 'aria-label': t('teamApprovalEntry', { name: member.name }),
            onClick: () => { void openMember(sessionId, member.id).catch(() => setError(t('teamApprovalOpenFailed'))) },
          }, t('teamPendingOpen')),
        )
      })),
    ) : null,
    error === undefined ? null : h('p', { role: 'status', className: css.error }, error),
  )
}
