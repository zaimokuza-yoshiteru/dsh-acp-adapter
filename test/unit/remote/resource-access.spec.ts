import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessAction, RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpTeamMemberView } from '../../../src/contract/remote.ts'

// Exercise the exact published Host dispatch and principal implementation,
// without depending on generated plugin artifacts or starting an HTTP server.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const Registry = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-typert-registry')).href)
const Access = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-api-remote-access')).href)
const Gateway = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-api-gateway')).href)
const Connection = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-client-connection')).href)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'acp-resource-test': { readonly kind: 'acp-resource-test' }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

const actions: readonly RemoteAccessAction[] = [
  'dshAcp/teamMembers',
  'dshAcp/approvalChildren',
  'dshAcp/teamMemberModels',
  'dshAcp/setTeamMemberModel',
  'dshAcp/health',
  'dshAcp/projectedSubagentIds',
  'dshAcp/backendOf',
]

const member: AcpTeamMemberView = {
  sessionId: 'member',
  profileId: 'test',
  name: 'worker',
  status: 'inactive',
  model: 'test-model',
  description: null,
}

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Registry.default)
  await ctx.plugin(Access.default)
  await ctx.plugin(Gateway.default)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  let held: readonly RemoteAccessBinding[] = []
  const bindings = vi.fn(() => held)
  ctx.remoteAccess.registerPolicy('acp-resource-test', { bindings })
  const members = vi.fn(async () => [member])
  const models = vi.fn(async () => ({ currentModel: 'test-model', pendingModel: null, models: [], writable: true }))
  const selectModel = vi.fn(async () => ({
    currentModel: 'test-model',
    pendingModel: null,
    models: [],
    writable: true,
  }))
  const backend = vi.fn(async () => 'acp-test')
  new AcpRemoteService(ctx, {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    checkExecutable: async () => true,
    queryVersion: async () => null,
    ownedSessionReadGate: async () => true,
    teamManagement: { members, models, selectModel },
    approvalChildren: () => [
      {
        sessionId: 'member',
        parentSessionId: 'lead',
        name: 'worker',
        mode: 'continuable',
        path: [{ sessionId: 'member', name: 'worker' }],
      },
      {
        sessionId: 'nested',
        parentSessionId: 'middle',
        name: 'nested worker',
        mode: 'continuable',
        path: [
          { sessionId: 'middle', name: 'middle' },
          { sessionId: 'nested', name: 'nested worker' },
        ],
      },
    ],
    projectedSubagentIds: async () => ['lead', 'member', 'other'],
    listLiveSessions: () =>
      ['lead', 'member', 'other'].map((sessionId) => ({
        sessionId,
        continuity: { status: 'ok', cause: null, detail: null },
      })),
    backendFacts: { readBindingProvider: backend, peekHeaderProvider: backend, hasLiveAgent: () => true },
  })
  const owner: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'owner' } })
  const restricted: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'acp-resource-test' } })
  const hold = (sessions: readonly string[], global = false) => {
    held = [
      ...sessions.map((id): RemoteAccessBinding => ({
        role: { name: 'acp-test-session', resource: 'session', actions },
        resource: { kind: 'session', id: SessionId(id) },
      })),
      ...(global
        ? [
            {
              role: { name: 'acp-test-global', resource: 'global' as const, actions },
              resource: { kind: 'global' as const },
            },
          ]
        : []),
    ]
  }
  const call = (peer: PeerScope, method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({ peer, namespace: 'dshAcp', method, args })
  return { ctx, owner, restricted, hold, call, members, models, selectModel, backend, bindings }
}

describe('ACP resources through the published RC1 Gateway and Peer', () => {
  it('filters child approvals by every current path resource and permits native parent discovery', async () => {
    const h = await fixture()
    h.hold(['lead'])
    await expect(h.call(h.restricted, 'approvalChildren', { parent: 'lead' })).resolves.toEqual([])
    h.hold(['lead', 'member', 'nested'])
    await expect(h.call(h.restricted, 'approvalChildren', { parent: 'lead' })).resolves.toMatchObject([
      { sessionId: 'member' },
    ])
    h.hold(['lead', 'middle', 'nested'])
    await expect(h.call(h.restricted, 'approvalChildren', { parent: 'lead' })).resolves.toMatchObject([
      { sessionId: 'nested' },
    ])
    h.hold(['member'])
    await expect(h.call(h.restricted, 'approvalChildren', { parent: 'lead' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    await expect(h.call(h.owner, 'approvalChildren', { parent: 'native-parent' })).resolves.toHaveLength(2)
  })
  it('keeps owner defaults and complete discovery without consulting non-owner policies', async () => {
    const h = await fixture()
    await expect(h.call(h.owner, 'teamMembers', { lead: 'lead' })).resolves.toEqual([member])
    await expect(h.call(h.owner, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: ['lead', 'member', 'other'] })
    await expect(h.call(h.owner, 'health')).resolves.toMatchObject({
      liveSessions: [{ sessionId: 'lead' }, { sessionId: 'member' }, { sessionId: 'other' }],
    })
    expect(h.bindings).not.toHaveBeenCalled()
  })

  it('authorizes a lead resource without requiring global access and refuses another lead before reading', async () => {
    const h = await fixture()
    h.hold(['lead'])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([member])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.members).toHaveBeenCalledTimes(1)
  })

  it.each(['teamMemberModels', 'setTeamMemberModel'])(
    'requires both lead and member resources for %s',
    async (method) => {
      const h = await fixture()
      const args = {
        lead: 'lead',
        sessionId: 'member',
        ...(method === 'setTeamMemberModel' ? { model: 'test-model' } : {}),
      }
      h.hold(['member'])
      await expect(h.call(h.restricted, method, args)).rejects.toMatchObject({ code: 'remote-access/denied' })
      h.hold(['lead'])
      await expect(h.call(h.restricted, method, args)).rejects.toMatchObject({ code: 'remote-access/denied' })
      expect(h.members).not.toHaveBeenCalled()
      expect(h.models).not.toHaveBeenCalled()
      expect(h.selectModel).not.toHaveBeenCalled()
      h.hold(['lead', 'member'])
      await expect(h.call(h.restricted, method, args)).resolves.toMatchObject({ currentModel: 'test-model' })
    },
  )

  it('filters session identities inside global discoveries by the actual caller and current bindings', async () => {
    const h = await fixture()
    h.hold(['member'], true)
    await expect(h.call(h.restricted, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: ['member'] })
    await expect(h.call(h.restricted, 'health')).resolves.toMatchObject({ liveSessions: [{ sessionId: 'member' }] })
    h.hold([], true)
    await expect(h.call(h.restricted, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: [] })
    await expect(h.call(h.restricted, 'health')).resolves.toMatchObject({ liveSessions: [] })
  })

  it('uses the native default sessionId resource for ordinary ACP reads before opening backend facts', async () => {
    const h = await fixture()
    h.hold(['member'])
    await expect(h.call(h.restricted, 'backendOf', { sessionId: 'member' })).resolves.toEqual({
      state: 'established',
      provider: 'acp-test',
    })
    await expect(h.call(h.restricted, 'backendOf', { sessionId: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.backend).toHaveBeenCalledOnce()
  })
})
