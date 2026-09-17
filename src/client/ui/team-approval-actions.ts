import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionBase, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/** Structural subsets of the host's public pending carriers; no second approval broker. */
export interface TeamApproval extends SessionPendingInteractionBase {
  readonly kind: 'approval'
  readonly reason?: string
  readonly toolName: string
  answer(outcome: 'allowed-once' | 'rejected'): Promise<void>
}
export function teamApproval(value: SessionPendingInteractionBase): TeamApproval | undefined {
  return value.kind === 'approval' && 'answer' in value && typeof value.answer === 'function' && 'toolName' in value && typeof value.toolName === 'string'
    ? value as TeamApproval : undefined
}
/** Settle only the captured, still-current requests. New arrivals never join a batch. */
export async function answerTeamRequests(
  requests: readonly { pending: SessionPendingInteractionBase; answer: () => Promise<void> }[],
  current: () => SessionStatusSnapshot,
  allowedMembers: ReadonlySet<SessionId>,
  active: () => boolean,
  inFlight: Set<SessionPendingInteractionBase>,
): Promise<number> {
  const outcomes = await Promise.allSettled(requests.map(async request => {
    const pending = request.pending
    if (!active() || !allowedMembers.has(pending.sessionId) || current().get(pending.sessionId)?.pendingInteraction !== pending || inFlight.has(pending)) return
    inFlight.add(pending)
    try { await request.answer() } finally { inFlight.delete(pending) }
  }))
  return outcomes.filter(outcome => outcome.status === 'rejected').length
}
