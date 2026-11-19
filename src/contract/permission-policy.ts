import type * as acp from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** A policy can decide only this request; standing grants remain human choices. */
export type AcpExternalPolicyOutcome = 'allow-once' | 'deny-once' | 'not-applicable' | 'cancelled' | 'failed'

export interface AcpExternalPolicyExplanation {
  readonly decision: AcpExternalPolicyOutcome
  /** Short, user-facing explanation. Providers must omit secrets and private reasoning. */
  readonly reason?: string
}
export type AcpExternalPolicyDecision = AcpExternalPolicyOutcome | AcpExternalPolicyExplanation

/** Snapshot the provider result once. Malformed integrations must fail closed. */
export function readExternalPolicyDecision(value: unknown): AcpExternalPolicyExplanation {
  const fields = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  const decision = fields === undefined ? value : Object.hasOwn(fields, 'decision') ? fields.decision : undefined
  const reason = fields?.reason
  if (
    (decision !== 'allow-once' &&
      decision !== 'deny-once' &&
      decision !== 'not-applicable' &&
      decision !== 'cancelled' &&
      decision !== 'failed') ||
    (reason !== undefined && typeof reason !== 'string')
  )
    return { decision: 'failed' }
  return reason === undefined ? { decision } : { decision, reason }
}

/** Read-only JSON facts received from the external Agent. */
export type AcpPermissionFacts<T> = T extends object ? { readonly [Key in keyof T]: AcpPermissionFacts<T[Key]> } : T

/**
 * Host-local facts for an explicitly registered, non-interactive policy.
 * `agent` is the original executing Agent, not the parent displaying a card.
 * Its object identity is live; only the ACP JSON facts are cloned and frozen.
 */
export interface AcpExternalPolicyRequest {
  readonly agent: Agent
  readonly requestId: string
  /** Adapter-resolved runtime profile, or generic when unavailable; not a configured profile ID. */
  readonly profile: string
  readonly params: AcpPermissionFacts<acp.RequestPermissionRequest>
  readonly signal?: AbortSignal
}
