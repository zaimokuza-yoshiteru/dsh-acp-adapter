import type { AcpAgentSessionSnapshotView, AcpAgentSessionOptionWrite } from '../data/acp-remote.ts'
import type { AcpLocaleKey } from './locales.ts'
import { isAcpModelOrReasoningOption } from '../../contract/config-options.ts'
import { teamModeLabel } from '../../contract/session-modes.ts'

export type AgentControlTranslate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type Translate = AgentControlTranslate

function isModeConfigOption(option: NonNullable<AcpAgentSessionSnapshotView['configOptions']>[number]): boolean {
  const id = option.id.trim().toLowerCase().replaceAll('-', '_')
  const category = option.category?.trim().toLowerCase().replaceAll('-', '_') ?? ''
  return id === 'mode' || category === 'mode'
}

export interface AgentControlChoice {
  readonly id: string
  readonly label: string
  readonly description?: string | null
  readonly group?: string
  readonly current: boolean
  readonly write: AcpAgentSessionOptionWrite
  readonly disabled: boolean
}
export interface AgentControlGroup {
  readonly kind: 'mode' | 'config'
  readonly id: string
  readonly name: string
  readonly current: string
  readonly description?: string | null
  readonly choices: readonly AgentControlChoice[]
}

/** Normalize ACP settings once; native Menu owns selection styling and keyboard navigation. */
export function agentControlMenuGroups(snapshot: AcpAgentSessionSnapshotView, t: Translate): AgentControlGroup[] {
  const groups: AgentControlGroup[] = []
  const disabled = !snapshot.editable || snapshot.freshness !== 'live'
  // configOptions is canonical; legacy modes are only a fallback.
  if (!(snapshot.configOptions ?? []).some(isModeConfigOption) && (snapshot.modes?.length ?? 0) > 0) {
    groups.push({ kind: 'mode', id: 'mode', name: t('agentControlMode'), current: teamModeLabel(snapshot, t('agentControlDefault')),
      choices: (snapshot.modes ?? []).map(mode => ({ id: `mode:${mode.id}`, label: mode.name,
        current: mode.id === (snapshot.pendingModeId ?? snapshot.currentModeId),
        write: { kind: 'mode', id: mode.id }, disabled })) })
  }
  for (const option of snapshot.configOptions ?? []) {
    // Model and reasoning remain exclusively in DSH's native ModelPicker.
    if (isAcpModelOrReasoningOption(option)) continue
    const choices: AgentControlChoice[] = option.type === 'boolean'
      ? [false, true].map(value => ({ id: `config:${option.id}:${value}`, label: t(value ? 'agentControlOn' : 'agentControlOff'),
        current: value === option.currentValue, write: { kind: 'config', id: option.id, value }, disabled }))
      : option.options.flatMap(entry => ('value' in entry ? [entry] : entry.options).map(value => ({
        id: `config:${option.id}:${value.value}`, label: value.name,
        ...(value.description == null ? {} : { description: value.description }),
        ...('group' in entry ? { group: entry.name } : {}),
        current: value.value === (isModeConfigOption(option) ? snapshot.pendingModeId ?? option.currentValue : option.currentValue),
        write: { kind: 'config' as const, id: option.id, value: value.value }, disabled,
      })))
    groups.push({ kind: isModeConfigOption(option) ? 'mode' : 'config', id: `config:${option.id}`, name: option.name,
      current: choices.find(choice => choice.current)?.label ?? String(option.currentValue),
      ...(option.description == null ? {} : { description: option.description }), choices })
  }
  return groups
}

export function agentControlLabel(snapshot: AcpAgentSessionSnapshotView, t: Translate): string {
  return `${t('agentControlTitle')} · ${teamModeLabel(snapshot, t('agentControlDefault'))}`
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

