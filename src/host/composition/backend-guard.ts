import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { readSessionFacts } from './session-facts.ts'
import type { AcpSidecar, AcpBindingData, AcpBindingLookup } from '../../persistence/sidecar.ts'
import { acpCanonicalHash16, modeIntentBindingKey } from '../../persistence/sidecar.ts'
import { unsentModelSwitchRecord } from '../../domain/session/unsent-model-switch.ts'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'
import { isAcpPresetModelSwitch, requiresAcpModelSwitchExit } from '../../contract/model-transition.ts'

import { isAcpAgentManagedModel } from '../../contract/model-selection.ts'
import { managedModelResendSource, readCommittedModelRetry } from './managed-model-resend.ts'
import { permitsManagedModelScope, managedModelUnavailable } from './managed-model.ts'

export interface AcpBackendGuardOptions {
  readonly sidecar: AcpSidecar
  readonly ownsProvider: (provider: string) => boolean
  readonly confirmModelSwitch?: (
    profileId: string,
    sessionId: string,
    owner: object,
    binding: AcpBindingData,
    target: LlmCallConfig,
    signal: AbortSignal,
  ) => Promise<void>
}

function transitionError(
  code: 'ACP_BACKEND_NEW_SESSION_REQUIRED' | 'ACP_BACKEND_RECOVERY_REQUIRED' | 'ACP_MODEL_SWITCH_UNAVAILABLE',
  message: string,
  cause?: unknown,
): LlmError {
  return LlmError.fromFailure({ message, code }, cause instanceof Error ? { cause } : undefined)
}

async function blockWithRecovery(
  sidecar: AcpSidecar,
  sessionId: string,
  provider: string,
  cause: string,
  detail: string,
  binding: AcpBindingLookup | undefined,
): Promise<never> {
  const bindingData = binding?.status === 'ok' ? binding.binding : undefined
  try {
    await sidecar.writeRecoveryState({
      dshSessionId: sessionId,
      kind: 'reconciliation-required',
      cause,
      detail,
      provider,
      ...(bindingData === undefined
        ? {}
        : { acpSessionId: bindingData.agentSessionId, generation: bindingData.generation }),
      updatedAt: Date.now(),
    })
  } catch (error: unknown) {
    throw transitionError(
      'ACP_BACKEND_RECOVERY_REQUIRED',
      `ACP transition is blocked and its recovery state could not be persisted: ${detail}`,
      error,
    )
  }
  throw transitionError('ACP_BACKEND_RECOVERY_REQUIRED', detail)
}

/** Install the additive, scoped request guard without replacing DSH's loop. */
export function installAcpBackendGuard(ctx: Context, options: AcpBackendGuardOptions): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const claims = new WeakMap<
      AbortSignal,
      {
        turn: number
        step: number
        messageId: string
        requestId: string
        committed?: { inputSeq: number; dispatchKey: string }
        originalBindingKey?: string
      }
    >()
    projectionCtx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next()
      claims.delete(signal)
      const inputs = messages.filter(
        (message) => message.source.kind === 'user' || message.source.kind === managedModelResendSource,
      )
      const input = inputs.length === 1 ? inputs[0] : undefined
      if (
        input?.source.kind === 'user' &&
        'rpcId' in input.source &&
        decision.kind === 'enter' &&
        decision.messages.some((message) => message.id === input.id)
      )
        claims.set(signal, { turn, step, messageId: input.id, requestId: input.source.rpcId })
      else if (
        input?.source.kind === managedModelResendSource &&
        decision.kind === 'enter' &&
        decision.messages.some((m) => m.id === input.id)
      ) {
        const recovered = await readCommittedModelRetry(projectionCtx, agent.session, input.source.failureSeq, signal)
        if (recovered?.ticket.committed)
          claims.set(signal, {
            turn,
            step,
            requestId: recovered.ticket.requestId,
            messageId: recovered.ticket.messageId,
            committed: recovered.ticket.committed,
            originalBindingKey: recovered.ticket.bindingKey,
          })
      }
      return decision
    })
    projectionCtx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const session = payload.agent.session
      const targetProfile = options.ownsProvider(resolved.provider) ? acpAgentIdFromRoute(resolved.provider) : undefined
      const facts = readSessionFacts(projectionCtx, session)
      // A committed request identifies the backend that owns the transcript.
      // agent.model.current() is the future choice and must not stand in for it.
      const previous = session.requestHeader()?.config ?? null
      const managed = targetProfile !== undefined && isAcpAgentManagedModel(resolved.model)
      if (managed && !permitsManagedModelScope(projectionCtx, payload.agent, resolved.model))
        throw managedModelUnavailable()
      const stableManaged = managed && previous?.provider === resolved.provider && previous.model === resolved.model
      if (stableManaged || requiresAcpModelSwitchExit(previous, resolved, options.ownsProvider)) {
        const presets = projectionCtx.get('agentPresets', false)
        if (
          targetProfile === undefined ||
          options.confirmModelSwitch === undefined ||
          presets === undefined ||
          (!stableManaged &&
            (!isAcpPresetModelSwitch(previous, resolved, presets.presetForSession(session)) ||
              presets.composedPreset(payload.agent.ctx) !== 'acp-adapter' ||
              presets.serviceFor(payload.agent, 'compaction') !== undefined ||
              payload.agent.ctx.get('compaction', false) !== undefined))
        )
          throw transitionError(
            'ACP_MODEL_SWITCH_UNAVAILABLE',
            'Keep the previous model or open a separate session with the selected model in this DSH mode.',
          )
        const lookup = await options.sidecar.readLatestBinding(session.id)
        if (
          stableManaged &&
          lookup === undefined &&
          !facts.acpReplaySeen &&
          (!facts.priorSemanticHistory || session.header.isSeeded)
        )
          return resolved
        if (
          lookup?.status !== 'ok' ||
          lookup.binding.profileId !== targetProfile ||
          lookup.binding.provider !== resolved.provider
        )
          throw transitionError(
            'ACP_BACKEND_RECOVERY_REQUIRED',
            'Restore the original ACP session before switching models.',
          )
        try {
          await options.confirmModelSwitch(
            targetProfile,
            String(session.id),
            session,
            lookup.binding,
            resolved,
            payload.signal,
          )
          payload.signal.throwIfAborted()
        } catch (error) {
          const claim = claims.get(payload.signal)
          if (
            claim?.turn === payload.turn &&
            claim.step === payload.step &&
            (claim.originalBindingKey === undefined ||
              claim.originalBindingKey === acpCanonicalHash16(modeIntentBindingKey(lookup.binding))) &&
            payload.agent.inbox.nextTurn.length === 0 &&
            payload.agent.inbox.nextStep.length === 0 &&
            projectionCtx.get('sessions', false)?.get(session.id) === session
          )
            appendPluginRecord(session, unsentModelSwitchRecord, {
              turn: claim.turn,
              step: claim.step,
              messageId: claim.messageId,
              requestId: claim.requestId,
              ...(claim.committed ? { committed: claim.committed } : {}),
              bindingKey: acpCanonicalHash16(modeIntentBindingKey(lookup.binding)),
            })
          throw error
        }
        return resolved
      }
      const previousProfile = acpAgentIdFromRoute(previous?.provider ?? '')
      if (previous !== null && previousProfile !== undefined && !options.ownsProvider(previous.provider)) {
        // Route names can be reused by a different plugin after a profile is
        // removed. Preserve the former ACP session without claiming other
        // conversations that merely used the same provider string.
        const stored = await options.sidecar.readLatestBinding(session.id)
        if (
          stored?.status === 'outdated' ||
          (stored?.status === 'ok' && stored.binding.provider === previous.provider) ||
          (facts.acpReplaySeen && facts.soleRequestProvider === previous.provider) ||
          facts.forkReplay?.profileId === previousProfile
        )
          throw transitionError(
            'ACP_BACKEND_NEW_SESSION_REQUIRED',
            'This session used an ACP profile that is no longer registered. Restore that profile or start a new session.',
          )
      }
      if (targetProfile === undefined && (previous === null || !options.ownsProvider(previous.provider)))
        return resolved
      if (previous === null && !facts.priorSemanticHistory) return resolved
      if (targetProfile === undefined || previousProfile !== targetProfile || previous === null)
        throw transitionError(
          'ACP_BACKEND_NEW_SESSION_REQUIRED',
          'This selection changes the execution backend; create a new DSH session to continue',
        )

      const sessionId = String(session.id)
      let binding: AcpBindingLookup | undefined
      try {
        binding = await options.sidecar.readLatestBinding(session.id)
      } catch (error: unknown) {
        await blockWithRecovery(
          options.sidecar,
          sessionId,
          resolved.provider,
          'binding-missing',
          'ACP binding could not be read; restore the session or create a new DSH session',
          undefined,
        )
        throw error
      }
      // A native fork has no child ACP binding until its first dispatch. The
      // provider proves the inherited boundary before forking; a seeded child
      // that cannot preserve its history must fail instead of starting blank.
      if (binding === undefined) {
        // Real subagents and pre-alpha ordinary forks already have an explicit
        // persisted parent. New ordinary forks use the separately verified source.
        const recordedParent = session.header.parentSession !== undefined
        const ordinary =
          !recordedParent && session.header.isSeeded ? await options.sidecar.readNativeFork(session.id) : undefined
        if (recordedParent || (ordinary !== undefined && session.inheritedEventCount === ordinary.atSeq + 1))
          return resolved
        // A committed request header records that this route was selected, not
        // that ACP answered. Another plugin may serve the stream, or the first
        // turn may fail before its binding is saved. Gate only a session with
        // evidence of ACP execution whose binding is gone; a seeded child keeps
        // the provider's fork-source gate.
        if (!session.header.isSeeded) {
          try {
            const recovery = await options.sidecar.readRecoveryState(session.id)
            if (recovery?.kind === 'healthy' && recovery.lastUserAction === 'rebind-blank') return resolved
            // An earlier version of this guard gated such sessions itself; that gate is stale.
            const staleGate = recovery?.kind === 'reconciliation-required' && recovery.cause === 'binding-missing'
            if (
              (recovery === undefined || recovery.kind === 'healthy' || staleGate) &&
              !facts.acpReplaySeen &&
              !(await options.sidecar.hasDurableActivityOwner(session.id))
            ) {
              if (staleGate)
                await options.sidecar.writeRecoveryState({
                  dshSessionId: sessionId,
                  kind: 'healthy',
                  updatedAt: Date.now(),
                })
              return resolved
            }
          } catch {
            // Unreadable evidence stays fail-closed below.
          }
        }
      }
      if (binding?.status === 'ok' && binding.binding.profileId === targetProfile) return resolved
      const cause =
        binding?.status === 'ok' && binding.binding.profileId !== targetProfile ? 'backend-conflict' : 'binding-missing'
      return await blockWithRecovery(
        options.sidecar,
        sessionId,
        resolved.provider,
        cause,
        'ACP session binding is missing or belongs to another profile; restore the original profile or create a new DSH session',
        binding,
      )
    })
  })
}
