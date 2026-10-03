/** ACP presentation facts become native Chat nodes; execution events remain untouched. */
import type { ChatConversationViewNode, ChatNode, AssistantBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { nativeActivityToolBlock, type AcpActivityNodeData, type ActivityPresentationRow } from './AcpActivityNode.ts'

export interface ActivityWindow {
  readonly rows: readonly ActivityPresentationRow[]
  readonly unavailable: boolean
}
export interface AcpNormalizationCacheEntry {
  readonly source: ChatConversationViewNode
  readonly window: ActivityWindow
  readonly nodes: readonly ChatConversationViewNode[]
  readonly contribution: {
    readonly turn: number
    readonly tools: number
    readonly answer: number | null
    readonly step: number
  }
}
export function activityWindowKey(data: AcpActivityNodeData, fallbackSessionId?: string): string {
  return JSON.stringify([data.ownerDshSessionId || fallbackSessionId || '', data.promptAnchorMessageId])
}
export function activityData(node: ChatConversationViewNode): AcpActivityNodeData | undefined {
  if (node.location.kind !== 'step') return undefined
  return node.location.step.data.get('acp-activity') ?? node.location.step.data.get('acp-activity-live')
}
export function activityBoundaries(
  rows: readonly ActivityPresentationRow[],
  count: number,
  settled = false,
): Map<number, ActivityPresentationRow[]> {
  const boundaries = new Map<number, ActivityPresentationRow[]>()
  for (const row of rows) {
    if (row.contentIndex === undefined || (!settled && row.contentIndex > count)) continue
    const index = Math.min(row.contentIndex, count)
    const group = boundaries.get(index) ?? []
    group.push(row)
    boundaries.set(index, group)
  }
  return boundaries
}
export function finalAnswerStart(blocks: readonly AssistantBlock[], boundaries: ReadonlyMap<number, unknown>): number {
  let start = blocks.findLastIndex(
    (block) => (block.kind === 'text' && block.text.trim() !== '') || block.kind === 'image',
  )
  if (start < 0) return blocks.length
  while (start > 0 && !boundaries.has(start)) {
    const previous = blocks[start - 1]!
    if (previous.kind !== 'text' && previous.kind !== 'image') break
    start--
  }
  return start
}

function sameBlock(left: AssistantBlock, right: AssistantBlock): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  if (left.kind === 'text' || left.kind === 'reasoning') return right.kind === left.kind && left.text === right.text
  if (left.kind === 'image') return right.kind === 'image' && left.attachment === right.attachment
  if (left.kind === 'tool-call')
    return (
      right.kind === 'tool-call' &&
      left.callId === right.callId &&
      left.name === right.name &&
      left.argsRaw === right.argsRaw
    )
  return right.kind === 'other' && left.block === right.block
}

/** Retain a projected node when its public Chat fields are unchanged. */
function reuseProjectedNode(
  node: ChatConversationViewNode,
  previous: ReadonlyMap<string, ChatConversationViewNode> | undefined,
): ChatConversationViewNode {
  const old = previous?.get(node.key)
  if (
    old === undefined ||
    old.kind !== node.kind ||
    old.id !== node.id ||
    old.target !== node.target ||
    old.visibility !== node.visibility ||
    old.anchorSeq !== node.anchorSeq ||
    old.location !== node.location
  )
    return node
  if (node.kind === 'assistant-step' && old.kind === 'assistant-step') {
    const before = old.data as ChatNode<'assistant-step'>['data']
    const after = node.data as ChatNode<'assistant-step'>['data']
    const sameBlocks =
      before.blocks.length === after.blocks.length &&
      before.blocks.every((block, index) => sameBlock(block, after.blocks[index]!))
    return sameBlocks &&
      before.status === after.status &&
      before.turn === after.turn &&
      before.step === after.step &&
      before.time === after.time &&
      before.usage === after.usage &&
      before.finalNode === after.finalNode
      ? old
      : node
  }
  if (node.kind === 'tool-call' && old.kind === 'tool-call') {
    const before = old.data as { acpActivity?: ActivityPresentationRow }
    const after = node.data as { acpActivity?: ActivityPresentationRow }
    return before.acpActivity === after.acpActivity ? old : node
  }
  if (node.kind === 'acp-inline-activity' && old.kind === 'acp-inline-activity')
    return old.data === node.data ? old : node
  if (node.kind === 'turn-process' && old.kind === 'turn-process') {
    const before = old.data as Record<string, unknown>
    const after = node.data as Record<string, unknown>
    const keys = Object.keys(before)
    return keys.length === Object.keys(after).length && keys.every((key) => before[key] === after[key]) ? old : node
  }
  return old.data === node.data ? old : node
}

export function normalizeAcpChatNodes(
  nodes: readonly ChatConversationViewNode[],
  windows: ReadonlyMap<string, ActivityWindow>,
  cache?: Map<string, AcpNormalizationCacheEntry>,
  previous?: ReadonlyMap<string, ChatConversationViewNode>,
  fallbackSessionId?: string,
): readonly ChatConversationViewNode[] {
  const replaced = new Map<string, readonly ChatConversationViewNode[]>()
  const owned = new Set<string>()
  const owners = new Map<string, number>()
  for (const node of nodes) {
    if (node.kind !== 'assistant-step') continue
    const data = activityData(node)
    if (data !== undefined) {
      const key = activityWindowKey(data, fallbackSessionId)
      owners.set(key, (owners.get(key) ?? 0) + 1)
    }
  }
  const turns = new Map<number, { tools: number; answer: number | null; step: number; inlineReasoning: boolean }>()
  const seenCache = new Set<string>()
  for (const base of nodes) {
    if (base.kind !== 'assistant-step') continue
    const data = activityData(base)
    if (data === undefined) continue
    const node = base as ChatNode<'assistant-step'>
    const windowKey = activityWindowKey(data, fallbackSessionId)
    // The public activity contract identifies a prompt window, not the owning
    // assistant step. Keep its marker as the lossless fallback while ownership
    // is ambiguous instead of repeating rows under every step.
    if (owners.get(windowKey) !== 1) {
      cache?.delete(node.key)
      continue
    }
    const window = windows.get(windowKey)
    // Keep the additive fallback until the sidecar is available, including failures.
    if (window === undefined || window.unavailable) {
      cache?.delete(node.key)
      continue
    }
    owned.add(windowKey)
    seenCache.add(node.key)
    const cached = cache?.get(node.key)
    if (cached?.source === base && cached.window === window) {
      replaced.set(node.key, cached.nodes)
      const old = turns.get(cached.contribution.turn)
      turns.set(cached.contribution.turn, {
        tools: (old?.tools ?? 0) + cached.contribution.tools,
        answer: cached.contribution.answer ?? old?.answer ?? null,
        step: cached.contribution.step,
        inlineReasoning: false,
      })
      continue
    }
    const blocks = node.data.blocks.map((block) =>
      block.kind === 'reasoning' ? { ...block, text: block.text.replace(/^\s*\n/, '') } : block,
    )
    const rows = window.rows
    const boundaries = activityBoundaries(rows, blocks.length, node.data.status !== 'running')
    const answer = finalAnswerStart(blocks, boundaries)
    const firstVisibleBlock = blocks.findIndex(
      (block) => (block.kind === 'text' && block.text.trim() !== '') || block.kind === 'image',
    )
    const stableAnchorIndex = answer < blocks.length ? answer : firstVisibleBlock
    const segments: ChatConversationViewNode[] = []
    let hasAnchor = false
    const emitRow = (row: ActivityPresentationRow): void => {
      const key = `${node.key}:acp:${row.activityId}`
      segments.push(
        reuseProjectedNode(
          {
            ...node,
            key,
            id: key,
            kind: row.kind === 'tool' ? 'tool-call' : 'acp-inline-activity',
            data: row.kind === 'tool' ? { root: nativeActivityToolBlock(row), acpActivity: row } : row,
          },
          previous,
        ),
      )
    }
    for (let index = 0; index <= blocks.length; index++) {
      for (const row of boundaries.get(index) ?? []) emitRow(row)
      if (index === blocks.length) break
      const start = index
      const group = [blocks[index]!]
      while (index + 1 < blocks.length && !boundaries.has(index + 1) && index + 1 !== answer)
        group.push(blocks[++index]!)
      // Preserve native Node identity on the final answer segment so collapsed
      // process content cannot hide the key used by navigation and scrolling.
      const ownsAnchor: boolean =
        (stableAnchorIndex >= start && stableAnchorIndex <= index) || (stableAnchorIndex < 0 && !hasAnchor)
      const key = ownsAnchor ? node.key : `${node.key}:content:${start}`
      hasAnchor ||= ownsAnchor
      const { finalNode, ...message } = node.data
      segments.push({
        ...node,
        key,
        id: key,
        data: {
          ...message,
          blocks: group,
          ...(index === blocks.length - 1 && finalNode !== undefined ? { finalNode } : {}),
          status: index === blocks.length - 1 ? node.data.status : 'settled',
        },
      })
    }
    // Historical journals without content boundaries remain visible after their message.
    for (const row of rows) if (row.contentIndex === undefined) emitRow(row)
    if (blocks.length === 0) segments.push(node)
    const placed = segments.map((segment, index) =>
      reuseProjectedNode(
        {
          ...segment,
          anchorSeq: node.anchorSeq + index / (segments.length + 1),
        },
        previous,
      ),
    )
    replaced.set(node.key, placed)
    const final = placed.findLast(
      (segment) =>
        segment.kind === 'assistant-step' &&
        (segment.data as ChatNode<'assistant-step'>['data']).blocks.some(
          (block) => (block.kind === 'text' && block.text.trim() !== '') || block.kind === 'image',
        ),
    )
    const old = turns.get(node.data.turn)
    turns.set(node.data.turn, {
      tools: (old?.tools ?? 0) + placed.filter((segment) => segment.kind === 'tool-call').length,
      answer: final?.anchorSeq ?? old?.answer ?? null,
      step: node.data.step,
      inlineReasoning: false,
    })
    cache?.set(node.key, {
      source: base,
      window,
      nodes: placed,
      contribution: {
        turn: node.data.turn,
        tools: placed.filter((segment) => segment.kind === 'tool-call').length,
        answer: final?.anchorSeq ?? null,
        step: node.data.step,
      },
    })
  }
  if (cache !== undefined) for (const key of cache.keys()) if (!seenCache.has(key)) cache.delete(key)
  return nodes.flatMap((node) => {
    const replacement = replaced.get(node.key)
    if (replacement !== undefined) return replacement
    if (
      node.kind === 'acp-activity' &&
      owned.has(activityWindowKey(node.data as AcpActivityNodeData, fallbackSessionId))
    )
      return []
    if (node.kind === 'turn-process') {
      const process = node as ChatNode<'turn-process'>
      const turn = turns.get(process.data.turn)
      if (turn !== undefined)
        return [
          reuseProjectedNode(
            {
              ...process,
              data: {
                ...process.data,
                toolCallCount: process.data.toolCallCount + turn.tools,
                // A native follow-up step can close the same Turn. Its answer boundary
                // remains authoritative; only split the ACP step that owns the answer.
                ...(process.data.answerStep === turn.step
                  ? {
                      answerAnchorSeq: turn.answer,
                      inlineReasoning: turn.inlineReasoning,
                    }
                  : {}),
              },
            },
            previous,
          ),
        ]
    }
    return [node]
  })
}
