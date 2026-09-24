import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { activityDiffsOf } from '../../contract/activity-diffs.ts'
import { createElement as h, Fragment, useEffect, useState, useSyncExternalStore, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import type {
  ConversationNodeDefinition,
  ConversationMatch,
  ConversationLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallBlock, ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  Button, DiffBlock, DisclosureRow, Modal, JsonTree, ReadBlock, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DiffHunk, ReadBlockLabels, ReadBlockProps, StateDotState, TerminalBlockLabels, TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpJsonStringWrapping } from './json-tree.ts'
import { acpJsonTreeLabels } from './json-tree.ts'
import type { AcpActivityView } from '../data/acp-remote.ts'
import { acpReplayPayloadOf, type AcpReplayPayloadV1 } from '../data/acp-replay-payload.ts'
import { AcpActivityJournalHub } from '../data/activity-journal.ts'
import css from './AcpActivityNode.module.css'
import { nativeOwner, type NativeToolOwner } from './native-tool-renderer.ts'
import type { AcpLocaleKey } from './locales.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    acpActivity: import('./locales.ts').AcpLocaleKey
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap { 'acp-activity': AcpActivityNodeData; 'acp-activity-live': AcpActivityNodeData }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'acp-activity': AcpActivityNodeData
  }
}

export interface AcpActivityNodeData {
  readonly settled?: true
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
  readonly profileId: string
  readonly agentSessionId: string
  readonly committedActivitySeq: number
}

interface AcpPromptAnchorState {
  readonly messageId: string
  readonly seq: number
  readonly location: ConversationLocation
}

interface AcpActivityState extends AcpActivityNodeData {
  readonly seq: number
  readonly location: ConversationLocation
}

type ActivityNode = ChatConversationViewNode & {
  readonly kind: 'acp-activity'
  readonly data: AcpActivityNodeData
}

export type ActivityNodeProps = {
  readonly node: ActivityNode
  readonly sessionId: string
  readonly t: (key: AcpLocaleKey, params?: Record<string, string | number>) => string
  readonly journalHub: AcpActivityJournalHub
  readonly onProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly jsonStringWrapping?: AcpJsonStringWrapping
  readonly renderTool?: (row: AcpActivityView) => ReactNode
} & Pick<import('@deepseek-ai/dsh-client-ui-chat/client').ChatNodeOwnerProps, 'openFile'>

/**
 * Activity is owned by the DSH session that committed the ACP replay payload.
 * A DSH fork may display that payload from a child session, so the current
 * conversation session is not necessarily the journal source. The Host Remote
 * still applies its managed-session access check to this owner id.
 */
export function activityJournalSessionId(data: Pick<AcpActivityNodeData, 'ownerDshSessionId'>, currentSessionId?: string): string {
  return data.ownerDshSessionId === '' ? (currentSessionId ?? '') : data.ownerDshSessionId
}

function statusLabel(status: AcpActivityView['status'], t: ActivityNodeProps['t']): string {
  const key = {
    running: 'activity.status.running', completed: 'activity.status.completed',
    failed: 'activity.status.failed', cancelled: 'activity.status.cancelled',
  } as const
  return t(key[status])
}

function detailValue(row: AcpActivityView): unknown {
  if (row.rawDetail === undefined) return row.rawDetailRef
  try { return JSON.parse(row.rawDetail) as unknown } catch { return row.rawDetail }
}

function hasMeaningfulDetail(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.some(hasMeaningfulDetail)
  if (record(value)) return Object.values(value).some(hasMeaningfulDetail)
  return true
}

type TerminalDetail = Pick<TerminalBlockProps, 'command' | 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>

function textContent(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(textContent)
  if (!record(value)) return []
  if (value.type === 'text' && typeof value.text === 'string') return [value.text]
  if (value.type === 'content') return textContent(value.content)
  return []
}

function joinTextContent(parts: readonly string[]): string | undefined {
  let result = ''
  for (const part of parts) {
    if (result !== '' && !result.endsWith('\n') && !part.startsWith('\n')) result += '\n'
    result += part
  }
  return result === '' ? undefined : result
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Project the common ACP execute shapes onto DSH's native terminal surface.
 * Codex reports formatted_output; Devin reports standard ACP text blocks and
 * a standalone exit-status line nested under content[].content.
 */
function terminalDetail(row: AcpActivityView, value: unknown): TerminalDetail | undefined {
  if (!record(value)) return undefined
  const rawInput = record(value.rawInput) ? value.rawInput : undefined
  const rawOutput = record(value.rawOutput) ? value.rawOutput : undefined
  const command = typeof rawInput?.command === 'string' ? rawInput.command : undefined
  const formatted = typeof value.formatted_output === 'string'
    ? value.formatted_output
    : typeof rawOutput?.formatted_output === 'string' ? rawOutput.formatted_output : undefined

  let nestedExitCode: number | undefined
  const nestedOutput: string[] = []
  for (const part of textContent(value.content)) {
    const exit = /^Exited with code (-?\d+)$/.exec(part.trim())
    if (exit?.[1] !== undefined) {
      const parsed = Number(exit[1])
      if (Number.isSafeInteger(parsed)) nestedExitCode = parsed
    } else {
      nestedOutput.push(part)
    }
  }
  if (value.toolKind !== 'execute' && command === undefined && formatted === undefined && nestedExitCode === undefined) return undefined
  if (nestedOutput.length === 0) nestedOutput.push(...textContent(value.rawOutput))
  const output = formatted ?? joinTextContent(nestedOutput)
  const exitCode = integer(value.exitCode) ?? integer(value.exit_code) ?? integer(rawOutput?.exitCode)
    ?? integer(rawOutput?.exit_code) ?? nestedExitCode

  return {
    command: command ?? row.presentation,
    ...(typeof rawInput?.cwd === 'string' ? { cwd: rawInput.cwd } : {}),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(typeof value.signal === 'string'
      ? { signal: value.signal }
      : typeof rawOutput?.signal === 'string' ? { signal: rawOutput.signal } : {}),
    running: row.status === 'running',
  }
}

function dotState(status: AcpActivityView['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'completed') return 'done'
  if (status === 'cancelled') return 'warning'
  return 'error'
}

/** Legacy audit rows may be incomplete; never compare their truncated file sides. */
function activityDiffs(row: AcpActivityView, detail: unknown): DiffHunk[] {
  if (row.display !== undefined) return [...(row.display.diffs ?? [])]
  if (/\[truncated\]|\[nested value omitted\]|\[redacted\]/.test(row.rawDetail ?? '')) return []
  return activityDiffsOf(detail)
}

type ReadDetail = Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>

/** Project Kimi's numbered read output (`line<TAB>text`) onto DSH ReadBlock. */
function readDetail(value: unknown): ReadDetail | undefined {
  if (!record(value) || value.toolKind !== 'read' || !record(value.rawInput) || typeof value.rawOutput !== 'string') return undefined
  // Kimi also classifies Grep as read. A search result is not a file window.
  if (value.rawInput.pattern !== undefined || value.rawInput.query !== undefined) return undefined
  const label = typeof value.rawInput.path === 'string'
    ? value.rawInput.path
    : typeof value.rawInput.file_path === 'string' ? value.rawInput.file_path : undefined
  if (label === undefined || label.trim() === '' || value.rawOutput === '') return undefined
  const normalized = value.rawOutput.replace(/\r\n/g, '\n')
    .replace(/\n<system>[\s\S]*<\/system>\s*$/, '')
    .replace(/\n$/, '')
  if (normalized === '') return undefined
  const lines = normalized.split('\n').map((line) => {
    const match = /^(\d+)\t(.*)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    const number = Number(match[1])
    return Number.isSafeInteger(number) && number > 0 ? { number, text: match[2] } : undefined
  })
  if (lines.some(line => line === undefined)) return undefined
  const numbered = lines as { readonly number: number; readonly text: string }[]
  if (numbered.some((line, index) => index > 0 && line.number !== numbered[index - 1]!.number + 1)) return undefined
  const extension = /\.([A-Za-z0-9]+)$/.exec(label)?.[1]?.toLowerCase()
  return {
    label,
    lines: numbered,
    // ACP does not expose the whole file's line count here. Using the returned
    // window length suppresses a fabricated "N of M" claim while preserving
    // the Agent-provided file line numbers in the gutter.
    totalLines: lines.length,
    ...(extension === undefined ? {} : { lang: extension }),
  }
}

function diffLabels(t: ActivityNodeProps['t']) {
  return {
    codeLabel: t('activity.code'),
    wrapLabel: t('activity.wrap'),
    unwrapLabel: t('activity.unwrap'),
    copy: t('activity.copy'),
    copied: t('activity.copied'),
    collapseAria: t('activity.collapse'),
    expandAria: (hidden: number) => t('activity.expandCount', { count: hidden }),
    collapse: t('activity.collapse'),
    expand: (hidden: number) => t('activity.expandCount', { count: hidden }),
  }
}

function terminalLabels(t: ActivityNodeProps['t']): TerminalBlockLabels {
  return {
    signal: signal => t('activity.terminal.signal', { signal }),
    exitCode: code => t('activity.terminal.exitCode', { code }),
    noExitCode: t('activity.terminal.noExitCode'),
    running: t('activity.status.running'),
    failed: t('activity.status.failed'),
    done: t('activity.status.completed'),
    copy: t('activity.copy'),
    copied: t('activity.copied'),
    noOutput: t('activity.terminal.noOutput'),
    collapseAria: t('activity.terminal.collapseAria'),
    collapse: t('activity.collapse'),
    expandAria: hidden => t('activity.terminal.expandAria', { count: hidden }),
    expand: hidden => t('activity.expandCount', { count: hidden }),
  }
}

function readLabels(t: ActivityNodeProps['t']): ReadBlockLabels {
  return {
    codeLabel: t('activity.code'),
    wrapLabel: t('activity.wrap'),
    unwrapLabel: t('activity.unwrap'),
    window: (shown, total) => t('activity.read.window', { shown, total }),
    copy: t('activity.copy'),
    copied: t('activity.copied'),
    collapseAria: t('activity.collapse'),
    expandAria: hidden => t('activity.expandCount', { count: hidden }),
    collapse: t('activity.collapse'),
    expand: hidden => t('activity.expandCount', { count: hidden }),
  }
}

function projectionLinkOnly(value: unknown): boolean {
  if (!record(value) || typeof value.projectedChildSessionId !== 'string') return false
  return Object.keys(value).every(key => key === 'projectedChildSessionId' || key === 'resultCompleteness' || key === 'sourceToolCallId')
}

function projectionMetadata(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (typeof value.projectedChildSessionId === 'string') return true
  return typeof value.sourceToolCallId === 'string' && value.projection === 'unavailable'
}

export function completedProjectedChild(row: AcpActivityView): {
  readonly parentSessionId: string
  readonly childSessionId: string
} | undefined {
  // Projection rows are staged before the durable child exists. Refreshing on
  // that running revision races the write, then exact-id deduplication would
  // suppress the completed revision that can actually be listed.
  if (row.status !== 'completed') return undefined
  const detail = detailValue(row)
  if (!record(detail)) return undefined
  if (typeof detail.projectedChildSessionId === 'string') {
    return { parentSessionId: row.ownerDshSessionId, childSessionId: detail.projectedChildSessionId }
  }
  if (typeof detail.childSessionId === 'string' && typeof detail.parentDshSessionId === 'string') {
    return { parentSessionId: detail.parentDshSessionId, childSessionId: detail.childSessionId }
  }
  return undefined
}

export type ActivityPresentationRow = AcpActivityView & {
  readonly projectedChild?: { readonly parentSessionId: string; readonly childSessionId: string }
}

/**
 * A projected child is navigation metadata for its source Tool call, not a
 * second operation in the parent transcript. Keep the source call, suppress
 * the link-only sidecar row, and suppress the content children already folded
 * into the source call. This leaves exactly one visible row per ACP Tool call.
 */
export function visibleActivityRows(rows: readonly AcpActivityView[]): readonly ActivityPresentationRow[] {
  const projectionRows = rows.filter(row => projectionMetadata(detailValue(row)))
  const delegationWindows = projectionRows.flatMap((projectionRow) => {
    const detail = detailValue(projectionRow)
    if (!projectionMetadata(detail) || typeof detail.sourceToolCallId !== 'string') return []
    const root = rows.find(row => row.kind === 'tool'
      && (row.activityId === `tool:${detail.sourceToolCallId}` || row.activityId.endsWith(`:tool:${detail.sourceToolCallId}`)))
    return root === undefined ? [] : [{ root, projectionRow }]
  })
  // ACP tool content is a child asset of its tool call, not another operation.
  // The parent row already retains the update detail, while the sidecar keeps
  // every child revision for audit. Keep only one top-level Chat row per tool.
  const visibleToolRoots = new Set(rows
    .filter(row => row.kind === 'tool')
    .map(row => row.activityId))
  return rows.filter(row => {
    // Devin can publish an id-only child lifecycle row before the actual
    // delegation evidence arrives. It has no user-visible operation or data;
    // showing the adapter's fallback title would create a transient duplicate.
    if (row.kind === 'tool'
      && row.presentation === 'Agent tool activity'
      && !hasMeaningfulDetail(detailValue(row))) return false
    if (projectionRows.includes(row)) return false
    if (delegationWindows.some(({ root }) => row === root
      && root.presentation === 'Agent tool activity'
      && !hasMeaningfulDetail(detailValue(root)))) return false
    if (delegationWindows.some(({ root, projectionRow }) => row.activitySeq > root.activitySeq
      && row.activitySeq < projectionRow.activitySeq)) return false
    if ([...visibleToolRoots].some(root => row.activityId.startsWith(`${root}:`))) return false
    return true
  }).map(row => {
    const projection = delegationWindows.find(window => window.root === row)?.projectionRow
    const projectedChild = projection === undefined ? undefined : completedProjectedChild(projection)
    return projectedChild === undefined ? row : { ...row, projectedChild }
  })
}

function json(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return '{}'}
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const text = joinTextContent(textContent(value))
  return text ?? (hasMeaningfulDetail(value) ? json(value) : '')
}

/** Compact summary with explicitly read-only, sidecar-redacted details. */
export function activityRowElement({ row, t, onOpenProjectedChild, jsonStringWrapping, open = false, onToggle = () => undefined }: {
  readonly row: AcpActivityView
  readonly t: ActivityNodeProps['t']
  readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly jsonStringWrapping?: AcpJsonStringWrapping
  readonly open?: boolean
  readonly onToggle?: () => void
}): ReactNode {
  const detail = detailValue(row)
  const external = record(detail) && detail.kind === 'dsh-acp-external-subagent' ? detail : undefined
  const projectedChildSessionId = record(detail) && typeof detail.projectedChildSessionId === 'string'
    ? detail.projectedChildSessionId
    : undefined
  const diffs = activityDiffs(row, detail)
  const terminal = terminalDetail(row, detail)
  const read = readDetail(detail)
  const showRawDetail = hasMeaningfulDetail(detail)
    && external === undefined
    && !projectionLinkOnly(detail)
    && diffs.length === 0
    && terminal === undefined
    && read === undefined
  const expandable = external !== undefined || projectedChildSessionId !== undefined || showRawDetail || diffs.length > 0
    || terminal !== undefined || read !== undefined || row.display?.unavailable !== undefined
  const body = h('div', { className: css.body },
    row.display?.unavailable === undefined ? null : h('p', null, t(row.display?.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge')),
    external === undefined ? null : h('div', { className: css.externalRecord },
      h('div', { className: css.externalSection },
        h('span', { className: css.externalLabel }, t('subagent.task')),
        h('p', { className: css.externalText }, record(external.task) && typeof external.task.text === 'string' ? external.task.text : t('subagent.unavailable')),
      ),
      h('div', { className: css.externalSection },
        h('span', { className: css.externalLabel }, record(external.result) && external.result.completeness === 'summary' ? t('subagent.summary') : t('subagent.result')),
        h('p', { className: css.externalText }, record(external.result) && typeof external.result.text === 'string' ? external.result.text : t('subagent.unavailable')),
      ),
      h('p', { className: css.externalNote }, t('subagent.observedTiming')),
    ),
    projectedChildSessionId === undefined || onOpenProjectedChild === undefined ? null : h(Button, {
      variant: 'outline', size: 'sm', className: css.openRecord,
      onClick: () => { onOpenProjectedChild(row.ownerDshSessionId, projectedChildSessionId) },
    }, t('subagent.openRecord')),
    diffs.length === 0 ? null : h(DiffBlock, { diffs, labels: diffLabels(t), className: css.nativeBlock }),
    terminal === undefined ? null : h(TerminalBlock, { ...terminal, labels: terminalLabels(t), className: css.nativeBlock }),
    read === undefined ? null : h(ReadBlock, { ...read, labels: readLabels(t), className: css.nativeBlock }),
    !showRawDetail ? null : typeof detail === 'object' && detail !== null
      ? h(JsonTree, {
        data: detail,
        label: t(`activity.kind.${row.kind}` as AcpLocaleKey),
        labels: acpJsonTreeLabels(t),
        ...(jsonStringWrapping === undefined ? {} : { stringWrapping: { ...jsonStringWrapping, label: t('auditWrapLines') } }),
        expandTopLevel: true,
        className: css.json,
      })
      : h('pre', { className: css.raw }, String(detail)),
  )
  return h(DisclosureRow, {
    className: css.row,
    rowClassName: css.rowSummary,
    titleClassName: css.presentation,
    icon: h(StateDot, { state: dotState(row.status) }),
    title: row.presentation,
    open,
    expandable,
    expandOnRowClick: true,
    keepContentWhenOpen: true,
    onToggle,
    collapsedContent: h('span', { className: css.status },
      h('span', { className: css.separator, 'aria-hidden': true }),
      statusLabel(row.status, t),
    ),
  }, body)
}

export function ActivityRow(props: { readonly row: ActivityPresentationRow; readonly journalHub?: AcpActivityJournalHub; readonly t: ActivityNodeProps['t']; readonly openFile: ActivityNodeProps['openFile']; readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void; readonly jsonStringWrapping?: AcpJsonStringWrapping; readonly renderTool?: (row: AcpActivityView) => ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<AcpActivityView | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const row = props.row
  const child = row.projectedChild
  const onOpenChild = props.onOpenProjectedChild
  const openChild = child !== undefined && onOpenChild !== undefined
    ? () => onOpenChild(child.parentSessionId, child.childSessionId) : undefined
  const current = loaded?.revisionSeq === row.revisionSeq && loaded.activityId === row.activityId
    && loaded.dshSessionId === row.dshSessionId && loaded.ownerDshSessionId === row.ownerDshSessionId ? loaded : undefined
  useEffect(() => {
    if (!open || row.detailDeferred !== true || current !== undefined) return
    let active = true
    setFailed(false)
    if (props.journalHub === undefined) { setFailed(true); return }
    void props.journalHub.detail(row).then(detail => { if (active) setLoaded(detail) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [open, row.dshSessionId, row.ownerDshSessionId, row.activityId, row.revisionSeq, row.detailDeferred, props.journalHub, current, attempt])
  const toggle = (): void => { setOpen(value => !value) }
  if (row.detailDeferred === true && current === undefined) {
    const pendingDetail = open ? h('div', { className: css.body, role: 'status' },
      props.t(failed ? 'activity.detailLoadFailed' : 'activity.detailLoading'),
      failed ? h(Button, { variant: 'outline', size: 'sm', onClick: () => { setAttempt(value => value + 1) } }, props.t('activity.detailRetry')) : null,
    ) : null
    if (row.kind === 'tool') return h('div', { onClickCapture: () => setOpen(true) },
      props.renderTool?.({ ...row, rawDetail: JSON.stringify({
        ...(row.detailPaths?.[0] === undefined ? {} : { toolName: 'edit', rawInput: { file_path: row.detailPaths[0] } }),
        rawOutput: props.t(failed ? 'activity.detailLoadFailed' : 'activity.detailLoading'),
      }) }),
      failed ? h(Button, { variant: 'outline', size: 'sm', onClick: () => { setAttempt(value => value + 1) } }, props.t('activity.detailRetry')) : null,
    )
    return h(DisclosureRow, {
      className: css.row, title: row.kind === 'plan' ? props.t('activity.tool.plan') : row.presentation,
      icon: h(StateDot, { state: dotState(row.status) }), open, expandable: true, expandOnRowClick: true, onToggle: toggle,
    }, pendingDetail)
  }
  const full = current ?? row
  if (full.kind === 'plan') return planRowElement(full, props.t, open, toggle)
  if (full.kind === 'tool') return h('div', null,
    props.renderTool?.(full),
    openChild === undefined ? null : h(Button, { variant: 'outline', size: 'sm', className: css.openRecord, onClick: openChild }, props.t('subagent.openRecord')),
    full.display?.unavailable === undefined ? null : h('p', { role: 'status' }, props.t(full.display.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge')),
  )
  return activityRowElement({ ...props, row: full, open, onToggle: toggle })
}

/** Historical ACP plan snapshot. The current plan is also projected into DSH's native todo dock. */
function planRowElement(row: AcpActivityView, t: ActivityNodeProps['t'], open: boolean, onToggle: () => void): ReactNode {
  const legacy = detailValue(row)
  const entries = row.display !== undefined ? row.display.plan ?? [] : (Array.isArray(legacy) ? legacy.filter((item): item is { content: string; status: string } =>
    record(item) && typeof item.content === 'string' && ['pending', 'in_progress', 'completed'].includes(String(item.status))) : [])
  return h(DisclosureRow, { title: t('activity.tool.plan'), icon: h(StateDot, { state: dotState(row.status) }), expandable: entries.length > 0 || row.display?.unavailable !== undefined, open, onToggle },
    row.display?.unavailable !== undefined ? h('p', null, t(row.display?.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge')) :
      h('ul', null, ...entries.map((entry, index) => h('li', { key: index },
        h(StateDot, { state: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'ongoing' : 'idle' }),
        entry.content,
        h('span', null, ` · ${t(entry.status === 'completed' ? 'activity.status.completed' : entry.status === 'in_progress' ? 'activity.status.running' : 'activity.status.pending')}`),
      ))),
  )
}

const UNSETTLED_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }

/** Subscribe to native Step facts: a final marker retires the live journal view. */
export function AcpActivityNode(props: ActivityNodeProps & Omit<ChatNodeViewProps<'acp-activity'>, 't'> & PropsRenderFactories): ReactNode {
  const location = props.node.location
  const source = location.kind === 'step' ? location.step.data.source('acp-activity') : UNSETTLED_SOURCE
  const settled = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (props.node.data.settled !== true && settled !== undefined) return null
  return h(AcpActivityContent, { ...props, renderTool: row => renderNativeActivityTool(props, row, props.t) })
}

/** Additive ACP activity renderer. Agent-provided presentation is never translated. */
export function AcpActivityContent({ node, sessionId, journalHub, t, openFile, onProjectedChild, onOpenProjectedChild, jsonStringWrapping, renderTool }: ActivityNodeProps): ReactNode {
  const [rows, setRows] = useState<readonly ActivityPresentationRow[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const data = node.data
  useEffect(() => {
    const publish = (): void => {
      const all = handle.snapshot()
      const next = visibleActivityRows(all)
      setRows(next)
      setUnavailable(handle.error() !== undefined)
      for (const row of all) {
        const projected = completedProjectedChild(row)
        if (projected !== undefined) onProjectedChild?.(projected.parentSessionId, projected.childSessionId)
      }
    }
    const ownerSessionId = activityJournalSessionId(data, sessionId)
    const handle = journalHub.acquire(ownerSessionId, ownerSessionId, data.promptAnchorMessageId, publish)
    publish()
    return handle.release
  }, [data.ownerDshSessionId, data.promptAnchorMessageId, sessionId, journalHub, onProjectedChild])

  if (rows.length === 0 && !unavailable) return null
  return h('section', { className: css.flow, 'data-acp-activity': true },
    ...rows.map(row => h(ActivityRow, {
      key: `${row.activityId}:${row.activitySeq}`, row, t, openFile, journalHub, ...(renderTool === undefined ? {} : { renderTool }),
      ...(jsonStringWrapping === undefined ? {} : { jsonStringWrapping }),
      ...(onOpenProjectedChild === undefined ? {} : { onOpenProjectedChild }),
    })),
    unavailable ? h('div', { className: css.unavailable },
      h(StateDot, { state: 'error' }),
      h('span', null, t('activity.unavailable')),
    ) : null,
  )
}

function payloadOf(match: ConversationMatch): AcpReplayPayloadV1 | undefined {
  return acpReplayPayloadOf(match.event)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function directUserMessageId(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'user/message' || !record(event.data)) return undefined
  const source = record(event.data.source) ? event.data.source : undefined
  return source?.kind === 'user' && typeof event.data.id === 'string' ? event.data.id : undefined
}

function requestProvider(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'request/header' || !record(event.data)) return undefined
  const header = record(event.data.header) ? event.data.header : undefined
  const config = record(header?.config) ? header.config : undefined
  return typeof config?.provider === 'string' ? config.provider : undefined
}

function interruptedAssistantProvider(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'assistant/message' || !record(event.data) || event.data.interrupted !== true) return undefined
  const message = record(event.data.message) ? event.data.message : undefined
  const source = record(message?.source) ? message.source : undefined
  return source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : undefined
}

function activityNodeData(state: AcpActivityState): AcpActivityNodeData {
  return {
    ...(state.settled === true ? { settled: true } : {}),
    ownerDshSessionId: state.ownerDshSessionId,
    promptAnchorMessageId: state.promptAnchorMessageId,
    profileId: state.profileId,
    agentSessionId: state.agentSessionId,
    committedActivitySeq: state.committedActivitySeq,
  }
}

/** State-only direct-user anchor consumed by the subsequent ACP request. */
export const acpPromptAnchorDefinition: ConversationNodeDefinition<AcpPromptAnchorState> = {
  kind: 'acp-prompt-anchor',
  match: event => {
    const id = directUserMessageId(event)
    return id === undefined ? null : { id, role: 'start' }
  },
  start: (_context, match) => ({ messageId: directUserMessageId(match.event)!, seq: match.event.seq, location: match.location }),
  update: context => context.state,
}

/**
 * Owned request/header evidence creates the node before the Agent starts.
 * A durable assistant marker publishes the settled node; native Step data
 * retires its live placeholder without retaining event-number references. Native
 * turns and ACP routes owned by another plugin create no node or subscription.
 */
export function createAcpActivityDefinition(
  ownsRoute: OwnsAcpRoute,
): ConversationNodeDefinition<AcpActivityState> {
  return {
    kind: 'acp-activity',
    target: 'chat',
    match: event => {
      const payload = acpReplayPayloadOf(event)
      // Session migrations renumber events but preserve opaque replay state.
      // Settle from stable ACP identity, never a saved request/header seq.
      if (payload !== undefined) return {
        id: `answer:${JSON.stringify([payload.ownerDshSessionId, payload.profileId, payload.profileGeneration, payload.bindingEpoch, payload.agentSessionId, payload.committedPromptOrdinal])}`,
        role: 'start',
      }
      const interruptedProvider = interruptedAssistantProvider(event)
      if (interruptedProvider !== undefined && ownsRoute(interruptedProvider)) return { id: `interrupted:${event.seq}`, role: 'start' }
      const provider = requestProvider(event)
      return provider !== undefined && ownsRoute(provider) ? { id: `request:${event.seq}`, role: 'start' } : null
    },
    start: (_context, match, reader) => {
      const payload = payloadOf(match)
      if (payload !== undefined) {
        return {
          settled: true,
          ownerDshSessionId: payload.ownerDshSessionId,
          promptAnchorMessageId: payload.activityAnchorMessageId ?? `prompt:${payload.committedPromptOrdinal}`,
          profileId: payload.profileId,
          agentSessionId: payload.agentSessionId,
          committedActivitySeq: payload.committedActivitySeq,
          seq: match.event.seq,
          location: match.location,
        }
      }
      const interruptedProvider = interruptedAssistantProvider(match.event)
      const provider = requestProvider(match.event) ?? interruptedProvider
      if (provider === undefined) throw new Error('acp-activity requires a matched ACP request or interrupted answer')
      const anchor = reader.previous<AcpPromptAnchorState>('acp-prompt-anchor')?.state
      if (interruptedProvider !== undefined) {
        const previous = reader.previous<AcpActivityState>('acp-activity')?.state
        if (previous !== undefined && previous.settled !== true && previous.profileId === interruptedProvider
          && (anchor === undefined || previous.promptAnchorMessageId === anchor.messageId)) {
          return { ...previous, settled: true, seq: match.event.seq, location: match.location }
        }
        // History can contain the interrupted answer before its request context
        // is available. Anchor to this prompt, never a prior completed answer;
        // reader dependencies replay this node when earlier contexts arrive.
      }
      return {
        ...(interruptedProvider === undefined ? {} : { settled: true as const }),
        ownerDshSessionId: '',
        promptAnchorMessageId: anchor?.messageId ?? `request:${match.event.seq}`,
        profileId: provider,
        agentSessionId: '',
        committedActivitySeq: 0,
        seq: match.event.seq,
        location: match.location,
      }
    },
    update: context => context.state,
    buildLocationData: (context, scope) => {
      const state = context.state
      if (scope !== 'step' || state?.settled !== true || state.location.kind !== 'step') return null
      return { kind: 'step', turn: state.location.turn.turn, step: state.location.step.step, key: 'acp-activity', value: activityNodeData(state) }
    },
    buildViewNode: (context): ActivityNode | null => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'acp-activity',
      id: context.id,
      target: 'chat',
      // The native Chat adapter expands this marker into activity nodes once
      // its journal is available. Keep its durable position for fallback UI.
      anchorSeq: context.state.seq,
      location: context.state.location,
      visibility: 'visible',
      data: activityNodeData(context.state),
    }
    },
  }
}

/** Own the live Step fact separately from the settled activity projection. */
export function createAcpLiveActivityDefinition(ownsRoute: OwnsAcpRoute): ConversationNodeDefinition<AcpActivityState> {
  const activity = createAcpActivityDefinition(ownsRoute)
  return {
    kind: 'acp-activity-live',
    match: event => event.type === 'request/header' ? activity.match(event) : null,
    start: activity.start,
    update: activity.update,
    buildLocationData: (context, scope) => {
      const state = context.state
      if (scope !== 'step' || state === undefined || state.location.kind !== 'step') return null
      return { kind: 'step', turn: state.location.turn.turn, step: state.location.step.step, key: 'acp-activity-live', value: activityNodeData(state) }
    },
  }
}

/** Presentation-only normalization. These blocks never enter the agent loop,
 * session event log, model context, tool execution or permission system. */
export function nativeActivityToolBlock(row: AcpActivityView): ToolCallBlock {
  const value = detailValue(row)
  const detail = record(value) ? value : {}
  const raw = detail.rawInput
  const mcp = record(raw) && typeof raw.tool === 'string' && record(raw.arguments)
  let input: unknown = mcp ? raw.arguments : raw
  let name = typeof detail.toolName === 'string' ? detail.toolName : row.presentation
  if (mcp) name = String(raw.tool)
  name = name.replace(/^mcp__.+?__/, '').replace(/^[a-f0-9]{8,}_/, '')
  const command = record(input) ? input.command ?? input.cmd : undefined
  const terminal = terminalDetail(row, value)
  const read = readDetail(value)
  const diffs = activityDiffs(row, value)
  const file = record(input) ? input.file_path ?? input.path : undefined
  let meta: unknown
  if (typeof command === 'string' && (!mcp || /^(bash|pwsh|exec_command|shell)$/i.test(name))) {
    name = /^(pwsh|powershell)$/i.test(name) ? 'pwsh' : 'bash'
    input = { ...(record(input) ? input : {}), command,
      ...(terminal?.cwd === undefined ? {} : { workdir: terminal.cwd }),
      // Native shell results with unknown exit status use the generic body;
      // do not fabricate a successful exit just to obtain a terminal card.
      ...(terminal?.exitCode === undefined && terminal?.signal === undefined ? {} : { description: row.presentation }),
    }
  } else if (diffs.length > 0) {
    name = diffs.every(diff => diff.oldText === null) ? 'write' : 'edit'
    const first = diffs[0]!
    input = { ...(record(input) ? input : {}), file_path: first.path,
      ...(name === 'write' ? { content: first.newText } : { old_string: first.oldText ?? '', new_string: first.newText }) }
    meta = { diffs }
  } else if (read !== undefined || (detail.toolKind === 'read' && typeof file === 'string' && record(input) && input.pattern === undefined && input.query === undefined)) {
    name = 'read'; input = { ...(record(input) ? input : {}), file_path: file ?? read?.label }
    // Without a file total, an offset window cannot satisfy native Read's
    // whole-file contract. Keep its original output in the native IO card.
    if (read !== undefined && read.lines[0]?.number === 1) meta = { path: read.label, offset: read.lines[0]?.number ?? 1, lines: read.lines, totalLines: read.totalLines, lang: read.lang }
  }
  const callId = `acp:${row.ownerDshSessionId}:${row.promptAnchorMessageId}:${row.activityId}`
  const argsRaw = input === undefined ? '{}' : typeof input === 'string' ? input : JSON.stringify(input)
  if (row.status === 'running') return { callId, name, phase: 'start', argsRaw, turn: 0, step: 0, time: row.time, subCalls: [] }
  let output = contentText(detail.rawOutput ?? detail.content)
  if (name === 'read' && read !== undefined && meta !== undefined) {
    output = `<path>${read.label}</path>\n<type>file</type>\n<content>\n${output}\n</content>`
  }
  if ((name === 'bash' || name === 'pwsh') && terminal !== undefined) {
    output = terminal.output ?? output
    if (terminal.signal !== undefined) output += `\n[killed by signal: ${terminal.signal}]`
    else if (terminal.exitCode !== undefined) output += `\n[exit code: ${terminal.exitCode}]`
  }
  return { kind: 'tool-result', callId, seq: row.activitySeq, time: row.time, callTime: null,
    call: { name, argsRaw }, content: output === '' ? [] : [{ type: 'text', text: output }],
    isError: row.status === 'failed' || row.status === 'cancelled', subCalls: [],
    ...(row.status === 'cancelled' ? { error: { name: 'Interrupted', code: 'interrupted' } } : {}),
    ...(meta === undefined ? {} : { meta }),
  }
}

export function renderNativeActivityTool(props: Omit<ChatNodeViewProps, 't'> & PropsRenderFactories, row: AcpActivityView, t: ActivityNodeProps['t']): ReactNode {
  return h(NativeActivityTool, { owner: props, row, t })
}

function NativeActivityTool({ owner, row, t }: {
  owner: Omit<ChatNodeViewProps, 't'> & PropsRenderFactories; row: AcpActivityView; t: ActivityNodeProps['t'];
}): ReactNode {
  const [inspecting, setInspecting] = useState(false)
  const block = useMemo(() => nativeActivityToolBlock(row), [row])
  const inspectCall = useCallback(() => setInspecting(true), [])
  const props: NativeToolOwner = {
    ...nativeOwner(owner),
    // ACP calls are sidecar facts, so the native event-log inspector cannot
    // resolve their IDs. Inspect the recorded ACP payload in a native Modal.
    inspectCall,
    node: { ...owner.node, kind: 'tool-call', data: { root: block } },
  }
  return h(Fragment, null,
    owner.renderFactorySlot('acp.native-tool', props),
    inspecting ? h(Modal, { open: true, onClose: () => setInspecting(false), title: row.presentation,
      closeLabel: t('auditClose'), ...(css.inspection === undefined ? {} : { contentClassName: css.inspection }) },
      row.detailDeferred === true ? h('p', { role: 'status' }, t('activity.detailLoading'))
        : h(JsonTree, { data: { activity: detailValue(row) }, label: t('auditDetails'), labels: acpJsonTreeLabels(t), expandTopLevel: true }),
    ) : null,
  )
}
