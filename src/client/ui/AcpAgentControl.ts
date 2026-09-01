import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView, AcpAgentSessionOptionWrite } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import { isAcpModelOrReasoningOption } from '../../contract/config-options.ts'
import css from './AcpAgentControl.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type AgentControlProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'acpActivity'> & {
  readonly remote: AcpRemoteLike
  readonly ownsRoute: OwnsAcpRoute
}

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { readonly provider?: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

export function snapshotIsAcp(value: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof value !== 'object' || value === null) return false
  const selection = value as { readonly lastUsed?: unknown; readonly next?: unknown }
  const current = selection.next === undefined ? selection.lastUsed : selection.next
  return ownsRoute(providerOf(current))
}

function optionLabel(option: NonNullable<AcpAgentSessionSnapshotView['configOptions']>[number]): string {
  if (option.type === 'boolean') return `${option.name}: ${option.currentValue ? 'On' : 'Off'}`
  return `${option.name}: ${option.currentValue}`
}

function isModeConfigOption(option: NonNullable<AcpAgentSessionSnapshotView['configOptions']>[number]): boolean {
  const id = option.id.trim().toLowerCase().replaceAll('-', '_')
  const category = option.category?.trim().toLowerCase().replaceAll('-', '_') ?? ''
  return id === 'mode' || category === 'mode'
}

export function agentControlMenuItems(snapshot: AcpAgentSessionSnapshotView, t: Translate): { readonly id: string; readonly label: ReactNode; readonly write: AcpAgentSessionOptionWrite; readonly disabled?: boolean }[] {
  const items: { id: string; label: ReactNode; write: AcpAgentSessionOptionWrite; disabled?: boolean }[] = []
  const disabled = !snapshot.editable || snapshot.freshness !== 'live'
  // ACP's config option is the canonical write path. Agents such as Devin
  // advertise the same mode roster through both transition-era surfaces; use
  // legacy set_mode only when no mode config option exists.
  if (!(snapshot.configOptions ?? []).some(isModeConfigOption)) {
    for (const mode of snapshot.modes ?? []) {
      items.push({ id: `mode:${mode.id}`, label: mode.name, write: { kind: 'mode', id: mode.id }, disabled })
    }
  }
  for (const option of snapshot.configOptions ?? []) {
    // Model and reasoning remain exclusively in DSH's native ModelPicker.
    if (isAcpModelOrReasoningOption(option)) continue
    if (option.type === 'boolean') {
      items.push({ id: `config:${option.id}`, label: optionLabel(option), write: { kind: 'config', id: option.id, value: !option.currentValue }, disabled })
      continue
    }
    for (const value of option.options) {
      if ('value' in value) items.push({ id: `config:${option.id}:${value.value}`, label: `${option.name}: ${value.name}`, write: { kind: 'config', id: option.id, value: value.value }, disabled })
      else for (const child of value.options) items.push({ id: `config:${option.id}:${child.value}`, label: `${option.name}: ${child.name}`, write: { kind: 'config', id: option.id, value: child.value }, disabled })
    }
  }
  if (items.length === 0 && snapshot.note !== null) items.push({ id: 'unavailable', label: t('agentControlUnavailable'), write: { kind: 'mode', id: '' }, disabled: true })
  return items
}

export function shouldRefreshAgentControlAfterRun(previous: boolean, current: boolean): boolean {
  return previous && !current
}

function currentModeName(snapshot: AcpAgentSessionSnapshotView): string {
  return snapshot.modes?.find(mode => mode.id === snapshot.currentModeId)?.name ?? snapshot.currentModeId ?? 'Native'
}

export function agentControlLabel(snapshot: AcpAgentSessionSnapshotView): string {
  return `Agent · ${currentModeName(snapshot)}`
}

export function agentControlFooter(snapshot: AcpAgentSessionSnapshotView, t: Translate): readonly { readonly type: 'label'; readonly id: string; readonly text: string }[] {
  const footer: { readonly type: 'label'; readonly id: string; readonly text: string }[] = []
  if (snapshot.contextUsage !== null) {
    footer.push({ type: 'label', id: 'context-usage', text: t('agentContextUsage', { used: snapshot.contextUsage.used, size: snapshot.contextUsage.size, percent: snapshot.contextUsage.percent }) })
    if (snapshot.contextUsage.cost !== null) footer.push({ type: 'label', id: 'session-cost', text: t('agentSessionCost', { amount: snapshot.contextUsage.cost.amount, currency: snapshot.contextUsage.cost.currency }) })
  }
  if (snapshot.freshness === 'stale') footer.push({ type: 'label', id: 'stale', text: t('agentStateStale') })
  return footer
}

/** Small ACP-only control in DSH's native input-left extension point. */
export function AcpAgentControl({ sessionId, useProjection, useSession, t, remote, ownsRoute }: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const running = useSession(state => state.running)
  const isAcp = snapshotIsAcp(projection, ownsRoute)
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useMemo(() => ({ value: 0 }), [])
  const refreshState = useRef<{ readonly sessionId: string | undefined; readonly isAcp: boolean; readonly running: boolean }>({ sessionId: undefined, isAcp: false, running })

  const loadSnapshot = (): void => {
    // ACP has no bounded client subscription in this host yet: refresh on
    // open (and use the post-write response) so controls are timely without a
    // high-frequency polling loop.
    if (!isAcp || sessionId === undefined) return
    const current = epoch.value
    void remote.agentSessionSnapshot(sessionId).then(result => {
      if (current !== epoch.value || !result.ok) return
      setSnapshot(result.value)
      setError(null)
    }).catch(() => {
      if (current === epoch.value) setError(t('agentControlUnavailable'))
    })
  }

  useEffect(() => {
    epoch.value += 1
    const current = epoch.value
    setOpen(false)
    setError(null)
    setSnapshot(null)
    if (!isAcp || sessionId === undefined) return
    void remote.agentSessionSnapshot(sessionId).then(result => {
      if (current !== epoch.value || !result.ok) return
      setSnapshot(result.value)
    }).catch(() => {
      if (current === epoch.value) setError(t('agentControlUnavailable'))
    })
  }, [epoch, isAcp, remote, sessionId, t])

  useEffect(() => {
    const previous = refreshState.current
    const scopeChanged = previous.sessionId !== sessionId || previous.isAcp !== isAcp
    refreshState.current = { sessionId, isAcp, running }
    if (scopeChanged || !shouldRefreshAgentControlAfterRun(previous.running, running)) return
    // A blank ACP launcher has no binding/runtime snapshot yet. The first
    // completed run establishes it; the host's session lifecycle is already a
    // bounded push signal, so refresh once here instead of polling or requiring
    // a reload.
    loadSnapshot()
  }, [isAcp, remote, running, sessionId, t])

  if (!isAcp || snapshot === null) return null
  const label = agentControlLabel(snapshot)
  const items = agentControlMenuItems(snapshot, t)
  const footer = [...agentControlFooter(snapshot, t)]
  if (error !== null) footer.push({ type: 'label', id: 'error', text: error })
  const select = (id: string): void => {
    const item = items.find(candidate => candidate.id === id)
    if (item === undefined || item.id === 'unavailable' || !snapshot.editable || snapshot.freshness !== 'live' || sessionId === undefined) return
    setBusy(true)
    setError(null)
    void remote.setAgentSessionOption(sessionId, item.write).then(result => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error.message)
    }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const description = t('agentControlTooltip')
  return h(Menu, {
    open,
    // This control shares DSH's bottom input row; match the native permission
    // selector and open upward so every Agent option remains reachable.
    side: 'top',
    items,
    onSelect: select,
    onClose: () => setOpen(false),
    anchor: h(Tooltip, { label: description, children: h('button', {
      type: 'button', className: css.trigger, disabled: busy, 'aria-expanded': open,
      onClick: () => { if (!open) loadSnapshot(); setOpen(value => !value) },
    },
    h('span', { className: css.triggerLabel }, label),
    h(IconChevronDownOutline14, { className: `${css.chevron}${open ? ` ${css.chevronOpen}` : ''}` }),
    ) }),
    ...(footer.length === 0 ? {} : { footer }),
  })
}
