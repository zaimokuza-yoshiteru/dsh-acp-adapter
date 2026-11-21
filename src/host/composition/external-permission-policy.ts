import { Context, Service } from '@deepseek-ai/cordis'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import {
  readExternalPolicyDecision,
  type AcpExternalPolicyDecision,
  type AcpExternalPolicyRequest,
  type AcpPreToolPolicyDecision,
  type AcpPreToolPolicyRequest,
} from '../../contract/permission-policy.ts'

export type {
  AcpExternalPolicyDecision,
  AcpExternalPolicyRequest,
  AcpPermissionFacts,
  AcpPreToolPolicyDecision,
  AcpPreToolPolicyRequest,
} from '../../contract/permission-policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpPermissionPolicy: AcpPermissionPolicy
  }
  interface Events {
    /** Optional machine denial for an agy native command, before ACP offers permission choices. */
    'dsh-acp/pre-tool-policy'(
      this: ReturnType<typeof agentCarrier>,
      request: AcpPreToolPolicyRequest,
      next: () => Promise<AcpPreToolPolicyDecision>,
    ): Promise<AcpPreToolPolicyDecision>
    /**
     * Opt-in machine policy. Call `next()` to defer; never open UI here.
     * This event has no connection to the native `approval/request` chain.
     * @mode waterfall
     */
    'dsh-acp/permission-policy'(
      this: ReturnType<typeof agentCarrier>,
      request: AcpExternalPolicyRequest,
      next: () => Promise<AcpExternalPolicyDecision>,
    ): Promise<AcpExternalPolicyDecision>
    /**
     * Explicit opt-in for requests representable by the native binary card.
     * @mode waterfall
     */
    'dsh-acp/binary-permission-policy'(
      this: ReturnType<typeof agentCarrier>,
      request: AcpExternalPolicyRequest,
      next: () => Promise<AcpExternalPolicyDecision>,
    ): Promise<AcpExternalPolicyDecision>
  }
}

function freezeFacts(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  // ACP facts are JSON. Mutable built-ins such as Map remain mutable after
  // Object.freeze(), so reject them instead of claiming an immutable snapshot.
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('ACP permission facts must contain only JSON objects and arrays')
  }
  Object.freeze(value)
  for (const child of Object.values(value)) freezeFacts(child)
}

function snapshot<T>(facts: T): T {
  const cloned = structuredClone(facts)
  freezeFacts(cloned)
  return cloned
}

/**
 * Host-local dispatch only. The existing permission handler owns asked/decided
 * audit, response mapping, and complete human fallback; this service owns no
 * authorization state or persistence.
 */
export default class AcpPermissionPolicy extends Service {
  private accepting = true
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'acpPermissionPolicy')
    ctx.effect(
      () => async () => {
        this.accepting = false
        this.lifetime.abort()
        // Callers are cancelled immediately. Providers must observe the signal
        // and settle; an in-process callback cannot safely be forcibly killed.
        await Promise.allSettled([...this.active])
      },
      'dsh-acp: drain registered permission policies',
    )
  }

  evaluate(request: AcpExternalPolicyRequest, onChainEnd?: () => void): Promise<AcpExternalPolicyDecision> {
    return this.dispatch('dsh-acp/permission-policy', request, onChainEnd)
  }

  evaluateBinary(request: AcpExternalPolicyRequest, onChainEnd?: () => void): Promise<AcpExternalPolicyDecision> {
    return this.dispatch('dsh-acp/binary-permission-policy', request, onChainEnd)
  }

  hasPreToolPolicy(agent: AcpPreToolPolicyRequest['agent']): boolean {
    return (
      this.accepting &&
      this.ctx.events.dispatch('waterfall', [agentCarrier(agent), 'dsh-acp/pre-tool-policy']).length > 0
    )
  }

  async evaluatePreTool(request: AcpPreToolPolicyRequest): Promise<AcpPreToolPolicyDecision | 'failed' | 'cancelled'> {
    const result = await this.run(request.signal, (signal) => {
      const input = Object.freeze({
        agent: request.agent,
        profile: request.profile,
        params: snapshot(request.params),
        signal,
      })
      return () =>
        this.ctx.waterfall(
          agentCarrier(input.agent),
          'dsh-acp/pre-tool-policy',
          input,
          async (): Promise<AcpPreToolPolicyDecision> => 'not-applicable',
        )
    })
    if (result === 'not-applicable' || result === 'cancelled') return result
    return typeof result === 'object' &&
      result.decision === 'deny-once' &&
      typeof result.reason === 'string' &&
      result.reason.trim()
      ? { decision: 'deny-once', reason: result.reason }
      : 'failed'
  }

  private dispatch(
    event: 'dsh-acp/permission-policy' | 'dsh-acp/binary-permission-policy',
    request: AcpExternalPolicyRequest,
    onChainEnd?: () => void,
  ): Promise<AcpExternalPolicyDecision> {
    return this.run(request.signal, (signal) => {
      const input = Object.freeze({
        agent: request.agent,
        requestId: request.requestId,
        profile: request.profile,
        params: snapshot(request.params),
        signal,
      })
      return () =>
        this.ctx.waterfall(agentCarrier(input.agent), event, input, async (): Promise<AcpExternalPolicyDecision> => {
          // Public next() consumers continue to receive the documented literal.
          onChainEnd?.()
          return 'not-applicable'
        })
    })
  }

  private run(
    requestSignal: AbortSignal | undefined,
    capture: (signal: AbortSignal) => () => Promise<AcpExternalPolicyDecision>,
  ): Promise<AcpExternalPolicyDecision> {
    if (!this.accepting || requestSignal?.aborted) return Promise.resolve('cancelled')
    const signal = AbortSignal.any([this.lifetime.signal, ...(requestSignal ? [requestSignal] : [])])
    let dispatch: () => Promise<AcpExternalPolicyDecision>
    try {
      // Snapshot before yielding. A caller may retain and change the original facts.
      dispatch = capture(signal)
    } catch {
      return Promise.resolve(signal.aborted ? 'cancelled' : 'failed')
    }

    const result = Promise.withResolvers<AcpExternalPolicyDecision>()
    const abort = () => result.resolve('cancelled')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    const settled = Promise.resolve()
      .then(async (): Promise<AcpExternalPolicyDecision> => {
        if (signal.aborted) return 'cancelled'
        const decision = await dispatch()
        const parsed = readExternalPolicyDecision(decision)
        return parsed.reason === undefined ? parsed.decision : parsed
      })
      .catch((): AcpExternalPolicyDecision => 'failed')
      .then((decision) => {
        result.resolve(signal.aborted ? 'cancelled' : decision)
      })
      .finally(() => {
        signal.removeEventListener('abort', abort)
        this.active.delete(settled)
      })
    this.active.add(settled)
    return result.promise
  }
}
