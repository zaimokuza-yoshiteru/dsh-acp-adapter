import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createTeamManagement } from '../../../src/host/teams/management.ts'

function fixture(rootProvider = 'acp-devin') {
  const session = (id: string, model: string, provider: string, child = false) => ({
    id,
    header: child ? { origin: 'subagent', parentSession: 'lead' } : {},
    isOwnSeq: () => true,
    requestHeader: () => ({ config: { model, provider } }),
  })
  const lead = {
    id: 'lead',
    session: session('lead', 'lead-current', rootProvider),
    options: { provider: rootProvider },
  }
  const child = {
    id: 'child',
    status: 'idle',
    session: session('child', 'child-current', 'acp-devin', true),
    options: { provider: 'acp-devin', model: 'child-old' },
  }
  Object.assign(lead, { model: { current: () => lead.session.requestHeader().config } })
  Object.assign(child, { model: { current: () => child.session.requestHeader().config } })
  const live = new Map<string, any>([
    ['lead', lead],
    ['child', child],
  ])
  const rows = [
    { kind: 'child', id: 'child', parentId: 'lead', mode: 'continuable', path: 'worker', label: 'Research' },
    { kind: 'child', id: 'cold', parentId: 'child', mode: 'continuable', path: 'worker/checker', label: 'Check' },
  ]
  const agents = { get: (id: string) => live.get(id) }
  const subagents = {
    rootOf: (value: unknown) => (value === lead || value === child ? lead : undefined),
    namesOf: () => ({ self: 'worker' }),
    listDescendants: vi.fn(async () => rows),
  }
  const resolveAgent = vi.fn(async () => {
    live.set('lead', lead)
    return { agent: lead }
  })
  const services: Record<string, unknown> = {
    agents,
    subagents,
    agentTeams: { isEnabled: () => false },
    sessions: { get: () => undefined },
    sessionController: { resolveAgent },
    sessionProjections: {
      snapshot: () => ({
        values: { subagent: { seq: 0, mode: 'continuable' }, acpExecution: { externalSubagent: false } },
      }),
    },
  }
  const ctx = { get: (key: string) => services[key] } as unknown as Context
  const binding = vi.fn(async (id: string) => (id === 'missing' ? undefined : 'acp-devin'))
  return {
    service: createTeamManagement(ctx, (value) => value.startsWith('acp-'), binding),
    subagents,
    lead,
    child,
    live,
    rows,
    resolveAgent,
    binding,
  }
}

describe('native tree ACP member management', () => {
  it('uses each member model and live state, leaving an unavailable cold model unknown', async () => {
    const h = fixture()
    expect(await h.service.members('lead')).toMatchObject([
      { sessionId: 'child', name: 'worker', profileId: 'devin', model: 'child-current', status: 'inactive' },
      { sessionId: 'cold', name: 'worker/checker', profileId: 'devin', model: null, status: 'inactive' },
    ])
    h.child.status = 'running'
    expect(await h.service.members('lead')).toMatchObject([
      { sessionId: 'child', status: 'running' },
      { sessionId: 'cold', status: 'inactive' },
    ])
    expect(h.resolveAgent).not.toHaveBeenCalled()
  })

  it('supports a native root while filtering native children and keeping ACP profiles separate', async () => {
    const h = fixture('native')
    h.child.session.requestHeader = () => ({ config: { model: 'other', provider: 'acp-codex' } })
    expect(await h.service.members('lead')).toMatchObject([{ profileId: 'codex' }, { profileId: 'devin' }])
    h.child.session.requestHeader = () => ({ config: { model: 'other', provider: 'native' } })
    expect(await h.service.members('lead')).toMatchObject([{ sessionId: 'cold', profileId: 'devin' }])
  })

  it('rejects a child presented as the root and does not activate an unbound root', async () => {
    const h = fixture()
    await expect(h.service.members('child')).rejects.toThrow('LEAD_UNAVAILABLE')
    await expect(h.service.members('missing')).rejects.toThrow('LEAD_REQUIRED')
    expect(h.resolveAgent).not.toHaveBeenCalled()
  })

  it('activates only a bound dormant root through the Host without prompting', async () => {
    const h = fixture()
    h.live.delete('lead')
    expect(await h.service.members('lead')).toHaveLength(2)
    expect(h.resolveAgent).toHaveBeenCalledExactlyOnceWith('lead')
    await h.service.members('lead')
    expect(h.resolveAgent).toHaveBeenCalledTimes(1)
  })

  it('rejects root replacement across an awaited directory read', async () => {
    const h = fixture()
    h.subagents.listDescendants.mockImplementationOnce(async () => {
      h.live.set('lead', { ...h.lead })
      return h.rows
    })
    await expect(h.service.members('lead')).rejects.toMatchObject({ code: 'ACP_SUBAGENT_OWNER_CHANGED' })
  })

  it('does not turn a diagnostic or external execution into a controllable member', async () => {
    const h = fixture()
    h.rows[0]!.mode = 'external'
    Object.assign(h.rows[1]!, { kind: 'diagnostic', reason: 'unavailable' })
    expect(await h.service.members('lead')).toEqual([])
  })
})
