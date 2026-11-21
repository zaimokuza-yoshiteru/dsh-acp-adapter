import type * as acp from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isAcpModelOrReasoningOption } from '../../contract/config-options.ts'
import type { AcpAgentSessionOptionWrite, AcpAgentSessionSnapshotView } from '../../contract/remote.ts'
import type { FirstTurnOptions } from '../../domain/session/first-turn-options.ts'

interface OptionSource {
  readonly configOptions?: readonly acp.SessionConfigOption[] | undefined
  readonly modes?: acp.SessionModeState | undefined
  readonly currentModeId?: string | undefined
}
interface OptionWriter extends OptionSource {
  setConfigOption?(id: string, value: string | boolean, signal?: AbortSignal): Promise<void>
  setMode?(id: string, signal?: AbortSignal): Promise<void>
}

export function preselectionUnavailable(): LlmError {
  return LlmError.fromFailure({
    code: 'ACP_CONFIG_UNSUPPORTED',
    message: 'The selected Agent setting is unavailable. Choose a current setting before sending.',
  })
}

export function offersFirstTurnOption(source: OptionSource, choice: AcpAgentSessionOptionWrite): boolean {
  if (choice.kind === 'mode') return source.modes?.availableModes.some((mode) => mode.id === choice.id) === true
  const option = source.configOptions?.find((option) => option.id === choice.id)
  if (!option || isAcpModelOrReasoningOption(option)) return false
  if (option.type === 'boolean') return typeof choice.value === 'boolean'
  return option.options.some((entry) =>
    'options' in entry ? entry.options.some((v) => v.value === choice.value) : entry.value === choice.value,
  )
}

function current(source: OptionSource, choice: AcpAgentSessionOptionWrite): boolean {
  return choice.kind === 'mode'
    ? (source.currentModeId ?? source.modes?.currentModeId) === choice.id
    : source.configOptions?.find((option) => option.id === choice.id)?.currentValue === choice.value
}

export function updatedPreselection(
  previous: readonly AcpAgentSessionOptionWrite[],
  choice: AcpAgentSessionOptionWrite,
): AcpAgentSessionOptionWrite[] {
  return [
    ...previous.filter((item) => item.kind !== choice.kind || (item.kind === 'config' && item.id !== choice.id)),
    choice,
  ]
}

/** Discovery describes another session. Live choices, including other choices invalidated by this write, must agree. */
export async function confirmFirstTurnOptions(
  runtime: OptionWriter,
  selection: FirstTurnOptions,
  generation: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (selection.generation !== generation) throw preselectionUnavailable()
  const verify = () => {
    signal?.throwIfAborted()
    if (!selection.choices.every((choice) => offersFirstTurnOption(runtime, choice) && current(runtime, choice)))
      throw LlmError.fromFailure({
        code: 'ACP_CONFIG_SYNC_FAILED',
        message: 'The Agent did not confirm the selected settings. No message was sent.',
      })
  }
  for (const choice of selection.choices) {
    signal?.throwIfAborted()
    if (!offersFirstTurnOption(runtime, choice)) throw preselectionUnavailable()
    if (current(runtime, choice)) continue
    if (choice.kind === 'mode' && runtime.setMode) await runtime.setMode(choice.id, signal)
    else if (choice.kind === 'config' && runtime.setConfigOption)
      await runtime.setConfigOption(choice.id, choice.value, signal)
    else throw preselectionUnavailable()
  }
  verify()
  return verify
}

/** Present the intended choice explicitly. The discovery default never becomes a user instruction. */
export function withPreselection(
  snapshot: AcpAgentSessionSnapshotView,
  pending: FirstTurnOptions | undefined,
): AcpAgentSessionSnapshotView {
  if (!pending?.choices.length) return snapshot
  const selectedMode = pending.choices.find((choice) => choice.kind === 'mode')
  return {
    ...snapshot,
    preselected: pending.choices,
    ...(snapshot.preselection
      ? {
          currentModeId: selectedMode?.id ?? snapshot.currentModeId,
          configOptions:
            snapshot.configOptions?.map((option) => {
              const chosen = pending.choices.find((choice) => choice.kind === 'config' && choice.id === option.id)
              if (chosen?.kind === 'config' && option.type === 'boolean' && typeof chosen.value === 'boolean')
                return { ...option, currentValue: chosen.value }
              if (chosen?.kind === 'config' && option.type === 'select' && typeof chosen.value === 'string')
                return { ...option, currentValue: chosen.value }
              return option
            }) ?? null,
        }
      : {}),
  }
}
