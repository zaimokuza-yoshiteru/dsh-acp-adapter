import type * as acp from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { openCodeInlineModelFacts } from '../../agents/opencode.ts'
import type { AcpContextUsageView } from '../../contract/remote.ts'
import type { AcpStubAgentConfig } from '../../domain/session/agent-config.ts'
import { acpLaunchFingerprint, acpLaunchFingerprintsCompatible } from '../../domain/session/launch-fingerprint.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import { ACP_SNAPSHOT_FIELD_MAX } from '../../persistence/options-snapshot.ts'
import {
  acpCanonicalHash16,
  modeIntentBindingKey,
  type AcpBindingData,
  type AcpSidecar,
} from '../../persistence/sidecar.ts'

type Usage = Pick<AcpContextUsageView, 'used' | 'size' | 'cost'>

/** Observe only updates delivered to this prompt on the original ACP session.
 * A model change within a turn makes its attribution ambiguous. */
export class ManagedModelTurnObservation {
  private usage: Usage | undefined
  constructor(
    private model: string | undefined,
    private readonly sessionId: string | undefined,
  ) {}

  observe(notification: AcpSessionNotification, model: string | undefined): void {
    if (notification.sessionId !== this.sessionId) return
    if (model !== this.model) this.model = undefined
    const update = notification.update
    if (
      update.sessionUpdate === 'usage_update' &&
      Number.isSafeInteger(update.used) &&
      update.used >= 0 &&
      Number.isSafeInteger(update.size) &&
      update.size > 0
    ) {
      const cost = update.cost
      this.usage = {
        used: update.used,
        size: update.size,
        cost:
          cost &&
          Number.isFinite(cost.amount) &&
          typeof cost.currency === 'string' &&
          cost.currency.length <= ACP_SNAPSHOT_FIELD_MAX
            ? { amount: cost.amount, currency: cost.currency }
            : null,
      }
    }
  }

  async commit(
    store: Pick<AcpSidecar, 'recordManagedModelTurn'>,
    sessionId: string,
    binding: AcpBindingData,
    confirmedModel: string | undefined,
  ): Promise<void> {
    if (!this.model || this.model !== confirmedModel || binding.agentSessionId !== this.sessionId) return
    await store.recordManagedModelTurn(SessionId(sessionId), acpCanonicalHash16(modeIntentBindingKey(binding)), {
      model: this.model,
      ordinal: binding.committedPromptOrdinal,
      used: this.usage?.used ?? null,
      size: this.usage?.size ?? null,
      costAmount: this.usage?.cost?.amount ?? null,
      costCurrency: this.usage?.cost?.currency ?? null,
    })
  }

  async recordFailure(
    store: Pick<AcpSidecar, 'recordManagedModelFailure'>,
    sessionId: string,
    binding: AcpBindingData,
  ): Promise<void> {
    if (!this.model || binding.agentSessionId !== this.sessionId) return
    await store.recordManagedModelFailure(
      SessionId(sessionId),
      acpCanonicalHash16(modeIntentBindingKey(binding)),
      this.model,
      binding.committedPromptOrdinal,
    )
  }
}

export async function clearManagedModelDeliveryFailure(
  store: Pick<AcpSidecar, 'clearManagedModelFailures'>,
  sessionId: string,
  binding: AcpBindingData,
): Promise<void> {
  await store.clearManagedModelFailures(
    SessionId(sessionId),
    acpCanonicalHash16(modeIntentBindingKey(binding)),
    binding.committedPromptOrdinal,
  )
}

function inlineModels(binding: AcpBindingData, profile: AcpStubAgentConfig | undefined, models: ReadonlySet<string>) {
  const raw = profile?.env.OPENCODE_CONFIG_CONTENT
  if (binding.agent.name !== 'OpenCode' || !raw || raw.length > 1_048_576) return undefined
  if (
    !profile ||
    !acpLaunchFingerprintsCompatible(
      binding.launchFingerprint,
      acpLaunchFingerprint({ profileId: binding.profileId, config: profile }),
    )
  )
    return undefined
  return openCodeInlineModelFacts(raw, models)
}

interface ManagedModelFeedback {
  readonly possiblyDelivered?: true
  readonly lastSuccessfulModel?: string
  readonly lastUsage?: Usage
  readonly capacityRisks?: readonly { readonly model: string; readonly lastUsed: number; readonly targetSize: number }[]
}

export async function readManagedModelFeedback(
  store: Pick<AcpSidecar, 'readManagedModelTurns'>,
  sessionId: string,
  binding: AcpBindingData,
  profile?: AcpStubAgentConfig,
  advertisedModelIds?: ReadonlySet<string>,
): Promise<ManagedModelFeedback> {
  const turns = await store.readManagedModelTurns(
    SessionId(sessionId),
    acpCanonicalHash16(modeIntentBindingKey(binding)),
  )
  const last = turns[0]
  const delivery = turns.some((turn) => (turn.failureOrdinal ?? 0) > (last?.ordinal ?? 0))
    ? { possiblyDelivered: true as const }
    : {}
  if (!last || last.ordinal === 0) return delivery
  const lastSuccessfulModel = last.model
  if (last.used === null || last.size === null) return { ...delivery, lastSuccessfulModel }
  const lastUsage = {
    used: last.used,
    size: last.size,
    cost:
      last.costAmount != null && last.costCurrency != null
        ? { amount: last.costAmount, currency: last.costCurrency }
        : null,
  }
  const choices = advertisedModelIds ?? new Set(turns.map((turn) => turn.model))
  const capacities = new Map<string, number>()
  const declared = inlineModels(binding, profile, choices)
  // Corroborate a local declaration against the current Agent's observed
  // window before using it to advise on an untried model in this profile.
  if (declared?.get(lastSuccessfulModel)?.context === last.size) {
    for (const [model, info] of declared) if (info.context !== undefined) capacities.set(model, info.context)
  }
  for (const turn of turns) if (turn.size !== null && choices.has(turn.model)) capacities.set(turn.model, turn.size)
  const capacityRisks = Array.from(capacities, ([model, targetSize]) => ({
    model,
    targetSize,
    lastUsed: lastUsage.used,
  })).filter(({ model, targetSize }) => model !== lastSuccessfulModel && targetSize < lastUsage.used)
  return { ...delivery, lastSuccessfulModel, lastUsage, ...(capacityRisks.length ? { capacityRisks } : {}) }
}

/** Raw occupancy can still belong to A after B has been confirmed. */
export function matchedManagedContextUsage(
  latest: AcpContextUsageView | null,
  confirmed: string | null | undefined,
  feedback: ManagedModelFeedback,
): AcpContextUsageView | null {
  if (!latest || !feedback.lastUsage || confirmed !== feedback.lastSuccessfulModel) return null
  return feedback.lastUsage.used === latest.used && feedback.lastUsage.size === latest.size
    ? { ...latest, cost: feedback.lastUsage.cost }
    : null
}

/** Check the actual image payload on the confirmed dispatch connection. */
export function assertManagedModelImageInput(
  binding: AcpBindingData,
  profile: AcpStubAgentConfig,
  model: string,
  agentSupportsImage: boolean | undefined,
  prompt: readonly acp.ContentBlock[],
): void {
  if (!prompt.some((block) => block.type === 'image')) return
  if (
    agentSupportsImage !== true ||
    inlineModels(binding, profile, new Set([model]))?.get(model)?.imageInput === false
  ) {
    throw LlmError.fromFailure({
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      message: 'The selected Agent model cannot receive the attached image.',
    })
  }
}
