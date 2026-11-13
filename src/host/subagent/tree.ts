import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
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

/** Catalog paths supply display and resource addresses, never runtime authority. */
export function subagentPath(
  root: SessionId,
  id: SessionId,
  rows: readonly SubagentDescendantListEntry[],
): readonly { sessionId: string; name: string }[] | undefined {
  const byId = new Map(rows.map((row) => [row.id, row]))
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
