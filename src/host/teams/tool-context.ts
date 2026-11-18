import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { captureSubagentTree, localSubagentIdentity } from '../subagent/tree.ts'

/** Native tree identity survives Team toggles; tool availability stays Host-owned. */
export function createTeamToolContext(ctx: Context, agent: Agent) {
  const tree = captureSubagentTree(ctx, agent)
  if (tree === undefined || (tree.root !== agent && localSubagentIdentity(ctx, agent) === undefined)) return undefined
  const membership = () =>
    tree.current()
      ? { id: tree.root.id, root: tree.root, role: agent === tree.root ? ('lead' as const) : ('teammate' as const) }
      : undefined
  return {
    membership,
    isLive: tree.current,
    isLeadReference: (value: unknown) => value === 'lead' || value === tree.root.id,
  }
}
