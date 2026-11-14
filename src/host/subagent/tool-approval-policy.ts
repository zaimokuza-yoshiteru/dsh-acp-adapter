import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpToolApprovalPolicySnapshot } from '../../contract/remote.ts'
import { captureSubagentTree, localSubagentIdentity } from './tree.ts'
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
      const committedProvider = session.requestHeader()?.config.provider
      // A native request may have completed while this plugin was disabled.
      // Its old ACP binding and preference no longer govern a new child's
      // initialization. Pending selection alone does not establish that switch.
      if (committedProvider !== undefined && acpAgentIdFromRoute(committedProvider) === undefined)
        return { sessionId, policy: defaultPolicy(), source: 'session', editable: false }
    }
    const binding = await sidecar.readLatestBinding(sessionId as never)
    if (binding?.status === 'outdated') throw new Error('ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE')
    const agent = ctx.get('agents', false)?.get(sessionId as never)
    const provider =
      binding?.binding.provider ??
      agent?.model.current()?.provider ??
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
    // Existing snapshots retain their policy across this migration. New local
    // descendants inherit their runtime root, independently of the Team toggle.
    const saved = await sidecar.readToolApprovalPolicy(sessionId as never)
    if (saved !== undefined) return { sessionId, policy: saved, source: 'session', editable: true }
    if (header.origin === 'subagent') {
      let root: Agent | undefined
      let tree: ReturnType<typeof captureSubagentTree>
      if (agent !== undefined) {
        tree = captureSubagentTree(ctx, agent)
        if (tree === undefined || tree.root === agent || localSubagentIdentity(ctx, agent) === undefined)
          throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
        root = tree.root
      } else {
        // Durable lineage locates a candidate only. The native root's catalog
        // must independently confirm this dormant local descendant below it.
        const seen = new Set<string>([sessionId])
        let ancestor = header
        while (ancestor.origin === 'subagent') {
          const parentId = ancestor.parentSession
          if (parentId === undefined || seen.has(parentId)) throw new Error('ACP_TOOL_APPROVAL_PARENT_CYCLE')
          seen.add(parentId)
          const parent =
            sessionOf(parentId)?.header ?? (await ctx.get('sessionPersistence', false)?.stat(parentId))?.header
          if (parent === undefined) throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
          ancestor = parent
        }
        root = ctx.get('agents', false)?.get(ancestor.id)
        if (root === undefined) {
          const activated = await ctx.get('sessionController', false)?.resolveAgent(ancestor.id)
          if (activated !== undefined && 'error' in activated) throw activated.error
          root = ctx.get('agents', false)?.get(ancestor.id)
        }
        tree = root === undefined ? undefined : captureSubagentTree(ctx, root)
        if (root === undefined || tree?.root !== root) throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
        const rows = await tree.descendants()
        if (!rows.some((row) => row.kind === 'child' && row.id === sessionId && row.mode === 'continuable'))
          throw new Error('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
      }
      const policy = await read(root.id, nextAncestry, true)
      if (!tree.current() || (agent === undefined && ctx.get('agents', false)?.get(sessionId as never) !== undefined))
        throw new Error('ACP_TOOL_APPROVAL_LEAD_CHANGED')
      return { sessionId, policy: policy.policy, source: 'lead', editable: false }
    }
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
