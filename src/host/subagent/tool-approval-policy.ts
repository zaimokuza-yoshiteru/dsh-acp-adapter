import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpToolApprovalPolicySnapshot } from '../../contract/remote.ts'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'

/** ACP transport approval preferences are separate from native delegated tool authority. */
export function createToolApprovalPolicyReader(
  ctx: Context,
  dependencies: {
    readonly sidecar: AcpSidecar | undefined
    readonly sessionOf: (id: string) => Session | undefined
    readonly ownsProvider: (profileId: string) => boolean
    readonly defaultPolicy: () => 'auto' | 'ask'
  },
): (sessionId: string) => Promise<AcpToolApprovalPolicySnapshot> {
  const { sidecar, sessionOf, ownsProvider, defaultPolicy } = dependencies
  const read = async (
    sessionId: string,
    ancestry = new Set<string>(),
    nativeParent = false,
  ): Promise<AcpToolApprovalPolicySnapshot> => {
    if (ancestry.has(sessionId)) throw new Error('ACP_TOOL_APPROVAL_PARENT_CYCLE')
    const nextAncestry = new Set(ancestry).add(sessionId)
    if (sidecar === undefined) throw new Error('ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE')
    const session = sessionOf(sessionId)
    const header = session?.header ?? (await ctx.get('sessionPersistence', false)?.stat(sessionId as never))?.header
    if (header === undefined) throw new Error('ACP_TOOL_APPROVAL_SESSION_UNAVAILABLE')
    if (nativeParent && session !== undefined) {
      const committedProvider =
        ctx.sessionProjections.stateOf(session, 'modelSelection')?.lastUsed?.provider ??
        session.requestHeader?.()?.config.provider
      // A native request may have completed while this plugin was disabled.
      // Its old ACP binding and preference no longer govern a new child's
      // initialization. Pending selection alone does not establish that switch.
      if (committedProvider !== undefined && acpAgentIdFromRoute(committedProvider) === undefined)
        return { sessionId, policy: defaultPolicy(), source: 'session', editable: false }
    }
    const binding = await sidecar.readLatestBinding(sessionId as never)
    if (binding?.status === 'outdated') throw new Error('ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE')
    const selected = session === undefined ? undefined : ctx.sessionProjections.stateOf(session, 'modelSelection')
    const agent = ctx.get('agents', false)?.get(sessionId as never)
    const provider =
      binding?.binding.provider ??
      selected?.pending?.provider ??
      selected?.lastUsed?.provider ??
      session?.requestHeader?.()?.config.provider ??
      agent?.options.provider ??
      (session !== undefined && header.origin !== 'subagent'
        ? ctx.get('agentDefaultModel')?.currentSelection().provider
        : undefined)
    const profileId = provider === undefined ? undefined : acpAgentIdFromRoute(provider)
    if (profileId === undefined || !ownsProvider(profileId)) {
      // Only an explicitly native route authorizes initialization from the ACP
      // default. Missing metadata, failed reads and a removed ACP route do not.
      if (nativeParent && provider !== undefined && profileId === undefined)
        return { sessionId, policy: defaultPolicy(), source: 'session', editable: false }
      throw new Error('ACP_TOOL_APPROVAL_SESSION_NOT_ACP')
    }
    const teams = ctx.get('agentTeams', false)
    const membership = agent === undefined ? undefined : teams?.tryMembership(agent)
    let root: Agent | undefined
    let teamId: string | undefined
    if (membership?.role === 'teammate') {
      root = membership.root
      teamId = membership.id
    } else if (header.origin === 'subagent' && teams !== undefined && header.parentSession !== undefined) {
      // Every ordinary root is an implicit Lead. A child belongs to its Team
      // only when the authoritative roster contains that exact child id.
      let parent = ctx.get('agents', false)?.get(header.parentSession)
      const saved = await sidecar.readToolApprovalPolicy(sessionId as never)
      const parentSession = sessionOf(header.parentSession)
      if (
        parent === undefined &&
        saved === undefined &&
        parentSession !== undefined &&
        parentSession.header.origin !== 'subagent'
      ) {
        const activated = await ctx.get('sessionController', false)?.resolveAgent(header.parentSession)
        if (activated !== undefined && 'error' in activated) throw activated.error
        parent = ctx.get('agents', false)?.get(header.parentSession)
      }
      if (parent !== undefined) {
        const parentMembership = teams.tryMembership(parent)
        if (parentMembership === undefined && parentSession?.header.origin !== 'subagent')
          throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
        if (parentMembership?.role === 'lead' && parentMembership.root === parent) {
          const row = teams.listMembers(parent).find((entry) => entry.id === sessionId && entry.role === 'teammate')
          if (row !== undefined) {
            if (row.status === 'failed' || (agent !== undefined && membership === undefined))
              throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
            root = parent
            teamId = parentMembership.id
          }
        }
      } else if (saved === undefined) {
        throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
      }
    }
    if (root !== undefined) {
      const lead = root
      const authenticated = (): boolean => {
        const currentLead = teams?.tryMembership(lead)
        if (
          ctx.get('agents', false)?.get(lead.id) !== lead ||
          currentLead?.role !== 'lead' ||
          currentLead.root !== lead ||
          currentLead.id !== teamId
        )
          return false
        if (agent !== undefined) {
          const current = teams?.tryMembership(agent)
          return (
            ctx.get('agents', false)?.get(agent.id) === agent &&
            current?.role === 'teammate' &&
            current.root === lead &&
            current.id === teamId
          )
        }
        const row = teams?.listMembers(lead).find((entry) => entry.id === sessionId && entry.role === 'teammate')
        return row !== undefined && row.status !== 'failed'
      }
      if (!authenticated()) throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
      const policy = await sidecar.readToolApprovalPolicy(lead.id, defaultPolicy())
      if (policy === undefined) throw new Error('ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE')
      if (!authenticated()) throw new Error('ACP_TOOL_APPROVAL_LEAD_CHANGED')
      return { sessionId, policy, source: 'lead', editable: false }
    }
    const saved = await sidecar.readToolApprovalPolicy(sessionId as never)
    if (saved !== undefined) return { sessionId, policy: saved, source: 'session', editable: true }
    if (header.origin === 'subagent' && header.parentSession === undefined)
      throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
    // Independent children and ordinary forks snapshot once. Their parent is
    // ancestry, not live authority after that snapshot has been committed.
    const initial =
      header.parentSession === undefined
        ? defaultPolicy()
        : (await read(header.parentSession, nextAncestry, true)).policy
    const policy = await sidecar.readToolApprovalPolicy(sessionId as never, initial)
    if (policy === undefined) throw new Error('ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE')
    return { sessionId, policy, source: 'session', editable: true }
  }
  return read
}
