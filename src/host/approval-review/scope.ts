import { reviewPeerStatus } from '../../contract/review-peer.ts'
import type * as acp from '@agentclientprotocol/sdk'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { APPROVAL_REVIEW_POLICY_VERSION } from './decision.ts'
import { DevinReviewer } from './devin/reviewer.ts'
import { OpenCodeReviewer } from './opencode/reviewer.ts'
import type { ApprovalReviewBackend } from './backend.ts'
import { isOpenCodeReviewModel, isOpenCodeReviewTool } from '../../contract/opencode-review.ts'
import { acpDeclaredModelRoute } from '../../contract/model-selection.ts'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import { approvalReviewAgent, supportsLocalApprovalReview, type ReviewAgent } from '../../contract/approval-review.ts'
import { discardPermissionResponse, type AcpNativePermissionBridgeDeps } from '../../domain/policy/permissions.ts'
import { profileLaunchIdentityHash } from '../../domain/session/launch-fingerprint.ts'
import type { SubprocessSeam } from '../../runtime/process/subprocess.ts'
import type { AcpPermissionReviewContext } from '../../runtime/session/session-runtime.ts'

/** Only the current admitted task goes to the reviewer. Preserve attribution for member messages. */
function approvalReviewTask(messages: readonly UserMessage[]): string | undefined {
  const task: string[] = []
  for (const message of messages) {
    const source: string = message.source.kind
    if (source !== 'user' && source !== 'agent-message' && source !== 'team-message') continue
    if (message.content.some((block) => block.type !== 'text')) return undefined
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    if (text) task.push(source === 'user' ? text : `Delegated message: ${text}`)
  }
  return task.length ? task.join('\n\n') : undefined
}

export function approvalReviewInput(messages: readonly UserMessage[], model: () => string | undefined) {
  return { task: () => approvalReviewTask(messages), model }
}

type ReviewSettings = Pick<AcpNativePermissionBridgeDeps, 'riskReviewer' | 'humanReviewOnly'>
type Handler = (settings: ReviewSettings, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>

/** One configured profile owns its review process and all permission audits still using it. */
export class ApprovalReviewScope {
  private active:
    | { agent: ReviewAgent; identity: string; model: string; lifetime: AbortController; worker?: ApprovalReviewBackend }
    | undefined
  private readonly pending = new Set<Promise<unknown>>()

  constructor(
    private readonly id: string,
    private readonly spawnReviewer: (agent: ReviewAgent) => ApprovalReviewBackend,
    private readonly warn: (message: string) => void,
    private readonly localExecution = true,
  ) {}

  static forProfile(id: string, seam: SubprocessSeam, warn: (message: string) => void): ApprovalReviewScope {
    return new ApprovalReviewScope(
      id,
      (agent) => (agent === 'devin' ? new DevinReviewer(seam, warn) : new OpenCodeReviewer(seam, warn)),
      warn,
      seam.localExecution === true,
    )
  }

  get enabled(): boolean {
    return this.active !== undefined
  }

  configure(profile: AcpAgentConfig | undefined, model: string | undefined): void {
    const agent = profile && approvalReviewAgent(this.id, profile)
    const identity = profile && agent && model !== undefined ? profileLaunchIdentityHash(this.id, profile) : undefined
    if (identity && this.active?.identity === identity && this.active.model === model) return
    const previous = this.active
    this.active =
      identity && agent && model !== undefined ? { agent, identity, model, lifetime: new AbortController() } : undefined
    if (previous) {
      previous.lifetime.abort()
      if (previous.worker)
        this.track(previous.worker.dispose().catch(() => this.warn('ACP review process cleanup failed')))
    }
  }

  handle(
    profile: AcpAgentConfig,
    context: AcpPermissionReviewContext,
    locale: string | undefined,
    promptSignal: AbortSignal,
    handler: Handler,
    checkedDevinModels?: readonly { readonly id: string }[],
  ): Promise<acp.RequestPermissionResponse> {
    const active = this.active
    if (!active) return handler({}, promptSignal)
    const signal = AbortSignal.any([promptSignal, active.lifetime.signal])
    const respond = (settings: ReviewSettings) =>
      this.track(
        handler(settings, signal).then((result) =>
          signal.aborted || !context.current() ? discardPermissionResponse(result) : result,
        ),
      )
    const task = context.task()
    const model = active.model || context.sessionModel
    if (context.humanOnly || (active.agent === 'opencode' && !isOpenCodeReviewTool(context.toolCall.name)))
      return respond({ humanReviewOnly: true })
    if (
      !task ||
      !this.localExecution ||
      !supportsLocalApprovalReview(process.platform) ||
      profileLaunchIdentityHash(this.id, profile) !== active.identity ||
      !model ||
      reviewPeerStatus(active.agent, context.agent) !== 'verified' ||
      (active.agent === 'opencode' && (!context.verifiedActorCwd || !isOpenCodeReviewModel(model)))
    )
      return respond({ humanReviewOnly: 'review-unavailable' })
    if (
      active.agent === 'devin' &&
      checkedDevinModels &&
      !checkedDevinModels.some((m) => m.id === acpDeclaredModelRoute(model))
    )
      return respond({ humanReviewOnly: 'review-model-unavailable' })
    const riskReviewer: NonNullable<ReviewSettings['riskReviewer']> = {
      agent: active.agent,
      model,
      policyVersion: APPROVAL_REVIEW_POLICY_VERSION,
      toolCall: context.toolCall,
      review: async (toolCall) => {
        signal.throwIfAborted()
        const worker = (active.worker ??= this.spawnReviewer(active.agent))
        return worker.review({
          profile,
          task,
          model,
          toolCall,
          locale,
          signal,
          ...(active.agent === 'opencode' && context.verifiedActorCwd ? { actorCwd: context.verifiedActorCwd } : {}),
        })
      },
    }
    return respond({ riskReviewer })
  }

  async close(): Promise<void> {
    this.configure(undefined, undefined)
    await Promise.allSettled([...this.pending])
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    const release = () => this.pending.delete(operation)
    void operation.then(release, release)
    return operation
  }
}
