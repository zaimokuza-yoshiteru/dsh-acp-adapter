import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '../../contract/external-subagent.ts'

/** A local descriptor is required in addition to the runtime's tree ownership. */
export function localSubagentIdentity(ctx: Context, agent: Agent) {
  if (agent.session.header.origin !== 'subagent') return undefined
  const view = ctx.get('sessionProjections', false)?.snapshot(agent.session, ['subagent', 'acpExecution']).values
  const identity = view?.subagent
  return view?.acpExecution?.externalSubagent !== true && identity != null && agent.session.isOwnSeq(identity.seq)
    ? identity
    : undefined
}

// Cordis returns a new caller-traced proxy on each service lookup. Compare the
// underlying service identity while invoking methods through the traced value.
function serviceIdentity(service: object | undefined): unknown {
  return service === undefined ? undefined : (Reflect.get(service, symbols.original) ?? service)
}

/** Capture the native owner, retaining exact instances across asynchronous reads. */
export function captureSubagentTree(ctx: Context, agent: Agent) {
  const agents = ctx.get('agents', false)
  const subagents = ctx.get('subagents', false)
  if (agents === undefined || subagents === undefined || agents.get(agent.id) !== agent) return undefined
  let root: Agent
  try {
    root = subagents.rootOf(agent)
  } catch {
    return undefined
  }
  const current = (): boolean => {
    if (
      serviceIdentity(ctx.get('agents', false)) !== serviceIdentity(agents) ||
      serviceIdentity(ctx.get('subagents', false)) !== serviceIdentity(subagents) ||
      agents.get(agent.id) !== agent ||
      agents.get(root.id) !== root
    )
      return false
    try {
      return subagents.rootOf(agent) === root && subagents.rootOf(root) === root
    } catch {
      return false
    }
  }
  if (!current()) return undefined
  return {
    root,
    current,
    names: () => subagents.namesOf(agent),
    async descendants(signal?: AbortSignal) {
      const rows = await subagents.listDescendants(root.id, signal)
      if (!current())
        throw new HarnessError('The subagent tree changed while loading its members.', 'ACP_SUBAGENT_OWNER_CHANGED')
      return rows
    },
  }
}

/** A retained native observation can identify a dormant root without activating it. */
export async function observeDormantSubagentRoot(ctx: Context, id: SessionId) {
  const agents = ctx.get('agents', false)
  const subagents = ctx.get('subagents', false)
  const query = ctx.get('sessionQuery', false)
  if (agents === undefined || subagents === undefined || query === undefined)
    throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
  const current = () =>
    serviceIdentity(ctx.get('agents', false)) === serviceIdentity(agents) &&
    serviceIdentity(ctx.get('subagents', false)) === serviceIdentity(subagents) &&
    serviceIdentity(ctx.get('sessionQuery', false)) === serviceIdentity(query) &&
    agents.get(id) === undefined
  const assertCurrent = () => {
    if (!current())
      throw new HarnessError('The subagent tree changed while loading its members.', 'ACP_SUBAGENT_OWNER_CHANGED')
  }
  try {
    using observation = await query.observeSession(id)
    assertCurrent()
    const values = observation.projections?.values
    if (values?.subagent === undefined || values.subagentCatalog === undefined)
      throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
    const identity = values.subagent
    if (
      observation.header.id !== id ||
      observation.header.origin === 'subagent' ||
      (identity !== null && identity.seq >= observation.inheritedEventCount && identity.seq <= observation.cursor) ||
      values.acpExecution?.externalSubagent === true ||
      values.subagentCatalog.length === 0
    )
      return undefined
  } catch (error) {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
    throw error
  }
  return {
    root: undefined,
    current,
    async descendants() {
      const rows = await subagents.listDescendants(id)
      assertCurrent()
      return rows
    },
  }
}

/** Index one native catalog cut. Its paths supply addresses, never runtime authority. */
export function subagentPaths(root: SessionId, rows: readonly SubagentDescendantListEntry[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return (id: SessionId): readonly { sessionId: string; name: string }[] | undefined => {
    const path: { sessionId: string; name: string }[] = []
    const seen = new Set<SessionId>()
    for (let current = id; current !== root;) {
      if (seen.has(current)) return undefined
      seen.add(current)
      const row = byId.get(current)
      if (row === undefined || row.kind !== 'child' || row.mode === 'external') return undefined
      path.unshift({ sessionId: row.id, name: ('name' in row ? row.name : undefined) ?? row.label ?? row.id })
      current = row.parentId
    }
    return path.length === 0 ? undefined : path
  }
}
