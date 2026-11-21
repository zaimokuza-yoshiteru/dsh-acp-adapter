import { randomUUID } from 'node:crypto'
import type { RequestPermissionRequest, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ApprovalReviewDecision, ReviewAgent } from '../../contract/approval-review.ts'
import { redactSecretText, permissionOperationHash, type AcpAiReviewAuditData, type AiReviewOutcome } from './events.ts'
import type { PermissionCopy } from './permission-copy.ts'

export interface PermissionRiskReviewer {
  readonly agent: ReviewAgent
  readonly model: string
  readonly policyVersion: string
  /** Original wire action, before native question presentation. */
  readonly toolCall?: ToolCallUpdate
  review(toolCall: ToolCallUpdate, signal?: AbortSignal): Promise<ApprovalReviewDecision>
}

type Outcome =
  | { readonly kind: 'human'; readonly reason: (copy: PermissionCopy) => string }
  | { readonly kind: 'allow'; readonly optionId: string }
  | { readonly kind: 'cancel' }

function reviewText(value: string): string {
  return redactSecretText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, 512)
}

/** Only the live, durably audited request can consume a reviewer's one-time grant. */
export async function reviewPermissionRisk(
  reviewer: PermissionRiskReviewer,
  params: RequestPermissionRequest,
  toolCall: ToolCallUpdate,
  requestId: string,
  current: () => boolean,
  append: ((data: AcpAiReviewAuditData) => Promise<boolean>) | undefined,
  now: () => number,
  signal?: AbortSignal,
): Promise<Outcome> {
  if (toolCall.toolCallId !== params.toolCall.toolCallId)
    return { kind: 'human', reason: (copy) => copy.reviewUnavailable }
  const choices = params.options.filter((option) => option.kind === 'allow_once')
  if (choices.length !== 1) return { kind: 'human', reason: (copy) => copy.reviewNoOnce }
  const auditUnavailable: Outcome = { kind: 'human', reason: (copy) => copy.reviewAuditUnavailable }
  if (!append) return auditUnavailable
  const attempt = {
    requestId,
    attemptId: randomUUID(),
    agentSessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    reviewAgent: reviewer.agent,
    model: reviewText(reviewer.model),
    policyVersion: reviewText(reviewer.policyVersion),
    operationHash: permissionOperationHash(toolCall),
    operationHashVersion: 2 as const,
  }
  if (!(await append({ ...attempt, phase: 'ai-review-started' }))) return auditUnavailable
  const started = now()
  const cancelled = { status: 'cancelled' } as const
  let result: AiReviewOutcome = cancelled
  if (current()) {
    try {
      const review = await reviewer.review(toolCall, signal)
      const reason = reviewText(review.reason)
      result =
        reason && (review.risk === 'high' || review.risk === 'not_high')
          ? { status: review.risk, reason }
          : { status: 'error' }
    } catch (error) {
      result = { status: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error' }
    }
  }
  if (!current()) result = cancelled
  const facts = { ...attempt, phase: 'ai-review-result' as const, durationMs: Math.max(0, now() - started) }
  const stored = await append({ ...facts, ...result })
  if (!current() || result.status === 'cancelled') return { kind: 'cancel' }
  if (!stored) return auditUnavailable
  if (result.status === 'not_high') return { kind: 'allow', optionId: choices[0]!.optionId }
  if (result.status === 'high') return { kind: 'human', reason: (copy) => copy.reviewHighRisk(result.reason) }
  return {
    kind: 'human',
    reason: (copy) => (result.status === 'timeout' ? copy.reviewTimeout : copy.reviewUnavailable),
  }
}
