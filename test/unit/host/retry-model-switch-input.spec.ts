import type { Context } from '@deepseek-ai/cordis'
import { describe, it, expect, vi } from 'vitest'
import { retryModelSwitchInput } from '../../../src/host/composition/retry-model-switch-input.ts'
import { unsentModelSwitchRecord } from '../../../src/domain/session/unsent-model-switch.ts'
import {
  acpCanonicalHash16,
  modeIntentBindingKey,
  type AcpBindingData,
  type AcpSidecar,
} from '../../../src/persistence/sidecar.ts'
import { applySessionFact, initialSessionFacts } from '../../../src/domain/session/session-facts.ts'

function fixture() {
  const source = { kind: 'user', rpcId: 'desktop-request', principal: { kind: 'acp-resource-test' as const } }
  const input = {
    id: 'original',
    source,
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { id: 'durable-image' } },
      { type: 'file', attachment: { id: 'durable-file' } },
      { type: 'text', text: 'after' },
    ],
  }
  const binding = {
    provider: 'acp-test',
    agentSessionId: 'original-session',
    generation: 1,
    bindingEpoch: 2,
    launchFingerprint: {},
  } as AcpBindingData
  const receipt = {
    turn: 1,
    step: 1,
    messageId: input.id,
    requestId: source.rpcId,
    bindingKey: acpCanonicalHash16(modeIntentBindingKey(binding)),
  }
  const events = [
    { type: 'agent/inbox/spliced', data: { inserted: [input] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: unsentModelSwitchRecord, ignorable: true, data: receipt },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
  ].map((event, seq) => ({ ...event, seq }))
  const fold = (inherited = 0) => events.reduce(applySessionFact, initialSessionFacts(inherited))
  let facts = fold()
  const view = () => ({ unsentModelSwitch: facts.unsentModelSwitch })
  const observation = {
    header: {},
    inheritedEventCount: 0,
    events,
    get projections() {
      return { values: { acpExecution: view() } }
    },
    [Symbol.dispose]() {},
  }
  const session = {}
  const agent = {
    ctx: {},
    session,
    model: { current: () => ({ provider: 'acp-test', model: 'B' }) },
    inbox: { nextTurn: [], nextStep: [] },
    runMaintenance: (task: (signal: AbortSignal) => Promise<void>) => task(new AbortController().signal),
    followup: vi.fn(() => {
      facts = applySessionFact(facts, { type: 'agent/inbox/spliced', data: { inserted: [input] }, seq: 6 })
    }),
  }
  const info = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
  const services = {
    agents: { get: () => agent },
    sessions: { get: () => session },
    agentPresets: { composedPreset: () => 'acp-adapter' },
    acpSessionFacts: { read: () => facts },
    sessionQuery: { observeSession: async () => observation },
  }
  const ctx = {
    get: (key: keyof typeof services) => services[key],
    llm: { resolveModelInfo: info },
  } as unknown as Context
  const sidecar = {
    readLatestBinding: vi.fn(async () => ({ status: 'ok', binding })),
    readRecoveryState: vi.fn(async () => undefined),
  }
  const authorized = vi.fn(() => true)
  const retry = (seq = 3, principal: typeof source.principal | undefined = source.principal) =>
    retryModelSwitchInput(
      ctx,
      sidecar as unknown as AcpSidecar,
      'dsh-session',
      seq,
      principal,
      authorized,
      new AbortController().signal,
    )
  return { retry, input, agent, fold, observation, sidecar, authorized, info, ctx }
}

describe('explicit retry of an unsent ACP input', () => {
  it('reuses exactly the accepted request and its ordered durable blocks once for competing clicks', async () => {
    const h = fixture()
    const results = await Promise.allSettled([h.retry(), h.retry()])
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(h.agent.followup).toHaveBeenCalledTimes(1)
    expect(h.agent.followup).toHaveBeenCalledWith(h.input)
    expect(h.info).toHaveBeenCalledWith('acp-test', 'B')
    await expect(h.retry()).rejects.toThrow()
    expect(h.agent.followup).toHaveBeenCalledTimes(1)
  })
  it('never inherits a retry from a fork or accepts a different sequence', async () => {
    const h = fixture()
    expect(h.fold(h.observation.events.length).unsentModelSwitch).toBeUndefined()
    await expect(h.retry(1)).rejects.toThrow()
    h.observation.inheritedEventCount = 4
    await expect(h.retry()).rejects.toThrow()
    expect(h.agent.followup).not.toHaveBeenCalled()
  })
  it('checks the original request principal and rechecks access immediately before delivery', async () => {
    const h = fixture()
    await expect(
      retryModelSwitchInput(
        h.ctx,
        h.sidecar as unknown as AcpSidecar,
        'dsh-session',
        3,
        undefined,
        h.authorized,
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    h.authorized.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(h.retry()).rejects.toThrow()
    expect(h.agent.followup).not.toHaveBeenCalled()
  })
  it('keeps the ticket when the new model rejects images or the bound Agent has changed', async () => {
    const h = fixture()
    h.info.mockResolvedValueOnce({ inputModalities: ['text'] })
    await expect(h.retry()).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    h.sidecar.readLatestBinding.mockImplementationOnce(async () => ({
      status: 'ok',
      binding: { ...(await h.sidecar.readLatestBinding()).binding, agentSessionId: 'replacement' },
    }))
    await expect(h.retry()).rejects.toThrow()
    expect(h.agent.followup).not.toHaveBeenCalled()
    await h.retry()
    expect(h.agent.followup).toHaveBeenCalledTimes(1)
  })
})
