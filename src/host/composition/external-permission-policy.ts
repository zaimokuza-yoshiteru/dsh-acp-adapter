import { Context, Service } from '@deepseek-ai/cordis'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import type { AcpExternalPolicyDecision, AcpExternalPolicyRequest } from '../../contract/permission-policy.ts'

export type {
  AcpExternalPolicyDecision,
  AcpExternalPolicyRequest,
  AcpPermissionFacts,
} from '../../contract/permission-policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpPermissionPolicy: AcpPermissionPolicy
  }
  interface Events {
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
  }
}

function validDecision(value: unknown): value is AcpExternalPolicyDecision {
  return (
    value === 'allow-once' ||
    value === 'deny-once' ||
    value === 'not-applicable' ||
    value === 'cancelled' ||
    value === 'failed'
  )
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

  evaluate(request: AcpExternalPolicyRequest): Promise<AcpExternalPolicyDecision> {
    if (!this.accepting || request.signal?.aborted) return Promise.resolve('cancelled')
    const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])])
    let input: AcpExternalPolicyRequest
    try {
      // Capture before yielding: mutation of the original request between
      // evaluate() and provider dispatch must not change the authorization facts.
      const params = structuredClone(request.params)
      freezeFacts(params)
      input = Object.freeze({
        agent: request.agent,
        requestId: request.requestId,
        profile: request.profile,
        params,
        signal,
      })
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
        const decision = await this.ctx.waterfall(
          agentCarrier(input.agent),
          'dsh-acp/permission-policy',
          input,
          async (): Promise<AcpExternalPolicyDecision> => 'not-applicable',
        )
        return validDecision(decision) ? decision : 'failed'
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
