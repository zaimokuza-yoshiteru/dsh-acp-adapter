import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ConversationNodeDefinition,
  ConversationMatch,
  ConversationLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  Button, DiffBlock, DisclosureRow, IconApiOutline14, JsonTree, ReadBlock, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DiffHunk, JsonTreeLabels, ReadBlockLabels, ReadBlockProps, StateDotState, TerminalBlockLabels, TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpActivityView } from '../data/acp-remote.ts'
import { acpReplayPayloadOf, type AcpReplayPayloadV1 } from '../data/acp-replay-payload.ts'
import { AcpActivityJournalHub } from '../data/activity-journal.ts'
import css from './AcpActivityNode.module.css'
import type { AcpLocaleKey } from './locales.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    acpActivity: import('./locales.ts').AcpLocaleKey
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'acp-activity': AcpActivityNodeData
  }
}

export interface AcpActivityNodeData {
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

type ActivityNodeProps = {
  readonly node: ActivityNode
  readonly sessionId: string
  readonly t: (key: AcpLocaleKey, params?: Record<string, string | number>) => string
  readonly journalHub: AcpActivityJournalHub
  readonly onProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly onOpenProjectedChild?: (childSessionId: string) => void
} & Pick<import('@deepseek-ai/dsh-client-ui-chat/client').ChatNodeOwnerProps, 'cwd' | 'openFile'>

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

function detailLabels(t: ActivityNodeProps['t']): JsonTreeLabels {
  return {
    copyValue: t('auditCopyValue'), copyJson: t('auditCopyJson'), copyPath: t('auditCopyPath'),
    copyPrettyJson: t('auditCopyPrettyJson'), copyCompactJson: t('auditCopyCompactJson'),
    copied: t('auditCopied'), copyFailed: t('auditCopyFailed'), collapseNode: t('auditCollapseNode'),
    expandNode: t('auditExpandNode'), copyButtonTitle: (action: string) => t('auditCopyOptions', { action }),
  }
}

function dotState(status: AcpActivityView['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'completed') return 'done'
  if (status === 'cancelled') return 'warning'
  return 'error'
}

function diffHunks(value: unknown): DiffHunk[] {
  const candidates = record(value) && Array.isArray(value.content) ? value.content : [value]
  const result: DiffHunk[] = []
  for (const candidate of candidates) {
    if (!record(candidate) || candidate.type !== 'diff' || typeof candidate.path !== 'string' || typeof candidate.newText !== 'string') continue
    result.push({
      path: candidate.path,
      oldText: typeof candidate.oldText === 'string' ? candidate.oldText : null,
      newText: candidate.newText,
    })
  }
  // Kimi's write tool reports the complete new file in rawInput instead of an
  // ACP diff content block. DiffBlock accepts null oldText for a create or
  // overwrite; every byte the Agent exposed for the new side remains visible.
  if (result.length === 0 && record(value) && value.toolKind === 'edit' && record(value.rawInput)) {
    const path = typeof value.rawInput.path === 'string'
      ? value.rawInput.path
      : typeof value.rawInput.file_path === 'string' ? value.rawInput.file_path : undefined
    const newText = typeof value.rawInput.content === 'string' ? value.rawInput.content : undefined
    if (path !== undefined && path.trim() !== '' && newText !== undefined) result.push({ path, oldText: null, newText })
  }
  return result
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
    copy: t('activity.copy'),
    copied: t('activity.copied'),
    collapseAria: t('activity.collapse'),
    expandAria: (hidden: number) => t('activity.expandCount', { count: hidden }),
    collapse: t('activity.collapse'),
    expand: (hidden: number) => t('activity.expandCount', { count: hidden }),
    files: (count: number) => t('activity.files', { count }),
  }
}

function terminalLabels(t: ActivityNodeProps['t']): TerminalBlockLabels {
  return {
    signal: signal => t('activity.terminal.signal', { signal }),
    exitCode: code => t('activity.terminal.exitCode', { code }),
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

/**
 * A projected child is navigation metadata for its source Tool call, not a
 * second operation in the parent transcript. Keep the source call, suppress
 * the link-only sidecar row, and suppress the content children already folded
 * into the source call. This leaves exactly one visible row per ACP Tool call.
 */
export function visibleActivityRows(rows: readonly AcpActivityView[]): readonly AcpActivityView[] {
  const projectionRows = rows.filter(row => projectionMetadata(detailValue(row)))
  const delegationWindows = projectionRows.flatMap((projectionRow) => {
    const detail = detailValue(projectionRow)
    if (!projectionMetadata(detail)) return []
    const root = rows.find(row => row.kind === 'tool'
      && row.activityId.endsWith(`:tool:${detail.sourceToolCallId as string}`))
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
export function activityRowElement({ row, t, onOpenProjectedChild, open = false, onToggle = () => undefined }: {
  readonly row: AcpActivityView
  readonly t: ActivityNodeProps['t']
  readonly onOpenProjectedChild?: (childSessionId: string) => void
  readonly open?: boolean
  readonly onToggle?: () => void
}): ReactNode {
  const detail = detailValue(row)
  const external = record(detail) && detail.kind === 'dsh-acp-external-subagent' ? detail : undefined
  const projectedChildSessionId = record(detail) && typeof detail.projectedChildSessionId === 'string'
    ? detail.projectedChildSessionId
    : undefined
  const diffs = diffHunks(detail)
  const terminal = terminalDetail(row, detail)
  const read = readDetail(detail)
  const showRawDetail = hasMeaningfulDetail(detail)
    && external === undefined
    && !projectionLinkOnly(detail)
    && diffs.length === 0
    && terminal === undefined
    && read === undefined
  const expandable = external !== undefined || projectedChildSessionId !== undefined || showRawDetail || diffs.length > 0
    || terminal !== undefined || read !== undefined
  const body = h('div', { className: css.body },
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
      onClick: () => { onOpenProjectedChild(projectedChildSessionId) },
    }, t('subagent.openRecord')),
    diffs.length === 0 ? null : h(DiffBlock, { diffs, labels: diffLabels(t), className: css.nativeBlock }),
    terminal === undefined ? null : h(TerminalBlock, { ...terminal, labels: terminalLabels(t), className: css.nativeBlock }),
    read === undefined ? null : h(ReadBlock, { ...read, labels: readLabels(t), className: css.nativeBlock }),
    !showRawDetail ? null : typeof detail === 'object' && detail !== null
      ? h(JsonTree, { data: detail, label: t(`activity.kind.${row.kind}` as AcpLocaleKey), labels: detailLabels(t), expandTopLevel: true, className: css.json })
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

function ActivityRow(props: { readonly row: AcpActivityView; readonly t: ActivityNodeProps['t']; readonly onOpenProjectedChild?: (childSessionId: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  if (props.row.kind === 'tool' || props.row.kind === 'plan') {
    return fallbackToolRowElement({ row: props.row, t: props.t, open, onToggle: () => { setOpen(value => !value) } })
  }
  return activityRowElement({ ...props, open, onToggle: () => { setOpen(value => !value) } })
}

/** Native GenericToolCard is intentionally not public; this is its minimal
 * visual contract for ACP tool names without a registered keyed Tool view. */
function fallbackToolRowElement({ row, t, open, onToggle }: {
  readonly row: AcpActivityView
  readonly t: ActivityNodeProps['t']
  readonly open: boolean
  readonly onToggle: () => void
}): ReactNode {
  const value = detailValue(row)
  const detail = record(value) ? value : {}
  const diffs = diffHunks(value)
  const terminal = terminalDetail(row, value)
  const read = readDetail(value)
  const input = detail.rawInput
  const output = detail.rawOutput ?? detail.content
  const delegationProfile = record(input) && typeof input.profile === 'string' && input.profile.startsWith('subagent_')
    ? input.profile.slice('subagent_'.length)
    : undefined
  const delegated = delegationProfile !== undefined
  const inputPath = record(input)
    ? typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : undefined
    : undefined
  const hasInput = !delegated && hasMeaningfulDetail(input)
  const hasOutput = !delegated && hasMeaningfulDetail(output)
  const expandable = diffs.length > 0 || terminal !== undefined || read !== undefined || hasInput || hasOutput
  const kind = typeof detail.toolKind === 'string' ? detail.toolKind : row.kind
  const title = kind === 'execute' ? t('activity.tool.execute')
    : kind === 'read' ? t('activity.tool.read')
      : kind === 'edit' ? t('activity.tool.edit')
        : kind === 'search' ? t('activity.tool.search')
          : kind === 'fetch' ? t('activity.tool.fetch')
            : kind === 'plan' ? t('activity.tool.plan')
              : t('activity.toolTitle')
  const summary = delegated && record(input) && typeof input.title === 'string'
    ? input.title
    : terminal?.command ?? read?.label ?? inputPath ?? diffs[0]?.path ?? row.presentation
  const icon = row.status === 'failed'
    ? h(StateDot, { state: 'error' })
    : row.status === 'cancelled' ? h(StateDot, { state: 'warning' }) : h(IconApiOutline14, { size: 14 })
  return h(DisclosureRow, {
    className: css.toolFallback,
    rowClassName: css.rowSummary,
    titleClassName: css.toolTitle,
    icon,
    title,
    open: open && expandable,
    expandable,
    expandOnRowClick: true,
    keepContentWhenOpen: true,
    onToggle,
    collapsedContent: h('span', { className: css.toolSummary }, summary),
  }, h('div', { className: css.toolBody },
    diffs.length === 0 ? null : h(DiffBlock, { diffs, labels: diffLabels(t), className: css.nativeBlock }),
    terminal === undefined ? null : h(TerminalBlock, { ...terminal, labels: terminalLabels(t), className: css.nativeBlock }),
    read === undefined ? null : h(ReadBlock, { ...read, labels: readLabels(t), className: css.nativeBlock }),
    diffs.length > 0 || terminal !== undefined || read !== undefined ? null : h('div', { className: css.ioCard },
      !hasInput ? null : h('div', { className: css.ioSection },
        h('span', { className: css.ioLabel }, t('activity.input')),
        h('pre', { className: css.ioText }, typeof input === 'string' ? input : json(input)),
      ),
      !hasInput || !hasOutput ? null : h('div', { className: css.ioDivider }),
      !hasOutput ? null : h('div', { className: css.ioSection },
        h('span', { className: css.ioLabel }, t('activity.output')),
        h('pre', { className: css.ioText }, contentText(output)),
      ),
    ),
  ))
}

/** Additive ACP activity renderer. Agent-provided presentation is never translated. */
export function AcpActivityNode({ node, sessionId, journalHub, t, onProjectedChild, onOpenProjectedChild }: ActivityNodeProps): ReactNode {
  const [rows, setRows] = useState<readonly AcpActivityView[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const data = node.data
  useEffect(() => {
    const publish = (): void => {
      const all = handle.snapshot()
      const next = visibleActivityRows(all)
      setRows(next)
      setUnavailable(handle.error() !== undefined)
      for (const row of all) {
        const detail = detailValue(row)
        if (!record(detail)) continue
        if (typeof detail.projectedChildSessionId === 'string') {
          onProjectedChild?.(ownerSessionId, detail.projectedChildSessionId)
        } else if (typeof detail.childSessionId === 'string' && typeof detail.parentDshSessionId === 'string') {
          onProjectedChild?.(detail.parentDshSessionId, detail.childSessionId)
        }
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
      key: `${row.activityId}:${row.activitySeq}`, row, t,
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
 * The durable assistant replay marker later enriches that same node. Native
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
      if (payload?.activityRequestHeaderSeq !== undefined) return { id: `request:${payload.activityRequestHeaderSeq}`, role: 'update' }
      if (payload !== undefined) return { id: `legacy:${payload.activityAnchorMessageId ?? `${payload.agentSessionId}:${payload.committedPromptOrdinal}`}`, role: 'start' }
      const provider = requestProvider(event)
      return provider !== undefined && ownsRoute(provider) ? { id: `request:${event.seq}`, role: 'start' } : null
    },
    start: (_context, match, reader) => {
      const payload = payloadOf(match)
      if (payload !== undefined) {
        return {
          ownerDshSessionId: payload.ownerDshSessionId,
          promptAnchorMessageId: payload.activityAnchorMessageId ?? `prompt:${payload.committedPromptOrdinal}`,
          profileId: payload.profileId,
          agentSessionId: payload.agentSessionId,
          committedActivitySeq: payload.committedActivitySeq,
          seq: match.event.seq,
          location: match.location,
        }
      }
      const provider = requestProvider(match.event)
      if (provider === undefined) throw new Error('acp-activity start requires an owned ACP request')
      const anchor = reader.previous<AcpPromptAnchorState>('acp-prompt-anchor')?.state
      return {
        ownerDshSessionId: '',
        promptAnchorMessageId: anchor?.messageId ?? `request:${match.event.seq}`,
        profileId: provider,
        agentSessionId: '',
        committedActivitySeq: 0,
        seq: match.event.seq,
        location: match.location,
      }
    },
    update: (context, match) => {
      const payload = payloadOf(match)
      return payload === undefined ? context.state : {
        ...context.state,
        // Once the durable answer exists, place Activity at that boundary.
        // Chat folds only nodes before answerAnchorSeq; using the marker's
        // exact sequence keeps ACP work visible without impersonating native
        // tool/call events or replacing the stock process-summary renderer.
        seq: match.event.seq,
        ownerDshSessionId: payload.ownerDshSessionId,
        promptAnchorMessageId: payload.activityAnchorMessageId ?? context.state.promptAnchorMessageId,
        profileId: payload.profileId,
        agentSessionId: payload.agentSessionId,
        committedActivitySeq: payload.committedActivitySeq,
      }
    },
    buildViewNode: (context): ActivityNode | null => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'acp-activity',
      id: context.id,
      target: 'chat',
      // The finalized marker sequence is the native process window's exclusive
      // end boundary. Equal anchoring remains adjacent to the answer but keeps
      // this additive kind out of the stock "Thought" disclosure, whose fixed
      // summary has no contribution slot for third-party activity counts.
      anchorSeq: context.state.seq,
      location: context.state.location,
      visibility: 'visible',
      data: {
        ownerDshSessionId: context.state.ownerDshSessionId,
        promptAnchorMessageId: context.state.promptAnchorMessageId,
        profileId: context.state.profileId,
        agentSessionId: context.state.agentSessionId,
        committedActivitySeq: context.state.committedActivitySeq,
      },
    }
    },
  }
}

/** Legacy/test-safe instance. Production supplies the profile registry's
 * ownership predicate through {@link createAcpActivityDefinition}. */
export const acpActivityDefinition = createAcpActivityDefinition(() => false)
