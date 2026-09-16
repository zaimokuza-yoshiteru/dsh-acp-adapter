import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Menu, StateDot, IconChevronDownOutline14, IconCloseOutline16, IconRefreshOutline14, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpRemoteLike, AcpTeamMemberView, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import { snapshotIsAcp } from './AcpAgentControl.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { applyTeamMode, teamModeChoices } from './team-mode-controls.ts'
import { teamModeLabel } from '../../contract/session-modes.ts'
import { TeamMemberModelControl } from './TeamMemberModelControl.ts'
import css from './AcpTeamManagement.module.css'
import agentControlCss from './AcpAgentControl.module.css'

type Copy = PropsLocale<'acpActivity'>['t']
type Actions = {
  remote: AcpRemoteLike
  streamFactory: RemoteStreamFactory
  isCurrent(sessionId: SessionId): boolean
  ownsRoute: OwnsAcpRoute
}
export function AcpTeamManagement({ sessionId, useSession, useProjection, t, ...actions }: PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'acpActivity'> & Actions): ReactNode {
  const child = useSession(state => state.subagent?.address?.parentSessionId !== undefined)
  const running = useSession(state => state.running)
  const enabled = !child && snapshotIsAcp(useProjection('modelSelection'), actions.ownsRoute)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  useDismissOnOutsidePointer(rootRef, open && !menuOpen, setOpen)
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, gap: 6, margin: 16 })
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role=menu]')) return
      setOpen(false)
      rootRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [open])
  const [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<{ id: string; members: readonly AcpTeamMemberView[] } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => { setOpen(false); setView(null); setError(false) }, [sessionId])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false, loading = false
    const load = async (): Promise<void> => {
      if (loading) return
      loading = true
      try {
        const result = await actions.remote.teamMembers(sessionId)
        if (cancelled) return
        if (result.ok) { setView({ id: sessionId, members: result.value }); setError(false) }
        else setError(true)
      } catch { if (!cancelled) setError(true) }
      finally { loading = false }
    }
    void load()
    const timer = open ? setInterval(() => { void load() }, 2500) : undefined
    return () => { cancelled = true; if (timer !== undefined) clearInterval(timer) }
  }, [sessionId, enabled, open, running, refresh, actions.remote])
  if (!enabled || view?.id !== sessionId || view.members.length === 0) return null
  const groups = Map.groupBy(view.members, member => member.profileId)
  return h('div', { className: css.root, ref: rootRef, 'data-acp-team-management': '' },
    h(Button, { variant: 'ghost', className: css.trigger, 'aria-label': `${t('teamManage')} · ${view.members.length}`, title: t('teamManage'),
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 9, cy: 8, r: 3 }), h('path', { d: 'M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2' }))),
    open ? h('div', { className: css.panel, ref: panelRef, style: position ?? { visibility: 'hidden' }, role: 'dialog', 'aria-label': t('teamManage') },
      h('div', { className: css.toolbar }, h('strong', null, t('teamManage')),
        h(Button, { variant: 'ghost', className: css.iconButton, 'aria-label': t('teamRefresh'), onClick: () => setRefresh(n => n + 1) }, h(IconRefreshOutline14)),
        h(Button, { variant: 'ghost', className: css.iconButton, 'aria-label': t('teamManageClose'), onClick: () => { setOpen(false); rootRef.current?.querySelector('button')?.focus() } }, h(IconCloseOutline16))),
      error ? h('p', { role: 'status', className: css.hint }, t('teamManageError')) : null,
      ...[...groups].map(([profileId, members]) => h(ModeGroup, { key: `${sessionId}:${profileId}`, lead: sessionId, profileId, members, t, onMenuOpen: setMenuOpen, ...actions }))) : null)
}

function ModeGroup({ lead, profileId, members, t, remote, streamFactory, onMenuOpen, isCurrent }: { lead: SessionId; profileId: string | null; members: readonly AcpTeamMemberView[]; t: Copy; onMenuOpen(value: boolean): void } & Actions): ReactNode {
  const [snapshots, setSnapshots] = useState<Record<string, AcpAgentSessionSnapshotView | null>>({})
  const [menu, setMenu] = useState<string | null>(null)
  useEffect(() => { onMenuOpen(menu !== null); return () => onMenuOpen(false) }, [menu, onMenuOpen])
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const alive = useRef(true)
  const [feedback, setFeedback] = useState('')
  const ids = members.map(member => member.sessionId).join('|')
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let disposed = false
    const streams = ids.split('|').map(id => agentSessionStream(remote, streamFactory, id,
      snapshot => { if (!disposed) setSnapshots(old => ({ ...old, [id]: snapshot })) },
      () => { if (!disposed) setSnapshots(old => ({ ...old, [id]: old[id] ? { ...old[id], editable: false, modeWritable: false, freshness: 'stale' } : null })) }))
    streams.forEach(stream => stream.start())
    return () => { disposed = true; streams.forEach(stream => { void stream.dispose() }) }
  }, [ids, remote, streamFactory])
  const editable = (member: AcpTeamMemberView) => (member.status === 'idle' || member.status === 'inactive') && snapshots[member.sessionId]?.profileId === profileId && snapshots[member.sessionId]?.modeWritable
  const choices = (member: AcpTeamMemberView) => { const snapshot = snapshots[member.sessionId]; return snapshot ? teamModeChoices(snapshot).map(choice => ({ ...choice, current: snapshot.pendingModeId ? snapshot.pendingModeId === choice.id : choice.current })) : [] }
  const batchChoices = [...new Map(members.flatMap(member => choices(member)).map(choice => [choice.id, choice])).values()]
  const change = async (targets: readonly string[], mode: string): Promise<void> => {
    if (locked.current || profileId === null) return
    locked.current = true; setBusy(true); setMenu(null); setFeedback('')
    const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    try {
      const result = await applyTeamMode({ targets, profileId, mode, isCurrent: () => alive.current && isCurrent(lead),
        members: async () => unwrap(await remote.teamMembers(lead)),
        snapshot: async id => unwrap(await remote.agentSessionSnapshot(id)),
        write: async (id, value) => { const snapshot = unwrap(await remote.setTeamMemberMode(lead, id, value.kind === 'mode' ? value.id : String(value.value))); if (alive.current) setSnapshots(old => ({ ...old, [id]: snapshot })) },
      })
      if (alive.current) setFeedback(t('teamModeResult', result))
    } finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return h('section', { 'data-acp-mode-group': profileId ?? 'unknown' },
    h('div', { className: css.groupHeader }, h('strong', null, profileId ?? t('teamProfileUnknown')),
      h(Menu, { portal: true, autoFocus: true, open: menu === 'batch', side: 'bottom', align: 'end', onClose: () => setMenu(null),
        items: batchChoices.map(choice => ({ id: choice.id, label: choice.label, disabled: busy || !members.some(member => editable(member) && choices(member).some(item => item.id === choice.id && !item.current)) })),
        onSelect: (id: string) => { void change(members.map(member => member.sessionId), id) },
        anchor: h(Button, { variant: 'ghost', disabled: batchChoices.length === 0 || profileId === null || busy, onClick: () => setMenu(menu === 'batch' ? null : 'batch') }, t('teamBatchMode')) })),
    h('div', { className: css.roster }, ...members.map(member => {
      const snapshot = snapshots[member.sessionId]
      const modeChoices = choices(member)
      const selectedMode = modeChoices.find(choice => choice.current)
      const modeNotice = snapshot?.pendingModeId
        ? t('teamModePending', { mode: teamModeLabel({ ...snapshot, pendingModeId: null }, t('teamModeUnknown')) })
        : null
      const reported = snapshot?.configOptions?.find(option => normalizeAcpConfigOptionKey(option.id) === 'model' || normalizeAcpConfigOptionKey(option.category ?? '') === 'model')
      const model = member.model ?? (reported?.type === 'select' ? reported.currentValue : null)
      return h('article', { key: member.sessionId, className: css.member, 'data-acp-managed-member': member.name },
        h('div', { className: css.memberHeader }, h(StateDot, { state: member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'done' }),
          h('strong', null, member.name), h('span', { className: css.hint }, t(`teamStatus${member.status}`))),
        member.description ? h('p', { className: css.memberDescription, title: member.description }, member.description) : null,
        h('div', { className: css.settings },
          h('div', { className: css.settingRow },
            h('span', { className: css.settingLabel }, t('teamModelLabel')),
            h('div', { className: css.settingValue },
              h(TeamMemberModelControl, { lead, member, initialModel: model, remote, t, isCurrent, onMenuOpen }))),
          h('div', { className: css.settingRow },
            h('span', { className: css.settingLabel }, t('teamModeLabel')),
            h('div', { className: css.settingValue },
              h('div', { className: css.modeControl },
                h(Menu, { portal: true, autoFocus: true, open: menu === member.sessionId, side: 'bottom', align: 'end', onClose: () => setMenu(null),
                  items: modeChoices.map(choice => ({ id: choice.id, label: choice.label, disabled: busy || !editable(member) })),
                  selectedId: selectedMode?.id,
                  onSelect: (id: string) => { void change([member.sessionId], id) },
                  anchor: h('button', { type: 'button', className: agentControlCss.trigger, disabled: !snapshot || modeChoices.length === 0 || busy, 'aria-expanded': menu === member.sessionId, 'aria-haspopup': 'menu', onClick: () => setMenu(menu === member.sessionId ? null : member.sessionId) },
                    h('span', { className: agentControlCss.triggerLabel }, snapshot ? `Agent · ${teamModeLabel(snapshot, t('teamModeUnknown'))}` : t('teamModeUnknown')),
                    h(IconChevronDownOutline14, { className: `${agentControlCss.chevron}${menu === member.sessionId ? ` ${agentControlCss.chevronOpen}` : ''}` })) }),
                h('div', { className: css.settingNotice, 'data-member-mode-notice': '', role: 'status' }, modeNotice ? h('span', { title: modeNotice, 'data-member-pending-mode': '' }, modeNotice) : null))))))
    })),
    h('div', { role: 'status', className: css.groupNotice, title: feedback }, feedback))
}
