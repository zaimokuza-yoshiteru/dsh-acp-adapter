/**
 * Opt-in, process-local diagnostics for authenticated live-test runs. The
 * normal application has no sink and writes no additional logs.
 */
export type LiveDiagnosticTool =
  | 'spawn_teammate'
  | 'send_message'
  | 'list_agents'
  | 'wait_agent'
  | 'interrupt_agent'
  | 'team_task_create'
  | 'team_task_list'
  | 'team_task_get'
  | 'team_task_update'
  | 'other'
export type LiveDiagnosticTargetRole = 'lead' | 'teammate' | 'unknown'
export type LiveDiagnosticErrorKind =
  | 'ACP_PROTOCOL_ERROR'
  | 'ACP_RESOURCE_EXHAUSTED'
  | 'ACP_TIMEOUT'
  | 'ACP_ABORTED'
  | 'ACP_STEERING_OUTCOME_UNKNOWN'
  | 'ACP_TEAM_TOOL_FAILED'
  | 'TEAM_INVALID_ARGUMENT'
  | 'TEAM_INVALID_TARGET'
  | 'TEAM_SELF_MESSAGE'
  | 'TEAM_MAILBOX_FULL'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGS'
  | 'TOOL_TIMEOUT'

export type LiveDiagnosticEvent =
  | {
      readonly type: 'adapter-prompt/start' | 'adapter-prompt/end'
      readonly sessionId: string
      readonly acpSessionId?: string
      readonly promptOrdinal: number
      readonly leaseId?: string
      readonly durationMs?: number
      readonly stopReason?: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | 'max_turn_requests' | 'unknown'
      readonly operation?: 'session/prompt'
      readonly errorCode?: string
      readonly providerErrorKind?: 'resource_exhausted' | 'unavailable'
      readonly jsonRpcCode?: number | null
      readonly contextUsed?: number
      readonly contextSize?: number
    }
  | {
      readonly type:
        | 'mcp/tool/dispatch'
        | 'mcp/tool/settled'
        | 'host-execute/start'
        | 'host-execute/settled'
        | 'mcp-handler/returned'
        | 'mcp/tool/cancelled'
        | 'mcp/tool/rejected'
      readonly sessionId: string
      readonly acpSessionId?: string
      readonly leaseId?: string
      readonly leasePromptOrdinal?: number
      readonly adapterPromptOrdinal?: number
      readonly mcpRequestId?: string
      readonly hostCallId?: string
      readonly providerModelCallId?: string
      readonly modelToolCallIdStatus?: 'available' | 'unavailable'
      readonly clientReceiptStatus?: 'unavailable'
      readonly messageId?: string
      readonly tool: LiveDiagnosticTool
      readonly targetRole?: LiveDiagnosticTargetRole
      readonly argsHmac?: string
      readonly argsBytes?: number | null
      readonly argsFingerprintComplete?: boolean
      readonly bodyHmac?: string
      readonly bodyBytes?: number | null
      readonly bodyFingerprintComplete?: boolean
      readonly nextStepCount?: number
      readonly nextTurnCount?: number
      readonly nextStepTeamMessageCount?: number
      readonly nextTurnTeamMessageCount?: number
      readonly nextStepSourceCounts?: Readonly<Record<'user' | 'team-message' | 'system' | 'other', number>>
      readonly nextTurnSourceCounts?: Readonly<Record<'user' | 'team-message' | 'system' | 'other', number>>
      readonly inboxCountStatus?: 'available' | 'unavailable'
      readonly inboxSnapshotStage?: 'before-host-call' | 'handler-return' | 'unavailable'
      readonly additionalContextsCount?: number | null
      readonly repeatReminderContextCount?: number | null
      /** Whether generic queued-input text was appended; repeat-specific feedback is counted above, not here. */
      readonly pendingYieldAppended?: boolean | null
      readonly concludesTurnReminderAppended?: boolean | null
      readonly mcpRequestIdScope?: 'lease-local' | 'unavailable'
      readonly idReusedWithinLease?: boolean
      readonly mcpRequestHistoryTruncated?: boolean
      readonly sameArgsAsPreviousToolCall?: 'same' | 'different' | 'unavailable'
      readonly durationMs?: number
      readonly resultStatus?: 'success' | 'error' | 'cancelled' | 'unknown'
      readonly errorKind?: LiveDiagnosticErrorKind
      readonly providerToolCallId?: string
      readonly providerToolStatus?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown'
      readonly handlerIsError?: boolean
      readonly hostResultIsError?: boolean
      readonly transportRetryRelation?: 'unavailable'
      readonly rejectionReason?:
        'request-id-collision' | 'request-id-unavailable' | 'prompt-inactive' | 'tool-unavailable'
    }
  | {
      readonly type: 'acp-tool/update'
      readonly sessionId: string
      readonly acpSessionId?: string
      readonly leaseId?: string
      readonly adapterPromptOrdinal?: number
      readonly providerToolCallId: string
      readonly tool: LiveDiagnosticTool
      readonly providerToolStatus: 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown'
    }
  | {
      readonly type: 'acp-usage/update'
      readonly sessionId: string
      readonly acpSessionId?: string
      readonly adapterPromptOrdinal?: number
      readonly contextUsed: number
      readonly contextSize: number
    }

export interface LiveDiagnosticTraceSink {
  (event: LiveDiagnosticEvent): void | Promise<void>
  readonly id: (kind: string, value: unknown) => string
  readonly fingerprint: (
    kind: string,
    value: unknown,
  ) => { readonly hmac: string; readonly bytes: number | null; readonly complete: boolean }
}

const stateKey = Symbol.for('@zaimokuza/dsh-acp-adapter/live-diagnostic-trace/v1')
interface TraceState {
  readonly sink: LiveDiagnosticTraceSink
  failures: number
}

type TraceGlobal = typeof globalThis & Record<symbol, unknown>

function currentState(): TraceState | undefined {
  return (globalThis as TraceGlobal)[stateKey] as TraceState | undefined
}

/** Install an explicit test-owned sink. It is not enabled by default. */
export function installLiveDiagnosticTrace(sink: LiveDiagnosticTraceSink): () => void {
  const target = globalThis as TraceGlobal
  const state: TraceState = { sink, failures: 0 }
  target[stateKey] = state
  return () => {
    if (target[stateKey] === state) delete target[stateKey]
  }
}

/** Hash through the currently installed test sink; raw IDs never enter its event stream. */
export function liveDiagnosticId(kind: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return 'unavailable'
  try {
    const id = currentState()?.sink.id(kind, value)
    return typeof id === 'string' && (/^h:[a-f0-9]{24}$/.test(id) || id === 'unavailable') ? id : 'unavailable'
  } catch {
    noteFailure()
    return undefined
  }
}

/** Fingerprint input through the test run's in-memory HMAC key. */
export function liveDiagnosticFingerprint(
  kind: string,
  value: unknown,
): { readonly hmac: string; readonly bytes: number | null; readonly complete: boolean } | undefined {
  try {
    const fingerprint = currentState()?.sink.fingerprint(kind, value)
    if (fingerprint === undefined) return undefined
    const hmac = fingerprint.hmac
    const bytes = fingerprint.bytes
    const complete = fingerprint.complete
    return {
      hmac: typeof hmac === 'string' && /^h:[a-f0-9]{24}$/.test(hmac) ? hmac : 'unavailable',
      bytes: typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
      complete: complete === true && typeof hmac === 'string' && /^h:[a-f0-9]{24}$/.test(hmac),
    }
  } catch {
    noteFailure()
    return undefined
  }
}

/** Count diagnostic preparation failures without allowing them to affect host work. */
export function noteLiveDiagnosticFailure(): void {
  noteFailure()
}

/** Safely collect diagnostic fields; the factory is skipped without a sink. */
export function collectLiveDiagnostic<T>(factory: () => T): T | undefined {
  const state = currentState()
  if (state === undefined) return undefined
  try {
    return factory()
  } catch {
    state.failures += 1
    return undefined
  }
}

/** Lazily prepare and emit an event only when a sink is installed. */
export function captureLiveDiagnostic(factory: () => LiveDiagnosticEvent): void {
  const state = currentState()
  if (state === undefined) return
  try {
    const event = factory()
    const result = state.sink(event)
    if (result !== undefined && typeof (result as PromiseLike<void>).then === 'function') {
      void Promise.resolve(result).catch(() => {
        state.failures += 1
      })
    }
  } catch {
    state.failures += 1
  }
}

/** A diagnostics sink is observational only; callback failures never escape into Host behavior. */
export function emitLiveDiagnostic(event: LiveDiagnosticEvent): void {
  const state = currentState()
  if (state === undefined) return
  try {
    const result = state.sink(event)
    if (result !== undefined && typeof (result as PromiseLike<void>).then === 'function') {
      void Promise.resolve(result).catch(() => {
        state.failures += 1
      })
    }
  } catch {
    state.failures += 1
  }
}

export function liveDiagnosticTraceFailureCount(): number {
  return currentState()?.failures ?? 0
}

export function liveDiagnosticTraceEnabled(): boolean {
  return currentState() !== undefined
}

function noteFailure(): void {
  const state = currentState()
  if (state !== undefined) state.failures += 1
}
