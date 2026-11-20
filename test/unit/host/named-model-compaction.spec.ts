import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installNamedModelCompaction, NamedModelSteps } from '../../../src/host/composition/named-model-compaction.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

async function arrange(
  position?:
    | 'before-stock'
    | 'after-stock'
    | 'global'
    | 'outer'
    | 'inner'
    | 'outer-veto'
    | 'once-veto'
    | 'inner-short'
    | 'outer-short'
    | 'effort',
) {
  const root = new Context()
  roots.push(root)
  const first = { provider: 'acp-codebuddy', model: 'first' }
  const next = { ...first, model: 'next' }
  const steps = new NamedModelSteps()
  const controller = new AbortController()
  const signal = controller.signal
  const engine = {}
  const agent = {
    model: { current: () => next },
    session: { header: { origin: 'user' }, requestHeader: () => ({ config: first }) },
  } as unknown as Agent
  const scope = createScope(root, agent)
  Object.assign(agent, { ctx: scope.ctx })
  root.provide('agents', { list: () => [agent] })
  root.provide('agentPresets', {
    presetForSession: () => 'standard',
    composedPreset: () => 'standard',
    serviceFor: () => engine,
  })
  const stock = await root.plugin(() => undefined)
  // A Loader entry owns these two fields in the real preset (covered in desktop/e2e).
  Object.defineProperty(stock.ctx.fiber, 'entry', { value: { options: { name: '@deepseek-ai/dsh-compaction-basic' } } })
  stock.ctx.provide('compaction', engine)
  const key = `${next.provider}/${next.model}`
  const missing = new LlmError('compaction refused the change', 'MODEL_SWITCH_COMPACTION_FAILED', {
    cause: Object.assign(
      new Error(`compaction-basic: no context capacity for ${key}; configure contextWindow on that adapter model`),
      { targetKey: key },
    ),
  })
  const foreign = vi.fn()
  function registerForeign(prepend = false, global = false) {
    root.on(
      'agent/request',
      async (_payload, inner) => {
        const config = await inner()
        foreign()
        return { ...config, maxTokens: 123 }
      },
      { prepend, global },
    )
  }
  if (position === 'after-stock') registerForeign()
  stock.ctx.on(
    'agent/request',
    async (_payload, inner) => {
      const config = await inner()
      if (position === 'outer-veto' || position === 'once-veto' || position === 'effort') return config
      throw missing
    },
    { prepend: true },
  )
  if (position === 'before-stock') registerForeign(true)
  if (position === 'global') registerForeign(false, true)
  if (position === 'inner-short') root.on('agent/request', async () => next, { prepend: true })
  if (position === 'effort')
    root.on('agent/request', async (_payload, inner) => ({
      ...(await inner()),
      reasoningEffort: ReasoningEffortId('unexpected'),
    }))
  const confirmed = vi.fn()
  const refused = vi.fn()
  await root.plugin((ctx) => {
    const frames = installNamedModelCompaction(
      ctx,
      () => true,
      steps,
      () => true,
    )
    ctx.on('agent/request', async ({ signal }, inner) => {
      const config = await inner()
      const frame = frames.get(signal)
      if (frame) frame.selection = { config, bindingKey: 'the original binding', confirm: confirmed, refused }
      return config
    })
  })
  if (position === 'outer') registerForeign(true)
  if (position === 'once-veto')
    root.once(
      'agent/request',
      async (_payload, inner) => {
        await inner()
        throw new Error('one-shot postcondition refused')
      },
      { prepend: true },
    )
  if (position === 'inner') registerForeign()
  if (position === 'outer-veto')
    root.on(
      'agent/request',
      async (_payload, inner) => {
        await inner()
        throw new Error('foreign postcondition refused')
      },
      { prepend: true },
    )
  if (position === 'outer-short') root.on('agent/request', async () => next, { prepend: true })
  const events = agentEvents(root, agent)
  let prepared: ReturnType<NamedModelSteps['prepare']>
  const prepare = () => (prepared = steps.prepare(next.provider, next.model, signal))
  const run = async () => {
    await events.waterfall(
      'agent/pre-step',
      { turn: 2, step: 1, signal, modelSelection: next, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const config = await events.waterfall('agent/request', { turn: 2, step: 1, signal }, async () => next)
    prepare()
    return config
  }
  return { run, confirmed, refused, foreign, missing, next, prepare, agent, first, controller, receipt: () => prepared }
}

it.each([undefined, 'inner'] as const)(
  'admits the verified switch and retains complete middleware controls (%s)',
  async (position) => {
    const h = await arrange(position)
    await expect(h.run()).resolves.toEqual({ ...h.next, ...(position && { maxTokens: 123 }) })
    expect(h.confirmed).toHaveBeenCalledOnce()
    expect(h.foreign).toHaveBeenCalledTimes(position ? 1 : 0)
    expect(h.prepare).toThrow()
  },
)

it.each(['before-stock', 'after-stock', 'global', 'outer'] as const)(
  'preserves the native error and original remote model when listener ownership is ambiguous (%s)',
  async (position) => {
    const h = await arrange(position)
    await expect(h.run()).rejects.toBe(h.missing)
    expect(h.confirmed).not.toHaveBeenCalled()
    expect(h.refused).toHaveBeenCalledOnce()
  },
)

it('allows the actual tool connection to reconfirm only this prepared call on its original binding', async () => {
  const h = await arrange()
  await h.run()
  const receipt = h.receipt()!
  const step = { turn: 2, step: 1 }
  expect(receipt.matches(h.agent.session, step, 'the original binding', h.next)).toBe(true)
  expect(receipt.matches(h.agent.session, step, 'other binding', h.next)).toBe(false)
  expect(receipt.matches({}, step, 'the original binding', h.next)).toBe(false)
  expect(receipt.matches(h.agent.session, { turn: 3, step: 1 }, 'the original binding', h.next)).toBe(false)
  expect(receipt.matches(h.agent.session, step, 'the original binding', h.first)).toBe(false)
  h.controller.abort()
  expect(receipt.matches(h.agent.session, step, 'the original binding', h.next)).toBe(false)
})

it.each(['outer-veto', 'once-veto', 'inner-short', 'outer-short', 'effort'] as const)(
  'cannot change the remote model or prepare a call without complete admission (%s)',
  async (position) => {
    const h = await arrange(position)
    await expect(h.run()).rejects.toMatchObject({ code: 'ACP_MODEL_SWITCH_UNAVAILABLE' })
    expect(h.confirmed).not.toHaveBeenCalled()
    expect(h.agent.session.requestHeader()?.config).toEqual(h.first)
    expect(h.prepare).toThrow()
  },
)
