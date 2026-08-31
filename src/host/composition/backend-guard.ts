/**
 * Pure classification for the stock DSH model-selection transition.
 *
 * Classification remains pure; the Host contribution below only observes the
 * final request and checks ACP continuity.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { AcpSidecar, AcpBindingLookup } from '../../persistence/sidecar.ts'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'

export interface ModelSelectionValue {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface BackendTransitionInput {
  /** The durable last-used selection, or null before the first selection. */
  readonly lastUsed: ModelSelectionValue | null
  /** The final selection produced by the stock DSH request waterfall. */
  readonly next: ModelSelectionValue
  /** True only when the DSH session has no semantic history to preserve. */
  readonly blank: boolean
  /** Defensive signal for a contradictory/legacy projection. */
  readonly hasPriorSemanticHistory: boolean
  /** ACP profile represented by the existing binding, when one is present. */
  readonly bindingProfileId?: string
}

export type BackendTransition =
  | 'allow-native'
  | 'allow-blank-acp'
  | 'allow-same-acp'
  | 'require-new-session'
  | 'recovery-conflict'

/** Classify one model transition without performing the transition. */
export function classifyBackendTransition(input: BackendTransitionInput): BackendTransition {
  const nextProfile = acpAgentIdFromRoute(input.next.provider)
  const previousProfile = acpAgentIdFromRoute(input.lastUsed?.provider ?? '')

  if (nextProfile === undefined) {
    // Native → native, including a model/provider change, never needs ACP
    // continuity and therefore cannot be affected by stale ACP state.
    if (input.lastUsed === null || previousProfile === undefined) return 'allow-native'
    return 'require-new-session'
  }

  if (input.lastUsed === null) {
    // An inconsistent projection must not let ACP adopt an existing transcript.
    return input.blank && !input.hasPriorSemanticHistory
      ? 'allow-blank-acp'
      : 'require-new-session'
  }

  if (previousProfile === undefined || previousProfile !== nextProfile) return 'require-new-session'
  return input.bindingProfileId === nextProfile ? 'allow-same-acp' : 'recovery-conflict'
}

/** Return whether semantic history exists before the current live turn. */
export function hasPriorSemanticHistory(session: Pick<Session, 'events'>): boolean {
  const lastTurnStart = session.events.findLastIndex(event => event.type === 'turn/start')
  const prefix = lastTurnStart < 0 ? session.events : session.events.slice(0, lastTurnStart)
  return prefix.some(event => (
    event.type === 'user/message'
    || event.type === 'assistant/message'
    || event.type === 'tool/call'
    || event.type === 'tool/result'
    || event.type === 'request/header'
  ))
}

export interface AcpBackendGuardOptions {
  readonly sidecar: AcpSidecar
}

function transitionError(code: 'ACP_BACKEND_NEW_SESSION_REQUIRED' | 'ACP_BACKEND_RECOVERY_REQUIRED', message: string, cause?: unknown): LlmError {
  return new LlmError(message, code, cause instanceof Error ? { cause } : undefined)
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
      ...(bindingData === undefined ? {} : { acpSessionId: bindingData.agentSessionId, generation: bindingData.generation }),
      updatedAt: Date.now(),
    })
  } catch (error: unknown) {
    throw transitionError('ACP_BACKEND_RECOVERY_REQUIRED', `ACP transition is blocked and its recovery state could not be persisted: ${detail}`, error)
  }
  throw transitionError('ACP_BACKEND_RECOVERY_REQUIRED', detail)
}

/** Install the additive, scoped request guard without replacing DSH's loop. */
export function installAcpBackendGuard(ctx: Context, options: AcpBackendGuardOptions): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const session = payload.agent.session
      const projection = projectionCtx.sessionProjections.stateOf(session, 'modelSelection')
      const targetProfile = acpAgentIdFromRoute(resolved.provider)
      const priorHistory = hasPriorSemanticHistory(session)
      if (projection === undefined) {
        if (targetProfile === undefined || !priorHistory) return resolved
        throw transitionError('ACP_BACKEND_RECOVERY_REQUIRED', 'DSH model-selection state is unavailable; ACP cannot safely adopt this session')
      }
      const previous = projection.lastUsed
      if (targetProfile === undefined && (previous === null || acpAgentIdFromRoute(previous.provider) === undefined)) return resolved
      const previousProfile = acpAgentIdFromRoute(previous?.provider ?? '')
      const baseInput = {
        lastUsed: previous,
        next: resolved,
        blank: !priorHistory,
        hasPriorSemanticHistory: priorHistory,
      }
      // ACP sidecar is consulted only for a same-profile continuation. This
      // keeps all native and cross-backend decisions independent of ACP I/O.
      if (targetProfile === undefined || previousProfile === undefined || previousProfile !== targetProfile) {
        const transition = classifyBackendTransition(baseInput)
        if (transition === 'allow-native' || transition === 'allow-blank-acp') return resolved
        if (transition === 'require-new-session') throw transitionError('ACP_BACKEND_NEW_SESSION_REQUIRED', 'This selection changes the execution backend; create a new DSH session to continue')
        throw transitionError('ACP_BACKEND_RECOVERY_REQUIRED', 'The DSH model-selection state conflicts with the ACP backend; restore the session or create a new DSH session')
      }

      const sessionId = String(session.id)
      let binding: AcpBindingLookup | undefined
      try {
        binding = await options.sidecar.readLatestBinding(session.id)
      } catch (error: unknown) {
        await blockWithRecovery(options.sidecar, sessionId, resolved.provider, 'binding-missing', 'ACP binding could not be read; restore the session or create a new DSH session', undefined)
        throw error
      }
      // DSH's native fork creates a new session whose model-selection
      // projection may inherit the parent's ACP route, but whose ACP binding
      // is intentionally absent until the child sends its first turn. The
      // provider adapter will establish a fresh Agent session (or use a
      // proven ACP fork) and record the child binding. Treating this as a
      // same-session recovery failure would prevent the documented blank
      // context fallback before the adapter is reached.
      if (binding === undefined
        && session.header.parentSession !== undefined
        && previousProfile === targetProfile) {
        return resolved
      }
      const transition = classifyBackendTransition({
        ...baseInput,
        ...(binding?.status === 'ok' ? { bindingProfileId: binding.binding.profileId } : {}),
      })
      if (transition === 'allow-same-acp') return resolved
      const cause = binding?.status === 'ok' && binding.binding.profileId !== targetProfile ? 'backend-conflict' : 'binding-missing'
      return await blockWithRecovery(options.sidecar, sessionId, resolved.provider, cause, 'ACP session binding is missing or belongs to another profile; restore the original profile or create a new DSH session', binding)
    })
  })
}
