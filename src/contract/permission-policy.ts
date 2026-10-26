import type * as acp from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** A policy can decide only this request; standing grants remain human choices. */
export type AcpExternalPolicyDecision = 'allow-once' | 'deny-once' | 'not-applicable' | 'cancelled' | 'failed'

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
