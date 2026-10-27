import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { activityDiffsOf } from '../../contract/activity-diffs.ts'
import { activityHostTerminalOutcome } from '../../contract/terminal-outcome.ts'
import { activityHostToolControlOutcome } from '../../contract/tool-control-outcome.ts'
import { createElement as h, useCallback, useEffect, useRef, useState, useSyncExternalStore, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ToolCallBlock, ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  Button,
  DiffBlock,
  DisclosureRow,
  JsonTree,
  StateDot,
  TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DiffHunk,
  StateDotState,
  TerminalBlockLabels,
  TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpJsonStringWrapping } from './json-tree.ts'
import { acpJsonTreeLabels } from './json-tree.ts'
import type { AcpActivityView } from '../data/acp-remote.ts'
import type { AcpActivityNodeData } from './activity-definitions.ts'
export {
  acpPromptAnchorDefinition,
  createAcpActivityDefinition,
  createAcpEffectiveRouteDefinition,
  createAcpLiveActivityDefinition,
} from './activity-definitions.ts'
export type { AcpActivityNodeData } from './activity-definitions.ts'
import { AcpActivityJournalHub, type ActivityJournalFeedback } from '../data/activity-journal.ts'
import css from './AcpActivityNode.module.css'
import { nativeOwner, NativeTerminalOutputNotice, type NativeToolOwner } from './native-tool-renderer.ts'
import type { AcpLocaleKey } from './locales.ts'
import { activityToolOutput, joinActivityToolOutput } from './activity-tool-output.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    acpActivity: import('./locales.ts').AcpLocaleKey
  }
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
  readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly jsonStringWrapping?: AcpJsonStringWrapping
  readonly renderTool?: (row: AcpActivityView) => ReactNode
} & Pick<ChatNodeViewProps, 'openFile' | 'useDisclosure'>

/**
 * Activity is owned by the DSH session that committed the ACP replay payload.
 * A DSH fork may display that payload from a child session, so the current
 * conversation session is not necessarily the journal source. The Host Remote
 * still applies its managed-session access check to this owner id.
 */
export function activityJournalSessionId(
  data: Pick<AcpActivityNodeData, 'ownerDshSessionId'>,
  currentSessionId?: string,
): string {
  return data.ownerDshSessionId === '' ? (currentSessionId ?? '') : data.ownerDshSessionId
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statusLabel(status: AcpActivityView['status'], t: ActivityNodeProps['t']): string {
  const key = {
    running: 'activity.status.running',
    completed: 'activity.status.completed',
    failed: 'activity.status.failed',
    cancelled: 'activity.status.cancelled',
    unfinished: 'activity.status.unfinished',
  } as const
  return t(key[status])
}

function detailValue(row: AcpActivityView): unknown {
  if (row.rawDetail === undefined) return row.rawDetailRef
  try {
    return JSON.parse(row.rawDetail) as unknown
  } catch {
    return row.rawDetail
  }
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

/** The official Claude producer emits a display fence alongside raw output.
 * Only unwrap that proven pair, never a fence inferred from terminal text. */
function toolDisplayContent(value: Record<string, unknown>, failed: boolean): unknown {
  if (
    !['claude:Bash', 'claude:Edit', 'claude:Write'].includes(String(value.toolSource)) ||
    typeof value.rawOutput !== 'string' ||
    !Array.isArray(value.content) ||
    value.content.length !== 1
  )
    return value.content
  const atom = value.content[0]
  if (!record(atom) || atom.type !== 'content' || !record(atom.content) || atom.content.type !== 'text')
    return value.content
  const stdout = value.rawOutput
  const wrapped = atom.content.text
  const consoleWrapper = value.toolSource === 'claude:Bash' && wrapped === `\`\`\`console\n${stdout.trimEnd()}\n\`\`\``
  const errorWrapper = failed && wrapped === `\`\`\`\n${stdout}\n\`\`\``
  if (!consoleWrapper && !errorWrapper) return value.content
  return [{ ...atom, content: { ...atom.content, text: stdout } }]
}

/**
 * Project the common ACP execute shapes onto DSH's native terminal surface.
 * Codex reports formatted_output; Devin reports standard ACP text blocks and
 * a standalone exit-status line nested under content[].content.
 */
function terminalDetail(row: AcpActivityView, value: unknown): TerminalDetail | undefined {
  if (!record(value)) return undefined
  const hostOutcome = activityHostTerminalOutcome(value, row.ownerDshSessionId)
  const rawInput = record(value.rawInput) ? value.rawInput : undefined
  const rawOutput = record(value.rawOutput) ? value.rawOutput : undefined
  const command = typeof rawInput?.command === 'string' ? rawInput.command : undefined
  const formatted =
    typeof value.formatted_output === 'string'
      ? value.formatted_output
      : typeof rawOutput?.formatted_output === 'string'
        ? rawOutput.formatted_output
        : undefined

  let nestedExitCode: number | undefined
  const nestedOutput: string[] = []
  for (const part of textContent(toolDisplayContent(value, row.status === 'failed' || row.status === 'cancelled'))) {
    const exit = /^Exited with code (-?\d+)$/.exec(part.trim())
    if (exit?.[1] !== undefined) {
      const parsed = Number(exit[1])
      if (Number.isSafeInteger(parsed)) nestedExitCode = parsed
    } else {
      nestedOutput.push(part)
    }
  }
  if (value.toolKind !== 'execute' && command === undefined && formatted === undefined && nestedExitCode === undefined)
    return undefined
  if (nestedOutput.length === 0) nestedOutput.push(...textContent(value.rawOutput))
  const output =
    formatted ??
    joinTextContent(nestedOutput) ??
    (nestedOutput.length > 0 ? '' : typeof value.rawOutput === 'string' ? value.rawOutput : undefined)
  const exitCode =
    hostOutcome === undefined
      ? (integer(value.exitCode) ??
        integer(value.exit_code) ??
        integer(rawOutput?.exitCode) ??
        integer(rawOutput?.exit_code) ??
        nestedExitCode)
      : (hostOutcome.exitCode ?? undefined)
  const signal =
    hostOutcome === undefined
      ? typeof value.signal === 'string'
        ? value.signal
        : typeof rawOutput?.signal === 'string'
          ? rawOutput.signal
          : undefined
      : (hostOutcome.signal ?? undefined)

  return {
    command: command ?? row.presentation,
    ...(typeof rawInput?.cwd === 'string' ? { cwd: rawInput.cwd } : {}),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    running: row.status === 'running',
  }
}

function dotState(status: AcpActivityView['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'completed') return 'done'
  if (status === 'cancelled' || status === 'unfinished') return 'warning'
  return 'error'
}

/** Legacy audit rows may be incomplete; never compare their truncated file sides. */
function activityDiffs(row: AcpActivityView, detail: unknown): DiffHunk[] {
  if (row.display !== undefined) return [...(row.display.diffs ?? [])]
  if (/\[truncated\]|\[nested value omitted\]|\[redacted\]/.test(row.rawDetail ?? '')) return []
  return activityDiffsOf(detail)
}

/** Use one recorded absolute location only when it identifies the tool's file target. */
function operationFilePath(detail: Record<string, unknown>, target: unknown): string | undefined {
  if (typeof target !== 'string' || target === '' || !Array.isArray(detail.locations) || detail.locations.length !== 1)
    return undefined
  const location = detail.locations[0]
  if (!record(location) || typeof location.path !== 'string' || !isAbsoluteWorkspacePath(location.path))
    return undefined
  const windows = /^[A-Za-z]:[/\\]/.test(location.path) || location.path.startsWith('\\\\')
  const normalize = (path: string) => (windows ? path.replaceAll('\\', '/') : path)
  const absolute = normalize(location.path)
  const file = normalize(target)
  if (isAbsoluteWorkspacePath(target)) return absolute === file ? location.path : undefined
  const parts = file.split('/').filter((part) => part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '' || part === '..' || /[*?\[\]]/.test(part)))
    return undefined
  return absolute.endsWith(`/${parts.join('/')}`) ? location.path : undefined
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

function terminalLabels(t: ActivityNodeProps['t'], outputNotProvided = false): TerminalBlockLabels {
  return {
    commandLine: (line) => t('activity.terminal.commandLine', { line }),
    signal: (signal) => t('activity.terminal.signal', { signal }),
    exitCode: (code) => t('activity.terminal.exitCode', { code }),
    noExitCode: t('activity.terminal.noExitCode'),
    running: t('activity.status.running'),
    failed: t('activity.status.failed'),
    done: t('activity.status.completed'),
    copy: t('activity.copy'),
    copied: t('activity.copied'),
    noOutput: t(outputNotProvided ? 'activity.terminal.outputNotProvided' : 'activity.terminal.noOutput'),
    collapseAria: t('activity.terminal.collapseAria'),
    collapse: t('activity.collapse'),
    expandAria: (hidden) => t('activity.terminal.expandAria', { count: hidden }),
    expand: (hidden) => t('activity.expandCount', { count: hidden }),
  }
}

function projectionLinkOnly(value: unknown): boolean {
  if (!record(value) || typeof value.projectedChildSessionId !== 'string') return false
  return Object.keys(value).every(
    (key) => key === 'projectedChildSessionId' || key === 'resultCompleteness' || key === 'sourceToolCallId',
  )
}

function projectionMetadata(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (typeof value.projectedChildSessionId === 'string') return true
  return typeof value.sourceToolCallId === 'string' && value.projection === 'unavailable'
}

export function completedProjectedChild(row: AcpActivityView):
  | {
      readonly parentSessionId: string
      readonly childSessionId: string
    }
  | undefined {
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

/** Unknown tool outcomes stay in the ACP activity surface; never fabricate a native result block. */
export function usesNativeActivityToolProjection(row: Pick<AcpActivityView, 'kind' | 'status'>): boolean {
  return row.kind === 'tool' && row.status !== 'unfinished'
}

function sameActivityOwner(left: AcpActivityView, right: AcpActivityView): boolean {
  return (
    left.dshSessionId === right.dshSessionId &&
    left.ownerDshSessionId === right.ownerDshSessionId &&
    left.promptAnchorMessageId === right.promptAnchorMessageId
  )
}

function toolCallIdOfRoot(row: AcpActivityView): string | undefined {
  const anchoredPrefix = `${row.promptAnchorMessageId}:tool:`
  if (row.activityId.startsWith(anchoredPrefix)) return row.activityId.slice(anchoredPrefix.length)
  if (row.activityId.startsWith('tool:')) return row.activityId.slice('tool:'.length)
  return undefined
}

function toolContentIdentity(row: AcpActivityView): { readonly toolCallId: string } | undefined {
  const anchoredPrefix = `${row.promptAnchorMessageId}:`
  const relativeId = row.activityId.startsWith(anchoredPrefix)
    ? row.activityId.slice(anchoredPrefix.length)
    : row.activityId
  const contentPrefix = relativeId.startsWith('part:') ? 'part:' : relativeId.startsWith('tool:') ? 'tool:' : undefined
  if (contentPrefix === undefined) return undefined
  const match = /^([\s\S]*):(0|[1-9]\d*):(diff|terminal|resource|content)$/.exec(relativeId.slice(contentPrefix.length))
  if (match === null) return undefined
  const expectedKind =
    match[3] === 'diff' ? 'diff' : match[3] === 'terminal' ? 'terminal' : match[3] === 'resource' ? 'resource' : 'other'
  return row.kind === expectedKind ? { toolCallId: match[1]! } : undefined
}

/**
 * A projected child is navigation metadata for its source Tool call, not a
 * second operation in the parent transcript. Keep the source call, suppress
 * the link-only sidecar row, and suppress the content children already folded
 * into the source call. This leaves exactly one visible row per ACP Tool call.
 */
export function visibleActivityRows(rows: readonly AcpActivityView[]): readonly ActivityPresentationRow[] {
  const projectionRows = rows.filter((row) => projectionMetadata(detailValue(row)))
  const delegationWindows = projectionRows.flatMap((projectionRow) => {
    const detail = detailValue(projectionRow)
    if (!projectionMetadata(detail) || typeof detail.sourceToolCallId !== 'string') return []
    const anchoredRootId = `${projectionRow.promptAnchorMessageId}:tool:${detail.sourceToolCallId}`
    const legacyRootId = `tool:${detail.sourceToolCallId}`
    const root = rows.find(
      (row) =>
        row.kind === 'tool' &&
        sameActivityOwner(row, projectionRow) &&
        (row.activityId === anchoredRootId || row.activityId === legacyRootId),
    )
    return root === undefined ? [] : [{ root, projectionRow, toolCallId: detail.sourceToolCallId }]
  })
  // ACP tool content is a child asset of its tool call, not another operation.
  // The parent row already retains the update detail, while the sidecar keeps
  // every child revision for audit. Keep only one top-level Chat row per tool.
  const visibleToolRoots = rows
    .filter((row) => row.kind === 'tool')
    .flatMap((row) => {
      const toolCallId = toolCallIdOfRoot(row)
      return toolCallId === undefined ? [] : [{ row, toolCallId }]
    })
  return rows
    .filter((row) => {
      // Devin can publish an id-only child lifecycle row before the actual
      // delegation evidence arrives. It has no user-visible operation or data;
      // showing the adapter's fallback title would create a transient duplicate.
      if (row.kind === 'tool' && row.presentation === 'Agent tool activity' && !hasMeaningfulDetail(detailValue(row)))
        return false
      if (projectionRows.includes(row)) return false
      if (
        delegationWindows.some(
          ({ root }) =>
            row === root && root.presentation === 'Agent tool activity' && !hasMeaningfulDetail(detailValue(root)),
        )
      )
        return false
      const contentIdentity = row.kind === 'tool' ? undefined : toolContentIdentity(row)
      if (
        contentIdentity !== undefined &&
        visibleToolRoots.some(
          (root) => sameActivityOwner(root.row, row) && root.toolCallId === contentIdentity.toolCallId,
        )
      )
        return false
      return true
    })
    .map((row) => {
      const projection = delegationWindows.find((window) => window.root === row)?.projectionRow
      const projectedChild = projection === undefined ? undefined : completedProjectedChild(projection)
      return projectedChild === undefined ? row : { ...row, projectedChild }
    })
}

function json(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const text = joinTextContent(textContent(value))
  return text ?? (hasMeaningfulDetail(value) ? json(value) : '')
}

/** Compact summary with explicitly read-only, sidecar-redacted details. */
export function activityRowElement({
  row,
  t,
  onOpenProjectedChild,
  jsonStringWrapping,
  open = false,
  onToggle = () => undefined,
}: {
  readonly row: AcpActivityView
  readonly t: ActivityNodeProps['t']
  readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly jsonStringWrapping?: AcpJsonStringWrapping
  readonly open?: boolean
  readonly onToggle?: () => void
}): ReactNode {
  const detail = detailValue(row)
  const external = record(detail) && detail.kind === 'dsh-acp-external-subagent' ? detail : undefined
  const projectedChildSessionId =
    record(detail) && typeof detail.projectedChildSessionId === 'string' ? detail.projectedChildSessionId : undefined
  const diffs = activityDiffs(row, detail)
  const terminal = terminalDetail(row, detail)
  const showRawDetail =
    hasMeaningfulDetail(detail) &&
    external === undefined &&
    !projectionLinkOnly(detail) &&
    diffs.length === 0 &&
    terminal === undefined
  const expandable =
    external !== undefined ||
    projectedChildSessionId !== undefined ||
    showRawDetail ||
    diffs.length > 0 ||
    terminal !== undefined ||
    row.display?.unavailable !== undefined
  const body = h(
    'div',
    { className: css.body },
    row.display?.unavailable === undefined
      ? null
      : h('p', null, t(row.display?.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge')),
    external === undefined
      ? null
      : h(
          'div',
          { className: css.externalRecord },
          h(
            'div',
            { className: css.externalSection },
            h('span', { className: css.externalLabel }, t('subagent.task')),
            h(
              'p',
              { className: css.externalText },
              record(external.task) && typeof external.task.text === 'string'
                ? external.task.text
                : t('subagent.unavailable'),
            ),
          ),
          h(
            'div',
            { className: css.externalSection },
            h(
              'span',
              { className: css.externalLabel },
              record(external.result) && external.result.completeness === 'summary'
                ? t('subagent.summary')
                : t('subagent.result'),
            ),
            h(
              'p',
              { className: css.externalText },
              record(external.result) && typeof external.result.text === 'string'
                ? external.result.text
                : t('subagent.unavailable'),
            ),
          ),
          h('p', { className: css.externalNote }, t('subagent.observedTiming')),
        ),
    projectedChildSessionId === undefined || onOpenProjectedChild === undefined
      ? null
      : h(
          Button,
          {
            variant: 'outline',
            size: 'sm',
            className: css.openRecord,
            onClick: () => {
              onOpenProjectedChild(row.ownerDshSessionId, projectedChildSessionId)
            },
          },
          t('subagent.openRecord'),
        ),
    diffs.length === 0 ? null : h(DiffBlock, { diffs, labels: diffLabels(t), className: css.nativeBlock }),
    terminal === undefined
      ? null
      : h(TerminalBlock, {
          ...terminal,
          labels: terminalLabels(t, terminal.output === undefined && !terminal.running),
          className: css.nativeBlock,
        }),
    !showRawDetail
      ? null
      : typeof detail === 'object' && detail !== null
        ? h(JsonTree, {
            data: detail,
            label: t(`activity.kind.${row.kind}` as AcpLocaleKey),
            labels: acpJsonTreeLabels(t),
            ...(jsonStringWrapping === undefined
              ? {}
              : { stringWrapping: { ...jsonStringWrapping, label: t('auditWrapLines') } }),
            expandTopLevel: true,
            className: css.json,
          })
        : h('pre', { className: css.raw }, String(detail)),
  )
  return h(
    DisclosureRow,
    {
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
      collapsedContent: h(
        'span',
        { className: css.status },
        h('span', { className: css.separator, 'aria-hidden': true }),
        statusLabel(row.status, t),
      ),
    },
    body,
  )
}

export function ActivityRow(props: {
  readonly row: ActivityPresentationRow
  readonly journalHub?: AcpActivityJournalHub
  readonly t: ActivityNodeProps['t']
  readonly openFile: ActivityNodeProps['openFile']
  readonly onOpenProjectedChild?: (parentSessionId: string, childSessionId: string) => void
  readonly jsonStringWrapping?: AcpJsonStringWrapping
  readonly renderTool?: (row: AcpActivityView) => ReactNode
  readonly useDisclosure: ChatNodeViewProps['useDisclosure']
}): ReactNode {
  const { expanded: open, setExpanded: setOpen, toggle } = props.useDisclosure()
  const [loaded, setLoaded] = useState<AcpActivityView | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const row = props.row
  const child = row.projectedChild
  const onOpenChild = props.onOpenProjectedChild
  const openChild =
    child !== undefined && onOpenChild !== undefined
      ? () => onOpenChild(child.parentSessionId, child.childSessionId)
      : undefined
  const current =
    loaded?.revisionSeq === row.revisionSeq &&
    loaded.activityId === row.activityId &&
    loaded.dshSessionId === row.dshSessionId &&
    loaded.ownerDshSessionId === row.ownerDshSessionId
      ? loaded
      : undefined
  useEffect(() => {
    if (!open || row.detailDeferred !== true || current !== undefined) return
    let active = true
    setFailed(false)
    if (props.journalHub === undefined) {
      setFailed(true)
      return
    }
    void props.journalHub.detail(row).then(
      (detail) => {
        if (active) setLoaded(detail)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [
    open,
    row.dshSessionId,
    row.ownerDshSessionId,
    row.activityId,
    row.revisionSeq,
    row.detailDeferred,
    props.journalHub,
    current,
    attempt,
  ])
  if (row.detailDeferred === true && current === undefined) {
    const pendingDetail = open
      ? h(
          'div',
          { className: css.body, role: 'status' },
          props.t(failed ? 'activity.detailLoadFailed' : 'activity.detailLoading'),
          failed
            ? h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => {
                    setAttempt((value) => value + 1)
                  },
                },
                props.t('activity.detailRetry'),
              )
            : null,
        )
      : null
    if (usesNativeActivityToolProjection(row))
      return h(
        'div',
        { onClickCapture: () => setOpen(true) },
        props.renderTool?.({
          ...row,
          rawDetail: JSON.stringify({
            ...(row.detailPaths?.[0] === undefined
              ? {}
              : { toolName: 'edit', rawInput: { file_path: row.detailPaths[0] } }),
            rawOutput: props.t(failed ? 'activity.detailLoadFailed' : 'activity.detailLoading'),
          }),
        }),
        failed
          ? h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                  setAttempt((value) => value + 1)
                },
              },
              props.t('activity.detailRetry'),
            )
          : null,
      )
    return h(
      DisclosureRow,
      {
        className: css.row,
        title: row.kind === 'plan' ? props.t('activity.tool.plan') : row.presentation,
        icon: h(StateDot, { state: dotState(row.status) }),
        open,
        expandable: true,
        expandOnRowClick: true,
        onToggle: toggle,
      },
      pendingDetail,
    )
  }
  const full = current ?? row
  if (full.kind === 'plan') return planRowElement(full, props.t, open, toggle)
  if (usesNativeActivityToolProjection(full))
    return h(
      'div',
      null,
      props.renderTool?.(full),
      openChild === undefined
        ? null
        : h(
            Button,
            { variant: 'outline', size: 'sm', className: css.openRecord, onClick: openChild },
            props.t('subagent.openRecord'),
          ),
      full.display?.unavailable === undefined
        ? null
        : h(
            'p',
            { role: 'status' },
            props.t(full.display.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge'),
          ),
    )
  return activityRowElement({ ...props, row: full, open, onToggle: toggle })
}

/** Historical ACP plan snapshot. The current plan is also projected into DSH's native todo dock. */
function planRowElement(
  row: AcpActivityView,
  t: ActivityNodeProps['t'],
  open: boolean,
  onToggle: () => void,
): ReactNode {
  const legacy = detailValue(row)
  const entries =
    row.display !== undefined
      ? (row.display.plan ?? [])
      : Array.isArray(legacy)
        ? legacy.filter(
            (item): item is { content: string; status: string } =>
              record(item) &&
              typeof item.content === 'string' &&
              ['pending', 'in_progress', 'completed'].includes(String(item.status)),
          )
        : []
  return h(
    DisclosureRow,
    {
      title: t('activity.tool.plan'),
      icon: h(StateDot, { state: dotState(row.status) }),
      expandable: entries.length > 0 || row.display?.unavailable !== undefined,
      open,
      onToggle,
    },
    row.display?.unavailable !== undefined
      ? h('p', null, t(row.display?.unavailable === 'invalid' ? 'activity.detailInvalid' : 'activity.detailTooLarge'))
      : h(
          'ul',
          { className: css.planList },
          ...entries.map((entry, index) =>
            h(
              'li',
              { key: index, className: css.planItem, 'data-status': entry.status },
              h(
                'span',
                { className: css.planGlyph, 'aria-hidden': true },
                h(StateDot, {
                  state: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'ongoing' : 'idle',
                }),
              ),
              h(
                'span',
                { className: css.planContent },
                h('span', null, entry.content),
                h(
                  'span',
                  { className: css.planStatus },
                  ` · ${t(
                    entry.status === 'completed'
                      ? 'activity.status.completed'
                      : entry.status === 'in_progress'
                        ? 'activity.status.running'
                        : 'activity.status.pending',
                  )}`,
                ),
              ),
            ),
          ),
        ),
  )
}

const UNSETTLED_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }

/** Subscribe to native Step facts: a final marker retires the live journal view. */
export function AcpActivityNode(
  props: ActivityNodeProps & Omit<ChatNodeViewProps<'acp-activity'>, 't'> & PropsRenderFactories,
): ReactNode {
  const location = props.node.location
  const source = location.kind === 'step' ? location.step.data.source('acp-activity') : UNSETTLED_SOURCE
  const settled = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (props.node.data.settled !== true && settled !== undefined) return null
  return h(AcpActivityContent, { ...props, renderTool: (row) => renderNativeActivityTool(props, row, props.t) })
}

/** Additive ACP activity renderer. Agent-provided presentation is never translated. */
export function AcpActivityContent({
  node,
  sessionId,
  journalHub,
  t,
  openFile,
  onOpenProjectedChild,
  jsonStringWrapping,
  renderTool,
  useDisclosure,
}: ActivityNodeProps): ReactNode {
  const [rows, setRows] = useState<readonly ActivityPresentationRow[]>([])
  const [feedback, setFeedback] = useState<ActivityJournalFeedback>('quiet')
  const [canRetry, setCanRetry] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const retryRef = useRef<(() => void) | undefined>(undefined)
  const data = node.data
  useEffect(() => {
    let handle!: ReturnType<AcpActivityJournalHub['acquire']>
    const publish = (): void => {
      const all = handle.snapshot()
      const next = visibleActivityRows(all)
      setRows(next)
      setRetrying(handle.retrying())
      setCanRetry(handle.canRetry())
      setFeedback(handle.feedback())
    }
    const ownerSessionId = activityJournalSessionId(data, sessionId)
    handle = journalHub.acquire(ownerSessionId, ownerSessionId, data.promptAnchorMessageId, publish)
    retryRef.current = handle.retry
    publish()
    return () => {
      retryRef.current = undefined
      handle.release()
    }
  }, [data.ownerDshSessionId, data.promptAnchorMessageId, sessionId, journalHub])

  if (rows.length === 0 && feedback === 'quiet') return null
  return h(
    'section',
    { className: css.flow, 'data-acp-activity': true },
    ...rows.map((row) =>
      h(ActivityRow, {
        key: `${row.activityId}:${row.activitySeq}`,
        row,
        t,
        openFile,
        journalHub,
        useDisclosure,
        ...(renderTool === undefined ? {} : { renderTool }),
        ...(jsonStringWrapping === undefined ? {} : { jsonStringWrapping }),
        ...(onOpenProjectedChild === undefined ? {} : { onOpenProjectedChild }),
      }),
    ),
    feedback === 'reconnecting' || feedback === 'initial-read-retrying'
      ? h(
          'div',
          { className: css.status },
          h(StateDot, { state: 'ongoing' }),
          h('span', null, t(feedback === 'reconnecting' ? 'activity.reconnecting' : 'activity.initialReadRetrying')),
        )
      : feedback === 'unavailable'
        ? h(
            'div',
            { className: css.unavailable },
            h(StateDot, { state: 'error' }),
            h('span', null, t('activity.unavailable')),
            canRetry || retrying
              ? h(
                  Button,
                  {
                    variant: 'outline',
                    size: 'sm',
                    disabled: retrying,
                    onClick: () => {
                      retryRef.current?.()
                    },
                  },
                  t('activity.retry'),
                )
              : null,
          )
        : null,
  )
}

/** Presentation-only normalization. These blocks never enter the agent loop,
 * session event log, model context, tool execution or permission system. */
export function nativeActivityToolBlock(
  row: AcpActivityView,
  externalAgentLabel?: string,
  externalAgentStatusLabel?: (status: string) => string,
  translateOutput?: ActivityNodeProps['t'],
): ToolCallBlock {
  if (row.status === 'unfinished')
    throw new Error('An ACP activity without a reported result cannot be projected as a native tool result')
  const value = detailValue(row)
  const detail = record(value) ? value : {}
  const externalDelegations = Array.isArray(detail.externalDelegations)
    ? detail.externalDelegations.flatMap((item) =>
        record(item) && typeof item.label === 'string' && item.label.length > 0
          ? [
              {
                label: item.label,
                status: typeof item.status === 'string' ? item.status : 'unfinished',
              },
            ]
          : [],
      )
    : []
  const raw = detail.rawInput
  const mcp = record(raw) && typeof raw.tool === 'string' && record(raw.arguments)
  let input: unknown = mcp ? raw.arguments : raw
  let name = typeof detail.toolName === 'string' ? detail.toolName : row.presentation
  if (detail.toolSource === 'claude:Edit') name = 'edit'
  else if (detail.toolSource === 'claude:Write') name = 'write'
  if (mcp) name = String(raw.tool)
  name = name.replace(/^mcp__.+?__/, '').replace(/^[a-f0-9]{8,}_/, '')
  const command = record(input) ? (input.command ?? input.cmd) : undefined
  const terminal = terminalDetail(row, value)
  const diffs = activityDiffs(row, value)
  const file = record(input) ? (input.file_path ?? input.path) : undefined
  let meta: unknown
  if (typeof command === 'string' && (!mcp || /^(bash|pwsh|exec_command|shell)$/i.test(name))) {
    name = /^(pwsh|powershell)$/i.test(name) ? 'pwsh' : 'bash'
    input = {
      ...(record(input) ? input : {}),
      command,
      ...(terminal?.cwd === undefined ? {} : { workdir: terminal.cwd }),
      // Native shell results with unknown exit status use the generic body;
      // do not fabricate a successful exit just to obtain a terminal card.
      ...(terminal?.exitCode === undefined && terminal?.signal === undefined ? {} : { description: row.presentation }),
    }
  } else if (diffs.length > 0) {
    name = diffs.every((diff) => diff.oldText === null) ? 'write' : 'edit'
    const first = diffs[0]!
    input = {
      ...(record(input) ? input : {}),
      file_path: first.path,
      ...(name === 'write'
        ? { content: first.newText }
        : { old_string: first.oldText ?? '', new_string: first.newText }),
    }
    meta = { diffs }
  } else if (
    detail.toolKind === 'read' &&
    typeof file === 'string' &&
    record(input) &&
    input.pattern === undefined &&
    input.query === undefined
  ) {
    name = 'read'
    input = { ...(record(input) ? input : {}), file_path: file }
    // Numbered output does not report the file total, even when it starts at 1.
    // Keep that output in the native IO body instead of fabricating Read metadata.
  }
  const target = record(input) ? (input.file_path ?? input.path) : undefined
  const path =
    diffs.length <= 1 && (name === 'read' || name === 'write' || name === 'edit')
      ? operationFilePath(detail, target)
      : undefined
  if (path !== undefined) meta = { ...(record(meta) ? meta : {}), path }
  if (externalAgentLabel !== undefined && externalDelegations.length > 0) {
    const labels = externalDelegations.map((item) =>
      externalAgentStatusLabel === undefined
        ? `${item.label} · ${item.status}`
        : `${item.label} · ${externalAgentStatusLabel(item.status)}`,
    )
    name = `${externalAgentLabel} · ${labels.join(', ')} · ${name}`
  }
  const callId = `acp:${row.ownerDshSessionId}:${row.promptAnchorMessageId}:${row.activityId}`
  const argsRaw = input === undefined ? '{}' : typeof input === 'string' ? input : JSON.stringify(input)
  const args = PartialArguments.fromText(argsRaw)
  if (row.status === 'running')
    return { callId, name, phase: 'start', args, argsRaw, turn: 0, step: 0, time: row.time, subCalls: [] }
  const shell = name === 'bash' || name === 'pwsh'
  const hostOutcome = shell ? activityHostTerminalOutcome(value, row.ownerDshSessionId) : undefined
  const hostProcessFailed =
    hostOutcome !== undefined &&
    (hostOutcome.signal !== null || (hostOutcome.exitCode !== null && hostOutcome.exitCode !== 0))
  let output =
    translateOutput === undefined
      ? contentText(detail.rawOutput ?? detail.content)
      : activityToolOutput(
          shell ? (terminal?.output ?? detail.rawOutput) : detail.rawOutput,
          toolDisplayContent(detail, row.status === 'failed' || row.status === 'cancelled'),
          translateOutput,
          shell ? terminal : undefined,
        ).text
  if ((name === 'bash' || name === 'pwsh') && terminal !== undefined) {
    if (translateOutput === undefined) output = terminal.output ?? output
    if (terminal.signal !== undefined) output += `\n[killed by signal: ${terminal.signal}]`
    else if (terminal.exitCode !== undefined) output += `\n[exit code: ${terminal.exitCode}]`
  }
  return {
    kind: 'tool-result',
    callId,
    name,
    args,
    seq: row.activitySeq,
    time: row.time,
    callTime: null,
    call: { name, argsRaw },
    content: output === '' ? [] : [{ type: 'text', text: output }],
    isError: row.status === 'failed' || row.status === 'cancelled' || hostProcessFailed,
    subCalls: [],
    ...(row.status === 'cancelled' ? { error: { name: 'Interrupted', code: 'interrupted' } } : {}),
    ...(meta === undefined ? {} : { meta }),
  }
}

export function renderNativeActivityTool(
  props: Omit<ChatNodeViewProps, 't'> & PropsRenderFactories,
  row: AcpActivityView,
  t: ActivityNodeProps['t'],
): ReactNode {
  return h(NativeActivityTool, { owner: props, row, t })
}

function NativeActivityTool({
  owner,
  row,
  t,
}: {
  owner: Omit<ChatNodeViewProps, 't'> & PropsRenderFactories
  row: AcpActivityView
  t: ActivityNodeProps['t']
}): ReactNode {
  const block = useMemo(
    () =>
      nativeActivityToolBlock(
        row,
        t('activity.externalAgent'),
        (status) => {
          const statusKey =
            status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled'
              ? status
              : 'unfinished'
          return t(`activity.externalAgentStatus.${statusKey}` as AcpLocaleKey)
        },
        t,
      ),
    [row, t],
  )
  const props: NativeToolOwner = {
    ...nativeOwner(owner),
    // Sidecar call IDs have no native trajectory event to inspect.
    inspectCall: undefined,
    node: { ...owner.node, kind: 'tool-call', data: { root: block } },
  }
  const supplement = useMemo(() => {
    // Only a successful adapter-projected root diff suppresses generic output.
    // Read has no invented lines metadata; Bash renders the mapped output text.
    // Match the normalized arguments consumed by the pinned native Diff card.
    if (
      !('kind' in block) ||
      block.isError ||
      (block.name !== 'write' && block.name !== 'edit') ||
      !record(block.meta) ||
      !Array.isArray(block.meta.diffs) ||
      block.meta.diffs.length === 0 ||
      (block.args.text('file_path') ?? '').trim() === '' ||
      (block.name === 'edit' && block.args.has('replace_all') && typeof block.args.value('replace_all') !== 'boolean')
    )
      return ''
    const detail = detailValue(row)
    if (!record(detail)) return ''
    const output = activityToolOutput(detail.rawOutput, detail.content, t)
    const hasDisplayCaption = textContent(detail.content).some((text) => text.trim() !== '')
    return output.hasUnrepresentedSupplement || hasDisplayCaption
      ? joinActivityToolOutput(output.items.filter((item) => item.kind !== 'diff'))
      : ''
  }, [block, row, t])
  const deferredWait = useMemo(() => {
    const detail = detailValue(row)
    return (
      activityHostToolControlOutcome(detail, row) !== undefined &&
      record(detail) &&
      !(Array.isArray(detail.content) && detail.content.length > 0)
    )
  }, [row])
  // locale.bind() retains identity across native locale changes. Cache only
  // protocol facts; resolve human copy on every render. The authenticated
  // control message and receipt remain in the journal/diagnostics, not the card.
  const control = deferredWait
    ? {
        title: t('activity.control.waitTitle'),
        status: t('activity.control.notExecuted'),
        explanation: t('activity.control.teamReplyQueued'),
      }
    : undefined
  // Keep this owner stable as streamed or deferred content arrives. Changing
  // between the direct tree and this wrapper would discard a user's open state.
  if (block.subCalls.length === 0) {
    const card = h(NativeToolWithSupplement, { owner, props, supplement, control })
    const terminal = terminalDetail(row, detailValue(row))
    return h(
      NativeTerminalOutputNotice.Provider,
      {
        value:
          terminal !== undefined && !terminal.running && terminal.output === undefined
            ? t('activity.terminal.outputNotProvided')
            : undefined,
      },
      card,
    )
  }
  return owner.renderFactorySlot('acp.native-tool', props)
}

/** One disclosure invocation owns both the native row and its extra content.
 * Calling the bound hook twice creates independent states. This is confined to
 * an ACP root with no subcalls; ordinary native trees retain their own hooks. */
function NativeToolWithSupplement({
  owner,
  props,
  supplement,
  control,
}: {
  owner: Omit<ChatNodeViewProps, 't'> & PropsRenderFactories
  props: NativeToolOwner
  supplement: string
  control?: { title: string; status: string; explanation: string } | undefined
}): ReactNode {
  const disclosure = owner.useDisclosure()
  const useSharedDisclosure = useCallback(() => disclosure, [disclosure])
  return h(
    'div',
    {
      className: `${css.nativeToolOwner}${supplement === '' ? '' : ` ${css.hasSupplement}`}`,
      'data-acp-tool-supplement-owner': true,
    },
    control === undefined
      ? owner.renderFactorySlot('acp.native-tool', { ...props, useDisclosure: useSharedDisclosure })
      : h(
          DisclosureRow,
          {
            className: css.row,
            rowClassName: css.rowSummary,
            titleClassName: css.presentation,
            title: control.title,
            icon: h(StateDot, { state: 'idle' }),
            open: disclosure.expanded,
            onToggle: disclosure.toggle,
            expandable: true,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            collapsedContent: h(
              'span',
              { className: css.status },
              h('span', { className: css.separator, 'aria-hidden': true }),
              control.status,
            ),
          },
          h(
            'div',
            { className: css.body, 'data-acp-host-control': 'deferred-team-message' },
            h('p', { className: css.externalText }, control.explanation),
          ),
        ),
    disclosure.expanded && supplement !== ''
      ? h('pre', { className: `${css.raw} ${css.toolSupplement}`, 'data-acp-tool-supplement': true }, supplement)
      : null,
  )
}
