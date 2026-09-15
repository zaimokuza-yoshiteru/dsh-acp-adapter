import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { AcpRemoteServiceDeps } from '../../remote/service.ts'
import { createMemberModels, type MemberModelDependencies } from './member-models.ts'

/** Read member facts from native Team ownership and each member’s own session. */
export function createTeamManagement(ctx: Context, owns: (provider: string) => boolean, readBindingProvider: (id: string) => Promise<string | undefined> = async () => undefined, modelDependencies?: MemberModelDependencies): NonNullable<AcpRemoteServiceDeps['teamManagement']> {
  const models = modelDependencies === undefined ? undefined : createMemberModels(ctx, modelDependencies)
  const resolve = (id: string) => {
    const teams = ctx.get('agentTeams')
    const agent = ctx.get('agents', false)?.get(id as never)
    if (teams === undefined || agent === undefined || teams.tryMembership(agent)?.role !== 'lead') throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
    const selection = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
    const provider = selection?.pending?.provider ?? agent.session.requestHeader()?.config.provider ?? agent.options.provider
    if (provider === undefined || !owns(provider)) throw new Error('ACP_TEAM_LEAD_REQUIRED')
    return { teams, agent, provider }
  }
  const resolveLead = async (id: string) => {
    if (ctx.get('agentTeams') !== undefined && ctx.get('agents', false)?.get(id as never) === undefined) {
      const provider = await readBindingProvider(id)
      if (provider === undefined || !owns(provider)) throw new Error('ACP_TEAM_LEAD_REQUIRED')
      // Historical reads need not activate the Lead. Reuse the host's deduplicated
      // activation without submitting a prompt or starting the ACP runtime.
      const result = await ctx.get('sessionController')?.resolveAgent(id as never)
      if (result !== undefined && 'error' in result) throw result.error
    }
    return resolve(id)
  }
  const resolveMember = async (leadId: string, memberId: string) => {
    const { teams, agent, provider } = await resolveLead(leadId)
    const member = teams.listMembers(agent).find(row => row.id === memberId && row.role === 'teammate')
    if (member === undefined || await readBindingProvider(memberId) !== provider) throw new Error('ACP_TEAM_MEMBER_REQUIRED')
    return { member, provider }
  }
  const memberModels = async (lead: string, id: string) => {
    if (models === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
    const { provider } = await resolveMember(lead, id)
    const catalog = await models.catalog(provider)
    const facts = await models.facts(id, provider)
    const { member } = await resolveMember(lead, id)
    return { ...facts, models: catalog, writable: facts.writable && (member.status === 'idle' || member.status === 'inactive') }
  }
  return {
    async members(id) {
      const { teams, agent } = await resolveLead(id)
      return await Promise.all(teams.listMembers(agent).filter(row => row.role === 'teammate').map(async row => {
        const child = ctx.get('agents', false)?.get(row.id)
        const session = child?.session ?? ctx.get('sessions')?.get(row.id)
        const selection = session === undefined ? undefined : ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')
        const provider = selection?.pending?.provider ?? session?.requestHeader()?.config.provider ?? child?.options.provider ?? await readBindingProvider(row.id)
        const facts = provider === undefined ? undefined : await models?.facts(row.id, provider)
        return { profileId: provider !== undefined && owns(provider) ? provider.slice(4) : null, sessionId: row.id, name: row.name, status: row.status, description: row.description ?? null,
          model: facts?.currentModel ?? session?.requestHeader()?.config.model ?? child?.options.model ?? null,
          pendingModel: facts?.pendingModel ?? null,
          modelWritable: facts?.writable === true && (row.status === 'idle' || row.status === 'inactive') }
      }))
    },
    models: memberModels,
    async selectModel(lead, id, model) {
      const view = await memberModels(lead, id)
      if (!view.writable || !view.models.some(item => item.id === model)) throw new Error('ACP_TEAM_MODEL_READ_ONLY_OR_UNAVAILABLE')
      const { provider, member } = await resolveMember(lead, id)
      if (member.status !== 'idle' && member.status !== 'inactive') throw new Error('ACP_TEAM_MEMBER_BUSY')
      await models!.save(id, provider, model, () => {
        const owner = resolve(lead)
        const current = owner.teams.listMembers(owner.agent).find(row => row.id === id && row.role === 'teammate')
        if (owner.provider !== provider || current === undefined || (current.status !== 'idle' && current.status !== 'inactive')
          || ctx.get('agents', false)?.get(id as never)?.status === 'running') throw new Error('ACP_TEAM_MEMBER_BUSY')
      })
      return await memberModels(lead, id)
    },
  }
}
