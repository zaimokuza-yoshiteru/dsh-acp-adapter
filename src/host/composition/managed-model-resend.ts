import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { unsentModelSwitchRecord, unsentModelSwitchSchema } from '../../domain/session/unsent-model-switch.ts'

/** Wakes the native inbox without copying an already-visible user message into history. */
export const managedModelResendSource = 'dsh-acp-adapter/resend'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-acp-adapter/resend': { kind: typeof managedModelResendSource; failureSeq: number }
  }
}

export function managedModelRetryNotice(failureSeq: number) {
  return createUserMessage({ source: { kind: managedModelResendSource, failureSeq }, content: [] })
}

export async function readCommittedModelRetry(
  ctx: Context,
  session: Session,
  failureSeq: number,
  signal?: AbortSignal,
) {
  const query = ctx.get('sessionQuery', false)
  if (query === undefined || !Number.isSafeInteger(failureSeq) || failureSeq < session.inheritedEventCount) return
  using observation = await query.observeSession(session.id, { ...(signal === undefined ? {} : { signal }) })
  const event = observation.events[failureSeq]
  const record = event === undefined ? undefined : pluginRecordOf(event)
  if (record?.type !== unsentModelSwitchRecord) return
  const parsed = unsentModelSwitchSchema.safeParse(record.data)
  const ticket = parsed.data
  if (
    !ticket?.committed ||
    ticket.committed.inputSeq < observation.inheritedEventCount ||
    ticket.committed.inputSeq >= failureSeq
  )
    return
  const original = observation.events[ticket.committed.inputSeq]
  if (
    original?.type !== 'user/message' ||
    original.data.id !== ticket.messageId ||
    original.data.source.kind !== 'user' ||
    !('rpcId' in original.data.source) ||
    original.data.source.rpcId !== ticket.requestId
  )
    return
  return { ticket, input: original.data }
}
