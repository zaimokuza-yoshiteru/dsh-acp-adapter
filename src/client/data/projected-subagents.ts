import type { AcpRemoteLike } from './acp-remote.ts'

/** Exact, sidecar-backed ownership proof for durable external-subagent records. */
export class ProjectedSubagentCatalog {
  private readonly ids = new Set<string>()

  constructor(private readonly remote: AcpRemoteLike, initial: readonly string[] = []) {
    for (const id of initial) this.ids.add(id)
  }

  readonly owns = (sessionId: string): boolean => this.ids.has(sessionId)

  add(sessionId: string): boolean {
    const fresh = !this.ids.has(sessionId)
    this.ids.add(sessionId)
    return fresh
  }

  async refresh(): Promise<void> {
    const result = await this.remote.projectedSubagentIds?.()
    if (result?.ok !== true) return
    for (const id of result.value.sessionIds) this.ids.add(id)
  }
}
