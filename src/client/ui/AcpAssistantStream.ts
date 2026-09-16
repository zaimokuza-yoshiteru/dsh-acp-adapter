import { createElement as h, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { AcpActivityContent, ActivityRow } from './AcpActivityNode.ts'
import type { ActivityNodeProps, AcpActivityNodeData } from './AcpActivityNode.ts'
import type { AcpActivityView } from '../data/acp-remote.ts'
import css from './AcpActivityNode.module.css'

type NativeProps = ChatNodeViewProps<'assistant-step'>
type Dependencies = Pick<ActivityNodeProps, 'journalHub' | 't' | 'onProjectedChild' | 'onOpenProjectedChild' | 'jsonStringWrapping'>
const EMPTY = { subscribe: () => () => {}, getSnapshot: (): AcpActivityNodeData | undefined => undefined }

/** Keep each activity at its first content boundary, irrespective of later patches. */
export function activityBoundaries(rows: readonly AcpActivityView[], count: number, settled = false): Map<number, AcpActivityView[]> {
  const boundaries = new Map<number, AcpActivityView[]>()
  for (const row of rows) {
    if (row.contentIndex === undefined || (!settled && row.contentIndex > count)) continue
    // A cancelled native partial can end before the last queued ACP content.
    const index = Math.min(row.contentIndex, count)
    const group = boundaries.get(index) ?? []
    group.push(row)
    boundaries.set(index, group)
  }
  return boundaries
}

/** Compose the registered native renderer, without copying Markdown/reasoning/image UI. */
function useOrderedAssistant(props: NativeProps, Native: ComponentType<NativeProps>, dependencies: Dependencies): ReactNode {
  const location = props.node.location
  const settledSource = location.kind === 'step' ? location.step.data.source('acp-activity') : EMPTY
  const liveSource = location.kind === 'step' ? location.step.data.source('acp-activity-live') : EMPTY
  const settled = useSyncExternalStore(settledSource.subscribe, settledSource.getSnapshot)
  const live = useSyncExternalStore(liveSource.subscribe, liveSource.getSnapshot)
  const data = settled ?? live
  if (data === undefined) return h(Native, props)
  return h(AcpActivityContent, {
    ...dependencies,
    sessionId: props.sessionId,
    openFile: props.openFile,
    node: { ...props.node, kind: 'acp-activity', data },
    renderRows: rows => {
      const blocks = props.node.data.blocks
      const boundaries = activityBoundaries(rows, blocks.length, props.node.data.status !== 'running')
      if (boundaries.size === 0) return h('div', { className: css.assistantFlow }, h(Native, { ...props, key: 'content:0' }))
      const output: ReactNode[] = []
      let start = 0
      for (const index of [...boundaries.keys()].sort((a, b) => a - b)) {
        if (index > start) output.push(h(Native, {
          ...props, key: `content:${start}`,
          node: { ...props.node, data: { ...props.node.data, blocks: blocks.slice(start, index), status: 'settled' } },
        }))
        output.push(h('div', { key: `activities:${index}`, className: css.inlineActivities, 'data-acp-activity': true },
          ...boundaries.get(index)!.map(row => h(ActivityRow, {
            ...dependencies, key: row.activityId, row, openFile: props.openFile,
          })),
        ))
        start = index
      }
      if (start < blocks.length || props.node.data.status === 'interrupted') output.push(h(Native, {
        ...props, key: `content:${start}`, node: { ...props.node, data: { ...props.node.data, blocks: blocks.slice(start) } },
      }))
      return h('div', { className: css.assistantFlow }, ...output)
    },
  })
}

/** A keyed wrapper delegates every unowned/legacy message to the existing renderer. */
export function installAcpAssistantStream(ctx: Context, dependencies: Dependencies): () => boolean {
  let installed = false
  let wrapper: ComponentType<NativeProps> | undefined
  ctx.slots.inject('conversation.chat.node', () => {
    const install = (): void => {
      if (installed) return
      const native = ctx.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'assistant-step')
      // Do not bypass a renderer's private dependency injection or child slots.
      if (native === undefined || native.inject !== undefined || native.children !== undefined || native.locale !== 'chat'
        || (native.options.priority ?? 0) !== 0) return
      const Native = native.component as ComponentType<NativeProps>
      installed = true
      wrapper = (props: NativeProps) => useOrderedAssistant(props, Native, dependencies)
      ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat', priority: -1 }, wrapper)
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', install)
    install()
    return () => { unsubscribe(); installed = false }
  })
  return () => installed && ctx.slots.entriesOfSlot('conversation.chat.node').some(entry => entry.options.key === 'assistant-step' && entry.component === wrapper)
}
