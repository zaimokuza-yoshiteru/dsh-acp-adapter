import type { Implementation } from '@agentclientprotocol/sdk'
import { effectiveRuntimeOf, type AcpAgentConfig } from './agent-config.ts'
import { isLocalDevinReviewProfile, isDevinReviewerAgent } from './devin-review.ts'
import { isLocalOpenCodeReviewProfile, isOpenCodeReviewerAgent } from './opencode-review.ts'

export type ReviewAgent = 'devin' | 'opencode'

export interface ApprovalReviewDecision {
  readonly risk: 'high' | 'not_high'
  readonly reason: string
}

/** A catalog label cannot opt a command into review. Runtime and launch shape must agree. */
export function approvalReviewAgent(id: string, profile: AcpAgentConfig): ReviewAgent | undefined {
  const runtime = effectiveRuntimeOf(id, profile)
  if (runtime === 'devin' && isLocalDevinReviewProfile(profile)) return 'devin'
  if (runtime === undefined && isLocalOpenCodeReviewProfile(profile)) return 'opencode'
  return undefined
}

export function verifiedReviewPeer(agent: ReviewAgent, info: Implementation | null | undefined): boolean {
  return agent === 'devin' ? isDevinReviewerAgent(info) : isOpenCodeReviewerAgent(info)
}

export function supportsLocalApprovalReview(platform: string): boolean {
  return platform === 'linux' || platform === 'darwin'
}
