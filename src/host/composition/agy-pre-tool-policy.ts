import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcpSessionRuntimeOptions } from '../../runtime/session/session-runtime.ts'
import { createPreToolDenialAudit, type AcpPreToolDenialAuditData } from '../../domain/policy/events.ts'
import { permissionCopy } from '../../domain/policy/permission-copy.ts'
import { hostLocale } from './host-locale.ts'
import type {} from './external-permission-policy.ts'

/** The pre-execution hook owns its own audit. Native cards and their options are created later by the CLI. */
export function agyPreToolPolicy(
  ctx: Context,
  dshSessionId: SessionId,
  append: (event: AcpPreToolDenialAuditData) => Promise<void>,
): Pick<AcpSessionRuntimeOptions, 'hasAgyPreToolPolicy' | 'onAgyPreToolUse'> {
  const currentAgent = () => ctx.get('agents', false)?.get(dshSessionId)
  return {
    hasAgyPreToolPolicy() {
      const agent = currentAgent()
      return agent !== undefined && ctx.get('acpPermissionPolicy', false)?.hasPreToolPolicy(agent) === true
    },
    async onAgyPreToolUse(sessionId, toolCall, signal) {
      const agent = currentAgent()
      const policy = ctx.get('acpPermissionPolicy', false)
      const unavailable = {
        decision: 'deny' as const,
        reason: permissionCopy(hostLocale(ctx)).permissionPolicyUnavailable,
      }
      if (signal.aborted || agent?.status !== 'running') return unavailable
      if (!policy?.hasPreToolPolicy(agent)) return { decision: 'delegate' }
      const current = () => !signal.aborted && agent.status === 'running' && currentAgent() === agent
      try {
        const decision = await policy.evaluatePreTool({
          agent,
          profile: 'antigravity',
          params: { sessionId, toolCall },
          signal,
        })
        if (!current()) return unavailable
        if (decision === 'not-applicable') return { decision: 'delegate' }
        if (typeof decision !== 'object') return unavailable
        const audit = createPreToolDenialAudit(sessionId, toolCall.toolCallId, decision.reason)
        if (!audit.reason) return unavailable
        await append(audit)
        return current() ? { decision: 'deny', reason: audit.reason } : unavailable
      } catch {
        // A known denial is irrevocable even when its durable append fails.
        return unavailable
      }
    },
  }
}
