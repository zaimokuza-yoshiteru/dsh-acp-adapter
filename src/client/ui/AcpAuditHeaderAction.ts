/** ACP 审计的会话视图与条件注册门。 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconSearchOutline16, JsonTree } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpAuditSummaryCode, AcpAuditTimelineEntry } from '../data/acp-remote.ts'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import type { AcpLocaleKey } from './locales.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import css from './AcpAuditHeaderAction.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string
type Filter = 'all' | 'recovery' | 'permission' | 'agent' | 'files'

export interface AcpAuditVisibilityGateProps {
  sessionId?: string
  useSession?: SnapshotSelectorHook<SessionSnapshot>
  useProjection: UseProjection
  remote?: AcpRemoteLike
  ownsRoute: OwnsAcpRoute
  onVisibilityChange(sessionId: string, visible: boolean): void
}

export interface AcpAuditViewProps extends ConvViewProps {
  remote?: AcpRemoteLike
  t?: Translate
}

export function auditHeaderVisible(backend: { readonly state: string; readonly provider?: string } | null | undefined, ownsRoute: OwnsAcpRoute): boolean {
  return backend?.state === 'established' && ownsRoute(backend.provider)
}

/** 原生模型会话在本地投影门直接旁路，不发 ACP Remote 请求。 */
export function auditProjectionIsAcp(selection: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof selection !== 'object' || selection === null || !('lastUsed' in selection)) return false
  const provider = (selection as { lastUsed?: { provider?: unknown } | null }).lastUsed?.provider
  return typeof provider === 'string' && ownsRoute(provider)
}

/** 首轮建立 binding 或宿主恢复后触发一次可见性复核。 */
export function auditSessionRefreshKeyOf(snapshot: {
  readonly blank: boolean
  readonly promptAttempted: boolean
  readonly awaitingFirstTurn: boolean
  readonly running: boolean
  readonly openState: string
  readonly lastAgentError: string | null
} | null | undefined): string {
  if (snapshot === null || snapshot === undefined) return 'absent'
  return [
    snapshot.blank,
    snapshot.promptAttempted,
    snapshot.awaitingFirstTurn,
    snapshot.running,
    snapshot.openState,
    snapshot.lastAgentError ?? '',
  ].join('|')
}

export function auditEntryMatchesFilter(entry: AcpAuditTimelineEntry, filter: Filter): boolean {
  return filter === 'all' || entry.category === filter
}

/** Search only user-meaningful audit facts; compact raw JSON stays in details. */
export function auditEntryMatchesQuery(t: Translate | undefined, entry: AcpAuditTimelineEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized === '') return true
  return [
    categoryLabel(t, entry.category),
    auditSummaryOf(t, entry),
    entry.subject ?? '',
    entry.status ?? '',
  ].some(value => value.toLocaleLowerCase().includes(normalized))
}

const summaryKeys: Record<AcpAuditSummaryCode, AcpLocaleKey> = {
  'binding.established': 'auditSummaryBinding',
  'permission.asked': 'auditSummaryPermissionAsked',
  'permission.decided': 'auditSummaryPermissionDecided',
  'reconciliation.required': 'auditSummaryReconciliation',
  'replay.matched': 'auditSummaryReplayMatched',
  'replay.different': 'auditSummaryReplayDifferent',
  'replay.overflow': 'auditSummaryReplayOverflow',
  'replay.not-compared': 'auditSummaryReplayNotCompared',
  'replay.unavailable': 'auditSummaryReplayUnavailable',
  'degradation.recorded': 'auditSummaryDegradation',
  'filesystem.operation': 'auditSummaryFilesystem',
  'terminal.operation': 'auditSummaryTerminal',
  'session-fork.completed': 'auditSummarySessionFork',
  'agent.event': 'auditSummaryAgentEvent',
}

export function auditSummaryOf(t: Translate | undefined, entry: AcpAuditTimelineEntry): string {
  const base = textOf(t, summaryKeys[entry.summaryCode], 'Agent event recorded')
  const subject = entry.subject === null ? null : auditStatusOf(t, entry.subject)
  const status = entry.status === null ? null : auditStatusOf(t, entry.status)
  return [base, subject, status].filter((value): value is string => value !== null && value !== '').join(' · ')
}

function auditStatusOf(t: Translate | undefined, status: string): string {
  const key: Partial<Record<string, AcpLocaleKey>> = {
    'danger-full-access': 'auditStatusNativeAccess',
    set_config_option: 'auditStatusConfigSync',
    'session-setup': 'auditStatusSessionSetup',
    ok: 'auditStatusOk', error: 'auditStatusError', aborted: 'auditStatusAborted', timeout: 'auditStatusTimeout',
    'concurrent-change': 'auditStatusConcurrentChange', selected: 'auditStatusSelected', cancelled: 'auditStatusCancelled',
    started: 'auditStatusStarted', running: 'auditStatusRunning', exited: 'auditStatusExited', killed: 'auditStatusKilled', released: 'auditStatusReleased',
    inherited: 'auditForkInherited', blank: 'auditForkBlank',
    'agent-does-not-advertise-fork': 'auditForkUnsupported',
    'parent-not-idle': 'auditForkParentNotIdle',
    'parent-recovery-required': 'auditForkParentRecoveryRequired',
    'parent-binding-unavailable': 'auditForkParentUnavailable',
    'parent-binding-mismatch': 'auditForkParentMismatch',
    'seed-not-latest-semantic-boundary': 'auditForkOlderBoundary',
    'candidate-not-available': 'auditForkCandidateUnavailable',
  }
  const localeKey = key[status]
  return localeKey === undefined ? status : textOf(t, localeKey, status)
}

function categoryLabel(t: Translate | undefined, category: AcpAuditTimelineEntry['category']): string {
  const key: Record<AcpAuditTimelineEntry['category'], AcpLocaleKey> = {
    recovery: 'auditCategoryRecovery', permission: 'auditCategoryPermission', agent: 'auditCategoryAgent',
    files: 'auditCategoryFiles',
  }
  return textOf(t, key[category], category)
}

function categoryClass(category: AcpAuditTimelineEntry['category']): string {
  const className: Record<AcpAuditTimelineEntry['category'], string> = {
    recovery: css.recovery ?? '',
    permission: css.permission ?? '',
    agent: css.agent ?? '',
    files: css.files ?? '',
  }
  return className[category]
}

function textOf(t: Translate | undefined, key: AcpLocaleKey, fallback: string): string {
  const result = t?.(key)
  return result === undefined || result.trim() === '' ? fallback : result
}

function timeOf(epoch: number): string {
  try { return new Date(epoch).toLocaleString() } catch { return String(epoch) }
}

type AuditDetail =
  | { readonly kind: 'json'; readonly value: object | unknown[] }
  | { readonly kind: 'text'; readonly value: string }

/** Parse structured records into DSH's native JSON inspector; preserve non-JSON text verbatim. */
function auditDetailOf(detail: string): AuditDetail {
  try {
    const value: unknown = JSON.parse(detail)
    if (typeof value === 'object' && value !== null) return { kind: 'json', value }
  } catch { /* Non-JSON records use the text fallback below. */ }
  return { kind: 'text', value: detail }
}

function auditJsonTreeLabels(t: Translate | undefined): JsonTreeLabels {
  return {
    copyValue: textOf(t, 'auditCopyValue', 'Copy value'),
    copyJson: textOf(t, 'auditCopyJson', 'Copy JSON'),
    copyPath: textOf(t, 'auditCopyPath', 'Copy path'),
    copyPrettyJson: textOf(t, 'auditCopyPrettyJson', 'Copy formatted JSON'),
    copyCompactJson: textOf(t, 'auditCopyCompactJson', 'Copy compact JSON'),
    copied: textOf(t, 'auditCopied', 'Copied'),
    copyFailed: textOf(t, 'auditCopyFailed', 'Copy failed'),
    collapseNode: textOf(t, 'auditCollapseNode', 'Collapse node'),
    expandNode: textOf(t, 'auditExpandNode', 'Expand node'),
    copyButtonTitle: action => textOf(t, 'auditCopyOptions', `Copy options: ${action}`).replace('{action}', action),
  }
}

/**
 * 只负责决定当前会话是否应拥有 Agent 审计 Tab；自身不渲染按钮。
 * `conversation.view` 目前没有 per-session selector，因此使用当前会话
 * header 的标准投影动态挂载，避免原生会话被插件增加无意义的 Tab。
 */
export function AcpAuditVisibilityGate(props: AcpAuditVisibilityGateProps): ReactNode {
  const { sessionId, useSession, useProjection, remote, onVisibilityChange, ownsRoute } = props
  const sessionRefreshKey = useSession === undefined
    ? 'absent'
    : useSession(snapshot => auditSessionRefreshKeyOf(snapshot))
  const projectionSelection = useProjection('modelSelection')
  const [verifiedSessionId, setVerifiedSessionId] = useState<string | undefined>(undefined)
  const projectedAcp = sessionId !== undefined && auditProjectionIsAcp(projectionSelection, ownsRoute)
  // Verification belongs to one session. A navigation therefore hides the
  // tab synchronously instead of briefly carrying the previous ACP result
  // into a native session while `backendOf` is still in flight.
  const visible = projectedAcp && verifiedSessionId === sessionId

  useEffect(() => {
    let disposed = false
    if (sessionId === undefined || remote === undefined || !projectedAcp) {
      setVerifiedSessionId(undefined)
      return
    }
    void remote.backendOf(sessionId).then((result) => {
      if (!disposed) setVerifiedSessionId(result.ok && auditHeaderVisible(result.value, ownsRoute) ? sessionId : undefined)
    }).catch(() => {
      if (!disposed) setVerifiedSessionId(undefined)
    })
    return () => { disposed = true }
  }, [sessionId, remote, projectedAcp, sessionRefreshKey, ownsRoute])

  useEffect(() => {
    if (sessionId === undefined) return
    onVisibilityChange(sessionId, visible)
    return () => { onVisibilityChange(sessionId, false) }
  }, [sessionId, visible, onVisibilityChange])
  return null
}

/** 与轨迹同级的全高会话视图；筛选和详情均在页面内完成。 */
export function AcpAuditView(props: AcpAuditViewProps): ReactNode {
  const { sessionId, remote, t } = props
  const [loading, setLoading] = useState(false)
  const [entries, setEntries] = useState<readonly AcpAuditTimelineEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(0)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const requestEpoch = useRef(0)
  const loadingRef = useRef(false)

  const load = useCallback((reset: boolean): void => {
    if (sessionId === undefined || remote === undefined || loadingRef.current) return
    requestEpoch.current += 1
    const epoch = requestEpoch.current
    loadingRef.current = true
    setLoading(true)
    setError(null)
    const afterSeq = reset ? 0 : cursor ?? 0
    void remote.auditTimeline(sessionId, { afterSeq, limit: 50 }).then((result) => {
      if (epoch !== requestEpoch.current) return
      if (!result.ok) {
        setError(textOf(t, 'auditUnavailable', 'Agent audit records are unavailable on this host.'))
        return
      }
      setEntries(previous => reset ? result.value.entries : [...previous, ...result.value.entries])
      setCursor(result.value.nextCursor)
      setHasMore(result.value.hasMore)
    }).catch(() => {
      if (epoch === requestEpoch.current) setError(textOf(t, 'auditUnavailable', 'Agent audit records are unavailable on this host.'))
    }).finally(() => {
      if (epoch === requestEpoch.current) {
        loadingRef.current = false
        setLoading(false)
      }
    })
  }, [sessionId, remote, cursor, t])

  useEffect(() => {
    requestEpoch.current += 1
    loadingRef.current = false
    setEntries([])
    setCursor(0)
    setHasMore(false)
    setError(null)
    setFilter('all')
    setQuery('')
    setSelectedSeq(null)
    load(true)
    return () => { requestEpoch.current += 1 }
    // `load` changes with paging state; reset belongs only to a new binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, remote])

  const visible = useMemo(() => entries.filter(entry =>
    auditEntryMatchesFilter(entry, filter) && auditEntryMatchesQuery(t, entry, query)), [entries, filter, query, t])
  const selected = useMemo(() => entries.find(entry => entry.seq === selectedSeq) ?? null, [entries, selectedSeq])
  const labels: readonly [Filter, AcpLocaleKey][] = [
    ['all', 'auditAll'], ['recovery', 'auditFilterRecovery'], ['permission', 'auditFilterPermission'],
    ['agent', 'auditFilterAgent'], ['files', 'auditFilterFiles'],
  ]
  return h('section', { className: css.root, 'aria-label': textOf(t, 'auditTitle', 'Agent audit') },
    h('div', { className: css.toolbar, role: 'toolbar', 'aria-label': textOf(t, 'auditTitle', 'Agent audit') },
      h('div', { className: css.toolbarInner },
        h('div', { className: css.filters },
          ...labels.map(([value, key]) => h('button', {
            key: value,
            type: 'button',
            className: value === filter ? css.filterActive : css.filter,
            'aria-pressed': value === filter,
            onClick: () => setFilter(value),
          }, textOf(t, key, value))),
        ),
        h('div', { className: css.toolbarEnd },
          h('button', { type: 'button', className: css.refresh, disabled: loading, onClick: () => load(true) },
            textOf(t, loading ? 'auditLoadingShort' : 'auditRefresh', loading ? 'Loading…' : 'Refresh')),
          h('label', { className: css.search },
            h(IconSearchOutline16, { size: 11, className: css.searchIcon }),
            h('input', {
              type: 'search',
              className: css.searchInput,
              value: query,
              placeholder: textOf(t, 'auditSearchPlaceholder', 'Search'),
              'aria-label': textOf(t, 'auditSearch', 'Search audit'),
              onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value),
            }),
          ),
        ),
      ),
    ),
    h('div', { className: css.split },
      h('div', { className: css.tablePane, 'data-audit-scroll': true },
        loading && entries.length === 0 ? h('p', { className: css.muted }, textOf(t, 'auditLoading', 'Loading audit records…')) : null,
        error === null ? null : h('p', { className: css.error, role: 'alert' }, error),
        !loading && error === null && visible.length === 0
          ? h('p', { className: css.muted }, entries.length === 0 ? textOf(t, 'auditEmpty', 'No Agent-specific audit records yet.') : textOf(t, 'auditNoMatch', 'No records match this filter.'))
          : null,
        h('table', { className: css.table, 'aria-label': textOf(t, 'auditTimeline', 'Agent audit timeline') },
          h('colgroup', null,
            h('col', { className: css.eventColumn }),
            h('col', { className: css.contentColumn }),
          ),
          h('tbody', null, ...visible.map(entry => {
            const isSelected = entry.seq === selectedSeq
            const select = (): void => setSelectedSeq(isSelected ? null : entry.seq)
            return h('tr', {
              key: `${entry.seq}-${entry.kind}`,
              tabIndex: 0,
              'data-selected': isSelected || undefined,
              'aria-selected': isSelected,
              onClick: select,
              onKeyDown: (event: { key: string; preventDefault(): void }) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                select()
              },
            },
            h('td', { className: css.event },
              h('div', { className: css.eventInner },
                h('div', { className: css.kindSlot },
                  h('span', { className: `${css.kindTag} ${categoryClass(entry.category)}` }, categoryLabel(t, entry.category)),
                ),
              ),
            ),
            h('td', { className: css.content },
              h('div', { className: css.contentInner },
                h('span', { className: css.summary }, auditSummaryOf(t, entry)),
                h('time', { className: css.time, dateTime: new Date(entry.time).toISOString() }, timeOf(entry.time)),
              ),
            ))
          })),
        ),
        hasMore ? h('button', { type: 'button', className: css.more, disabled: loading, onClick: () => load(false) }, textOf(t, 'auditLoadMore', 'Load more')) : null,
        !hasMore && entries.length > 0 ? h('p', { className: css.end }, textOf(t, 'auditPageEnd', 'All records are shown')) : null,
      ),
      selected === null ? null : h('aside', { className: css.details, 'aria-label': textOf(t, 'auditDetails', 'Event details') },
        h('div', { className: css.detailsHeader },
          h('div', { className: css.detailsTitle },
            h('span', { className: `${css.kindTag} ${categoryClass(selected.category)}` }, categoryLabel(t, selected.category)),
            h('span', { className: css.detailsLocation }, `#${String(selected.seq)}`),
          ),
          h('button', { type: 'button', className: css.close, 'aria-label': textOf(t, 'auditClose', 'Close'), onClick: () => setSelectedSeq(null) }, '×'),
        ),
        h('div', { className: css.detailsBody },
          h('p', { className: css.detailsSummary }, auditSummaryOf(t, selected)),
          h('dl', { className: css.overview },
            h('div', null, h('dt', null, textOf(t, 'auditTime', 'Time')), h('dd', null, timeOf(selected.time))),
            h('div', null, h('dt', null, textOf(t, 'auditSequence', 'Sequence')), h('dd', null, String(selected.seq))),
          ),
          selected.detail === null
            ? h('p', { className: css.noDetails }, textOf(t, 'auditNoDetails', 'No additional details.'))
            : (() => {
              const detail = auditDetailOf(selected.detail)
              return detail.kind === 'json'
                ? h(JsonTree, {
                  data: detail.value,
                  label: textOf(t, 'auditDetailJson', 'Audit record JSON'),
                  className: css.jsonPayload,
                  labels: auditJsonTreeLabels(t),
                  expandTopLevel: true,
                })
                : h('pre', { className: css.detailPayload }, detail.value)
            })(),
        ),
      ),
    ),
  )
}

export function createAcpAuditView(remote: AcpRemoteLike): (props: AcpAuditViewProps) => ReactNode {
  return props => h(AcpAuditView, { ...props, remote })
}
