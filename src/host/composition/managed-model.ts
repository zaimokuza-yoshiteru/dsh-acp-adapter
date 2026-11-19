import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isAcpAgentManagedModel } from '../../contract/model-selection.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

import type { AcpAgentSessionSnapshotView } from '../../contract/remote.ts'
import { acpModelConfigOption } from '../../contract/model-selection.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import type { AcpStubAgentConfig } from '../../domain/session/agent-config.ts'
import { acpLaunchFingerprintsCompatible } from '../../domain/session/launch-fingerprint.ts'
import { sameSwitchableAgent, supportsAgentManagedModels } from '../../agents/compatibility.ts'
import {
  modeIntentBindingKey,
  type AcpBindingData,
  type AcpSidecar,
  type AcpRecoveryState,
} from '../../persistence/sidecar.ts'
import { AcpPromptNotDispatchedError } from '../../runtime/session/session-runtime.ts'
import { readManagedModelFeedback, matchedManagedContextUsage } from './managed-model-feedback.ts'
import type { AcpProfileRuntime } from './profile-adapter.ts'

/** Current selection, session composition and main-conversation identity must all agree. */
export function permitsManagedModelScope(ctx: Context, agent: Agent, model: string): boolean {
  return isAcpAgentManagedModel(model) && permitsOrdinaryModelScope(ctx, agent)
}

export function permitsOrdinaryModelScope(ctx: Context, agent: Agent): boolean {
  if (agent.session.header.origin === 'subagent') return false
  const presets = ctx.get('agentPresets', false)
  const preset = presets?.presetForSession(agent.session)
  return (
    typeof preset === 'string' &&
    ['standard', 'cordis', 'ptc', 'minimal'].includes(preset) &&
    presets?.composedPreset(agent.ctx) === preset
  )
}

export function managedModelUnavailable(): LlmError {
  return LlmError.fromFailure({
    code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
    message:
      'Confirm the model in the original Agent session. If this mode has no Agent model control, choose a named model in the model picker.',
  })
}

export async function managedModelSnapshot(
  snapshot: AcpAgentSessionSnapshotView,
  sidecar: AcpSidecar,
  profile: AcpStubAgentConfig | undefined,
  launchFingerprint: (profile: AcpStubAgentConfig) => Promise<AcpBindingData['launchFingerprint']>,
  localRecovery: AcpRecoveryState | undefined,
  named = false,
): Promise<AcpAgentSessionSnapshotView> {
  const sessionId = snapshot.sessionId
  const lookup = await sidecar.readLatestBinding(sessionId as never)
  if (lookup?.status !== 'ok' || !supportsAgentManagedModels(lookup.binding.agent.name, profile)) return snapshot
  const binding = lookup.binding
  if (!profile || !acpLaunchFingerprintsCompatible(binding.launchFingerprint, await launchFingerprint(profile)))
    return snapshot
  const intent = named ? undefined : await sidecar.readManagedModelIntent(sessionId as never)
  if (!named && (!intent || intent.bindingKey !== modeIntentBindingKey(binding))) return snapshot
  const option = snapshot.configOptions?.find(
    (item) =>
      item.type === 'select' &&
      (named ? normalizeAcpConfigOptionKey(item.category ?? '') === 'model' : item.id === intent?.optionId),
  )
  const optionId = intent?.optionId ?? option?.id
  if (!optionId) return snapshot
  const choices = new Set(
    option?.type === 'select'
      ? option.options.flatMap((item) => ('options' in item ? item.options.map((entry) => entry.value) : [item.value]))
      : [],
  )
  const feedback = await readManagedModelFeedback(sidecar, sessionId, binding, profile, choices)
  const { lastUsage: _lastUsage, possiblyDelivered, ...display } = feedback
  const recovery = localRecovery ?? (await sidecar.readRecoveryState(sessionId as never))
  const confirmed =
    option?.type === 'select' && (named || (intent?.confirmed && option.currentValue === intent.target))
      ? option.currentValue
      : null
  return {
    ...snapshot,
    contextUsage: matchedManagedContextUsage(snapshot.contextUsage, confirmed, feedback),
    managedModel: {
      optionId,
      confirmed,
      ...display,
      ...(confirmed === null && intent ? { requested: intent.target, recovery: 'unconfirmed' as const } : {}),
      ...(possiblyDelivered || recovery?.kind === 'outcome-unknown' ? { recovery: 'possibly-delivered' as const } : {}),
    },
  }
}

export interface ManagedDispatchReceipt {
  readonly binding: AcpBindingData
  readonly target: string
  /** Recheck synchronously at the final transport write after Host feedback drains. */
  verify(): void
}

interface ManagedDispatchAccess {
  sidecar: AcpSidecar
  sessionId: string
  profile: AcpStubAgentConfig
  runtime: AcpProfileRuntime
  bindingOf(peer: AcpProfileRuntime): AcpBindingData | undefined
  eligible(): boolean
  apply(target: string): Promise<void>
  changed(): void
}

/** Check the actual connection after MCP setup. The pre-request check cannot witness this lease. */
export async function verifyManagedDispatch({
  sidecar,
  sessionId,
  profile,
  runtime,
  bindingOf,
  eligible,
  apply,
  changed,
}: ManagedDispatchAccess): Promise<ManagedDispatchReceipt> {
  const bound = bindingOf(runtime)
  const current = await sidecar.readLatestBinding(sessionId as never)
  const selected = acpModelConfigOption(runtime.configOptions)
  if (
    !bound ||
    current?.status !== 'ok' ||
    !selected?.currentValue ||
    !sameSwitchableAgent(bound.agent.name, runtime.agentInfo?.name, profile) ||
    bound.agentSessionId !== runtime.acpSessionId ||
    modeIntentBindingKey(bound) !== modeIntentBindingKey(current.binding) ||
    !eligible()
  )
    throw managedModelUnavailable()
  const bindingKey = modeIntentBindingKey(bound)
  const intent = await sidecar.readManagedModelIntent(sessionId as never)
  if (intent === undefined && bound.committedPromptOrdinal !== 0) throw managedModelUnavailable()
  if (
    intent !== undefined &&
    (!intent.confirmed || intent.bindingKey !== bindingKey || intent.optionId !== selected.id)
  )
    throw managedModelUnavailable()
  const target = intent?.target ?? selected.currentValue
  await apply(target)
  const effective = acpModelConfigOption(runtime.configOptions)
  if (
    effective?.id !== selected.id ||
    effective.currentValue !== target ||
    runtime.acpSessionId !== bound.agentSessionId ||
    !eligible()
  )
    throw managedModelUnavailable()
  const receipt = {
    binding: bound,
    target,
    verify: () => {
      const actual = acpModelConfigOption(runtime.configOptions)
      if (
        actual?.id !== selected.id ||
        actual.currentValue !== target ||
        runtime.acpSessionId !== bound.agentSessionId ||
        bindingOf(runtime) !== bound
      )
        throw new AcpPromptNotDispatchedError()
    },
  }
  if (intent === undefined) {
    await sidecar.changeManagedModelIntent(sessionId as never, {
      bindingKey,
      optionId: selected.id,
      target,
      confirmed: true,
    })
    changed()
  }

  return receipt
}
