import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

export const DEVIN_LIVE_TRACE_MAX_BYTES = 2 * 1024 * 1024

const HASHED_ID_FIELDS = new Set([
  'runId',
  'actorId',
  'sessionId',
  'acpSessionId',
  'turnId',
  'stepId',
  'hostCallId',
  'rootHostCallId',
  'leaseId',
  'mcpRequestId',
  'acpPromptId',
  'acpReportedToolCallId',
  'providerToolCallId',
  'providerModelCallId',
  'messageId',
  'parentSessionId',
  'senderId',
  'targetId',
])
const DIGEST_FIELDS = new Set(['argsHmac', 'bodyHmac'])
const ALLOWED_EVENTS = new Set([
  'run/start',
  'run/summary',
  'adapter-prompt/start',
  'adapter-prompt/end',
  'mcp/tool/dispatch',
  'mcp/tool/settled',
  'host-execute/start',
  'host-execute/settled',
  'mcp-handler/returned',
  'mcp/tool/cancelled',
  'mcp/tool/rejected',
  'acp-tool/update',
  'acp-usage/update',
  'host/ready',
  'provider/ready',
  'phase/completed',
  'model/selected',
  'session/event',
  'tool/admission',
  'tool/settled',
  'tool/cancelled',
  'team/message/queued',
  'team/message/delivered',
  'team-message/receipt',
  'agent/inbox/claimed',
  'test/pass',
  'test/assertions-passed',
  'test/fail',
  'cleanup/start',
  'cleanup/end',
  'trace/truncated',
  'trace/final',
  'trace/write-failed',
  'test/wait',
  'test/wait/start',
  'test/wait/end',
  'run/metadata',
  'agent/created',
])
const SAFE_STRINGS = new Set([
  'acp-devin',
  'unknown',
  'other',
  'unavailable',
  'lead',
  'teammate',
  'lead-0',
  'lead-1',
  'member-0',
  'member-1',
  'initial',
  'mailbox',
  'followup',
  'spawn_teammate',
  'send_message',
  'bash',
  'accepted',
  'queued',
  'error',
  'success',
  'denied',
  'cancelled',
  'completed',
  'failed',
  'started',
  'ended',
  'timedOut',
  'noProgress',
  'idle',
  'running',
  'inactive',
  'provisioning',
  'user',
  'team-message',
  'system',
  'tool',
  'end_turn',
  'max_tokens',
  'refusal',
  'max_turn_requests',
  'cancelled',
  'completed',
  'error',
  'swe-2-high',
  'swe-1-6-fast',
  'darwin',
  'win32',
  'linux',
  'in_progress',
  'pending',
  'failed',
  'ACP_ABORTED',
  'ACP_AUTH_REQUIRED',
  'ACP_BINDING_PERSIST_FAILED',
  'ACP_CRASH',
  'ACP_CONFIG_CHANGE_DURING_PROMPT',
  'ACP_PROTOCOL_ERROR',
  'ACP_RESOURCE_EXHAUSTED',
  'ACP_SPAWN_FAILURE',
  'ACP_TIMEOUT',
  'ACP_STEERING_OUTCOME_UNKNOWN',
  'ACP_STEERING_FAILED',
  'ACP_TEAM_TOOL_FAILED',
  'TEAM_DISPOSED',
  'TEAM_INVALID_ARGUMENT',
  'TEAM_INVALID_TARGET',
  'TEAM_MAILBOX_FULL',
  'TEAM_MEMBER_NOT_FOUND',
  'TEAM_MESSAGE_TOO_LARGE',
  'TEAM_SELF_MESSAGE',
  'INVALID_ARGS',
  'UNKNOWN_TOOL',
  'INVALID_TOOL_OUTPUT',
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
  'TOOL_TIMEOUT',
  'resource_exhausted',
  'LIVE_TOOL_ALLOWED',
  'LIVE_TOOL_BUDGET_EXCEEDED',
  'LIVE_TOTAL_TOOL_BUDGET_EXCEEDED',
  'LIVE_TOOL_ACTOR_UNCLASSIFIED',
  'LIVE_TOOL_PHASE_UNCLASSIFIED',
  'LIVE_FOLLOWUP_TOOL_CALL_UNEXPECTED',
  'LIVE_LEAD_MESSAGE_UNEXPECTED',
  'LIVE_LEAD_SPAWN_BUDGET_EXCEEDED',
  'LIVE_TEAMMATE_MESSAGE_BUDGET_EXCEEDED',
  'LIVE_TIME_BUDGET_EXCEEDED',
  'LIVE_TEST_FAILED',
  'LIVE_WAIT_TIMED_OUT',
  'LIVE_TRACE_WRITE_FAILED',
  'LIVE_TRACE_OBSERVER_FAILED',
  'LIVE_TRACE_INCOMPLETE',
  'HOST_BOOT',
  'PROVIDER_REGISTERED',
  'MODEL_DISCOVERED',
  'RUN_TEAMS',
  'HOST_SETUP',
  'HOST_START',
  'PROVIDER_SETUP',
  'structured-code-only',
  'trace-write',
  'trace-observer',
  'cleanup',
])
const SAFE_FIELD_NAMES = new Set([
  'schemaVersion',
  'event',
  'sequence',
  'elapsedMs',
  ...HASHED_ID_FIELDS,
  ...DIGEST_FIELDS,
  'argsBytes',
  'bodyBytes',
  'argsFingerprintComplete',
  'bodyFingerprintComplete',
  'jsonRpcCode',
  'requestIdPreviouslySeen',
  'requestIdHistoryTruncated',
  'transportRetryRelation',
  'handlerIsError',
  'hostResultIsError',
  'errorKind',
  'actorRole',
  'actorLabel',
  'phase',
  'tool',
  'targetRole',
  'admission',
  'resultStatus',
  'errorCode',
  'providerErrorKind',
  'jsonRpcCode',
  'mcpRequestIdScope',
  'idReusedWithinLease',
  'mcpRequestHistoryTruncated',
  'inboxCountStatus',
  'rejectionReason',
  'operation',
  'stopReason',
  'hostEvent',
  'turn',
  'step',
  'sessionSeq',
  'hostRequestOrdinal',
  'acpPromptOrdinal',
  'promptOrdinal',
  'leasePromptOrdinal',
  'adapterPromptOrdinal',
  'mcpRequestPreviouslySeen',
  'activeRequestIdCollision',
  'sameArgsAsPreviousToolCall',
  'providerToolStatus',
  'costAmount',
  'dshTurn',
  'dshStep',
  'durationMs',
  'dispatchAttempt',
  'nextStepCount',
  'nextTurnCount',
  'nextStepTeamMessageCount',
  'nextTurnTeamMessageCount',
  'callerInboxPending',
  'exactExpectedMarker',
  'repeatPrevious',
  'nameNonblank',
  'descriptionNonblank',
  'promptNonblank',
  'contextFresh',
  'model',
  'provider',
  'success',
  'exitCode',
  'totalEvents',
  'omittedEvents',
  'maxBytes',
  'truncated',
  'writeFailed',
  'testResult',
  'workflowRun',
  'workflowAttempt',
  'platform',
  'pendingPromptCount',
  'nextStepSourceCounts',
  'nextTurnSourceCounts',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'contextUsed',
  'contextSize',
  'acpFinishReason',
  'hostPromptOrdinal',
  'modelToolCallIdStatus',
  'mcpRequestIdStatus',
  'clientReceiptStatus',
  'transportRetryRelation',
  'traceObserverFailures',
  'phaseCode',
  'stageCode',
  'diagnosticComplete',
  'waitName',
  'waitResult',
  'resultSource',
  'inboxSnapshotStage',
  'additionalContextsCount',
  'repeatReminderContextCount',
  'pendingYieldAppended',
  'concludesTurnReminderAppended',
  'errorSource',
  'messageIdStatus',
  'nativeReceiptStatus',
  'requestModelOrdinal',
  'nativeEventSeq',
  'callerInboxSources',
  'summaryVersion',
  'failureCount',
  'writeFailureCount',
  'incompleteReasons',
  'allowed',
  'senderRole',
  'senderLabel',
  'sendStatus',
  'matchedQueuedMessage',
  'exactMessageMatch',
  'uniqueQueuedMessages',
  'uniqueDeliveredMessages',
  'uniqueReceipts',
  'receiptsMatchingQueued',
  'deliveriesMatchingQueued',
  'receiptsAndDeliveries',
  'exactMarkerQueuedMessages',
  'exactMarkerReceipts',
  'exactMarkerDeliveries',
  'toolAdmission',
  'toolAttemptsByRolePhaseKind',
  'mailbox',
  'queuedSenderTargetRoles',
  'receiptSenderTargetRoles',
  'deliveredSenderTargetRoles',
  'resultCount',
  'markerCount',
  'durationSource',
  'mcpRequestIdStatus',
  'dispatchAttempts',
  'allowedDispatches',
  'deniedDispatches',
  'observedToolResults',
  'queuedMessages',
  'deliveredMessages',
  'receipts',
])
const SAFE_ENUM_FIELDS: Record<string, ReadonlySet<string>> = {
  event: ALLOWED_EVENTS,
  actorRole: new Set(['lead', 'teammate', 'unknown']),
  actorLabel: new Set(['lead-0', 'lead-1', 'member-0', 'member-1', 'unknown']),
  senderLabel: new Set(['lead-0', 'lead-1', 'member-0', 'member-1', 'unknown']),
  targetLabel: new Set(['lead-0', 'lead-1', 'member-0', 'member-1', 'unknown']),
  phase: new Set(['initial', 'mailbox', 'followup', 'unknown']),
  phaseCode: new Set([
    'HOST_BOOT',
    'PROVIDER_REGISTERED',
    'MODEL_DISCOVERED',
    'RUN_TEAMS',
    'HOST_SETUP',
    'HOST_START',
    'PROVIDER_SETUP',
    'LIVE_TOOL_ALLOWED',
    'LIVE_TOOL_BUDGET_EXCEEDED',
    'LIVE_TOTAL_TOOL_BUDGET_EXCEEDED',
    'LIVE_TOOL_ACTOR_UNCLASSIFIED',
    'LIVE_TOOL_PHASE_UNCLASSIFIED',
    'LIVE_FOLLOWUP_TOOL_CALL_UNEXPECTED',
    'LIVE_LEAD_MESSAGE_UNEXPECTED',
    'LIVE_LEAD_SPAWN_BUDGET_EXCEEDED',
    'LIVE_TEAMMATE_MESSAGE_BUDGET_EXCEEDED',
    'LIVE_TIME_BUDGET_EXCEEDED',
    'LIVE_TEST_FAILED',
    'LIVE_WAIT_TIMED_OUT',
    'LIVE_TRACE_WRITE_FAILED',
    'LIVE_TRACE_OBSERVER_FAILED',
    'LIVE_TRACE_INCOMPLETE',
    'unavailable',
  ]),
  stageCode: new Set([
    'HOST_SETUP',
    'HOST_START',
    'PROVIDER_SETUP',
    'RUN_TEAMS',
    'CLEANUP',
    'DIAGNOSTICS',
    'unavailable',
  ]),
  tool: new Set([
    'spawn_teammate',
    'send_message',
    'list_agents',
    'wait_agent',
    'interrupt_agent',
    'team_task_create',
    'team_task_list',
    'team_task_get',
    'team_task_update',
    'bash',
    'other',
  ]),
  targetRole: new Set(['lead', 'teammate', 'unknown']),
  admission: new Set(['admitted', 'denied']),
  resultStatus: new Set(['success', 'error', 'accepted', 'queued', 'unknown']),
  operation: new Set(['initialize', 'session/new', 'session/load', 'session/resume', 'session/prompt', 'unknown']),
  stopReason: new Set(['end_turn', 'max_tokens', 'cancelled', 'refusal', 'max_turn_requests', 'unknown']),
  hostEvent: new Set([
    'request/header',
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'assistant/message',
    'user/message',
    'tool/call',
    'tool/result',
    'usage_update',
    'other',
  ]),
  model: new Set(['swe-2-high', 'swe-1-6-fast', 'other', 'unavailable']),
  provider: new Set(['acp-devin', 'other', 'unavailable']),
  testResult: new Set(['pass', 'fail']),
  waitName: new Set([
    'provider-registration',
    'spawn-lead-0',
    'spawn-lead-1',
    'member-call-0',
    'member-call-1',
    'message-delivery-0',
    'message-delivery-1',
    'lead-reply-0',
    'lead-reply-1',
    'team-idle-0',
    'team-idle-1',
    'followup-0',
    'followup-1',
    'unknown',
  ]),
  waitResult: new Set(['timedOut', 'noProgress', 'observedChange', 'unknown']),
  resultSource: new Set(['host-condition', 'dsh-wait-agent', 'unavailable']),
  sendStatus: new Set(['accepted', 'queued', 'error', 'unknown']),
  inboxSnapshotStage: new Set(['before-host-call', 'handler-return', 'unavailable']),
  durationSource: new Set(['host-tool-result', 'bridge', 'unavailable']),
  mcpRequestIdStatus: new Set(['available', 'unavailable']),
  clientReceiptStatus: new Set(['unavailable']),
  nativeReceiptStatus: new Set(['pending', 'claimed', 'unavailable']),
  acpFinishReason: new Set(['end_turn', 'max_tokens', 'cancelled', 'unknown', 'unavailable']),
  modelToolCallIdStatus: new Set(['unavailable', 'available']),
  transportRetryRelation: new Set(['unavailable']),
  mcpRequestIdScope: new Set(['lease-local', 'unavailable']),
  inboxCountStatus: new Set(['available', 'unavailable']),
  rejectionReason: new Set(['request-id-collision', 'prompt-inactive', 'tool-unavailable']),
  providerErrorKind: new Set(['resource_exhausted', 'unavailable']),
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>()
  let nodes = 0
  let outputBytes = 0
  const maxBytes = 256 * 1024
  const append = (parts: string[], part: string): void => {
    const bytes = Buffer.byteLength(part, 'utf8')
    outputBytes += bytes
    if (outputBytes > maxBytes) throw new Error('trace-value-limit')
    parts.push(part)
  }
  const parts: string[] = []
  const encodeString = (value: string): string => {
    // Bound work before JSON.stringify can expand control characters several-fold.
    if (value.length > maxBytes) throw new Error('trace-value-limit')
    return JSON.stringify(value)
  }
  const visit = (current: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 20_000 || depth > 32) throw new Error('trace-value-limit')
    if (current === undefined) return append(parts, '{"$type":"undefined"}')
    if (typeof current === 'string') return append(parts, encodeString(current))
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      if (typeof current === 'number' && !Number.isFinite(current)) throw new Error('trace-value-invalid')
      return append(parts, JSON.stringify(current))
    }
    if (typeof current !== 'object' || seen.has(current)) throw new Error('trace-value-invalid')
    seen.add(current)
    append(parts, Array.isArray(current) ? '[' : '{')
    const entries = Array.isArray(current)
      ? current.map((item, index) => [String(index), item] as const)
      : Object.keys(current as Record<string, unknown>)
          .sort()
          .map((key) => [key, (current as Record<string, unknown>)[key]] as const)
    for (let index = 0; index < entries.length; index += 1) {
      const [key, item] = entries[index]!
      if (index > 0) append(parts, ',')
      if (!Array.isArray(current)) {
        append(parts, encodeString(key))
        append(parts, ':')
      }
      visit(item, depth + 1)
    }
    append(parts, Array.isArray(current) ? ']' : '}')
    seen.delete(current)
  }
  visit(value, 0)
  return parts.join('')
}

export interface DevinLiveTraceOptions {
  readonly directory: string
  readonly maxBytes?: number
  readonly key?: Uint8Array
  readonly onWriteFailure?: () => void
}

export interface DevinLiveFingerprint {
  readonly hmac: string
  readonly bytes: number | null
  readonly complete: boolean
}

/** Bounded, append-only live-test trace. The per-run HMAC key is never persisted. */
export class DevinLiveTrace {
  readonly filePath: string
  readonly runId: string
  readonly maxBytes: number
  private readonly key: Uint8Array
  private readonly startedAt = performance.now()
  private readonly reserveBytes = 1200
  private descriptor: number | undefined
  private bytesWritten = 0
  private sequence = 0
  private omittedEvents = 0
  private truncated = false
  private failed = false
  private incompleteFingerprints = 0
  private readonly onWriteFailure: (() => void) | undefined

  constructor(options: DevinLiveTraceOptions) {
    this.key = options.key ?? randomBytes(32)
    this.onWriteFailure = options.onWriteFailure
    this.maxBytes = Math.max(4096, options.maxBytes ?? DEVIN_LIVE_TRACE_MAX_BYTES)
    this.runId = this.id('run', randomUUID())
    this.filePath = join(options.directory, `real-devin-live-${this.runId.slice(2)}.jsonl`)
    try {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 })
      this.descriptor = openSync(this.filePath, 'w', 0o600)
      this.record('run/start', { runId: this.runId, schemaVersion: 1 })
    } catch {
      this.failed = true
      this.signalWriteFailure()
    }
  }

  get writeFailed(): boolean {
    return this.failed
  }

  get diagnosticIncomplete(): boolean {
    return this.incompleteFingerprints > 0
  }

  id(kind: string, value: unknown): string {
    if (value === undefined || value === null) return 'unavailable'
    try {
      return `h:${createHmac('sha256', this.key)
        .update(`${kind}\0${stableJson(value)}`)
        .digest('hex')
        .slice(0, 24)}`
    } catch {
      this.incompleteFingerprints += 1
      return 'unavailable'
    }
  }

  fingerprint(kind: string, value: unknown): DevinLiveFingerprint {
    let canonical: string
    try {
      canonical = stableJson(value)
    } catch {
      this.incompleteFingerprints += 1
      return { hmac: 'unavailable', bytes: null, complete: false }
    }
    return {
      hmac: `h:${createHmac('sha256', this.key).update(`${kind}\0${canonical}`).digest('hex').slice(0, 24)}`,
      bytes: Buffer.byteLength(canonical, 'utf8'),
      complete: true,
    }
  }

  record(event: string, fields: Record<string, unknown> = {}): void {
    if (this.descriptor === undefined || this.failed) return
    if (this.truncated) {
      this.omittedEvents += 1
      return
    }
    try {
      this.sequence += 1
      const candidate = {
        ...this.sanitize(event, fields),
        runId: this.runId,
        schemaVersion: 1,
        sequence: this.sequence,
        elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
      }
      const line = `${JSON.stringify(candidate)}\n`
      if (this.bytesWritten + Buffer.byteLength(line) > this.maxBytes - this.reserveBytes) {
        this.truncated = true
        this.omittedEvents = 1
        this.sequence += 1
        this.writeReserved({
          schemaVersion: 1,
          sequence: this.sequence,
          elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
          event: 'trace/truncated',
          truncated: true,
          maxBytes: this.maxBytes,
          omittedEvents: null,
        })
        return
      }
      this.write(line)
    } catch {
      this.failed = true
      this.signalWriteFailure()
    }
  }

  finish(result: 'pass' | 'fail', summary: Record<string, unknown>): void {
    if (this.descriptor === undefined || this.failed) return
    this.record('run/summary', {
      runId: this.runId,
      testResult: result,
      totalEvents: this.sequence,
      omittedEvents: this.omittedEvents,
      truncated: this.truncated,
      ...summary,
    })
    if (this.descriptor !== undefined && !this.failed) {
      this.writeReserved({
        schemaVersion: 1,
        sequence: ++this.sequence,
        elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
        event: 'trace/final',
        runId: this.runId,
        testResult: result,
        totalEvents: this.sequence,
        omittedEvents: this.omittedEvents,
        truncated: this.truncated,
        writeFailed: this.failed,
      })
    }
    try {
      if (this.descriptor !== undefined) closeSync(this.descriptor)
      this.descriptor = undefined
    } catch {
      this.failed = true
    }
  }

  private sanitize(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    return { ...this.sanitizeFields(fields), event: ALLOWED_EVENTS.has(event) ? event : 'trace/write-failed' }
  }

  private sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (!SAFE_FIELD_NAMES.has(key)) continue
      if (key === 'event' || key === 'sequence' || key === 'schemaVersion' || key === 'elapsedMs') continue
      if (HASHED_ID_FIELDS.has(key)) {
        safe[key] = typeof value === 'string' && /^h:[a-f0-9]{24}$/.test(value) ? value : 'unavailable'
      } else if (DIGEST_FIELDS.has(key)) {
        safe[key] = typeof value === 'string' && /^h:[a-f0-9]{24}$/.test(value) ? value : 'unavailable'
      } else if (typeof value === 'string') {
        const enumValues = SAFE_ENUM_FIELDS[key]
        safe[key] = enumValues?.has(value) === true || SAFE_STRINGS.has(value) ? value : 'unavailable'
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        safe[key] =
          key === 'jsonRpcCode'
            ? Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value))
            : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value))
      } else if (typeof value === 'boolean' || value === null) {
        safe[key] = value
      } else if (
        (key === 'nextStepSourceCounts' || key === 'nextTurnSourceCounts' || key === 'callerInboxSources') &&
        typeof value === 'object' &&
        value !== null
      ) {
        safe[key] = this.sanitizeSourceCounts(value)
      }
    }
    return safe
  }

  private sanitizeSourceCounts(value: object): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const source of ['user', 'team-message', 'system', 'other']) {
      const count = (value as Record<string, unknown>)[source]
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[source] = count
    }
    return counts
  }

  private write(line: string): void {
    try {
      if (this.descriptor === undefined) return
      const bytes = Buffer.from(line, 'utf8')
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = writeSync(this.descriptor, bytes, offset, bytes.byteLength - offset)
        if (written <= 0) throw new Error('trace-write-incomplete')
        offset += written
      }
      this.bytesWritten += bytes.byteLength
    } catch {
      this.failed = true
      this.signalWriteFailure()
      try {
        closeSync(this.descriptor!)
      } catch {
        // Preserve the already-written partial trace.
      }
      this.descriptor = undefined
    }
  }

  private writeReserved(record: Record<string, unknown>): void {
    try {
      const line = `${JSON.stringify({ ...record, runId: this.runId, schemaVersion: 1 })}\n`
      if (this.bytesWritten + Buffer.byteLength(line) <= this.maxBytes) this.write(line)
      else {
        this.failed = true
        this.signalWriteFailure()
      }
    } catch {
      this.failed = true
      this.signalWriteFailure()
    }
  }

  private signalWriteFailure(): void {
    try {
      this.onWriteFailure?.()
    } catch {
      // Diagnostics cannot replace the original live-test result.
    }
  }
}
