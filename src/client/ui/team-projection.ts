import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Refresh ACP settings when the native descendant catalogs or model selections change.
 * This key never grants membership: the Host's live ACP roster remains authoritative.
 */
export function projectionRevision(
  root: SessionId,
  projections: SessionListState['projectionsBySession'],
  runtime?: (id: SessionId) => unknown,
): string {
  const visited = new Set<SessionId>()
  const revisions: unknown[] = []
  const visit = (id: SessionId): void => {
    if (visited.has(id)) return
    visited.add(id)
    const projection = projections[id]
    const catalog = projection?.values.subagentCatalog
    revisions.push([id, projection?.state, catalog, projection?.values.modelSelection, runtime?.(id)])
    for (const child of catalog ?? []) if (child.mode === 'continuable') visit(child.id)
  }
  visit(root)
  return JSON.stringify(revisions)
}
