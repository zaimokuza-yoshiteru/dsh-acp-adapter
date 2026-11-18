import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import { unsentModelSwitchRecord, unsentModelSwitchSchema } from '../../domain/session/unsent-model-switch.ts'
import { acpCanonicalHash16, modeIntentBindingKey, type AcpSidecar } from '../../persistence/sidecar.ts'
import { readSessionFacts } from './session-facts.ts'

/** A resend re-admits the original Host message; the Agent checks its model again before dispatch. */
export async function retryModelSwitchInput(
  ctx: Context,
  sidecar: AcpSidecar,
  sessionId: string,
  failureSeq: number,
  principal: Principal | undefined,
  authorized: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  const id = SessionId(sessionId)
  const unavailable = () =>
    new RemoteError('session/agent-busy', 'The unsent input is no longer available for retry.', {
      reason: 'STALE_ACP_MODEL_SWITCH',
    })
  const query = ctx.get('sessionQuery', false)
  if (query === undefined) throw unavailable()
  using observation = await query.observeSession(id, { signal })
  if (
    observation.header.origin === 'subagent' ||
    failureSeq < observation.inheritedEventCount ||
    observation.projections?.values.acpExecution?.unsentModelSwitch?.failureSeq !== failureSeq
  )
    throw unavailable()
  const event = observation.events[failureSeq]
  const record = event === undefined ? undefined : pluginRecordOf(event)
  if (record?.type !== unsentModelSwitchRecord) throw unavailable()
  const parsed = unsentModelSwitchSchema.safeParse(record.data)
  if (!parsed.success) throw unavailable()
  const ticket = parsed.data
  let input: UserMessage | undefined
  for (let i = failureSeq - 1; i >= observation.inheritedEventCount && input === undefined; i--) {
    const entry = observation.events[i]
    if (entry?.type === 'agent/inbox/spliced')
      input = entry.data.inserted.find((message) => message.id === ticket.messageId)
  }
  if (
    input?.source.kind !== 'user' ||
    !('rpcId' in input.source) ||
    input.source.rpcId !== ticket.requestId ||
    !isDeepStrictEqual(input.source.principal, principal) ||
    !authorized()
  )
    throw unavailable()
  const message = input
  signal.throwIfAborted()
  const controller = ctx.get('sessionController', false)
  const active = ctx.get('agents', false)?.get(id)
  const resolved = active === undefined ? await controller?.resolveAgent(id) : { agent: active }
  if (resolved === undefined || 'error' in resolved) throw unavailable()
  const { agent } = resolved
  await agent.runMaintenance(async (maintenanceSignal) => {
    const current = agent.model.current()
    if (current === undefined) throw unavailable()
    if (message.content.some((block) => block.type === 'image')) {
      const info = await ctx.llm.resolveModelInfo(current.provider, current.model)
      if (info.inputModalities !== undefined && !info.inputModalities.includes('image'))
        throw new RemoteError('session/attachment-invalid', 'The selected model does not support images.', {
          reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
        })
    }
    const binding = await sidecar.readLatestBinding(id)
    const recovery = await sidecar.readRecoveryState(id)
    signal.throwIfAborted()
    maintenanceSignal.throwIfAborted()
    const next = agent.model.current()
    if (
      !authorized() ||
      ctx.get('agents', false)?.get(id) !== agent ||
      ctx.get('sessions', false)?.get(id) !== agent.session ||
      ctx.get('agentPresets', false)?.composedPreset(agent.ctx) !== 'acp-adapter' ||
      ctx.get('workspaceRegistry', false)?.archivedSessionIds.includes(id) ||
      agent.inbox.nextTurn.length > 0 ||
      agent.inbox.nextStep.length > 0 ||
      readSessionFacts(ctx, agent.session).unsentModelSwitch?.failureSeq !== failureSeq ||
      binding?.status !== 'ok' ||
      acpCanonicalHash16(modeIntentBindingKey(binding.binding)) !== ticket.bindingKey ||
      (recovery !== undefined && (recovery.kind !== 'healthy' || recovery.lastUserAction === 'rebind-blank')) ||
      next?.provider !== binding.binding.provider ||
      next.provider !== current.provider ||
      next.model !== current.model
    )
      throw unavailable()
    // This single native insertion consumes the ticket synchronously, before another retry can enter.
    agent.followup(message)
  })
}
