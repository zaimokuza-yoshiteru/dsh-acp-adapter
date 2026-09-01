import type { SettingsScopeLike } from './controller.ts'

/** Client-side ownership catalogue derived from the plugin's authoritative
 * profile registry. A naming prefix is never an ownership claim. */
export class ManagedAcpRouteCatalog {
  private routes = new Set<string>()
  private readonly durableRoutes: ReadonlySet<string>
  private readonly unsubscribe: () => void

  constructor(private readonly scope: SettingsScopeLike, durableRoutes: Iterable<string> = []) {
    this.durableRoutes = new Set(durableRoutes)
    this.refresh()
    this.unsubscribe = scope.subscribe(() => { this.refresh() })
  }

  owns = (provider: string | undefined): boolean =>
    provider !== undefined && this.routes.has(provider)

  snapshot(): ReadonlySet<string> {
    return new Set(this.routes)
  }

  dispose(): void {
    this.unsubscribe()
    this.routes.clear()
  }

  private refresh(): void {
    const agents = this.scope.getSnapshot().value?.agents
    if (agents === undefined) return
    this.routes = new Set([...this.durableRoutes, ...Object.keys(agents).map(id => `acp-${id}`)])
  }
}
