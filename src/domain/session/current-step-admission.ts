/**
 * Current-step admission for the ordinary DSH AgentLoop request.
 *
 * `GenerateOptions.messages` is a projection and may contain the entire
 * conversation. It is not safe to send every direct user message to ACP. The
 * native Session projection of committed events is the authority: only user/message events between
 * the currently open step/start and its step/end are admitted, and only when
 * their stable ids also occur in the request projection. These include plugin
 * inputs and runtime context; their source must not make an admitted input vanish.
 */
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'

import type { SessionLike } from './session-facts.ts'
export type { SessionLike, SessionEventLike } from './session-facts.ts'

export interface CurrentStepProof {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly endSeq: number | null
  readonly acceptedMessageIds: readonly string[]
  readonly anchorMessageId: string
  /** Whether the request projection contained anything other than the logged
   * inputs admitted for this step. This is a bounded diagnostic fact; the
   * live event-log check above remains the actual admission boundary. */
  readonly projectionFiltered: boolean
}

export class AcpAdmissionError extends Error {
  constructor(readonly code:
    | 'ACP_SESSION_UNAVAILABLE'
    | 'ACP_NO_OPEN_STEP'
    | 'ACP_NO_CURRENT_INPUT') {
    super(code === 'ACP_SESSION_UNAVAILABLE'
        ? 'ACP cannot prove the live DSH session for this request'
        : code === 'ACP_NO_OPEN_STEP'
          ? 'ACP cannot prove a currently open DSH AgentLoop step'
          : 'the current DSH AgentLoop step contains no projected, logged input')
    this.name = 'AcpAdmissionError'
  }
}

/**
 * Admit the request's current step and return a durable provenance proof. The
 * callback is deliberately synchronous: callers must record the proof before
 * issuing the ACP RPC if they expose it to audit.
 */
export function admitCurrentStep(
  options: GenerateOptions,
  session: SessionLike | undefined,
  onProof?: (proof: CurrentStepProof) => void,
): readonly UserMessage[] {
  if (options.purpose !== undefined) return []
  // Do not gate on dsh-llm's process-local AgentLoop request marker here. The
  // LLM runtime is allowed to copy the request envelope while resolving model
  // defaults, projecting images, or filtering replay state, so exact object
  // identity does not survive to the final adapter boundary. The live session,
  // open step, and stable logged-input ids below are the durable proof.
  if (session === undefined) throw new AcpAdmissionError('ACP_SESSION_UNAVAILABLE')
  const step = session.facts.openSteps.at(-1)
  if (step === undefined) throw new AcpAdmissionError('ACP_NO_OPEN_STEP')
  const currentIds = step.messageIds
  const messagesById = new Map(options.messages.map(message => [String(message.id), message]))
  // Durable log order is authoritative. The projection order can differ after
  // middleware copies/reorders it, so never forward the projection's order.
  const admitted = currentIds
    .map(id => messagesById.get(id))
    .filter((message): message is UserMessage => message !== undefined && message.role === 'user')
  if (admitted.length === 0) throw new AcpAdmissionError('ACP_NO_CURRENT_INPUT')
  const proof: CurrentStepProof = {
    turn: step.turn,
    step: step.step,
    startSeq: step.startSeq,
    endSeq: null,
    acceptedMessageIds: admitted.map((message) => String(message.id)),
    anchorMessageId: String((admitted.findLast(message => message.source.kind === 'user') ?? admitted.at(-1)!).id),
    projectionFiltered: options.messages.length !== admitted.length,
  }
  onProof?.(proof)
  return admitted
}
