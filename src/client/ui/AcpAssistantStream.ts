import { createElement as h, useState, useSyncExternalStore, useRef, useLayoutEffect, useEffect } from 'react'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps, AssistantBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { AcpActivityContent, ActivityRow, renderNativeActivityTool } from './AcpActivityNode.ts'
import type { ActivityNodeProps, AcpActivityNodeData, ActivityPresentationRow } from './AcpActivityNode.ts'
import { nativeOwner } from './native-tool-renderer.ts'
import css from './AcpActivityNode.module.css'

type NativeProps = ChatNodeViewProps<'assistant-step'> & PropsRenderFactories
type Dependencies = Pick<ActivityNodeProps, 'journalHub' | 't' | 'onProjectedChild' | 'onOpenProjectedChild' | 'jsonStringWrapping'> & {
  transcript: { subscribe(listener: () => void): () => void; getSnapshot(): { value?: { transcriptView?: string } | undefined } }
}
const EMPTY = { subscribe: () => () => {}, getSnapshot: (): AcpActivityNodeData | undefined => undefined }

/** Keep each activity at its first content boundary, irrespective of later patches. */
export function activityBoundaries(rows: readonly ActivityPresentationRow[], count: number, settled = false): Map<number, ActivityPresentationRow[]> {
  const boundaries = new Map<number, ActivityPresentationRow[]>()
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

/** Keep the complete trailing answer (including adjacent text/image blocks).
 * Tool updates after the answer do not turn its last paragraph into the only
 * visible content. Reasoning and intervening activities end the answer group.
 */
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

/** Native Chat uses HTML hidden-until-found so browser search can reveal a
 * collapsed process. Our interleaving containers retain that behavior too.
 */
function ProcessPart({ hidden, reveal, children, ...attributes }: {
  hidden: boolean; reveal(): void; children?: ReactNode; className?: string | undefined; 'data-acp-activity'?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) { reveal(); return }
    if (hidden) element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
  }, [hidden, reveal])
  useEffect(() => {
    const element = ref.current
    element?.addEventListener('beforematch', reveal)
    return () => element?.removeEventListener('beforematch', reveal)
  }, [reveal])
  return h('div', { ...attributes, ref }, children)
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
    renderRows: (rows, unavailable) => h(OrderedFlow, { props, Native, dependencies, rows, unavailable }),
  })
}

function OrderedFlow({ props, Native, dependencies, rows, unavailable }: {
  props: NativeProps; Native: ComponentType<NativeProps>; dependencies: Dependencies;
  rows: readonly ActivityPresentationRow[]; unavailable: boolean;
}): ReactNode {
  const [localOpen, setLocalOpen] = useState(false)
  const settings = useSyncExternalStore(dependencies.transcript.subscribe, dependencies.transcript.getSnapshot)
  // A leading formatting newline must not become the native first-line summary.
  // This is a presentation copy; the persisted reasoning and audit stay intact.
  const blocks = props.node.data.blocks.map(block => block.kind === 'reasoning'
    ? { ...block, text: block.text.replace(/^\s*\n/, '') } : block)
  const settled = props.node.data.status !== 'running'
  const boundaries = activityBoundaries(rows, blocks.length, settled)
  const count = rows.filter(row => row.kind === 'tool' && row.contentIndex !== undefined).length
  const nativeProcess = props.turnProcess
  const lastStep = nativeProcess?.spec.answerStep
  const ownsProcess = lastStep == null || lastStep === props.node.data.step
  const foldable = settled && settings.value?.transcriptView !== 'normal'
    && (count > 0 || nativeProcess?.foldable === true) && ownsProcess && !unavailable
  const open = !foldable || (nativeProcess?.foldable ? nativeProcess.open : localOpen)
  const setOpen = nativeProcess?.foldable ? nativeProcess.setOpen : setLocalOpen
  const answerStart = finalAnswerStart(blocks, boundaries)
  const location = props.node.location
  const turn = location.kind === 'step' || location.kind === 'turn' ? location.turn.turn : props.node.data.turn
  const spec = { turn, controlAnchorSeq: props.node.anchorSeq, processStartSeq: props.node.anchorSeq,
    answerAnchorSeq: props.node.anchorSeq, answerStep: props.node.data.step, inlineReasoning: false,
    messageCount: nativeProcess?.spec.messageCount ?? 0, subagentCount: nativeProcess?.spec.subagentCount ?? 0,
    toolCallCount: count + (nativeProcess?.spec.toolCallCount ?? 0),
  }
  const output: ReactNode[] = []
  if (foldable) output.push(props.renderFactorySlot('acp.native-process', {
    ...nativeOwner(props), node: { ...props.node, kind: 'turn-process', data: spec },
    turnProcess: { spec, foldable, open, setOpen },
  }))
  const content = (index: number, group: AssistantBlock[]): ReactNode => h(Native, {
    ...props, key: `content:${index}`,
    // ACP interleaving owns the inline visibility; avoid a second native fold.
    turnProcess: undefined,
    node: { ...props.node, data: { ...props.node.data, blocks: group,
      status: index + group.length === blocks.length && props.node.data.status === 'running' ? 'running' : 'settled',
    } },
  })
  for (let index = 0; index <= blocks.length; index++) {
    const activities = boundaries.get(index)
    if (activities !== undefined) output.push(h(ProcessPart, {
      key: `activities:${index}`, hidden: !open, reveal: () => setOpen(true), className: css.inlineActivities, 'data-acp-activity': true,
    }, ...activities.map(row => h(ActivityRow, {
      ...dependencies, key: row.activityId, row, openFile: props.openFile,
      renderTool: full => renderNativeActivityTool(props, full, dependencies.t),
    }))))
    const block = blocks[index]
    if (block !== undefined) {
      const start = index
      const group = [block]
      // Keep native consecutive-image galleries intact across boundaries.
      while (block.kind === 'image' && blocks[index + 1]?.kind === 'image' && !boundaries.has(index + 1)) group.push(blocks[++index]!)
      output.push(h(ProcessPart, { key: `segment:${start}`, hidden: !open && start < answerStart, reveal: () => setOpen(true) }, content(start, group)))
    }
  }
  if (props.node.data.status === 'interrupted' || blocks.length === 0 && props.node.data.status === 'running') {
    output.push(h(Native, { ...props, key: 'status', turnProcess: undefined, node: { ...props.node, data: { ...props.node.data, blocks: [] } } }))
  }
  if (unavailable) output.push(h('div', { key: 'unavailable', role: 'status' }, dependencies.t('activity.unavailable')))
  return h('div', { className: css.assistantFlow }, ...output)
}

/** A keyed wrapper delegates every unowned/legacy message to the existing renderer. */
export function installAcpAssistantStream(ctx: Context, options: Omit<Dependencies, 'transcript'>): () => boolean {
  const scope = ctx.settingsScope.bind<{ transcriptView?: string }>({ namespace: 'ui-chat' })
  const dependencies: Dependencies = { ...options, transcript: {
    subscribe: listener => scope.subscribe(listener), getSnapshot: () => scope.getSnapshot(),
  } }
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
      const process = ctx.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'turn-process' && (entry.options.priority ?? 0) === 0)
      if (process !== undefined && process.inject === undefined && process.children === undefined) {
        const Process = process.component as ComponentType<ChatNodeViewProps<'turn-process'>>
        ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-process', registrant: 'acp-process-owner', locale: 'chat', priority: -1 }, (processProps: ChatNodeViewProps<'turn-process'>) => {
          const location = processProps.node.location
          const turn = location.kind === 'step' || location.kind === 'turn' ? location.turn : undefined
          const inline = ctx.slots.entriesOfSlot('conversation.chat.node').some(entry => entry.options.key === 'assistant-step' && entry.component === wrapper)
          const acp = inline && turn?.steps.some(step => step.data.get('acp-activity') !== undefined || step.data.get('acp-activity-live') !== undefined)
          return acp ? null : h(Process, processProps)
        })
      }
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', install)
    install()
    return () => { unsubscribe(); installed = false }
  })
  return () => installed && ctx.slots.entriesOfSlot('conversation.chat.node').some(entry => entry.options.key === 'assistant-step' && entry.component === wrapper)
}
