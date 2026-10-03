import { describe, it, expect } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { normalizeAcpChatNodes, activityWindowKey } from '../../../src/client/ui/acp-chat-normalization.ts'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationGroupDefinition,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpActivityView } from '../../../src/client/data/acp-remote.ts'
import {
  activityBoundaries,
  finalAnswerStart,
  createChatProjection,
  stageChatProjection,
  commitChatProjection,
  installAcpAssistantStream,
  uniqueViewTabs,
} from '../../../src/client/ui/AcpAssistantStream.ts'

describe('native assistant renderer composition', () => {
  it('keeps legacy and not-yet-delivered activity out of the inline boundaries', () => {
    const rows = [
      { activityId: 'old' },
      { activityId: 'tail', contentIndex: 2 },
      { activityId: 'future', contentIndex: 3 },
      { activityId: 'head', contentIndex: 0 },
    ] as AcpActivityView[]
    expect([...activityBoundaries(rows, 2)]).toEqual([
      [2, [rows[1]]],
      [0, [rows[3]]],
    ])
    expect([...activityBoundaries(rows, 2, true)]).toEqual([
      [2, [rows[1], rows[2]]],
      [0, [rows[3]]],
    ])
  })

  it('keeps all trailing answer paragraphs and images visible when folding the process', () => {
    const blocks = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: 'progress' },
      { kind: 'text', text: 'answer paragraph one' },
      { kind: 'text', text: 'answer paragraph two' },
    ] as never
    expect(
      finalAnswerStart(
        blocks,
        new Map([
          [2, []],
          [4, []],
        ]),
      ),
    ).toBe(2)
    expect(finalAnswerStart(blocks, new Map())).toBe(1)
  })

  it('composes the native Chat and header trees without redeclaring their child slots', async () => {
    const slots = new SlotCore()
    const root = slots.register(
      {
        name: 'root',
        children: {
          'conversation.view': { kind: 'list', scope: 'session' },
          'conversation.session.header': { kind: 'single', scope: 'session' },
        },
      } as never,
      (() => null) as never,
    )
    const Native = () => null
    const inject = () => ({ hooks: { presentation: {} } })
    slots.register(
      {
        name: 'conversation.view',
        id: 'chat',
        inject,
        children: {
          'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        },
      } as never,
      Native as never,
    )
    slots.register({ name: 'conversation.session.header' } as never, Native as never)
    slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, Native as never)
    const releases: Array<() => void> = []
    installAcpAssistantStream(
      {
        slots: {
          entries: slots.entries.bind(slots),
          entriesOfSlot: slots.entriesOfSlot.bind(slots),
          subscribe: slots.subscribe.bind(slots),
          register: slots.register.bind(slots),
          registerFactory: slots.registerFactory,
          inject: (_name: string, setup: () => () => void) => {
            releases.push(setup())
          },
        },
      } as never,
      {} as never,
    )
    await Promise.resolve()
    const chat = slots.entriesOfSlot('conversation.view')[0]!
    expect(chat.inject).toBe(inject)
    const child = Object.keys(chat.children!)[0]!
    expect(child).not.toBe('conversation.chat.node')
    expect(
      slots
        .entriesOfSlot(child)
        .map((entry) => entry.options.key)
        .sort(),
    ).toEqual(['acp-inline-activity', 'tool-call'])
    expect(uniqueViewTabs(slots.entries('conversation.view').map((entry) => ({ id: entry.options.id! })))).toEqual([
      { id: 'chat' },
    ])
    releases.reverse().forEach((release) => release())
    expect(slots.entriesOfSlot('conversation.view')[0]!.component).toBe(Native)
    expect(slots.entriesOfSlot(child)).toEqual([])
    root()
  })

  it('normalizes interleaved tools into native nodes, preserves ordinary nodes and falls back on journal errors', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'codex',
      agentSessionId: 'remote',
      committedActivitySeq: 4,
    }
    const location = {
      kind: 'step',
      turn: { turn: 1 },
      step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
    }
    const assistant = {
      key: 'answer',
      id: 'answer',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location,
      data: {
        status: 'settled',
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'reasoning', text: '\n\nThink' },
          { kind: 'text', text: 'Progress' },
          { kind: 'text', text: 'Answer one' },
          { kind: 'text', text: 'Answer two' },
        ],
      },
    } as unknown as ChatConversationViewNode
    const marker = { ...assistant, key: 'marker', kind: 'acp-activity', data }
    const native = { ...assistant, key: 'native', location: { kind: 'session' } } as ChatConversationViewNode
    const row = {
      activityId: 'tool:one',
      kind: 'tool',
      status: 'completed',
      contentIndex: 2,
      rawDetail: JSON.stringify({ toolName: 'send_message', rawInput: { target: 'worker' } }),
    } as AcpActivityView
    const key = activityWindowKey(data)
    const result = normalizeAcpChatNodes(
      [native, assistant, marker],
      new Map([[key, { rows: [row], unavailable: false }]]),
    )
    expect(result[0]).toBe(native)
    expect(result.map((node) => node.kind)).toEqual(['assistant-step', 'assistant-step', 'tool-call', 'assistant-step'])
    expect(result[1]!.data).toMatchObject({
      blocks: [
        { kind: 'reasoning', text: 'Think' },
        { kind: 'text', text: 'Progress' },
      ],
    })
    expect(result[2]!.data).toMatchObject({ root: { call: { name: 'send_message' } } })
    expect(result[3]!.data).toMatchObject({
      blocks: [
        { kind: 'text', text: 'Answer one' },
        { kind: 'text', text: 'Answer two' },
      ],
    })
    expect(normalizeAcpChatNodes([assistant, marker], new Map([[key, { rows: [], unavailable: true }]]))).toEqual([
      assistant,
      marker,
    ])
  })

  it('retains a ready journal step anchor when its first content follows a tool and on reload', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const assistant = {
      key: 'answer',
      id: 'answer',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location: {
        kind: 'step',
        turn: { turn: 1 },
        step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
      },
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Answer' }] },
    } as unknown as ChatConversationViewNode
    const marker = { ...assistant, key: 'marker', kind: 'acp-activity', data }
    const before = normalizeAcpChatNodes([assistant, marker], new Map())
    const ready = normalizeAcpChatNodes(
      [assistant, marker],
      new Map([
        [
          activityWindowKey(data),
          {
            rows: [
              {
                activityId: 'tool:first',
                kind: 'tool',
                status: 'completed',
                contentIndex: 0,
                rawDetail: JSON.stringify({ toolName: 'bash', rawInput: { command: 'true' } }),
              } as AcpActivityView,
            ],
            unavailable: false,
          },
        ],
      ]),
    )
    const reloaded = normalizeAcpChatNodes(
      [assistant, marker],
      new Map([
        [
          activityWindowKey(data),
          {
            rows: [
              {
                activityId: 'tool:first',
                kind: 'tool',
                status: 'completed',
                contentIndex: 0,
                rawDetail: JSON.stringify({ toolName: 'bash', rawInput: { command: 'true' } }),
              } as AcpActivityView,
            ],
            unavailable: false,
          },
        ],
      ]),
    )
    expect(before[0]!.key).toBe('answer')
    expect(ready.find((node) => node.kind === 'assistant-step')!.key).toBe('answer')
    expect(reloaded.find((node) => node.kind === 'assistant-step')!.key).toBe('answer')
    expect(ready.find((node) => node.kind === 'tool-call')!.anchorSeq).toBeLessThan(
      ready.find((node) => node.key === 'answer')!.anchorSeq,
    )
  })

  it('keeps the original navigation key on visible answer content after leading reasoning', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const assistant = {
      key: 'answer',
      id: 'answer',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location: {
        kind: 'step',
        turn: { turn: 1 },
        step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
      },
      data: {
        status: 'settled',
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'reasoning', text: 'Thinking' },
          { kind: 'text', text: 'Progress text' },
          { kind: 'text', text: 'Visible answer' },
        ],
      },
    } as unknown as ChatConversationViewNode
    const window = new Map([
      [
        activityWindowKey(data),
        {
          rows: [
            {
              activityId: 'tool:between',
              kind: 'tool',
              status: 'completed',
              contentIndex: 2,
              rawDetail: JSON.stringify({ toolName: 'bash' }),
            } as AcpActivityView,
          ],
          unavailable: false,
        },
      ],
    ])
    const unavailable = normalizeAcpChatNodes(
      [assistant],
      new Map([[activityWindowKey(data), { rows: [], unavailable: true }]]),
    )
    const projected = normalizeAcpChatNodes([assistant], window)
    const reasoning = projected.find(
      (node) =>
        node.kind === 'assistant-step' &&
        (node as ChatNode<'assistant-step'>).data.blocks.some((block) => block.kind === 'reasoning'),
    )!
    const answer = projected.find(
      (node) =>
        node.kind === 'assistant-step' &&
        (node as ChatNode<'assistant-step'>).data.blocks.some(
          (block) => block.kind === 'text' && block.text === 'Visible answer',
        ),
    )!
    expect(unavailable.find((node) => node.kind === 'assistant-step')!.key).toBe('answer')
    expect(reasoning.key).toBe('answer:content:0')
    expect(answer.key).toBe('answer')
    const reloaded = normalizeAcpChatNodes([assistant], window)
    expect(
      reloaded.find(
        (node) =>
          node.kind === 'assistant-step' &&
          (node as ChatNode<'assistant-step'>).data.blocks.some(
            (block) => block.kind === 'text' && block.text === 'Visible answer',
          ),
      )!.key,
    ).toBe('answer')
  })

  it('updates the native anchor when a new activity row changes fractional segment ordering', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const assistant = {
      key: 'answer',
      id: 'answer',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location: {
        kind: 'step',
        turn: { turn: 1 },
        step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
      },
      data: {
        status: 'settled',
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'text', text: 'prefix' },
          { kind: 'text', text: 'answer' },
        ],
      },
    } as unknown as ChatConversationViewNode
    const before = normalizeAcpChatNodes(
      [assistant],
      new Map([
        [
          activityWindowKey(data),
          {
            rows: [
              {
                activityId: 'tool:last',
                kind: 'tool',
                status: 'completed',
                contentIndex: 1,
                rawDetail: JSON.stringify({ toolName: 'bash' }),
              } as AcpActivityView,
            ],
            unavailable: false,
          },
        ],
      ]),
    )
    const after = normalizeAcpChatNodes(
      [assistant],
      new Map([
        [
          activityWindowKey(data),
          {
            rows: [
              {
                activityId: 'tool:first',
                kind: 'tool',
                status: 'completed',
                contentIndex: 0,
                rawDetail: JSON.stringify({ toolName: 'bash' }),
              } as AcpActivityView,
              {
                activityId: 'tool:last',
                kind: 'tool',
                status: 'completed',
                contentIndex: 1,
                rawDetail: JSON.stringify({ toolName: 'bash' }),
              } as AcpActivityView,
            ],
            unavailable: false,
          },
        ],
      ]),
    )
    const priorAnswer = before.find(
      (node) =>
        node.kind === 'assistant-step' &&
        (node as ChatNode<'assistant-step'>).data.blocks.some(
          (block) => block.kind === 'text' && block.text === 'answer',
        ),
    )!
    const nextAnswer = after.find(
      (node) =>
        node.kind === 'assistant-step' &&
        (node as ChatNode<'assistant-step'>).data.blocks.some(
          (block) => block.kind === 'text' && block.text === 'answer',
        ),
    )!
    expect(nextAnswer.anchorSeq).not.toBe(priorAnswer.anchorSeq)
    expect(nextAnswer).not.toBe(priorAnswer)
  })

  it('keeps a shared prompt-window journal at its single marker when assistant-step ownership is ambiguous', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const location = {
      kind: 'step',
      turn: { turn: 1 },
      step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
    }
    const first = {
      key: 'first',
      id: 'first',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location,
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'first message' }] },
    } as unknown as ChatConversationViewNode
    const second = {
      ...first,
      key: 'second',
      id: 'second',
      anchorSeq: 11,
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'second message' }] },
    } as ChatConversationViewNode
    const marker = { ...first, key: 'marker', kind: 'acp-activity', data } as ChatConversationViewNode
    const process = {
      ...first,
      key: 'process',
      kind: 'turn-process',
      data: { turn: 1, answerStep: 1, inlineReasoning: true, toolCallCount: 2 },
    } as ChatConversationViewNode
    const result = normalizeAcpChatNodes(
      [process, first, second, marker],
      new Map([
        [
          activityWindowKey(data),
          {
            rows: [
              {
                activityId: 'tool:one',
                kind: 'tool',
                status: 'completed',
                contentIndex: 0,
                rawDetail: JSON.stringify({ toolName: 'bash', rawInput: { command: 'true' } }),
              } as AcpActivityView,
            ],
            unavailable: false,
          },
        ],
      ]),
    )
    expect(result.filter((node) => node.kind === 'acp-activity')).toHaveLength(1)
    expect(
      result
        .filter((node) => node.kind === 'assistant-step')
        .map((node) => (node.data as { blocks: { text: string }[] }).blocks[0]!.text),
    ).toEqual(['first message', 'second message'])
    expect(result.filter((node) => node.kind === 'tool-call')).toHaveLength(0)
    expect(result.find((node) => node.kind === 'turn-process')!.data).toMatchObject({ toolCallCount: 2 })
  })

  it('creates one native builder and only upserts changed normalized nodes across stream deltas', () => {
    let creates = 0
    let replaces = 0
    let applies = 0
    const empty = {
      nodes: { values: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
    } as unknown as ChatSnapshot
    const makeSnapshot = (nodes: readonly ChatConversationViewNode[]) =>
      ({
        nodes: { values: () => nodes },
        timeline: empty.timeline,
      }) as ChatSnapshot
    const view = {
      target: 'chat',
      create: () => {
        creates++
        return {
          empty,
          replace: ({ nodes }: { nodes: readonly ChatConversationViewNode[] }) => {
            replaces++
            return makeSnapshot(nodes)
          },
          apply: ({ upserts }: { upserts: readonly ChatConversationViewNode[] }) => {
            applies++
            return makeSnapshot(upserts)
          },
          publish: () => {},
        }
      },
    } as unknown as ConversationViewDefinition
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const location = {
      kind: 'step',
      turn: { turn: 1 },
      step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
    }
    const locations = new Map<string, typeof location>()
    const locationFor = (activity: typeof data) => {
      const key = activity.promptAnchorMessageId
      let value = locations.get(key)
      if (value === undefined) {
        value = {
          ...location,
          step: { data: { get: (name: string) => (name === 'acp-activity' ? activity : undefined) } },
        }
        locations.set(key, value)
      }
      return value
    }
    const assistant = (answer: string, key = 'answer', activity = data) =>
      ({
        key,
        id: key,
        kind: 'assistant-step',
        target: 'chat',
        visibility: 'visible',
        anchorSeq: key === 'answer' ? 10 : 8,
        location: locationFor(activity),
        data: {
          status: 'running',
          turn: 1,
          step: 1,
          blocks: [
            { kind: 'reasoning', text: 'stable' },
            { kind: 'text', text: answer },
          ],
        },
      }) as unknown as ChatConversationViewNode
    const process = {
      key: 'process',
      id: 'process',
      kind: 'turn-process',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 11,
      location: { kind: 'session' },
      data: { turn: 1, answerStep: 1, toolCallCount: 0, answerAnchorSeq: 10, inlineReasoning: true },
    } as unknown as ChatConversationViewNode
    const windows = new Map([
      [
        activityWindowKey(data),
        {
          rows: [
            {
              activityId: 'tool:one',
              kind: 'tool',
              status: 'completed',
              contentIndex: 1,
              rawDetail: JSON.stringify({ toolName: 'bash', rawInput: { command: 'true' } }),
            } as AcpActivityView,
          ],
          unavailable: false,
        },
      ],
    ])
    const projection = createChatProjection(view, undefined)
    const historicData = { ...data, promptAnchorMessageId: 'historic-prompt' }
    const projectionWindows = new Map([...windows, [activityWindowKey(historicData), { rows: [], unavailable: false }]])
    const historicNode = assistant('old answer', 'historic-answer', historicData)
    const first = stageChatProjection(
      projection,
      makeSnapshot([historicNode, assistant('answer 1'), process]),
      projectionWindows,
    )
    commitChatProjection(projection, first)
    const second = stageChatProjection(
      projection,
      makeSnapshot([historicNode, assistant('answer 2'), process]),
      projectionWindows,
    )
    const previous = projection.nodes
    expect(second.nodes.find((node) => node.key === 'historic-answer')).toBe(previous.get('historic-answer'))
    expect(second.nodes.find((node) => node.key === 'answer')).not.toBe(previous.get('answer'))
    expect(second.nodes.find((node) => node.key === 'process')).toBe(previous.get('process'))
    expect(second.upserts.map((node) => node.key)).toEqual(['answer'])
    commitChatProjection(projection, second)
    const sameValueDifferentSource = assistant('answer 2')
    const cacheRefresh = stageChatProjection(
      projection,
      makeSnapshot([historicNode, sameValueDifferentSource, process]),
      projectionWindows,
    )
    expect(cacheRefresh.changed).toBe(false)
    commitChatProjection(projection, cacheRefresh)
    expect(projection.normalizationCache.get('answer')?.source).toBe(sameValueDifferentSource)
    const insertedWindow = new Map([
      ...projectionWindows,
      [
        activityWindowKey(data),
        {
          rows: [
            {
              activityId: 'tool:inserted',
              kind: 'tool',
              status: 'completed',
              contentIndex: 0,
              rawDetail: JSON.stringify({ toolName: 'bash' }),
            } as AcpActivityView,
            {
              activityId: 'tool:one',
              kind: 'tool',
              status: 'completed',
              contentIndex: 1,
              rawDetail: JSON.stringify({ toolName: 'bash' }),
            } as AcpActivityView,
          ],
          unavailable: false,
        },
      ],
    ] as const)
    const third = stageChatProjection(
      projection,
      makeSnapshot([historicNode, sameValueDifferentSource, process]),
      insertedWindow,
    )
    expect(third.replace).toBe(false)
    expect(
      third.nodes.findIndex(
        (node) =>
          node.kind === 'tool-call' &&
          (node.data as { acpActivity?: { activityId: string } }).acpActivity?.activityId === 'tool:inserted',
      ),
    ).toBeLessThan(third.nodes.findIndex((node) => node.key === 'answer'))
    expect(third.nodes.find((node) => node.key === 'answer')!.anchorSeq).not.toBe(
      second.nodes.find((node) => node.key === 'answer')!.anchorSeq,
    )
    commitChatProjection(projection, third)
    expect(creates).toBe(1)
    expect(replaces).toBe(1)
    expect(applies).toBe(2)
  })
  it('publishes sidecar-only grouping changes through the persistent group source', () => {
    const empty = {
      nodes: { values: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
    } as unknown as ChatSnapshot
    let builtNodes: readonly ChatConversationViewNode[] = []
    let latestInput: { kind: string } | undefined
    const makeSnapshot = (nodes: readonly ChatConversationViewNode[]) =>
      ({
        nodes: { values: () => nodes, get: (key: string) => nodes.find((node) => node.key === key) },
        timeline: empty.timeline,
      }) as ChatSnapshot
    const view = {
      target: 'chat',
      create: () => ({
        empty,
        replace: ({ nodes }: { nodes: readonly ChatConversationViewNode[] }) => {
          builtNodes = nodes
          latestInput = { kind: 'replace' }
          return makeSnapshot(nodes)
        },
        apply: ({ upserts }: { upserts: readonly ChatConversationViewNode[] }) => {
          const next = new Map(builtNodes.map((node) => [node.key, node]))
          for (const node of upserts) next.set(node.key, node)
          builtNodes = [...next.values()]
          latestInput = { kind: 'apply' }
          return makeSnapshot(builtNodes)
        },
        groupInput: () => latestInput,
        publish: () => {},
      }),
    } as unknown as ConversationViewDefinition
    const group = {
      create: () => ({ changed: false }),
      update: (context: { state: { changed: boolean } }, input: { kind: string }) => {
        latestInput = input
        context.state.changed = true
        return context.state
      },
      buildGroups: ({ state }: { state: { changed: boolean } }) => {
        if (!state.changed) return null
        state.changed = false
        const key = 'activity-group'
        const snapshot = { key, data: {}, members: [] }
        return latestInput?.kind === 'replace'
          ? { entries: [{ kind: 'group', key }], groups: { kind: 'replace', snapshots: [snapshot] } }
          : { entries: [{ kind: 'group', key }], groups: { kind: 'apply', upserts: [snapshot], removes: [] } }
      },
    } as unknown as ConversationGroupDefinition
    const projection = createChatProjection(view, group)
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const assistant = {
      key: 'answer',
      id: 'answer',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location: {
        kind: 'step',
        turn: { turn: 1 },
        step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
      },
      data: { status: 'running', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'answer' }] },
    } as unknown as ChatConversationViewNode
    const snapshot = (nodes: readonly ChatConversationViewNode[]) =>
      ({ nodes: { values: () => nodes }, timeline: empty.timeline }) as ChatSnapshot
    const unavailable = new Map([[activityWindowKey(data), { rows: [], unavailable: true }]])
    commitChatProjection(projection, stageChatProjection(projection, snapshot([assistant]), unavailable))
    const before = projection.groupedView.entries
    const ready = new Map([
      [
        activityWindowKey(data),
        {
          rows: [
            {
              activityId: 'tool:ready',
              kind: 'tool',
              status: 'completed',
              contentIndex: 0,
              rawDetail: JSON.stringify({ toolName: 'bash' }),
            } as AcpActivityView,
          ],
          unavailable: false,
        },
      ],
    ])
    commitChatProjection(projection, stageChatProjection(projection, snapshot([assistant]), ready))
    expect(projection.groupedView.entries).not.toBe(before)
    expect(projection.groupedView.entries).toEqual([{ kind: 'group', key: 'activity-group' }])
    expect(projection.groupRevision.getSnapshot()).toBe(2)
  })
  it('preserves a later native answer while adding ACP tool counts to the same Turn', () => {
    const data = {
      ownerDshSessionId: 'owner',
      promptAnchorMessageId: 'prompt',
      profileId: 'profile',
      agentSessionId: 'agent',
      committedActivitySeq: 1,
    }
    const location = {
      kind: 'step',
      turn: { turn: 1 },
      step: { data: { get: (key: string) => (key === 'acp-activity' ? data : undefined) } },
    }
    const assistant = {
      key: 'acp',
      id: 'acp',
      kind: 'assistant-step',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 10,
      location,
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'ACP result' }] },
    } as unknown as ChatConversationViewNode
    const process = {
      ...assistant,
      key: 'process',
      kind: 'turn-process',
      data: {
        turn: 1,
        answerStep: 2,
        answerAnchorSeq: 20,
        inlineReasoning: true,
        toolCallCount: 2,
      },
    } as ChatConversationViewNode
    const row = {
      activityId: 'call',
      activitySeq: 1,
      kind: 'tool',
      presentation: 'list_agents',
      status: 'completed',
      contentIndex: 0,
    } as AcpActivityView
    const result = normalizeAcpChatNodes(
      [process, assistant],
      new Map([[activityWindowKey(data as never), { rows: [row], unavailable: false }]]),
    )
    expect(result[0]!.data).toEqual({
      turn: 1,
      answerStep: 2,
      answerAnchorSeq: 20,
      inlineReasoning: true,
      toolCallCount: 3,
    })
  })
})
