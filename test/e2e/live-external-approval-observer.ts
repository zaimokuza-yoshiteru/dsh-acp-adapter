import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { acpPermissionAudit } from './acp-permission-audit.ts'

/** Test observations, deliberately distinct from persisted native Session events. */
export type ExternalApprovalObservation =
  | {
      readonly type: 'acp-approval/asked'
      readonly data: SessionEventMap['approval/asked']
      readonly auditOwner: 'acp-sidecar'
    }
  | {
      readonly type: 'acp-approval/decided'
      readonly data: SessionEventMap['approval/decided']
      readonly auditOwner: 'acp-sidecar'
    }

/** Observe the public answerer without answering, changing policy or synthesizing native audit. */
export function observeLiveExternalApprovals(
  host: { ctx: Context },
  observe: (sessionId: SessionId, event: ExternalApprovalObservation) => void,
) {
  return host.ctx.on(
    'approval/request',
    async (request, next) => {
      // ApprovalService never forwards native DSH calls under `never`. Reaching
      // this answerer with that policy therefore identifies external ACP approval.
      if (host.ctx.approval.overrideOf(request.agent.session) !== 'never') return next()
      const asked = acpPermissionAudit(host, 'asked').findLast(
        (entry) => entry.sessionId === request.agent.id && entry.data.toolCall.toolCallId === request.callId,
      )
      if (asked === undefined) throw new Error('LIVE_EXTERNAL_APPROVAL_DURABLE_REQUEST_MISSING')
      const id = ApprovalRequestId(asked.data.requestId)
      observe(request.agent.id, {
        type: 'acp-approval/asked',
        auditOwner: 'acp-sidecar',
        data: {
          id,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      })
      const outcome = await next()
      observe(request.agent.id, { type: 'acp-approval/decided', auditOwner: 'acp-sidecar', data: { id, outcome } })
      return outcome
    },
    { prepend: true },
  )
}
