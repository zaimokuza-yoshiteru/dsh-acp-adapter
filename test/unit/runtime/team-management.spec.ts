import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createTeamManagement } from '../../../src/host/teams/management.ts'

function fixture(provider = 'acp-devin') {
  const session = (model: string) => ({ requestHeader: () => ({ config: { model, provider } }) })
  const lead = { id: 'lead', session: session('lead-current'), options: { provider, model: 'lead-old' } }
  const child = { id: 'child', session: session('child-current'), options: { provider, model: 'child-old' } }
  const rows = [
    { id: 'lead', name: 'lead', role: 'lead', provider, status: 'inactive' },
    { id: 'child', name: 'worker', role: 'teammate', provider: 'agent', status: 'inactive', model: 'wrong-native-fallback' },
    { id: 'cold', name: 'cold', role: 'teammate', provider: 'agent', status: 'inactive', model: 'wrong-lead-fallback' },
  ]
  const agents = { get: (id: string) => id === 'lead' ? lead : id === 'child' ? child : undefined }
  const teams = { tryMembership: (agent: unknown) => ({ role: agent === lead ? 'lead' : 'teammate' }), listMembers: () => rows }
  const ctx = { get: (key: string) => key === 'agents' ? agents : key === 'agentTeams' ? teams : key === 'sessions' ? { get: () => undefined } : undefined } as unknown as Context
  return { service: createTeamManagement(ctx, value => value === 'acp-devin', async id => id === 'cold' ? provider : undefined), teams, lead, child, rows }
}
describe('Lead member management', () => {
  it('uses each member’s committed model and leaves an unavailable model unknown', async () => {
    const { service } = fixture()
    expect(await service.members('lead')).toMatchObject([{ sessionId: 'child', model: 'child-current' }, { sessionId: 'cold', model: null }])
  })
  it('groups members by their own ACP profile, never by the subagent backend', async () => {
    const { service, child } = fixture()
    expect(await service.members('lead')).toMatchObject([{ profileId: 'devin' }, { profileId: 'devin' }])
    child.session.requestHeader = () => ({ config: { model: 'other', provider: 'native' } })
    expect(await service.members('lead')).toMatchObject([{ profileId: null }, { profileId: 'devin' }])
  })
  it('rejects member-as-lead, unbound sessions and native-provider lead', async () => {
    await expect(fixture().service.members('child')).rejects.toThrow('LEAD_UNAVAILABLE')
    await expect(fixture().service.members('missing')).rejects.toThrow('LEAD_REQUIRED')
    await expect(fixture('native').service.members('lead')).rejects.toThrow('LEAD_REQUIRED')
  })
  it('activates a bound dormant Lead through the host without prompting or using the member as authority', async () => {
    const { lead, rows, teams } = fixture()
    let active = false
    const resolveAgent = vi.fn(async () => { active = true; return { agent: lead } })
    const ctx = { get: (key: string) => key === 'agents' ? { get: (id: string) => active && id === 'lead' ? lead : undefined }
      : key === 'agentTeams' ? teams : key === 'sessionController' ? { resolveAgent } : undefined } as unknown as Context
    const service = createTeamManagement(ctx, provider => provider === 'acp-devin', async () => 'acp-devin')
    expect(await service.members('lead')).toHaveLength(rows.length - 1)
    expect(resolveAgent).toHaveBeenCalledExactlyOnceWith('lead')
    await service.members('lead')
    expect(resolveAgent).toHaveBeenCalledTimes(1)
  })
  it('does not activate an unowned cold session and preserves host activation errors', async () => {
    const resolveAgent = vi.fn(async () => ({ error: new Error('session/not-found') }))
    const ctx = { get: (key: string) => key === 'agentTeams' ? {} : key === 'sessionController' ? { resolveAgent } : undefined } as unknown as Context
    const create = (provider: string | undefined) => createTeamManagement(ctx, value => value === 'acp-devin', async () => provider)
    await expect(create('native').members('lead')).rejects.toThrow('LEAD_REQUIRED')
    await expect(create(undefined).members('lead')).rejects.toThrow('LEAD_REQUIRED')
    expect(resolveAgent).not.toHaveBeenCalled()
    await expect(create('acp-devin').members('lead')).rejects.toThrow('session/not-found')
  })
})
