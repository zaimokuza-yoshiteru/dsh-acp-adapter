import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createTeamManagement } from '../../../src/host/teams/management.ts'

function fixture(provider = 'acp-devin') {
  const session = (model: string) => ({ requestHeader: () => ({ config: { model, provider } }) })
  const lead = { id: 'lead', session: session('lead-current'), options: { provider, model: 'lead-old' } }
  const child = { id: 'child', session: session('child-current'), options: { provider, model: 'child-old' } }
  const rows = [
    { id: 'lead', name: 'lead', role: 'lead', provider, status: 'idle' },
    { id: 'child', name: 'worker', role: 'teammate', provider: 'agent', status: 'idle', model: 'wrong-native-fallback' },
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
  it('rejects member-as-lead, inactive lead and native-provider lead', async () => {
    await expect(fixture().service.members('child')).rejects.toThrow('LEAD_UNAVAILABLE')
    await expect(fixture().service.members('missing')).rejects.toThrow('LEAD_UNAVAILABLE')
    await expect(fixture('native').service.members('lead')).rejects.toThrow('LEAD_REQUIRED')
  })
})
