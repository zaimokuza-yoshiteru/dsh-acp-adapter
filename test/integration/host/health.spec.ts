import { supportsLocalApprovalReview } from '../../../src/contract/approval-review.ts'
// Host Remote integration coverage for the current additive API.
// Legacy options, permission/elicitation brokers, and model-switch endpoints
// are intentionally not part of the public Remote contract anymore.

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  AcpRemoteService,
  type AcpHealthRegistryLike,
  type AcpRemoteServiceDeps,
  type AcpProbeSnapshotLike,
} from '../../../src/remote/service.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { ACP_PROBE_CACHE_OK_TTL_MS, acpProbeConfigKey } from '../../../src/domain/session/agent-config.ts'
import type { AcpRecoveryView } from '../../../src/contract/remote.ts'
import { acpDeclaredModelRoute, ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { TYPERT } from '../../../lib/typert.host.js'

const DEVIN: AcpAgentConfig = {
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  env: {},
  loginHint: 'devin auth login',
}

const PROBE: AcpProbeSnapshotLike = {
  key: acpProbeConfigKey(DEVIN),
  at: Date.now(),
  result: {
    kind: 'ok',
    models: [{ id: 'fast' }],
    authMethods: [{ id: 'browser', name: 'Browser' }],
    agentInfo: { name: 'devin-acp', version: '1.0.0' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
  },
}

function registry(
  agents: Record<string, AcpAgentConfig> = { devin: DEVIN },
  snapshots: Record<string, AcpProbeSnapshotLike | undefined> = { 'acp-devin': PROBE },
): AcpHealthRegistryLike {
  return {
    agents: () => new Map(Object.entries(agents)),
    probeCacheFor: () => ({
      probeSnapshot: (route) => snapshots[route],
      invalidateProbe: () => {},
      listModels: async () => [],
    }),
  }
}

function service(extra: Partial<AcpRemoteServiceDeps> = {}) {
  const ctx = new Context()
  const instance = new AcpRemoteService(ctx, {
    registry: registry(),
    checkExecutable: async () => true,
    queryVersion: async () => '1.0.0',
    ...extra,
  })
  return { ctx, instance }
}

describe('AcpRemoteService current public surface', () => {
  it('offers only cached named models on a supported local Devin profile', async () => {
    const source = { ...DEVIN, runtime: 'devin' as const }
    const cloud = { ...source, args: ['acp', '--cloud'] }
    const handshake = { name: 'affogato', title: 'Devin Agent', version: '3000.14.30821' }
    const seam = { localExecution: true as const, resolveExecutable: vi.fn(), spawn: vi.fn() }
    const snap = {
      at: Date.now(),
      key: acpProbeConfigKey(source),
      result: {
        kind: 'ok' as const,
        agentInfo: handshake,
        models: [
          { id: ACP_CURRENT_CONFIG_MODEL_ID },
          { id: acpDeclaredModelRoute('dsh-acp:custom'), name: 'Custom' },
          { id: 'swe-2-high' },
        ],
      },
    }
    const check = (snapshot: AcpProbeSnapshotLike | undefined, local: boolean) =>
      service({
        registry: registry({ custom: source, remote: cloud }, { 'acp-custom': snapshot }),
        subprocess: { ok: true, seam: local ? seam : { spawn: seam.spawn, resolveExecutable: seam.resolveExecutable } },
      }).instance
    const instance = check(snap, true)
    const rows = (await instance.health()).providers
    const local = rows.find((row) => row.id === 'custom')!
    if (supportsLocalApprovalReview(process.platform)) {
      expect(local.devinReviewModels).toEqual([
        { id: 'dsh-acp:custom', name: 'Custom' },
        { id: 'swe-2-high', name: 'swe-2-high' },
      ])
    } else {
      expect(local.devinReviewModels).toBeUndefined()
    }
    expect(rows.find((row) => row.id === 'remote')!.devinReviewModels).toBeUndefined()
    expect(local.reviewVersionUnsupported).toBeUndefined()
    const unavailable: Array<AcpProbeSnapshotLike | undefined> = [
      undefined,
      { ...snap, key: 'another-profile' },
      { ...snap, result: { kind: 'error', failureKind: 'auth-required', error: { message: 'Check login' } } },
      { ...snap, result: { kind: 'ok', models: snap.result.models } },
      { ...snap, result: { ...snap.result, agentInfo: { ...handshake, version: '' } } },
      { ...snap, result: { ...snap.result, agentInfo: { ...handshake, version: 'unknown' } } },
      { ...snap, result: { ...snap.result, agentInfo: { ...handshake, title: 'Other', version: '1.0.0' } } },
      { ...snap, result: { ...snap.result, agentInfo: { ...handshake, name: 'unrecognized' } } },
    ]
    for (const snapshot of unavailable) {
      const row = (await check(snapshot, true).health()).providers[0]
      expect(row?.devinReviewModels).toBeUndefined()
      expect(row?.reviewVersionUnsupported).toBeUndefined()
    }
    for (const version of ['3000.14.30820', '3000.14.30822']) {
      const mismatch = { ...snap, result: { ...snap.result, agentInfo: { ...handshake, version } } }
      const row = (await check(mismatch, true).health()).providers[0]
      expect(row?.probe.status).toBe('ok')
      expect(row?.devinReviewModels).toBeUndefined()
      expect(row?.reviewVersionUnsupported).toBe(supportsLocalApprovalReview(process.platform) ? true : undefined)
      expect((await check(mismatch, false).health()).providers[0]?.reviewVersionUnsupported).toBeUndefined()
    }
    const empty = { ...snap, result: { ...snap.result, models: [{ id: ACP_CURRENT_CONFIG_MODEL_ID }] } }
    expect((await check(empty, true).health()).providers[0]?.devinReviewModels).toEqual(
      supportsLocalApprovalReview(process.platform) ? [] : undefined,
    )
    const remoteHost = await check(snap, false).health()
    expect(remoteHost.localReviewUnavailable).toBe(true)
    expect(remoteHost.providers[0]?.devinReviewModels).toBeUndefined()
  })
  it('discovers the verified local OpenCode profile without rebinding generic profiles or exposing credentials', async () => {
    const config = { name: 'Work', command: 'opencode', args: ['acp'], env: { TOKEN: 'test-secret' } }
    const seam = { localExecution: true as const, resolveExecutable: vi.fn(), spawn: vi.fn() }
    const snap = {
      at: Date.now(),
      key: acpProbeConfigKey(config),
      result: {
        kind: 'ok' as const,
        agentInfo: { name: 'OpenCode', version: '2.3.2' },
        models: [{ id: 'work/fast' }, { id: 'implicit' }, { id: ACP_CURRENT_CONFIG_MODEL_ID }],
      },
    }
    const { instance } = service({
      subprocess: { ok: true, seam },
      registry: registry(
        { one: config, two: config },
        {
          'acp-one': snap,
          'acp-two': { ...snap, result: { ...snap.result, agentInfo: { name: 'OpenCode', version: '1.2.3' } } },
        },
      ),
    })
    const [one, two] = (await instance.health()).providers
    expect(one?.openCodeReviewModels).toEqual(
      supportsLocalApprovalReview(process.platform) ? [{ id: 'work/fast', name: 'work/fast' }] : undefined,
    )
    expect(one?.reviewVersionUnsupported).toBeUndefined()
    expect(two?.reviewVersionUnsupported).toBe(supportsLocalApprovalReview(process.platform) ? true : undefined)
    expect(two?.openCodeReviewModels).toBeUndefined()
    expect(one?.devinReviewModels).toBeUndefined()
    expect(JSON.stringify([one, two])).not.toContain('test-secret')
    expect(seam.spawn).not.toHaveBeenCalled()
  })
  it('registers in Cordis and returns bounded health facts', async () => {
    const { ctx, instance } = service()
    expect(ctx.get('dshAcp' as never)).toBeDefined()
    await expect(instance.health()).resolves.toMatchObject({
      providers: [{ id: 'devin', name: 'Devin', executable: true, version: '1.0.0', probe: { status: 'ok' } }],
    })
  })

  it('publishes registered routes separately from saved settings and historical bindings', async () => {
    let registered = ['acp-acp-custom']
    const { instance } = service({
      registry: { ...registry(), registeredProviders: () => registered },
      bindingFacts: {
        countBoundSessions: async () => 1,
        listBoundProviders: async () => ['acp-removed', 'acp-removed', 'native-provider'],
      },
    })
    await expect(instance.ownedProviderRoutes()).resolves.toEqual({
      providers: ['acp-acp-custom'],
      historicalProviders: ['acp-removed'],
    })
    registered = []
    await expect(instance.ownedProviderRoutes()).resolves.toEqual({
      providers: [],
      historicalProviders: ['acp-removed'],
    })
  })

  it('reports retained retired profiles without launching or probing them, including explicit rechecks', async () => {
    const probe = vi.fn(async () => [])
    const checkExecutable = vi.fn(async () => true)
    const queryVersion = vi.fn(async () => '1.0.0')
    const configurations: Record<string, AcpAgentConfig> = {
      kimi: { name: 'Old legacy', command: 'kimi', args: [], env: {} },
      renamed: { name: 'Old explicit', command: 'kimi', args: [], env: {}, runtime: 'kimi' },
      generic: { name: 'Generic', command: 'generic', args: [], env: {} },
    }
    const { instance } = service({
      registry: {
        agents: () => new Map(Object.entries(configurations)),
        probeCacheFor: () => ({ probeSnapshot: () => undefined, invalidateProbe: vi.fn(), listModels: probe }),
      },
      checkExecutable,
      queryVersion,
    })
    for (const agentId of ['kimi', 'renamed']) {
      const result = await instance.health({ recheck: true, agentId })
      expect(result.providers).toMatchObject([
        { id: agentId, state: 'unavailable', unavailableReason: 'agent-retired', probe: { status: 'never', at: null } },
      ])
    }
    expect(probe).not.toHaveBeenCalled()
    expect(checkExecutable).not.toHaveBeenCalled()
    expect(queryVersion).not.toHaveBeenCalled()
    await instance.health({ recheck: true, agentId: 'generic' })
    expect(probe).toHaveBeenCalledOnce()
    expect(checkExecutable).toHaveBeenCalledOnce()
    expect(queryVersion).toHaveBeenCalledOnce()
  })

  it('reports a Host version mismatch with health, and nothing when versions agree', async () => {
    expect(await service().instance.health()).not.toHaveProperty('hostVersion')
    const mismatch = { adapter: '0.2.2-rc.1.1', required: '0.2.2-rc.1', running: '0.2.2-rc.2' }
    await expect(service({ hostVersion: () => mismatch }).instance.health()).resolves.toMatchObject({
      hostVersion: { required: '0.2.2-rc.1', running: '0.2.2-rc.2' },
    })
  })

  it('health recheck is targeted and does not expose authentication RPCs', async () => {
    const { instance } = service()
    await expect(instance.health({ recheck: true, agentId: 'devin' })).resolves.toMatchObject({
      providers: [{ id: 'devin' }],
    })
    expect((instance as unknown as Record<string, unknown>).authenticate).toBeUndefined()
    expect((instance as unknown as Record<string, unknown>).options).toBeUndefined()
  })

  it('publishes rechecked models only after the probe settles, including failures; read-only health does not refresh', async () => {
    const changed = vi.fn()
    const probe = vi.fn(async () => {
      expect(changed).not.toHaveBeenCalled()
      throw new Error('offline')
    })
    const { instance } = service({
      registry: {
        agents: () => new Map([['devin', DEVIN]]),
        probeCacheFor: () => ({ invalidateProbe: () => {}, listModels: probe, probeSnapshot: () => undefined }),
        modelsChanged: changed,
      },
    })
    await instance.health()
    expect(changed).not.toHaveBeenCalled()
    await instance.health({ recheck: true, agentId: 'devin' })
    expect(probe).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledExactlyOnceWith(['devin'])
  })

  it('keeps the last explicit result after the runtime TTL and invalidates it when configuration changes', async () => {
    const stale = { ...PROBE, at: Date.now() - ACP_PROBE_CACHE_OK_TTL_MS - 1 }
    const previous = service({ registry: registry({ devin: DEVIN }, { 'acp-devin': stale }) }).instance
    await expect(previous.health()).resolves.toMatchObject({
      providers: [{ id: 'devin', state: 'ready', version: '1.0.0', probe: { status: 'ok', at: stale.at } }],
    })

    const edited = { ...DEVIN, args: ['acp', '--different'] }
    const changed = service({ registry: registry({ devin: edited }, { 'acp-devin': stale }) }).instance
    await expect(changed.health()).resolves.toMatchObject({
      providers: [{ id: 'devin', state: 'saved-unverified', version: null, probe: { status: 'never', at: null } }],
    })
  })

  it('routes recovery through the bound provider adapter and keeps DSH history untouched', async () => {
    let current: AcpRecoveryView = {
      dshSessionId: 's1',
      kind: 'outcome-unknown',
      cause: 'transport-closed',
      detail: 'unknown',
      provider: 'acp-devin',
      acpSessionId: 'agent-1',
      generation: 1,
      interruptedTurnId: null,
      lastAttemptAt: null,
      lastUserAction: null,
      updatedAt: 1,
    }
    const actions: string[] = []
    const { instance } = service({
      ownedSessionReadGate: async () => true,
      backendFacts: {
        readBindingProvider: async () => 'acp-devin',
        peekHeaderProvider: async () => 'acp-devin',
        hasLiveAgent: () => true,
      },
      recoveryStateStore: { read: async () => current },
      recoveryAdapter: () => ({
        retryOriginal: async () => {
          actions.push('retry')
        },
        rebindBlank: async () => {
          actions.push('rebind')
          current = { ...current, kind: 'healthy', cause: null, detail: null }
        },
      }),
    })
    await expect(instance.retryOriginal('s1')).resolves.toMatchObject({ kind: 'outcome-unknown' })
    await expect(instance.rebindRecoveryBlank('s1')).resolves.toMatchObject({ kind: 'healthy' })
    expect(actions).toEqual(['retry', 'rebind'])
  })

  it('keeps native host facts separate from ACP binding counts', async () => {
    const { instance } = service({
      ownedSessionReadGate: async () => true,
      backendFacts: {
        readBindingProvider: async () => undefined,
        peekHeaderProvider: async () => undefined,
        hasLiveAgent: () => true,
      },
      bindingFacts: { countBoundSessions: async () => 2 },
    })
    await expect(instance.backendOf('native')).resolves.toEqual({ state: 'blank' })
    await expect(instance.boundSessions('devin')).resolves.toEqual({ agentId: 'devin', count: 2 })
  })

  it('reads backend identity from bindings and request headers, preserving blank and missing session boundaries', async () => {
    let bound: string | undefined = 'acp-devin'
    let header: string | undefined = 'deepseek'
    let readable = true
    let live = true
    const readHeader = vi.fn(async () => {
      if (!readable) throw new Error('session unavailable')
      return header
    })
    const { instance } = service({
      backendFacts: {
        readBindingProvider: async () => bound,
        peekHeaderProvider: readHeader,
        hasLiveAgent: () => live,
      },
    })
    await expect(instance.backendOf('s1')).resolves.toEqual({
      state: 'established',
      provider: 'acp-devin',
      acpBinding: true,
    })
    expect(readHeader).not.toHaveBeenCalled()
    bound = undefined
    header = 'acp-codex'
    await expect(instance.backendOf('s1')).resolves.toEqual({ state: 'established', provider: 'acp-codex' })
    header = undefined
    await expect(instance.backendOf('s1')).resolves.toEqual({ state: 'blank' })
    readable = false
    await expect(instance.backendOf('s1')).resolves.toEqual({ state: 'blank' })
    live = false
    await expect(instance.backendOf('s1')).rejects.toMatchObject({ code: 'dsh-acp/config' })
  })

  it('preserves ACP taxonomy and diagnostics as typed RemoteError details', async () => {
    const { instance } = service()
    await expect(instance.backendOf('missing')).rejects.toMatchObject({
      code: 'dsh-acp/config',
      message: expect.stringContaining('backend facts are not wired'),
      details: {
        kind: 'protocol-error',
        correlationId: expect.stringMatching(/^acperr-/),
      },
    })
  })

  it('uses the additive agent session controls only for an established ACP binding', async () => {
    const snapshot = {
      sessionId: 's1',
      profileId: 'devin',
      freshness: 'live' as const,
      editable: true,
      configOptions: null,
      modes: null,
      currentModeId: null,
      contextUsage: null,
      note: null,
    }
    const setOption = vi.fn(async () => snapshot)
    const { instance } = service({
      ownedSessionReadGate: async () => true,
      backendFacts: {
        readBindingProvider: async () => 'acp-devin',
        peekHeaderProvider: async () => 'acp-devin',
        hasLiveAgent: () => true,
      },
      agentSessionControl: () => ({ agentSessionSnapshot: async () => snapshot, setAgentSessionOption: setOption }),
    })
    await expect(instance.agentSessionSnapshot('s1')).resolves.toEqual(snapshot)
    await expect(
      instance.setAgentSessionOption('s1', { kind: 'config', id: 'compact', value: false }),
    ).resolves.toEqual(snapshot)
    expect(setOption).toHaveBeenCalledExactlyOnceWith(
      's1',
      { kind: 'config', id: 'compact', value: false },
      expect.any(Function),
      undefined,
    )
  })

  it('guards ACP-only snapshots and recovery mutations before reading or changing an unowned session', async () => {
    const controlSnapshot = vi.fn(async () => ({
      sessionId: 'foreign',
      profileId: 'devin',
      freshness: 'live' as const,
      editable: true,
      configOptions: null,
      modes: null,
      currentModeId: null,
      contextUsage: null,
      note: null,
    }))
    const setOption = vi.fn(async () => controlSnapshot())
    const readRecovery = vi.fn(async () => ({
      dshSessionId: 'foreign',
      kind: 'outcome-unknown' as const,
      cause: 'transport-closed',
      detail: 'sensitive recovery detail',
      provider: 'acp-devin',
      acpSessionId: 'agent-secret',
      generation: 1,
      interruptedTurnId: null,
      lastAttemptAt: 1,
      lastUserAction: null,
      updatedAt: 1,
    }))
    const recoveryAction = vi.fn(async () => {})
    const readBinding = vi.fn(async () => 'acp-devin')
    const { instance } = service({
      ownedSessionReadGate: async () => false,
      backendFacts: {
        readBindingProvider: readBinding,
        peekHeaderProvider: async () => undefined,
        hasLiveAgent: () => false,
      },
      agentSessionControl: () => ({ agentSessionSnapshot: controlSnapshot, setAgentSessionOption: setOption }),
      recoveryStateStore: { read: readRecovery },
      recoveryAdapter: () => ({ retryOriginal: recoveryAction, rebindBlank: recoveryAction }),
    })

    await expect(instance.agentSessionSnapshot('foreign')).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    await expect(
      instance.setAgentSessionOption('foreign', { kind: 'config', id: 'compact', value: false }),
    ).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    await expect(instance.recoverySnapshot('foreign')).resolves.toMatchObject({
      dshSessionId: 'foreign',
      kind: 'healthy',
      provider: null,
      detail: null,
    })
    await expect(instance.retryOriginal('foreign')).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    await expect(instance.rebindRecoveryBlank('foreign')).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    expect(controlSnapshot).not.toHaveBeenCalled()
    expect(setOption).not.toHaveBeenCalled()
    expect(readRecovery).not.toHaveBeenCalled()
    expect(recoveryAction).not.toHaveBeenCalled()
    expect(readBinding).not.toHaveBeenCalled()

    // backendOf is also the native/blank backend query used before ACP model
    // selection, so a native session without an ACP durable owner stays valid.
    await expect(instance.backendOf('foreign')).resolves.toEqual({
      state: 'established',
      provider: 'acp-devin',
      acpBinding: true,
    })
    expect(readBinding).toHaveBeenCalledOnce()

    let storageAvailable = false
    const { instance: unavailableGate } = service({
      ownedSessionReadGate: async () => {
        if (!storageAvailable) throw new Error('sidecar unavailable')
        return true
      },
      recoveryStateStore: { read: readRecovery },
    })
    await expect(unavailableGate.recoverySnapshot('session')).rejects.toThrow('sidecar unavailable')
    expect(readRecovery).not.toHaveBeenCalled()
    storageAvailable = true
    await expect(unavailableGate.recoverySnapshot('session')).resolves.toMatchObject({
      kind: 'outcome-unknown',
      provider: 'acp-devin',
      detail: 'sensitive recovery detail',
    })
    expect(readRecovery).toHaveBeenCalledOnce()
  })

  it('generated descriptors contain only the current invocation set', () => {
    const ids = (TYPERT as { invocations: Array<{ id: string }> }).invocations.map(({ id }) => id.split('/').at(-1))
    expect(ids).toEqual([
      'activityDetail',
      'activityFollow',
      'activityPage',
      'activitySnapshot',
      'agentSessionFollow',
      'agentSessionSnapshot',
      'approvalChildren',
      'auditTimeline',
      'backendOf',
      'boundSessions',
      'health',
      'nativeForkScope',
      'ownedProviderRoutes',
      'projectedSubagentIds',
      'rebindRecoveryBlank',
      'recoveryFollow',
      'recoverySnapshot',
      'registerNativeFork',
      'retryModelSwitchInput',
      'retryOriginal',
      'setAgentSessionOption',
      'setTeamMemberMode',
      'setTeamMemberModel',
      'teamMemberModels',
      'teamMembers',
    ])
  })
})

it('looks up reference versions by catalog identity after customizing the profile ID', async () => {
  const { registryVersionOf } = await import('../../../src/domain/session/registry-versions.ts')
  const config: AcpAgentConfig = {
    name: 'My agent',
    command: 'custom-agent',
    args: [],
    env: {},
    catalogId: 'fast-agent',
  }
  const version = registryVersionOf('fast-agent')!
  const probe: AcpProbeSnapshotLike = {
    key: acpProbeConfigKey(config),
    at: Date.now(),
    result: { kind: 'ok', models: [], agentInfo: { name: 'custom', version } },
  }
  const { instance } = service({ registry: registry({ custom: config }, { 'acp-custom': probe }) })
  expect((await instance.health()).providers[0]?.probe).toMatchObject({ versionCompatibility: 'current' })
  const changed = service({
    registry: registry({ custom: { ...config, catalogId: 'not-in-snapshot' } }, { 'acp-custom': probe }),
  }).instance
  expect((await changed.health()).providers[0]?.probe).toMatchObject({ versionCompatibility: null })
})
