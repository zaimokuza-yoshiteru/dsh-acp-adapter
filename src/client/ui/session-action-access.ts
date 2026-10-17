import { useMemo, useSyncExternalStore } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Native RemoteAccess answers; absent services never grant a write. */
export type SessionAccessSource = (sessionId: string, action: string) => HostObservable<boolean> | undefined

/** Combine native sources without caching a grant or interpreting roles. */
export function sessionActionAccess(source: SessionAccessSource, sessionIds: readonly string[], action: string) {
  const sources = new Map([...new Set(sessionIds)].map((id) => [id, source(id, action)]))
  return {
    allows: (id: string): boolean => sources.get(id)?.getSnapshot() === true,
    getSnapshot: (): string => [...sources.values()].map((item) => (item?.getSnapshot() === true ? '1' : '0')).join(''),
    subscribe: (changed: () => void): (() => void) => {
      const disposers = [...sources.values()].map((item) => item?.subscribe(changed))
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    },
  }
}

/** One subscription for a changing member set, with no Hooks inside its loop. */
export function useSessionActionAccess(source: SessionAccessSource, sessionIds: readonly string[], action: string) {
  const identities = JSON.stringify([...new Set(sessionIds)])
  const access = useMemo(
    () => sessionActionAccess(source, JSON.parse(identities) as string[], action),
    [source, identities, action],
  )
  useSyncExternalStore(access.subscribe, access.getSnapshot)
  return access
}
