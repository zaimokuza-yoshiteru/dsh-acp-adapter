import { describe, expect, it } from 'vitest'
import type { AssistantBlock, ChatConversationViewNode, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  activityWindowKey,
  normalizeAcpChatNodes,
  type AcpNormalizationCacheEntry,
  type ActivityWindow,
} from '../../../src/client/ui/acp-chat-normalization.ts'
import type { AcpActivityNodeData } from '../../../src/client/ui/activity-definitions.ts'

function response(
  step: number,
  blocks: readonly AssistantBlock[],
  options: {
    route?: 'acp' | 'native'
    committed?: boolean
    synthetic?: boolean
  } = {},
) {
  const activity: AcpActivityNodeData = {
    ownerDshSessionId: 'session',
    promptAnchorMessageId: `input-${step}`,
    profileId: 'devin',
    agentSessionId: 'remote',
    committedActivitySeq: step,
    settled: true,
  }
  const finalNode = {
    kind: 'assistant',
    seq: step * 10,
    time: step * 10,
    turn: 1,
    step,
    blocks,
    ...(options.synthetic ? { interrupted: true } : { messageId: `reply-${step}` }),
  }
  const node = {
    key: `reply-${step}`,
    id: `reply-${step}`,
    kind: 'assistant-step',
    target: 'chat',
    visibility: 'visible',
    anchorSeq: step * 10,
    location: {
      kind: 'step',
      turn: { turn: 1 },
      step: {
        step,
        data: { get: (key: string) => (options.route !== 'native' && key === 'acp-activity' ? activity : undefined) },
      },
    },
    data: {
      turn: 1,
      step,
      status: options.committed === false ? 'running' : 'settled',
      blocks,
      ...(options.committed === false ? {} : { finalNode }),
    },
  } as unknown as ChatConversationViewNode
  return { node, activity }
}

const text = (text: string): AssistantBlock => ({ kind: 'text', text })
const thought = (text: string): AssistantBlock => ({ kind: 'reasoning', text })
const replies = (nodes: readonly ChatConversationViewNode[]) =>
  nodes.filter((node): node is ChatNode<'assistant-step'> => node.kind === 'assistant-step')

describe('committed ACP replies across native automatic follow-up steps', () => {
  it.each([
    ['Main report with [file](./report.html).', 'No new information.'],
    ['OK', 'A long correction. '.repeat(30)],
    ['Identical text', 'Identical text'],
  ])('keeps both committed responses without selecting by contents: %s', (first, second) => {
    const report = response(1, [thought('Read the files'), text(first!)])
    const receipt = response(2, [thought('Handle the notice'), text(second!)])
    const process = {
      ...receipt.node,
      key: 'process',
      kind: 'turn-process',
      data: { turn: 1, answerStep: 2, answerAnchorSeq: 20, inlineReasoning: true, toolCallCount: 0 },
    } as ChatConversationViewNode
    const result = normalizeAcpChatNodes([process, report.node, receipt.node], new Map())
    const visible = replies(result).filter((node) => node.groupTree === 'turn')
    expect(visible.map((node) => node.data.blocks)).toEqual([[text(first!)], [text(second!)]])
    expect(visible.map((node) => node.key)).toEqual(['reply-1', 'reply-2'])
    expect(visible.map((node) => node.data.finalNode?.messageId)).toEqual(['reply-1', 'reply-2'])
    expect(
      replies(result)
        .filter((node) => node.data.blocks.some((block) => block.kind === 'reasoning'))
        .every((node) => node.groupTree === undefined),
    ).toBe(true)
    expect(result.find((node) => node.kind === 'turn-process')?.data).toMatchObject({
      answerStep: 2,
      inlineReasoning: true,
      toolCallCount: 0,
    })
  })

  it.each(['not loaded', 'unavailable', 'empty', 'ready'] as const)(
    'preserves the durable reply when the activity journal is %s without hiding its fallback',
    (state) => {
      const { node, activity } = response(1, [thought('Process'), text('Committed report')])
      const marker = {
        ...node,
        key: 'marker',
        kind: 'acp-activity',
        data: activity,
        groupTree: 'process',
      } as ChatConversationViewNode
      const windows = new Map<string, ActivityWindow>()
      if (state !== 'not loaded')
        windows.set(activityWindowKey(activity), {
          unavailable: state === 'unavailable',
          rows:
            state === 'ready'
              ? [
                  {
                    activityId: 'tool',
                    kind: 'tool',
                    status: 'completed',
                    contentIndex: 0,
                    rawDetail: JSON.stringify({ toolName: 'read_file', rawInput: { path: 'README.md' } }),
                  } as ActivityWindow['rows'][number],
                ]
              : [],
        })
      const result = normalizeAcpChatNodes([node, marker], windows)
      expect(result.find((item) => item.key === node.key)?.groupTree).toBe('turn')
      expect(result.some((item) => item.key === marker.key)).toBe(state === 'not loaded' || state === 'unavailable')
      expect(result.filter((item) => item.kind === 'tool-call').every((item) => item.groupTree === undefined)).toBe(
        true,
      )
    },
  )

  it.each(['native', 'streaming', 'synthetic interruption'] as const)(
    'does not promote %s to a committed ACP reply',
    (kind) => {
      const { node, activity } = response(1, [thought('Process'), text('Text')], {
        route: kind === 'native' ? 'native' : 'acp',
        committed: kind !== 'streaming',
        synthetic: kind === 'synthetic interruption',
      })
      const result = normalizeAcpChatNodes(
        [node],
        new Map([[activityWindowKey(activity), { rows: [], unavailable: false }]]),
      )
      expect(result.every((item) => item.groupTree === undefined)).toBe(true)
    },
  )

  it('does not expose reasoning-only responses or trailing reasoning with a preserved reply', () => {
    const report = response(1, [text('Report'), thought('Trailing private reasoning')])
    const empty = response(2, [thought('No reply')])
    const result = replies(normalizeAcpChatNodes([report.node, empty.node], new Map()))
    expect(result.filter((node) => node.groupTree === 'turn').map((node) => node.data.blocks)).toEqual([
      [text('Report')],
    ])
    expect(result.find((node) => node.key === report.node.key)?.data.finalNode?.messageId).toBe('reply-1')
    expect(result.filter((node) => node.data.finalNode?.messageId === 'reply-1')).toHaveLength(1)
  })

  it.each(['settled', 'interrupted'] as const)(
    'retains one final record and stable seat when a reasoning-only live response becomes %s without a reply',
    (status) => {
      const blocks = [thought('Only reasoning')]
      const live = response(1, blocks, { committed: false })
      const windows = new Map([[activityWindowKey(live.activity), { rows: [], unavailable: false }]])
      const running = normalizeAcpChatNodes([live.node], windows)
      expect(running.some((node) => node.key === live.node.key)).toBe(false)
      expect(replies(running).flatMap((node) => node.data.blocks)).toEqual(blocks)
      const final = response(1, blocks).node as ChatNode<'assistant-step'>
      const terminal = {
        ...final,
        data: {
          ...final.data,
          status,
          finalNode: { ...final.data.finalNode!, ...(status === 'interrupted' ? { interrupted: true } : {}) },
        },
      } as ChatNode<'assistant-step'>
      const result = replies(
        normalizeAcpChatNodes([terminal], windows, undefined, new Map(running.map((node) => [node.key, node]))),
      )
      expect(result.filter((node) => node.key === running[0]!.key)).toHaveLength(1)
      expect(result.filter((node) => node.data.finalNode !== undefined)).toHaveLength(1)
      expect(result[0]!.data).toMatchObject({ status, blocks, finalNode: { messageId: 'reply-1' } })
      expect(result[0]!.data.finalNode?.interrupted).toBe(status === 'interrupted' ? true : undefined)
      expect(result[0]!.groupTree).toBeUndefined()
    },
  )

  it.each(['reply then reasoning', 'reasoning only', 'synthetic interruption'] as const)(
    'keeps one native interruption marker on the owning segment: %s',
    (scenario) => {
      const { node, activity } = response(
        1,
        scenario === 'reasoning only'
          ? [thought('Only reasoning')]
          : [text('Partial reply'), thought('Trailing reasoning')],
        { synthetic: scenario === 'synthetic interruption' },
      )
      const assistant = node as ChatNode<'assistant-step'>
      const interrupted = {
        ...assistant,
        data: {
          ...assistant.data,
          status: 'interrupted',
          finalNode: { ...assistant.data.finalNode!, interrupted: true },
        },
      } as ChatNode<'assistant-step'>
      const result = replies(
        normalizeAcpChatNodes(
          [interrupted],
          new Map([[activityWindowKey(activity), { rows: [], unavailable: false }]]),
        ),
      )
      expect(result.filter((item) => item.data.status === 'interrupted')).toHaveLength(1)
      const owner = result.find((item) => item.data.status === 'interrupted')!
      expect(owner.key).toBe(scenario === 'reasoning only' ? `${node.key}:content:0` : node.key)
      expect(owner.data.finalNode?.interrupted).toBe(true)
      if (scenario === 'reply then reasoning') {
        expect(owner.groupTree).toBe('turn')
        expect(owner.data.blocks).toEqual([text('Partial reply')])
      } else expect(owner.groupTree).toBeUndefined()
    },
  )

  it('retains only the last reply segment inside a committed ACP prompt', () => {
    const { node, activity } = response(1, [text('Intermediate progress'), thought('Work'), text('Report')])
    const result = replies(
      normalizeAcpChatNodes([node], new Map([[activityWindowKey(activity), { rows: [], unavailable: false }]])),
    )
    expect(result.filter((node) => node.groupTree === 'turn').map((node) => node.data.blocks)).toEqual([
      [text('Report')],
    ])
    expect(
      result.find((node) =>
        node.data.blocks.some((block) => block.kind === 'text' && block.text === 'Intermediate progress'),
      )?.groupTree,
    ).toBeUndefined()
  })

  it('preserves committed replies with a shared historical activity anchor without duplicating journal rows', () => {
    const first = response(1, [text('First report')])
    const second = response(2, [text('Second report')])
    const ambiguous = {
      ...second.node,
      location: { ...first.node.location, step: { step: 2, data: { get: () => first.activity } } },
    } as unknown as ChatConversationViewNode
    const marker = {
      ...first.node,
      key: 'marker',
      kind: 'acp-activity',
      data: first.activity,
      groupTree: 'process',
    } as ChatConversationViewNode
    const result = normalizeAcpChatNodes(
      [first.node, ambiguous, marker],
      new Map([
        [
          activityWindowKey(first.activity),
          {
            unavailable: false,
            rows: [
              {
                activityId: 'tool',
                kind: 'tool',
                status: 'completed',
                contentIndex: 0,
              } as ActivityWindow['rows'][number],
            ],
          },
        ],
      ]),
    )
    expect(
      replies(result)
        .filter((node) => node.groupTree === 'turn')
        .map((node) => node.key),
    ).toEqual(['reply-1', 'reply-2'])
    expect(result.filter((node) => node.kind === 'acp-activity')).toEqual([marker])
    expect(result.some((node) => node.kind === 'tool-call')).toBe(false)
  })

  it('does not reuse a formerly folded seat after its public placement changes', () => {
    const { node, activity } = response(1, [text('Report')])
    const windows = new Map([[activityWindowKey(activity), { rows: [], unavailable: false }]])
    const folded = normalizeAcpChatNodes([response(1, [text('Report')], { committed: false }).node], windows)
    const cache = new Map<string, AcpNormalizationCacheEntry>()
    const cold = normalizeAcpChatNodes([node], windows, cache, new Map(folded.map((item) => [item.key, item])))
    const warm = normalizeAcpChatNodes([node], windows, cache, new Map(cold.map((item) => [item.key, item])))
    expect(cold[0]?.groupTree).toBe('turn')
    expect(warm[0]).toBe(cold[0])
    expect(normalizeAcpChatNodes([node], windows)[0]).toEqual(cold[0])
  })
})
