/** 会话 header 上的插件自有 ACP 审计入口。 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpAuditSummaryCode, AcpAuditTimelineEntry } from '../data/acp-remote.ts'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpAuditHeaderAction.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

export interface AcpAuditHeaderActionProps {
  sessionId?: string
  remote?: AcpRemoteLike
  t?: Translate
}

type Filter = 'all' | 'recovery' | 'permission' | 'agent' | 'files' | 'config'

/** 审计行摘要事实在客户端本地化，避免 host 固定使用某一种语言。 */

export function auditHeaderVisible(backend: { readonly state: string; readonly provider?: string } | null | undefined): boolean {
  return backend?.state === 'established' && backend.provider?.startsWith('acp-') === true
}

export function auditEntryMatchesFilter(entry: AcpAuditTimelineEntry, filter: Filter): boolean {
  return filter === 'all' || entry.category === filter
}

const summaryKeys: Record<AcpAuditSummaryCode, AcpLocaleKey> = {
  'binding.established': 'auditSummaryBinding',
  'permission.asked': 'auditSummaryPermissionAsked',
  'permission.decided': 'auditSummaryPermissionDecided',
  'permission-scope.recorded': 'auditSummaryPermissionScope',
  'agent-mode.changed': 'auditSummaryAgentMode',
  'agent-config.changed': 'auditSummaryAgentConfig',
  'reconciliation.required': 'auditSummaryReconciliation',
  'replay.matched': 'auditSummaryReplayMatched',
  'replay.different': 'auditSummaryReplayDifferent',
  'replay.overflow': 'auditSummaryReplayOverflow',
  'replay.not-compared': 'auditSummaryReplayNotCompared',
  'replay.unavailable': 'auditSummaryReplayUnavailable',
  'degradation.recorded': 'auditSummaryDegradation',
  'elicitation.requested': 'auditSummaryElicitationRequested',
  'elicitation.decided': 'auditSummaryElicitationDecided',
  'filesystem.operation': 'auditSummaryFilesystem',
  'terminal.operation': 'auditSummaryTerminal',
  'agent.event': 'auditSummaryAgentEvent',
}

export function auditSummaryOf(t: Translate | undefined, entry: AcpAuditTimelineEntry): string {
  const base = textOf(t, summaryKeys[entry.summaryCode], 'Agent event recorded')
  const status = entry.status === null ? null : auditStatusOf(t, entry.status)
  return [base, entry.subject, status].filter((value): value is string => value !== null && value !== '').join(' · ')
}

function auditStatusOf(t: Translate | undefined, status: string): string {
  const key: Partial<Record<string, AcpLocaleKey>> = {
    'danger-full-access': 'auditStatusNativeAccess',
    set_config_option: 'auditStatusConfigSync',
    'session-setup': 'auditStatusSessionSetup',
    ok: 'auditStatusOk',
    error: 'auditStatusError',
    aborted: 'auditStatusAborted',
    timeout: 'auditStatusTimeout',
    'concurrent-change': 'auditStatusConcurrentChange',
    selected: 'auditStatusSelected',
    cancelled: 'auditStatusCancelled',
    started: 'auditStatusStarted',
    running: 'auditStatusRunning',
    exited: 'auditStatusExited',
    killed: 'auditStatusKilled',
    released: 'auditStatusReleased',
  }
  const localeKey = key[status]
  return localeKey === undefined ? status : textOf(t, localeKey, status)
}

function categoryLabel(t: Translate | undefined, category: AcpAuditTimelineEntry['category']): string {
  const key: Record<AcpAuditTimelineEntry['category'], AcpLocaleKey> = {
    recovery: 'auditCategoryRecovery', permission: 'auditCategoryPermission', agent: 'auditCategoryAgent',
    files: 'auditCategoryFiles', config: 'auditCategoryConfig',
  }
  return textOf(t, key[category], category)
}

function textOf(t: Translate | undefined, key: AcpLocaleKey, fallback: string): string {
  const result = t?.(key)
  return result === undefined || result.trim() === '' ? fallback : result
}

function timeOf(epoch: number): string {
  try { return new Date(epoch).toLocaleString() } catch { return String(epoch) }
}

export function AcpAuditHeaderAction(props: AcpAuditHeaderActionProps): ReactNode {
  const { sessionId, remote, t } = props
  const [isAcp, setIsAcp] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [entries, setEntries] = useState<readonly AcpAuditTimelineEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(0)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const requestEpoch = useRef(0)

  useEffect(() => {
    requestEpoch.current += 1
    let disposed = false
    setIsAcp(false)
    setOpen(false)
    setLoading(false)
    setEntries([])
    setCursor(0)
    setHasMore(false)
    setError(null)
    setFilter('all')
    if (sessionId === undefined || remote === undefined) return
    void remote.backendOf(sessionId).then((result) => {
      if (!disposed && result.ok && auditHeaderVisible(result.value)) setIsAcp(true)
    }).catch(() => undefined)
    return () => { disposed = true }
  }, [sessionId, remote])

  const load = (reset: boolean): void => {
    if (sessionId === undefined || remote?.auditTimeline === undefined || loading) return
    requestEpoch.current += 1
    const epoch = requestEpoch.current
    setLoading(true)
    setError(null)
    const afterSeq = reset ? 0 : cursor ?? 0
    void remote.auditTimeline(sessionId, { afterSeq, limit: 50 }).then((result) => {
      if (epoch !== requestEpoch.current) return
      if (!result.ok) { setError(textOf(t, 'auditUnavailable', 'Agent audit records are unavailable on this host.')); return }
      setEntries((previous) => reset ? result.value.entries : [...previous, ...result.value.entries])
      setCursor(result.value.nextCursor)
      setHasMore(result.value.hasMore)
    }).catch(() => {
      if (epoch === requestEpoch.current) setError(textOf(t, 'auditUnavailable', 'Agent audit records are unavailable on this host.'))
    }).finally(() => {
      if (epoch === requestEpoch.current) setLoading(false)
    })
  }

  const visible = useMemo(() => entries.filter((entry) => auditEntryMatchesFilter(entry, filter)), [entries, filter])
  if (!isAcp || sessionId === undefined || remote?.auditTimeline === undefined) return null
  const labels: readonly [Filter, AcpLocaleKey][] = [
    ['all', 'auditAll'], ['recovery', 'auditFilterRecovery'], ['permission', 'auditFilterPermission'],
    ['agent', 'auditFilterAgent'], ['files', 'auditFilterFiles'], ['config', 'auditFilterConfig'],
  ]
  return h('div', { className: css.root },
    h('button', { type: 'button', className: css.trigger, onClick: () => { setOpen(true); load(true) } }, textOf(t, 'auditOpen', 'Agent audit')),
    h(Modal, {
      open,
      onClose: () => setOpen(false),
      title: textOf(t, 'auditTitle', 'Agent audit'),
      closeLabel: textOf(t, 'auditClose', 'Close'),
      className: css.modal ?? '',
      contentClassName: css.content ?? '',
    },
      h('div', { className: css.filters, role: 'toolbar' }, ...labels.map(([value, key]) => h('button', {
        key: value, type: 'button', className: value === filter ? css.filterActive : css.filter,
        onClick: () => setFilter(value),
      }, textOf(t, key, value))),),
      loading && entries.length === 0 ? h('p', { className: css.muted }, textOf(t, 'auditLoading', 'Loading audit records…')) : null,
      error === null ? null : h('p', { className: css.error, role: 'alert' }, error),
      !loading && error === null && visible.length === 0 ? h('p', { className: css.muted }, entries.length === 0 ? textOf(t, 'auditEmpty', 'No Agent-specific audit records yet.') : textOf(t, 'auditNoMatch', 'No records match this filter.')) : null,
      h('ol', { className: css.ledger }, ...visible.map((entry) => h('li', { key: `${entry.seq}-${entry.kind}`, className: css.entry },
        h('div', { className: css.entryHead },
          h('span', { className: css.kind }, categoryLabel(t, entry.category)),
          h('time', { dateTime: new Date(entry.time).toISOString() }, timeOf(entry.time)),
        ),
        h('p', { className: css.summary }, auditSummaryOf(t, entry)),
        entry.detail === null ? null : h('details', { className: css.details },
          h('summary', null, textOf(t, 'auditDetails', 'View details')),
          h('pre', null, entry.detail),
        ),
      ))),
      hasMore ? h('button', { type: 'button', className: css.more, disabled: loading, onClick: () => load(false) }, textOf(t, 'auditLoadMore', 'Load more')) : null,
      !hasMore && entries.length > 0 ? h('p', { className: css.end }, textOf(t, 'auditPageEnd', 'All records are shown')) : null,
    ),
  )
}

export function createAcpAuditHeaderAction(remote: AcpRemoteLike): (props: AcpAuditHeaderActionProps) => ReactNode {
  return (props) => h(AcpAuditHeaderAction, { ...props, remote })
}
