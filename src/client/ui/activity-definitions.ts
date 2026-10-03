import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationLocation,
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { acpReplayPayloadOf } from '../data/acp-replay-payload.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'acp-activity': AcpActivityNodeData
    'acp-activity-live': AcpActivityNodeData
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'acp-activity': AcpActivityNodeData
  }
}

export interface AcpActivityNodeData {
  readonly settled?: true
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
  readonly profileId: string
  readonly agentSessionId: string
  readonly committedActivitySeq: number
}

interface AcpPromptAnchorState {
  readonly anchorMessageId: string
  readonly lastDirectUserMessageId?: string
  readonly seq: number
  readonly location: ConversationLocation
}

interface AcpActivityState extends AcpActivityNodeData {
  readonly seq: number
  readonly location: ConversationLocation
}

interface AcpEffectiveRouteChange {
  readonly seq: number
  readonly turn?: number
  readonly step?: number
  readonly provider: string | undefined
}

interface AcpEffectiveRouteState {
  readonly baselineProvider: string | undefined
  readonly currentProvider: string | undefined
  readonly changes: readonly AcpEffectiveRouteChange[]
}

type ActivityNode = ChatConversationViewNode & {
  readonly kind: 'acp-activity'
  readonly data: AcpActivityNodeData
}

type OwnsAcpRoute = (provider: string | undefined) => boolean

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface UserInputMessage {
  readonly messageId: string
  readonly sourceKind: string
}

function userInputMessage(event: { readonly type: string; readonly data: unknown }): UserInputMessage | undefined {
  if (event.type !== 'user/message' || !record(event.data)) return undefined
  const source = record(event.data.source) ? event.data.source : undefined
  return typeof source?.kind === 'string' && typeof event.data.id === 'string'
    ? { messageId: event.data.id, sourceKind: source.kind }
    : undefined
}

function sameStep(left: ConversationLocation, right: ConversationLocation): boolean {
  return (
    left.kind === 'step' &&
    right.kind === 'step' &&
    left.turn.turn === right.turn.turn &&
    left.step.step === right.step.step
  )
}

function promptAnchorForInput(
  input: UserInputMessage,
  location: ConversationLocation,
  previous: AcpPromptAnchorState | undefined,
): Omit<AcpPromptAnchorState, 'seq'> {
  const prior = previous !== undefined && sameStep(previous.location, location) ? previous : undefined
  const lastDirectUserMessageId = input.sourceKind === 'user' ? input.messageId : prior?.lastDirectUserMessageId
  return {
    anchorMessageId: lastDirectUserMessageId ?? input.messageId,
    ...(lastDirectUserMessageId === undefined ? {} : { lastDirectUserMessageId }),
    location,
  }
}

function requestProvider(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'request/header' || !record(event.data)) return undefined
  const header = record(event.data.header) ? event.data.header : undefined
  const config = record(header?.config) ? header.config : undefined
  return typeof config?.provider === 'string' ? config.provider : undefined
}

function promptProvider(value: unknown): string | undefined {
  if (!record(value)) return undefined
  const prompt = record(value.prompt) ? value.prompt : undefined
  const config = record(prompt?.config) ? prompt.config : undefined
  return typeof config?.provider === 'string' ? config.provider : undefined
}

function effectiveRouteForStep(
  state: AcpEffectiveRouteState | undefined,
  location: ConversationLocation,
): string | undefined {
  if (state === undefined || location.kind !== 'step') return undefined
  const targetTurn = location.turn.turn
  const targetStep = location.step.step
  let provider = state.baselineProvider
  for (const change of state.changes) {
    if (change.turn === undefined || change.step === undefined) {
      const stepStartSeq = location.step.start?.seq
      if (stepStartSeq !== undefined && change.seq < stepStartSeq) provider = change.provider
      continue
    }
    if (change.turn < targetTurn || (change.turn === targetTurn && change.step <= targetStep))
      provider = change.provider
  }
  return provider
}

export function createAcpEffectiveRouteDefinition(): ConversationNodeDefinition<AcpEffectiveRouteState> {
  const updateRoute = (state: AcpEffectiveRouteState, match: ConversationMatch): AcpEffectiveRouteState => {
    const provider = requestProvider(match.event)
    if (match.event.type !== 'request/header') return state
    if (provider === state.currentProvider) return state
    const { turn, step } =
      match.location.kind === 'step' ? { turn: match.location.turn.turn, step: match.location.step.step } : {}
    let earlierStepRoute = state.baselineProvider
    if (turn !== undefined && step !== undefined) {
      const stepStartSeq = match.location.kind === 'step' ? match.location.step.start?.seq : undefined
      for (const change of state.changes) {
        if (change.turn === undefined || change.step === undefined) {
          if (stepStartSeq !== undefined && change.seq < stepStartSeq) earlierStepRoute = change.provider
        } else if (change.turn < turn || (change.turn === turn && change.step < step)) {
          earlierStepRoute = change.provider
        }
      }
    }
    const sameStep =
      turn === undefined || step === undefined
        ? -1
        : state.changes.findIndex((change) => change.turn === turn && change.step === step)
    const inherited = turn === undefined || step === undefined ? state.currentProvider : earlierStepRoute
    const changes = [...state.changes]
    if (sameStep >= 0) changes.splice(sameStep, 1)
    if (provider !== inherited) {
      changes.push({
        seq: match.event.seq,
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        provider,
      })
    }
    return { ...state, currentProvider: provider, changes }
  }

  return {
    kind: 'acp-effective-route',
    match: (event) =>
      event.type === 'turn/start' || event.type === 'request/header' ? { id: 'effective', role: 'start' } : null,
    start: (_context, match, reader) => {
      const initialProvider = promptProvider(reader.previous<{ readonly prompt?: unknown }>('request-prompt')?.state)
      const state: AcpEffectiveRouteState = {
        baselineProvider: initialProvider,
        currentProvider: initialProvider,
        changes: [],
      }
      return updateRoute(state, match)
    },
    update: (context, match) => updateRoute(context.state, match),
  }
}

function interruptedAssistantProvider(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'assistant/message' || !record(event.data) || event.data.interrupted !== true) return undefined
  const message = record(event.data.message) ? event.data.message : undefined
  const source = record(message?.source) ? message.source : undefined
  return source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : undefined
}

function activityNodeData(state: AcpActivityState): AcpActivityNodeData {
  return {
    ...(state.settled === true ? { settled: true } : {}),
    ownerDshSessionId: state.ownerDshSessionId,
    promptAnchorMessageId: state.promptAnchorMessageId,
    profileId: state.profileId,
    agentSessionId: state.agentSessionId,
    committedActivitySeq: state.committedActivitySeq,
  }
}

/** State-only admitted-input anchor consumed by subsequent ACP requests. */
export const acpPromptAnchorDefinition: ConversationNodeDefinition<AcpPromptAnchorState> = {
  kind: 'acp-prompt-anchor',
  match: (event) => {
    const input = userInputMessage(event)
    return input === undefined ? null : { id: `input:${input.messageId}`, role: 'start' }
  },
  start: (_context, match, reader) => {
    const input = userInputMessage(match.event)
    if (input === undefined) throw new Error('acp-prompt-anchor requires a user message')
    return {
      ...promptAnchorForInput(input, match.location, reader.previous<AcpPromptAnchorState>('acp-prompt-anchor')?.state),
      seq: match.event.seq,
    }
  },
  update: (context) => context.state,
}

/** An ACP request plus its durable replay marker produces a read-only activity view. */
export function createAcpActivityDefinition(ownsRoute: OwnsAcpRoute): ConversationNodeDefinition<AcpActivityState> {
  return {
    kind: 'acp-activity',
    target: 'chat',
    match: (event) => {
      const payload = acpReplayPayloadOf(event)
      if (payload !== undefined)
        return {
          id: `answer:${JSON.stringify([payload.ownerDshSessionId, payload.profileId, payload.profileGeneration, payload.bindingEpoch, payload.agentSessionId, payload.committedPromptOrdinal])}`,
          role: 'start',
        }
      const interruptedProvider = interruptedAssistantProvider(event)
      if (interruptedProvider !== undefined && ownsRoute(interruptedProvider))
        return { id: `interrupted:${event.seq}`, role: 'start' }
      const provider = requestProvider(event)
      return provider !== undefined && ownsRoute(provider) ? { id: `request:${event.seq}`, role: 'start' } : null
    },
    start: (_context, match, reader) => {
      const payload = acpReplayPayloadOf(match.event)
      if (payload !== undefined) {
        return {
          settled: true,
          ownerDshSessionId: payload.ownerDshSessionId,
          promptAnchorMessageId: payload.activityAnchorMessageId ?? `prompt:${payload.committedPromptOrdinal}`,
          profileId: payload.profileId,
          agentSessionId: payload.agentSessionId,
          committedActivitySeq: payload.committedActivitySeq,
          seq: match.event.seq,
          location: match.location,
        }
      }
      const interruptedProvider = interruptedAssistantProvider(match.event)
      const provider = requestProvider(match.event) ?? interruptedProvider
      if (provider === undefined) throw new Error('acp-activity requires a matched ACP request or interrupted answer')
      const candidateAnchor = reader.previous<AcpPromptAnchorState>('acp-prompt-anchor')?.state
      const anchor =
        candidateAnchor !== undefined && sameStep(candidateAnchor.location, match.location)
          ? candidateAnchor.anchorMessageId
          : undefined
      if (interruptedProvider !== undefined) {
        const previous = reader.previous<AcpActivityState>('acp-activity')?.state
        if (
          previous !== undefined &&
          previous.settled !== true &&
          previous.profileId === interruptedProvider &&
          sameStep(previous.location, match.location) &&
          (anchor === undefined || previous.promptAnchorMessageId === anchor)
        ) {
          return { ...previous, settled: true, seq: match.event.seq, location: match.location }
        }
      }
      return {
        ...(interruptedProvider === undefined ? {} : { settled: true as const }),
        ownerDshSessionId: '',
        promptAnchorMessageId: anchor ?? `request:${match.event.seq}`,
        profileId: provider,
        agentSessionId: '',
        committedActivitySeq: 0,
        seq: match.event.seq,
        location: match.location,
      }
    },
    update: (context) => context.state,
    buildLocationData: (context, scope) => {
      const state = context.state
      if (scope !== 'step' || state?.settled !== true || state.location.kind !== 'step') return null
      return {
        kind: 'step',
        turn: state.location.turn.turn,
        step: state.location.step.step,
        key: 'acp-activity',
        value: activityNodeData(state),
      }
    },
    buildViewNode: (context): ActivityNode | null => {
      if (context.state === undefined) return null
      return {
        key: context.key,
        kind: 'acp-activity',
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.state.location,
        visibility: 'visible',
        data: activityNodeData(context.state),
      }
    },
  }
}

/** Own an admitted user/message input's effective ACP route as a read-only live marker. */
export function createAcpLiveActivityDefinition(ownsRoute: OwnsAcpRoute): ConversationNodeDefinition<AcpActivityState> {
  return {
    kind: 'acp-activity-live',
    target: 'chat',
    match: (event) => {
      const input = userInputMessage(event)
      return input === undefined ? null : { id: `input:${input.messageId}`, role: 'start' }
    },
    start: (_context, match, reader) => {
      const input = userInputMessage(match.event)
      if (input === undefined) throw new Error('acp-activity-live requires a user message')
      const anchor = promptAnchorForInput(
        input,
        match.location,
        reader.previous<AcpPromptAnchorState>('acp-prompt-anchor')?.state,
      )
      const route = reader.previous<AcpEffectiveRouteState>('acp-effective-route')?.state
      const provider = effectiveRouteForStep(route, match.location)
      return {
        ownerDshSessionId: '',
        promptAnchorMessageId: anchor.anchorMessageId,
        profileId: provider !== undefined && ownsRoute(provider) ? provider : '',
        agentSessionId: '',
        committedActivitySeq: 0,
        seq: match.event.seq,
        location: match.location,
      }
    },
    update: (context) => context.state,
    buildViewNode: (context): ActivityNode | null => {
      const state = context.state
      if (state === undefined) return null
      return {
        key: context.key,
        kind: 'acp-activity',
        id: context.id,
        target: 'chat',
        anchorSeq: state.seq,
        location: state.location,
        visibility: state.profileId === '' ? 'hidden' : 'visible',
        data: activityNodeData(state),
      }
    },
  }
}
