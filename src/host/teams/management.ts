import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { AcpRemoteServiceDeps } from '../../remote/service.ts'

/** Read member facts from native Team ownership and each member’s own session. */
export function createTeamManagement(ctx: Context, owns: (provider: string) => boolean, readBindingProvider: (id: string) => Promise<string | undefined> = async () => undefined): NonNullable<AcpRemoteServiceDeps['teamManagement']> {
  const resolve = (id: string) => {
    const teams = ctx.get('agentTeams')
    const agent = ctx.get('agents', false)?.get(id as never)
    if (teams === undefined || agent === undefined || teams.tryMembership(agent)?.role !== 'lead') throw new Error('ACP_TEAM_LEAD_UNAVAILABLE')
    const selection = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
    const provider = selection?.pending?.provider ?? agent.session.requestHeader()?.config.provider ?? agent.options.provider
    if (provider === undefined || !owns(provider)) throw new Error('ACP_TEAM_LEAD_REQUIRED')
    return { teams, agent, provider }
  }
  return {
    async members(id) {
      const { teams, agent } = resolve(id)
      return await Promise.all(teams.listMembers(agent).filter(row => row.role === 'teammate').map(async row => {
        const child = ctx.get('agents', false)?.get(row.id)
        const session = child?.session ?? ctx.get('sessions')?.get(row.id)
        const selection = session === undefined ? undefined : ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')
        const provider = selection?.pending?.provider ?? session?.requestHeader()?.config.provider ?? child?.options.provider ?? await readBindingProvider(row.id)
        return { profileId: provider !== undefined && owns(provider) ? provider.slice(4) : null, sessionId: row.id, name: row.name, status: row.status, description: row.description ?? null,
          model: selection?.pending?.model ?? session?.requestHeader()?.config.model ?? child?.options.model ?? null }
      }))
    },
  }
}
