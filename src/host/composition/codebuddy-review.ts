import { isCodeBuddyPeer } from '../../agents/codebuddy.ts'
import { isAnonymousCodeBuddyLaunch } from '../../contract/codebuddy-profile.ts'
import type { AcpStubAgentConfig } from '../../contract/agent-config.ts'
import { redactSecretText } from '../../contract/redaction.ts'
import type { AcpCodeBuddyReviewAuditData } from '../../domain/policy/events.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function auditId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.:-]{1,256}$/u.test(value) && redactSecretText(value) === value
}

/** A separate broadcast can omit the member route. Require the initial tool call
 * on this session before attributing either its broadcast or its terminal update. */
export function createCodeBuddyReviewRecorder(
  profile: Pick<AcpStubAgentConfig, 'command' | 'args' | 'runtime'>,
  append: (data: AcpCodeBuddyReviewAuditData) => Promise<unknown>,
  warn?: (message: string) => void,
) {
  let observedSession: string | undefined
  const activeCalls = new Set<string>()
  const completedCalls = new Set<string>()
  return (agentName: string | undefined, notification: AcpSessionNotification): void => {
    const { sessionId, update } = notification
    if (
      (update.sessionUpdate !== 'tool_call_update' && update.sessionUpdate !== 'tool_call') ||
      (profile.runtime !== undefined && profile.runtime !== 'codebuddy') ||
      !(agentName === undefined ? isAnonymousCodeBuddyLaunch(profile) : isCodeBuddyPeer(agentName)) ||
      !auditId(sessionId) ||
      !auditId(update.toolCallId)
    )
      return
    if (sessionId !== observedSession) {
      observedSession = sessionId
      activeCalls.clear()
      completedCalls.clear()
    }
    const meta = update._meta
    if (
      (meta && 'codebuddy.ai/memberEvent' in meta) ||
      (notification._meta && 'codebuddy.ai/memberEvent' in notification._meta)
    ) {
      activeCalls.delete(update.toolCallId)
      completedCalls.delete(update.toolCallId)
      return
    }
    const id = update.toolCallId
    if (update.sessionUpdate === 'tool_call' && !completedCalls.has(id)) activeCalls.add(id)
    if ((update.status === 'completed' || update.status === 'failed') && activeCalls.delete(id)) {
      completedCalls.add(id)
      // Late security broadcasts can follow the terminal update. Keep their history bounded.
      if (completedCalls.size > 256) completedCalls.delete(completedCalls.values().next().value!)
    }
    if (update.sessionUpdate === 'tool_call' || (!activeCalls.has(id) && !completedCalls.has(id))) return
    const vendor = meta?.['codebuddy.ai']
    if (!record(vendor) || !record(vendor.toolMetaData)) return
    const conclusions = vendor.toolMetaData.securityConclusions
    if (!Array.isArray(conclusions) || conclusions.length > 16) return
    const seen = new Set<string>()
    // Free text and contentPreview may contain private tool input or output.
    const source = {
      phase: 'codebuddy-review' as const,
      agentSessionId: sessionId,
      toolCallId: update.toolCallId,
      decidedBy: 'ai' as const,
      ...(auditId(vendor.toolName) ? { toolName: vendor.toolName } : {}),
    }
    for (const item of conclusions) {
      if (!record(item) || item.decidedBy !== 'ai') continue
      const { scope, decision } = item
      if (typeof scope !== 'string' || seen.has(scope)) continue
      let data: AcpCodeBuddyReviewAuditData
      if (scope === 'sensitive' && decision === 'allow') data = { ...source, scope, decision }
      else if ((scope === 'sandbox' || scope === 'tool_call' || scope === 'tool_result') && decision === 'deny')
        data = { ...source, scope, decision }
      else continue
      seen.add(scope)
      void append(data).catch(() => warn?.('Could not record a CodeBuddy security review'))
    }
  }
}
