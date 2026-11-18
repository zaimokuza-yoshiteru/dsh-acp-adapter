import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Borrowed Host admission. The Host alone disposes its toolSet after the step settles. */
export interface StepToolAdmission {
  readonly agent: Agent
  readonly toolSet: ResolvedToolSet
  readonly definitions: ReadonlyMap<string, ToolDefinition>
  readonly signal: AbortSignal
  readonly turn: number
  readonly step: number
  isActive(): boolean
}

/** The most recent prepared directory survives idle time; isActive gates new calls. */
export type ReadStepToolAdmission = (agent: Agent) => StepToolAdmission | undefined

/** Capture the Host's single resolution without re-running conditional tool predicates. */
export function installStepToolAdmissions(ctx: Context): ReadStepToolAdmission {
  type Candidate = {
    readonly toolSet: ResolvedToolSet
    readonly signal: AbortSignal
    readonly modelSelection: Readonly<ModelSelection>
  }
  const candidates = new WeakMap<Agent, Candidate>()
  const admissions = new WeakMap<Agent, StepToolAdmission>()
  const sessions = new WeakMap<Agent['session'], { admission: StepToolAdmission; setActive(active: boolean): void }>()
  let closed = false
  ctx.effect(() => () => {
    closed = true
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const { agent, scope, toolSet, signal, modelSelection } = context
    // Diagnostic assemblies have no admission and must not overwrite a running step.
    if (
      !closed &&
      agent !== undefined &&
      scope === agent &&
      toolSet !== undefined &&
      signal !== undefined &&
      modelSelection !== undefined
    ) {
      candidates.set(agent, { toolSet, signal, modelSelection })
    }
    return assembly
  })
  ctx.on('agent/pre-step', async ({ agent, signal, modelSelection, turn, step }, next) => {
    const candidate = candidates.get(agent)
    candidates.delete(agent)
    const decision = await next()
    if (
      closed ||
      decision.kind !== 'enter' ||
      signal.aborted ||
      candidate?.signal !== signal ||
      candidate.modelSelection !== modelSelection
    )
      return decision
    let active = false
    const admission: StepToolAdmission = {
      agent,
      toolSet: candidate.toolSet,
      definitions: new Map(candidate.toolSet.view(agent)),
      signal,
      turn,
      step,
      isActive: () => !closed && active && !signal.aborted && admissions.get(agent) === admission,
    }
    admissions.set(agent, admission)
    sessions.set(agent.session, {
      admission,
      setActive(value) {
        active = value
      },
    })
    return decision
  })
  ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session)
    if (entry === undefined) return
    if (event.type !== 'step/start' && event.type !== 'step/end') return
    if (event.data.turn === entry.admission.turn && event.data.step === entry.admission.step) {
      // Start is committed only after every pre-step hook accepted the proposal.
      entry.setActive(event.type === 'step/start')
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    candidates.delete(agent)
    sessions.get(agent.session)?.setActive(false)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    candidates.delete(agent)
    admissions.delete(agent)
    sessions.delete(agent.session)
  })
  return (agent) => (closed ? undefined : admissions.get(agent))
}
