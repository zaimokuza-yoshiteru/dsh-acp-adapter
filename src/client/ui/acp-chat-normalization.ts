/** ACP presentation facts become native Chat nodes; execution events remain untouched. */
import type { ChatConversationViewNode, ChatNode, AssistantBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { nativeActivityToolBlock, type AcpActivityNodeData, type ActivityPresentationRow } from './AcpActivityNode.ts'

export interface ActivityWindow {
  readonly rows: readonly ActivityPresentationRow[]
  readonly unavailable: boolean
}
export function activityWindowKey(data: AcpActivityNodeData): string {
  return JSON.stringify([data.ownerDshSessionId, data.promptAnchorMessageId])
}
export function activityData(node: ChatConversationViewNode): AcpActivityNodeData | undefined {
  if (node.location.kind !== 'step') return undefined
  return node.location.step.data.get('acp-activity') ?? node.location.step.data.get('acp-activity-live')
}
export function activityBoundaries(rows: readonly ActivityPresentationRow[], count: number, settled = false): Map<number, ActivityPresentationRow[]> {
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
  let start = blocks.findLastIndex(block => block.kind === 'text' && block.text.trim() !== '' || block.kind === 'image')
  if (start < 0) return blocks.length
  while (start > 0 && !boundaries.has(start)) {
    const previous = blocks[start - 1]!
    if (previous.kind !== 'text' && previous.kind !== 'image') break
    start--
  }
  return start
}

export function normalizeAcpChatNodes(nodes: readonly ChatConversationViewNode[], windows: ReadonlyMap<string, ActivityWindow>): readonly ChatConversationViewNode[] {
  const replaced = new Map<string, readonly ChatConversationViewNode[]>()
  const owned = new Set<string>()
  const turns = new Map<number, { tools: number; answer: number | null; step: number; inlineReasoning: boolean }>()
  for (const base of nodes) {
    if (base.kind !== 'assistant-step') continue
    const data = activityData(base)
    if (data === undefined) continue
    const node = base as ChatNode<'assistant-step'>
    const window = windows.get(activityWindowKey(data))
    // Keep the additive fallback until the sidecar is available, including failures.
    if (window === undefined || window.unavailable) continue
    owned.add(activityWindowKey(data))
    const blocks = node.data.blocks.map(block => block.kind === 'reasoning' ? { ...block, text: block.text.replace(/^\s*\n/, '') } : block)
    const rows = window.rows
    const boundaries = activityBoundaries(rows, blocks.length, node.data.status !== 'running')
    const answer = finalAnswerStart(blocks, boundaries)
    const segments: ChatConversationViewNode[] = []
    const emitRow = (row: ActivityPresentationRow): void => {
      const key = `${node.key}:acp:${row.activityId}`
      segments.push({ ...node, key, id: key, kind: row.kind === 'tool' ? 'tool-call' : 'acp-inline-activity',
        data: row.kind === 'tool' ? { root: nativeActivityToolBlock(row), acpActivity: row } : row })
    }
    for (let index = 0; index <= blocks.length; index++) {
      for (const row of boundaries.get(index) ?? []) emitRow(row)
      if (index === blocks.length) break
      const start = index
      const group = [blocks[index]!]
      while (index + 1 < blocks.length && !boundaries.has(index + 1) && index + 1 !== answer) group.push(blocks[++index]!)
      const key = `${node.key}:content:${start}`
      const { finalNode, ...message } = node.data
      segments.push({ ...node, key, id: key, data: { ...message, blocks: group,
        ...(index === blocks.length - 1 && finalNode !== undefined ? { finalNode } : {}),
        status: index === blocks.length - 1 ? node.data.status : 'settled',
      } })
    }
    // Historical journals without content boundaries remain visible after their message.
    for (const row of rows) if (row.contentIndex === undefined) emitRow(row)
    if (blocks.length === 0) segments.push(node)
    const placed = segments.map((segment, index) => ({ ...segment, anchorSeq: node.anchorSeq + index / (segments.length + 1) }))
    replaced.set(node.key, placed)
    const final = placed.findLast(segment => segment.kind === 'assistant-step' && (segment.data as ChatNode<'assistant-step'>['data']).blocks.some(block => block.kind === 'text' && block.text.trim() !== '' || block.kind === 'image'))
    const old = turns.get(node.data.turn)
    turns.set(node.data.turn, { tools: (old?.tools ?? 0) + placed.filter(segment => segment.kind === 'tool-call').length,
      answer: final?.anchorSeq ?? old?.answer ?? null, step: node.data.step, inlineReasoning: false })
  }
  return nodes.flatMap(node => {
    const replacement = replaced.get(node.key)
    if (replacement !== undefined) return replacement
    if (node.kind === 'acp-activity' && owned.has(activityWindowKey(node.data as AcpActivityNodeData))) return []
    if (node.kind === 'turn-process') {
      const process = node as ChatNode<'turn-process'>
      const turn = turns.get(process.data.turn)
      if (turn !== undefined) return [{ ...process, data: { ...process.data,
        toolCallCount: process.data.toolCallCount + turn.tools,
        // A native follow-up step can close the same Turn. Its answer boundary
        // remains authoritative; only split the ACP step that owns the answer.
        ...(process.data.answerStep === turn.step ? {
          answerAnchorSeq: turn.answer, inlineReasoning: turn.inlineReasoning,
        } : {}),
      } }]
    }
    return [node]
  })
}
