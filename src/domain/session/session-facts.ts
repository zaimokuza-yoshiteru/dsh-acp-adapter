import { z } from 'zod'
import { acpReplayPayloadOf, acpReplayPayloadSchema } from './acp-replay-payload.ts'

export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

const stepSchema = z.object({
  turn: z.number(), step: z.number(), startSeq: z.number(),
  messageIds: z.array(z.string()),
})

/** ACP-only execution facts; the host owns folding, persistence and invalidation. */
export const sessionFactsSchema = z.object({
  turnOpen: z.boolean(), turnSeen: z.boolean(),
  hasSemanticHistory: z.boolean(), priorSemanticHistory: z.boolean(),
  openSteps: z.array(stepSchema),
  inheritedRemaining: z.number().int().nonnegative(),
  forkReplay: acpReplayPayloadSchema.nullable(),
})
export type SessionFacts = z.infer<typeof sessionFactsSchema>

export function initialSessionFacts(inheritedEventCount = 0): SessionFacts {
  return { turnOpen: false, turnSeen: false, hasSemanticHistory: false, priorSemanticHistory: false,
    openSteps: [], inheritedRemaining: inheritedEventCount, forkReplay: null }
}

/** One committed event; unrelated events retain identity and no transcript is cached. */
export function applySessionFact(previous: SessionFacts, event: SessionEventLike): SessionFacts {
  let state = previous
  if (state.inheritedRemaining > 0) state = { ...state,
    inheritedRemaining: state.inheritedRemaining - 1,
    forkReplay: acpReplayPayloadOf(event) ?? state.forkReplay,
  }
  if (event.type === 'turn/start') return { ...state, turnOpen: true, turnSeen: true, priorSemanticHistory: state.hasSemanticHistory }
  if (event.type === 'turn/end') return { ...state, turnOpen: false }
  const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
  if ((event.type === 'step/start' || event.type === 'step/end') && typeof data.turn === 'number' && typeof data.step === 'number') {
    const openSteps = state.openSteps.filter(step => step.turn !== data.turn || step.step !== data.step)
    if (event.type === 'step/start') openSteps.push({ turn: data.turn, step: data.step, startSeq: event.seq, messageIds: [] })
    return { ...state, openSteps }
  }
  if (event.type === 'user/message' && typeof data.id === 'string' && data.id.length > 0) {
    const id = data.id
    state = { ...state, openSteps: state.openSteps.map(step => step.messageIds.includes(id)
      ? step : { ...step, messageIds: [...step.messageIds, id] }) }
  }
  if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'request/header'].includes(event.type)) {
    if (!state.hasSemanticHistory) state = { ...state, hasSemanticHistory: true, priorSemanticHistory: state.turnSeen ? state.priorSemanticHistory : true }
  }
  return state
}

/** Live read face backed by native Session and projection services, not a log copy. */
export interface SessionLike {
  /** Original host object used to match disposal, even when this read face is recreated. */
  readonly identity?: object
  readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string; readonly delegationDepth?: number }
  readonly seq: number
  readonly facts: SessionFacts
  readonly permissions: { readonly sandbox: string | null; readonly approval: string | null }
  append?(type: string, data: unknown): unknown
}
