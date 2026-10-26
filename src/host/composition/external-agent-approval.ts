import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { AcpNativeApprovalService } from '../../domain/policy/permissions.ts'
import type {} from './external-permission-policy.ts'

/**
 * ACP owns these requests and their durable audit. Reuse the public native
 * answerer chain and pending card, without changing the Session policy that
 * DSH tools execute under. This is never installed as the Host approval service.
 */
export function externalAgentApproval(ctx: Context, getAgent: () => Agent | undefined): AcpNativeApprovalService {
  return {
    async evaluateExternal(request) {
      const agent = getAgent()
      if (agent === undefined || request.agent !== agent || agent.status !== 'running' || request.signal?.aborted)
        return 'cancelled'
      const policy = ctx.get('acpPermissionPolicy')
      if (policy === undefined) return 'not-applicable'
      const outcome = await policy.evaluate({ ...request, agent })
      return request.signal?.aborted || getAgent() !== agent || agent.status !== 'running' ? 'cancelled' : outcome
    },
    async request(request) {
      const agent = getAgent()
      if (agent === undefined || request.agent !== agent || agent.status !== 'running') return 'unavailable'
      if (request.signal?.aborted) return 'cancelled'
      const native = ctx.get('approval')
      if (native === undefined) return 'unavailable'
      // Preserve native audit for sessions where its policy admits the request.
      // Delegation's `never` still governs every DSH tool, but cannot stand in
      // for the independent external Agent's own permission decision.
      if ((native.overrideOf(agent.session) ?? native.config.policy ?? 'ask') !== 'never') {
        const result = await native.request({
          agent,
          toolName: request.toolName,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.callId === undefined ? {} : { callId: request.callId as ToolCallId }),
          // ACP has no native tool-call record for an answerer to resolve.
          // Keep these local facts additive; native UI and audit retain their
          // published fields, ownership and decision vocabulary.
          ...(request.toolArgs === undefined ? {} : { toolArgs: request.toolArgs }),
          ...(request.commandLine === undefined ? {} : { commandLine: request.commandLine }),
        })
        return request.signal?.aborted || getAgent() !== agent ? 'cancelled' : result
      }
      const signal = request.signal
      const { promise: cancelled, resolve: cancel } = Promise.withResolvers<'cancelled'>()
      const onAbort = () => cancel('cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const answer = Promise.resolve()
          .then(() => {
            if (signal?.aborted || getAgent() !== agent) return 'cancelled' as const
            return agentEvents(ctx, agent).waterfall(
              'approval/request',
              {
                toolName: request.toolName,
                ...(request.callId === undefined ? {} : { callId: request.callId as ToolCallId }),
                ...(request.reason === undefined ? {} : { reason: request.reason }),
                ...(signal === undefined ? {} : { signal }),
                ...(request.toolArgs === undefined ? {} : { toolArgs: request.toolArgs }),
                ...(request.commandLine === undefined ? {} : { commandLine: request.commandLine }),
              },
              async () => 'unavailable',
            )
          })
          .catch(() => 'unavailable' as const)
        const result = await Promise.race([answer, cancelled])
        if (signal?.aborted || getAgent() !== agent) return 'cancelled'
        return result === 'allowed-once' || result === 'rejected' || result === 'cancelled' ? result : 'unavailable'
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
