import { createSnapshotStore, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { AcpOwnedRoutesView } from '../../contract/remote.ts'

const emptyRoutes: AcpOwnedRoutesView = { providers: [], historicalProviders: [] }
const retryDelays = [250, 1_000, 4_000] as const

export type UseRouteOwnership = SnapshotSelectorHook<AcpOwnedRoutesView>

export function includesRoute(providers: readonly string[], provider: string | undefined): boolean {
  return provider !== undefined && providers.includes(provider)
}

/** Only a live registration authorizes new actions. A historical route is a hint to check the session binding. */
export class ManagedAcpRouteCatalog {
  readonly store = createSnapshotStore(emptyRoutes)
  private revision = 0
  private disposed = false
  private retry?: ReturnType<typeof setTimeout>

  constructor(private readonly read: () => Promise<AcpOwnedRoutesView | undefined>) {}

  owns = (provider: string | undefined): boolean => includesRoute(this.store.getSnapshot().providers, provider)

  refresh(): Promise<void> {
    clearTimeout(this.retry)
    return this.readRoutes(++this.revision, 0)
  }

  private async readRoutes(revision: number, attempt: number): Promise<void> {
    if (this.disposed || revision !== this.revision) return
    const routes = await this.read().catch(() => undefined)
    if (this.disposed || revision !== this.revision) return
    this.store.set(routes ?? emptyRoutes)
    const delay = retryDelays[attempt]
    if (routes === undefined && delay !== undefined) {
      this.retry = setTimeout(() => void this.readRoutes(revision, attempt + 1), delay)
    }
  }

  reset(): void {
    this.store.set(emptyRoutes)
    void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retry)
    this.store.set(emptyRoutes)
  }
}
