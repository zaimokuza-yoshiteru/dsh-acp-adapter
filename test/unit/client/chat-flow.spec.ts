import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpActivityView } from '../../../src/client/data/acp-remote.ts'
import {
  commitChatProjection,
  createChatProjection,
  installAcpAssistantStream,
  stageChatProjection,
  type ChatProjection,
} from '../../../src/client/ui/AcpAssistantStream.ts'
import { activityWindowKey } from '../../../src/client/ui/acp-chat-normalization.ts'

type Props = Record<string, any>
type Element = { type: any; props: Props }
const observable = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })

function snapshot(nodes: readonly ChatConversationViewNode[]): ChatSnapshot {
  return {
    nodes: {
      values: () => nodes,
      get: (key: string) => nodes.find((node) => node.key === key),
      source: (key: string) => observable(nodes.find((node) => node.key === key)),
      bottomSource: (key: string) => observable(nodes.some((node) => node.key === key)),
      processSource: (key: string) =>
        observable(nodes.some((node) => node.key === key) ? { turn: 1, answerStep: 1 } : undefined),
    },
    order: nodes.map((node) => node.key),
    timeline: { turnOrder: [], turns: new Map() },
    navigation: { items: () => [] },
  } as unknown as ChatSnapshot
}

function fixture(label = 'answer') {
  const data = {
    ownerDshSessionId: 'owner',
    promptAnchorMessageId: 'prompt',
    profileId: 'codex',
    agentSessionId: 'remote',
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
        { kind: 'text', text: 'progress' },
        { kind: 'text', text: label },
      ],
    },
  } as unknown as ChatConversationViewNode
  const native = snapshot([assistant])
  const view = {
    target: 'chat',
    create: () => ({
      empty: snapshot([]),
      replace: ({ nodes }: { nodes: readonly ChatConversationViewNode[] }) => snapshot(nodes),
      apply: ({ upserts }: { upserts: readonly ChatConversationViewNode[] }) => snapshot(upserts),
      publish() {},
    }),
  } as unknown as ConversationViewDefinition
  const projection = createChatProjection(view, undefined)
  const windows = new Map([
    [
      activityWindowKey(data),
      {
        unavailable: false,
        rows: [
          {
            activityId: 'tool:one',
            kind: 'tool',
            status: 'completed',
            contentIndex: 1,
            rawDetail: JSON.stringify({ toolName: 'bash', rawInput: { command: 'true' } }),
          } as AcpActivityView,
        ],
      },
    ],
  ])
  commitChatProjection(projection, stageChatProjection(projection, native, windows))
  const tool = projection.chatSource
    .getSnapshot()
    .nodes.values()
    .find((node) => node.kind === 'tool-call')!
  return { native, view, projection, tool }
}

function dataHooks(chat: ChatSnapshot): Props {
  const conversation = { views: { get: () => chat, grouped: () => undefined } }
  return {
    useChat: (select: (value: ChatSnapshot) => unknown) => select(chat),
    useConversation: (select: (value: unknown) => unknown) => select(conversation),
    useChatNode: (key: string, select?: (value: unknown) => unknown) => {
      const node = chat.nodes.get(key)
      return select === undefined ? node : select(node)
    },
    useChatNodeBottom: (key: string) => chat.nodes.bottomSource(key).getSnapshot(),
    useChatNodeProcess: (key: string, select?: (value: unknown) => unknown) => {
      const value = chat.nodes.processSource(key).getSnapshot()
      return select === undefined ? value : select(value)
    },
    useChatGroup: (_key: string, select?: (value: unknown) => unknown) => select?.(undefined),
  }
}

/** Walk only the React element/context seam; browser E2E owns effects and DOM geometry. */
function readTree(element: Element): any {
  if (typeof element.type === 'function') return readTree(element.type(element.props))
  if (element.type?.$$typeof === Symbol.for('react.provider')) {
    const context = element.type._context
    const previous = context._currentValue
    context._currentValue = element.props.value
    try {
      return readTree(element.props.children)
    } finally {
      context._currentValue = previous
    }
  }
  return element.props.observed
}

function harness(native: ChatSnapshot, view: ConversationViewDefinition, selectedKey: string) {
  const slots = new SlotCore()
  const releases: Array<() => void> = []
  releases.push(
    slots.register(
      {
        name: 'root',
        children: {
          'conversation.view': { kind: 'list', scope: 'session' },
          'conversation.session.header': { kind: 'single', scope: 'session' },
        },
      } as never,
      (() => null) as never,
    ),
  )
  const viewport = { useGroupAction: () => ({ current: null }), useGroupHeaderAction: () => {} }
  const flowContext = { motion: { viewport: 'native' } }
  let flowInjections = 0
  let seenContext: unknown
  const flowInject = () => {
    flowInjections++
    return dataHooks(native)
  }
  const NativeFlow = (props: Props) =>
    h('flow-probe', {
      observed: {
        nodes: props.useChat((chat: ChatSnapshot) => chat.nodes.values()),
        selected: props.useChatNode(selectedKey),
        selectedText: props.useChatNode(selectedKey, (node: ChatConversationViewNode | undefined) => node?.kind),
        bottom: props.useChatNodeBottom(selectedKey),
        process: props.useChatNodeProcess(selectedKey),
        useGroupAction: props.useGroupAction,
        useGroupHeaderAction: props.useGroupHeaderAction,
        entries: props.entries,
        children: props.childSlots,
      },
    })
  const NativeChat = (props: Props) =>
    props.renderSlot(
      'conversation.chat.flow',
      {
        entries: props.useChat((chat: ChatSnapshot) => chat.order).map((key: string) => ({ kind: 'node', key })),
      },
      { hookContext: flowContext },
    )
  releases.push(
    slots.register(
      {
        name: 'conversation.view',
        id: 'chat',
        children: {
          'conversation.chat.flow': { kind: 'single', scope: 'session' },
        },
      } as never,
      NativeChat as never,
    ),
  )
  releases.push(
    slots.register(
      {
        name: 'conversation.chat.flow',
        inject: flowInject,
        children: {
          'conversation.chat.node': { kind: 'keyed', scope: 'session' },
          'conversation.message.images': { kind: 'single', scope: 'session' },
        },
      } as never,
      NativeFlow as never,
    ),
  )
  releases.push(slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, (() => null) as never))
  const ctx = {
    uiConversation: { views: { entries: () => [view] }, groups: { forTarget: () => undefined } },
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
  }
  installAcpAssistantStream(ctx as never, {} as never)
  const invoke = (entry: StoredEntry, owner: Props = {}): Element => {
    const inject = entry.inject as (() => Props) | undefined
    return h(entry.component as any, {
      sessionId: 'same-session',
      ...owner,
      ...inject?.(),
      ...viewport,
      renderSlot: (name: string, props: Props, options?: Props) => {
        seenContext = options?.hookContext
        return invoke(slots.entriesOfSlot(name as never)[0]!, props)
      },
      childSlots: Object.keys(entry.children ?? {}),
    }) as unknown as Element
  }
  const chat = (): Element => {
    const entry = slots.entriesOfSlot('conversation.view')[0]!
    const wrapper = invoke(entry, dataHooks(native))
    // Enter the mounted wrapper and NormalizedChat, stopping before its Provider.
    const normalized = wrapper.type(wrapper.props) as Element
    return normalized.type(normalized.props) as Element
  }
  return {
    slots,
    chat,
    standaloneFlow: () => readTree(invoke(slots.entriesOfSlot('conversation.chat.flow')[0]!)),
    flowInject,
    flowContext,
    seenContext: () => seenContext,
    flowInjections: () => flowInjections,
    viewport,
    dispose: () => releases.reverse().forEach((release) => release()),
  }
}

function commitToView(provider: Element, projection: ChatProjection | undefined) {
  // Effects are intentionally inert in element-tree tests. Publish the same
  // per-view ref that NormalizedChat commits in its layout effect.
  provider.props.value.projectionRef.current = projection
}

describe('alpha.2 independently injected native Chat flow', () => {
  it('reads synthetic ACP nodes from the view projection and retains native viewport hooks and child slots', async () => {
    const { native, view, projection, tool } = fixture()
    const app = harness(native, view, tool.key)
    await Promise.resolve()
    try {
      expect(native.nodes.get(tool.key)).toBeUndefined()
      const outside = app.standaloneFlow()
      expect(outside.selected).toBeUndefined()
      expect(outside.bottom).toBe(false)
      const provider = app.chat()
      commitToView(provider, projection)
      const result = readTree(provider)
      expect(result.nodes).toEqual(projection.chatSource.getSnapshot().nodes.values())
      expect(result.selected).toBe(tool)
      expect(result.selectedText).toBe('tool-call')
      expect(result.bottom).toBe(true)
      expect(result.process).toEqual({ turn: 1, answerStep: 1 })
      expect(result.entries.map((entry: Props) => entry.key)).toContain(tool.key)
      expect(result.useGroupAction).toBe(app.viewport.useGroupAction)
      expect(result.useGroupHeaderAction).toBe(app.viewport.useGroupHeaderAction)
      expect(app.seenContext()).toBe(app.flowContext)
      expect(app.flowInjections()).toBeGreaterThan(1)
      const flow = app.slots.entriesOfSlot('conversation.chat.flow')[0]!
      expect(flow.inject).toBe(app.flowInject)
      expect(result.children).toHaveLength(2)
      const nodeSlot = result.children.find((name: string) => name.endsWith('conversation.chat.node'))!
      expect(app.slots.entriesOfSlot(nodeSlot).map((entry) => entry.options.key)).toContain('tool-call')
      // A subsequent native viewport must not inherit the previous Provider.
      expect(app.standaloneFlow().selected).toBeUndefined()
    } finally {
      app.dispose()
    }
  })

  it('isolates two Chat views of one Session and delegates ordinary or detached views to their native sources', async () => {
    const first = fixture('first answer')
    const second = fixture('second answer')
    const app = harness(first.native, first.view, 'answer')
    await Promise.resolve()
    try {
      const left = app.chat(),
        right = app.chat()
      expect(left.props.value).not.toBe(right.props.value)
      commitToView(left, first.projection)
      commitToView(right, second.projection)
      const text = (result: Props) => result.selected.data.blocks.map((block: Props) => block.text).join(' ')
      expect(text(readTree(left))).toBe('first answer')
      expect(text(readTree(right))).toBe('second answer')
      expect(text(readTree(left))).toBe('first answer')
      commitToView(left, undefined)
      const ordinary = readTree(left)
      expect(ordinary.selected).toBe(first.native.nodes.get('answer'))
      expect(ordinary.nodes).toEqual(first.native.nodes.values())
      expect(ordinary.useGroupAction).toBe(app.viewport.useGroupAction)
    } finally {
      app.dispose()
    }
  })
})
