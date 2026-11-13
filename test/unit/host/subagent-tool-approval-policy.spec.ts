import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { createToolApprovalPolicyReader } from '../../../src/host/subagent/tool-approval-policy.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-child-policy-'))
  const sidecar = createAcpSidecar({ root: directory })
  const agents = new Map<string, any>()
  const roots = new Map<any, any>()
  const rows: any[] = []
  let listingError: Error | undefined
  let defaultPolicy: 'auto' | 'ask' = 'auto'
  let enabled = true
  ctx.provide('agents', { get: (id: string) => agents.get(id) })
  ctx.provide('agentTeams', { isEnabled: () => enabled } as never)
  ctx.provide('subagents', {
    rootOf(agent: any) {
      const root = roots.get(agent)
      if (agents.get(agent.id) !== agent || root === undefined || agents.get(root.id) !== root)
        throw new Error('UNAUTHORIZED')
      return root
    },
    namesOf: (agent: any) => ({ self: agent.id }),
    listDescendants: async () => {
      if (listingError) throw listingError
      return rows
    },
  } as never)
  ctx.provide('sessionProjections', {
    snapshot: () => ({
      values: { subagent: { seq: 0, mode: 'continuable' }, acpExecution: { externalSubagent: false } },
    }),
  } as never)
  const add = (id: string, provider: string | undefined, parentSession?: string, origin?: 'subagent') => {
    const session = ctx.sessions.prepare(SessionId(id), {
      meta: { ...(parentSession ? { parentSession: SessionId(parentSession) } : {}), ...(origin ? { origin } : {}) },
    })
    ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    if (provider !== undefined)
      session.append('request/header', { header: { config: { provider, model: 'fixture' } }, reason: 'initial' })
    const agent = {
      id,
      session,
      options: { provider },
      model: { current: () => (provider === undefined ? undefined : { provider, model: 'fixture' }) },
    }
    agents.set(id, agent)
    roots.set(agent, origin === 'subagent' ? roots.get(agents.get(parentSession!)) : agent)
    if (origin === 'subagent') rows.push({ kind: 'child', id, parentId: parentSession, mode: 'continuable' })
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
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ctx,
    sidecar,
    agents,
    roots,
    rows,
    add,
    read,
    setDefault: (value: 'auto' | 'ask') => {
      defaultPolicy = value
    },
    setEnabled: (value: boolean) => {
      enabled = value
    },
    failListing: (error: Error) => {
      listingError = error
    },
  }
}

it.each([false, true])(
  'preserves an existing child policy when Team is %s and its parent disappears',
  async (enabled) => {
    const h = await setup()
    h.setEnabled(enabled)
    h.add('parent', 'acp-test')
    h.add('child', 'acp-test', 'parent', 'subagent')
    await h.sidecar.writeToolApprovalPolicy(SessionId('child'), 'ask')
    await h.sidecar.writeToolApprovalPolicy(SessionId('parent'), 'auto')
    h.agents.delete('parent')
    await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
  },
)

it('inherits root policy for new nested members and retains it across Team toggles and dormant creators', async () => {
  const h = await setup()
  h.add('root', 'acp-test')
  h.add('creator', 'acp-test', 'root', 'subagent')
  h.add('leaf', 'acp-test', 'creator', 'subagent')
  await h.sidecar.writeToolApprovalPolicy(SessionId('root'), 'ask')
  h.agents.delete('creator')
  await expect(h.read('leaf')).resolves.toMatchObject({ policy: 'ask', source: 'lead', editable: false })
  h.setEnabled(false)
  await h.sidecar.writeToolApprovalPolicy(SessionId('root'), 'auto')
  await expect(h.read('leaf')).resolves.toMatchObject({ policy: 'auto', source: 'lead', editable: false })
  h.agents.delete('leaf')
  await expect(h.read('leaf')).resolves.toMatchObject({ policy: 'auto', source: 'lead', editable: false })
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('leaf'))).resolves.toBeUndefined()
})

it('uses the configured ACP default under a known native runtime root without changing that root', async () => {
  const h = await setup()
  h.setDefault('ask')
  h.add('root', 'deepseek')
  h.add('child', 'acp-test', 'root', 'subagent')
  await expect(h.read('child')).resolves.toMatchObject({ policy: 'ask', source: 'lead', editable: false })
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('root'))).resolves.toBeUndefined()
})

it('snapshots an ordinary fork independently of its persisted parent', async () => {
  const h = await setup()
  h.add('root', 'acp-test')
  h.add('fork', 'acp-test', 'root')
  await h.sidecar.writeToolApprovalPolicy(SessionId('root'), 'ask')
  await expect(h.read('fork')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
  h.agents.delete('root')
  await expect(h.read('fork')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
})

it('rejects a root replaced while its policy is being read', async () => {
  const h = await setup()
  const root = h.add('root', 'acp-test')
  h.add('child', 'acp-test', 'root', 'subagent')
  const original = h.sidecar.readToolApprovalPolicy.bind(h.sidecar)
  vi.spyOn(h.sidecar, 'readToolApprovalPolicy').mockImplementation(async (id, fallback) => {
    const result = await original(id, fallback)
    if (id === 'root') h.agents.set('root', { ...root })
    return result
  })
  await expect(h.read('child')).rejects.toThrow('ACP_TOOL_APPROVAL_LEAD_CHANGED')
})

it('does not convert an unreadable dormant directory or binding into a default', async () => {
  const h = await setup()
  h.add('root', 'acp-test')
  h.add('child', 'acp-test', 'root', 'subagent')
  h.agents.delete('child')
  const error = new Error('catalog unavailable')
  h.failListing(error)
  await expect(h.read('child')).rejects.toBe(error)
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('child'))).resolves.toBeUndefined()
  vi.spyOn(h.sidecar, 'readLatestBinding').mockRejectedValue(error)
  await expect(h.read('child')).rejects.toBe(error)
})

it('rejects a dormant ancestry cycle without persisting a policy', async () => {
  const h = await setup()
  h.add('a', 'acp-test', 'b', 'subagent')
  h.add('b', 'acp-test', 'a', 'subagent')
  h.agents.clear()
  // Dormant bindings retain their ACP route; lineage itself grants nothing.
  vi.spyOn(h.sidecar, 'readLatestBinding').mockResolvedValue({
    status: 'ok',
    binding: { provider: 'acp-test' },
  } as never)
  await expect(h.read('a')).rejects.toThrow('ACP_TOOL_APPROVAL_PARENT_CYCLE')
  await expect(h.sidecar.readToolApprovalPolicy(SessionId('a'))).resolves.toBeUndefined()
})
