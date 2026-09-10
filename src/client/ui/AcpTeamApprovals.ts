import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
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
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'acpActivity'> & AcpTeamApprovalActions): ReactNode {
  const snapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot)
  const selection = useProjection('modelSelection')
  const isChild = useSession(session => session.subagent?.address?.parentSessionId !== undefined)
  const enabled = !isChild && projectionIsAcp(selection, ownsRoute)
  const [members, setMembers] = useState<readonly TeamMemberView[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setMembers([])
    setError(undefined)
    if (enabled && snapshot.size > 0) void loadMembers(sessionId).then(value => {
      if (!cancelled) setMembers(value)
    }).catch(() => { if (!cancelled) setError(t('teamApprovalLoadFailed')) })
    return () => { cancelled = true }
  }, [enabled, snapshot, sessionId, loadMembers, t])
  if (!enabled) return null
  const waiting = members.filter(member => member.role === 'teammate' && member.id !== sessionId && snapshot.has(member.id))
  return h('span', { 'data-acp-team-approvals': '' },
    ...waiting.map(member => h(Button, {
      key: member.id, variant: 'outline',
      onClick: () => { void openMember(sessionId, member.id).catch(() => setError(t('teamApprovalOpenFailed'))) },
    }, t('teamApprovalEntry', { name: member.name }))),
    error === undefined ? null : h('span', { role: 'status' }, error),
  )
}
