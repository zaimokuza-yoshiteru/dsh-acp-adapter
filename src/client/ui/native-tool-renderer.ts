import { createElement as h } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps, ChatNodeOwnerProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

type NativeOwner = ChatNodeOwnerProps & { node: ChatConversationViewNode }
export type NativeToolOwner = NativeOwner & { node: ChatNodeViewProps<'tool-call'>['node'] }
export function nativeOwner(props: NativeOwner): NativeOwner {
  const { cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions, turnProcess, node } = props
  return { cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions, turnProcess, node }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'acp.native-tool': { scope: 'session'; props: NativeToolOwner }
    'acp.native-process': { scope: 'session'; props: NativeOwner & { node: ChatNodeViewProps<'turn-process'>['node'] } }
  }
}

type EntryProps = Record<string, unknown> & {
  renderSlot?: (key: string, owner: unknown, options?: unknown) => ReactNode
  renderSlotChain?: (key: string, owner: unknown, options?: unknown) => ReactNode
}
// Slot names and registrations come from the live native registry. Keep the
// erased bridge here; callers still pass the public Tool-call owner contract.
type Registration = Record<string, unknown>
type Register = (options: Registration, component: ComponentType<EntryProps>) => () => void

/** Reuse the registered native Tool tree including its injected hooks, stores,
 * locale and third-party child renderers. Factories cannot redeclare an existing
 * slot, so give this presentation-only occurrence its own declaration names.
 * No component, classifier, CSS, execution event or approval is copied.
 */
export function installNativeToolRenderer(ctx: Context): void {
  const register = ctx.slots.register.bind(ctx.slots) as unknown as Register
  const factory = ctx.slots.registerFactory.bind(ctx.slots) as unknown as Register
  const sourceEntries = (name: string) => ctx.slots.entriesOfSlot(name as never)
  let generation = 0
  const mount = (entry: StoredEntry, destination: string, root: boolean): (() => void) => {
    const aliases = new Map(Object.keys(entry.children ?? {}).map(key => [key, `acp.native.${++generation}.${key}`]))
    const Native = entry.component as ComponentType<EntryProps>
    const Component = (props: EntryProps): ReactNode => h(Native, {
      ...props,
      ...(props.renderSlot === undefined ? {} : { renderSlot: (key: string, owner: unknown, options?: unknown) => props.renderSlot!(aliases.get(key) ?? key, owner, options) }),
      ...(props.renderSlotChain === undefined ? {} : { renderSlotChain: (key: string, owner: unknown, options?: unknown) => props.renderSlotChain!(aliases.get(key) ?? key, owner, options) }),
    })
    const options = {
      name: destination,
      ...(root ? { scope: 'session' } : { ...entry.options, ...(entry.select === undefined ? {} : { select: entry.select }) }),
      ...(entry.inject === undefined ? {} : { inject: entry.inject }),
      ...(entry.store === undefined ? {} : { store: entry.store }),
      ...(entry.locale === undefined ? {} : { locale: entry.locale }),
      ...(entry.children === undefined ? {} : { children: Object.fromEntries(Object.entries(entry.children).map(([key, spec]) => [aliases.get(key)!, spec])) }),
    }
    const dispose = (root ? factory : register)(options, Component)
    const children = [...aliases].map(([source, target]) => {
      const mounted = new Map<StoredEntry, () => void>()
      const sync = () => {
        const entries = sourceEntries(source)
        for (const [old, release] of mounted) if (!entries.includes(old)) { release(); mounted.delete(old) }
        for (const next of entries) if (!mounted.has(next)) mounted.set(next, mount(next, target, false))
      }
      const unsubscribe = ctx.slots.subscribe(source as never, sync)
      sync()
      return () => { unsubscribe(); for (const release of mounted.values()) release() }
    })
    return () => { children.forEach(release => release()); dispose() }
  }
  for (const [key, name] of [['tool-call', 'acp.native-tool'], ['turn-process', 'acp.native-process']] as const) ctx.slots.inject('conversation.chat.node', () => {
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = () => {
      const entries = key === 'turn-process' ? ctx.slots.entries('conversation.chat.node') : sourceEntries('conversation.chat.node')
      const next = entries.find(entry => entry.options.key === key && entry.registrant !== 'acp-process-owner')
      if (next === current) return
      release?.(); release = undefined; current = next
      if (next !== undefined) release = mount(next, name, true)
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', sync)
    sync()
    return () => { unsubscribe(); release?.() }
  })
}
