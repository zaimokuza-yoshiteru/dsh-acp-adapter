import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { createToolApprovalPolicyReader } from '../../../src/host/subagent/tool-approval-policy.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function setup(teams = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const root = mkdtempSync(join(tmpdir(), 'dsh-acp-child-policy-'))
  const sidecar = createAcpSidecar({ root })
  const agents = new Map<string, any>()
  const rows = new Map<string, { id: string; role: 'teammate'; status: string }>()
  const members = new Set<string>()
  let rosterError: Error | undefined
  let defaultPolicy: 'auto' | 'ask' = 'auto'
  ctx.provide('agents', { get: (id: string) => agents.get(id) })
  if (teams)
    ctx.provide('agentTeams', {
      tryMembership: (agent: any) => {
        if (agents.get(agent.id) !== agent) return undefined
        if (members.has(agent.id)) {
          const lead = agents.get(agent.session.header.parentSession)
          return lead === undefined ? undefined : { root: lead, id: lead.id, role: 'teammate' }
        }
        if (agent.session.header.origin === 'subagent') return undefined
        return { root: agent, id: agent.id, role: 'lead' }
      },
      listMembers: () => {
        if (rosterError) throw rosterError
        return [...rows.values()]
      },
    } as never)
  const add = (id: string, provider: string | undefined, parentSession?: string, origin?: 'subagent') => {
    const session = ctx.sessions.prepare(SessionId(id), {
      meta: { ...(parentSession ? { parentSession: SessionId(parentSession) } : {}), ...(origin ? { origin } : {}) },
    })
    ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const agent = { id, session, options: { provider } }
    agents.set(id, agent)
    return agent
  }
  const read = createToolApprovalPolicyReader(ctx, {
    sidecar,
    sessionOf: (id) => ctx.sessions.get(SessionId(id)),
    ownsProvider: (id) => id === 'test',
    defaultPolicy: () => defaultPolicy,
  })
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await sidecar.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    ctx,
    sidecar,
    agents,
    rows,
    members,
    add,
    read,
    setDefault: (value: 'auto' | 'ask') => {
      defaultPolicy = value
    },
    failRoster: (error: Error) => {
      rosterError = error
    },
  }
}

it.each([false, true])(
  'snapshots an independent ACP child with Teams=%s and survives its parent disposal',
  async (teams) => {
    const h = await setup(teams)
    h.add('parent', 'acp-test')
    h.add('child', 'acp-test', 'parent', 'subagent')
    await h.sidecar.writeToolApprovalPolicy(SessionId('parent'), 'ask')
    await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await h.sidecar.writeToolApprovalPolicy(SessionId('parent'), 'auto')
    h.agents.delete('parent')
    await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
  },
)

it.each([false, true])(
  'initializes from the configured ACP default only for a known native parent, Teams=%s',
  async (teams) => {
    const h = await setup(teams)
    h.setDefault('ask')
    h.add('native-parent', 'deepseek')
    h.add('child', 'acp-test', 'native-parent', 'subagent')
    await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await expect(h.sidecar.readToolApprovalPolicy(SessionId('native-parent'))).resolves.toBeUndefined()
    h.setDefault('auto')
    await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask' })
  },
)

it('keeps verified Team members on their live Lead preference instead of a child snapshot', async () => {
  const h = await setup()
  h.add('lead', 'acp-test')
  h.add('member', 'acp-test', 'lead', 'subagent')
  h.members.add('member')
  h.rows.set('member', { id: 'member', role: 'teammate', status: 'inactive' })
  await h.sidecar.writeToolApprovalPolicy(SessionId('lead'), 'ask')
  await expect(h.read('member')).resolves.toMatchObject({ policy: 'ask', source: 'lead', editable: false })
  await h.sidecar.writeToolApprovalPolicy(SessionId('lead'), 'auto')
  await expect(h.read('member')).resolves.toMatchObject({ policy: 'auto', source: 'lead', editable: false })
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('member'))).resolves.toBeUndefined()
  h.add('grandchild', 'acp-test', 'member', 'subagent')
  await expect(h.read('grandchild')).resolves.toMatchObject({ policy: 'auto', source: 'session', editable: true })
})

it('rejects a Lead replaced while its preference is being read', async () => {
  const h = await setup()
  const lead = h.add('lead', 'acp-test')
  h.add('member', 'acp-test', 'lead', 'subagent')
  h.members.add('member')
  const original = h.sidecar.readToolApprovalPolicy.bind(h.sidecar)
  vi.spyOn(h.sidecar, 'readToolApprovalPolicy').mockImplementation(async (id, fallback) => {
    const result = await original(id, fallback)
    if (id === 'lead') h.agents.set('lead', { ...lead })
    return result
  })
  await expect(h.read('member')).rejects.toThrow('ACP_TOOL_APPROVAL_LEAD_CHANGED')
})

it('does not convert an unreadable Team roster or sidecar into an independent default', async () => {
  const h = await setup()
  h.add('lead', 'acp-test')
  h.add('child', 'acp-test', 'lead', 'subagent')
  const error = new Error('authoritative roster unavailable')
  h.failRoster(error)
  await expect(h.read('child')).rejects.toBe(error)
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('child'))).resolves.toBeUndefined()
  const storageError = new Error('binding store unavailable')
  vi.spyOn(h.sidecar, 'readLatestBinding').mockRejectedValue(storageError)
  await expect(h.read('child')).rejects.toBe(storageError)
})

it.each(['missing', 'unknown', 'removed-acp'])('does not initialize from an unverifiable %s parent', async (kind) => {
  const h = await setup(false)
  if (kind !== 'missing') h.add('parent', kind === 'unknown' ? undefined : 'acp-removed')
  h.add('child', 'acp-test', 'parent', 'subagent')
  await expect(h.read('child')).rejects.toThrow(/ACP_TOOL_APPROVAL_SESSION_(?:UNAVAILABLE|NOT_ACP)/)
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('child'))).resolves.toBeUndefined()
})

it('rejects ancestry cycles without persisting a preference', async () => {
  const h = await setup(false)
  h.add('a', 'acp-test', 'b', 'subagent')
  h.add('b', 'acp-test', 'a', 'subagent')
  await expect(h.read('a')).rejects.toThrow('ACP_TOOL_APPROVAL_PARENT_CYCLE')
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('a'))).resolves.toBeUndefined()
})
