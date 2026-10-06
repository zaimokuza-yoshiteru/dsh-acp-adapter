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
import type { AcpTerminalHandlers } from '../client-capabilities/terminal.ts'
import { acpConfigOptionsSnapshot } from '../../protocol/v1/config-options.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
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
}

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
      if (!supportsFork(connection.agentCapabilities)) throw new Error('ACP_FORK_UNSUPPORTED')
      if (expected?.protocolVersion !== undefined && connection.protocolVersion !== expected.protocolVersion)
        throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.name !== undefined && connection.agentInfo?.name !== expected.agent.name)
        throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.version !== undefined && connection.agentInfo?.version !== expected.agent.version)
        throw new Error('ACP_FORK_PRECONDITION_FAILED')
      try {
        await beforeDispatch?.()
      } catch (error) {
        throw new Error(`ACP_FORK_INTENT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
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
      const promptToolSnapshots = new Map<string, acp.ToolCallUpdate>()
      this.promptToolSnapshots?.clear()
      this.promptToolSnapshots = promptToolSnapshots
      this.promptActive = true
      this.promptAbort = promptAbort
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
      this.mcpLease?.beginPrompt(
        this.permissionSignal() ?? promptAbort.signal,
        onTeamReport,
        promptOrdinal,
        onTurnConcluded,
        // Natural prompt completion aborts setup/permission work but must not
        // cancel an already-dispatched Host body. When ACP has no external
        // Stop signal, provide a distinct live signal until lease shutdown.
        signal ?? new AbortController().signal,
        onSuccessfulToolResult,
      )
      // Do not pass the turn signal into the RPC budget layer: abandoning an
      // in-flight JSON-RPC request poisons the connection. ACP cancellation is a
      // protocol notification followed by a bounded wait for this same prompt.
      const instructions = this.mcpLease?.instructions
      const prompting = connection.prompt(
        sessionId,
        instructions === undefined
          ? content
          : [{ type: 'text', text: generatedContextBlock(instructions) }, ...content],
        (notification) => {
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
        },
      )
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
        signal?.removeEventListener('abort', onAbort)
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
      onSessionUpdate: (notification) => {
        if (connectionAbort.signal.aborted) return
        this.stageSessionCreationUpdate(connection, connectionAbort, notification)
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
      this.promptActive &&
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

  private permissionSignal(): AbortSignal | undefined {
    const connectionSignal = this.connectionAbort?.signal
    const promptLifetimeSignal = this.promptAbort?.signal
    const promptSignal = this.promptSignal
    const signals = [connectionSignal, promptLifetimeSignal, promptSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    )
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    return AbortSignal.any(signals)
  }

  private async handlePermissionRequest(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const cancelled = (): acp.RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } })
    if (!this.promptActive || this.sessionId === undefined || params.sessionId !== this.sessionId) return cancelled()
    const handler = this.options.onPermissionRequest
    if (handler === undefined) return cancelled()
    const signal = this.permissionSignal()
    if (isAborted(signal)) return cancelled()
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
