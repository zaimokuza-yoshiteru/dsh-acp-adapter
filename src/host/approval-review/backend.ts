import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import type { ApprovalReviewDecision } from '../../contract/approval-review.ts'

export interface ApprovalReviewRequest {
  readonly profile: Pick<AcpAgentConfig, 'command' | 'args' | 'env'>
  readonly model: string
  readonly task: string
  readonly toolCall: ToolCallUpdate
  readonly locale: string | undefined
  readonly signal: AbortSignal
  /** Verified business session directory when the review backend must attest the source configuration. */
  readonly actorCwd?: string
}

export interface ApprovalReviewBackend {
  review(request: ApprovalReviewRequest): Promise<ApprovalReviewDecision>
  dispose(): Promise<void>
}
