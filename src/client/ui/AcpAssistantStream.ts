import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatSnapshot, ChatViewSlotProps, ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationGroupDefinition, ConversationViewDefinition, ConversationGroupData, GroupSnapshot, GroupKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ActivityRow, completedProjectedChild, visibleActivityRows, activityJournalSessionId, renderNativeActivityTool } from './AcpActivityNode.ts'
import type { ActivityNodeProps, ActivityPresentationRow } from './AcpActivityNode.ts'
import { mountNativeEntry, type EntryProps } from './native-tool-renderer.ts'
import { activityData, activityWindowKey, normalizeAcpChatNodes, type ActivityWindow } from './acp-chat-normalization.ts'
export { activityBoundaries, finalAnswerStart } from './acp-chat-normalization.ts'

type Dependencies = Pick<ActivityNodeProps, 'journalHub' | 't' | 'onProjectedChild' | 'onOpenProjectedChild' | 'jsonStringWrapping'>
type NativeChatProps = ChatViewSlotProps & PropsRenderFactories

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'acp-inline-activity': ActivityPresentationRow }
}

/** The registry owns the algorithms. This adapter only feeds them normalized inputs. */
export function buildAcpChatView(view: ConversationViewDefinition, group: ConversationGroupDefinition | undefined,
  original: ChatSnapshot, windows: ReadonlyMap<string, ActivityWindow>) {
  const builder = (view as ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot>).create()
  const chat = builder.replace({ nodes: normalizeAcpChatNodes(original.nodes.values(), windows), timeline: original.timeline })
  const input = builder.groupInput?.()
  const state = group !== undefined && input !== undefined ? group.update({ state: group.create() }, input) : undefined
  const update = state === undefined ? undefined : group?.buildGroups({ state })
  const snapshots = new Map<GroupKey, GroupSnapshot<ConversationGroupData<'chat'>>>()
  if (update !== undefined && update !== null) {
    for (const snapshot of update.groups.kind === 'replace' ? update.groups.snapshots : update.groups.upserts) {
      snapshots.set(snapshot.key, snapshot as GroupSnapshot<ConversationGroupData<'chat'>>)
    }
  }
  const grouped = update?.entries === undefined ? undefined : {
    entries: update.entries,
    groupSource: (key: GroupKey) => ({ getSnapshot: () => snapshots.get(key), subscribe: () => () => {} }),
  }
  return { chat, grouped, snapshots }
}

function NormalizedChat({ Native, props, ctx, dependencies }: {
  Native: ComponentType<EntryProps>; props: NativeChatProps; ctx: Context; dependencies: Dependencies
}): ReactNode {
  const original = props.useChat(value => value)
  const conversation = props.useConversation(value => value)
  const [windows, setWindows] = useState<ReadonlyMap<string, ActivityWindow>>(new Map())
  const anchors = new Map(original.nodes.values().flatMap(node => {
    const data = activityData(node)
    return data === undefined ? [] : [[activityWindowKey(data), data] as const]
  }))
  const signature = JSON.stringify([...anchors].map(([key, data]) => [key, data.ownerDshSessionId, data.promptAnchorMessageId]))
  useEffect(() => {
    let disposed = false
    const releases = [...anchors].map(([key, data]) => {
      const owner = activityJournalSessionId(data, props.sessionId)
      const publish = (): void => {
        if (disposed) return
        const rows = handle.snapshot()
        setWindows(current => new Map(current).set(key, { rows: visibleActivityRows(rows), unavailable: handle.error() !== undefined }))
        for (const row of rows) {
          const child = completedProjectedChild(row)
          if (child !== undefined) dependencies.onProjectedChild?.(child.parentSessionId, child.childSessionId)
        }
      }
      const handle = dependencies.journalHub.acquire(owner, owner, data.promptAnchorMessageId, publish)
      publish()
      return handle.release
    })
    return () => { disposed = true; releases.forEach(release => release()) }
  }, [signature, props.sessionId, dependencies])
  const view = ctx.uiConversation.views.entries().find(value => value.target === 'chat')
  const group = ctx.uiConversation.groups.forTarget('chat')
  const normalized = useMemo(() => view === undefined ? undefined
    : buildAcpChatView(view, group, original, windows), [view, group, original, conversation, windows, signature])
  if (normalized === undefined) return h(Native, { ...props, key: 'unavailable' } as unknown as EntryProps)
  const { chat, grouped, snapshots } = normalized
  // Hooks are selector-compatible pure readers here. Their owning Chat wrapper
  // subscribes to the native snapshot and sidecar and republishes them together.
  const normalizedConversation = { ...conversation, views: { ...conversation.views,
    get: (target: string) => target === 'chat' ? chat : conversation.views.get(target as 'chat'),
    grouped: (target: string) => target === 'chat' ? grouped : conversation.views.grouped(target),
  } }
  return h(Native, { ...props,
    useChat: (selector: (snapshot: ChatSnapshot) => unknown) => selector(chat),
    useConversation: (selector: (snapshot: typeof normalizedConversation) => unknown) => selector(normalizedConversation),
    useChatNode: (key: string, selector?: (node: ChatConversationViewNode | undefined) => unknown) => selector === undefined ? chat.nodes.get(key) : selector(chat.nodes.get(key)),
    useChatNodeProcess: (key: string, selector?: (value: unknown) => unknown) => {
      const value = chat.nodes.processSource(key).getSnapshot()
      return selector === undefined ? value : selector(value)
    },
    useChatGroup: (key: string, selector?: (value: unknown) => unknown) => {
      const value = snapshots.get(key as GroupKey)
      return selector === undefined ? value : selector(value)
    },
  } as unknown as EntryProps)
}

/** Shadow a native entry through the public slot API, preserving its full tree. */
function composeSlot(ctx: Context, name: string, select: (entry: StoredEntry) => boolean,
  wrap: (Native: ComponentType<EntryProps>, props: EntryProps) => ReactNode): void {
  ctx.slots.inject(name as never, () => {
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = (): void => {
      const next = ctx.slots.entries(name as never).find(entry => entry.registrant !== 'acp-chat-normalization' && select(entry))
      if (next === current) return
      const oldRelease = release
      release = undefined
      current = next
      oldRelease?.()
      if (next !== undefined) release = mountNativeEntry(ctx, next, name, {
        registration: { priority: (next.options.priority ?? 0) - 1, registrant: 'acp-chat-normalization' }, wrap,
      })
    }
    const unsubscribe = ctx.slots.subscribe(name as never, sync)
    sync()
    return () => { unsubscribe(); release?.() }
  })
}

/** Native 0.1.7 lists raw registrations for tabs, whereas rendering selects winners by id. */
export function uniqueViewTabs<T extends { id: string }>(tabs: readonly T[]): readonly T[] {
  const unique = tabs.filter((tab, index) => tabs.findIndex(value => value.id === tab.id) === index)
  return unique.length === tabs.length ? tabs : unique
}

export function installAcpAssistantStream(ctx: Context, dependencies: Dependencies): void {
  composeSlot(ctx, 'conversation.view', entry => entry.options.id === 'chat', (Native, props) =>
    h(NormalizedChat, { Native, props: props as unknown as NativeChatProps, ctx, dependencies }))
  composeSlot(ctx, 'conversation.session.header', () => true, (Native, props) => {
    const useViews = props.useConversationViews as (selector: (tabs: readonly { id: string }[]) => unknown, equal?: (left: unknown, right: unknown) => boolean) => unknown
    return h(Native, { ...props, useConversationViews: (selector: (tabs: readonly { id: string }[]) => unknown, equal?: (left: unknown, right: unknown) => boolean) =>
      useViews(tabs => selector(uniqueViewTabs(tabs)), equal) })
  })
  // Native tool nodes still use the native Tool tree. Only their sidecar detail
  // loader/inspector and external-child navigation belong to ACP.
  composeSlot(ctx, 'conversation.chat.node', entry => entry.options.key === 'tool-call', (Native, props) => {
    const owner = props as unknown as ChatNodeViewProps<'tool-call'> & PropsRenderFactories
    const row = (owner.node.data as { acpActivity?: ActivityPresentationRow }).acpActivity
    return row === undefined ? h(Native, props) : h(ActivityRow, { ...dependencies, row, openFile: owner.openFile,
      renderTool: full => renderNativeActivityTool(owner, full, dependencies.t) })
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'acp-inline-activity', locale: 'acpActivity',
  }, (props: Omit<ChatNodeViewProps<'acp-inline-activity'>, 't'>) => h(ActivityRow, { ...dependencies, row: props.node.data, openFile: props.openFile })))
  // Standalone ACP markers remain the fallback for unavailable journals or turns
  // with no assistant message. They must not suppress their own activity rows.
}
