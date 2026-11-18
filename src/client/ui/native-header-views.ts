import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConversationSessionHeaderInjected, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpAuditViewVisibility } from './audit-view-visibility.ts'

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
export function nativeHeaderViewRegistration(
  entry: StoredEntry,
  auditVisibility?: AcpAuditViewVisibility,
): Record<string, unknown> {
  const inject = entry.inject
  if (inject === undefined) return {}
  type Source = ObservableSnapshot<readonly ViewTab[]>
  const sources = new WeakMap<Source, Source>()
  // Native actions belong to the exact scoped Store instance. A weak key keeps
  // each session's filtering face stable without retaining retired bindings.
  const scopedSources = new WeakMap<object, WeakMap<Source, Source>>()
  const deduplicated = (source: Source, sessionId?: string, owner?: object): Source => {
    let cache: WeakMap<Source, Source> | undefined = auditVisibility === undefined ? sources : undefined
    if (auditVisibility !== undefined && sessionId !== undefined && owner !== undefined) {
      let scoped = scopedSources.get(owner)
      if (scoped === undefined) scopedSources.set(owner, (scoped = new WeakMap()))
      cache = scoped
    }
    let mapped = cache?.get(source)
    if (mapped === undefined) {
      const visible = () =>
        auditVisibility === undefined || (sessionId !== undefined && auditVisibility.visible(sessionId))
      const filter = (tabs: readonly ViewTab[], showAudit: boolean) => {
        const unique = uniqueViewTabs(tabs)
        return showAudit || !unique.some((tab) => tab.id === 'dsh-acp-audit')
          ? unique
          : unique.filter((tab) => tab.id !== 'dsh-acp-audit')
      }
      let previous = source.getSnapshot()
      let previousVisible = visible()
      let snapshot = filter(previous, previousVisible)
      mapped = {
        subscribe: (listener) => {
          const releaseSource = source.subscribe(listener)
          const releaseVisibility =
            sessionId === undefined ? undefined : auditVisibility?.subscribe(sessionId, listener)
          return () => {
            releaseVisibility?.()
            releaseSource()
          }
        },
        getSnapshot: () => {
          const next = source.getSnapshot()
          const nextVisible = visible()
          if (next !== previous || nextVisible !== previousVisible) {
            previous = next
            previousVisible = nextVisible
            snapshot = filter(next, nextVisible)
          }
          return snapshot
        },
      }
      cache?.set(source, mapped)
    }
    return mapped
  }
  return {
    inject: (...args: never[]) => {
      const face = inject(...args) as unknown as ConversationSessionHeaderInjected
      const [sessionId, actions] = args as readonly unknown[]
      return {
        ...face,
        hooks: {
          ...face.hooks,
          conversationViews: deduplicated(
            face.hooks.conversationViews,
            typeof sessionId === 'string' ? sessionId : undefined,
            typeof actions === 'object' && actions !== null ? actions : undefined,
          ),
        },
      }
    },
  }
}
