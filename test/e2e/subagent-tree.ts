import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

/** Fixture observations use native runtime identity; persisted names grant no authority. */
export function treeMember(ctx: Context, agent: Agent) {
  if (ctx.agents.get(agent.id) !== agent) return undefined
  try {
    const root = ctx.subagents.rootOf(agent)
    const name = ctx.subagents.namesOf(agent).self
    return { root, name, role: root === agent ? ('lead' as const) : ('teammate' as const) }
  } catch {
    return undefined
  }
}

export function treeRoots(ctx: Context): Agent[] {
  return ctx.agents.list().filter((agent) => treeMember(ctx, agent)?.root === agent)
}

/** Include the root when asserting a complete collaboration tree, and observe cold descendants. */
export async function treeMembers(ctx: Context, root: Agent) {
  if (ctx.subagents.rootOf(root) !== root) throw new Error('Expected the exact live tree root')
  const rows = await ctx.subagents.listDescendants(root.id)
  const observe = (id: Agent['id'], name: string, role: 'lead' | 'teammate') => {
    const live = ctx.agents.get(id)
    const route = live?.session.requestHeader()?.config ?? live?.options
    return {
      id,
      name,
      role,
      status: live?.status === 'running' ? ('running' as const) : ('inactive' as const),
      provider: route?.provider,
      model: route?.model,
    }
  }
  return [
    observe(root.id, 'lead', 'lead'),
    ...rows.map((row) => {
      if (row.kind !== 'child') throw new Error(`Unreadable subagent ${row.id}: ${row.reason}`)
      return observe(row.id, row.path ?? row.id, 'teammate')
    }),
  ]
}

/** Verify direct creation separately from current shared runtime-root ownership. */
export function isDirectChild(ctx: Context, childId: Agent['id'], creator: Agent): boolean {
  const child = ctx.agents.get(childId)
  return (
    child !== undefined &&
    child.session.header.origin === 'subagent' &&
    child.session.header.parentSession === creator.id &&
    treeMember(ctx, child)?.root === treeMember(ctx, creator)?.root &&
    treeMember(ctx, child) !== undefined
  )
}
