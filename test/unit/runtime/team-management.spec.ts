import { describe, expect, it, vi } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
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
  const release = vi.fn()
  const observeSession = vi.fn(async (id: string) => {
    if (id === 'missing') throw new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
    return {
      header: { id, origin: id === 'child' ? 'subagent' : 'user' },
      cursor: 3,
      inheritedEventCount: 2,
      projections: { values: { subagent: null as null | { seq: number }, subagentCatalog: rows } },
      [Symbol.dispose]: release,
    }
  })
  const services: Record<string, unknown> = {
    agents,
    subagents,
    agentTeams: { isEnabled: () => false },
    sessions: { get: () => undefined },
    sessionController: { resolveAgent },
    sessionQuery: { observeSession },
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
    release,
    observeSession,
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

  it('treats a live child, a dormant child and a missing root as ineligible without activation', async () => {
    const h = fixture()
    expect(await h.service.members('child')).toEqual([])
    h.live.delete('child')
    expect(await h.service.members('child')).toEqual([])
    expect(await h.service.members('missing')).toEqual([])
    expect(h.resolveAgent).not.toHaveBeenCalled()
    expect(h.subagents.listDescendants).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledOnce()
  })

  it.each(['native', 'acp-devin'])(
    'reads a dormant %s root and its local ACP descendants without activation',
    async (provider) => {
      const h = fixture(provider)
      h.live.clear()
      h.binding.mockImplementation(async (id) => (id === 'cold' ? 'acp-devin' : undefined))
      expect(await h.service.members('lead')).toMatchObject([
        { resourcePath: ['lead', 'child', 'cold'], profileId: 'devin' },
      ])
      expect(h.binding).not.toHaveBeenCalledWith('lead')
      expect(h.resolveAgent).not.toHaveBeenCalled()
      expect(h.release).toHaveBeenCalledOnce()
      h.binding.mockClear()
      expect(await h.service.members('lead', (id) => id !== 'child')).toEqual([])
      expect(h.binding).not.toHaveBeenCalled()
    },
  )

  it('checks owned legacy descriptors and accepts inherited descriptors on independent forks', async () => {
    const h = fixture()
    h.live.clear()
    const observation = await h.observeSession('lead')
    for (const [seq, expected] of [
      [2, 0],
      [1, 2],
    ] as const) {
      h.observeSession.mockResolvedValueOnce({
        ...observation,
        projections: { values: { subagent: { seq }, subagentCatalog: h.rows } },
      })
      expect(await h.service.members('lead')).toHaveLength(expected)
    }
    expect(h.resolveAgent).not.toHaveBeenCalled()
  })

  it('propagates a cold catalog read failure and rejects activation during a dormant directory read', async () => {
    const h = fixture()
    h.live.clear()
    h.observeSession.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(h.service.members('lead')).rejects.toThrow('disk unavailable')
    h.subagents.listDescendants.mockImplementationOnce(async () => {
      h.live.set('lead', h.lead)
      return h.rows
    })
    await expect(h.service.members('lead')).rejects.toMatchObject({ code: 'ACP_SUBAGENT_OWNER_CHANGED' })
    expect(h.release).toHaveBeenCalledOnce()
  })

  it('rejects root replacement across an awaited directory read', async () => {
    const h = fixture()
    h.subagents.listDescendants.mockImplementationOnce(async () => {
      h.live.set('lead', { ...h.lead })
      return h.rows
    })
    await expect(h.service.members('lead')).rejects.toMatchObject({ code: 'ACP_SUBAGENT_OWNER_CHANGED' })
  })

  it('indexes each wide catalog cut once and reflects the next catalog immediately', async () => {
    const h = fixture()
    h.rows.length = 0
    let idReads = 0
    for (let index = 0; index < 128; index++) {
      const id = `worker-${index}`
      h.rows.push({
        kind: 'child',
        get id() {
          idReads++
          return id
        },
        parentId: 'lead',
        mode: 'continuable',
        path: id,
        label: id,
      })
    }
    const members = await h.service.members('lead')
    expect(members.map((member) => member.resourcePath)).toEqual(
      Array.from({ length: 128 }, (_, index) => ['lead', `worker-${index}`]),
    )
    // Re-indexing all 128 rows for each path would read each id at least 128 times.
    expect(idReads).toBeLessThan(16 * h.rows.length)
    h.rows.splice(1)
    expect(await h.service.members('lead')).toHaveLength(1)
  })

  it('does not turn a diagnostic or external execution into a controllable member', async () => {
    const h = fixture()
    h.rows[0]!.parentId = 'cold'
    expect(await h.service.members('lead')).toEqual([])
    h.rows[0]!.parentId = 'lead'
    h.rows[0]!.mode = 'external'
    expect(await h.service.members('lead')).toEqual([])
    Object.assign(h.rows[1]!, { kind: 'diagnostic', reason: 'unavailable' })
    expect(await h.service.members('lead')).toEqual([])
  })
})
