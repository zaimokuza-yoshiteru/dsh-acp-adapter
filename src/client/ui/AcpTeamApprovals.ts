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
import {
  answerTeamRequests,
  isStableTeamMemberReadError,
  readTeamMembersUntilAvailable,
  teamApproval,
} from './team-approval-actions.ts'
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
export function AcpTeamApprovals({
  sessionId,
  useSession,
  useSessions,
  useProjection,
  t,
  status,
  ownsRoute,
  loadMembers,
  openMember,
  isCurrent,
}: PropsRuntime<'conversation.input.dock'> & PropsLocale<'acpActivity'> & AcpTeamApprovalActions): ReactNode {
  const inFlight = useRef(new Set<SessionPendingInteractionBase>())
  const epoch = useRef(0)
  const runController = useRef<AbortController | undefined>(undefined)
  const requestIdentity = useRef<{ ids: WeakMap<object, number>; next: number } | undefined>(undefined)
  if (requestIdentity.current === undefined) requestIdentity.current = { ids: new WeakMap(), next: 0 }
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    ++epoch.current
    runController.current?.abort()
    runController.current = undefined
    setBusy(false)
    setActionError(undefined)
    return () => {
      ++epoch.current
    }
  }, [sessionId])
  const [expanded, setExpanded] = useState(true)
  const seen = useRef(new Set<string>())
  const snapshot = useSyncExternalStore(status.subscribe, status.getSnapshot)
  const selection = useProjection('modelSelection')
  const isChild = useSession((session) => session.subagent?.address?.parentSessionId !== undefined)
  const enabled = !isChild && projectionIsAcp(selection, ownsRoute)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const team = useProjection('agentTeam') as TeamProjection | undefined
  const sessionOpening = useSession((session) => session.openState === 'loading')
  const sessionsLoading = useSessions((sessions) => sessions.phase === 'pending')
  const roster = teamRoster(team, sessionOpening || sessionsLoading)
  const revision = projectionRevision(team)
  const pendingCarriers =
    roster.kind === 'ready'
      ? roster.members.flatMap((member) => {
          const pending = snapshot.get(member.id)?.pendingInteraction
          return pending === undefined ? [] : [{ sessionId: member.id, pending }]
        })
      : []
  const pendingKeys = pendingCarriers
    .map(({ sessionId: memberId, pending }) => {
      const identity = requestIdentity.current!
      let id = identity.ids.get(pending)
      if (id === undefined) {
        id = ++identity.next
        identity.ids.set(pending, id)
      }
      return JSON.stringify([memberId, pending.key, id])
    })
    .join('\n')
  const failedTeamHasPending =
    roster.kind === 'failed' && roster.memberIds.some((id) => snapshot.get(id)?.pendingInteraction !== undefined)
  const [eligible, setEligible] = useState<
    | { sessionId: SessionId; revision: string; pendingKeys: string; ids: ReadonlySet<string> }
    | { sessionId: SessionId; revision: string; pendingKeys: string; loading: true }
    | { sessionId: SessionId; revision: string; pendingKeys: string; failed: true }
    | undefined
  >(undefined)
  useEffect(() => {
    let cancelled = false
    setActionError(undefined)
    if (!enabled || pendingKeys === '' || roster.kind !== 'ready') {
      setEligible(undefined)
      return () => {
        cancelled = true
      }
    }
    const controller = new AbortController()
    const currentEpoch = epoch.current
    const capturedPendingIsCurrent = () =>
      pendingCarriers.every(
        ({ sessionId: memberId, pending }) => status.getSnapshot().get(memberId)?.pendingInteraction === pending,
      )
    const active = () =>
      !cancelled &&
      !controller.signal.aborted &&
      epoch.current === currentEpoch &&
      isCurrent(sessionId) &&
      capturedPendingIsCurrent()
    setEligible({ sessionId, revision, pendingKeys, loading: true })
    void readTeamMembersUntilAvailable(sessionId, loadMembers, active, { signal: controller.signal })
      .then((members) => {
        if (!active()) return
        if (members === undefined) {
          setEligible(undefined)
          return
        }
        setEligible({ sessionId, revision, pendingKeys, ids: new Set(members.map((member) => member.sessionId)) })
      })
      .catch((error: unknown) => {
        if (!active() || !isStableTeamMemberReadError(error)) return
        setEligible({ sessionId, revision, pendingKeys, failed: true })
        setActionError(t('teamApprovalLoadFailed'))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, pendingKeys, sessionId, revision, roster.kind, loadMembers, isCurrent, status])
  const eligibleMatches =
    eligible !== undefined &&
    eligible.sessionId === sessionId &&
    eligible.revision === revision &&
    eligible.pendingKeys === pendingKeys
  const allowedIds = eligibleMatches && eligible !== undefined && 'ids' in eligible ? eligible.ids : undefined
  const waiting = (roster.kind === 'ready' && allowedIds !== undefined ? roster.members : []).filter(
    (member) =>
      member.id !== sessionId &&
      allowedIds?.has(member.id) === true &&
      snapshot.get(member.id)?.pendingInteraction !== undefined,
  )
  const keys = waiting.map((member) => snapshot.get(member.id)!.pendingInteraction!.key)
  useEffect(() => {
    if (keys.some((key) => !seen.current.has(key))) setExpanded(true)
    seen.current = new Set(keys)
  }, [keys.join('|')])
  const approvals = waiting.flatMap((member) => {
    const value = teamApproval(snapshot.get(member.id)!.pendingInteraction!)
    return value === undefined ? [] : [value]
  })
  const run = async (
    requests: readonly { pending: SessionPendingInteractionBase; answer: () => Promise<void> }[],
  ): Promise<void> => {
    if (busy || runController.current !== undefined || !isCurrent(sessionId)) return
    const currentEpoch = epoch.current
    const controller = new AbortController()
    runController.current = controller
    let settling = false
    const active = () => !controller.signal.aborted && epoch.current === currentEpoch && isCurrent(sessionId)
    const requestSetIsCurrent = () =>
      requests.every(
        (request) => status.getSnapshot().get(request.pending.sessionId)?.pendingInteraction === request.pending,
      )
    const unsubscribe = status.subscribe(() => {
      if (!settling && !requestSetIsCurrent()) controller.abort()
    })
    setBusy(true)
    setActionError(undefined)
    try {
      const members = await readTeamMembersUntilAvailable(
        sessionId,
        loadMembers,
        () => active() && requestSetIsCurrent(),
        {
          onFailure: () => {
            if (active() && requestSetIsCurrent()) setActionError(t('teamApprovalRechecking'))
          },
          signal: controller.signal,
        },
      )
      if (!active()) return
      if (members === undefined || !requestSetIsCurrent()) {
        setActionError(undefined)
        return
      }
      setActionError(undefined)
      const allowed = new Set(
        members.filter((member) => member.sessionId !== sessionId).map((member) => member.sessionId as SessionId),
      )
      settling = true
      const failures = await answerTeamRequests(requests, status.getSnapshot, allowed, active, inFlight.current)
      if (active() && failures > 0) setActionError(t('teamAnswerFailed', { count: failures }))
    } catch {
      if (active()) setActionError(t('teamApprovalLoadFailed'))
    } finally {
      unsubscribe()
      if (runController.current === controller) runController.current = undefined
      if (active()) setBusy(false)
      else if (epoch.current === currentEpoch && isCurrent(sessionId)) {
        setActionError(undefined)
        setBusy(false)
      }
    }
  }
  const batch = (outcome: 'allowed-once' | 'rejected'): void => {
    void run(approvals.map((request) => ({ pending: request, answer: () => request.answer(outcome) })))
  }
  const rosterMessage =
    pendingKeys !== ''
      ? allowedIds === undefined
        ? t('teamPendingLoading')
        : undefined
      : failedTeamHasPending
        ? t('teamProjectionFailed')
        : undefined
  const error = actionError ?? rosterMessage
  if (!enabled || (waiting.length === 0 && error === undefined)) return null
  const pendingTitle =
    (pendingKeys !== '' || failedTeamHasPending) && allowedIds === undefined
      ? eligibleMatches && eligible !== undefined && 'failed' in eligible
        ? t('teamPendingUncounted')
        : t('teamPendingLoading')
      : t('teamPendingTitle', { count: waiting.length })
  return h(
    'section',
    {
      className: css.card,
      'data-acp-team-approvals': '',
      'aria-label': pendingTitle,
    },
    h(
      'div',
      { className: css.header },
      h('span', { className: css.icon, 'aria-hidden': true }, '!'),
      h('strong', { role: 'status', 'aria-live': 'polite' }, pendingTitle),
      approvals.length === 0
        ? null
        : h(
            'div',
            { className: css.actions },
            h(Button, { variant: 'outline', disabled: busy, onClick: () => batch('rejected') }, t('teamRejectAll')),
            h(Button, { variant: 'primary', disabled: busy, onClick: () => batch('allowed-once') }, t('teamAllowAll')),
          ),
      h(
        Button,
        { variant: 'ghost', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) },
        t(expanded ? 'teamPendingCollapse' : 'teamPendingExpand'),
      ),
    ),
    expanded
      ? h(
          'div',
          { className: css.body },
          h('p', { className: css.hint }, t('teamPendingHint')),
          approvals.length === 0
            ? null
            : h('p', { className: css.hint }, t('teamBatchHint', { count: approvals.length })),
          h(
            'ul',
            { className: css.members },
            ...waiting.map((member) => {
              const request = snapshot.get(member.id)!.pendingInteraction!
              const approval = teamApproval(request)
              const kind = request.kind
              return h(
                'li',
                { key: member.id, className: css.member, 'data-team-pending-member': member.name },
                h(
                  'div',
                  { className: css.memberHeader },
                  h('span', { className: css.name }, member.name),
                  h(
                    'div',
                    { className: css.actions },
                    h(
                      'span',
                      { className: css.status },
                      t(
                        kind === 'approval'
                          ? 'teamPendingApproval'
                          : kind === 'question' || kind === 'plan-review'
                            ? 'teamPendingQuestion'
                            : 'teamPendingOther',
                      ),
                    ),
                    h(
                      Button,
                      {
                        variant: 'outline',
                        'aria-label': t('teamApprovalEntry', { name: member.name }),
                        onClick: () => {
                          void openMember(sessionId, member.id).catch(() => setActionError(t('teamApprovalOpenFailed')))
                        },
                      },
                      t('teamPendingOpen'),
                    ),
                    approval === undefined
                      ? null
                      : h(
                          Button,
                          {
                            variant: 'outline',
                            disabled: busy,
                            onClick: () => {
                              void run([{ pending: request, answer: () => approval.answer('rejected') }])
                            },
                          },
                          t('teamReject'),
                        ),
                    approval === undefined
                      ? null
                      : h(
                          Button,
                          {
                            variant: 'primary',
                            disabled: busy,
                            onClick: () => {
                              void run([{ pending: request, answer: () => approval.answer('allowed-once') }])
                            },
                          },
                          t('teamAllowOnce'),
                        ),
                  ),
                ),
                approval === undefined
                  ? null
                  : h(
                      'div',
                      { className: css.reason, 'data-team-approval-reason': '', tabIndex: 0 },
                      approval.reason ?? approval.toolName,
                    ),
              )
            }),
          ),
        )
      : null,
    error === undefined ? null : h('p', { role: 'status', className: css.error }, error),
  )
}
