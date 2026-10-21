import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '../../contract/external-subagent.ts'
import type { AcpApprovalChildView } from '../../contract/remote.ts'

/** Discover only live, descriptor-backed descendants; persisted lineage alone grants nothing. */
export function createApprovalChildrenReader(ctx: Context, owns: (provider: string) => boolean) {
  return (parentId: string): readonly AcpApprovalChildView[] => {
    const agents = ctx.get('agents', false)
    const projections = ctx.get('sessionProjections', false)
    const root = agents?.get(parentId as SessionId)
    if (agents === undefined || projections === undefined || root === undefined) return []
    const identityOf = (child: Agent) => {
      if (child.session.header.origin !== 'subagent') return undefined
      const view = projections.snapshot(child.session, ['subagent', 'acpExecution']).values
      const identity = view.subagent
      if (view.acpExecution?.externalSubagent === true || identity == null || !child.session.isOwnSeq(identity.seq))
        return undefined
      return identity
    }
    const result: AcpApprovalChildView[] = []
    const labelOf = (child: Agent, label: string | undefined): string => {
      const membership = ctx.get('agentTeams', false)?.tryMembership(child)
      return membership?.role === 'teammate' ? membership.name : (label ?? child.id)
    }
    for (const child of agents.list()) {
      const provider = child.session.requestHeader()?.config.provider ?? child.options.provider
      if (provider === undefined || !owns(provider) || agents.get(child.id) !== child) continue
      const identity = identityOf(child)
      if (identity === undefined) continue
      const path: { sessionId: string; name: string }[] = []
      const visited = new Set<SessionId>()
      let current: Agent | undefined = child
      while (current !== undefined && current !== root) {
        if (visited.has(current.id) || agents.get(current.id) !== current) break
        visited.add(current.id)
        const currentIdentity = identityOf(current)
        const parent: Agent | undefined =
          current.session.header.parentSession === undefined
            ? undefined
            : agents.get(current.session.header.parentSession)
        if (currentIdentity === undefined || parent === undefined || !agents.isOwnedBy(current.id, parent)) break
        path.unshift({ sessionId: current.id, name: labelOf(current, currentIdentity.label) })
        current = parent
      }
      if (current !== root || path.length === 0 || agents.get(root.id) !== root) continue
      result.push({
        sessionId: child.id,
        parentSessionId: child.session.header.parentSession!,
        name: labelOf(child, identity.label),
        mode: identity.mode,
        path,
      })
    }
    return result
  }
}
