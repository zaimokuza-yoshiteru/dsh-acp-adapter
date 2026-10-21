import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './AcpTeamApprovals.module.css'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpApprovalChildView } from '../data/acp-remote.ts'
import {
  answerTeamRequests,
  isStableTeamMemberReadError,
  readTeamMembersUntilAvailable,
  teamApproval,
  pendingChildCandidates,
} from './team-approval-actions.ts'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'

export interface AcpTeamApprovalActions {
  readonly status: HostObservable<SessionStatusSnapshot>
  loadChildren(sessionId: SessionId): Promise<readonly AcpApprovalChildView[]>
  isCurrent(sessionId: SessionId): boolean
  openMember(parent: SessionId, child: AcpApprovalChildView): Promise<void>
  resolveReason(reason: NonNullable<ReturnType<typeof teamApproval>>['displayReason']): string | undefined
}

// Match the collision-safe identity shown by the native full-choice permission card.
function shortSessionId(id: string, ids: readonly string[]): string {
  let length = Math.min(8, id.length)
  while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))) length++
  return id.slice(0, length)
}

/** Present and answer the original member-owned carriers without changing the active conversation. */
export function AcpTeamApprovals({
  sessionId,
  useSessions,
  t,
  status,
  loadChildren,
  openMember,
  isCurrent,
  resolveReason,
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
  const summaries = useSessions((sessions) => sessions.byId)
  const projections = useSessions((sessions) => sessions.projectionsBySession)
  const readOnly = new Set(
    Object.entries(projections)
      .filter(([, projection]) => projection.values.acpExecution?.externalSubagent === true)
      .map(([id]) => id as SessionId),
  )
  const enabled = isCurrent(sessionId) && !readOnly.has(sessionId)
  const candidates = pendingChildCandidates(sessionId, summaries, snapshot, readOnly)
  const revision = JSON.stringify(candidates.map((id) => [id, summaries[id]?.parentId]))
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const pendingCarriers = candidates.map((id) => ({ sessionId: id, pending: snapshot.get(id)!.pendingInteraction! }))
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
  const [eligible, setEligible] = useState<
    | { sessionId: SessionId; revision: string; pendingKeys: string; children: readonly AcpApprovalChildView[] }
    | { sessionId: SessionId; revision: string; pendingKeys: string; loading: true }
    | { sessionId: SessionId; revision: string; pendingKeys: string; failed: true }
    | undefined
  >(undefined)
  useEffect(() => {
    let cancelled = false
    setActionError(undefined)
    if (!enabled || pendingKeys === '') {
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
    void readTeamMembersUntilAvailable(sessionId, loadChildren, active, { signal: controller.signal })
      .then((members) => {
        if (!active()) return
        if (members === undefined) {
          setEligible(undefined)
          return
        }
        setEligible({ sessionId, revision, pendingKeys, children: members })
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
  }, [enabled, pendingKeys, sessionId, revision, loadChildren, isCurrent, status])
  const eligibleMatches =
    eligible !== undefined &&
    eligible.sessionId === sessionId &&
    eligible.revision === revision &&
    eligible.pendingKeys === pendingKeys
  const children = eligibleMatches && eligible !== undefined && 'children' in eligible ? eligible.children : undefined
  const sessionIds = Object.keys(summaries)
  const waiting = (children ?? []).filter(
    (member) =>
      member.sessionId !== sessionId &&
      candidates.includes(member.sessionId as SessionId) &&
      snapshot.get(member.sessionId as SessionId)?.pendingInteraction !== undefined,
  )
  const keys = waiting.map((member) => snapshot.get(member.sessionId as SessionId)!.pendingInteraction!.key)
  useEffect(() => {
    if (keys.some((key) => !seen.current.has(key))) setExpanded(true)
    seen.current = new Set(keys)
  }, [keys.join('|')])
  const approvals = waiting.flatMap((member) => {
    const value = teamApproval(snapshot.get(member.sessionId as SessionId)!.pendingInteraction!)
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
        loadChildren,
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
  const error = actionError
  const loading = pendingKeys !== '' && children === undefined
  if (!enabled || (waiting.length === 0 && error === undefined && !loading)) return null
  const pendingTitle =
    pendingKeys !== '' && children === undefined
      ? eligibleMatches && eligible !== undefined && 'failed' in eligible
        ? t('teamPendingUncounted')
        : t('teamPendingLoading')
      : t('teamPendingTitle', { count: waiting.length })
  return h(
    'section',
    {
      className: css.card,
      'data-acp-team-approvals': '',
      'data-acp-child-approvals': '',
      'aria-label': pendingTitle,
    },
    h(
      'div',
      { className: css.header },
      h('span', { className: css.icon, 'aria-hidden': true }, '!'),
      h('strong', { role: 'status', 'aria-live': 'polite' }, pendingTitle),
      approvals.length <= 1
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
          approvals.length <= 1
            ? null
            : h('p', { className: css.hint }, t('teamBatchHint', { count: approvals.length })),
          h(
            'ul',
            { className: css.members },
            ...waiting.map((member) => {
              const request = snapshot.get(member.sessionId as SessionId)!.pendingInteraction!
              const approval = teamApproval(request)
              const kind = request.kind
              const source = member.path.map((part) => `${part.name} (${part.sessionId})`).join(' › ')
              return h(
                'li',
                {
                  key: member.sessionId,
                  className: css.member,
                  'data-team-pending-member': member.name,
                  'aria-label': source,
                },
                h(
                  'div',
                  { className: css.memberHeader },
                  h(
                    'span',
                    { className: css.name, title: source },
                    member.path
                      .map((part) => `${part.name} · ${shortSessionId(part.sessionId, sessionIds)}`)
                      .join(' › '),
                  ),
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
                          void openMember(sessionId, member).catch(() => setActionError(t('teamApprovalOpenFailed')))
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
                      resolveReason(approval.displayReason) ?? approval.reason ?? approval.toolName,
                    ),
              )
            }),
          ),
        )
      : null,
    error === undefined ? null : h('p', { role: 'status', className: css.error }, error),
  )
}
