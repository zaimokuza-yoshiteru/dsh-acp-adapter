/**
 * Opt-in diagnostics owned by one Host or authenticated live-test run. The
 * normal application has no sink and writes no additional logs.
 */
export type LiveDiagnosticTool =
  | 'subagent'
  | 'subagent_fork'
  | 'subagent_oar'
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

/** A run-owned observer; passing it explicitly also works across source and built module graphs. */
export interface LiveDiagnosticTrace {
  /** Replace the current sink; its disposer stops admission immediately and drains accepted writes. */
  install(sink: LiveDiagnosticTraceSink): () => Promise<void>
  enabled(): boolean
  id(kind: string, value: unknown): string | undefined
  fingerprint(
    kind: string,
    value: unknown,
  ): { readonly hmac: string; readonly bytes: number | null; readonly complete: boolean } | undefined
  collect<T>(factory: () => T): T | undefined
  emit(event: LiveDiagnosticEvent): void
  noteFailure(): void
  /** Failures remain visible after a sink is replaced or the owner is disposed. */
  failureCount(): number
  /** Revoke all sinks and wait for writes accepted before revocation. */
  dispose(): Promise<void>
}

interface TraceState {
  readonly sink: LiveDiagnosticTraceSink
  readonly pending: Set<Promise<void>>
  closed: boolean
}

/** Create a disabled observer with no process-wide state; the caller owns its disposal. */
export function createLiveDiagnosticTrace(): LiveDiagnosticTrace {
  const states = new Set<TraceState>()
  let current: TraceState | undefined
  let failures = 0
  let disposed = false
  let disposing: Promise<void> | undefined
  const closeState = (state: TraceState): Promise<void> => {
    state.closed = true
    if (current === state) current = undefined
    if (state.pending.size === 0) states.delete(state)
    return Promise.all(state.pending).then(() => {
      states.delete(state)
    })
  }
  return {
    install(sink) {
      if (disposed) throw new Error('Live diagnostic owner has been disposed')
      if (current !== undefined) void closeState(current)
      const state: TraceState = { sink, pending: new Set(), closed: false }
      states.add(state)
      current = state
      return () => closeState(state)
    },
    enabled() {
      return current !== undefined
    },
    id(kind, value) {
      const state = current
      if (state === undefined) return undefined
      if (value === undefined || value === null) return 'unavailable'
      try {
        const id = state.sink.id(kind, value)
        return typeof id === 'string' && (/^h:[a-f0-9]{24}$/.test(id) || id === 'unavailable') ? id : 'unavailable'
      } catch {
        failures += 1
        return undefined
      }
    },
    fingerprint(kind, value) {
      const state = current
      if (state === undefined) return undefined
      try {
        const fingerprint = state.sink.fingerprint(kind, value)
        const { hmac, bytes, complete } = fingerprint
        const validHmac = typeof hmac === 'string' && /^h:[a-f0-9]{24}$/.test(hmac)
        return {
          hmac: validHmac ? hmac : 'unavailable',
          bytes: typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
          complete: complete === true && validHmac,
        }
      } catch {
        failures += 1
        return undefined
      }
    },
    collect(factory) {
      if (current === undefined) return undefined
      try {
        return factory()
      } catch {
        failures += 1
        return undefined
      }
    },
    emit(event) {
      const state = current
      if (state === undefined) return
      // Reserve before calling user code so reentrant disposal also awaits this write.
      const completion = Promise.withResolvers<void>()
      state.pending.add(completion.promise)
      const settle = (): void => {
        state.pending.delete(completion.promise)
        if (state.closed && state.pending.size === 0) states.delete(state)
        completion.resolve()
      }
      try {
        void Promise.resolve(state.sink(event)).then(settle, () => {
          failures += 1
          settle()
        })
      } catch {
        failures += 1
        settle()
      }
    },
    noteFailure() {
      if (current !== undefined) failures += 1
    },
    failureCount() {
      return failures
    },
    dispose() {
      if (disposing !== undefined) return disposing
      disposed = true
      current = undefined
      disposing = Promise.all([...states].map(closeState)).then(() => undefined)
      return disposing
    },
  }
}
