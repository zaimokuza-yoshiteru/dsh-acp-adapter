import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, StateDot, closeTopModal, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  GlobalStandardProps,
  HostObservable,
  PropsLocale,
  PropsRuntime,
  InjectFace,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpRemoteLike, AcpTeamMemberView, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import { AgentSessionMenu } from './AgentSessionMenu.ts'
import { agentControlLabel, type AgentControlGroup } from './agent-session-controls.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { applyTeamMode, teamModeChoices, teamSessionMenuGroups, type TeamModeResult } from './team-mode-controls.ts'
import { teamModeLabel } from '../../contract/session-modes.ts'
import { TeamMemberModelControl } from './TeamMemberModelControl.ts'
import { interruptTeam } from './team-interrupt.ts'
import { projectionRevision } from './team-projection.ts'
import css from './AcpTeamManagement.module.css'
import { useSessionActionAccess, type SessionAccessSource } from './session-action-access.ts'

type Copy = PropsLocale<'acpActivity'>['t']
type AcpTeamManagementActions = {
  remote: AcpRemoteLike
  streamFactory: RemoteStreamFactory
  isCurrent(sessionId: SessionId): boolean
  interruptMember(member: SessionId): Promise<void>
  status: HostObservable<SessionStatusSnapshot>
  loadMembers(sessionId: SessionId): Promise<readonly AcpTeamMemberView[]>
  sessionAccessSource: SessionAccessSource
}
type ManagedMember = AcpTeamMemberView & { readonly runtimeKnown: boolean }
type InterruptFeedback =
  | { key: 'teamInterruptResult'; params: { accepted: number; skipped: number; failed: number }; isError: boolean }
  | { key: 'teamInterruptFailed'; isError: true }

/** ACP settings extend the native catalog; the native owner keeps member navigation. */
export function AcpTeamManagementAction({
  sessionId,
  useSessions,
  loadMembers,
  status,
  openManagement,
  t,
}: PropsRuntime<'conversation.session.header.actions.subagent.footer'> &
  PropsLocale<'acpActivity'> & {
    loadMembers: AcpTeamManagementActions['loadMembers']
    status: AcpTeamManagementActions['status']
    openManagement(sessionId: SessionId): void
  }): ReactNode {
  const statuses = useSyncExternalStore(status.subscribe, status.getSnapshot)
  const revision = useSessions((state) =>
    projectionRevision(sessionId, state.projectionsBySession, (id) => {
      const current = statuses.get(id)
      return [current?.running, current?.pendingInteraction?.key]
    }),
  )
  const [available, setAvailable] = useState<{ sessionId: SessionId; visible: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadMembers(sessionId).then(
      (members) => {
        if (!cancelled) setAvailable({ sessionId, visible: members.length > 0 })
      },
      () => {
        // Keep a retry route when the native catalog exists but ACP metadata fails.
        if (!cancelled) setAvailable({ sessionId, visible: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, revision, loadMembers])
  if (available === null || available.sessionId !== sessionId || !available.visible) return null
  return h(
    'div',
    { className: css.entry, 'data-acp-team-management': '' },
    h(
      Button,
      {
        variant: 'ghost',
        onClick: () => openManagement(sessionId),
      },
      t('teamManage'),
    ),
  )
}

export type AcpTeamManagementInjected = AcpTeamManagementActions & {
  hooks: { managementRequest: HostObservable<SessionId | null> }
  closeManagement(): void
}

/** A root-owned dialog survives dismissal of the native catalog that opened it. */
export function AcpTeamManagementOverlay({
  useManagementRequest,
  ...props
}: PropsRuntime<'shell.overlay'> & PropsLocale<'acpActivity'> & InjectFace<AcpTeamManagementInjected>): ReactNode {
  const sessionId = useManagementRequest((value) => value)
  return sessionId === null ? null : h(AcpTeamManagement, { ...props, sessionId, key: sessionId })
}

export function AcpTeamManagement({
  sessionId,
  useSessions,
  useSessionAccess,
  t,
  closeManagement,
  ...actions
}: PropsRuntime<'shell.overlay'> &
  PropsLocale<'acpActivity'> &
  AcpTeamManagementActions & {
    sessionId: SessionId
    closeManagement(): void
  }): ReactNode {
  const composition = useRef<ReturnType<typeof observeComposition> | undefined>(undefined)
  useEffect(() => {
    const observer = observeComposition(document)
    composition.current = observer
    return () => {
      composition.current = undefined
      observer.dispose()
    }
  }, [])
  const statusSnapshot = useSyncExternalStore(actions.status.subscribe, actions.status.getSnapshot)
  const revision = useSessions((state) =>
    projectionRevision(sessionId, state.projectionsBySession, (id) => {
      const current = statusSnapshot.get(id)
      return [current?.running, current?.pendingInteraction?.key]
    }),
  )
  const [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<{
    revision: string
    runtimeRevision: string
    members: readonly AcpTeamMemberView[]
  } | null>(null)
  const runtimeFacts = useSessions((state) =>
    JSON.stringify(
      (view?.members ?? []).map((member) => [
        member.sessionId,
        state.byId[member.sessionId as SessionId]?.running,
        state.projectionsBySession[member.sessionId as SessionId]?.values.modelSelection?.next,
      ]),
    ),
  )
  const runtimeById = new Map<string, boolean | undefined>(
    (JSON.parse(runtimeFacts) as [string, boolean | null, unknown][]).map(([id, running]) => [
      id,
      typeof running === 'boolean' ? running : undefined,
    ]),
  )
  const runtimeRevision = JSON.stringify([
    runtimeFacts,
    ...(view?.members ?? []).map((member) => [
      member.sessionId,
      statusSnapshot.get(member.sessionId as SessionId)?.running,
    ]),
  ])
  const [error, setError] = useState(false)
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [interrupting, setInterrupting] = useState(false)
  const [interruptFeedback, setInterruptFeedback] = useState<InterruptFeedback | null>(null)
  const interruptLock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    setError(false)
    setMetadataLoading(true)
    void actions
      .loadMembers(sessionId)
      .then(
        (members) => {
          if (!cancelled) setView({ revision, runtimeRevision, members })
        },
        () => {
          if (!cancelled) setError(true)
        },
      )
      .finally(() => {
        if (!cancelled) setMetadataLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, revision, runtimeRevision, refresh, actions.loadMembers])
  const metadataReady =
    !error && !metadataLoading && view?.revision === revision && view.runtimeRevision === runtimeRevision
  const members: ManagedMember[] = (view?.members ?? []).map((member) => {
    const running = statusSnapshot.get(member.sessionId as SessionId)?.running ?? runtimeById.get(member.sessionId)
    return {
      ...member,
      status: running === undefined ? member.status : running ? 'running' : 'inactive',
      runtimeKnown: running !== undefined,
    }
  })
  const interruptAccess = useSessionActionAccess(
    actions.sessionAccessSource,
    members.map((member) => member.sessionId),
    'subagents/interruptByUser',
  )
  const interruptAll = async (): Promise<void> => {
    if (interruptLock.current || !metadataReady) return
    interruptLock.current = true
    setInterrupting(true)
    setInterruptFeedback(null)
    const current = () => alive.current && actions.isCurrent(sessionId)
    let membershipReadSucceeded = false
    try {
      const result = await interruptTeam({
        lead: sessionId,
        targets: members
          .filter((member) => member.status === 'running' && member.runtimeKnown)
          .map((member) => member.sessionId),
        isCurrent: current,
        canInterrupt: (id) => interruptAccess.allows(id),
        members: async () => {
          const result = await actions.remote.teamMembers(sessionId)
          if (!result.ok) throw new Error(result.error.message)
          membershipReadSucceeded = true
          return result.value
        },
        interrupt: (id) => actions.interruptMember(id as SessionId),
      })
      if (current()) setInterruptFeedback({ key: 'teamInterruptResult', params: result, isError: result.failed > 0 })
    } catch {
      if (current()) setInterruptFeedback({ key: 'teamInterruptFailed', isError: true })
    } finally {
      interruptLock.current = false
      if (alive.current) {
        setInterrupting(false)
        if (membershipReadSucceeded) setRefresh((value) => value + 1)
      }
    }
  }
  const groups = Map.groupBy(members, (member) => member.profileId)
  return h(
    Modal,
    {
      open: true,
      title: t('teamManage'),
      closeLabel: t('teamManageClose'),
      onClose: closeManagement,
      // The native catalog behind this Modal also listens for Escape on document.
      // Its handler must not consume the foreground dialog's key first. Native
      // menus already handle Escape during document capture and retain priority.
      onKeyDownCapture: (event) => {
        if (event.key !== 'Escape') return
        const composing = composition.current?.guards(event.nativeEvent) ?? event.nativeEvent.isComposing
        if (event.defaultPrevented || composing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
          return
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) closeTopModal(event.currentTarget.ownerDocument)
      },
      className: css.dialog ?? '',
      contentClassName: css.content ?? '',
      footer: h(
        'div',
        { className: css.footer },
        h(
          Button,
          { variant: 'outline', disabled: metadataLoading, onClick: () => setRefresh((value) => value + 1) },
          t('teamRefresh'),
        ),
        h(Button, { variant: 'outline', onClick: closeManagement }, t('teamManageClose')),
      ),
    },
    h(
      'div',
      { 'data-acp-team-panel': '' },
      metadataLoading ? h('p', { role: 'status', className: css.hint }, t('teamMetadataLoading')) : null,
      error ? h('p', { role: 'alert', className: css.error }, t('teamManageError')) : null,
      !metadataLoading && !error && members.length === 0
        ? h('p', { className: css.hint }, t('teamMembersEmpty'))
        : null,
      ...[...groups].map(([profileId, grouped], index) =>
        h(ModeGroup, {
          key: profileId ?? 'unknown',
          lead: sessionId,
          profileId,
          members: grouped,
          metadataCurrent: metadataReady,
          t,
          useSessionAccess,
          interrupt:
            index === 0
              ? {
                  busy: interrupting,
                  disabled:
                    interrupting ||
                    !metadataReady ||
                    !members.some(
                      (member) =>
                        member.status === 'running' && member.runtimeKnown && interruptAccess.allows(member.sessionId),
                    ),
                  run: () => {
                    void interruptAll()
                  },
                }
              : null,
          ...actions,
        }),
      ),
      interruptFeedback
        ? h(
            'p',
            {
              role: interruptFeedback.isError ? 'alert' : 'status',
              className: interruptFeedback.isError ? css.error : css.hint,
            },
            t(interruptFeedback.key, 'params' in interruptFeedback ? interruptFeedback.params : undefined),
          )
        : null,
    ),
  )
}

function ModeGroup({
  lead,
  profileId,
  members,
  metadataCurrent,
  t,
  remote,
  streamFactory,
  isCurrent,
  interrupt,
  useSessionAccess,
  sessionAccessSource,
}: {
  interrupt: { busy: boolean; disabled: boolean; run(): void } | null
  lead: SessionId
  profileId: string | null
  members: readonly ManagedMember[]
  metadataCurrent: boolean
  t: Copy
  useSessionAccess: GlobalStandardProps['useSessionAccess']
} & AcpTeamManagementActions): ReactNode {
  const modeAccess = useSessionActionAccess(
    sessionAccessSource,
    [lead, ...members.map((member) => member.sessionId)],
    'dshAcp/setTeamMemberMode',
  )
  const modeAllowed = (id: string): boolean => modeAccess.allows(lead) && modeAccess.allows(id)
  const [snapshots, setSnapshots] = useState<Record<string, AcpAgentSessionSnapshotView | null>>({})
  const [menu, setMenu] = useState<string | null>(null)
  const updateMenu = (value: string | null): void => setMenu(value)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const alive = useRef(true)
  const [feedback, setFeedback] = useState<
    { key: 'teamModeResult'; applied: number; skipped: number; failed: number } | undefined
  >(undefined)
  const [results, setResults] = useState<readonly TeamModeResult[]>([])
  const ids = members.map((member) => member.sessionId).join('|')
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let disposed = false
    const streams = ids.split('|').map((id) =>
      agentSessionStream(
        remote,
        streamFactory,
        id,
        (snapshot) => {
          if (!disposed) setSnapshots((old) => ({ ...old, [id]: snapshot }))
        },
        () => {
          if (!disposed)
            setSnapshots((old) => ({
              ...old,
              [id]: old[id] ? { ...old[id], editable: false, modeWritable: false, freshness: 'stale' } : null,
            }))
        },
      ),
    )
    streams.forEach((stream) => stream.start())
    return () => {
      disposed = true
      streams.forEach((stream) => {
        void stream.dispose()
      })
    }
  }, [ids, remote, streamFactory])
  const editable = (member: ManagedMember) =>
    modeAllowed(member.sessionId) &&
    metadataCurrent &&
    member.status === 'inactive' &&
    member.runtimeKnown &&
    snapshots[member.sessionId]?.profileId === profileId &&
    snapshots[member.sessionId]?.modeWritable
  const choices = (member: AcpTeamMemberView) => {
    const snapshot = snapshots[member.sessionId]
    return snapshot
      ? teamModeChoices(snapshot).map((choice) => ({
          ...choice,
          current: snapshot.pendingModeId ? snapshot.pendingModeId === choice.id : choice.current,
        }))
      : []
  }
  const batchChoices = [
    ...new Map(members.flatMap((member) => choices(member)).map((choice) => [choice.id, choice])).values(),
  ]
  const change = async (targets: readonly string[], mode: string): Promise<void> => {
    if (locked.current || profileId === null || !metadataCurrent) return
    locked.current = true
    setBusy(true)
    updateMenu(null)
    setFeedback(undefined)
    setResults([])
    const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    try {
      const result = await applyTeamMode({
        targets,
        profileId,
        mode,
        isCurrent: () => alive.current && isCurrent(lead),
        canWrite: modeAllowed,
        members: async () => unwrap(await remote.teamMembers(lead)),
        snapshot: async (id) => unwrap(await remote.agentSessionSnapshot(id)),
        write: async (id, value) => {
          const snapshot = unwrap(
            await remote.setTeamMemberMode(lead, id, value.kind === 'mode' ? value.id : String(value.value)),
          )
          if (alive.current) setSnapshots((old) => ({ ...old, [id]: snapshot }))
        },
      })
      if (alive.current) {
        setFeedback({ key: 'teamModeResult', applied: result.applied, skipped: result.skipped, failed: result.failed })
        setResults(result.members)
      }
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const currentLabels = new Set(
    members.map((member) =>
      snapshots[member.sessionId]
        ? teamModeLabel(snapshots[member.sessionId]!, t('teamModeUnknown'))
        : t('teamModeUnknown'),
    ),
  )
  const batchGroup: AgentControlGroup = {
    kind: 'mode',
    id: 'mode',
    name: t('agentControlMode'),
    current: currentLabels.size === 1 ? [...currentLabels][0]! : t('agentControlMixed'),
    choices: batchChoices.map((choice) => ({
      id: choice.id,
      label: choice.name,
      write: choice.write,
      current: members.every((member) => choices(member).some((item) => item.id === choice.id && item.current)),
      disabled:
        busy ||
        !members.some(
          (member) => editable(member) && choices(member).some((item) => item.id === choice.id && !item.current),
        ),
    })),
  }
  return h(
    'section',
    { 'data-acp-mode-group': profileId ?? 'unknown' },
    h(
      'div',
      { className: css.groupHeader },
      h('strong', null, profileId ?? t('teamProfileUnknown')),
      h(
        'div',
        { className: css.batchActions },
        interrupt === null
          ? null
          : h(
              Button,
              {
                variant: 'ghost',
                className: css.batchButton,
                disabled: interrupt.disabled,
                title: t('teamInterruptHint'),
                onClick: interrupt.run,
              },
              t(interrupt.busy ? 'teamInterrupting' : 'teamInterruptAll'),
            ),
        h(AgentSessionMenu, {
          groups: [batchGroup],
          label: t('teamBatchMode'),
          t,
          open: menu === 'batch',
          side: 'bottom',
          align: 'end',
          disabled: batchChoices.length === 0 || profileId === null || busy,
          onOpenChange: (value) => updateMenu(value ? 'batch' : null),
          onSelect: (choice) => {
            if (choice.write.kind !== 'tool-approval-policy')
              void change(
                members.map((member) => member.sessionId),
                choice.write.kind === 'mode' ? choice.write.id : String(choice.write.value),
              )
          },
        }),
      ),
    ),
    h(
      'div',
      { className: css.roster },
      ...members.map((member) => {
        const snapshot = snapshots[member.sessionId]
        const modeNotice = snapshot?.pendingModeId
          ? t('teamModePending', { mode: teamModeLabel({ ...snapshot, pendingModeId: null }, t('teamModeUnknown')) })
          : null
        const reported = snapshot?.configOptions?.find(
          (option) =>
            normalizeAcpConfigOptionKey(option.id) === 'model' ||
            normalizeAcpConfigOptionKey(option.category ?? '') === 'model',
        )
        const model = member.model ?? (reported?.type === 'select' ? reported.currentValue : null)
        return h(
          'article',
          { key: member.sessionId, className: css.member, 'data-acp-managed-member': member.name },
          h(
            'div',
            { className: css.memberHeader },
            h(StateDot, {
              state: member.status === 'running' ? 'ongoing' : 'idle',
            }),
            h('span', { className: css.memberName }, member.name),
            h(
              'span',
              { className: css.hint },
              t(member.runtimeKnown ? `teamStatus${member.status}` : 'teamStatusunknown'),
            ),
          ),
          h(
            'div',
            { className: css.settings },
            h(
              'div',
              { className: css.settingRow },
              h('span', { className: css.settingLabel }, t('teamModelLabel')),
              h(
                'div',
                { className: css.settingValue },
                h(TeamMemberModelControl, {
                  lead,
                  member,
                  initialModel: model,
                  sessionReady:
                    metadataCurrent &&
                    member.runtimeKnown &&
                    snapshot != null &&
                    snapshot.profileId === member.profileId,
                  remote,
                  t,
                  isCurrent,
                  useSessionAccess,
                  sessionAccessSource,
                }),
              ),
            ),
            h(
              'div',
              { className: css.settingRow },
              h('span', { className: css.settingLabel }, t('teamModeLabel')),
              h(
                'div',
                { className: css.settingValue },
                h(
                  'div',
                  { className: css.modeControl },
                  h(AgentSessionMenu, {
                    groups: snapshot ? teamSessionMenuGroups(snapshot, t, !busy && editable(member) === true) : [],
                    ...(!editable(member)
                      ? {
                          footer: [
                            {
                              type: 'label' as const,
                              id: 'read-only',
                              text: t(member.status === 'running' ? 'agentControlRunning' : 'agentControlReadOnly'),
                            },
                          ],
                        }
                      : {}),
                    label: snapshot ? agentControlLabel(snapshot, t) : t('teamModeUnknown'),
                    t,
                    open: menu === member.sessionId,
                    side: 'bottom',
                    align: 'end',
                    disabled: !snapshot || choices(member).length === 0 || busy,
                    onOpenChange: (value) => updateMenu(value ? member.sessionId : null),
                    onSelect: (choice) => {
                      if (choice.write.kind !== 'tool-approval-policy')
                        void change(
                          [member.sessionId],
                          choice.write.kind === 'mode' ? choice.write.id : String(choice.write.value),
                        )
                    },
                  }),
                  h(
                    'div',
                    { className: css.settingNotice, 'data-member-mode-notice': '', role: 'status' },
                    modeNotice ? h('span', { title: modeNotice, 'data-member-pending-mode': '' }, modeNotice) : null,
                  ),
                ),
              ),
            ),
          ),
        )
      }),
    ),
    h('div', { role: 'status', className: css.groupNotice }, feedback === undefined ? '' : t(feedback.key, feedback)),
    results.length === 0
      ? null
      : h(
          'details',
          { className: css.resultDetails },
          h('summary', null, t('teamResultDetails')),
          h(
            'ul',
            null,
            ...results.map((result) =>
              h(
                'li',
                { key: result.sessionId },
                `${members.find((member) => member.sessionId === result.sessionId)?.name ?? result.sessionId}: ${t(`teamResult${result.reason}`)}`,
              ),
            ),
          ),
        ),
  )
}
