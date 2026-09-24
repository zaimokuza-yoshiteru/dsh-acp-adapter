import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './AcpTeamApprovals.module.css'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { AcpTeamMemberView } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import { answerTeamRequests, teamApproval } from './team-approval-actions.ts'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import { projectionIsAcp } from './AcpRecoveryDock.ts'
import { projectionRevision, teamRoster } from './team-projection.ts'

export interface AcpTeamApprovalActions {
  readonly status: HostObservable<SessionStatusSnapshot>
  readonly ownsRoute: OwnsAcpRoute
  loadMembers(sessionId: SessionId): Promise<readonly AcpTeamMemberView[]>
  isCurrent(sessionId: SessionId): boolean
  openMember(parent: SessionId, child: SessionId): Promise<void>
}

/** Present and answer the original member-owned carriers without changing the active conversation. */
export function AcpTeamApprovals({ sessionId, useSession, useSessions, useProjection, t, status, ownsRoute, loadMembers, openMember, isCurrent }:
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'acpActivity'> & AcpTeamApprovalActions): ReactNode {
  const inFlight = useRef(new Set<SessionPendingInteractionBase>())
  const epoch = useRef(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => { ++epoch.current; setBusy(false); setActionError(undefined); return () => { ++epoch.current } }, [sessionId])
  const [expanded, setExpanded] = useState(true)
  const seen = useRef(new Set<string>())
  const snapshot = useSyncExternalStore(status.subscribe, status.getSnapshot)
  const selection = useProjection('modelSelection')
  const isChild = useSession(session => session.subagent?.address?.parentSessionId !== undefined)
  const enabled = !isChild && projectionIsAcp(selection, ownsRoute)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const team = useProjection('agentTeam') as TeamProjection | undefined
  const sessionOpening = useSession(session => session.openState === 'loading')
  const sessionsLoading = useSessions(sessions => sessions.phase === 'pending')
  const roster = teamRoster(team, sessionOpening || sessionsLoading)
  const revision = projectionRevision(team)
  const pendingKeys = roster.kind === 'ready' ? roster.members.flatMap(member => {
    const pending = snapshot.get(member.id)?.pendingInteraction
    return pending === undefined ? [] : [JSON.stringify([member.id, pending.key])]
  }).join('\n') : ''
  const failedTeamHasPending = roster.kind === 'failed' && roster.memberIds.some(id => snapshot.get(id)?.pendingInteraction !== undefined)
  const [eligible, setEligible] = useState<{ sessionId: SessionId; revision: string; ids: ReadonlySet<string> } | undefined>(undefined)
  const [membersLoading, setMembersLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setEligible(undefined)
    setActionError(undefined)
    if (!enabled || pendingKeys === '' || roster.kind !== 'ready') { setMembersLoading(false); return () => { cancelled = true } }
    setMembersLoading(true)
    void loadMembers(sessionId).then(members => {
      if (!cancelled) setEligible({ sessionId, revision, ids: new Set(members.map(member => member.sessionId)) })
    }).catch(() => { if (!cancelled) setActionError(t('teamApprovalLoadFailed')) })
      .finally(() => { if (!cancelled) setMembersLoading(false) })
    return () => { cancelled = true }
  }, [enabled, pendingKeys, sessionId, revision, roster.kind, loadMembers, t])
  const allowedIds = eligible?.sessionId === sessionId && eligible.revision === revision ? eligible.ids : undefined
  const waiting = (roster.kind === 'ready' && allowedIds !== undefined ? roster.members : [])
    .filter(member => member.id !== sessionId && allowedIds?.has(member.id) === true && snapshot.get(member.id)?.pendingInteraction !== undefined)
  const keys = waiting.map(member => snapshot.get(member.id)!.pendingInteraction!.key)
  useEffect(() => {
    if (keys.some(key => !seen.current.has(key))) setExpanded(true)
    seen.current = new Set(keys)
  }, [keys.join('|')])
  const approvals = waiting.flatMap(member => {
    const value = teamApproval(snapshot.get(member.id)!.pendingInteraction!)
    return value === undefined ? [] : [value]
  })
  const run = async (requests: readonly { pending: SessionPendingInteractionBase; answer: () => Promise<void> }[]): Promise<void> => {
    if (busy || !isCurrent(sessionId)) return
    const currentEpoch = epoch.current
    const active = () => epoch.current === currentEpoch && isCurrent(sessionId)
    setBusy(true)
    setActionError(undefined)
    try {
      const members = await loadMembers(sessionId)
      const allowed = new Set(members.filter(member => member.sessionId !== sessionId).map(member => member.sessionId as SessionId))
      const failures = await answerTeamRequests(requests, status.getSnapshot, allowed, active, inFlight.current)
      if (active() && failures > 0) setActionError(t('teamAnswerFailed', { count: failures }))
    } catch { if (active()) setActionError(t('teamApprovalLoadFailed')) }
    finally { if (active()) setBusy(false) }
  }
  const batch = (outcome: 'allowed-once' | 'rejected'): void => {
    void run(approvals.map(request => ({ pending: request, answer: () => request.answer(outcome) })))
  }
  const rosterMessage = pendingKeys !== '' ? membersLoading || allowedIds === undefined ? t('teamProjectionLoading') : undefined
    : failedTeamHasPending ? t('teamProjectionFailed') : undefined
  const error = actionError ?? rosterMessage
  if (!enabled || (waiting.length === 0 && error === undefined)) return null
  return h('section', { className: css.card, 'data-acp-team-approvals': '', 'aria-label': t('teamPendingTitle', { count: waiting.length }) },
    h('div', { className: css.header },
      h('span', { className: css.icon, 'aria-hidden': true }, '!'),
      h('strong', { role: 'status', 'aria-live': 'polite' }, t('teamPendingTitle', { count: waiting.length })),
      approvals.length === 0 ? null : h('div', { className: css.actions },
        h(Button, { variant: 'outline', disabled: busy, onClick: () => batch('rejected') }, t('teamRejectAll')),
        h(Button, { variant: 'primary', disabled: busy, onClick: () => batch('allowed-once') }, t('teamAllowAll'))),
      h(Button, { variant: 'ghost', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, t(expanded ? 'teamPendingCollapse' : 'teamPendingExpand')),
    ),
    expanded ? h('div', { className: css.body },
      h('p', { className: css.hint }, t('teamPendingHint')),
      approvals.length === 0 ? null : h('p', { className: css.hint }, t('teamBatchHint', { count: approvals.length })),
      h('ul', { className: css.members }, ...waiting.map(member => {
        const request = snapshot.get(member.id)!.pendingInteraction!
        const approval = teamApproval(request)
        const kind = request.kind
        return h('li', { key: member.id, className: css.member, 'data-team-pending-member': member.name },
          h('div', { className: css.memberHeader },
            h('span', { className: css.name }, member.name),
            h('div', { className: css.actions },
              h('span', { className: css.status }, t(kind === 'approval' ? 'teamPendingApproval' : kind === 'question' || kind === 'plan-review' ? 'teamPendingQuestion' : 'teamPendingOther')),
              h(Button, { variant: 'outline', 'aria-label': t('teamApprovalEntry', { name: member.name }),
                onClick: () => { void openMember(sessionId, member.id).catch(() => setActionError(t('teamApprovalOpenFailed'))) },
              }, t('teamPendingOpen')),
              approval === undefined ? null : h(Button, { variant: 'outline', disabled: busy, onClick: () => { void run([{ pending: request, answer: () => approval.answer('rejected') }]) } }, t('teamReject')),
              approval === undefined ? null : h(Button, { variant: 'primary', disabled: busy, onClick: () => { void run([{ pending: request, answer: () => approval.answer('allowed-once') }]) } }, t('teamAllowOnce')))),
          approval === undefined ? null : h('div', { className: css.reason, 'data-team-approval-reason': '', tabIndex: 0 }, approval.reason ?? approval.toolName),
        )
      })),
    ) : null,
    error === undefined ? null : h('p', { role: 'status', className: css.error }, error),
  )
}
