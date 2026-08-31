import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AcpSidecar, AcpBindingLookup } from '../../../src/persistence/sidecar.ts'
import { installAcpBackendGuard } from '../../../src/host/composition/backend-guard.ts'

type RequestListener = (payload: unknown, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>

const config = (provider: string, model = 'model-a'): LlmCallConfig => ({ provider, model })

function session(events: readonly string[], parentSession?: string, id = 'session-test'): Session {
  return {
    id,
    header: parentSession === undefined ? {} : { parentSession },
    events: events.map(type => ({ type, data: {} })),
  } as unknown as Session
}

function sidecar(binding: AcpBindingLookup | undefined, writes: unknown[] = []): AcpSidecar {
  return {
    readLatestBinding: vi.fn(async () => binding),
    writeRecoveryState: vi.fn(async (state: unknown) => { writes.push(state) }),
  } as unknown as AcpSidecar
}

function install(selection: unknown, acpSidecar: AcpSidecar): { listener: RequestListener; reads: ReturnType<typeof vi.fn> } {
  let listener: RequestListener | undefined
  const reads = vi.fn(() => selection)
  const context = {
    inject: (_keys: readonly string[], callback: (ctx: unknown) => void) => callback({
      sessionProjections: { stateOf: reads },
      on: (_event: string, handler: RequestListener) => { listener = handler; return () => undefined },
    }),
  }
  installAcpBackendGuard(context as unknown as Context, { sidecar: acpSidecar })
  if (listener === undefined) throw new Error('guard listener was not installed')
  return { listener, reads }
}

const validBinding = (profileId: string): AcpBindingLookup => ({
  status: 'ok',
  binding: {
    profileId,
    agentSessionId: 'agent-session',
    provider: `acp-${profileId}`,
    canonicalCwd: '/workspace',
    generation: 1,
    dshCommittedSeq: 1,
    historyBaseSeq: 0,
    establishedAt: 1,
    time: 1,
  } as never,
})

describe('M6b additive ACP backend guard', () => {
  it('leaves native same-model, model-change, provider-change, and residual-binding paths untouched', async () => {
    for (const next of [config('native-a'), config('native-a', 'model-b'), config('native-b'), config('native-c')]) {
      const writes: unknown[] = []
      const acpSidecar = sidecar(validBinding('codex'), writes)
      const { listener } = install({ lastUsed: config('native-a'), pending: null }, acpSidecar)
      await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => next)).resolves.toEqual(next)
      expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
      expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
      expect(writes).toHaveLength(0)
    }
  })

  it('allows the first ACP request when only the current turn user message exists', async () => {
    const acpSidecar = sidecar(undefined)
    const { listener } = install({ lastUsed: null, pending: null }, acpSidecar)
    const next = config('acp-codex')
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => next)).resolves.toEqual(next)
    expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
  })

  it('reads a same-profile binding once and allows a valid continuation', async () => {
    const acpSidecar = sidecar(validBinding('codex'))
    const { listener } = install({ lastUsed: config('acp-codex'), pending: null }, acpSidecar)
    const next = config('acp-codex', 'model-b')
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => next)).resolves.toEqual(next)
    expect(acpSidecar.readLatestBinding).toHaveBeenCalledTimes(1)
    expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
  })

  it('blocks cross-backend transitions without reading or writing ACP state', async () => {
    const acpSidecar = sidecar(validBinding('codex'))
    const { listener } = install({ lastUsed: config('acp-codex'), pending: null }, acpSidecar)
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => config('native')))
      .rejects.toMatchObject({ code: 'ACP_BACKEND_NEW_SESSION_REQUIRED' })
    expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
    expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
  })

  it('blocks ACP profile changes without reading either profile binding', async () => {
    const acpSidecar = sidecar(validBinding('codex'))
    const { listener } = install({ lastUsed: config('acp-codex'), pending: null }, acpSidecar)
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => config('acp-kimi')))
      .rejects.toMatchObject({ code: 'ACP_BACKEND_NEW_SESSION_REQUIRED' })
    expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
    expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
  })

  it('persists recovery and blocks a same-profile continuation with a missing binding', async () => {
    const acpSidecar = sidecar(undefined)
    const { listener } = install({ lastUsed: config('acp-codex'), pending: null }, acpSidecar)
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => config('acp-codex')))
      .rejects.toMatchObject({ code: 'ACP_BACKEND_RECOVERY_REQUIRED' })
    expect(acpSidecar.readLatestBinding).toHaveBeenCalledTimes(1)
    expect(acpSidecar.writeRecoveryState).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reconciliation-required',
      cause: 'binding-missing',
      dshSessionId: 'session-test',
    }))
  })

  it('allows a DSH fork child to establish a fresh ACP binding when the parent route is inherited', async () => {
    const acpSidecar = sidecar(undefined)
    const { listener } = install({ lastUsed: config('acp-devin'), pending: null }, acpSidecar)
    const child = session(['turn/start', 'user/message'], 'parent-session', 'child-session')
    await expect(listener({ agent: { session: child } }, async () => config('acp-devin'))).resolves.toEqual(config('acp-devin'))
    expect(acpSidecar.readLatestBinding).toHaveBeenCalledTimes(1)
    expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
  })

  it('records a backend conflict when the binding belongs to another ACP profile', async () => {
    const acpSidecar = sidecar(validBinding('kimi'))
    const { listener } = install({ lastUsed: config('acp-codex'), pending: null }, acpSidecar)
    await expect(listener({ agent: { session: session(['turn/start', 'user/message']) } }, async () => config('acp-codex')))
      .rejects.toMatchObject({ code: 'ACP_BACKEND_RECOVERY_REQUIRED' })
    expect(acpSidecar.writeRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ cause: 'backend-conflict' }))
  })

  it('allows native with prior history and no last-used selection', async () => {
    const acpSidecar = sidecar(undefined)
    const { listener } = install({ lastUsed: null, pending: null }, acpSidecar)
    const next = config('native')
    await expect(listener({ agent: { session: session(['turn/start', 'user/message', 'turn/start', 'user/message']) } }, async () => next)).resolves.toEqual(next)
    expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
  })

  it('blocks ACP adoption when prior history exists without a last-used selection', async () => {
    const acpSidecar = sidecar(undefined)
    const { listener } = install({ lastUsed: null, pending: null }, acpSidecar)
    await expect(listener({ agent: { session: session(['turn/start', 'user/message', 'turn/start', 'user/message']) } }, async () => config('acp-codex')))
      .rejects.toMatchObject({ code: 'ACP_BACKEND_NEW_SESSION_REQUIRED' })
    expect(acpSidecar.readLatestBinding).not.toHaveBeenCalled()
    expect(acpSidecar.writeRecoveryState).not.toHaveBeenCalled()
  })
})
