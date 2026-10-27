import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConversationSessionHeaderInjected, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** This public child declaration has exactly one owner. A replacement that
 * borrows its navigation face is not another source for native composition. */
export function ownsNativeHeaderViews(entry: StoredEntry): boolean {
  return entry.children?.['conversation.session.header.views.actions'] !== undefined && entry.inject !== undefined
}

/** The pinned shell lists raw view registrations; rendering elects one entry per id. */
export function uniqueViewTabs<T extends { id: string }>(tabs: readonly T[]): readonly T[] {
  const unique = tabs.filter((tab, index) => tabs.findIndex((value) => value.id === tab.id) === index)
  return unique.length === tabs.length ? tabs : unique
}

/** Adapt the source rather than a component Hook, so a replacement header can
 * borrow the same navigation face without losing deduplication. The cache belongs
 * to this one composition mount and keeps useSyncExternalStore snapshots stable. */
export function nativeHeaderViewRegistration(entry: StoredEntry): Record<string, unknown> {
  const inject = entry.inject
  if (inject === undefined) return {}
  type Source = ObservableSnapshot<readonly ViewTab[]>
  const sources = new WeakMap<Source, Source>()
  const deduplicated = (source: Source): Source => {
    let mapped = sources.get(source)
    if (mapped === undefined) {
      let previous = source.getSnapshot()
      let snapshot = uniqueViewTabs(previous)
      mapped = {
        subscribe: (listener) => source.subscribe(listener),
        getSnapshot: () => {
          const next = source.getSnapshot()
          if (next !== previous) {
            previous = next
            snapshot = uniqueViewTabs(next)
          }
          return snapshot
        },
      }
      sources.set(source, mapped)
    }
    return mapped
  }
  return {
    inject: (...args: never[]) => {
      const face = inject(...args) as unknown as ConversationSessionHeaderInjected
      return { ...face, hooks: { ...face.hooks, conversationViews: deduplicated(face.hooks.conversationViews) } }
    },
  }
}
