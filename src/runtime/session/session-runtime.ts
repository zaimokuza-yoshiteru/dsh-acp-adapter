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
/** Deliberately protocol-local: runtime restoration does not own persistence. */
export interface AcpRuntimeBindingRef { readonly agentSessionId: string }
export interface AcpRuntimeConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

export interface AcpRuntimeLaunch {
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
  readonly profileId: string
  /** Explicit descriptor-derived gate for Claude's private draft extension. */
  readonly enableClaudeDraftSubagents?: boolean
  readonly config: AcpRuntimeConfig
  readonly subprocess: SubprocessSeam
  readonly cwd: string
  readonly prepareLaunch: (config: AcpRuntimeConfig, cwd: string) => Promise<AcpRuntimeLaunch>
  /** Optional host capability handlers, created after the native launch environment is known. */
  readonly createFileSystemHandlers?: (context: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => AcpFileSystemHandlers
  readonly createTerminalHandlers?: (context: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => AcpTerminalHandlers
  /** Trusted, already validated MCP definitions. Undefined means no injection. */
  readonly resolveMcpServers?: (capabilities: acp.AgentCapabilities | undefined) => readonly acp.McpServer[]
  /** Replay/load notifications are staging-only; the DSH log remains authoritative. */
  readonly onSessionUpdate?: (notification: AcpSessionNotification) => void
  /** Host-owned approval bridge. The optional signal is the active prompt lifetime. */
  readonly onPermissionRequest?: (params: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse>
  /** Host-owned form elicitation bridge; URL elicitation is intentionally not advertised. */
  readonly onElicitationRequest?: (params: acp.CreateElicitationRequest, signal?: AbortSignal) => Promise<acp.CreateElicitationResponse>
  /** One-shot diagnostic for optional private capability degradation. */
  readonly onCapabilityDegraded?: (message: string) => void
  /** Grace period after `session/cancel` before the Agent process is closed. */
  readonly cancelGraceMs?: number
}

/** A conforming Agent normally settles cancellation immediately; this only
 * bounds an Agent that ignores `session/cancel`. */
export const ACP_CANCEL_SETTLE_GRACE_MS = 5_000

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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
  try { parsed = JSON.parse(serialized) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const input = parsed as Record<string, unknown>
  const command = input.command ?? input.cmd
  const argv = input.argv
  if (
    !(typeof command === 'string' && command.trim() !== '')
    && !(Array.isArray(argv) && argv.length > 0 && argv.every(item => typeof item === 'string'))
  ) return undefined
  return structuredClone(input)
}

function permissionToolCall(
  prior: acp.ToolCallUpdate | undefined,
  request: acp.ToolCallUpdate,
): acp.ToolCallUpdate {
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
      if (request.kind !== undefined && candidate.kind !== undefined && request.kind !== candidate.kind) return undefined
      return candidate
    }
  }
  // Some Kimi builds use unrelated opaque ids on the permission request.  A
  // unique live execute snapshot whose content already contains a complete
  // command is still an unambiguous protocol-local correlation.  Never choose
  // when two commands are concurrently eligible.
  const eligible = [...(snapshots?.values() ?? [])].filter(snapshot => {
    if (request.kind !== undefined && snapshot.kind !== undefined && request.kind !== snapshot.kind) return false
    return snapshot.kind === 'execute' && executeInputFromContent(snapshot.content) !== undefined
  })
  return eligible.length === 1 ? eligible[0] : undefined
}

const ACP_PERMISSION_INPUT_GRACE_MS = 1_500

async function completePermissionToolCall(
  snapshots: ReadonlyMap<string, acp.ToolCallUpdate> | undefined,
  request: acp.ToolCallUpdate,
  signal: AbortSignal | undefined,
): Promise<acp.ToolCallUpdate> {
  const deadline = Date.now() + ACP_PERMISSION_INPUT_GRACE_MS
  let toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  while (toolCall.kind === 'execute' && toolCall.rawInput === undefined && Date.now() < deadline && !isAborted(signal)) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    toolCall = permissionToolCall(permissionPriorSnapshot(snapshots, request), request)
  }
  return toolCall
}

/** A bounded, detached ACP session configuration snapshot. */
/** Validate trusted MCP definitions against the Agent's negotiated transport capabilities. */
export function mcpServersForCapabilities(
  servers: readonly acp.McpServer[],
  capabilities: acp.AgentCapabilities | undefined,
): readonly acp.McpServer[] {
  for (const server of servers) {
    const kind = 'type' in server ? server.type : 'stdio'
    const supported = kind === 'http'
      ? capabilities?.mcpCapabilities?.http === true
      : kind === 'sse'
        ? capabilities?.mcpCapabilities?.sse === true
        : kind === 'acp'
          ? capabilities?.mcpCapabilities?.acp === true
          : true
    if (!supported) throw new Error(`ACP_MCP_UNSUPPORTED: agent did not advertise MCP transport "${kind}"`)
  }
  return servers
}

/** One reusable ACP connection/session, lazily started on the first prompt. */
export class AcpSessionRuntime {
  private connection: AcpClientConnection | undefined
  private sessionId: string | undefined
  private starting: Promise<void> | undefined
  private launch: AcpRuntimeLaunch | undefined
  private replayHandler: ((notification: AcpSessionNotification) => void) | undefined
  private connectionAbort: AbortController | undefined
  private promptAbort: AbortController | undefined
  private promptSignal: AbortSignal | undefined
  private configSnapshot: acp.SessionConfigOption[] | undefined
  private currentMode: string | undefined
  private modeSnapshot: acp.SessionModeState | undefined
  private usageSnapshot: AcpRuntimeContextUsage | undefined
  private configWrite: Promise<void> = Promise.resolve()
  /** Claim the complete prompt lifecycle, including lazy session setup. This is
   * distinct from promptActive, which gates Agent callbacks only after the
   * session/prompt request has actually been dispatched. */
  private promptClaimed = false
  private promptActive = false
  /** One map per active prompt. Tool call ids are only meaningful inside this
   * lifetime for permission enrichment and must never leak into another turn. */
  private promptToolSnapshots: Map<string, acp.ToolCallUpdate> | undefined
  private readonly cancelGraceMs: number

  constructor(private readonly options: AcpSessionRuntimeOptions) {
    this.cancelGraceMs = options.cancelGraceMs ?? ACP_CANCEL_SETTLE_GRACE_MS
  }

  get acpSessionId(): string | undefined { return this.sessionId }
  get agentCapabilities(): acp.AgentCapabilities | undefined { return this.connection?.agentCapabilities }
  get agentInfo(): acp.Implementation | null | undefined { return this.connection?.agentInfo }
  get protocolVersion(): number | undefined { return this.connection?.protocolVersion }
  get launchInfo(): AcpRuntimeLaunch | undefined { return this.launch }
  /** Latest detached options advertised by this ACP session. */
  get configOptions(): readonly acp.SessionConfigOption[] | undefined { return this.configSnapshot }
  get currentModeId(): string | undefined { return this.currentMode }
  /** Complete detached legacy mode state advertised by this ACP session. */
  get modes(): acp.SessionModeState | undefined { return this.modeSnapshot }
  /** ACP context occupancy/cumulative cost; intentionally not DSH TokenUsage. */
  get contextUsage(): AcpRuntimeContextUsage | undefined { return this.usageSnapshot }
  get isBusy(): boolean { return this.promptClaimed }

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
  ): Promise<'resumed' | 'loaded'> {
    if (this.sessionId !== undefined) {
      if (this.sessionId !== binding.agentSessionId) throw new Error('ACP binding session id does not match the active runtime')
      return 'resumed'
    }
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
      const caps = connection.agentCapabilities
    const mcpServers = this.mcpServers(caps)
      const rpcOptions = signal === undefined ? {} : { signal }
    this.replayHandler = onReplay
    try {
      if (caps?.sessionCapabilities?.resume != null) {
        const response = await connection.resumeSession(binding.agentSessionId, { cwd: this.options.cwd, mcpServers }, rpcOptions)
        this.applySessionSnapshot(response)
        this.sessionId = binding.agentSessionId
        return 'resumed'
      }
      if (caps?.loadSession !== true) {
        throw new Error('ACP agent does not advertise session/resume or session/load')
      }
      const response = await connection.loadSession(binding.agentSessionId, { cwd: this.options.cwd, mcpServers }, rpcOptions)
      this.applySessionSnapshot(response)
      this.sessionId = binding.agentSessionId
      return 'loaded'
    } finally {
      this.replayHandler = undefined
    }
  }

  /**
   * Create a child ACP session from an already-bound parent. This is kept
   * separate from start(): a successful fork owns the returned child id and
   * must never first create an unrelated session/new.
   */
  async fork(parentSessionId: string, signal?: AbortSignal, expected?: { readonly agent?: { readonly name?: string; readonly version?: string }; readonly protocolVersion?: number }, beforeDispatch?: () => Promise<void>): Promise<acp.ForkSessionResponse> {
    if (this.sessionId !== undefined) throw new Error('ACP runtime already owns a session')
    await this.initialize(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    const mcpServers = this.mcpServers(connection.agentCapabilities)
    try {
      if (!supportsFork(connection.agentCapabilities)) throw new Error('ACP_FORK_UNSUPPORTED')
      if (expected?.protocolVersion !== undefined && connection.protocolVersion !== expected.protocolVersion) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.name !== undefined && connection.agentInfo?.name !== expected.agent.name) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      if (expected?.agent?.version !== undefined && connection.agentInfo?.version !== expected.agent.version) throw new Error('ACP_FORK_PRECONDITION_FAILED')
      try {
        await beforeDispatch?.()
      } catch (error) {
        throw new Error(`ACP_FORK_INTENT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
      }
      const response = await connection.forkSession(parentSessionId, { cwd: this.options.cwd, mcpServers }, signal === undefined ? {} : { signal })
      if (typeof response.sessionId !== 'string' || response.sessionId.length === 0 || response.sessionId === parentSessionId) {
        throw new Error('ACP_FORK_INVALID_RESPONSE')
      }
      this.applySessionSnapshot(response)
      this.sessionId = response.sessionId
      return response
    } catch (error) {
      await connection.close().catch(() => undefined)
      this.connection = undefined
      this.launch = undefined
      throw error
    }
  }

  async prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: AcpSessionNotification) => void,
    signal?: AbortSignal,
  ): Promise<acp.PromptResponse> {
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    this.promptClaimed = true
    try {
      // A turn cancelled before dispatch has no remote outcome to reconcile.
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      await this.start(signal)
      const connection = this.connection
      const sessionId = this.sessionId
      if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      const promptAbort = new AbortController()
      const promptToolSnapshots = new Map<string, acp.ToolCallUpdate>()
      this.promptToolSnapshots?.clear()
      this.promptToolSnapshots = promptToolSnapshots
      this.promptActive = true
      this.promptAbort = promptAbort
      this.promptSignal = signal
      // Do not pass the turn signal into the RPC budget layer: abandoning an
      // in-flight JSON-RPC request poisons the connection. ACP cancellation is a
      // protocol notification followed by a bounded wait for this same prompt.
      const prompting = connection.prompt(sessionId, content, onUpdate)
      let settled = false
      void prompting.then(
        () => { settled = true },
        () => { settled = true },
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
          () => { /* prompt failed inside the grace period; no escalation needed */ },
        )
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (isAborted(signal)) onAbort()
      try {
        return await prompting
      } finally {
        signal?.removeEventListener('abort', onAbort)
        // Permission requests are scoped to this prompt, not merely to the
        // process connection. Natural completion must cancel an unresolved host
        // question just as Stop does, before another turn can begin.
        promptAbort.abort(new Error('ACP prompt lifetime ended'))
        if (this.promptAbort === promptAbort) {
          promptToolSnapshots.clear()
          if (this.promptToolSnapshots === promptToolSnapshots) this.promptToolSnapshots = undefined
          this.promptAbort = undefined
          this.promptSignal = undefined
          this.promptActive = false
        }
      }
    } finally {
      this.promptClaimed = false
    }
  }

  /** Set one ACP option for this runtime's session; writes are serialized and never cross sessions. */
  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      const connection = this.connection
      const sessionId = this.sessionId
      if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
      const response = await connection.setConfigOption(sessionId, configId, value, signal === undefined ? {} : { signal })
      this.configSnapshot = acpConfigOptionsSnapshot(response.configOptions)
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  /** Set a legacy ACP mode for this runtime's session. */
  async setMode(modeId: string, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      const connection = this.connection
      const sessionId = this.sessionId
      if (connection === undefined || sessionId === undefined) throw new Error('ACP session is not started')
      await connection.setMode(sessionId, modeId, signal === undefined ? {} : { signal })
      this.currentMode = modeId
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  async close(): Promise<void> {
    this.promptAbort?.abort(new Error('ACP session runtime closed'))
    this.promptToolSnapshots?.clear()
    this.promptToolSnapshots = undefined
    this.connectionAbort?.abort()
    this.connectionAbort = undefined
    await this.connection?.close()
    this.connection = undefined
    this.sessionId = undefined
    this.launch = undefined
    this.configSnapshot = undefined
    this.currentMode = undefined
    this.modeSnapshot = undefined
    this.usageSnapshot = undefined
  }

  private async createSession(signal?: AbortSignal): Promise<void> {
    const connection = this.connection
    if (connection === undefined) throw new Error('ACP connection is not started')
    try {
      const session = await connection.newSession({ cwd: this.options.cwd, mcpServers: this.mcpServers(connection.agentCapabilities) }, signal === undefined ? {} : { signal })
      this.applySessionSnapshot(session)
      this.sessionId = session.sessionId
    } catch (error) {
      await connection.close().catch(() => undefined)
      this.connection = undefined
      throw error
    }
  }

  private async createConnection(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const launch = await this.options.prepareLaunch(this.options.config, this.options.cwd)
    this.launch = launch
    const spec: AcpConnectionSpec = {
      argv: [...launch.argv],
      cwd: this.options.cwd,
      env: launch.env,
      spawnPlan: launch.spawnPlan,
      subprocess: this.options.subprocess,
    }
    const fileSystemHandlers = this.options.createFileSystemHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const terminalHandlers = this.options.createTerminalHandlers?.({ cwd: this.options.cwd, env: launch.env })
    const connectionAbort = new AbortController()
    const connection = new AcpClientConnection(spec, {
      ...(this.options.enableClaudeDraftSubagents === true ? { enableClaudeDraftSubagents: true } : {}),
      ...(this.options.onCapabilityDegraded === undefined ? {} : { onCapabilityDegraded: this.options.onCapabilityDegraded }),
      ...(fileSystemHandlers === undefined ? {} : { fileSystemHandlers }),
      ...(terminalHandlers === undefined ? {} : { terminalHandlers }),
      ...(this.options.onPermissionRequest === undefined ? {} : {
        onPermissionRequest: (params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => this.handlePermissionRequest(params),
      }),
      ...(this.options.onElicitationRequest === undefined ? {} : {
        onElicitationRequest: (params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> => this.options.onElicitationRequest!(params, this.permissionSignal()),
      }),
      onSessionUpdate: (notification) => {
        this.applyUpdate(notification)
        this.replayHandler?.(notification)
        this.options.onSessionUpdate?.(notification)
      },
    })
    try {
      await connection.initialize(signal === undefined ? {} : { signal })
      this.connection = connection
      this.connectionAbort = connectionAbort
    } catch (error) {
      await connection.close().catch(() => undefined)
      this.launch = undefined
      throw error
    }
  }

  private applySessionSnapshot(snapshot: { readonly configOptions?: readonly acp.SessionConfigOption[] | null; readonly modes?: acp.SessionModeState | null }): void {
    if (snapshot.configOptions !== undefined && snapshot.configOptions !== null) this.configSnapshot = acpConfigOptionsSnapshot(snapshot.configOptions)
    if (snapshot.modes?.currentModeId !== undefined) {
      this.currentMode = snapshot.modes.currentModeId
      this.modeSnapshot = structuredClone(snapshot.modes)
    }
  }

  private applyUpdate(notification: AcpSessionNotification): void {
    const update = notification.update
    if (
      this.promptActive
      && notification.sessionId === this.sessionId
      && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    ) {
      // Keep permission enrichment prompt- and session-scoped. Kimi streams
      // tool arguments before requesting permission, so the map is cleared at
      // every turn boundary and can never authorize data from another turn.
      const snapshots = this.promptToolSnapshots
      if (snapshots !== undefined) snapshots.set(update.toolCallId, mergeToolCallSnapshot(snapshots.get(update.toolCallId), update))
    }
    if (update.sessionUpdate === 'config_option_update') this.configSnapshot = acpConfigOptionsSnapshot(update.configOptions)
    if (update.sessionUpdate === 'current_mode_update') {
      this.currentMode = update.currentModeId
      if (this.modeSnapshot !== undefined) this.modeSnapshot = { ...this.modeSnapshot, currentModeId: update.currentModeId }
    }
    if (update.sessionUpdate === 'usage_update') {
      const cost = update.cost
      this.usageSnapshot = {
        used: update.used,
        size: update.size,
        ...(cost === undefined ? {} : { cost: cost === null ? null : { amount: cost.amount, currency: cost.currency } }),
      }
    }
  }

  private permissionSignal(): AbortSignal | undefined {
    const connectionSignal = this.connectionAbort?.signal
    const promptLifetimeSignal = this.promptAbort?.signal
    const promptSignal = this.promptSignal
    const signals = [connectionSignal, promptLifetimeSignal, promptSignal].filter((signal): signal is AbortSignal => signal !== undefined)
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
    const pending = handler(request, signal)
    if (signal === undefined) return await pending
    let onAbort: (() => void) | undefined
    const aborted = new Promise<acp.RequestPermissionResponse>((resolve) => {
      onAbort = () => { resolve(cancelled()) }
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

  private mcpServers(capabilities: acp.AgentCapabilities | undefined): readonly acp.McpServer[] {
    const servers = this.options.resolveMcpServers?.(capabilities) ?? []
    return mcpServersForCapabilities(servers, capabilities)
  }
}
