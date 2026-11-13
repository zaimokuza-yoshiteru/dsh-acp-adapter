import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createApprovalChildrenReader } from '../../../src/host/subagent/approval-children.ts'

function harness() {
  const live = new Map<string, Agent>()
  const roots = new Map<Agent, Agent>()
  const rows: any[] = []
  const facts = new Map<string, any>()
  let listing: (() => Promise<void>) | undefined
  const add = (
    id: string,
    parent?: string,
    options: {
      provider?: string
      ordinary?: boolean
      observed?: boolean
      inherited?: boolean
      detached?: boolean
      name?: string
    } = {},
  ) => {
    const agent = {
      id,
      options: { provider: options.provider ?? 'acp-test' },
      session: {
        id,
        header: {
          id,
          ...(parent === undefined ? {} : { parentSession: parent }),
          ...(parent === undefined || options.ordinary ? {} : { origin: 'subagent' }),
        },
        requestHeader: () => ({ config: { provider: options.provider ?? 'acp-test' } }),
        isOwnSeq: () => !options.inherited,
      },
    } as unknown as Agent
    const parentAgent = parent === undefined ? undefined : live.get(parent)
    roots.set(
      agent,
      parentAgent === undefined || options.detached || options.ordinary ? agent : roots.get(parentAgent)!,
    )
    live.set(id, agent)
    facts.set(id, {
      subagent: parent === undefined ? null : { mode: 'continuable', label: id, seq: 0 },
      acpExecution: { externalSubagent: options.observed === true },
    })
    if (parent !== undefined)
      rows.push({
        kind: 'child',
        id,
        parentId: parent,
        mode: options.observed ? 'external' : 'continuable',
        name: options.name ?? id,
        path: parentAgent === roots.get(parentAgent!) ? (options.name ?? id) : `${parent}/${options.name ?? id}`,
        activity: 'inactive',
        hasChildren: false,
      })
    return agent
  }
  const agents = { list: () => [...live.values()], get: (id: string) => live.get(id) }
  const subagents = {
    rootOf: (agent: Agent) => {
      const root = roots.get(agent)
      if (root === undefined || live.get(agent.id) !== agent || live.get(root.id) !== root)
        throw new Error('UNAUTHORIZED')
      return root
    },
    namesOf: (agent: Agent) => ({ self: rows.find((row) => row.id === agent.id)?.path ?? 'lead' }),
    listDescendants: async () => {
      await listing?.()
      return rows
    },
  }
  const projections = { snapshot: (session: Agent['session']) => ({ values: facts.get(session.id) }) }
  const services: Record<string, unknown> = {
    agents,
    subagents,
    sessionProjections: projections,
    agentTeams: { isEnabled: () => false },
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  return {
    add,
    live,
    roots,
    rows,
    facts,
    subagents,
    setListing: (value: typeof listing) => {
      listing = value
    },
    read: createApprovalChildrenReader(ctx, (provider) => provider === 'acp-test'),
  }
}

describe('managed ACP approval descendants', () => {
  it.each(['native', 'acp-test'])('reads named descendants under a %s root while Team is off', async (provider) => {
    const h = harness()
    h.add('root', undefined, { provider })
    h.add('reviewer', 'root', { provider: 'native' })
    h.add('checker', 'reviewer')
    expect(await h.read('root')).toEqual([
      {
        sessionId: 'checker',
        parentSessionId: 'reviewer',
        name: 'reviewer/checker',
        mode: 'continuable',
        path: [
          { sessionId: 'reviewer', name: 'reviewer' },
          { sessionId: 'checker', name: 'checker' },
        ],
      },
    ])
    h.live.delete('reviewer')
    expect(await h.read('root')).toHaveLength(1)
  })

  it('does not infer authority from names, ordinary forks, observed sessions or inherited descriptors', async () => {
    const h = harness()
    h.add('root')
    h.add('other')
    h.add('same-name', 'other', { name: 'reviewer' })
    h.add('ordinary', 'root', { ordinary: true })
    h.add('observed', 'root', { observed: true })
    h.add('inherited', 'root', { inherited: true })
    h.add('detached', 'root', { detached: true })
    expect(await h.read('root')).toEqual([])
  })

  it('rejects replacement of a root while the native directory read is pending', async () => {
    const h = harness()
    h.add('root')
    h.add('child', 'root')
    h.setListing(async () => {
      h.add('root')
    })
    await expect(h.read('root')).rejects.toMatchObject({ code: 'ACP_SUBAGENT_OWNER_CHANGED' })
  })

  it('rejects a child instance with an old root and does not expose incomplete catalog paths', async () => {
    const h = harness()
    h.add('root')
    h.add('child', 'root')
    h.rows[0].parentId = 'missing'
    expect(await h.read('root')).toEqual([])
    h.rows[0].parentId = 'root'
    h.add('root')
    expect(await h.read('root')).toEqual([])
  })
})
