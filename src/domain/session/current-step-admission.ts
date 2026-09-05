/**
 * Current-step admission for the ordinary DSH AgentLoop request.
 *
 * `GenerateOptions.messages` is a projection and may contain the entire
 * conversation. It is not safe to send every direct user message to ACP. The
 * live Session event log is the authority: only user/message events between
 * the currently open step/start and its step/end are admitted, and only when
 * their stable ids also occur in the request projection. These include plugin
 * inputs and runtime context; their source must not make an admitted input vanish.
 */
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'

export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

export interface SessionLike {
  readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string; readonly delegationDepth?: number }
  readonly inheritedEventCount: number
  snapshotEvents(): readonly SessionEventLike[]
  /** Host sessions expose append; pure admission fixtures may omit it. */
  append?(type: string, data: unknown): unknown
}

/** Read one stable supported-DSH Session event snapshot for the current operation. */
export function snapshotSessionEvents(session: Pick<SessionLike, 'snapshotEvents'>): readonly SessionEventLike[] {
  return session.snapshotEvents()
}

export interface CurrentStepProof {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly endSeq: number | null
  readonly acceptedMessageIds: readonly string[]
  readonly anchorMessageId: string
  /** Request header that opened this exact model dispatch, when already
   * present in the live log at adapter admission time. */
  readonly requestHeaderSeq?: number
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

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Return the current unclosed step, if one exists. */
function openStep(events: readonly SessionEventLike[]): { turn: number; step: number; startSeq: number; endSeq: number | null } | undefined {
  const open = new Map<string, { turn: number; step: number; startSeq: number }>()
  for (const event of events) {
    if (event.type === 'step/start' && isRecord(event.data)
      && typeof event.data.turn === 'number' && typeof event.data.step === 'number') {
      const key = `${event.data.turn}:${event.data.step}`
      open.set(key, { turn: event.data.turn, step: event.data.step, startSeq: event.seq })
    } else if (event.type === 'step/end' && isRecord(event.data)
      && typeof event.data.turn === 'number' && typeof event.data.step === 'number') {
      open.delete(`${event.data.turn}:${event.data.step}`)
    }
  }
  const result = [...open.values()].sort((left, right) => left.startSeq - right.startSeq).at(-1)
  return result === undefined ? undefined : { ...result, endSeq: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const events = snapshotSessionEvents(session)
  const step = openStep(events)
  if (step === undefined) throw new AcpAdmissionError('ACP_NO_OPEN_STEP')
  const currentIds: string[] = []
  for (const event of events) {
    if (event.seq <= step.startSeq || event.type !== 'user/message' || !isRecord(event.data)) continue
    const id = idOf(event.data.id)
    if (id !== undefined && !currentIds.includes(id)) currentIds.push(id)
  }
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
    endSeq: step.endSeq,
    acceptedMessageIds: admitted.map((message) => String(message.id)),
    anchorMessageId: String((admitted.findLast(message => message.source.kind === 'user') ?? admitted.at(-1)!).id),
    ...(() => {
      const requestHeaderSeq = events
        .filter(event => event.seq > step.startSeq && event.type === 'request/header')
        .at(-1)?.seq
      return requestHeaderSeq === undefined ? {} : { requestHeaderSeq }
    })(),
    projectionFiltered: options.messages.length !== admitted.length,
  }
  onProof?.(proof)
  return admitted
}
