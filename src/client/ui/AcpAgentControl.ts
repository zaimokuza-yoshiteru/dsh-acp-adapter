import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView, AcpAgentSessionOptionWrite } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import { isAcpModelOrReasoningOption } from '../../contract/config-options.ts'
import css from './AcpAgentControl.module.css'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { agentSessionStream } from '../data/agent-session-stream.ts'

type Translate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type AgentControlProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'acpActivity'> & {
  readonly remote: AcpRemoteLike
  readonly streamFactory: RemoteStreamFactory
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
      items.push({ id: `config:${option.id}`, label: `${option.name}: ${t(option.currentValue ? 'agentControlOn' : 'agentControlOff')}`, write: { kind: 'config', id: option.id, value: !option.currentValue }, disabled })
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

function currentModeName(snapshot: AcpAgentSessionSnapshotView, t: Translate): string {
  const mode = snapshot.configOptions?.find(isModeConfigOption)
  if (mode?.type === 'select') {
    const values = mode.options.flatMap(entry => 'options' in entry ? entry.options : [entry])
    return values.find(value => value.value === mode.currentValue)?.name ?? mode.currentValue
  }
  return snapshot.modes?.find(mode => mode.id === snapshot.currentModeId)?.name ?? snapshot.currentModeId ?? t('agentControlDefault')
}

export function agentControlLabel(snapshot: AcpAgentSessionSnapshotView, t: Translate): string {
  return `Agent · ${currentModeName(snapshot, t)}`
}

/** Compact ACP token counts without falling back to an unqualified raw count. */
export function formatContextTokenCount(value: number): string {
  const unit = value >= 1_000_000 ? 'm' : 'k'
  const divisor = unit === 'm' ? 1_000_000 : 1_000
  const scaled = value / divisor
  // Match the host's compact context figures for ordinary K/M values while
  // retaining enough precision below 1k to avoid displaying a non-zero count
  // as zero. The raw count determines the unit, so rounding never promotes it.
  const fractionDigits = scaled < 1 ? 3 : scaled < 100 ? 1 : 0
  const factor = 10 ** fractionDigits
  return `${String(Math.round(scaled * factor) / factor)}${unit}`
}

export function agentControlFooter(snapshot: AcpAgentSessionSnapshotView, t: Translate): readonly { readonly type: 'label'; readonly id: string; readonly text: string }[] {
  const footer: { readonly type: 'label'; readonly id: string; readonly text: string }[] = []
  if (snapshot.contextUsage !== null) {
    footer.push({ type: 'label', id: 'context-usage', text: t('agentContextUsage', { used: formatContextTokenCount(snapshot.contextUsage.used), size: formatContextTokenCount(snapshot.contextUsage.size), percent: snapshot.contextUsage.percent }) })
    if (snapshot.contextUsage.cost !== null) footer.push({ type: 'label', id: 'session-cost', text: t('agentSessionCost', { amount: snapshot.contextUsage.cost.amount, currency: snapshot.contextUsage.cost.currency }) })
  }
  if (snapshot.freshness === 'stale') footer.push({ type: 'label', id: 'stale', text: t('agentStateStale') })
  return footer
}

/** Small ACP-only control in DSH's native input-left extension point. */
export function AcpAgentControl({ sessionId, useProjection, useSession, t, remote, streamFactory, ownsRoute }: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const running = useSession(state => state.running)
  const isAcp = snapshotIsAcp(projection, ownsRoute)
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useMemo(() => ({ value: 0 }), [])
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const current = ++epoch.value
    setOpen(false)
    setBusy(false)
    setError(null)
    setSnapshot(null)
    if (!isAcp || sessionId === undefined) return
    const stream = agentSessionStream(remote, streamFactory, sessionId, value => {
      if (current !== epoch.value) return
      setSnapshot(value)
      setError(null)
    }, () => {
      if (current !== epoch.value) return
      setSnapshot(value => value === null ? null : { ...value, editable: false, freshness: 'stale' })
      setError(t('agentControlUnavailable'))
    })
    stream.start()
    return () => {
      ++epoch.value
      void stream.dispose()
    }
  }, [epoch, isAcp, remote, streamFactory, sessionId, t, retry])

  if (!isAcp || (snapshot !== null && snapshot.sessionId !== sessionId)) return null
  if (snapshot === null) return error === null ? null : h('button', {
    type: 'button', className: css.trigger,
    onClick: () => setRetry(value => value + 1),
    title: t('agentControlRetry'),
  }, error)
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot = running ? { ...snapshot, editable: false } : snapshot
  const label = agentControlLabel(snapshot, t)
  const items = agentControlMenuItems(visibleSnapshot, t)
  const footer = [...agentControlFooter(snapshot, t)]
  if (error !== null) footer.push({ type: 'label', id: 'error', text: error })
  if (items.length === 0 && footer.length === 0) return null
  const select = (id: string): void => {
    const item = items.find(candidate => candidate.id === id)
    if (item === undefined || item.id === 'unavailable' || !visibleSnapshot.editable || snapshot.freshness !== 'live' || sessionId === undefined) return
    const current = epoch.value
    setBusy(true)
    setError(null)
    void remote.setAgentSessionOption(sessionId, item.write).then(result => {
      if (current !== epoch.value) return
      // The subscription owns snapshots, so a late write response cannot roll back a newer notification.
      if (!result.ok) setError(result.error.message)
    }).catch(reason => {
      if (current === epoch.value) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (current === epoch.value) setBusy(false) })
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
      onClick: () => { if (error !== null) setRetry(value => value + 1); setOpen(value => !value) },
    },
    h('span', { className: css.triggerLabel }, label),
    h(IconChevronDownOutline14, { className: `${css.chevron}${open ? ` ${css.chevronOpen}` : ''}` }),
    ) }),
    ...(footer.length === 0 ? {} : { footer }),
  })
}
