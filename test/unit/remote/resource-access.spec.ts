import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessAction, RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { createTeamManagement } from '../../../src/host/teams/management.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { AcpRemoteService, type AcpRemoteServiceDeps } from '../../../src/remote/service.ts'
import type { AcpApprovalChildView, AcpTeamMemberView } from '../../../src/contract/remote.ts'
import { AcpNativeForkError } from '../../../src/domain/session/native-fork-error.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../../src/contract/config-options.ts'
import { acpDeclaredModelRoute } from '../../../src/contract/model-selection.ts'

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
  'dshAcp/registerNativeFork',
  'dshAcp/nativeForkScope',
  'dshAcp/retryModelSwitchInput',
]

const member: AcpTeamMemberView = {
  sessionId: 'member',
  profileId: 'test',
  name: 'worker',
  status: 'inactive',
  model: 'test-model',
  description: null,
}

async function fixture(
  options: {
    ownedSessionReadGate?: AcpRemoteServiceDeps['ownedSessionReadGate']
    management?: (ctx: Context) => NonNullable<AcpRemoteServiceDeps['teamManagement']>
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Registry.default)
  await ctx.plugin(Access.default)
  await ctx.plugin(Gateway.default)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  let held: readonly RemoteAccessBinding[] = []
  const bindings = vi.fn(() => held)
  ctx.remoteAccess.registerPolicy('acp-resource-test', { bindings })
  const members = vi.fn(async () => [{ ...member, resourcePath: ['lead', member.sessionId] }])
  const models = vi.fn(async () => ({ currentModel: 'test-model', pendingModel: null, models: [], writable: true }))
  const selectModel = vi.fn(async () => ({
    currentModel: 'test-model',
    pendingModel: null,
    models: [],
    writable: true,
  }))
  const backend = vi.fn(async () => 'acp-test')
  const nativeFork = vi.fn(async () => {})
  const retryModelSwitchInput = vi.fn<NonNullable<AcpRemoteServiceDeps['retryModelSwitchInput']>>(async () => {})
  const nativeForkScope = vi.fn(() => '11111111-1111-4111-8111-111111111111')
  const approvalChildren = vi.fn(async (): Promise<readonly AcpApprovalChildView[]> => [
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
  ])
  new AcpRemoteService(ctx, {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    nativeFork,
    retryModelSwitchInput,
    nativeForkScope,
    checkExecutable: async () => true,
    queryVersion: async () => null,
    ownedSessionReadGate: options.ownedSessionReadGate ?? (async () => true),
    teamManagement: options.management?.(ctx) ?? { members, models, selectModel },
    approvalChildren,
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
  const hold = (sessions: readonly string[], global = false, sessionActions = actions) => {
    held = [
      ...sessions.map((id): RemoteAccessBinding => ({
        role: { name: 'acp-test-session', resource: 'session', actions: sessionActions },
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
  return {
    ctx,
    owner,
    restricted,
    hold,
    call,
    members,
    models,
    selectModel,
    approvalChildren,
    backend,
    bindings,
    retryModelSwitchInput,
    nativeFork,
    nativeForkScope,
  }
}

describe('ACP resources through the published Gateway and Peer', () => {
  it('requires both retry and native prompt grants on the same session and passes the actual caller', async () => {
    const h = await fixture()
    const args = { sessionId: 'original', failureSeq: 17 }
    h.hold(['different'], false, [...actions, 'session/prompt'])
    await expect(h.call(h.restricted, 'retryModelSwitchInput', args)).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    h.hold(['original'])
    await expect(h.call(h.restricted, 'retryModelSwitchInput', args)).rejects.toMatchObject({
      code: 'dsh-acp/user-rejected',
    })
    expect(h.retryModelSwitchInput).not.toHaveBeenCalled()
    h.hold(['original'], false, [...actions, 'session/prompt'])
    await h.call(h.restricted, 'retryModelSwitchInput', args)
    expect(h.retryModelSwitchInput).toHaveBeenCalledWith(
      'original',
      17,
      { kind: 'acp-resource-test' },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    const canConfirm = h.retryModelSwitchInput.mock.lastCall![5]!
    expect(canConfirm()).toBe(false)
    h.hold(['original'], false, [...actions, 'session/prompt', 'session/selectModel'])
    expect(canConfirm()).toBe(false)
    h.hold(['original'], false, [...actions, 'session/prompt', 'dshAcp/setAgentSessionOption'])
    expect(canConfirm()).toBe(false)
    h.hold(['original'], false, [...actions, 'session/prompt', 'session/selectModel', 'dshAcp/setAgentSessionOption'])
    expect(canConfirm()).toBe(true)
    h.hold(['different'], false, [...actions, 'session/prompt', 'session/selectModel', 'dshAcp/setAgentSessionOption'])
    expect(canConfirm()).toBe(false)
    await h.call(h.owner, 'retryModelSwitchInput', args)
    expect(h.retryModelSwitchInput).toHaveBeenLastCalledWith(
      'original',
      17,
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })
  it('discovers a bound ACP grandchild of a cold native lead through the Gateway and SQLite owner gate', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'acp-mixed-team-'))
    const sidecar = createAcpSidecar({ root: dir.path })
    try {
      await sidecar.append(SessionId('member'), {
        kind: 'binding',
        time: 1,
        data: {
          provider: 'acp-test',
          agentSessionId: 'agent-1',
          profileId: 'test',
          canonicalCwd: dir.path,
          launchFingerprint: { command: 'test-agent', args: [], envKeys: [] },
          agent: { name: 'test', version: '1' },
          protocolVersion: 1,
          capabilityHash: 'cap',
          configHash: 'config',
          generation: 1,
          bindingEpoch: 1,
          committedPromptOrdinal: 0,
          historyBaseSeq: 0,
          establishedAt: 1,
          dshCommittedSeq: 0,
        },
      })
      const gate = (id: string) => sidecar.hasDurableActivityOwner(SessionId(id))
      expect(await gate('lead')).toBe(false)
      expect(await gate('member')).toBe(true)
      const rows = [
        { id: 'middle', parentId: 'lead', kind: 'child', mode: 'continuable' },
        { id: 'member', parentId: 'middle', kind: 'child', mode: 'continuable' },
      ]
      const readBinding = vi.fn(async (id: string) => {
        const record = await sidecar.readLatestBinding(SessionId(id))
        return record?.status === 'ok' ? record.binding.provider : undefined
      })
      const h = await fixture({
        ownedSessionReadGate: gate,
        management(ctx) {
          ctx.provide('agents', { get: () => undefined } as never)
          ctx.provide('subagents', { listDescendants: async () => rows } as never)
          ctx.provide('sessionQuery', {
            observeSession: async (id: string) => ({
              header: { id },
              inheritedEventCount: 0,
              cursor: 2,
              projections: { values: { subagent: null, subagentCatalog: rows } },
              [Symbol.dispose]() {},
            }),
          } as never)
          return createTeamManagement(ctx, (provider) => provider === 'acp-test', readBinding)
        },
      })
      h.hold(['lead', 'member'])
      await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([])
      expect(readBinding).not.toHaveBeenCalled()
      h.hold(['lead', 'middle', 'member'])
      for (const peer of [h.restricted, h.owner]) {
        await expect(h.call(peer, 'teamMembers', { lead: 'lead' })).resolves.toMatchObject([
          { sessionId: 'member', profileId: 'test' },
        ])
      }
    } finally {
      await sidecar.dispose()
    }
  })

  it('requires ownership of the ACP member for direct controls on a native team', async () => {
    const gate = vi.fn(async (id: string) => id === 'member')
    const h = await fixture({ ownedSessionReadGate: gate })
    h.hold(['lead', 'member'])
    await expect(
      h.call(h.restricted, 'teamMemberModels', { lead: 'lead', sessionId: 'member' }),
    ).resolves.toMatchObject({
      currentModel: 'test-model',
    })
    expect(gate).toHaveBeenCalledExactlyOnceWith('member')
    gate.mockResolvedValue(false)
    await expect(
      h.call(h.owner, 'setTeamMemberModel', { lead: 'lead', sessionId: 'member', model: 'test-model' }),
    ).rejects.toMatchObject({
      code: 'dsh-acp/user-rejected',
    })
    expect(h.selectModel).not.toHaveBeenCalled()
  })

  it('accepts a framed maximum-length member model while rejecting oversized Agent values', async () => {
    const h = await fixture()
    h.hold(['lead', 'member'])
    const model = acpDeclaredModelRoute('dsh-acp:'.padEnd(ACP_CONFIG_IDENTIFIER_MAX, 'x'))
    await expect(
      h.call(h.restricted, 'setTeamMemberModel', { lead: 'lead', sessionId: 'member', model }),
    ).resolves.toMatchObject({ currentModel: 'test-model' })
    expect(h.selectModel).toHaveBeenCalledExactlyOnceWith('lead', 'member', model)
    for (const invalid of [`${model}x`, 'x'.repeat(ACP_CONFIG_IDENTIFIER_MAX + 1)])
      await expect(
        h.call(h.restricted, 'setTeamMemberModel', { lead: 'lead', sessionId: 'member', model: invalid }),
      ).rejects.toMatchObject({ message: 'Invalid member model' })
    expect(h.selectModel).toHaveBeenCalledOnce()
  })

  it('gates the stable fork journal scope by source access and reports initialization failure', async () => {
    const h = await fixture()
    await expect(h.call(h.restricted, 'nativeForkScope', { sessionId: 'source' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.nativeForkScope).not.toHaveBeenCalled()
    h.hold(['source'])
    await expect(h.call(h.restricted, 'nativeForkScope', { sessionId: 'source' })).resolves.toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    h.nativeForkScope.mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    await expect(h.call(h.restricted, 'nativeForkScope', { sessionId: 'source' })).rejects.toMatchObject({
      code: 'dsh-acp/native-fork-scope-unavailable',
      details: { sessionId: 'source' },
    })
  })

  it('preserves typed fork refusal details through the real Gateway', async () => {
    const h = await fixture()
    h.hold(['source', 'child'])
    h.nativeFork.mockRejectedValueOnce(new AcpNativeForkError('child-changed', 'child has new activity'))
    await expect(
      h.call(h.restricted, 'registerNativeFork', { sessionId: 'child', sourceSessionId: 'source', atSeq: 7 }),
    ).rejects.toMatchObject({
      code: 'dsh-acp/native-fork-rejected',
      details: { sessionId: 'child', sourceSessionId: 'source', atSeq: 7, reason: 'child-changed' },
    })
  })
  it('requires access to both the source and child before accepting fork provenance', async () => {
    const h = await fixture()
    for (const allowed of [['source'], ['child'], []]) {
      h.hold(allowed)
      await expect(
        h.call(h.restricted, 'registerNativeFork', { sessionId: 'child', sourceSessionId: 'source', atSeq: 7 }),
      ).rejects.toMatchObject({ code: 'remote-access/denied' })
      expect(h.nativeFork).not.toHaveBeenCalled()
    }
    h.hold(['source', 'child'])
    await h.call(h.restricted, 'registerNativeFork', { sessionId: 'child', sourceSessionId: 'source', atSeq: 7 })
    expect(h.nativeFork).toHaveBeenCalledExactlyOnceWith('child', 'source', 7)
  })
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
  it('does not return child approvals when root access is revoked during directory discovery', async () => {
    const h = await fixture()
    const rows = await h.approvalChildren()
    h.hold(['lead', 'member', 'middle', 'nested'])
    h.approvalChildren.mockImplementationOnce(async () => {
      h.hold(['member', 'middle', 'nested'])
      return rows
    })
    await expect(h.call(h.restricted, 'approvalChildren', { parent: 'lead' })).resolves.toEqual([])
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
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([])
    h.hold(['lead', 'member'])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([member])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.members).toHaveBeenCalledTimes(2)
  })

  it('requires each creation ancestor for member discovery and direct model controls', async () => {
    const h = await fixture()
    const nested = { ...member, sessionId: 'nested', name: 'worker/checker' }
    const internal = { ...nested, resourcePath: ['lead', 'middle', 'nested'] }
    h.members.mockResolvedValue([internal])
    h.hold(['lead', 'nested'])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([])
    for (const method of ['teamMemberModels', 'setTeamMemberModel'])
      await expect(
        h.call(h.restricted, method, {
          lead: 'lead',
          sessionId: 'nested',
          ...(method === 'setTeamMemberModel' ? { model: 'test-model' } : {}),
        }),
      ).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    expect(h.models).not.toHaveBeenCalled()
    expect(h.selectModel).not.toHaveBeenCalled()
    h.hold(['lead', 'middle', 'nested'])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([nested])
    await expect(
      h.call(h.restricted, 'teamMemberModels', { lead: 'lead', sessionId: 'nested' }),
    ).resolves.toMatchObject({ currentModel: 'test-model' })
    // Recheck permissions after discovery yields, including the root resource.
    h.members.mockImplementationOnce(async () => {
      h.hold(['middle', 'nested'])
      return [internal]
    })
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([])
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
      acpBinding: true,
    })
    await expect(h.call(h.restricted, 'backendOf', { sessionId: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.backend).toHaveBeenCalledOnce()
  })
})
