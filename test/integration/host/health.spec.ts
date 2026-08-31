// Host Remote integration coverage for the current additive API.
// Legacy options, permission/elicitation brokers, and model-switch endpoints
// are intentionally not part of the public Remote contract anymore.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  AcpRemoteService,
  type AcpHealthRegistryLike,
  type AcpRemoteServiceDeps,
  type AcpProbeSnapshotLike,
} from '../../../src/remote/service.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { acpProbeConfigKey } from '../../../src/domain/session/agent-config.ts'
import type { AcpRecoveryView } from '../../../src/contract/remote.ts'
import { TYPERT } from '../../../lib/typert.host.js'

const DEVIN: AcpAgentConfig = {
  name: 'Devin', command: 'devin', args: ['acp'], env: {}, loginHint: 'devin auth login',
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

function registry(agents: Record<string, AcpAgentConfig> = { devin: DEVIN }, snapshots: Record<string, AcpProbeSnapshotLike | undefined> = { 'acp-devin': PROBE }): AcpHealthRegistryLike {
  return {
    agents: () => new Map(Object.entries(agents)),
    probeCacheFor: () => ({
      probeSnapshot: route => snapshots[route],
      invalidateProbe: () => {},
      listModels: async () => [],
    }),
  }
}

function service(extra: Partial<AcpRemoteServiceDeps> = {}) {
  const ctx = new Context()
  const instance = new AcpRemoteService(ctx, {
    registry: registry(),
    resolveLiveAgent: () => undefined,
    checkExecutable: async () => true,
    queryVersion: async () => '1.0.0',
    ...extra,
  })
  return { ctx, instance }
}

describe('AcpRemoteService current public surface', () => {
  it('registers in Cordis and returns bounded health facts', async () => {
    const { ctx, instance } = service()
    expect(ctx.get('dshAcp' as never)).toBeDefined()
    await expect(instance.health()).resolves.toMatchObject({
      providers: [{ id: 'devin', name: 'Devin', executable: true, version: '1.0.0', probe: { status: 'ok' } }],
    })
  })

  it('health recheck is targeted and does not expose authentication RPCs', async () => {
    const { instance } = service()
    await expect(instance.health({ recheck: true, agentId: 'devin' })).resolves.toMatchObject({ providers: [{ id: 'devin' }] })
    expect((instance as unknown as Record<string, unknown>).authenticate).toBeUndefined()
    expect((instance as unknown as Record<string, unknown>).options).toBeUndefined()
  })

  it('routes recovery through the bound provider adapter and keeps DSH history untouched', async () => {
    let current: AcpRecoveryView = {
      dshSessionId: 's1', kind: 'outcome-unknown', cause: 'transport-closed', detail: 'unknown',
      provider: 'acp-devin', acpSessionId: 'agent-1', generation: 1, interruptedTurnId: null,
      lastAttemptAt: null, lastUserAction: null, updatedAt: 1,
    }
    const actions: string[] = []
    const { instance } = service({
      backendFacts: {
        readBindingProvider: async () => 'acp-devin',
        peekHeaderProvider: async () => 'acp-devin',
        hasLiveAgent: () => true,
      },
      recoveryStateStore: { read: async () => current },
      recoveryAdapter: () => ({
        retryOriginal: async () => { actions.push('retry') },
        rebindBlank: async () => { actions.push('rebind'); current = { ...current, kind: 'healthy', cause: null, detail: null } },
      }),
    })
    await expect(instance.retryOriginal('s1')).resolves.toMatchObject({ kind: 'outcome-unknown' })
    await expect(instance.rebindRecoveryBlank('s1')).resolves.toMatchObject({ kind: 'healthy' })
    expect(actions).toEqual(['retry', 'rebind'])
  })

  it('keeps native host facts separate from ACP binding counts', async () => {
    const { instance } = service({
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
    const snapshot = { sessionId: 's1', profileId: 'devin', freshness: 'live' as const, editable: true, configOptions: null, modes: null, currentModeId: null, contextUsage: null, note: null }
    const { instance } = service({
      backendFacts: { readBindingProvider: async () => 'acp-devin', peekHeaderProvider: async () => 'acp-devin', hasLiveAgent: () => true },
      agentSessionControl: () => ({ agentSessionSnapshot: async () => snapshot, setAgentSessionOption: async () => snapshot }),
    })
    await expect(instance.agentSessionSnapshot('s1')).resolves.toEqual(snapshot)
  })

  it('generated descriptors contain only the current invocation set', () => {
    const ids = (TYPERT as { invocations: Array<{ id: string }> }).invocations.map(({ id }) => id.split('/').at(-1))
    expect(ids).toEqual([
      'activityFollow', 'activityPage', 'activitySnapshot', 'agentSessionSnapshot', 'auditTimeline',
      'backendOf', 'boundSessions', 'health', 'ownedProviderRoutes', 'projectedSubagentIds', 'rebindRecoveryBlank', 'recoverySnapshot', 'retryOriginal',
      'setAgentSessionOption',
    ])
  })
})
