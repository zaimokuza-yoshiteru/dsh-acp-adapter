import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acpLaunchFingerprint } from '../../../src/domain/session/launch-fingerprint.ts'
import {
  createAcpSidecar,
  modeIntentBindingKey,
  type AcpBindingData,
  type AcpSidecar,
} from '../../../src/persistence/sidecar.ts'
import { acpOptionsSnapshotOf } from '../../../src/persistence/options-snapshot.ts'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertManagedModelImageInput,
  clearManagedModelDeliveryFailure,
  ManagedModelTurnObservation,
  lastConfirmedBindingModel,
  matchedManagedContextUsage,
  readManagedModelFeedback,
} from '../../../src/host/composition/managed-model-feedback.ts'

const a = 'local/a'
const b = 'local/b'
const models = new Set([a, b])
const config = {
  name: 'Local',
  command: 'opencode',
  args: ['acp'],
  env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        local: {
          models: {
            a: { limit: { context: 32000 } },
            b: { limit: { context: 12000 }, modalities: { input: ['text'] } },
          },
        },
      },
    }),
  },
}
const binding: AcpBindingData = {
  provider: 'acp-local',
  profileId: 'local',
  agentSessionId: 'remote-id',
  canonicalCwd: '/work',
  agent: { name: 'OpenCode' },
  protocolVersion: 1,
  generation: 1,
  bindingEpoch: 1,
  committedPromptOrdinal: 1,
  establishedAt: 1,
  dshCommittedSeq: 2,
  historyBaseSeq: 0,
  capabilityHash: 'hash',
  configHash: 'hash',
  launchFingerprint: acpLaunchFingerprint({ profileId: 'local', config }),
}
let root: string
let store: AcpSidecar
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-model-feedback-'))
  store = createAcpSidecar({ root })
})
afterEach(async () => {
  await store.dispose()
  await rm(root, { recursive: true, force: true })
})
function usage(model: string, used: number, size: number, sessionId = binding.agentSessionId) {
  const turn = new ManagedModelTurnObservation(model, binding.agentSessionId)
  turn.observe({ sessionId, update: { sessionUpdate: 'usage_update', used, size } }, model)
  return turn
}

it('restores only the last successful model at the exact binding head with settled delivery', async () => {
  await usage(a, 100, 32000).commit(store, 's', binding, a)
  expect(await lastConfirmedBindingModel(store, 's', binding, a)).toBe(true)
  expect(await lastConfirmedBindingModel(store, 's', binding, b)).toBe(false)
  expect(await lastConfirmedBindingModel(store, 's', { ...binding, committedPromptOrdinal: 2 }, a)).toBe(false)
  expect(await lastConfirmedBindingModel(store, 's', { ...binding, bindingEpoch: 2 }, a)).toBe(false)
  await store.beginDispatch({
    dshSessionId: 's',
    key: 'pending',
    provider: binding.provider,
    model: b,
    state: 'dispatch-uncertain',
    createdAt: 1,
  })
  expect(await lastConfirmedBindingModel(store, 's', binding, a)).toBe(false)
  await store.clearDispatch(SessionId('s'), 'pending')
  await new ManagedModelTurnObservation(b, binding.agentSessionId).recordFailure(store, 's', {
    ...binding,
    committedPromptOrdinal: 2,
  })
  expect(await lastConfirmedBindingModel(store, 's', binding, a)).toBe(false)
})

it('recovers a legacy picker label from the bound receipt and suppresses it for an uncertain dispatch or delivery', async () => {
  const id = SessionId('old-session')
  await store.append(id, { kind: 'binding', data: binding })
  await store.changeManagedModelIntent(id, {
    bindingKey: modeIntentBindingKey(binding),
    optionId: 'models',
    target: b,
    confirmed: true,
  })
  await store.writeOptionSnapshot(
    id,
    acpOptionsSnapshotOf(
      [
        {
          type: 'select',
          id: 'models',
          category: 'model',
          name: 'Model',
          currentValue: b,
          options: [{ value: b, name: 'B' }],
        },
      ],
      undefined,
      'hash',
      1,
    ),
  )
  const adapter = new AcpProfileAdapter(
    'local',
    () => config,
    { ok: false, message: 'no process in this test' },
    () => ({ workingDirectory: binding.canonicalCwd }) as never,
    {} as never,
    undefined,
    undefined,
    store,
  )
  try {
    expect(await adapter.confirmedLegacyModel(id, 'acp-local')).toBe(b)
    await store.beginDispatch({
      key: 'sending',
      provider: 'acp-local',
      model: b,
      dshSessionId: id,
      state: 'dispatch-uncertain',
      createdAt: 1,
    })
    expect(await adapter.confirmedLegacyModel(id, 'acp-local')).toBeUndefined()
    await store.clearDispatch(id, 'sending')
    await new ManagedModelTurnObservation(b, binding.agentSessionId).recordFailure(store, id, {
      ...binding,
      committedPromptOrdinal: 2,
    })
    expect(await adapter.confirmedLegacyModel(id, 'acp-local')).toBeUndefined()
  } finally {
    await adapter.close()
  }
})

it('warns on a first switch using a corroborated inline model limit, without exposing the previous usage on B', async () => {
  await usage(a, 16280, 32000).commit(store, 's', binding, a)
  const feedback = await readManagedModelFeedback(store, 's', binding, config, models)
  expect(feedback).toMatchObject({
    lastSuccessfulModel: a,
    capacityRisks: [{ model: b, lastUsed: 16280, targetSize: 12000 }],
  })
  const reading = { used: 16280, size: 32000, percent: 50.9, cost: null }
  expect(matchedManagedContextUsage(reading, b, feedback)).toBeNull()
  expect(matchedManagedContextUsage(reading, a, feedback)).toEqual(reading)
  expect(
    matchedManagedContextUsage({ ...reading, cost: { amount: 42, currency: 'USD' } }, a, feedback)?.cost,
  ).toBeNull()
  expect(matchedManagedContextUsage({ ...reading, size: 9000 }, a, feedback)).toBeNull()
  expect((await readManagedModelFeedback(store, 's', binding, config, new Set([a]))).capacityRisks).toBeUndefined()
  const changedConfig = { ...config, env: { OPENCODE_CONFIG_CONTENT: config.env.OPENCODE_CONFIG_CONTENT + ' ' } }
  expect((await readManagedModelFeedback(store, 's', binding, changedConfig, models)).capacityRisks).toBeUndefined()
  expect(
    (await readManagedModelFeedback(store, 's', binding, { ...config, command: 'other-server' }, models)).capacityRisks,
  ).toBeUndefined()
  await usage(a, 16280, 25600).commit(store, 's', { ...binding, committedPromptOrdinal: 2 }, a)
  expect((await readManagedModelFeedback(store, 's', binding, config, models)).capacityRisks).toBeUndefined()
})

it('retains the last successful model after reopening and trusts previously observed windows only inside the same binding', async () => {
  await usage(b, 200, 12000).commit(store, 's', binding, b)
  await usage(a, 14000, 32000).commit(store, 's', { ...binding, committedPromptOrdinal: 2 }, a)
  await store.dispose()
  store = createAcpSidecar({ root })
  expect(await readManagedModelFeedback(store, 's', binding)).toMatchObject({
    lastSuccessfulModel: a,
    capacityRisks: [{ model: b, lastUsed: 14000, targetSize: 12000 }],
  })
  expect(await readManagedModelFeedback(store, 's', { ...binding, bindingEpoch: 2 })).toEqual({})
  // No occupancy update was observed in this new B prompt.
  await new ManagedModelTurnObservation(b, binding.agentSessionId).commit(
    store,
    's',
    { ...binding, committedPromptOrdinal: 3 },
    b,
  )
  expect(await readManagedModelFeedback(store, 's', binding)).toEqual({ lastSuccessfulModel: b })
  await usage(a, 16000, 32000).commit(store, 's', { ...binding, committedPromptOrdinal: 4 }, a)
  expect((await readManagedModelFeedback(store, 's', binding)).capacityRisks).toEqual([
    { model: b, lastUsed: 16000, targetSize: 12000 },
  ])
})

it('keeps an already dispatched failure separate from the previous successful model through reload and explicit recovery', async () => {
  const failed = new ManagedModelTurnObservation(b, binding.agentSessionId)
  await failed.recordFailure(store, 's', binding)
  expect(await readManagedModelFeedback(store, 's', binding)).toEqual({ possiblyDelivered: true })
  await usage(a, 100, 32000).commit(store, 's', { ...binding, committedPromptOrdinal: 2 }, a)
  await failed.recordFailure(store, 's', { ...binding, committedPromptOrdinal: 3 })
  await store.dispose()
  store = createAcpSidecar({ root })
  expect(await readManagedModelFeedback(store, 's', binding)).toMatchObject({
    lastSuccessfulModel: a,
    possiblyDelivered: true,
  })
  await clearManagedModelDeliveryFailure(store, 's', { ...binding, committedPromptOrdinal: 2 })
  expect((await readManagedModelFeedback(store, 's', binding)).possiblyDelivered).toBe(true)
  await clearManagedModelDeliveryFailure(store, 's', { ...binding, committedPromptOrdinal: 3 })
  await failed.recordFailure(store, 's', { ...binding, committedPromptOrdinal: 3 })
  await clearManagedModelDeliveryFailure(store, 's', { ...binding, committedPromptOrdinal: 1 })
  expect((await readManagedModelFeedback(store, 's', binding)).possiblyDelivered).toBeUndefined()
  expect((await readManagedModelFeedback(store, 's', binding)).lastSuccessfulModel).toBe(a)
})

it('ignores usage from child sessions and discards outcomes whose actual model changed in flight', async () => {
  await usage(a, 14000, 32000, 'child').commit(store, 's', binding, a)
  expect(await readManagedModelFeedback(store, 's', binding)).toEqual({ lastSuccessfulModel: a })
  const drift = usage(b, 13000, 32000)
  drift.observe(
    { sessionId: binding.agentSessionId, update: { sessionUpdate: 'config_option_update', configOptions: [] } },
    a,
  )
  await drift.commit(store, 's', { ...binding, committedPromptOrdinal: 2 }, b)
  await usage(b, 100, 12000).commit(store, 's', { ...binding, agentSessionId: 'other' }, b)
  expect(await readManagedModelFeedback(store, 's', binding)).toEqual({ lastSuccessfulModel: a })
})

it('validates image input on the actual connection and the bound OpenCode model before sending', () => {
  const image = [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }]
  expect(() => assertManagedModelImageInput(binding, config, b, true, image)).toThrow(/attached image/)
  expect(() => assertManagedModelImageInput(binding, config, a, false, image)).toThrow(/attached image/)
  expect(() => assertManagedModelImageInput(binding, config, a, true, image)).not.toThrow()
  expect(() => assertManagedModelImageInput(binding, config, b, false, [{ type: 'text', text: 'hello' }])).not.toThrow()
})
