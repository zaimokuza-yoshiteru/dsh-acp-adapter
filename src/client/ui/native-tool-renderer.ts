import { createElement as h, useLayoutEffect, useMemo } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ChatNodeViewProps,
  ChatNodeOwnerProps,
  ChatConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

type NativeOwner = ChatNodeOwnerProps &
  Pick<ChatNodeViewProps, 'useDisclosure' | 'useGroupAction'> & {
    node: ChatConversationViewNode
  }
export type NativeToolOwner = NativeOwner & { node: ChatNodeViewProps<'tool-call'>['node'] }
export function nativeOwner(props: NativeOwner): NativeOwner {
  const {
    useDisclosure,
    useGroupAction,
    groupPart,
    cwd,
    openFile,
    inspectCall,
    forkAt,
    loadImage,
    fileMentions,
    turnProcess,
    node,
  } = props
  return {
    useDisclosure,
    useGroupAction,
    ...(groupPart === undefined ? {} : { groupPart }),
    cwd,
    openFile,
    inspectCall,
    forkAt,
    loadImage,
    fileMentions,
    turnProcess,
    node,
  }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'acp.native-tool': { scope: 'session'; props: NativeToolOwner }
  }
}

export type EntryProps = Record<string, unknown> & {
  renderSlot?: (key: string, owner: unknown, options?: unknown) => ReactNode
  renderSlotChain?: (key: string, owner: unknown, options?: unknown) => ReactNode
}
// Slot names and registrations come from the live native registry. Keep the
// erased bridge here; callers still pass the public Tool-call owner contract.
type Registration = Record<string, unknown>
type Register = (options: Registration, component: ComponentType<EntryProps>) => () => void

let generation = 0

/** Preserve pinned DSH's semantic DOM anchors while private slots keep their
 * registry identities. DSH currently derives data-slot from the dispatch key;
 * its public render options expose no separate DOM name. This adapter depends
 * on that renderer detail and never changes dispatch, declarations or owners.
 * @param document - document receiving this native composition.
 * @param aliases - private dispatch keys owned by one mount and their native names.
 * @returns layout flushing and lifetime cleanup for this mount's observer.
 */
export function observeNativeSlotAnchors(document: Document, aliases: ReadonlyMap<string, string>) {
  let disposed = false
  let initialized = false
  const correctElement = (element: Element): void => {
    const name = aliases.get(element.getAttribute('data-slot') ?? '')
    if (name !== undefined) element.setAttribute('data-slot', name)
  }
  const correctSubtree = (node: Node): void => {
    if (node.nodeType !== 1) return
    const element = node as Element
    correctElement(element)
    for (const child of element.querySelectorAll('[data-slot]')) correctElement(child)
  }
  const correct = (records: readonly MutationRecord[]): void => {
    if (disposed) return
    for (const record of records) {
      if (record.type === 'attributes') correctElement(record.target as Element)
      else for (const node of record.addedNodes) correctSubtree(node)
    }
  }
  const observer = new MutationObserver(correct)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-slot'],
  })
  return {
    flush(): void {
      if (disposed) return
      if (!initialized) {
        initialized = true
        correctSubtree(document.documentElement)
      }
      correct(observer.takeRecords())
    },
    dispose(): void {
      disposed = true
      observer.disconnect()
    },
  }
}

/** Compose a registered native component with its complete injection and child tree. */
export function mountNativeEntry(
  ctx: Context,
  entry: StoredEntry,
  destination: string,
  options: {
    factory?: boolean
    registration?: Record<string, unknown>
    wrap?: (Native: ComponentType<EntryProps>, props: EntryProps) => ReactNode
  } = {},
): () => void {
  const register = ctx.slots.register.bind(ctx.slots) as unknown as Register
  const factory = ctx.slots.registerFactory.bind(ctx.slots) as unknown as Register
  const sourceEntries = (name: string) => ctx.slots.entriesOfSlot(name as never)
  const semanticAliases = new Map<string, string>()
  const anchors = typeof document === 'undefined' ? undefined : observeNativeSlotAnchors(document, semanticAliases)
  const mount = (entry: StoredEntry, destination: string, root: boolean): (() => void) => {
    const aliases = new Map(Object.keys(entry.children ?? {}).map((key) => [key, `acp.native.${++generation}.${key}`]))
    for (const [name, alias] of aliases) semanticAliases.set(alias, name)
    const Native = entry.component as ComponentType<EntryProps>
    const Component = (props: EntryProps): ReactNode => {
      useLayoutEffect(() => anchors?.flush())
      const renderSlot = useMemo(
        () =>
          props.renderSlot === undefined
            ? undefined
            : (key: string, owner: unknown, options?: unknown) =>
                props.renderSlot!(aliases.get(key) ?? key, owner, options),
        [props.renderSlot],
      )
      const renderSlotChain = useMemo(
        () =>
          props.renderSlotChain === undefined
            ? undefined
            : (key: string, owner: unknown, options?: unknown) =>
                props.renderSlotChain!(aliases.get(key) ?? key, owner, options),
        [props.renderSlotChain],
      )
      const render =
        root && options.wrap !== undefined
          ? options.wrap
          : (component: ComponentType<EntryProps>, value: EntryProps) => h(component, value)
      return render(Native, {
        ...props,
        ...(renderSlot === undefined
          ? {}
          : {
              renderSlot,
            }),
        ...(renderSlotChain === undefined
          ? {}
          : {
              renderSlotChain,
            }),
      })
    }
    const registration = {
      name: destination,
      ...(root && options.factory
        ? { scope: 'session' }
        : { ...entry.options, ...(entry.select === undefined ? {} : { select: entry.select }) }),
      ...(entry.inject === undefined ? {} : { inject: entry.inject }),
      ...(entry.store === undefined ? {} : { store: entry.store }),
      ...(entry.locale === undefined ? {} : { locale: entry.locale }),
      ...(entry.children === undefined
        ? {}
        : {
            children: Object.fromEntries(
              Object.entries(entry.children).map(([key, spec]) => [aliases.get(key)!, spec]),
            ),
          }),
    }
    const dispose = (root && options.factory ? factory : register)(
      { ...registration, ...(root ? options.registration : {}) },
      Component,
    )
    const children = [...aliases].map(([source, target]) => {
      const mounted = new Map<StoredEntry, () => void>()
      const sync = () => {
        const entries = sourceEntries(source)
        for (const [old, release] of mounted)
          if (!entries.includes(old)) {
            release()
            mounted.delete(old)
          }
        for (const next of entries) if (!mounted.has(next)) mounted.set(next, mount(next, target, false))
      }
      const unsubscribe = ctx.slots.subscribe(source as never, sync)
      sync()
      return () => {
        unsubscribe()
        for (const release of mounted.values()) release()
      }
    })
    return () => {
      anchors?.flush()
      children.forEach((release) => release())
      dispose()
      for (const alias of aliases.values()) semanticAliases.delete(alias)
    }
  }
  let release: () => void
  try {
    release = mount(entry, destination, true)
  } catch (error) {
    anchors?.dispose()
    throw error
  }
  return () => {
    anchors?.dispose()
    semanticAliases.clear()
    release()
  }
}

/** Reuse the registered native Tool tree including its injected hooks, stores,
 * locale and third-party child renderers. Factories cannot redeclare an existing
 * slot, so give this presentation-only occurrence its own declaration names.
 * No component, classifier, CSS, execution event or approval is copied.
 */
export function installNativeToolRenderer(ctx: Context): void {
  ctx.slots.inject('conversation.chat.node', () => {
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = () => {
      const entries = ctx.slots.entries('conversation.chat.node')
      const next = entries.find(
        (entry) => entry.options.key === 'tool-call' && entry.registrant !== 'acp-chat-normalization',
      )
      if (next === current) return
      release?.()
      release = undefined
      current = next
      if (next !== undefined) release = mountNativeEntry(ctx, next, 'acp.native-tool', { factory: true })
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', sync)
    sync()
    return () => {
      unsubscribe()
      release?.()
    }
  })
}
