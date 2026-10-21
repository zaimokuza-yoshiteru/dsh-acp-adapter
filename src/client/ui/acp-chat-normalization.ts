/** ACP presentation facts become native Chat nodes; execution events remain untouched. */
import type { ChatConversationViewNode, ChatNode, AssistantBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  nativeActivityToolBlock,
  usesNativeActivityToolProjection,
  type AcpActivityNodeData,
  type ActivityPresentationRow,
} from './AcpActivityNode.ts'

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
  if (node.kind === 'acp-activity') return node.visibility === 'hidden' ? undefined : (node.data as AcpActivityNodeData)
  if (node.location.kind !== 'step') return undefined
  return node.location.step.data.get('acp-activity') ?? node.location.step.data.get('acp-activity-live')
}
function stepKey(node: ChatConversationViewNode): string | undefined {
  return node.location.kind === 'step' ? `${node.location.turn.turn}:${node.location.step.step}` : undefined
}
function stepActivityData(
  node: ChatConversationViewNode,
  liveMarkersByStep: ReadonlyMap<string, readonly ChatConversationViewNode[]>,
): AcpActivityNodeData | undefined {
  const locationData =
    node.location.kind === 'step'
      ? (node.location.step.data.get('acp-activity') ?? node.location.step.data.get('acp-activity-live'))
      : undefined
  if (locationData !== undefined) return locationData
  if (node.kind !== 'assistant-step') return undefined
  const live = liveMarkersByStep.get(stepKey(node) ?? '') ?? []
  return live.length === 1 ? (live[0]!.data as AcpActivityNodeData) : undefined
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
    old.groupTree !== node.groupTree ||
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

function projectActivityRow(
  owner: ChatConversationViewNode,
  row: ActivityPresentationRow,
  windowKey: string,
): ChatConversationViewNode {
  // The same journal row can precede its first assistant chunk. Its seat must
  // survive the move from the admitted request to that assistant's content.
  const key = JSON.stringify(['acp-activity', windowKey, row.activityId])
  const nativeTool = usesNativeActivityToolProjection(row)
  return {
    ...owner,
    key,
    id: key,
    kind: nativeTool ? 'tool-call' : 'acp-inline-activity',
    data: nativeTool ? { root: nativeActivityToolBlock(row), acpActivity: row } : row,
  } as ChatConversationViewNode
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
  const markersByWindow = new Map<string, ChatConversationViewNode[]>()
  for (const node of nodes) {
    if (node.kind === 'acp-activity') {
      const data = node.data as AcpActivityNodeData
      const key = activityWindowKey(data, fallbackSessionId)
      const group = markersByWindow.get(key) ?? []
      group.push(node)
      markersByWindow.set(key, group)
    }
  }
  const duplicateMarkers = new Set<string>()
  for (const markers of markersByWindow.values()) {
    const settled = markers.find(
      (node) => node.visibility !== 'hidden' && (node.data as AcpActivityNodeData).settled === true,
    )
    if (settled !== undefined) {
      for (const marker of markers) if (marker !== settled) duplicateMarkers.add(marker.key)
      continue
    }
    const live = markers.find((node) => node.id.startsWith('input:') && node.visibility !== 'hidden')
    if (live !== undefined) {
      for (const marker of markers) if (marker !== live) duplicateMarkers.add(marker.key)
      continue
    }
    // A hidden current-input marker means this Step resolved to another or an
    // unknown provider. Do not leave an earlier ACP request/header fallback
    // visible for the same input window.
    const hiddenLive = markers.some((node) => node.id.startsWith('input:') && node.visibility === 'hidden')
    if (hiddenLive) {
      for (const marker of markers) duplicateMarkers.add(marker.key)
      continue
    }
    const fallback = markers.find((node) => node.visibility !== 'hidden')
    if (fallback !== undefined) for (const marker of markers) if (marker !== fallback) duplicateMarkers.add(marker.key)
  }
  const liveMarkersByStep = new Map<string, ChatConversationViewNode[]>()
  for (const markers of markersByWindow.values()) {
    for (const marker of markers) {
      if (!marker.id.startsWith('input:') || duplicateMarkers.has(marker.key) || marker.visibility === 'hidden')
        continue
      const data = marker.data as AcpActivityNodeData
      if ((windows.get(activityWindowKey(data, fallbackSessionId))?.rows.length ?? 0) === 0) continue
      const key = stepKey(marker)
      if (key === undefined) continue
      const group = liveMarkersByStep.get(key) ?? []
      group.push(marker)
      liveMarkersByStep.set(key, group)
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'assistant-step') continue
    const data = stepActivityData(node, liveMarkersByStep)
    if (data === undefined) continue
    const key = activityWindowKey(data, fallbackSessionId)
    owners.set(key, (owners.get(key) ?? 0) + 1)
  }
  const turns = new Map<number, { tools: number; answer: number | null; step: number }>()
  const earlyCandidates = new Map<string, { marker: ChatConversationViewNode; window: ActivityWindow }>()
  const earlySteps = new Map<string, number>()
  for (const [windowKey, markers] of markersByWindow) {
    if (owners.has(windowKey)) continue
    const window = windows.get(windowKey)
    // Without an assistant, only a known prefix can be placed without moving
    // a tool ahead of content that has not reached the native stream yet.
    if (
      window === undefined ||
      window.unavailable ||
      window.rows.length === 0 ||
      window.rows.some((row) => row.contentIndex !== 0)
    )
      continue
    if (!markers.some((marker) => marker.visibility !== 'hidden' && !duplicateMarkers.has(marker.key))) continue
    const requests = markers.filter(
      (marker) => marker.visibility !== 'hidden' && marker.id.startsWith('request:') && marker.location.kind === 'step',
    )
    if (requests.length !== 1) continue
    const marker = requests[0]!
    const step = stepKey(marker)!
    earlyCandidates.set(windowKey, { marker, window })
    earlySteps.set(step, (earlySteps.get(step) ?? 0) + 1)
  }
  for (const [windowKey, { marker, window }] of earlyCandidates) {
    if (earlySteps.get(stepKey(marker)!) !== 1 || marker.location.kind !== 'step') continue
    // Empty marker seats stay outside step runs. Actual activity joins the
    // native run immediately, so its group and member parent need not change
    // when the first assistant response arrives.
    const { groupTree: _markerPosition, ...owner } = marker
    const placed = window.rows.map((row, index) =>
      reuseProjectedNode(
        {
          ...projectActivityRow(owner, row, windowKey),
          anchorSeq: marker.anchorSeq + index / (window.rows.length + 1),
        },
        previous,
      ),
    )
    replaced.set(marker.key, placed)
    owned.add(windowKey)
    const turn = marker.location.turn.turn
    const old = turns.get(turn)
    turns.set(turn, {
      tools: (old?.tools ?? 0) + placed.filter((node) => node.kind === 'tool-call').length,
      answer: old?.answer ?? null,
      step: marker.location.step.step,
    })
  }
  const seenCache = new Set<string>()
  for (const base of nodes) {
    if (base.kind !== 'assistant-step') continue
    const data = stepActivityData(base, liveMarkersByStep)
    if (data === undefined) continue
    const node = base as ChatNode<'assistant-step'>
    const windowKey = activityWindowKey(data, fallbackSessionId)
    // The public activity contract identifies a prompt window, not the owning
    // assistant step. Keep its marker as the lossless fallback while ownership
    // is ambiguous instead of repeating rows under every step.
    const window = owners.get(windowKey) === 1 ? windows.get(windowKey) : undefined
    const journalReady = window !== undefined && !window.unavailable
    // A committed ACP response remains a reply when a later native step admits
    // an automatic notification. The native finalNode, not content or the last
    // step in a Turn, establishes that this response was actually committed.
    const committedReply = data.settled === true && node.data.finalNode?.messageId !== undefined
    // Keep the additive journal fallback until its sidecar is available. A
    // persisted response can still retain its native reply seat independently.
    if (!journalReady && !committedReply) {
      cache?.delete(node.key)
      continue
    }
    if (journalReady) {
      owned.add(windowKey)
      seenCache.add(node.key)
    } else cache?.delete(node.key)
    const cached = cache?.get(node.key)
    if (journalReady && cached?.source === base && cached.window === window) {
      replaced.set(node.key, cached.nodes)
      const old = turns.get(cached.contribution.turn)
      turns.set(cached.contribution.turn, {
        tools: (old?.tools ?? 0) + cached.contribution.tools,
        answer: cached.contribution.answer ?? old?.answer ?? null,
        step: cached.contribution.step,
      })
      continue
    }
    const blocks = node.data.blocks.map((block) =>
      block.kind === 'reasoning' ? { ...block, text: block.text.replace(/^\s*\n/, '') } : block,
    )
    const rows = journalReady ? window.rows : []
    const boundaries = activityBoundaries(rows, blocks.length, node.data.status !== 'running')
    const answer = finalAnswerStart(blocks, boundaries)
    const firstVisibleBlock = blocks.findIndex(
      (block) => (block.kind === 'text' && block.text.trim() !== '') || block.kind === 'image',
    )
    const stableAnchorIndex = answer < blocks.length ? answer : firstVisibleBlock
    const segments: ChatConversationViewNode[] = []
    let hasAnchor = false
    const emitRow = (row: ActivityPresentationRow): void => {
      segments.push(reuseProjectedNode(projectActivityRow(node, row, windowKey), previous))
    }
    for (let index = 0; index <= blocks.length; index++) {
      for (const row of boundaries.get(index) ?? []) emitRow(row)
      if (index === blocks.length) break
      const start = index
      const group = [blocks[index]!]
      while (
        index + 1 < blocks.length &&
        !boundaries.has(index + 1) &&
        index + 1 !== answer &&
        // A later answer must not merge earlier prose and reasoning into a new
        // native Node: its reasoning part owns the already mounted process group.
        (blocks[index]!.kind === 'reasoning') === (blocks[index + 1]!.kind === 'reasoning') &&
        // A reply seat must never pull trailing reasoning into the visible reply.
        !(start === answer && blocks[index + 1]!.kind !== 'text' && blocks[index + 1]!.kind !== 'image')
      )
        group.push(blocks[++index]!)
      // Preserve native Node identity on the final answer segment so collapsed
      // process content cannot hide the key used by navigation and scrolling.
      const ownsAnchor: boolean =
        (stableAnchorIndex >= start && stableAnchorIndex <= index) || (stableAnchorIndex < 0 && !hasAnchor)
      // A reasoning-only live segment must not borrow the future reply's key:
      // moving it later would replace the native process parent and its open tools.
      // Keep that identity through a no-reply cancellation too. Native navigation
      // is rebuilt from these projected nodes; finalNode stays on its owning segment.
      const key = ownsAnchor && stableAnchorIndex >= 0 ? node.key : `${node.key}:content:${start}`
      hasAnchor ||= ownsAnchor
      const { finalNode, ...message } = node.data
      segments.push({
        ...node,
        key,
        id: key,
        ...(committedReply && start === answer ? { groupTree: 'turn' as const } : {}),
        data: {
          ...message,
          blocks: group,
          ...(ownsAnchor && finalNode !== undefined ? { finalNode } : {}),
          // Keep the native interruption marker on the retained reply, even
          // when a later reasoning block belongs in the folded process.
          status:
            node.data.status === 'interrupted'
              ? ownsAnchor
                ? 'interrupted'
                : 'settled'
              : index === blocks.length - 1
                ? node.data.status
                : 'settled',
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
    })
    if (journalReady)
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
      (owned.has(activityWindowKey(node.data as AcpActivityNodeData, fallbackSessionId)) ||
        duplicateMarkers.has(node.key))
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
                // A native follow-up step can close the same Turn. Keep the host's
                // inline-reasoning flag authoritative; only split the ACP answer step.
                ...(process.data.answerStep === turn.step
                  ? {
                      answerAnchorSeq: turn.answer,
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
