/**
 * Minimal ACP session owner used by the provider adapter.
 *
 * This is deliberately not a DSH Agent or AgentLoop.  It owns one ACP
 * connection and one ACP session for one DSH model route, while the stock DSH
 * loop remains responsible for turns, history, cancellation and UI.
 */
/// <reference types="node" />

import type * as acp from '@agentclientprotocol/sdk'
import { AcpClientConnection, supportsFork } from '../../protocol/v1/connection.ts'
import type { AcpConnectionSpec, AcpSpawnPlanView } from '../process/types.ts'
import type { SubprocessSeam } from '../process/subprocess.ts'
import type { AcpFileSystemHandlers } from '../client-capabilities/filesystem.ts'
import { acpConfigOptionsSnapshot } from '../../protocol/v1/config-options.ts'
import type { AcpSessionNotification, AcpTerminalHandlers } from '../../protocol/v1/types.ts'
import { waitWithin } from '../process/timeout.ts'
import { AcpHostSettlementError } from './mcp-lease.ts'
import type { AcpMcpLease } from './mcp-lease.ts'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'
import {
  collectLiveDiagnostic,
  emitLiveDiagnostic,
  liveDiagnosticId,
  liveDiagnosticTraceEnabled,
} from '../../contract/live-diagnostic-trace.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import { performance } from 'node:perf_hooks'
import { generatedContextBlock } from '../text-block-boundary.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../contract/config-options.ts'
import { isQwenUserQuestion } from '../../domain/policy/qwen-question.ts'
import { RequestError } from '@agentclientprotocol/sdk'
import type { QwenTurnEndParams, QwenTurnStartParams, QwenTurnStartResult } from '../../protocol/v1/types.ts'
import {
  QwenBackgroundTasks,
  qwenTaskCompletion,
  qwenTaskSnapshots,
  type QwenTaskJobStarter,
} from './qwen-background.ts'

const safeAcpErrorCodes = new Set([
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
  'ACP_HOST_CALL_DRAIN_TIMEOUT',
  'ACP_HOST_GENERATION_STILL_ACTIVE',
  'ACP_HOST_TOOL_NOT_DISPATCHED',
  'ACP_HOST_FEEDBACK_COMMIT_FAILED',
  'ACP_HOST_TOOL_RECONCILIATION_REQUIRED',
])

function structuredAcpErrorCode(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return 'unavailable'
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' && safeAcpErrorCodes.has(code) ? code : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function structuredJsonRpcCode(error: unknown): number | null {
  try {
    if (typeof error !== 'object' || error === null) return null
    const cause = (error as { readonly cause?: unknown }).cause
    if (typeof cause !== 'object' || cause === null || !('code' in cause)) return null
    const code = (cause as { readonly code?: unknown }).code
    return typeof code === 'number' && Number.isSafeInteger(code) ? code : null
  } catch {
    return null
  }
}

function structuredProviderErrorKind(error: unknown): 'resource_exhausted' | 'unavailable' {
  try {
    if (error instanceof AcpClientError && error.kind === 'resource-exhausted') return 'resource_exhausted'
    if (typeof error !== 'object' || error === null || !('cause' in error)) return 'unavailable'
    const cause = (error as { readonly cause?: unknown }).cause
    if (typeof cause !== 'object' || cause === null || !('data' in cause)) return 'unavailable'
    const data = (cause as { readonly data?: unknown }).data
    return typeof data === 'object' && data !== null && 'errorKind' in data && data.errorKind === 'resource_exhausted'
      ? 'resource_exhausted'
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
/** Deliberately protocol-local: runtime restoration does not own persistence. */
export interface AcpRuntimeBindingRef {
  readonly agentSessionId: string
}
export interface AcpRuntimeConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

export interface AcpRuntimeLaunch {
  readonly mcpLease?: AcpMcpLease
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly spawnPlan: AcpSpawnPlanView
}

export interface AcpRuntimeContextUsage {
  readonly used: number
  readonly size: number
  readonly cost?: { readonly amount: number; readonly currency: string } | null
}

export interface AcpSessionRuntimeOptions {
  /** DSH session id used only by the opt-in live-test diagnostic observer. */
  readonly diagnosticDshSessionId?: string
  readonly mcpKey?: () => unknown
  readonly createMcpLease?: (capabilities: acp.AgentCapabilities | undefined) => Promise<AcpMcpLease | undefined>
  readonly profileId: string
  /** Explicit runtime-bound gate for Claude's private draft extension. */
  readonly enableClaudeDraftSubagents?: boolean
  readonly config: AcpRuntimeConfig
  readonly subprocess: SubprocessSeam
  readonly cwd: string
  readonly prepareLaunch: (config: AcpRuntimeConfig, cwd: string) => Promise<AcpRuntimeLaunch>
  /** Optional host capability handlers, created after the native launch environment is known. */
  readonly createFileSystemHandlers?: (context: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
  }) => AcpFileSystemHandlers
  readonly createTerminalHandlers?: (context: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
  }) => AcpTerminalHandlers
  /** Replay/load notifications are staging-only; the DSH log remains authoritative. */
  readonly onSessionUpdate?: (notification: AcpSessionNotification) => void
  /** Host-owned approval bridge. The optional signal is the active prompt lifetime. */
  readonly onPermissionRequest?: (
    params: acp.RequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>
  readonly onPermissionCheck?: (check: AcpPermissionCheck, request: acp.RequestPermissionRequest) => Promise<void>
  /** Host-owned form elicitation bridge; URL elicitation is intentionally not advertised. */
  readonly onElicitationRequest?: (
    params: acp.CreateElicitationRequest,
    signal?: AbortSignal,
    hostToolName?: string,
    hostToolCall?: acp.ToolCallUpdate,
  ) => Promise<acp.CreateElicitationResponse>
  /** One-shot diagnostic for optional private capability degradation. */
  readonly onCapabilityDegraded?: (message: string) => void
  /** Best-effort notification when a terminal ACP response is waiting on Host settlement. */
  readonly onHostSettlementChanged?: () => void
  /** Reopen a confirmed-cancelled native session before its next bound prompt. */
  readonly refreshSessionAfterCancelledPrompt?: boolean
  /** Grace period after `session/cancel` before the Agent process is closed. */
  readonly cancelGraceMs?: number
  /** Qwen `ask_user_question` bridge (permission request carrying questions + `answers`). */
  readonly onQwenQuestion?: (
    params: acp.RequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>
  /** Host job registry seam. Enables Qwen background-task mirroring and adoption of Qwen-initiated turns. */
  readonly qwenTaskJobs?: QwenTaskJobStarter
  /** How long an adopting host call waits for Qwen to announce its turn. */
  readonly agentTurnWaitMs?: number
  /** Unannounced (cron) turn: bound without authoritative activity reports, never a success deadline. */
  readonly unannouncedIdleMs?: number
}

export type AcpForkPreDispatchCode = 'ACP_FORK_UNSUPPORTED' | 'ACP_FORK_PRECONDITION_FAILED' | 'ACP_FORK_INTENT_FAILED'

/** A fork failure established before RPC dispatch; matching display text is not such proof. */
export class AcpForkPreDispatchError extends Error {
  readonly code: AcpForkPreDispatchCode

  constructor(code: AcpForkPreDispatchCode, cause?: unknown) {
    const messages: Record<AcpForkPreDispatchCode, string> = {
      ACP_FORK_UNSUPPORTED: 'The ACP Agent does not advertise session/fork',
      ACP_FORK_PRECONDITION_FAILED: 'The ACP Agent no longer matches the parent binding',
      ACP_FORK_INTENT_FAILED: 'The ACP fork intent could not be persisted before dispatch',
    }
    super(messages[code], { cause })
    this.name = 'AcpForkPreDispatchError'
    this.code = code
  }
}

/** Options for one `prompt()` call. */
export interface AcpPromptOptions {
  /** Host execution lifetime, distinct from directory/input handoff cancellation. */
  readonly hostBodySignal?: AbortSignal
  /**
   * The host turn was woken by a Qwen background-task notice: run the turn
   * Qwen has started by itself instead of sending `session/prompt`. Falls back
   * to an ordinary prompt when no such turn is announced in time.
   */
  readonly adoptAgentTurn?: boolean
  /** Already-admitted non-Qwen input, dispatched after a confirmed adopted terminal response. */
  readonly followupContent?: acp.ContentBlock[]
}

/** One Agent-initiated (Qwen `_qwencode/start_turn`) turn. */
interface AgentTurn {
  readonly turnId: string
  /** false = inferred from out-of-turn updates (Qwen cron/loop turns carry no start/end markers). */
  readonly announced: boolean
  readonly buffer: AcpSessionNotification[]
  listener: ((notification: AcpSessionNotification) => void) | undefined
  ended: string | undefined
  readonly endedPromise: Promise<string>
  readonly end: (reason: string) => void
  /** Full-snapshot watermark and activity evidence for unannounced turns. */
  workSeq: number
  workActive: boolean
  idleTimer?: ReturnType<typeof setTimeout> | undefined
}

/** Updates that describe Agent work (as opposed to session metadata). */
function isTurnContent(update: AcpSessionNotification['update']): boolean {
  const kind = update.sessionUpdate
  if (kind === 'user_message_chunk') {
    const source = (update as { _meta?: { source?: unknown } })._meta?.source
    return source === 'cron' || source === 'loop'
  }
  // Empty chunks are Qwen bookkeeping (usage, per-request lifecycle) that can
  // trail a finished prompt; they never start an automatic turn.
  if (
    (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') &&
    update.content.type === 'text' &&
    update.content.text === ''
  )
    return false
  return (
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'tool_call' ||
    kind === 'tool_call_update' ||
    kind === 'plan'
  )
}

function scheduledTurnLabel(update: AcpSessionNotification['update']): string | undefined {
  if (update.sessionUpdate !== 'user_message_chunk' || update.content.type !== 'text') return undefined
  const source = (update as { _meta?: { source?: unknown } })._meta?.source
  const text = update.content.text.replace(/\s+/g, ' ').trim()
  const short = text.length > 100 ? `${text.slice(0, 99)}…` : text
  return `${source === 'loop' ? 'loop' : 'cron'}: ${short === '' ? 'scheduled prompt' : short}`
}

const AGENT_TURN_BUFFER_MAX = 10_000
/** Upper bound for an Agent-initiated turn's permission request to wait for host adoption. */
const AGENT_TURN_ADOPTION_MAX_MS = 60_000
const ACP_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
const QWEN_AGENT_NAME = 'qwen-code'

/** Transient failure while refreshing an already-settled, cancelled session. */
export class AcpSessionRefreshRetryError extends Error {
  readonly code = 'ACP_SESSION_REFRESH_FAILED'

  constructor(cause: unknown) {
    super('The cancelled ACP session could not be refreshed before dispatch', { cause })
    this.name = 'AcpSessionRefreshRetryError'
  }
}

/** The runtime was explicitly closed while refreshing a cancelled session. */
export class AcpSessionRefreshAbortedError extends Error {
  readonly code = 'ACP_SESSION_REFRESH_ABORTED'

  constructor(cause?: unknown) {
    super('The cancelled ACP session refresh was cancelled before dispatch', { cause })
    this.name = 'AcpSessionRefreshAbortedError'
  }
}

/** A conforming Agent normally settles cancellation immediately; this only
 * bounds an Agent that ignores `session/cancel`. */
const ACP_CANCEL_SETTLE_GRACE_MS = 5_000

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function waitForRefreshRetry(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
  })
}

function isTransientSessionRefreshFailure(error: unknown): boolean {
  return error instanceof AcpClientError && (error.kind === 'crash' || error.kind === 'timeout')
}

/** ACP tool updates are top-level patches. Keep the detached fields that can
 * make a later id-only permission request understandable to the user. */
function mergeToolCallSnapshot(
  previous: acp.ToolCallUpdate | undefined,
  patch: acp.ToolCallUpdate,
): acp.ToolCallUpdate {
  const next: acp.ToolCallUpdate = { ...(previous ?? {}), toolCallId: patch.toolCallId }
  if (patch.kind !== undefined) next.kind = patch.kind
  if (patch.status !== undefined) next.status = patch.status
  // ACP explicitly treats `name: null` as unchanged. A created tool call has
  // a required title, so retain that useful title across nullable updates too.
  if (patch.title !== undefined && patch.title !== null) next.title = patch.title
  if (patch.name !== undefined && patch.name !== null) next.name = patch.name
  if (patch.content !== undefined) next.content = patch.content
  if (patch.locations !== undefined) next.locations = patch.locations
  if (patch.rawInput !== undefined) next.rawInput = patch.rawInput
  if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput
  if (patch._meta !== undefined) next._meta = patch._meta
  return structuredClone(next)
}

/**
 * Some ACP agents stream a complete JSON argument object through tool content
 * immediately before requesting permission, but omit `rawInput` from the
 * request itself.  Recover only a complete, bounded execute-command object;
 * partial JSON and arbitrary prose remain unusable rather than being guessed.
 */
function executeInputFromContent(content: unknown): Record<string, unknown> | undefined {
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const block = value as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'content') visit(block.content)
  }
  visit(content)
  const serialized = parts.join('').trim()
  if (serialized === '' || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const input = parsed as Record<string, unknown>
  const command = input.command ?? input.cmd
  const argv = input.argv
  if (
    !(typeof command === 'string' && command.trim() !== '') &&
    !(Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string'))
  )
    return undefined
  return structuredClone(input)
}

function permissionToolCall(prior: acp.ToolCallUpdate | undefined, request: acp.ToolCallUpdate): acp.ToolCallUpdate {
  const toolCall = prior === undefined ? structuredClone(request) : mergeToolCallSnapshot(prior, request)
  if (toolCall.kind === 'execute' && toolCall.rawInput === undefined) {
    // Kimi replaces the streamed JSON argument content with human-readable
    // approval prose on the request itself. Prefer the request when it still
    // contains structured input, then fall back to the preceding snapshot.
    const recovered = executeInputFromContent(toolCall.content) ?? executeInputFromContent(prior?.content)
    if (recovered !== undefined) toolCall.rawInput = recovered
  }
  return toolCall
}

/** Kimi namespaces permission ids as `<turn>:<tool-id>` while its preceding
 * standard tool updates use the unprefixed id.  Accept that one documented
 * numeric namespace form only, and only when the candidate is unambiguous and
 * kind-compatible; all other opaque ids remain exact-match only. */
function permissionPriorSnapshot(
  snapshots: ReadonlyMap<string, acp.ToolCallUpdate> | undefined,
  request: acp.ToolCallUpdate,
): acp.ToolCallUpdate | undefined {
  const exact = snapshots?.get(request.toolCallId)
  if (exact !== undefined) return exact
  const match = /^(\d+):(.+)$/.exec(request.toolCallId)
  if (match?.[2] !== undefined) {
    const candidate = snapshots?.get(match[2])
    if (candidate !== undefined) {
      if (request.kind !== undefined && candidate.kind !== undefined && request.kind !== candidate.kind)
        return undefined
      return candidate
    }
  }
  // A sole candidate can belong to an earlier operation, including a completed
  // one. Without a matching identity, keep the request's own details only.
  return undefined
}

const ACP_PERMISSION_INPUT_GRACE_MS = 1_500

async function completePermissionToolCall(
  snapshots: ReadonlyMap<string, acp.ToolCallUpdate> | undefined,
  request: acp.ToolCallUpdate,
  signal: AbortSignal | undefined,
): Promise<acp.ToolCallUpdate> {
  const deadline = Date.now() + ACP_PERMISSION_INPUT_GRACE_MS
  let toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  while (
    toolCall.kind === 'execute' &&
    toolCall.rawInput === undefined &&
    Date.now() < deadline &&
    !isAborted(signal)
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  }
  return toolCall
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
  if (signal === undefined) return await pending
  let listener: (() => void) | undefined
  const aborted = new Promise<T>((resolve) => {
    listener = () => resolve(onAbort())
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener)
  }
}

/** A bounded, detached ACP session configuration snapshot. */
/** One reusable ACP connection/session, lazily started on the first prompt. */
export class AcpSessionRuntime {
  private connection: AcpClientConnection | undefined
  private mcpLease: AcpMcpLease | undefined
  private mcpKey: unknown
  private sessionId: string | undefined
  private starting: Promise<void> | undefined
  /** Keep restore/new initialization behind process teardown. Lease shutdown is
   * allowed its own grace, but must not shorten the subprocess close ladder. */
  private closing: Promise<void> | undefined
  private cancelledRefreshController: AbortController | undefined
  private launch: AcpRuntimeLaunch | undefined
  private replayHandler: ((notification: AcpSessionNotification) => void) | undefined
  private restoringSessionId: string | undefined
  private connectionAbort: AbortController | undefined
  private sessionCreationGeneration = 0
  private sessionCreation:
    | {
        readonly generation: number
        readonly connection: AcpClientConnection
        readonly connectionAbort: AbortController
        readonly updates: Map<string, { configOptions?: acp.SessionConfigOption[]; currentModeId?: string }>
      }
    | undefined
  private promptAbort: AbortController | undefined
  private promptPhaseAbort: AbortController | undefined
  private promptSignal: AbortSignal | undefined
  private configSnapshot: acp.SessionConfigOption[] | undefined
  private currentMode: string | undefined
  private modeSnapshot: acp.SessionModeState | undefined
  private usageSnapshot: AcpRuntimeContextUsage | undefined
  private promptOrdinal = 0
  private configWrite: Promise<void> = Promise.resolve()
  /** Claim the complete prompt lifecycle, including lazy session setup. This is
   * distinct from promptActive, which gates Agent callbacks only after the
   * session/prompt request has actually been dispatched. */
  private promptClaimed = false
  private hostSettlementPendingValue = false
  private refreshBeforeRestore = false
  private refreshBindingSessionId: string | undefined
  private lastRestoreRefreshedCancelledSessionValue = false
  private promptActive = false
  /** One map per active prompt. Tool call ids are only meaningful inside this
   * lifetime for permission enrichment and must never leak into another turn. */
  private promptToolSnapshots: Map<string, acp.ToolCallUpdate> | undefined
  private readonly cancelGraceMs: number
  private readonly retiredMcpLeases = new Set<AcpMcpLease>()

  constructor(private readonly options: AcpSessionRuntimeOptions) {
    this.cancelGraceMs = options.cancelGraceMs ?? ACP_CANCEL_SETTLE_GRACE_MS
  }

  get acpSessionId(): string | undefined {
    return this.sessionId
  }
  /** Close a vendor process after a cancelled response and its local settlement
   * complete, keeping the same-session refresh marker for the next user input.
   * This is deliberately not a prompt retry. */
  async retireCancelledSession(): Promise<void> {
    if (
      this.options.refreshSessionAfterCancelledPrompt !== true ||
      !this.refreshBeforeRestore ||
      this.refreshBindingSessionId === undefined
    )
      return
    await this.close()
  }
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.connection?.agentCapabilities
  }
  /** Positive image-input proof belongs to the current live connection only. */
  get inputImageSupported(): boolean | undefined {
    if (
      this.connection === undefined ||
      !this.connection.isTransportAvailable ||
      this.connectionAbort?.signal.aborted === true ||
      this.mcpLease?.signal.aborted === true ||
      this.mcpKey !== this.options.mcpKey?.()
    )
      return undefined
    return this.connection.agentCapabilities?.promptCapabilities?.image
  }
  get agentInfo(): acp.Implementation | null | undefined {
    return this.connection?.agentInfo
  }
  get protocolVersion(): number | undefined {
    return this.connection?.protocolVersion
  }
  get launchInfo(): AcpRuntimeLaunch | undefined {
    return this.launch
  }
  /** Latest detached options advertised by this ACP session. */
  get configOptions(): readonly acp.SessionConfigOption[] | undefined {
    return this.configSnapshot
  }
  get currentModeId(): string | undefined {
    return this.currentMode
  }
  /** Complete detached legacy mode state advertised by this ACP session. */
  get modes(): acp.SessionModeState | undefined {
    return this.modeSnapshot
  }
  /** ACP context occupancy/cumulative cost; intentionally not DSH TokenUsage. */
  get contextUsage(): AcpRuntimeContextUsage | undefined {
    return this.usageSnapshot
  }
  get lastRestoreRefreshedCancelledSession(): boolean {
    return this.lastRestoreRefreshedCancelledSessionValue
  }
  get cancelledSessionRefreshPending(): boolean {
    return this.refreshBeforeRestore
  }
  get cancelledSessionRefreshBindingId(): string | undefined {
    return this.refreshBindingSessionId
  }
  get isBusy(): boolean {
    return this.promptClaimed
  }
  get hostSettlementPending(): boolean {
    return this.hostSettlementPendingValue
  }
  private setHostSettlementPending(pending: boolean): void {
    if (this.hostSettlementPendingValue === pending) return
    this.hostSettlementPendingValue = pending
    try {
      this.options.onHostSettlementChanged?.()
    } catch {
      /* Host settlement notifications are best effort. */
    }
  }
  hasPendingHostCalls(): boolean {
    return (
      this.mcpLease?.hasPendingCalls?.() === true ||
      [...this.retiredMcpLeases].some((lease) => lease.hasPendingCalls?.() === true)
    )
  }
  hasUncommittedHostFeedback(): boolean {
    return (
      this.mcpLease?.hasUncommittedFeedback?.() === true ||
      [...this.retiredMcpLeases].some((lease) => lease.hasUncommittedFeedback?.() === true)
    )
  }
  async flushHostFeedback(): Promise<void> {
    const leases = [this.mcpLease, ...this.retiredMcpLeases].filter(
      (lease): lease is AcpMcpLease => lease !== undefined,
    )
    try {
      for (const lease of leases) await lease.flushHostFeedback?.()
    } finally {
      this.setHostSettlementPending(this.hasPendingHostCalls() || this.hasUncommittedHostFeedback())
    }
  }
  hasRetainedHostFeedback(): boolean {
    return (
      this.mcpLease?.hasRetainedFeedback?.() === true ||
      [...this.retiredMcpLeases].some((lease) => lease.hasRetainedFeedback?.() === true)
    )
  }
  async waitForHostCallsSettled(): Promise<void> {
    const leases = [this.mcpLease, ...this.retiredMcpLeases].filter(
      (lease): lease is AcpMcpLease => lease !== undefined,
    )
    await Promise.all(leases.map((lease) => lease.waitForCallsSettled?.() ?? Promise.resolve()))
    for (const lease of this.retiredMcpLeases) {
      if (lease.hasPendingCalls?.() !== true && lease.hasRetainedFeedback?.() !== true)
        this.retiredMcpLeases.delete(lease)
    }
  }
  private pendingQuestions = 0
  /** Qwen-initiated turns, oldest first; the last one may still be live. */
  private agentTurns: AgentTurn[] = []
  private readonly agentTurnWaiters = new Set<() => void>()
  /** A host prompt() is waiting to adopt an Agent-initiated turn. */
  private awaitingAgentTurn = false
  /** `session/prompt` RPC is on the wire (updates arrive through its listener). */
  private wirePromptActive = false
  private qwenTasks: QwenBackgroundTasks | undefined
  get canSteer(): boolean {
    return this.connection?.supportsSteering === true && this.pendingQuestions === 0
  }

  async steer(content: acp.ContentBlock[], onDispatch?: () => void): Promise<'injected' | 'promptRequired'> {
    if (!this.canSteer || !this.promptActive || this.sessionId === undefined) return 'promptRequired'
    return await this.connection!.steer(this.sessionId, content, onDispatch)
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.initialize(signal)
    if (this.sessionId !== undefined) return
    this.starting ??= this.createSession(signal)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /** Initialize and negotiate capabilities without creating session/new. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.closing !== undefined) await this.closing
    if (
      this.connection !== undefined &&
      (this.connection.isClosed || this.mcpLease?.signal.aborted === true || this.mcpKey !== this.options.mcpKey?.())
    )
      await this.close()
    if (this.connection !== undefined) return
    this.starting ??= this.createConnection(signal)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /**
   * Restore an already-bound ACP session. `session/resume` is preferred because
   * it does not replay presentation history. `session/load` is an explicit
   * staging path: notifications are forwarded to the caller but never written
   * to DSH history by this runtime.
   */
  async restore(
    binding: AcpRuntimeBindingRef,
    signal?: AbortSignal,
    onReplay?: (notification: AcpSessionNotification) => void,
  ): Promise<'reused' | 'resumed' | 'loaded'> {
    this.lastRestoreRefreshedCancelledSessionValue = false
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    if (this.refreshBeforeRestore) {
      if (this.refreshBindingSessionId !== binding.agentSessionId)
        throw new Error('ACP binding session id does not match the cancelled runtime session')
      return await this.refreshCancelledSession(binding, signal, onReplay)
    }
    if (this.closing !== undefined) await this.closing
    // A closed transport cannot own a reusable in-memory session, even if the
    // remote session id is still cached. Clear local state before deciding
    // whether this binding can be reused; the caller's durable recovery guard
    // remains responsible for authorizing a resume after an unknown outcome.
    if (this.connection?.isClosed === true) await this.close()
    if (this.sessionId !== undefined) {
      if (this.sessionId !== binding.agentSessionId)
        throw new Error('ACP binding session id does not match the active runtime')
      return 'reused'
    }
    return await this.restoreCold(binding, signal, onReplay)
  }

  private async waitForCancelledSessionSettlement(): Promise<void> {
    if (this.promptClaimed) throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
    if (this.hasPendingHostCalls()) throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
    await this.flushHostFeedback()
    if (this.promptClaimed || this.hasPendingHostCalls() || this.hasUncommittedHostFeedback())
      throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
  }

  private async refreshCancelledSession(
    binding: AcpRuntimeBindingRef,
    signal?: AbortSignal,
    onReplay?: (notification: AcpSessionNotification) => void,
  ): Promise<'resumed' | 'loaded'> {
    const refreshController = new AbortController()
    this.cancelledRefreshController = refreshController
    const refreshSignal =
      signal === undefined ? refreshController.signal : AbortSignal.any([signal, refreshController.signal])
    const retryDelaysMs = [100, 300] as const
    try {
      await this.waitForCancelledSessionSettlement()
      if (refreshSignal.aborted) throw new AcpSessionRefreshAbortedError(refreshSignal.reason)
      for (let attempt = 0; ; attempt += 1) {
        if (refreshSignal.aborted) throw new AcpSessionRefreshAbortedError(refreshSignal.reason)
        try {
          await this.closeForCancelledRefresh(refreshController)
          const restored = await this.restoreCold(binding, refreshSignal, onReplay)
          if (refreshSignal.aborted) throw new AcpSessionRefreshAbortedError(refreshSignal.reason)
          this.refreshBeforeRestore = false
          this.refreshBindingSessionId = undefined
          this.lastRestoreRefreshedCancelledSessionValue = true
          return restored
        } catch (error) {
          if (refreshSignal.aborted) throw new AcpSessionRefreshAbortedError(refreshSignal.reason ?? error)
          if (!isTransientSessionRefreshFailure(error) || attempt >= retryDelaysMs.length) {
            if (attempt >= retryDelaysMs.length && isTransientSessionRefreshFailure(error))
              throw new AcpSessionRefreshRetryError(error)
            throw error
          }
          try {
            await waitForRefreshRetry(refreshSignal, retryDelaysMs[attempt]!)
          } catch (waitError) {
            if (refreshSignal.aborted) throw new AcpSessionRefreshAbortedError(refreshSignal.reason ?? waitError)
            throw waitError
          }
        }
      }
    } finally {
      if (this.cancelledRefreshController === refreshController) this.cancelledRefreshController = undefined
    }
  }

  private async closeForCancelledRefresh(owner: AbortController): Promise<void> {
    await this.closeInternal(owner)
  }

  private async restoreCold(
    binding: AcpRuntimeBindingRef,
    signal?: AbortSignal,
    onReplay?: (notification: AcpSessionNotification) => void,
  ): Promise<'resumed' | 'loaded'> {
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const caps = connection.agentCapabilities
    const mcpServers = this.mcpLease?.servers ?? []
    const rpcOptions = signal === undefined ? {} : { signal }
    this.replayHandler = onReplay
    this.restoringSessionId = binding.agentSessionId
    try {
      if (caps?.sessionCapabilities?.resume != null) {
        const response = await connection.resumeSession(
          binding.agentSessionId,
          { cwd: this.options.cwd, mcpServers },
          rpcOptions,
        )
        this.applySessionSnapshot(response)
        this.sessionId = binding.agentSessionId
        return 'resumed'
      }
      if (caps?.loadSession !== true) {
        throw new Error('ACP agent does not advertise session/resume or session/load')
      }
      const response = await connection.loadSession(
        binding.agentSessionId,
        { cwd: this.options.cwd, mcpServers },
        rpcOptions,
      )
      this.applySessionSnapshot(response)
      this.sessionId = binding.agentSessionId
      return 'loaded'
    } finally {
      this.replayHandler = undefined
      this.restoringSessionId = undefined
    }
  }

  /**
   * Create a child ACP session from an already-bound parent. This is kept
   * separate from start(): a successful fork owns the returned child id and
   * must never first create an unrelated session/new.
   * AcpForkPreDispatchError proves no fork RPC was sent; every other failure
   * retains an unknown remote outcome. The runtime owns intent-error wrapping.
   */
  async fork(
    parentSessionId: string,
    signal?: AbortSignal,
    expected?: {
      readonly agent?: { readonly name?: string; readonly version?: string }
      readonly protocolVersion?: number
    },
    beforeDispatch?: () => Promise<void>,
  ): Promise<acp.ForkSessionResponse> {
    if (this.sessionId !== undefined) throw new Error('ACP runtime already owns a session')
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const mcpServers = this.mcpLease?.servers ?? []
    try {
      if (!supportsFork(connection.agentCapabilities)) throw new AcpForkPreDispatchError('ACP_FORK_UNSUPPORTED')
      if (expected?.protocolVersion !== undefined && connection.protocolVersion !== expected.protocolVersion)
        throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.name !== undefined && connection.agentInfo?.name !== expected.agent.name)
        throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.version !== undefined && connection.agentInfo?.version !== expected.agent.version)
        throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
      try {
        await beforeDispatch?.()
      } catch (error) {
        throw new AcpForkPreDispatchError('ACP_FORK_INTENT_FAILED', error)
      }
      const response = await connection.forkSession(
        parentSessionId,
        { cwd: this.options.cwd, mcpServers },
        signal === undefined ? {} : { signal },
      )
      if (
        typeof response.sessionId !== 'string' ||
        response.sessionId.length === 0 ||
        response.sessionId === parentSessionId
      ) {
        throw new Error('ACP_FORK_INVALID_RESPONSE')
      }
      this.applySessionSnapshot(response)
      this.sessionId = response.sessionId
      return response
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: AcpSessionNotification) => void,
    signal?: AbortSignal,
    onTeamReport?: () => void,
    onTurnConcluded?: () => void,
    onSuccessfulToolResult?: () => void,
    promptOptions: AcpPromptOptions = {},
  ): Promise<acp.PromptResponse> {
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    // Claim synchronously before the asynchronous local feedback flush. Without
    // this ordering, two callers can both pass the initial check and dispatch
    // overlapping RPC prompts while they await the same retained feedback.
    this.promptClaimed = true
    const promptAbort = new AbortController()
    this.promptAbort = promptAbort
    const setupSignal = signal === undefined ? promptAbort.signal : AbortSignal.any([signal, promptAbort.signal])
    try {
      await this.flushHostFeedback()
      if (this.hasPendingHostCalls() || this.hasUncommittedHostFeedback())
        throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
      // A turn cancelled before dispatch has no remote outcome to reconcile.
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      // Claim the prompt first, preventing further UI writes, then finish any
      // already admitted setting changes before sending this turn.
      await this.configWrite
      if (setupSignal.aborted) return { stopReason: 'cancelled' }
      await this.start(setupSignal)
      const connection = this.connection
      const sessionId = this.sessionId
      if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      // A turn woken by a Qwen background/cron notice runs the turn Qwen has
      // already started instead of dispatching a new session/prompt.
      const adoptedTurn = promptOptions.adoptAgentTurn === true ? await this.nextAgentTurn(setupSignal) : undefined
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      const promptToolSnapshots =
        adoptedTurn === undefined ? new Map<string, acp.ToolCallUpdate>() : (this.promptToolSnapshots ?? new Map())
      if (adoptedTurn === undefined) this.promptToolSnapshots?.clear()
      this.promptToolSnapshots = promptToolSnapshots
      this.promptActive = true
      this.promptAbort = promptAbort
      let phaseAbort = new AbortController()
      this.promptPhaseAbort = phaseAbort
      this.promptSignal = signal
      const diagnosticsEnabled = liveDiagnosticTraceEnabled()
      const promptOrdinal = diagnosticsEnabled ? ++this.promptOrdinal : undefined
      const promptStartedAt = diagnosticsEnabled ? performance.now() : 0
      const diagnosticLeaseId = diagnosticsEnabled ? this.mcpLease?.diagnosticLeaseId : undefined
      const diagnosticSessionId = diagnosticsEnabled
        ? (liveDiagnosticId('dsh-session', this.options.diagnosticDshSessionId) ?? 'unavailable')
        : 'unavailable'
      const diagnosticAcpSessionId = diagnosticsEnabled
        ? (liveDiagnosticId('acp-session', sessionId) ?? 'unavailable')
        : undefined
      if (diagnosticsEnabled)
        emitLiveDiagnostic({
          type: 'adapter-prompt/start',
          sessionId: diagnosticSessionId,
          ...(diagnosticAcpSessionId === undefined ? {} : { acpSessionId: diagnosticAcpSessionId }),
          promptOrdinal: promptOrdinal!,
          ...(diagnosticLeaseId === undefined ? {} : { leaseId: diagnosticLeaseId }),
        })
      const beginLease = (): void =>
        this.mcpLease?.beginPrompt(
          this.permissionSignal() ?? promptAbort.signal,
          onTeamReport,
          promptOrdinal,
          onTurnConcluded,
          // Natural prompt completion aborts setup/permission work but must not
          // cancel an already-dispatched Host body. When ACP has no external
          // Stop signal, provide a distinct live signal until lease shutdown.
          promptOptions.hostBodySignal ?? signal ?? new AbortController().signal,
          onSuccessfulToolResult,
        )
      beginLease()
      // Do not pass the turn signal into the RPC budget layer: abandoning an
      // in-flight JSON-RPC request poisons the connection. ACP cancellation is a
      // protocol notification followed by a bounded wait for this same prompt.
      const instructions = this.mcpLease?.instructions
      const deliver = (notification: AcpSessionNotification): void => {
        const update = notification.update
        // Permission snapshots retain the original wire identity; only the presentation callback is normalized.
        const presented =
          notification.sessionId === sessionId &&
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
            ? this.mcpLease?.presentTool?.(update)
            : undefined
        onUpdate(
          presented === undefined
            ? notification
            : { ...notification, update: { ...update, ...presented } as typeof update },
        )
      }
      const wirePrompt = async (wireContent: acp.ContentBlock[]): Promise<acp.PromptResponse> => {
        this.wirePromptActive = true
        try {
          return await connection.prompt(
            sessionId,
            instructions === undefined
              ? wireContent
              : [{ type: 'text', text: generatedContextBlock(instructions) }, ...wireContent],
            (notification) => {
              // Qwen's discrete "background task completed" line is task state,
              // not part of the assistant answer.
              if (connection.agentInfo?.name === QWEN_AGENT_NAME && qwenTaskCompletion(notification) !== undefined)
                return
              // Qwen drains its cron queue before answering session/prompt: from
              // the echoed scheduled prompt on, the stream belongs to that turn.
              if (notification.sessionId === sessionId && this.liveAgentTurn()?.announced === false) return
              deliver(notification)
            },
          )
        } finally {
          this.wirePromptActive = false
        }
      }
      const prompting = (async (): Promise<acp.PromptResponse> => {
        if (adoptedTurn === undefined) return await wirePrompt(content)
        const response = await this.adoptAgentTurn(connection, adoptedTurn, deliver)
        await connection.drainAgentTurnHostOperations(sessionId)
        const followup = promptOptions.followupContent
        if (followup === undefined || setupSignal.aborted) return response
        if (connection.isClosed)
          throw new AcpClientError('crash', 'ACP automatic turn connection closed before follow-up')
        // Close and drain the adopted capability generation before admitting
        // retained input. Native FS and MCP bodies cannot spill into its tools.
        this.mcpLease?.endPrompt({ stopReason: response.stopReason, remoteOutcomeKnown: true })
        phaseAbort.abort(new Error('ACP adopted turn ended'))
        await this.mcpLease?.drainPrompt?.()
        await this.flushHostFeedback()
        if (this.hasPendingHostCalls() || this.hasUncommittedHostFeedback())
          throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
        if (setupSignal.aborted) return { stopReason: 'cancelled' }
        this.releaseAgentTurn(connection, sessionId, adoptedTurn)
        promptToolSnapshots.clear()
        phaseAbort = new AbortController()
        this.promptPhaseAbort = phaseAbort
        beginLease()
        // This is independently admitted input, not a retry of the automatic
        // turn. Its own response determines whether that input completed.
        return await wirePrompt(followup)
      })()
      let settled = false
      void prompting.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      const onAbort = (): void => {
        if (settled) return
        void connection.cancel(sessionId).catch(() => undefined)
        void waitWithin(prompting, this.cancelGraceMs).then(
          (response) => {
            if (response !== undefined || settled || this.connection !== connection || connection.isClosed) return
            // The remote outcome is now unknown. Closing the connection rejects
            // the still-pending prompt, allowing the adapter's existing recovery
            // guard to take over instead of hanging the DSH turn indefinitely.
            void connection.close().catch(() => undefined)
          },
          () => {
            /* prompt failed inside the grace period; no escalation needed */
          },
        )
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (isAborted(signal)) onAbort()
      let promptResponse: acp.PromptResponse | undefined
      let promptError: unknown
      try {
        promptResponse = await prompting
        return promptResponse
      } catch (error) {
        promptError = error
        throw error
      } finally {
        this.wirePromptActive = false
        signal?.removeEventListener('abort', onAbort)
        if (adoptedTurn !== undefined) this.releaseAgentTurn(connection, sessionId, adoptedTurn)
        void this.ensureQwenTasks()?.refresh()
        // Permission requests are scoped to this prompt, not merely to the
        // process connection. Natural completion must cancel an unresolved host
        // question just as Stop does, before another turn can begin.
        const externallyAborted = isAborted(signal)
        this.mcpLease?.endPrompt({
          ...(promptResponse === undefined ? {} : { stopReason: promptResponse.stopReason }),
          externallyAborted,
          remoteOutcomeKnown: promptResponse !== undefined,
        })
        this.setHostSettlementPending(
          promptResponse !== undefined && (this.hasPendingHostCalls() || this.hasUncommittedHostFeedback()),
        )
        promptAbort.abort(new Error('ACP prompt lifetime ended'))
        let drainError: unknown
        if (this.options.refreshSessionAfterCancelledPrompt === true && promptResponse?.stopReason === 'cancelled') {
          this.refreshBeforeRestore = true
          this.refreshBindingSessionId = sessionId
        }
        if (this.mcpLease?.drainPrompt !== undefined) {
          try {
            await this.mcpLease.drainPrompt()
          } catch (error) {
            drainError = error
          }
        }
        this.setHostSettlementPending(this.hasPendingHostCalls() || this.hasUncommittedHostFeedback())
        const feedbackCommitFailure =
          drainError instanceof AcpHostSettlementError &&
          drainError.code === 'ACP_HOST_FEEDBACK_COMMIT_FAILED' &&
          promptResponse === undefined
        if (
          drainError instanceof AcpHostSettlementError &&
          drainError.code === 'ACP_HOST_FEEDBACK_COMMIT_FAILED' &&
          promptResponse !== undefined
        ) {
          drainError = new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
            remoteOutcomeKnown: true,
            remoteResponse: promptResponse,
          })
        }
        const structuredFailureError =
          feedbackCommitFailure && promptError !== undefined ? promptError : (drainError ?? promptError)
        const structuredFailure =
          diagnosticsEnabled && structuredFailureError !== undefined
            ? collectLiveDiagnostic(() => ({
                operation: 'session/prompt' as const,
                errorCode: structuredAcpErrorCode(structuredFailureError),
                providerErrorKind: structuredProviderErrorKind(structuredFailureError),
                jsonRpcCode: structuredJsonRpcCode(structuredFailureError),
              }))
            : undefined
        if (diagnosticsEnabled)
          emitLiveDiagnostic({
            type: 'adapter-prompt/end',
            sessionId: diagnosticSessionId,
            ...(diagnosticAcpSessionId === undefined ? {} : { acpSessionId: diagnosticAcpSessionId }),
            promptOrdinal: promptOrdinal!,
            ...(diagnosticLeaseId === undefined ? {} : { leaseId: diagnosticLeaseId }),
            durationMs: Math.max(0, Math.round(performance.now() - promptStartedAt)),
            stopReason:
              promptResponse?.stopReason === 'end_turn' ||
              promptResponse?.stopReason === 'max_tokens' ||
              promptResponse?.stopReason === 'cancelled' ||
              promptResponse?.stopReason === 'refusal' ||
              promptResponse?.stopReason === 'max_turn_requests'
                ? promptResponse.stopReason
                : 'unknown',
            ...(structuredFailure ?? {}),
          })
        if (this.promptAbort === promptAbort) {
          promptToolSnapshots.clear()
          if (this.promptToolSnapshots === promptToolSnapshots) this.promptToolSnapshots = undefined
          this.promptAbort = undefined
          phaseAbort.abort(new Error('ACP prompt phase ended'))
          if (this.promptPhaseAbort === phaseAbort) this.promptPhaseAbort = undefined
          this.promptSignal = undefined
          this.promptActive = false
        }
        if (drainError !== undefined && !(feedbackCommitFailure && promptError !== undefined)) throw drainError
      }
    } finally {
      promptAbort.abort(new Error('ACP prompt lifetime ended'))
      if (this.promptAbort === promptAbort) this.promptAbort = undefined
      this.promptClaimed = false
    }
  }

  /** Set one ACP option for this runtime's session; writes are serialized and never cross sessions. */
  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const connection = this.connection
    const sessionId = this.sessionId
    if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      if (connection !== this.connection || sessionId !== this.sessionId)
        throw new Error('ACP configuration connection changed')
      const response = await connection.setConfigOption(
        sessionId,
        configId,
        value,
        signal === undefined ? {} : { signal },
      )
      if (connection !== this.connection || sessionId !== this.sessionId)
        throw new Error('ACP configuration connection changed')
      this.configSnapshot = acpConfigOptionsSnapshot(response.configOptions)
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  /** Set a legacy ACP mode for this runtime's session. */
  async setMode(modeId: string, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const connection = this.connection
    const sessionId = this.sessionId
    if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      if (connection !== this.connection || sessionId !== this.sessionId)
        throw new Error('ACP configuration connection changed')
      await connection.setMode(sessionId, modeId, signal === undefined ? {} : { signal })
      if (connection !== this.connection || sessionId !== this.sessionId)
        throw new Error('ACP configuration connection changed')
      this.currentMode = modeId
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  close(): Promise<void> {
    return this.closeInternal()
  }

  private closeInternal(refreshOwner?: AbortController): Promise<void> {
    this.sessionCreationGeneration += 1
    this.sessionCreation?.updates.clear()
    this.sessionCreation = undefined
    if (this.cancelledRefreshController !== undefined && this.cancelledRefreshController !== refreshOwner)
      this.cancelledRefreshController.abort(new Error('ACP session runtime closed during cancelled-session refresh'))
    if (this.closing !== undefined) return this.closing

    // Capture one generation before signalling it. A concurrent restore waits
    // for this promise, and cleanup below only clears fields still owned by
    // this generation.
    const connection = this.connection
    const lease = this.mcpLease
    const launch = this.launch
    const connectionAbort = this.connectionAbort
    const operation = (async () => {
      this.promptAbort?.abort(new Error('ACP session runtime closed'))
      for (const turn of this.agentTurns) turn.end('cancelled')
      this.agentTurns = []
      this.notifyAgentTurnWaiters()
      this.qwenTasks?.close()
      this.qwenTasks = undefined
      this.promptToolSnapshots?.clear()
      this.promptToolSnapshots = undefined
      connectionAbort?.abort()

      // MCP teardown is bounded independently. The subprocess owns a separate
      // bounded EOF/terminate ladder; wrapping both in cancelGraceMs could
      // abandon that ladder and let restore spawn while the old child lives.
      const leaseClose =
        lease === undefined
          ? Promise.resolve(undefined)
          : waitWithin(
              Promise.resolve().then(() => lease.close(this.cancelGraceMs)),
              this.cancelGraceMs,
            )
      const connectionClose = connection?.close()
      const results = await Promise.allSettled([leaseClose, connectionClose])

      if (lease?.hasPendingCalls?.() === true || lease?.hasRetainedFeedback?.() === true) {
        this.retiredMcpLeases.add(lease)
        const settled = lease.waitForCallsSettled?.()
        if (settled !== undefined)
          void settled.then(
            () => {
              if (lease.hasPendingCalls?.() !== true && lease.hasRetainedFeedback?.() !== true)
                this.retiredMcpLeases.delete(lease)
            },
            () => {
              /* keep the lease reachable when settlement cannot be observed */
            },
          )
      }

      if (this.connection === connection && this.mcpLease === lease && this.launch === launch) {
        this.connection = undefined
        this.mcpLease = undefined
        this.sessionId = undefined
        this.launch = undefined
        // A confirmed cancelled response keeps the same durable ACP binding for
        // the next explicit user action. Preserve its last-known controls while
        // the process is retired so a passive UI refresh can still render them;
        // the next prompt/control write must restore the binding before use.
        if (!this.refreshBeforeRestore) {
          this.configSnapshot = undefined
          this.currentMode = undefined
          this.modeSnapshot = undefined
          this.usageSnapshot = undefined
        }
      }
      if (this.connectionAbort === connectionAbort) this.connectionAbort = undefined

      const errors: unknown[] = []
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'ACP runtime cleanup failed')
    })()
    this.closing = operation
    void operation.then(
      () => {
        if (this.closing === operation) this.closing = undefined
      },
      () => {
        if (this.closing === operation) this.closing = undefined
      },
    )
    return operation
  }

  private async createSession(signal?: AbortSignal): Promise<void> {
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const connectionAbort = this.connectionAbort
    if (connectionAbort === undefined) throw new Error('ACP connection is not active')
    const generation = ++this.sessionCreationGeneration
    const creation = {
      generation,
      connection,
      connectionAbort,
      updates: new Map<string, { configOptions?: acp.SessionConfigOption[]; currentModeId?: string }>(),
    }
    this.sessionCreation = creation
    try {
      const session = await connection.newSession(
        { cwd: this.options.cwd, mcpServers: this.mcpLease?.servers ?? [] },
        signal === undefined ? {} : { signal },
      )
      signal?.throwIfAborted()
      connectionAbort.signal.throwIfAborted()
      if (
        generation !== this.sessionCreationGeneration ||
        this.connection !== connection ||
        this.connectionAbort !== connectionAbort
      )
        throw new Error('ACP session creation generation changed')
      const staged = creation.updates.get(session.sessionId)
      if (staged?.configOptions !== undefined) this.configSnapshot = staged.configOptions
      if (staged?.currentModeId !== undefined) this.currentMode = staged.currentModeId
      this.applySessionSnapshot(session)
      this.sessionId = session.sessionId
    } catch (error) {
      if (this.connection === connection && this.connectionAbort === connectionAbort)
        await this.close().catch(() => undefined)
      throw error
    } finally {
      if (this.sessionCreation === creation) {
        creation.updates.clear()
        this.sessionCreation = undefined
      }
    }
  }

  private stageSessionCreationUpdate(
    connection: AcpClientConnection,
    connectionAbort: AbortController,
    notification: AcpSessionNotification,
  ): void {
    const creation = this.sessionCreation
    if (
      creation === undefined ||
      creation.connection !== connection ||
      creation.connectionAbort !== connectionAbort ||
      creation.generation !== this.sessionCreationGeneration ||
      connectionAbort.signal.aborted
    )
      return
    const update = notification.update
    if (update.sessionUpdate !== 'config_option_update' && update.sessionUpdate !== 'current_mode_update') return
    let staged = creation.updates.get(notification.sessionId)
    if (staged === undefined) {
      if (creation.updates.size >= 32) return
      staged = {}
    }
    if (update.sessionUpdate === 'config_option_update') {
      const configOptions = acpConfigOptionsSnapshot(update.configOptions)
      if (configOptions !== undefined) staged.configOptions = configOptions
    } else {
      if (update.currentModeId.length > ACP_CONFIG_IDENTIFIER_MAX) return
      staged.currentModeId = update.currentModeId
    }
    creation.updates.set(notification.sessionId, staged)
  }

  private async createConnection(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    // Teardown can arrive while prepareLaunch/initialize is still pending.
    // Own its cancellation before awaiting either, so a disposed session cannot
    // publish a newly initialized child after close() has returned.
    const connectionAbort = new AbortController()
    this.connectionAbort = connectionAbort
    const setupSignal =
      signal === undefined ? connectionAbort.signal : AbortSignal.any([signal, connectionAbort.signal])
    const launch = await this.options.prepareLaunch(this.options.config, this.options.cwd)
    if (setupSignal.aborted) {
      await launch.mcpLease?.close().catch(() => undefined)
      setupSignal.throwIfAborted()
    }
    this.launch = launch
    this.mcpLease = launch.mcpLease
    const spec: AcpConnectionSpec = {
      argv: [...launch.argv],
      cwd: this.options.cwd,
      env: launch.env,
      spawnPlan: launch.spawnPlan,
      subprocess: this.options.subprocess,
    }
    const fileSystemHandlers = this.options.createFileSystemHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const terminalHandlers = this.options.createTerminalHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const connection = new AcpClientConnection(spec, {
      ...(this.options.enableClaudeDraftSubagents === true ? { enableClaudeDraftSubagents: true } : {}),
      ...(this.options.onCapabilityDegraded === undefined
        ? {}
        : { onCapabilityDegraded: this.options.onCapabilityDegraded }),
      ...(fileSystemHandlers === undefined ? {} : { fileSystemHandlers }),
      ...(terminalHandlers === undefined ? {} : { terminalHandlers }),
      ...(this.options.onPermissionRequest === undefined
        ? {}
        : {
            onPermissionRequest: async (
              params: acp.RequestPermissionRequest,
            ): Promise<acp.RequestPermissionResponse> => {
              this.pendingQuestions += 1
              try {
                return await this.handlePermissionRequest(params)
              } finally {
                this.pendingQuestions -= 1
              }
            },
          }),
      ...(this.options.onElicitationRequest === undefined
        ? {}
        : {
            onElicitationRequest: async (
              params: acp.CreateElicitationRequest,
            ): Promise<acp.CreateElicitationResponse> => {
              const signal = this.permissionSignal()
              if (!this.promptActive || isAborted(signal)) return { action: 'cancel' }
              const scope = params as { sessionId?: unknown; toolCallId?: unknown }
              const toolCall =
                scope.sessionId !== this.sessionId || typeof scope.toolCallId !== 'string'
                  ? undefined
                  : this.promptToolSnapshots?.get(scope.toolCallId)
              this.pendingQuestions += 1
              try {
                const lease = this.mcpLease
                const automaticPromise = Promise.resolve(lease?.elicitation?.(params, toolCall))
                let automatic: acp.CreateElicitationResponse | undefined
                if (signal === undefined) automatic = await automaticPromise
                else {
                  const abortToken = Symbol('abort')
                  let onAbort: (() => void) | undefined
                  const aborted = new Promise<typeof abortToken>((resolve) => {
                    onAbort = () => resolve(abortToken)
                    if (isAborted(signal)) onAbort()
                    else signal.addEventListener('abort', onAbort, { once: true })
                  })
                  try {
                    const result = await Promise.race([automaticPromise, aborted])
                    if (result === abortToken) return { action: 'cancel' }
                    automatic = result
                  } finally {
                    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
                  }
                }
                if (isAborted(signal) || lease !== this.mcpLease || lease?.signal.aborted) return { action: 'cancel' }
                if (automatic !== undefined) return automatic
                const hostToolName = this.mcpLease?.elicitationToolName?.(params, toolCall)
                return await this.options.onElicitationRequest!(
                  params,
                  signal,
                  hostToolName,
                  hostToolName === undefined ? undefined : toolCall,
                )
              } finally {
                this.pendingQuestions -= 1
              }
            },
          }),
      ...(this.options.qwenTaskJobs === undefined
        ? {}
        : {
            onQwenTurnStart: (params: QwenTurnStartParams) => this.startAgentTurn(params),
            onQwenTurnEnd: (params: QwenTurnEndParams) => {
              this.endAgentTurn(params)
            },
            onQwenActiveWork: () => this.updateAgentTurnWork(),
          }),
      onSessionUpdate: (notification) => {
        if (connectionAbort.signal.aborted) return
        this.stageSessionCreationUpdate(connection, connectionAbort, notification)
        this.routeAgentTurnUpdate(notification)
        this.applyUpdate(notification)
        this.replayHandler?.(notification)
        this.options.onSessionUpdate?.(notification)
      },
    })
    try {
      await connection.initialize({ signal: setupSignal })
      this.mcpKey = this.options.mcpKey?.()
      this.mcpLease ??= await this.options.createMcpLease?.(connection.agentCapabilities)
      setupSignal.throwIfAborted()
      this.connection = connection
      this.connectionAbort = connectionAbort
    } catch (error) {
      await connection.close().catch(() => undefined)
      await this.mcpLease?.close().catch(() => undefined)
      this.mcpLease = undefined
      this.launch = undefined
      throw error
    }
  }

  private applySessionSnapshot(snapshot: {
    readonly configOptions?: readonly acp.SessionConfigOption[] | null
    readonly modes?: acp.SessionModeState | null
  }): void {
    if (snapshot.configOptions !== undefined && snapshot.configOptions !== null)
      this.configSnapshot = acpConfigOptionsSnapshot(snapshot.configOptions)
    if (
      snapshot.modes?.currentModeId !== undefined &&
      snapshot.modes.currentModeId.length <= ACP_CONFIG_IDENTIFIER_MAX
    ) {
      this.currentMode = snapshot.modes.currentModeId
      this.modeSnapshot = structuredClone(snapshot.modes)
    }
  }

  private applyUpdate(notification: AcpSessionNotification): void {
    // Claude's negotiated child-session updates share this connection. They
    // are forwarded to the external-subagent projector, but never own the
    // parent's model, mode, usage or permission snapshots.
    if (notification.sessionId !== (this.sessionId ?? this.restoringSessionId)) return
    const update = notification.update
    const diagnosticsEnabled = liveDiagnosticTraceEnabled()
    const diagnosticSessionId = diagnosticsEnabled
      ? (liveDiagnosticId('dsh-session', this.options.diagnosticDshSessionId) ?? 'unavailable')
      : 'unavailable'
    const diagnosticAcpSessionId = diagnosticsEnabled
      ? (liveDiagnosticId('acp-session', notification.sessionId) ?? 'unavailable')
      : undefined
    if (diagnosticsEnabled && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
      const toolNames = new Set([
        'spawn_teammate',
        'send_message',
        'list_agents',
        'wait_agent',
        'interrupt_agent',
        'team_task_create',
        'team_task_list',
        'team_task_get',
        'team_task_update',
      ])
      const rawToolName = (update as { readonly name?: unknown }).name
      const rawStatus = update.status
      emitLiveDiagnostic({
        type: 'acp-tool/update',
        sessionId: diagnosticSessionId,
        ...(diagnosticAcpSessionId === undefined ? {} : { acpSessionId: diagnosticAcpSessionId }),
        ...(this.mcpLease?.diagnosticLeaseId === undefined ? {} : { leaseId: this.mcpLease.diagnosticLeaseId }),
        ...(this.promptActive ? { adapterPromptOrdinal: this.promptOrdinal } : {}),
        providerToolCallId: liveDiagnosticId('acp-tool-call', update.toolCallId) ?? 'unavailable',
        tool: typeof rawToolName === 'string' && toolNames.has(rawToolName) ? (rawToolName as never) : 'other',
        providerToolStatus:
          rawStatus === 'pending' || rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'failed'
            ? rawStatus
            : 'unknown',
      })
    }
    if (diagnosticsEnabled && update.sessionUpdate === 'usage_update') {
      emitLiveDiagnostic({
        type: 'acp-usage/update',
        sessionId: diagnosticSessionId,
        ...(diagnosticAcpSessionId === undefined ? {} : { acpSessionId: diagnosticAcpSessionId }),
        ...(this.promptActive ? { adapterPromptOrdinal: this.promptOrdinal } : {}),
        contextUsed: update.used,
        contextSize: update.size,
      })
    }
    if (
      (this.promptActive || this.liveAgentTurn() !== undefined) &&
      notification.sessionId === this.sessionId &&
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    ) {
      // Keep permission enrichment prompt- and session-scoped. Kimi streams
      // tool arguments before requesting permission, so the map is cleared at
      // every turn boundary and can never authorize data from another turn.
      const snapshots = this.promptToolSnapshots
      if (snapshots !== undefined)
        snapshots.set(update.toolCallId, mergeToolCallSnapshot(snapshots.get(update.toolCallId), update))
    }
    if (update.sessionUpdate === 'config_option_update')
      this.configSnapshot = acpConfigOptionsSnapshot(update.configOptions)
    if (update.sessionUpdate === 'current_mode_update') {
      if (update.currentModeId.length <= ACP_CONFIG_IDENTIFIER_MAX) {
        this.currentMode = update.currentModeId
        if (this.modeSnapshot !== undefined)
          this.modeSnapshot = { ...this.modeSnapshot, currentModeId: update.currentModeId }
      }
    }
    if (update.sessionUpdate === 'usage_update') {
      const cost = update.cost
      this.usageSnapshot = {
        used: update.used,
        size: update.size,
        ...(cost === undefined
          ? {}
          : { cost: cost === null ? null : { amount: cost.amount, currency: cost.currency } }),
      }
    }
  }

  private ensureQwenTasks(): QwenBackgroundTasks | undefined {
    if (this.qwenTasks !== undefined) return this.qwenTasks
    const startJob = this.options.qwenTaskJobs
    const connection = this.connection
    const sessionId = this.sessionId
    if (
      startJob === undefined ||
      connection === undefined ||
      sessionId === undefined ||
      connection.agentInfo?.name !== QWEN_AGENT_NAME
    )
      return undefined
    this.qwenTasks = new QwenBackgroundTasks({
      startJob,
      listTasks: async () => {
        if (connection !== this.connection || connection.isClosed) return undefined
        return qwenTaskSnapshots(await connection.extRequest('qwen/status/session/tasks', { sessionId }))
      },
      cancelTask: async (taskId, taskKind) => {
        if (connection !== this.connection || connection.isClosed) return
        await connection.extRequest('qwen/control/session/task/cancel', { sessionId, taskId, taskKind })
      },
    })
    return this.qwenTasks
  }

  private notifyAgentTurnWaiters(): void {
    for (const wake of [...this.agentTurnWaiters]) wake()
  }

  /** Resolve on the next Agent-turn state change or after `ms`. */
  private agentTurnChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.agentTurnWaiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      timer = setTimeout(wake, Math.max(1, ms))
      this.agentTurnWaiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  private liveAgentTurn(): AgentTurn | undefined {
    const last = this.agentTurns.at(-1)
    return last !== undefined && last.ended === undefined ? last : undefined
  }

  private startAgentTurn(params: QwenTurnStartParams): QwenTurnStartResult {
    const notFound = (): never => {
      throw RequestError.methodNotFound('_qwencode/start_turn')
    }
    if (params.sessionId !== this.sessionId) return { accepted: false }
    // Only background notification turns are adopted; others keep Qwen's own fallback.
    if (params.source !== 'background_notification') return notFound()
    // A host prompt owns the session; Qwen retries the notification after it.
    if (this.promptClaimed && !this.awaitingAgentTurn) return { accepted: false }
    if (this.liveAgentTurn() !== undefined) return { accepted: false }
    const tasks = this.ensureQwenTasks()
    if (tasks === undefined) return notFound()
    const turn = this.createAgentTurn(params.turnId, true)
    // A host call already waiting adopts it directly; otherwise the task's
    // native job settles unawaited and DSH wakes the idle agent.
    if (!this.awaitingAgentTurn && !tasks.wake(params)) return notFound()
    this.agentTurns.push(turn)
    this.promptToolSnapshots ??= new Map()
    this.connection?.setAgentTurnActive(params.sessionId, true)
    this.notifyAgentTurnWaiters()
    return { accepted: true }
  }

  private createAgentTurn(turnId: string, announced: boolean): AgentTurn {
    let resolveEnded!: (reason: string) => void
    const endedPromise = new Promise<string>((resolve) => {
      resolveEnded = resolve
    })
    const turn: AgentTurn = {
      turnId,
      announced,
      buffer: [],
      listener: undefined,
      ended: undefined,
      endedPromise,
      workSeq: this.connection?.qwenActiveWorkSnapshot?.seq ?? 0,
      workActive:
        this.connection?.qwenActiveWorkSnapshot?.sessions.some(
          (session) =>
            session.sessionId === this.sessionId &&
            session.holds.some((hold) => hold.category === 'session' && hold.id === 'session:active-turn'),
        ) === true,
      end: (reason) => {
        if (turn.ended !== undefined) return
        turn.ended = reason
        if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer)
        resolveEnded(reason)
      },
    }
    return turn
  }

  private endAgentTurn(params: QwenTurnEndParams): void {
    if (params.sessionId !== this.sessionId) return
    const turn = this.agentTurns.find((candidate) => candidate.turnId === params.turnId)
    if (turn === undefined) return
    this.finishAgentTurn(turn, params.reason ?? 'end_turn')
  }

  private finishAgentTurn(turn: AgentTurn, reason: string): void {
    if (turn.ended !== undefined) return
    turn.end(reason)
    const sessionId = this.sessionId
    if (sessionId !== undefined && this.liveAgentTurn() === undefined)
      this.connection?.setAgentTurnActive(sessionId, false)
    if (turn.listener === undefined) {
      // Not adopted yet: keep a bounded record for the woken host turn only.
      const stale = setTimeout(() => {
        if (turn.listener === undefined) this.agentTurns = this.agentTurns.filter((candidate) => candidate !== turn)
      }, 120_000)
      stale.unref?.()
    }
    this.notifyAgentTurnWaiters()
  }

  private routeAgentTurnUpdate(notification: AcpSessionNotification): void {
    if (
      notification.sessionId !== this.sessionId ||
      this.connection?.isClosed === true ||
      this.connection?.agentInfo?.name !== QWEN_AGENT_NAME
    )
      return
    const completion = qwenTaskCompletion(notification)
    if (completion !== undefined) {
      this.ensureQwenTasks()?.complete(completion, this.wirePromptActive)
      return
    }
    let turn = this.liveAgentTurn()
    if (this.wirePromptActive && turn?.announced !== false && scheduledTurnLabel(notification.update) === undefined)
      return
    if (turn === undefined) {
      // Qwen runs cron/loop turns (and announced turns it fell back on) with
      // no start/end markers. Adopt them like a background turn instead of
      // dropping their output and failing their approvals. A scheduled echo
      // may arrive while the finishing prompt is still on the wire.
      if (this.promptClaimed && !this.awaitingAgentTurn && scheduledTurnLabel(notification.update) === undefined) return
      if (!isTurnContent(notification.update)) return
      turn = this.startUnannouncedTurn(notification)
      if (turn === undefined) return
    }
    if (!turn.announced) this.trackUnannouncedTurn(turn)
    if (turn.listener !== undefined) turn.listener(notification)
    else if (turn.buffer.length < AGENT_TURN_BUFFER_MAX) turn.buffer.push(notification)
  }

  private unannouncedSeq = 0

  private startUnannouncedTurn(notification: AcpSessionNotification): AgentTurn | undefined {
    const tasks = this.ensureQwenTasks()
    const sessionId = this.sessionId
    if (tasks === undefined || sessionId === undefined) return undefined
    this.unannouncedSeq += 1
    const turn = this.createAgentTurn(`unannounced:${String(this.unannouncedSeq)}`, false)
    if (
      !this.awaitingAgentTurn &&
      !tasks.wake({ label: scheduledTurnLabel(notification.update) ?? 'Qwen automatic turn' })
    )
      return undefined
    this.agentTurns.push(turn)
    this.promptToolSnapshots ??= new Map()
    this.connection?.setAgentTurnActive(sessionId, true)
    this.notifyAgentTurnWaiters()
    return turn
  }

  /** Request/usage markers end model rounds, not the tool/Stop-hook work after them. */
  private trackUnannouncedTurn(turn: AgentTurn): void {
    turn.workSeq = this.connection?.qwenActiveWorkSnapshot?.seq ?? turn.workSeq
    this.armUnannouncedTurnWatchdog(turn)
  }

  private armUnannouncedTurnWatchdog(turn: AgentTurn): void {
    if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer)
    const interval = this.connection?.qwenActiveWorkIntervalMs
    turn.idleTimer = setTimeout(
      () => {
        if (turn.ended !== undefined) return
        // An unanswered human question can legitimately remain open. Missing
        // reporting otherwise makes the outcome unknown, never end_turn.
        if (this.pendingQuestions > 0) this.armUnannouncedTurnWatchdog(turn)
        else void this.connection?.close().catch(() => undefined)
      },
      this.options.unannouncedIdleMs ?? (interval === undefined ? 180_000 : interval * 3),
    )
    turn.idleTimer.unref?.()
  }

  private updateAgentTurnWork(): void {
    const turn = this.liveAgentTurn()
    const snapshot = this.connection?.qwenActiveWorkSnapshot
    const interval = this.connection?.qwenActiveWorkIntervalMs
    if (
      turn === undefined ||
      turn.announced ||
      snapshot === undefined ||
      interval === undefined ||
      snapshot.seq <= turn.workSeq
    )
      return
    turn.workSeq = snapshot.seq
    const active = snapshot.sessions.some(
      (session) =>
        session.sessionId === this.sessionId &&
        session.holds.some((hold) => hold.category === 'session' && hold.id === 'session:active-turn'),
    )
    if (active) {
      turn.workActive = true
      this.armUnannouncedTurnWatchdog(turn)
      return
    }
    // Sequence numbers reject reordered snapshots; they do not date a snapshot
    // queued behind another send. Idle without observed work is not completion.
    if (!turn.workActive) return
    this.finishAgentTurn(turn, this.promptSignal?.aborted === true ? 'cancelled' : 'end_turn')
  }

  private async waitForAdoption(): Promise<void> {
    const deadline = Date.now() + AGENT_TURN_ADOPTION_MAX_MS
    while (
      !this.promptActive &&
      this.liveAgentTurn() !== undefined &&
      Date.now() < deadline &&
      this.connection?.isClosed !== true
    ) {
      await this.agentTurnChange(Math.min(1_000, deadline - Date.now()))
    }
  }

  /** Oldest unadopted Agent turn, waiting briefly for Qwen's announcement. */
  private async nextAgentTurn(signal: AbortSignal): Promise<AgentTurn | undefined> {
    const pick = (): AgentTurn | undefined => this.agentTurns.find((turn) => turn.listener === undefined)
    const deadline = Date.now() + (this.options.agentTurnWaitMs ?? 5_000)
    this.awaitingAgentTurn = true
    try {
      let turn = pick()
      while (turn === undefined && !signal.aborted && Date.now() < deadline && this.connection?.isClosed !== true) {
        await this.agentTurnChange(deadline - Date.now(), signal)
        turn = pick()
      }
      return turn
    } finally {
      this.awaitingAgentTurn = false
    }
  }

  /** Present an Agent-initiated turn as the current prompt until it ends. */
  private adoptAgentTurn(
    connection: AcpClientConnection,
    turn: AgentTurn,
    deliver: (notification: AcpSessionNotification) => void,
  ): Promise<acp.PromptResponse> {
    for (const notification of turn.buffer.splice(0)) deliver(notification)
    turn.listener = deliver
    this.notifyAgentTurnWaiters()
    return Promise.race([turn.endedPromise, connection.failed]).then((reason) => ({
      stopReason: (ACP_STOP_REASONS.has(reason) ? reason : 'end_turn') as acp.StopReason,
    }))
  }

  private releaseAgentTurn(connection: AcpClientConnection, sessionId: string, turn: AgentTurn): void {
    turn.listener = () => undefined
    this.agentTurns = this.agentTurns.filter((candidate) => candidate !== turn)
    if (this.liveAgentTurn() === undefined) connection.setAgentTurnActive(sessionId, false)
  }

  private permissionSignal(): AbortSignal | undefined {
    const connectionSignal = this.connectionAbort?.signal
    const promptLifetimeSignal = this.promptAbort?.signal
    const promptSignal = this.promptSignal
    const signals = [connectionSignal, promptLifetimeSignal, this.promptPhaseAbort?.signal, promptSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    )
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    return AbortSignal.any(signals)
  }

  private async handlePermissionRequest(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const cancelled = (): acp.RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } })
    // A Qwen-initiated turn may ask before the woken host turn has adopted it.
    if (!this.promptActive && params.sessionId === this.sessionId && this.liveAgentTurn() !== undefined)
      await this.waitForAdoption()
    if (!this.promptActive || this.sessionId === undefined || params.sessionId !== this.sessionId) return cancelled()
    const handler = this.options.onPermissionRequest
    if (handler === undefined) return cancelled()
    const signal = this.permissionSignal()
    if (isAborted(signal)) return cancelled()
    if (this.connection?.agentInfo?.name === QWEN_AGENT_NAME && isQwenUserQuestion(params)) {
      // A question is not an approval: never run it through the tool approval
      // policy (Auto must not "approve" it with an empty answer).
      const ask = this.options.onQwenQuestion
      if (ask === undefined) return cancelled()
      return await raceAbort(ask(params, signal), signal, cancelled)
    }
    const request = {
      ...params,
      toolCall: await completePermissionToolCall(this.promptToolSnapshots, params.toolCall, signal),
    }
    const lease = this.mcpLease
    const inspectPromise = Promise.resolve(lease?.inspectPermission?.(request))
    let inspected: Awaited<typeof inspectPromise>
    if (signal === undefined) inspected = await inspectPromise
    else {
      const abortToken = Symbol('permission-abort')
      let onAbort: (() => void) | undefined
      const aborted = new Promise<typeof abortToken>((resolve) => {
        onAbort = () => resolve(abortToken)
        if (isAborted(signal)) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const result = await Promise.race([inspectPromise, aborted])
        if (result === abortToken) return cancelled()
        inspected = result
      } finally {
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      }
    }
    if (this.options.onPermissionCheck !== undefined) {
      // Audit stores only the bounded decision facts, never capability names or addresses.
      try {
        await this.options.onPermissionCheck(inspected ?? { reason: 'bridge-unavailable' }, request)
      } catch {
        return cancelled()
      }
    }
    if (
      isAborted(signal) ||
      lease !== this.mcpLease ||
      lease?.signal.aborted ||
      (inspected?.reason === 'auto-approved' && lease?.validatePermissionDecision?.(request) === false)
    )
      return cancelled()
    // Use the very policy resolution that was audited above. Re-reading here
    // could turn an audited Ask into an automatic approval (or the reverse).
    const bridgeDecision = inspected === undefined ? await lease?.permission(request) : inspected.response
    if (bridgeDecision !== undefined) return bridgeDecision
    // Resolve bridge decisions against the original wire identity first; normalize
    // only the request shown by the native approval surface.
    const pending = handler(
      { ...request, toolCall: this.mcpLease?.presentTool?.(request.toolCall) ?? request.toolCall },
      signal,
    )
    if (signal === undefined) return await pending
    let onAbort: (() => void) | undefined
    const aborted = new Promise<acp.RequestPermissionResponse>((resolve) => {
      onAbort = () => {
        resolve(cancelled())
      }
      if (isAborted(signal)) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // The native question service receives the same signal, but the ACP RPC
      // must still settle if a host implementation fails to honor it. The race
      // also observes a late handler rejection, avoiding an unhandled promise.
      return await Promise.race([pending, aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}
