import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createApprovalChildrenReader } from '../../../src/host/subagent/approval-children.ts'

function harness() {
  const live = new Map<string, Agent>()
  const owners = new Map<string, Agent>()
  const teamNames = new Map<string, string>()
  const facts = new Map<
    string,
    {
      subagent: { mode: 'continuable' | 'one-shot'; label: string; seq: number } | null
      acpExecution: { externalSubagent: boolean }
    }
  >()
  const add = (
    id: string,
    parent?: string,
    options: {
      provider?: string
      ordinary?: boolean
      observed?: boolean
      inheritedDescriptor?: boolean
      detached?: boolean
      oneShot?: boolean
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
        isOwnSeq: () => options.inheritedDescriptor !== true,
      },
    } as unknown as Agent
    live.set(id, agent)
    if (parent !== undefined && !options.detached) owners.set(id, live.get(parent)!)
    facts.set(id, {
      subagent:
        parent === undefined
          ? null
          : { mode: options.oneShot ? 'one-shot' : 'continuable', label: `label-${id}`, seq: 0 },
      acpExecution: { externalSubagent: options.observed === true },
    })
    return agent
  }
  const agents = {
    list: () => [...live.values()],
    get: (id: string) => live.get(id),
    isOwnedBy: (id: string, owner: Agent) => owners.get(id) === owner,
  }
  const projections = { snapshot: (session: Agent['session']) => ({ values: facts.get(session.id) }) }
  const ctx = {
    get: (name: string) =>
      name === 'agents'
        ? agents
        : name === 'sessionProjections'
          ? projections
          : name === 'agentTeams'
            ? {
                tryMembership: (agent: Agent) =>
                  teamNames.has(agent.id) ? { role: 'teammate', name: teamNames.get(agent.id) } : undefined,
              }
            : undefined,
  } as unknown as Context
  return {
    add,
    live,
    owners,
    teamNames,
    read: createApprovalChildrenReader(ctx, (provider) => provider === 'acp-test'),
  }
}

describe('managed ACP approval descendants', () => {
  it('keeps native Team display names and uses the active request route rather than a future selection', () => {
    const h = harness()
    h.add('parent')
    h.add('team-child', 'parent')
    h.teamNames.set('team-child', 'Researcher')
    const native = h.add('native-request', 'parent')
    Object.assign(native.session, { requestHeader: () => ({ config: { provider: 'native' } }) })
    expect(h.read('parent')).toMatchObject([{ name: 'Researcher', path: [{ name: 'Researcher' }] }])
    h.teamNames.clear()
    expect(h.read('parent')).toMatchObject([{ name: 'label-team-child' }])
  })
  it.each(['native', 'acp-test'])(
    'discovers direct and nested ACP children under a %s parent without Teams',
    (provider) => {
      const h = harness()
      h.add('parent', undefined, { provider })
      h.add('direct', 'parent')
      h.add('native-child', 'parent', { provider: 'native' })
      h.add('nested', 'native-child')
      h.add('one-shot', 'parent', { oneShot: true })
      expect(h.read('parent')).toEqual([
        {
          sessionId: 'direct',
          parentSessionId: 'parent',
          name: 'label-direct',
          mode: 'continuable',
          path: [{ sessionId: 'direct', name: 'label-direct' }],
        },
        {
          sessionId: 'nested',
          parentSessionId: 'native-child',
          name: 'label-nested',
          mode: 'continuable',
          path: [
            { sessionId: 'native-child', name: 'label-native-child' },
            { sessionId: 'nested', name: 'label-nested' },
          ],
        },
        {
          sessionId: 'one-shot',
          parentSessionId: 'parent',
          name: 'label-one-shot',
          mode: 'one-shot',
          path: [{ sessionId: 'one-shot', name: 'label-one-shot' }],
        },
      ])
    },
  )

  it('excludes ordinary forks, observed records, inherited descriptors and detached runtime roots', () => {
    const h = harness()
    h.add('parent')
    h.add('ordinary', 'parent', { ordinary: true })
    h.add('observed', 'parent', { observed: true })
    h.add('inherited', 'parent', { inheritedDescriptor: true })
    h.add('detached', 'parent', { detached: true })
    for (const id of ['ordinary', 'observed', 'inherited', 'detached']) h.add(`${id}-descendant`, id)
    expect(h.read('parent')).toEqual([])
  })

  it('rejects stale exact parent objects, vanished owners and ownership cycles', () => {
    const h = harness()
    h.add('parent')
    h.add('child', 'parent')
    h.add('parent')
    expect(h.read('parent')).toEqual([])
    h.live.delete('parent')
    expect(h.read('parent')).toEqual([])
    h.add('root')
    const first = h.add('first', 'root')
    const second = h.add('second', 'first')
    Object.assign(first.session.header, { parentSession: 'second' })
    h.owners.set('first', second)
    expect(h.read('root')).toEqual([])
  })
})
