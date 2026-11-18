import { createSnapshotStore, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { AcpOwnedRoutesView } from '../../contract/remote.ts'

const emptyRoutes: AcpOwnedRoutesView = { providers: [], historicalProviders: [] }

export type UseRouteOwnership = SnapshotSelectorHook<AcpOwnedRoutesView>

export function includesRoute(providers: readonly string[], provider: string | undefined): boolean {
  return provider !== undefined && providers.includes(provider)
}

/** Only a live registration authorizes new actions. A historical route is a hint to check the session binding. */
export class ManagedAcpRouteCatalog {
  readonly store = createSnapshotStore(emptyRoutes)
  private revision = 0
  private disposed = false

  constructor(private readonly read: () => Promise<AcpOwnedRoutesView | undefined>) {}

  owns = (provider: string | undefined): boolean => includesRoute(this.store.getSnapshot().providers, provider)

  async refresh(): Promise<void> {
    const revision = ++this.revision
    const routes = await this.read().catch(() => undefined)
    if (!this.disposed && revision === this.revision) this.store.set(routes ?? emptyRoutes)
  }

  reset(): void {
    this.store.set(emptyRoutes)
    void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    this.store.set(emptyRoutes)
  }
}
