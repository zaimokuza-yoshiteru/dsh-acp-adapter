/**
 * AcpToolRow: the keyed `tool.call.toolview` renderer for ACP
 * external-tool calls (`key: ACP_EXTERNAL_TOOL_NAME` — the stable wire name
 * every ACP tool/call now carries). It is a PURE RENDER contribution: no
 * store, no inject face, no fake executable tool is registered; calls logged
 * before (dynamic names) never match the key and land on the host's
 * GenericToolCard fallback by construction.
 *
 * Chrome mirrors the upstream ui-tool ToolRow (figma 122:9479): the shared
 * DisclosureRow 24px single-line row — leading 16px slot (kind icon; StateDot
 * on error), title, separator dot, FILL-truncated summary, whole-row expand
 * toggle, and the running sweep driven by `data-state`. The expanded body
 * renders the envelope sections: one DiffBlock per diff item (`oldText: null`
 * — the full old content is never logged, ), an IN/OUT gutter card for
 * the bounded input summary and the text/terminal/resource output lines, and
 * an explicit note when any envelope item is a truncated preview.
 *
 * Envelope source: the settled `ToolResultNode.meta` (the tool/result event's
 * `meta.acpToolPresentation`, decoded fail-closed by
 * ../data/tool-presentation.ts). A RUNNING call has no envelope — the
 * upstream RunningToolCall carries no meta — so the row renders its generic
 * title (localized `tool.title`) plus the bounded args preview until
 * settlement. A settled call whose meta fails to decode renders the same
 * minimal row over the logged result text (fail-closed, never throws).
 *
 * createElement style per this package's react.d.ts discipline (no JSX);
 * ui-primitives is the baseline module-table row (DiffBlock/DisclosureRow/
 * StateDot/icons value-imported; types from devDependencies).
 *
 * @module @zaimokuza/dsh-acp-adapter/client/AcpToolRow
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DiffBlock,
  DisclosureRow,
  IconApiOutline14,
  IconBrowseOutline16,
  IconEditOutline16,
  IconGlobeOutline14,
  IconSearchOutline16,
  IconSparkle16,
  IconThinkOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  acpToolIconKey,
  acpToolRowModel,
  decodeAcpToolPresentation,
} from '../data/tool-presentation.ts'
import type { AcpToolIconKey } from '../data/tool-presentation.ts'
import type { AcpRemoteResultLike, AcpToolCallPresentationView } from '../data/acp-remote.ts'
import type { AcpModelKey } from '../host-compat/model-picker/selector-locales.ts'
import css from './AcpToolRow.module.css'

/** The seat's translate seat (slot renderer binds it from the entry's `locale` declaration). */
export type AcpToolRowTranslate = (key: AcpModelKey, params?: Record<string, string | number>) => string

/**
 * Structural minimum of the upstream`ToolCallBlock` union (runtime
 * sessions/conversation.ts): the running form has no meta (the tool/call
 * meta never reaches the client); the settled form carries the tool/result
 * event's meta verbatim. Narrowed locally — the client bundle must not
 * import host/upstream modules (same discipline as react.d.ts).
 */
interface RunningToolCallLike {
  callId: string
  name: string
  argsRaw: string
}

interface ToolResultNodeLike {
  kind: 'tool-result'
  callId: string
  call: { name: string; argsRaw: string } | null
  content: readonly { type: string; text?: string }[]
  isError: boolean
  meta?: unknown
}

export type AcpToolCallBlockLike = RunningToolCallLike | ToolResultNodeLike

/** Registration-position props: the keyed toolview owner currency plus the locale seat. */
export interface AcpToolRowProps {
  sessionId?: string | undefined
  callId: string
  toolName: string
  block: AcpToolCallBlockLike
  cwd?: string | undefined
  home?: string | undefined
  openFile: (path: string) => void
  inspect?: (() => void) | undefined
  t: AcpToolRowTranslate
  loadPresentation?: ((toolCallId: string) => Promise<AcpRemoteResultLike<AcpToolCallPresentationView | null>>) | undefined
}

interface MouseEventLike {
  stopPropagation(): void
}

interface KeyboardEventLike {
  key: string
  stopPropagation(): void
}

/** Kind → leading glyph (figma variant table as upstream GenericToolCard; all glyphs render at 14 in the 16px slot). */
const ICONS: Record<AcpToolIconKey, (props: { size?: number | undefined; className?: string | undefined }) => ReactNode> = {
  read: IconBrowseOutline16,
  edit: IconEditOutline16,
  execute: IconApiOutline14,
  search: IconSearchOutline16,
  fetch: IconGlobeOutline14,
  think: IconThinkOutline16,
  other: IconSparkle16,
}

/** Flattened result text of a settled block (无信封时的 OUT 兜底). */
function resultTextOf(block: ToolResultNodeLike): string {
  return block.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('')
}

/**
 * The ACP external-tool row. All decisions live in ../data/tool-presentation.ts
 * (acpToolRowModel); this component is the pure render of that model.
 */
export function AcpToolRow({ callId, block, cwd, openFile, inspect, t, loadPresentation }: AcpToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [livePresentation, setLivePresentation] = useState<AcpToolCallPresentationView | undefined>(undefined)
  const settled = 'kind' in block
  const running = !settled
  useEffect(() => {
    if (!running || loadPresentation === undefined) {
      setLivePresentation(undefined)
      return
    }
    let disposed = false
    const refresh = (): void => {
      void loadPresentation(callId).then((result) => {
        if (disposed || !result.ok || result.value === null) return
        setLivePresentation(result.value)
      }).catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [callId, loadPresentation, running])
  const envelope = settled ? decodeAcpToolPresentation(block.meta) : undefined
  const model = acpToolRowModel({
    running,
    isError: settled ? block.isError : false,
    argsRaw: settled ? (block.call?.argsRaw ?? undefined) : block.argsRaw,
    resultText: settled ? resultTextOf(block) : undefined,
    envelope,
    cwd,
  })
  const open = expanded && model.expandable
  const iconKey = acpToolIconKey(envelope?.kind ?? livePresentation?.kind)
  const icon = model.agentExtension === undefined
    ? h(ICONS[iconKey], { size: 14 })
    : h(IconSparkle16, { size: 14 })
  const baseTitle = model.title ?? livePresentation?.title ?? t('tool.title')
  const title = model.agentExtension === undefined
    ? baseTitle
    : `${t('tool.codexSubagent')} · ${baseTitle}`
  const extensionSummary = model.agentExtension?.type === 'collaboration' && model.agentExtension.receiverThreadIds.length > 0
    ? t('tool.codexCollaboration', {
        tool: model.agentExtension.tool,
        count: model.agentExtension.receiverThreadIds.length,
      })
    : model.agentExtension?.type === 'subagent-activity'
      ? t('tool.codexActivity', {
          activity: model.agentExtension.activity,
          name: model.agentExtension.path.split('/').filter(Boolean).at(-1) ?? 'subagent',
        })
      : null
  const status = model.state === 'running' ? t('tool.running') : model.state === 'error' ? t('tool.failed') : null
  const fileLink = model.filePath !== undefined && model.state !== 'error'
  const openFileLink = (event: MouseEventLike): void => {
    event.stopPropagation()
    if (model.filePath !== undefined) openFile(model.filePath)
  }
  const fileLinkKeyDown = (event: KeyboardEventLike): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  const truncatedNotes: ReactNode[] = []
  if (model.diffs.some((diff) => diff.truncated)) {
    truncatedNotes.push(h('div', { key: 'patch', className: css.note }, t('tool.truncatedPatch')))
  }
  if (model.truncated) {
    truncatedNotes.push(h('div', { key: 'all', className: css.note }, t('tool.truncated')))
  }
  return h('div', { className: css.root, 'data-state': model.state },
    status !== null ? h('span', { className: css.visuallyHidden }, status) : null,
    h(DisclosureRow, {
      rowClassName: css.row,
      leadingClassName: css.leading,
      titleClassName: css.title,
      chevronClassName: css.chevron,
      icon: model.state === 'error' ? h(StateDot, { state: 'error' }) : icon,
      title,
      open,
      expandable: model.expandable,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: () => { setExpanded((value) => !value) },
      collapsedContent: extensionSummary !== null || model.summary !== ''
        ? [
            h('span', { key: 'sep', className: css.sep, 'aria-hidden': true }),
            extensionSummary !== null
              ? h('span', { key: 'agent-summary', className: css.summary }, extensionSummary)
              : fileLink
              ? h('button', {
                  key: 'summary',
                  type: 'button',
                  className: css.fileLink,
                  onClick: openFileLink,
                  onKeyDown: fileLinkKeyDown,
                }, model.summary)
              : h('span', {
                  key: 'summary',
                  className: model.state === 'error' ? css.errorSummary : css.summary,
                }, model.summary),
          ]
        : null,
    },
      h('div', { className: css.bodyWrap },
        model.diffs.map((diff) =>
          h(DiffBlock, {
            key: diff.path,
            diffs: [{ path: diff.path, oldText: null, newText: diff.newText }],
            className: css.diffBody,
          })),
        model.inputText !== undefined || model.outputText !== undefined
          ? h('div', { className: css.ioCard },
              model.inputText !== undefined
                ? h('div', { className: css.ioSection },
                    h('span', { className: css.ioLabel }, 'IN'),
                    h('span', { className: css.ioText }, model.inputText))
                : null,
              model.inputText !== undefined && model.outputText !== undefined
                ? h('span', { className: css.ioDivider, 'aria-hidden': true })
                : null,
              model.outputText !== undefined
                ? h('div', { className: css.ioSection },
                    h('span', { className: css.ioLabel }, 'OUT'),
                    h('span', {
                      className: css.ioText,
                      'data-error': model.state === 'error' || undefined,
                    }, model.outputText))
                : null)
          : null,
        ...truncatedNotes,
        inspect !== undefined
          ? h('button', { type: 'button', className: css.inspectButton, onClick: inspect }, t('tool.inspect'))
          : null)))
}
