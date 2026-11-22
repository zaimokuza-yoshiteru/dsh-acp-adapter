import { describe, expect, it, vi } from 'vitest'
import { confirmFirstTurnOptions, offersFirstTurnOption } from '../../../src/host/composition/first-turn-options.ts'
import { applySessionFact, initialSessionFacts } from '../../../src/domain/session/session-facts.ts'
import { firstTurnOptionsRecord, type FirstTurnOptions } from '../../../src/domain/session/first-turn-options.ts'

const intent: FirstTurnOptions = { provider: 'acp-demo', generation: 'g1', choices: [{ kind: 'mode', id: 'plan' }] }
const modes = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'plan', name: 'Plan' },
  ],
}

describe('first Agent settings', () => {
  it('keeps legacy mode confirmation and cancellation bound to the first session', async () => {
    const gate = Promise.withResolvers<void>()
    const runtime = {
      modes,
      currentModeId: 'ask',
      setMode: vi.fn(async (value: string) => {
        await gate.promise
        runtime.currentModeId = value
      }),
    }
    const abort = new AbortController()
    const confirming = confirmFirstTurnOptions(runtime, intent, 'g1', abort.signal)
    expect(runtime.setMode).toHaveBeenCalledWith('plan', abort.signal)
    abort.abort()
    gate.resolve()
    await expect(confirming).rejects.toMatchObject({ name: 'AbortError' })
    const verify = await confirmFirstTurnOptions(runtime, intent, 'g1')
    expect(runtime.setMode).toHaveBeenCalledTimes(1)
    runtime.currentModeId = 'ask'
    expect(verify).toThrow()
    await expect(confirmFirstTurnOptions(runtime, intent, 'another-cli')).rejects.toMatchObject({
      code: 'ACP_CONFIG_UNSUPPORTED',
    })
  })

  it('rejects model settings and never copies choices into forks or another Agent', () => {
    const model = {
      id: 'provider-model',
      name: 'Model',
      type: 'select' as const,
      category: 'model',
      currentValue: 'a',
      options: [{ value: 'a', name: 'A' }],
    }
    expect(offersFirstTurnOption({ configOptions: [model] }, { kind: 'config', id: model.id, value: 'a' })).toBe(false)
    const event = { type: firstTurnOptionsRecord, seq: 0, ignorable: true, data: intent }
    const inherited = applySessionFact(initialSessionFacts(1), event)
    expect(inherited.firstTurnOptions).toBeUndefined()
    expect(inherited.preselectionRevision).toBeUndefined()
    const blank = applySessionFact(initialSessionFacts(), event)
    expect(blank.firstTurnOptions).toEqual(intent)
    expect(
      applySessionFact(blank, { type: 'model/selection', seq: 1, data: { provider: 'acp-other', model: 'a' } })
        .firstTurnOptions,
    ).toBeUndefined()
  })
})
