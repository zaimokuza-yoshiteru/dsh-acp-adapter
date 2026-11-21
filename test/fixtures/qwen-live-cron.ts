import { isDeepStrictEqual } from 'node:util'
import type * as acp from '@agentclientprotocol/sdk'

export const qwenLiveCronInput = {
  cron: '* * * * *',
  prompt: 'Reply with exactly CRONFIRED',
  recurring: false,
  durable: false,
} as const

/** Qwen 0.25.2 supplies the actual tool name and raw arguments in its ACP request. */
export function qwenLiveCronApproval(session: () => string | undefined) {
  let approved = false
  return (request: acp.RequestPermissionRequest, signal?: AbortSignal): acp.RequestPermissionResponse => {
    const once = request.options.filter((option) => option.kind === 'allow_once')
    if (
      approved ||
      signal?.aborted ||
      request.sessionId !== session() ||
      request.toolCall._meta?.toolName !== 'cron_create' ||
      !isDeepStrictEqual(request.toolCall.rawInput, qwenLiveCronInput) ||
      once.length !== 1 ||
      !once[0]?.optionId ||
      request.options.filter((option) => option.optionId === once[0]!.optionId).length !== 1
    )
      return { outcome: { outcome: 'cancelled' } }
    approved = true
    return { outcome: { outcome: 'selected', optionId: once[0].optionId } }
  }
}
