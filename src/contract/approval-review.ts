import type { Implementation } from '@agentclientprotocol/sdk'
import { effectiveRuntimeOf, type AcpAgentConfig } from './agent-config.ts'
import { isLocalDevinReviewProfile, isDevinReviewerAgent } from './devin-review.ts'
import { isLocalOpenCodeReviewProfile, isOpenCodeReviewerAgent } from './opencode-review.ts'

export type ReviewAgent = 'devin' | 'opencode'

/** Stable, content-free reasons shared by native approval cards and audit details. */
export const approvalReviewFailures = {
  en: {
    'incomplete-evidence': 'The Agent provided too little information to review the operation.',
    'invalid-response': 'The model did not return a usable risk assessment.',
    'unverified-reviewer': 'The review environment could not be verified.',
    'model-unavailable': 'The selected review model could not be confirmed.',
    'review-unavailable': 'The review service was unavailable.',
  },
  zh: {
    'incomplete-evidence': '本次操作信息不足，无法完成审查。',
    'invalid-response': '模型未返回可用的风险判断。',
    'unverified-reviewer': '无法验证审查环境。',
    'model-unavailable': '无法确认所选审查模型。',
    'review-unavailable': '审查服务暂不可用。',
  },
}

export type ApprovalReviewFailureCode = keyof typeof approvalReviewFailures.en

export function isApprovalReviewFailureCode(value: unknown): value is ApprovalReviewFailureCode {
  return typeof value === 'string' && Object.hasOwn(approvalReviewFailures.en, value)
}

/** The audit stores only the code. Diagnostic messages must contain no provider output. */
export class ApprovalReviewError extends Error {
  constructor(
    readonly code: ApprovalReviewFailureCode,
    message = 'Approval review unavailable',
  ) {
    super(message)
  }
}

export const permissionAuditFailureMessage = {
  en: 'The approval record could not be saved. This request was cancelled. You can retry it.',
  zh: '审批记录保存失败，本次请求已取消。你可以重试。',
}

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
