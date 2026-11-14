import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { AcpRemoteServiceDeps } from '../../remote/service.ts'
import { createMemberModels, type MemberModelDependencies } from './member-models.ts'
import { captureSubagentTree, localSubagentIdentity, subagentPath } from '../subagent/tree.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** ACP controls supplement the native tree without owning a separate Team roster. */
export function createTeamManagement(
  ctx: Context,
  owns: (provider: string) => boolean,
  readBindingProvider: (id: string) => Promise<string | undefined> = async () => undefined,
  modelDependencies?: MemberModelDependencies,
): NonNullable<AcpRemoteServiceDeps['teamManagement']> {
  const models = modelDependencies === undefined ? undefined : createMemberModels(ctx, modelDependencies)
  const resolveLead = async (id: string) => {
    let agent = ctx.get('agents', false)?.get(id as SessionId)
    if (agent === undefined) {
      const provider = await readBindingProvider(id)
      if (provider === undefined || !owns(provider)) throw new Error('ACP_TEAM_LEAD_REQUIRED')
      const result = await ctx.get('sessionController', false)?.resolveAgent(id as SessionId)
      if (result !== undefined && 'error' in result) throw result.error
      agent = ctx.get('agents', false)?.get(id as SessionId)
    }
    const tree = agent === undefined ? undefined : captureSubagentTree(ctx, agent)
    if (agent === undefined || tree?.root !== agent) throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
    return tree
  }
  const localMember = (root: Agent, row: SubagentDescendantListEntry) => {
    if (row.kind !== 'child' || row.mode !== 'continuable') return undefined
    const child = ctx.get('agents', false)?.get(row.id)
    if (
      child !== undefined &&
      (localSubagentIdentity(ctx, child) === undefined || captureSubagentTree(ctx, child)?.root !== root)
    )
      return undefined
    return { row, child }
  }
  const resolveMember = async (leadId: string, memberId: string) => {
    const tree = await resolveLead(leadId)
    const row = (await tree.descendants()).find((entry) => entry.id === memberId)
    const member = row === undefined ? undefined : localMember(tree.root, row)
    if (member === undefined) throw new Error('ACP_TEAM_MEMBER_REQUIRED')
    const provider = await readBindingProvider(memberId)
    const current = () => {
      const route = member.child?.model.current()?.provider ?? member.child?.session.requestHeader()?.config.provider
      return (
        tree.current() &&
        ctx.get('agents', false)?.get(member.row.id) === member.child &&
        (route === undefined || route === provider)
      )
    }
    if (!current() || provider === undefined || !owns(provider)) throw new Error('ACP_TEAM_MEMBER_REQUIRED')
    return { member, provider, current }
  }
  const memberModels = async (lead: string, id: string) => {
    if (models === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
    const owner = await resolveMember(lead, id)
    const catalog = await models.catalog(owner.provider)
    const facts = await models.facts(id, owner.provider)
    if (!owner.current()) throw new Error('ACP_TEAM_MEMBER_REQUIRED')
    const choices =
      facts.unavailableReason === 'model-switch' &&
      facts.currentModel !== null &&
      !catalog.some((model) => model.id === facts.currentModel)
        ? [...catalog, { id: facts.currentModel, name: facts.currentModel }]
        : catalog
    return { ...facts, models: choices, writable: facts.writable && owner.member.child?.status !== 'running' }
  }
  return {
    async members(id) {
      const tree = await resolveLead(id)
      const rows = await tree.descendants()
      const result = []
      for (const row of rows) {
        const member = localMember(tree.root, row)
        const path = subagentPath(tree.root.id, row.id, rows)
        if (member === undefined || path === undefined) continue
        const { child } = member
        const session = child?.session ?? ctx.get('sessions', false)?.get(row.id)
        const provider =
          child?.model.current()?.provider ??
          session?.requestHeader()?.config.provider ??
          child?.options.provider ??
          (await readBindingProvider(row.id))
        if (provider === undefined || !owns(provider)) continue
        const facts = await models?.facts(row.id, provider)
        if (!tree.current() || ctx.get('agents', false)?.get(row.id) !== child)
          throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
        result.push({
          resourcePath: [tree.root.id, ...path.map((entry) => entry.sessionId)],
          profileId: provider.slice(4),
          sessionId: row.id,
          name: row.path ?? row.id,
          status: child?.status === 'running' ? ('running' as const) : ('inactive' as const),
          description: member.row.label ?? null,
          model: facts?.currentModel ?? session?.requestHeader()?.config.model ?? child?.options.model ?? null,
          pendingModel: facts?.pendingModel ?? null,
          modelWritable: facts?.writable === true && child?.status !== 'running',
          modelUnavailableReason: facts?.unavailableReason ?? null,
        })
      }
      if (!tree.current()) throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
      return result
    },
    models: memberModels,
    async selectModel(lead, id, model) {
      const view = await memberModels(lead, id)
      if (!view.writable || !view.models.some((item) => item.id === model))
        throw new Error('ACP_TEAM_MODEL_READ_ONLY_OR_UNAVAILABLE')
      const owner = await resolveMember(lead, id)
      if (owner.member.child?.status === 'running') throw new Error('ACP_TEAM_MEMBER_BUSY')
      if (view.unavailableReason === 'model-switch' && model !== view.currentModel)
        throw LlmError.fromFailure({
          message:
            'This ACP member cannot change models after its first request. Keep its current model or create an independent session.',
          code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
        })
      await models!.save(id, owner.provider, model, () => {
        if (!owner.current() || owner.member.child?.status === 'running') throw new Error('ACP_TEAM_MEMBER_BUSY')
      })
      return await memberModels(lead, id)
    },
  }
}
