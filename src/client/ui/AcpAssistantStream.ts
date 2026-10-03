import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatSnapshot,
  ChatViewSlotProps,
  ChatNodeViewProps,
  ChatConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationGroupDefinition,
  ConversationViewDefinition,
  ConversationGroupData,
  GroupSnapshot,
  GroupKey,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ActivityRow,
  completedProjectedChild,
  visibleActivityRows,
  activityJournalSessionId,
  renderNativeActivityTool,
} from './AcpActivityNode.ts'
import type { ActivityNodeProps, ActivityPresentationRow } from './AcpActivityNode.ts'
import { mountNativeEntry, type EntryProps } from './native-tool-renderer.ts'
import {
  activityData,
  activityWindowKey,
  normalizeAcpChatNodes,
  type ActivityWindow,
  type AcpNormalizationCacheEntry,
} from './acp-chat-normalization.ts'
export { activityBoundaries, finalAnswerStart } from './acp-chat-normalization.ts'

type Dependencies = Pick<
  ActivityNodeProps,
  'journalHub' | 't' | 'onProjectedChild' | 'onOpenProjectedChild' | 'jsonStringWrapping'
>
type NativeChatProps = ChatViewSlotProps & PropsRenderFactories

class SnapshotSource<T> {
  private value: T
  private listeners = new Set<() => void>()

  constructor(value: T) {
    this.value = value
  }

  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(value: T): boolean {
    if (Object.is(this.value, value)) return false
    this.value = value
    return true
  }

  publish(): void {
    for (const listener of this.listeners) listener()
  }
}

export interface ChatProjection {
  readonly view: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot>
  readonly group: ConversationGroupDefinition | undefined
  readonly builder: ReturnType<ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot>['create']>
  readonly chatSource: SnapshotSource<ChatSnapshot>
  readonly groupRevision: SnapshotSource<number>
  readonly snapshots: Map<GroupKey, GroupSnapshot<ConversationGroupData<'chat'>>>
  readonly groupSources: Map<GroupKey, SnapshotSource<GroupSnapshot<ConversationGroupData<'chat'>> | undefined>>
  groupedView: {
    readonly entries: readonly unknown[]
    groupSource(key: GroupKey): SnapshotSource<GroupSnapshot<ConversationGroupData<'chat'>> | undefined>
  }
  initial: boolean
  groupState: unknown
  groupedEntries: readonly unknown[] | undefined
  nodes: Map<string, ChatConversationViewNode>
  timeline: ChatSnapshot['timeline'] | undefined
  dirtySources: Set<SnapshotSource<unknown>>
  normalizationCache: Map<string, AcpNormalizationCacheEntry>
}

function groupSource(projection: ChatProjection, key: GroupKey) {
  let source = projection.groupSources.get(key)
  if (source === undefined) {
    source = new SnapshotSource(projection.snapshots.get(key))
    projection.groupSources.set(key, source)
  }
  return source
}

const emptyChatSource = new SnapshotSource(null as unknown as ChatSnapshot)
const emptyNodeSource = new SnapshotSource<ChatConversationViewNode | undefined>(undefined)
const emptyProcessSource = new SnapshotSource<unknown>(undefined)
const emptyGroupSource = new SnapshotSource<GroupSnapshot<ConversationGroupData<'chat'>> | undefined>(undefined)
const emptyGroupRevisionSource = new SnapshotSource(0)

export interface ChatProjectionChange {
  readonly nodes: ChatConversationViewNode[]
  readonly upserts: ChatConversationViewNode[]
  readonly replace: boolean
  readonly changed: boolean
  readonly timeline: ChatSnapshot['timeline']
  readonly normalizationCache: Map<string, AcpNormalizationCacheEntry>
}

export function createChatProjection(
  view: ConversationViewDefinition,
  group: ConversationGroupDefinition | undefined,
): ChatProjection {
  const typedView = view as ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot>
  const builder = typedView.create()
  const projection: ChatProjection = {
    view: typedView,
    group,
    builder,
    chatSource: new SnapshotSource(builder.empty),
    groupRevision: new SnapshotSource(0),
    snapshots: new Map(),
    groupSources: new Map(),
    groupedView: undefined as never,
    initial: true,
    groupState: group?.create(),
    groupedEntries: undefined,
    nodes: new Map(),
    timeline: undefined,
    dirtySources: new Set(),
    normalizationCache: new Map(),
  }
  projection.groupedView = {
    get entries() {
      return projection.groupedEntries ?? []
    },
    groupSource: (key) => groupSource(projection, key),
  }
  return projection
}

/** Render-phase work is pure; builder and group mutation happens after commit. */
export function stageChatProjection(
  projection: ChatProjection,
  original: ChatSnapshot,
  windows: ReadonlyMap<string, ActivityWindow>,
  fallbackSessionId?: string,
): ChatProjectionChange {
  const normalizationCache = new Map(projection.normalizationCache)
  const nodes = [
    ...normalizeAcpChatNodes(original.nodes.values(), windows, normalizationCache, projection.nodes, fallbackSessionId),
  ]
  const nextNodes = new Map(nodes.map((node) => [node.key, node]))
  const upserts = nodes.filter((node) => projection.nodes.get(node.key) !== node)
  const removed = [...projection.nodes.keys()].some((key) => !nextNodes.has(key))
  return {
    nodes,
    upserts,
    replace: projection.initial || removed,
    changed: projection.initial || removed || upserts.length > 0 || projection.timeline !== original.timeline,
    timeline: original.timeline,
    normalizationCache,
  }
}

export function commitChatProjection(projection: ChatProjection, change: ChatProjectionChange): void {
  projection.normalizationCache = change.normalizationCache
  if (!change.changed) return
  let chat: ChatSnapshot
  if (change.replace) {
    chat = projection.builder.replace({ nodes: change.nodes, timeline: change.timeline })
  } else if (change.upserts.length > 0 || projection.timeline !== change.timeline) {
    chat = projection.builder.apply({ upserts: change.upserts, timeline: change.timeline })
  } else chat = projection.chatSource.getSnapshot()
  projection.initial = false
  projection.nodes = new Map(change.nodes.map((node) => [node.key, node]))
  projection.timeline = change.timeline
  const dirty = projection.chatSource.set(chat)
  let groupsChanged = false
  const removedSourceKeys: GroupKey[] = []
  const input = projection.builder.groupInput?.()
  const state = projection.groupState
  const updatedState =
    projection.group !== undefined && input !== undefined ? projection.group.update({ state }, input) : state
  if (projection.group !== undefined && input !== undefined) {
    projection.groupState = updatedState
    const update = projection.group.buildGroups({ state: updatedState })
    if (update !== null && update !== undefined) {
      groupsChanged = true
      if (update.groups.kind === 'replace') {
        for (const key of projection.snapshots.keys()) projection.snapshots.delete(key)
        for (const snapshot of update.groups.snapshots)
          projection.snapshots.set(snapshot.key, snapshot as GroupSnapshot<ConversationGroupData<'chat'>>)
      } else {
        for (const key of update.groups.removes) projection.snapshots.delete(key)
        for (const snapshot of update.groups.upserts)
          projection.snapshots.set(snapshot.key, snapshot as GroupSnapshot<ConversationGroupData<'chat'>>)
      }
      if (update.entries !== undefined) projection.groupedEntries = update.entries
      for (const [key, source] of projection.groupSources) {
        if (source.set(projection.snapshots.get(key))) projection.dirtySources.add(source as SnapshotSource<unknown>)
        if (!projection.snapshots.has(key)) removedSourceKeys.push(key)
      }
      for (const key of projection.snapshots.keys()) groupSource(projection, key)
    }
  }
  projection.builder.publish?.()
  if (dirty) projection.chatSource.publish()
  for (const source of projection.dirtySources) source.publish()
  projection.dirtySources.clear()
  for (const key of removedSourceKeys) projection.groupSources.delete(key)
  if (groupsChanged) {
    projection.groupRevision.set(projection.groupRevision.getSnapshot() + 1)
    projection.groupRevision.publish()
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'acp-inline-activity': ActivityPresentationRow
  }
}

function NormalizedChat({
  Native,
  props,
  ctx,
  dependencies,
}: {
  Native: ComponentType<EntryProps>
  props: NativeChatProps
  ctx: Context
  dependencies: Dependencies
}): ReactNode {
  const selectedChat = props.useChat(
    (value) => ({ nodes: value.nodes.values(), timeline: value.timeline }),
    (left, right) => left.nodes === right.nodes && left.timeline === right.timeline,
  )
  const original = useMemo(
    () => ({ nodes: { values: () => selectedChat.nodes }, timeline: selectedChat.timeline }) as ChatSnapshot,
    [selectedChat.nodes, selectedChat.timeline],
  )
  const [windows, setWindows] = useState<ReadonlyMap<string, ActivityWindow>>(new Map())
  const generation = useRef(0)
  const projectionRef = useRef<ChatProjection | undefined>(undefined)
  const projectionModeRef = useRef<SnapshotSource<number> | undefined>(undefined)
  if (projectionModeRef.current === undefined) projectionModeRef.current = new SnapshotSource(0)
  const projectionModeSource = projectionModeRef.current
  const nativePropsRef = useRef(props)
  const anchors = new Map(
    original.nodes.values().flatMap((node) => {
      const data = activityData(node)
      return data === undefined ? [] : [[activityWindowKey(data, props.sessionId), data] as const]
    }),
  )
  const signature = JSON.stringify(
    [...anchors].map(([key, data]) => [key, data.ownerDshSessionId, data.promptAnchorMessageId]),
  )
  useEffect(() => {
    let disposed = false
    const currentGeneration = ++generation.current
    const activeKeys = new Set(anchors.keys())
    setWindows((current) => {
      const next = new Map([...current].filter(([key]) => activeKeys.has(key)))
      return next.size === current.size ? current : next
    })
    const releases = [...anchors].map(([key, data]) => {
      const owner = activityJournalSessionId(data, props.sessionId)
      const publish = (): void => {
        if (disposed || generation.current !== currentGeneration || !activeKeys.has(key)) return
        const rows = handle.snapshot()
        setWindows((current) => {
          const nextWindow = {
            rows: visibleActivityRows(rows),
            unavailable: !handle.ready() || handle.error() !== undefined,
          }
          const previous = current.get(key)
          if (
            previous !== undefined &&
            previous.unavailable === nextWindow.unavailable &&
            previous.rows.length === nextWindow.rows.length &&
            previous.rows.every((row, index) => row === nextWindow.rows[index])
          )
            return current
          const next = new Map([...current].filter(([activeKey]) => activeKeys.has(activeKey)))
          next.set(key, nextWindow)
          return next
        })
        for (const row of rows) {
          const child = completedProjectedChild(row)
          if (child !== undefined) dependencies.onProjectedChild?.(child.parentSessionId, child.childSessionId)
        }
      }
      const handle = dependencies.journalHub.acquire(owner, owner, data.promptAnchorMessageId, publish)
      publish()
      return handle.release
    })
    return () => {
      disposed = true
      releases.forEach((release) => release())
    }
  }, [signature, props.sessionId, dependencies])
  const visibleWindows = useMemo(() => new Map([...windows].filter(([key]) => anchors.has(key))), [windows, signature])
  const view = ctx.uiConversation.views.entries().find((value) => value.target === 'chat')
  const group = ctx.uiConversation.groups.forTarget('chat')
  const hasAcp = anchors.size > 0 && view !== undefined
  const committedProjection = projectionRef.current
  const projection = !hasAcp
    ? undefined
    : committedProjection?.view === view && committedProjection.group === group
      ? committedProjection
      : createChatProjection(view!, group)
  const change = useMemo(
    () =>
      projection === undefined ? undefined : stageChatProjection(projection, original, visibleWindows, props.sessionId),
    [projection, original, visibleWindows, props.sessionId],
  )
  useLayoutEffect(() => {
    nativePropsRef.current = props
    if (projection !== undefined && change !== undefined) commitChatProjection(projection, change)
    if (projectionRef.current !== projection) {
      projectionRef.current = projection
      projectionModeSource.set(projectionModeSource.getSnapshot() + 1)
      projectionModeSource.publish()
    }
  }, [projection, change, props])
  const adapters = useMemo(() => {
    const useChat = (
      selector: (snapshot: ChatSnapshot) => unknown,
      equal?: (left: unknown, right: unknown) => boolean,
    ) => {
      const native = nativePropsRef.current.useChat(
        (snapshot) => selector(projectionRef.current?.chatSource.getSnapshot() ?? snapshot),
        equal,
      )
      useSyncExternalStore(projectionModeSource.subscribe, projectionModeSource.getSnapshot)
      const current = projectionRef.current
      const source = current?.chatSource ?? emptyChatSource
      const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
      return current === undefined ? native : selector(snapshot)
    }
    const useConversation = (
      selector: (snapshot: unknown) => unknown,
      equal?: (left: unknown, right: unknown) => boolean,
    ) => {
      void equal
      const base = nativePropsRef.current.useConversation((snapshot: unknown) => snapshot)
      useSyncExternalStore(projectionModeSource.subscribe, projectionModeSource.getSnapshot)
      const current = projectionRef.current
      const chatSource = current?.chatSource ?? emptyChatSource
      const chatSnapshot = useSyncExternalStore(chatSource.subscribe, chatSource.getSnapshot)
      const groupRevision = current?.groupRevision ?? emptyGroupRevisionSource
      const groupsSnapshot = useSyncExternalStore(groupRevision.subscribe, groupRevision.getSnapshot)
      const conversation = useMemo(() => {
        const active = current
        const conversation = base as {
          readonly views: { get(target: 'chat'): unknown; grouped(target: string): unknown }
        }
        if (active === undefined || base == null) return base
        void chatSnapshot
        void groupsSnapshot
        return {
          ...conversation,
          views: {
            ...conversation.views,
            get: (target: string) =>
              target === 'chat' ? active.chatSource.getSnapshot() : conversation.views.get(target as 'chat'),
            grouped: (target: string) =>
              target === 'chat'
                ? active.group === undefined
                  ? undefined
                  : active.groupedView
                : conversation.views.grouped(target),
          },
        }
      }, [base, current, chatSnapshot, groupsSnapshot])
      return conversation == null ? conversation : selector(conversation)
    }
    const useChatNode = (key: string, selector?: (node: ChatConversationViewNode | undefined) => unknown) => {
      const nativeSelector =
        selector === undefined
          ? undefined
          : (node: ChatConversationViewNode | undefined) => {
              const current = projectionRef.current
              return selector(current === undefined ? node : current.chatSource.getSnapshot().nodes.get(key))
            }
      const native = nativePropsRef.current.useChatNode(key, nativeSelector as never)
      useSyncExternalStore(projectionModeSource.subscribe, projectionModeSource.getSnapshot)
      const current = projectionRef.current
      const source = current?.chatSource.getSnapshot().nodes.source(key) ?? emptyNodeSource
      const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
      return current === undefined ? native : selector === undefined ? value : selector(value)
    }
    const useChatNodeProcess = (key: string, selector?: (value: unknown) => unknown) => {
      const nativeSelector =
        selector === undefined
          ? undefined
          : (value: unknown) => {
              const current = projectionRef.current
              return selector(
                current === undefined ? value : current.chatSource.getSnapshot().nodes.processSource(key).getSnapshot(),
              )
            }
      const native = nativePropsRef.current.useChatNodeProcess(key, nativeSelector as never)
      useSyncExternalStore(projectionModeSource.subscribe, projectionModeSource.getSnapshot)
      const current = projectionRef.current
      const source = current?.chatSource.getSnapshot().nodes.processSource(key) ?? emptyProcessSource
      const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
      return current === undefined ? native : selector === undefined ? value : selector(value)
    }
    const useChatGroup = (key: string, selector?: (value: unknown) => unknown) => {
      const nativeSelector =
        selector === undefined
          ? undefined
          : (value: unknown) => {
              const current = projectionRef.current
              return selector(
                current === undefined ? value : current.groupedView.groupSource(key as GroupKey).getSnapshot(),
              )
            }
      const native = nativePropsRef.current.useChatGroup(key, nativeSelector as never)
      useSyncExternalStore(projectionModeSource.subscribe, projectionModeSource.getSnapshot)
      const source = projectionRef.current?.groupedView.groupSource(key as GroupKey) ?? emptyGroupSource
      const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
      return projectionRef.current === undefined ? native : selector === undefined ? value : selector(value)
    }
    return { useChat, useConversation, useChatNode, useChatNodeProcess, useChatGroup }
  }, [])
  return h(Native, {
    ...props,
    ...adapters,
  } as unknown as EntryProps)
}

/** Shadow a native entry through the public slot API, preserving its full tree. */
function composeSlot(
  ctx: Context,
  name: string,
  select: (entry: StoredEntry) => boolean,
  wrap: (Native: ComponentType<EntryProps>, props: EntryProps) => ReactNode,
): void {
  ctx.slots.inject(name as never, () => {
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = (): void => {
      const next = ctx.slots
        .entries(name as never)
        .find((entry) => entry.registrant !== 'acp-chat-normalization' && select(entry))
      if (next === current) return
      const oldRelease = release
      release = undefined
      current = next
      oldRelease?.()
      if (next !== undefined)
        release = mountNativeEntry(ctx, next, name, {
          registration: { priority: (next.options.priority ?? 0) - 1, registrant: 'acp-chat-normalization' },
          wrap,
        })
    }
    const unsubscribe = ctx.slots.subscribe(name as never, sync)
    sync()
    return () => {
      unsubscribe()
      release?.()
    }
  })
}

/** The conversation shell lists raw view registrations; slot rendering selects winners by id. */
export function uniqueViewTabs<T extends { id: string }>(tabs: readonly T[]): readonly T[] {
  const unique = tabs.filter((tab, index) => tabs.findIndex((value) => value.id === tab.id) === index)
  return unique.length === tabs.length ? tabs : unique
}

export function installAcpAssistantStream(ctx: Context, dependencies: Dependencies): void {
  composeSlot(
    ctx,
    'conversation.view',
    (entry) => entry.options.id === 'chat',
    (Native, props) =>
      h(NormalizedChat, {
        key: (props as unknown as NativeChatProps).sessionId,
        Native,
        props: props as unknown as NativeChatProps,
        ctx,
        dependencies,
      }),
  )
  composeSlot(
    ctx,
    'conversation.session.header',
    () => true,
    (Native, props) => {
      const useViews = props.useConversationViews as (
        selector: (tabs: readonly { id: string }[]) => unknown,
        equal?: (left: unknown, right: unknown) => boolean,
      ) => unknown
      return h(Native, {
        ...props,
        useConversationViews: (
          selector: (tabs: readonly { id: string }[]) => unknown,
          equal?: (left: unknown, right: unknown) => boolean,
        ) => useViews((tabs) => selector(uniqueViewTabs(tabs)), equal),
      })
    },
  )
  // Native tool nodes still use the native Tool tree. Only their sidecar detail
  // loader/inspector and external-child navigation belong to ACP.
  composeSlot(
    ctx,
    'conversation.chat.node',
    (entry) => entry.options.key === 'tool-call',
    (Native, props) => {
      const owner = props as unknown as ChatNodeViewProps<'tool-call'> & PropsRenderFactories
      const row = (owner.node.data as { acpActivity?: ActivityPresentationRow }).acpActivity
      return row === undefined
        ? h(Native, props)
        : h(ActivityRow, {
            ...dependencies,
            row,
            openFile: owner.openFile,
            renderTool: (full) => renderNativeActivityTool(owner, full, dependencies.t),
          })
    },
  )
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'acp-inline-activity',
        locale: 'acpActivity',
      },
      (props: Omit<ChatNodeViewProps<'acp-inline-activity'>, 't'>) =>
        h(ActivityRow, { ...dependencies, row: props.node.data, openFile: props.openFile }),
    ),
  )
  // Standalone ACP markers remain the fallback for unavailable journals or turns
  // with no assistant message. They must not suppress their own activity rows.
}
