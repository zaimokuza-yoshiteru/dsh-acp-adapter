import { Context, symbols } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmError, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { isAcpSessionModelSwitch } from '../../contract/model-transition.ts'
import { acpModelSelection } from '../../contract/model-selection.ts'

interface AdmittedSwitch {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  selection?: { config: LlmCallConfig; bindingKey: string; confirm: () => Promise<void>; refused: () => void }
}

export interface ConfirmedNamedModelSwitch {
  readonly kind: 'switch' | 'continuation'
  matches(
    owner: object | undefined,
    step: { turn: number; step: number } | undefined,
    bindingKey: string,
    config: Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>,
  ): boolean
}

function unavailable() {
  return LlmError.fromFailure({
    code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
    message: 'The model change could not be verified for this request. Keep the previous model or open a new session.',
  })
}

function sameChoice(a: LlmCallConfig, b: ModelSelection) {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** The native prepareCall follows the complete waterfall and precedes header commit.
 * It can only check a receipt; a nested prepare call can never change the remote model. */
export class NamedModelSteps {
  private readonly bySignal = new WeakMap<
    AbortSignal,
    {
      agent: Agent
      turn: number
      step: number
      target: Readonly<ModelSelection>
      kind: ConfirmedNamedModelSwitch['kind']
      bindingKey?: string
      consumed: boolean
    }
  >()

  begin(
    signal: AbortSignal,
    agent: Agent,
    turn: number,
    step: number,
    target: Readonly<ModelSelection> | undefined,
    kind: ConfirmedNamedModelSwitch['kind'],
  ) {
    if (target) this.bySignal.set(signal, { agent, turn, step, target, kind, consumed: false })
    else this.bySignal.delete(signal)
  }

  get(signal: AbortSignal) {
    return this.bySignal.get(signal)
  }

  prepare(provider: string, model: string, signal: AbortSignal | undefined): ConfirmedNamedModelSwitch | undefined {
    if (!signal) return
    const frame = this.bySignal.get(signal)
    if (!frame || frame.target.provider !== provider || frame.target.model !== model) return
    signal.throwIfAborted()
    const previous = frame.agent.session.requestHeader()?.config
    if (
      frame.kind === 'switch' &&
      (!frame.bindingKey || (frame.consumed && (!previous || !sameChoice(previous, frame.target))))
    )
      throw unavailable()
    frame.consumed = true
    return {
      kind: frame.kind,
      matches: (owner, step, key, config) =>
        !signal.aborted &&
        this.bySignal.get(signal) === frame &&
        owner === frame.agent.session &&
        step?.turn === frame.turn &&
        step.step === frame.step &&
        (frame.kind === 'continuation' || key === frame.bindingKey) &&
        config.provider === provider &&
        config.model === model &&
        (frame.target.reasoningEffort === undefined || config.reasoningEffort === frame.target.reasoningEffort),
    }
  }
}

/** RC.5 checks an external Agent's target as if DSH could compact its history.
 * Recover only its absent-capacity error and only when the complete result of
 * every inner middleware is available. Foreign postconditions must still run. */
export function installNamedModelCompaction(
  inner: Context,
  canSwitch: (provider: string) => boolean,
  steps: NamedModelSteps,
  ownsProvider: (provider: string) => boolean,
): WeakMap<AbortSignal, AdmittedSwitch> {
  const admitted = new WeakMap<AbortSignal, AdmittedSwitch>()
  inner.inject(['agents', 'agentPresets'], (ctx) => {
    const subscriptions = new Map<Agent, () => void>()
    const inspections = new WeakSet<object>()
    const orderOf = (carrier: object, agent: Agent, payload: object) => {
      const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
      const included = Reflect.get(carrier, Context.filter) as (listener: Context) => boolean
      const owners: Context[] = []
      const inspect = {
        [Context.filter](listener: Context) {
          if (!included.call(carrier, listener)) return false
          owners.push(listener)
          return true
        },
      }
      inspections.add(inspect)
      const count = ctx.events.dispatch('waterfall', [inspect, 'agent/request', payload]).length
      const index = owners.findIndex((owner) => owner.fiber === agent.ctx.fiber)
      const stock = owners[index + 1]?.fiber
      const outermost =
        count === owners.length && index === 0 && owners.filter((owner) => owner.fiber === agent.ctx.fiber).length === 1
      const adjacent =
        outermost &&
        engine !== undefined &&
        stock?.entry?.options.name === '@deepseek-ai/dsh-compaction-basic' &&
        [...stock.provisions].some(
          (impl) => impl.name === 'compaction' && impl.value === (Reflect.get(engine, symbols.original) ?? engine),
        ) &&
        owners[index + 2]?.fiber === inner.fiber &&
        owners.filter((owner) => owner.fiber === inner.fiber).length === 1
      return { outermost, adjacent }
    }
    // Cordis snapshots the listener chain immediately after this notification, before
    // a once() listener can remove itself and continue through its stored next().
    const originalOrder = new WeakMap<object, { carrier: object; order: ReturnType<typeof orderOf> }>()
    ctx.on('internal/dispatch', (mode, name, args, carrier) => {
      if (
        mode !== 'waterfall' ||
        name !== 'agent/request' ||
        !carrier ||
        typeof carrier !== 'object' ||
        inspections.has(carrier) ||
        typeof Reflect.get(carrier, Context.filter) !== 'function'
      )
        return
      const payload = args[0] as { agent: Agent; signal: AbortSignal; turn: number; step: number } | undefined
      if (!payload || !subscriptions.has(payload.agent)) return
      const frame = steps.get(payload.signal)
      if (
        !frame ||
        frame.kind !== 'switch' ||
        frame.agent !== payload.agent ||
        frame.turn !== payload.turn ||
        frame.step !== payload.step
      )
        return
      originalOrder.set(payload, { carrier, order: orderOf(carrier, payload.agent, payload) })
    })
    const attach = (agent: Agent) => {
      if (subscriptions.has(agent) || agent.session.header.origin === 'subagent') return
      const stopStep = agent.ctx.on(
        'agent/pre-step',
        (payload, next) => {
          const { modelSelection: target, signal, turn, step } = payload
          const previous = agent.session.requestHeader()?.config
          const preset = ctx.agentPresets.presetForSession(agent.session)
          const switchable =
            ownsProvider(target.provider) &&
            preset === ctx.agentPresets.composedPreset(agent.ctx) &&
            isAcpSessionModelSwitch(previous, target, preset, canSwitch(target.provider))
          const continuation =
            previous?.provider === target.provider &&
            previous.model === target.model &&
            acpModelSelection(target.model).kind === 'declared-model' &&
            canSwitch(target.provider) &&
            preset === ctx.agentPresets.composedPreset(agent.ctx) &&
            ['standard', 'cordis', 'ptc', 'minimal', 'acp-adapter'].includes(preset ?? '')
          steps.begin(
            signal,
            agent,
            turn,
            step,
            switchable || continuation ? target : undefined,
            continuation ? 'continuation' : 'switch',
          )
          return next()
        },
        { prepend: true },
      )
      const stop = agent.ctx.on(
        'agent/request',
        async function (payload, next) {
          const previous = agent.session.requestHeader()?.config
          const frame = steps.get(payload.signal)
          if (
            !frame ||
            frame.kind !== 'switch' ||
            frame.agent !== agent ||
            frame.step !== payload.step ||
            frame.turn !== payload.turn ||
            !previous ||
            (frame.consumed && previous.provider === frame.target.provider && previous.model === frame.target.model)
          )
            return next()
          const target = frame.target
          const observed = originalOrder.get(payload)
          const initial = observed?.carrier === this ? observed.order : undefined
          const order = () => orderOf(this, agent, payload)
          const admission: AdmittedSwitch = { agent, turn: payload.turn, step: payload.step }
          admitted.set(payload.signal, admission)
          try {
            let config: LlmCallConfig
            try {
              config = await next()
            } catch (error) {
              payload.signal.throwIfAborted()
              const observed = admission.selection?.config
              const key = `${target.provider}/${target.model}`
              if (
                !initial?.adjacent ||
                !observed ||
                !sameChoice(observed, target) ||
                !(error instanceof LlmError) ||
                error.code !== 'MODEL_SWITCH_COMPACTION_FAILED' ||
                !(error.cause instanceof Error) ||
                Reflect.get(error.cause, 'targetKey') !== key ||
                error.cause.message !==
                  `compaction-basic: no context capacity for ${key}; configure contextWindow on that adapter model` ||
                !order().adjacent
              ) {
                admission.selection?.refused()
                throw error
              }
              config = observed
            }
            if (
              !initial?.outermost ||
              !order().outermost ||
              !admission.selection ||
              !sameChoice(config, target) ||
              !sameChoice(admission.selection.config, target) ||
              steps.get(payload.signal) !== frame
            ) {
              admission.selection?.refused()
              throw unavailable()
            }
            payload.signal.throwIfAborted()
            await admission.selection.confirm()
            payload.signal.throwIfAborted()
            frame.bindingKey = admission.selection.bindingKey
            return config
          } finally {
            admitted.delete(payload.signal)
          }
        },
        { prepend: true },
      )
      subscriptions.set(agent, () => {
        stopStep()
        stop()
      })
    }
    ctx.on('agent/created', ({ agent }) => {
      attach(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      subscriptions.get(agent)?.()
      subscriptions.delete(agent)
    })
    for (const agent of ctx.agents.list()) attach(agent)
    ctx.effect(() => () => {
      for (const stop of subscriptions.values()) stop()
      subscriptions.clear()
    })
  })
  return admitted
}
