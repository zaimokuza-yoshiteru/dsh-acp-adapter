/** ACP profile as an ordinary DSH LLM provider route. */
/// <reference types="node" />

import fs from 'node:fs'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AcpStubAdapter, reasoningInfoFromConfigOptions } from './llm-stub.ts'
import type { AcpProbeCacheEntry } from './llm-stub.ts'
import type { AcpStubAgentConfig } from '../../domain/session/agent-config.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import { AcpSessionRuntime } from '../../runtime/session/session-runtime.ts'
import type { AcpRuntimeContextUsage } from '../../runtime/session/session-runtime.ts'
import type { AcpRuntimeLaunch } from '../../runtime/session/session-runtime.ts'
import { acpLaunchEnvironment, acpLaunchFingerprint, profileLaunchIdentityHash } from '../../domain/session/launch-fingerprint.ts'
import { buildAcpSpawnPlan } from '../../domain/policy/sandbox.ts'
import { descriptorOf } from '../../domain/session/agent-config.ts'
import { DispatchLedger } from '../../runtime/session/dispatch-ledger.ts'
import type { DispatchLedgerStore } from '../../runtime/session/dispatch-ledger.ts'
import { admitCurrentStep, snapshotSessionEvents } from '../../domain/session/current-step-admission.ts'
import { AcpAdmissionError } from '../../domain/session/current-step-admission.ts'
import type { CurrentStepProof, SessionLike } from '../../domain/session/current-step-admission.ts'
import { ExternalDelegationNormalizer } from '../../domain/subagent/external-delegation.ts'
import type { ExternalDelegationObservation } from '../../domain/subagent/external-delegation.ts'
import { acpCanonicalHash16 } from '../../persistence/sidecar.ts'
import { acpOptionsSnapshotOf } from '../../persistence/options-snapshot.ts'
import type { AcpActivityKind, AcpActivityStatus, AcpBindingData, AcpFileSystemAuditData, AcpRecoveryState, AcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpSessionForkReason, AcpTerminalAuditData } from '../../domain/policy/events.ts'
import { acpReplayPayloadOf } from '../../domain/session/acp-replay-payload.ts'
import { redactSecretText } from '../../domain/observability/redaction.ts'
import { AcpPromptContentError, toAcpPrompt } from '../../domain/session/prompt-content.ts'
import { createAcpFileSystemHandlers } from '../../runtime/client-capabilities/filesystem.ts'
import { createAcpTerminalHandlers } from '../../runtime/client-capabilities/terminal.ts'
import { createAcpNativePermissionHandler, type AcpNativeApprovalService } from '../../domain/policy/permissions.ts'
import type { AcpPermissionAuditChannel } from '../../domain/policy/permissions.ts'
import { createAcpNativeElicitationHandler } from '../../domain/policy/elicitation.ts'
import type { AcpNativeUserQuestionService } from '../../domain/policy/elicitation.ts'
import { isAcpModelOrReasoningOption, normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import { nonTextContentFallback } from '../../domain/session/assistant-content.ts'
import type { AcpNonTextContent } from '../../domain/session/assistant-content.ts'
import { AcpToolCallReducer } from './tool-call-reducer.ts'
import type { AcpToolCallPatch, AcpToolCallSnapshot } from './tool-call-reducer.ts'

type AcpAttachmentStore = Pick<AttachmentStore, 'readImage' | 'imageLimits'> & Partial<Pick<AttachmentStore, 'saveImages'>>
interface AgentSessionModeView { readonly id: string; readonly name: string; readonly description?: string | null }
interface AgentSessionSelectValueView { readonly value: string; readonly name: string; readonly description?: string | null }
interface AgentSessionSelectGroupView { readonly group: string; readonly name: string; readonly options: readonly AgentSessionSelectValueView[] }
type AgentSessionConfigOptionView = {
  readonly type: 'select'
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly category?: string | null
  readonly currentValue: string
  readonly options: readonly (AgentSessionSelectValueView | AgentSessionSelectGroupView)[]
} | {
  readonly type: 'boolean'
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly category?: string | null
  readonly currentValue: boolean
}
interface AgentSessionSnapshotView {
  readonly sessionId: string
  readonly profileId: string
  readonly freshness: 'live' | 'stale'
  readonly editable: boolean
  readonly configOptions: readonly AgentSessionConfigOptionView[] | null
  readonly modes: readonly AgentSessionModeView[] | null
  readonly currentModeId: string | null
  readonly contextUsage: { readonly used: number; readonly size: number; readonly percent: number; readonly cost: { readonly amount: number; readonly currency: string } | null } | null
  readonly note: string | null
}
type AgentSessionOptionWrite =
  | { readonly kind: 'config'; readonly id: string; readonly value: string | boolean }
  | { readonly kind: 'mode'; readonly id: string }

function hasOpenTurn(session: SessionLike | undefined): boolean {
  if (session === undefined) return false
  const events = snapshotSessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * Project ACP's Native Agent Access through DSH's stock permission selector.
 *
 * The Agent process is intentionally unconfined by DSH, while ACP may still
 * ask the user for individual approvals.  That combination does not match a
 * stock DSH preset, so the native projection renders its existing `Custom`
 * value.  These events belong only to the already-established ACP session;
 * native sessions never pass through this adapter.
 */
function projectNativeAgentAccess(session: SessionLike | undefined): void {
  if (session?.append === undefined) return
  const latest = (type: string, key: string): unknown => {
    const events = snapshotSessionEvents(session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== type || typeof event.data !== 'object' || event.data === null) continue
      return (event.data as Record<string, unknown>)[key]
    }
    return undefined
  }
  if (latest('sandbox/mode', 'mode') !== 'danger-full-access') {
    session.append('sandbox/mode', { mode: 'danger-full-access', source: 'dsh-acp-native-agent-access' })
  }
  if (latest('approval/policy', 'policy') !== 'ask') {
    session.append('approval/policy', { policy: 'ask', source: 'dsh-acp-native-agent-access' })
  }
}

/** Prove the child seed ends at the parent's durable ACP binding head. */
function isLatestForkCut(session: SessionLike | undefined, parentSessionId: string, parentBinding: AcpBindingData, currentFingerprint: unknown): boolean {
  if (session === undefined || !Number.isInteger(session.inheritedEventCount) || session.inheritedEventCount < 0) return false
  const seed = snapshotSessionEvents(session).slice(0, session.inheritedEventCount)
  if (seed.length < session.inheritedEventCount) return false
  const payload = [...seed].reverse().map(acpReplayPayloadOf).find((value) => value !== undefined)
  return payload !== undefined
    && payload.ownerDshSessionId === parentSessionId
    && payload.profileId === parentBinding.profileId
    && payload.profileGeneration === parentBinding.generation
    && payload.agentSessionId === parentBinding.agentSessionId
    && payload.bindingEpoch === parentBinding.bindingEpoch
    && payload.launchFingerprint === acpCanonicalHash16(currentFingerprint)
    && payload.committedPromptOrdinal === parentBinding.committedPromptOrdinal
}

/**
 * Build the model-directory probe with the same native launch environment as
 * a real ACP session.  The profile route is also queried directly by the
 * stock ModelPicker, so it cannot use the old `{ ...profile.env }` shortcut:
 * that shortcut asks the subprocess host to tombstone PATH and makes a CLI
 * appear healthy in Remote health while failing when its model list opens.
 */
function createNativeProfileProbe(
  profileId: string,
  subprocess: SubprocessSeamResolution,
  config: AcpStubAgentConfig,
): AcpStubAdapter {
  return new AcpStubAdapter({
    agents: () => new Map([[`acp-${profileId}`, config]]),
    subprocess,
    prepareProbe: async ({ config: probeConfig, argv }) => {
      const env = await acpLaunchEnvironment({ config: probeConfig })
      const plan = buildAcpSpawnPlan({
        mode: 'danger-full-access',
        argv,
        env,
      })
      return {
        plan,
        cleanup: () => undefined,
      }
    },
  })
}

function finishReason(stopReason: string): FinishReason {
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  if (stopReason === 'cancelled') return { kind: 'aborted', failure: { code: 'ACP_ABORTED', message: 'ACP prompt was cancelled' } }
  return { kind: 'stop' }
}

function redactActivityValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested value omitted]'
  if (typeof value === 'string') {
    const redacted = redactSecretText(value)
    return redacted.length > 4_096 ? `${redacted.slice(0, 4_096)}… [truncated]` : redacted
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactActivityValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      result[key] = redactSecretText(key).toLowerCase() !== key.toLowerCase() || /(?:token|secret|password|authorization|api[_-]?key|cookie|credential)/i.test(key) ? '[redacted]' : redactActivityValue(item, depth + 1)
    }
    return result
  }
  return value
}

function activityRawDetail(value: unknown): string {
  if (value === undefined) return ''
  try { return JSON.stringify(redactActivityValue(value)) } catch { return '[activity detail unavailable]' }
}

function activityStatus(value: unknown, fallback: AcpActivityStatus = 'running'): AcpActivityStatus {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  return fallback
}

function isTerminalActivityStatus(value: AcpActivityStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

interface NormalizedActivity {
  readonly activityId: string
  readonly kind: AcpActivityKind
  readonly status: AcpActivityStatus
  readonly presentation: string
  readonly rawDetail?: string
}

function normalizeActivityContent(parentId: string, content: unknown, status: AcpActivityStatus): NormalizedActivity | undefined {
  if (typeof content !== 'object' || content === null) return undefined
  const item = content as { type?: unknown; path?: unknown; terminalId?: unknown }
  if (item.type === 'diff') {
    const name = typeof item.path === 'string' ? path.basename(item.path) : 'file'
    return { activityId: `${parentId}:diff`, kind: 'diff', status, presentation: `File change · ${name}`, rawDetail: activityRawDetail(content) }
  }
  if (item.type === 'terminal') return { activityId: `${parentId}:terminal`, kind: 'terminal', status, presentation: 'Terminal activity', rawDetail: activityRawDetail(content) }
  if (item.type === 'resource' || item.type === 'resource_link' || item.type === 'image' || item.type === 'audio') return { activityId: `${parentId}:resource`, kind: 'resource', status, presentation: 'Agent resource', rawDetail: activityRawDetail(content) }
  return { activityId: `${parentId}:content`, kind: 'other', status, presentation: 'Tool output', rawDetail: activityRawDetail(content) }
}

function activitiesForNotification(notification: AcpSessionNotification, fallbackId: string, toolCall?: AcpToolCallSnapshot): readonly NormalizedActivity[] {
  const update = notification.update as unknown as Record<string, unknown>
  const type = update.sessionUpdate
  if (type === 'tool_call' || type === 'tool_call_update') {
    const toolId = toolCall?.callId ?? (typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId)
    const status = activityStatus(toolCall?.status ?? update.status)
    const title = typeof toolCall?.title === 'string' && toolCall.title.length > 0
      ? toolCall.title
      : typeof toolCall?.name === 'string' && toolCall.name.length > 0 ? toolCall.name : 'Agent tool activity'
    const detail = toolCall ?? update
    const result: NormalizedActivity[] = [{ activityId: `tool:${toolId}`, kind: 'tool', status, presentation: title, rawDetail: activityRawDetail({ toolKind: detail.kind, toolName: detail.name, rawInput: detail.rawInput, rawOutput: detail.rawOutput, locations: detail.locations, content: detail.content }) }]
    if (Array.isArray(detail.content)) {
      for (const [index, content] of detail.content.entries()) {
        const normalized = normalizeActivityContent(`tool:${toolId}:${String(index)}`, content, status)
        if (normalized !== undefined) result.push(normalized)
      }
    }
    return result
  }
  if (type === 'plan' || type === 'plan_update') {
    const entries = type === 'plan' && Array.isArray(update.entries) ? update.entries : undefined
    const plan = type === 'plan_update' ? update.plan : entries
    const planId = isPlainRecord(update._meta) && typeof update._meta.activityId === 'string' ? update._meta.activityId : 'session'
    const complete = Array.isArray(entries) && entries.length > 0 && entries.every((entry) => isPlainRecord(entry) && entry.status === 'completed')
    return [{ activityId: `plan:${planId}`, kind: 'plan', status: complete ? 'completed' : 'running', presentation: 'Agent plan', rawDetail: activityRawDetail(plan) }]
  }
  if (type === 'plan_removed') {
    const planId = typeof update.planId === 'string' ? update.planId : 'session'
    return [{ activityId: `plan:${planId}`, kind: 'plan', status: 'completed', presentation: 'Agent plan', rawDetail: activityRawDetail(update) }]
  }
  if (type === 'delegated' || type === 'subagent') return [{ activityId: `delegated:${typeof update.activityId === 'string' ? update.activityId : fallbackId}`, kind: 'delegated', status: activityStatus(update.status), presentation: 'Delegated Agent activity', rawDetail: activityRawDetail(update) }]
  if (type === 'subagent_spawned') return [{
    activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
    kind: 'delegated', status: 'running',
    presentation: typeof update.name === 'string' && update.name.length > 0 ? update.name : 'Agent delegation',
    rawDetail: activityRawDetail({ task: update.task, capabilities: update.capabilities }),
  }]
  if (type === 'subagent_state_update') return [{
    activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
    kind: 'delegated', status: update.state === 'completed' ? 'completed' : update.state === 'cancelled' ? 'cancelled' : 'failed',
    presentation: 'Agent delegation', rawDetail: activityRawDetail({ state: update.state }),
  }]
  if (type === 'agent_message_chunk' || type === 'agent_thought_chunk' || type === 'user_message_chunk'
    || type === 'config_option_update' || type === 'current_mode_update' || type === 'available_commands_update'
    || type === 'usage_update' || type === 'session_info_update') return []
  return [{ activityId: `other:${fallbackId}`, kind: 'other', status: 'completed', presentation: 'Agent activity', rawDetail: activityRawDetail(update) }]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotProfile(profile: AcpStubAgentConfig | undefined): AcpStubAgentConfig | undefined {
  return profile === undefined
    ? undefined
    : { ...profile, args: [...profile.args], env: { ...profile.env } }
}

interface ProfileGeneration {
  readonly id: string
  readonly config: AcpStubAgentConfig
  readonly probe: {
    listModels(provider: string): Promise<readonly LlmModelInfo[]>
    probeSnapshot?(provider: string): AcpProbeCacheEntry | undefined
    invalidateProbe?(provider: string): void
    configOptions?(provider: string): readonly acp.SessionConfigOption[] | undefined
    configOptionsForModel?(provider: string, model: string): readonly acp.SessionConfigOption[] | undefined
  }
}

export interface AcpProfileRuntime {
  /** Negotiate capabilities without creating session/new. */
  initialize?(signal?: AbortSignal): Promise<void>
  start(signal?: AbortSignal): Promise<void>
  /** Fork a parent ACP session; absent means the Agent cannot fork. */
  fork?(parentSessionId: string, signal?: AbortSignal, expected?: { readonly agent?: AcpBindingData['agent']; readonly protocolVersion?: number }, beforeDispatch?: () => Promise<void>): Promise<acp.ForkSessionResponse>
  /** Restore an existing binding; absent implementations fail closed. */
  restore?(binding: Pick<AcpBindingData, 'agentSessionId'>, signal?: AbortSignal, onReplay?: (notification: AcpSessionNotification) => void): Promise<'resumed' | 'loaded'>
  readonly acpSessionId?: string | undefined
  readonly agentInfo?: acp.Implementation | null | undefined
  readonly agentCapabilities?: acp.AgentCapabilities | undefined
  readonly protocolVersion?: number | undefined
  /** Latest ACP session-scoped configuration; presence means this runtime supports M6 config convergence. */
  readonly configOptions?: readonly acp.SessionConfigOption[] | undefined
  readonly currentModeId?: string | undefined
  readonly modes?: acp.SessionModeState | undefined
  readonly contextUsage?: AcpRuntimeContextUsage | undefined
  readonly isBusy?: boolean
  /** ACP session-scoped writes. Implementations must confirm the resulting snapshot. */
  setConfigOption?(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void>
  setMode?(modeId: string, signal?: AbortSignal): Promise<void>
  prompt(content: acp.ContentBlock[], onUpdate: (notification: AcpSessionNotification) => void, signal?: AbortSignal): Promise<acp.PromptResponse>
  close(): Promise<void>
}

/** Host-owned DSH user-question seam resolved for the current DSH session. */
export interface AcpNativeQuestionBinding {
  readonly userQuestions?: AcpNativeUserQuestionService
  readonly approval?: AcpNativeApprovalService
  readonly getAgent: () => unknown
}

/** One independent adapter and runtime per configured ACP profile. */
export class AcpProfileAdapter extends LlmAdapter {
  private probeGeneration: ProfileGeneration | undefined
  private readonly runtimes = new Map<string, AcpProfileRuntime>()
  private readonly nextGenerations = new Map<string, number>()
  private claudeDraftDegradationReported = false
  private readonly ledger: DispatchLedger

  constructor(
    readonly profileId: string,
    private readonly readConfig: () => AcpStubAgentConfig | undefined,
    private readonly subprocess: SubprocessSeamResolution,
    private readonly sessionOf: (sessionId: string) => SessionLike | undefined = () => undefined,
    ledgerStore: DispatchLedgerStore,
    private readonly probeFactory: (config: AcpStubAgentConfig) => ProfileGeneration['probe'] = (config) => createNativeProfileProbe(profileId, subprocess, config),
    private readonly runtimeFactory: (options: ConstructorParameters<typeof AcpSessionRuntime>[0]) => AcpProfileRuntime = (options) => new AcpSessionRuntime(options),
    private readonly sidecar?: AcpSidecar,
    private readonly attachments?: AcpAttachmentStore,
    private readonly resolveQuestions?: (dshSessionId: string) => AcpNativeQuestionBinding | undefined,
    private readonly projectExternalDelegation?: (observation: ExternalDelegationObservation, context: {
      readonly profileId: string
      readonly bindingGeneration: number
      readonly rootAcpSessionId: string
      readonly parentDshSessionId: string
      readonly parentCwd: string
      readonly parentDelegationDepth?: number
    }) => Promise<string | undefined>,
    private readonly log?: (message: string) => void,
  ) {
    super()
    this.ledger = new DispatchLedger(ledgerStore)
    this.probeGeneration = this.generationOfSnapshot(snapshotProfile(readConfig()))
  }

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: `${this.readConfig()?.name ?? this.profileId} · ACP` } }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const generation = this.currentProbeGeneration()
    if (generation === undefined) return []
    try {
      return await generation.probe.listModels(provider)
    } catch (error) {
      // The stock picker has no useful place for a second, persistent ACP
      // protocol-error row. Health/Settings owns the bounded diagnostic; a
      // failed ACP catalogue simply contributes no selectable models. Native
      // provider adapters never pass through this composition path.
      if (error instanceof LlmError && error.code === 'ACP_PROBE_FAILED') return []
      throw error
    }
  }

  /** The profile adapter is the single probe cache owner for both ModelPicker and health. */
  probeSnapshot(routeId: string): AcpProbeCacheEntry | undefined {
    return this.currentProbeGeneration()?.probe.probeSnapshot?.(routeId)
  }

  invalidateProbe(routeId: string): void {
    this.currentProbeGeneration()?.probe.invalidateProbe?.(routeId)
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const generation = this.currentProbeGeneration()
    if (generation === undefined) throw new LlmError(`ACP profile "${this.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
    const models = await generation.probe.listModels(provider)
    const found = models.find((entry) => entry.id === model)
    const reasoning = reasoningInfoFromConfigOptions(this.profileId, generation.config, generation.probe.configOptionsForModel?.(provider, model) ?? generation.probe.configOptions?.(provider))
    return found === undefined
      ? { provider, id: model, name: model, ...(reasoning === undefined ? {} : { reasoning }) }
      : { ...found, ...(reasoning === undefined ? {} : { reasoning }) }
  }

  /** Capture the current profile generation before model dispatch. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const generation = this.generationOf(snapshotProfile(this.readConfig()))
    if (generation === undefined) throw new LlmError(`ACP profile "${this.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
    const resolved = await this.resolveModelForGeneration(provider, model, generation, signal)
    return {
      model: resolved,
      // This closure is the generation boundary: later settings edits cannot
      // change the command, args, or environment used by an already prepared call.
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => this.streamWithGeneration(options, generation),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithGeneration(options, this.generationOf(snapshotProfile(this.readConfig())))
  }

  private generationOf(profile: AcpStubAgentConfig | undefined): ProfileGeneration | undefined {
    if (profile === undefined) return undefined
    // The runtime key is deliberately secret-free.  Keep the immutable launch
    // config in the generation value, but only expose a canonical fingerprint
    // hash in maps/errors so credentials can never become an index or log.
    const id = profileLaunchIdentityHash(this.profileId, profile)
    if (this.probeGeneration?.id === id) return this.probeGeneration
    const generation = this.generationOfSnapshot(profile)
    this.probeGeneration = generation
    return generation
  }

  /** Resolve the picker/probe catalogue against the latest saved profile.
   * Existing ACP runtimes retain their immutable generation; only catalogue
   * discovery moves to the new launch fingerprint. */
  private currentProbeGeneration(): ProfileGeneration | undefined {
    return this.generationOf(snapshotProfile(this.readConfig()))
  }

  private generationOfSnapshot(profile: AcpStubAgentConfig | undefined): ProfileGeneration | undefined {
    if (profile === undefined) return undefined
    return {
      id: profileLaunchIdentityHash(this.profileId, profile),
      config: profile,
      probe: this.probeFactory(profile),
    }
  }

  private async resolveModelForGeneration(provider: string, model: string, generation: ProfileGeneration, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await generation.probe.listModels(provider)
    if (signal?.aborted) signal.throwIfAborted()
    const found = models.find((entry) => entry.id === model)
    const reasoning = reasoningInfoFromConfigOptions(this.profileId, generation.config, generation.probe.configOptionsForModel?.(provider, model) ?? generation.probe.configOptions?.(provider))
    return found === undefined
      ? { provider, id: model, name: model, ...(reasoning === undefined ? {} : { reasoning }) }
      : { ...found, ...(reasoning === undefined ? {} : { reasoning }) }
  }

  /** Narrow session-scoped control/read surface for the additive Agent dock. */
  async agentSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshotView> {
    const runtime = this.runtimeForSession(sessionId)
    if (runtime !== undefined) return this.liveAgentSessionSnapshot(sessionId, runtime)
    if (this.sidecar === undefined) throw new LlmError('ACP sidecar is unavailable', 'ACP_BINDING_UNAVAILABLE')
    const lookup = await this.sidecar.readLatestBinding(sessionId as never)
    if (lookup?.status !== 'ok') throw new LlmError('No established ACP Agent session is available', 'ACP_SESSION_UNAVAILABLE')
    const snapshot = await this.sidecar.readOptionSnapshot(sessionId as never)
    if (snapshot === undefined) throw new LlmError('No last-known Agent session controls are available', 'ACP_SESSION_OPTIONS_UNAVAILABLE')
    const configOptions = snapshot.options.map(option => option.values === null
      ? { type: 'boolean' as const, id: option.id, name: option.name, ...(option.category === null ? {} : { category: option.category }), currentValue: typeof option.value === 'boolean' ? option.value : false }
      : { type: 'select' as const, id: option.id, name: option.name, ...(option.category === null ? {} : { category: option.category }), currentValue: typeof option.value === 'string' ? option.value : '', options: option.values.map(value => ({ value, name: value })) })
    return {
      sessionId,
      profileId: this.profileId,
      freshness: 'stale',
      editable: false,
      configOptions,
      modes: snapshot.modes?.availableModes ?? null,
      currentModeId: snapshot.currentModeId,
      contextUsage: snapshot.contextUsage === undefined || snapshot.contextUsage === null ? null : {
        used: snapshot.contextUsage.used, size: snapshot.contextUsage.size,
        percent: snapshot.contextUsage.size > 0 ? Math.round(snapshot.contextUsage.used / snapshot.contextUsage.size * 1000) / 10 : 0,
        cost: snapshot.contextUsage.cost ?? null,
      },
      note: 'Last known Agent session state; controls are read-only until the Agent reconnects.',
    }
  }

  async setAgentSessionOption(sessionId: string, request: AgentSessionOptionWrite): Promise<AgentSessionSnapshotView> {
    const runtime = this.runtimeForSession(sessionId)
    if (runtime === undefined || runtime.isBusy === true) throw new LlmError('Agent session is not live or is currently running', 'ACP_SESSION_OPTIONS_READ_ONLY')
    if (request.kind === 'mode') {
      if (runtime.setMode === undefined) throw new LlmError('This Agent does not expose mode controls', 'ACP_CONFIG_UNSUPPORTED')
      if (runtime.modes === undefined || !runtime.modes.availableModes.some(mode => mode.id === request.id)) throw new LlmError(`Agent mode "${request.id}" is not available`, 'ACP_CONFIG_UNSUPPORTED')
      await runtime.setMode(request.id)
    } else {
      const option = runtime.configOptions?.find(candidate => candidate.id === request.id)
      if (option === undefined || isAcpModelOrReasoningOption(option)) {
        throw new LlmError('Model and reasoning controls are managed by the DSH model picker', 'ACP_CONFIG_UNSUPPORTED')
      }
      if (option.type === 'select' && (typeof request.value !== 'string' || !this.selectValues(option).has(request.value))) throw new LlmError(`Agent option "${request.id}" does not allow that value`, 'ACP_CONFIG_UNSUPPORTED')
      if (option.type === 'boolean' && typeof request.value !== 'boolean') throw new LlmError(`Agent option "${request.id}" expects a boolean`, 'ACP_CONFIG_UNSUPPORTED')
      if (runtime.setConfigOption === undefined) throw new LlmError('This Agent does not expose session controls', 'ACP_CONFIG_UNSUPPORTED')
      await runtime.setConfigOption(request.id, request.value)
    }
    await this.persistRuntimeSnapshot(sessionId, runtime)
    return this.liveAgentSessionSnapshot(sessionId, runtime)
  }

  private runtimeForSession(sessionId: string): AcpProfileRuntime | undefined {
    for (const [key, runtime] of this.runtimes) if (key.startsWith(`${sessionId}:`)) return runtime
    return undefined
  }

  private liveAgentSessionSnapshot(sessionId: string, runtime: AcpProfileRuntime): AgentSessionSnapshotView {
    const options = runtime.configOptions === undefined ? null : runtime.configOptions.map(option => {
      if (option.type === 'boolean') return { type: 'boolean' as const, id: option.id, name: option.name, ...(option.description === undefined ? {} : { description: option.description }), ...(option.category === undefined ? {} : { category: option.category }), currentValue: option.currentValue }
      return { type: 'select' as const, id: option.id, name: option.name, ...(option.description === undefined ? {} : { description: option.description }), ...(option.category === undefined ? {} : { category: option.category }), currentValue: option.currentValue, options: option.options.map(entry => 'options' in entry ? { group: entry.group, name: entry.name, options: entry.options.map(value => ({ value: value.value, name: value.name, ...(value.description === undefined ? {} : { description: value.description }) })) } : ({ value: entry.value, name: entry.name, ...(entry.description === undefined ? {} : { description: entry.description }) })) }
    })
    const modes: readonly AgentSessionModeView[] | null = runtime.modes?.availableModes?.map(mode => ({ id: mode.id, name: mode.name, ...(mode.description === undefined ? {} : { description: mode.description }) })) ?? null
    const usage = runtime.contextUsage
    return {
      sessionId, profileId: this.profileId, freshness: 'live', editable: runtime.isBusy !== true,
      configOptions: options, modes, currentModeId: runtime.currentModeId ?? runtime.modes?.currentModeId ?? null,
      contextUsage: usage === undefined ? null : { used: usage.used, size: usage.size, percent: usage.size > 0 ? Math.round(usage.used / usage.size * 1000) / 10 : 0, cost: usage.cost === undefined ? null : usage.cost },
      note: null,
    }
  }

  private async persistRuntimeSnapshot(sessionId: string, runtime: AcpProfileRuntime): Promise<void> {
    if (this.sidecar === undefined) return
    try {
      const profile = snapshotProfile(this.readConfig())
      if (profile === undefined) return
      await this.sidecar.writeOptionSnapshot(sessionId as never, acpOptionsSnapshotOf(runtime.configOptions, runtime.currentModeId, profileLaunchIdentityHash(this.profileId, profile), Date.now(), {
        contextUsage: runtime.contextUsage === undefined ? null : runtime.contextUsage,
        modes: runtime.modes === undefined ? null : { currentModeId: runtime.modes.currentModeId, availableModes: runtime.modes.availableModes.map(mode => ({ id: mode.id, name: mode.name, ...(mode.description === undefined ? {} : { description: mode.description }) })) },
      }))
    } catch { /* last-known presentation is best effort */ }
  }

  /** Flatten ACP select values without assuming whether the agent groups them. */
  private selectValues(option: acp.SessionConfigOption | undefined): Set<string> {
    if (option?.type !== 'select') return new Set()
    return new Set(option.options.flatMap((entry) => 'options' in entry ? entry.options : [entry]).map((entry) => entry.value))
  }

  private findSelectOption(options: readonly acp.SessionConfigOption[], kind: 'model' | 'reasoning'): Extract<acp.SessionConfigOption, { type: 'select' }> | undefined {
    return options.find((option): option is Extract<acp.SessionConfigOption, { type: 'select' }> => {
      if (option.type !== 'select') return false
      if (kind === 'model') return normalizeAcpConfigOptionKey(option.category ?? '') === 'model' || normalizeAcpConfigOptionKey(option.id) === 'model'
      const id = normalizeAcpConfigOptionKey(option.id)
      return normalizeAcpConfigOptionKey(option.category ?? '') === 'thought_level' || normalizeAcpConfigOptionKey(option.category ?? '') === 'reasoning_effort' || id === 'thought_level' || id === 'reasoning_effort'
    })
  }

  /**
   * Match one DSH reasoning request against the live Agent option.
   *
   * Kimi Code 0.39.1 advertises `high` on session/new, but the same durable
   * session resumes with the collapsed value `on` as its only selectable
   * thinking state. Sending the stale catalog value back would violate ACP's
   * live option contract, while rejecting it makes every restarted Kimi
   * session unusable. Keep this compatibility rule explicit and profile-bound:
   * it applies only when `high` has disappeared and the Agent itself confirms
   * `on`; all other unknown value drift remains fail-closed.
   */
  private reasoningRequestIsCurrent(option: Extract<acp.SessionConfigOption, { type: 'select' }>, requested: string): boolean {
    if (option.currentValue === requested) return true
    const values = this.selectValues(option)
    return descriptorOf(this.profileId, this.readConfig())?.id === 'kimi'
      && requested === 'high'
      && option.currentValue === 'on'
      && values.has('on')
      && !values.has('high')
  }

  /**
   * Align the stock DSH request with the live ACP session before the durable
   * dispatch WAL. This is intentionally a narrow session-scoped adapter seam:
   * it never changes native routes or DSH permission presets.
   */
  private async convergeConfig(runtime: AcpProfileRuntime, options: GenerateOptions): Promise<void> {
    // Legacy embedding fakes without the new runtime property are not an ACP
    // session implementation. Keep their existing contract; the real runtime
    // always declares configOptions, including an explicit undefined value.
    if (!('configOptions' in runtime)) return
    const snapshot = runtime.configOptions
    if (snapshot === undefined) throw new LlmError('ACP session did not advertise configuration options required by the selected model', 'ACP_CONFIG_UNSUPPORTED')
    const modelOption = this.findSelectOption(snapshot, 'model')
    // ACP option lists describe values that may be selected now. They do not
    // necessarily repeat a legacy value that an older, resumed session is
    // already using. Treat the Agent-confirmed current value as valid even
    // when it has disappeared from the selectable catalog; only a requested
    // change must still be present in `options`.
    if (modelOption === undefined || (modelOption.currentValue !== options.model && !this.selectValues(modelOption).has(options.model))) {
      throw new LlmError(`ACP session does not allow model "${options.model}"`, 'ACP_CONFIG_UNSUPPORTED')
    }
    const previousModel = modelOption.currentValue
    const modelChanged = previousModel !== options.model
    const applyOption = async (option: Extract<acp.SessionConfigOption, { type: 'select' }>, value: string): Promise<void> => {
      if (runtime.setConfigOption === undefined) throw new LlmError('ACP runtime cannot change its model configuration', 'ACP_CONFIG_UNSUPPORTED')
      try { await runtime.setConfigOption(option.id, value, options.signal) } catch (error) {
        throw new LlmError(`ACP configuration could not be applied: ${error instanceof Error ? error.message : String(error)}`, 'ACP_CONFIG_SYNC_FAILED', { cause: error })
      }
      if (runtime.configOptions?.find((entry) => entry.id === option.id)?.currentValue !== value) {
        throw new LlmError(`ACP agent did not confirm configuration "${option.id}"`, 'ACP_CONFIG_SYNC_FAILED')
      }
    }
    if (!modelChanged && options.reasoningEffort === undefined) return
    if (modelChanged) {
      try {
        await applyOption(modelOption, options.model)
      } catch (error) {
        throw error
      }
    }
    if (options.reasoningEffort === undefined) return
    // A model change can change the available reasoning values. Always inspect
    // the confirmed response snapshot rather than the pre-change object.
    const confirmedSnapshot = runtime.configOptions
    if (confirmedSnapshot === undefined) throw new LlmError('ACP agent did not return a configuration snapshot', 'ACP_CONFIG_SYNC_FAILED')
    const reasoningOption = this.findSelectOption(confirmedSnapshot, 'reasoning')
    try {
      const requestedReasoning = String(options.reasoningEffort)
      if (reasoningOption === undefined || (!this.reasoningRequestIsCurrent(reasoningOption, requestedReasoning) && !this.selectValues(reasoningOption).has(requestedReasoning))) {
        throw new LlmError(`ACP session does not allow reasoning effort "${String(options.reasoningEffort)}"`, 'ACP_CONFIG_UNSUPPORTED')
      }
      if (!this.reasoningRequestIsCurrent(reasoningOption, requestedReasoning)) {
        await applyOption(reasoningOption, requestedReasoning)
      }
    } catch (error) {
      if (!modelChanged) throw error
      // A model switch may invalidate the requested effort. Restore the
      // previous model before failing closed so a half-applied configuration
      // cannot surprise the next turn.
      try {
        const rollbackOption = this.findSelectOption(runtime.configOptions ?? [], 'model')
        if (rollbackOption === undefined || !this.selectValues(rollbackOption).has(previousModel)) throw new Error('previous model is no longer selectable')
        await applyOption(rollbackOption, previousModel)
      } catch (rollbackError) {
        throw new LlmError(`ACP configuration failed and the previous model could not be restored; inspect the Agent session (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`, 'ACP_CONFIG_SYNC_FAILED', { cause: error })
      }
      throw new LlmError(`ACP reasoning configuration is unavailable for the selected model; the previous model was restored (${error instanceof Error ? error.message : String(error)})`, error instanceof LlmError ? error.code : 'ACP_CONFIG_SYNC_FAILED', { cause: error })
    }
  }

  private streamWithGeneration(options: GenerateOptions, generation: ProfileGeneration | undefined): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (options.purpose !== undefined) {
        throw new LlmError('ACP does not execute auxiliary title or compaction requests', 'ACP_AUXILIARY_CALL')
      }
      const sessionKey = String(options.sessionId ?? '')
      if (sessionKey.length === 0) throw new LlmError('ACP requires a DSH session id', 'ACP_SESSION_UNAVAILABLE')
      if (self.sidecar === undefined) throw new LlmError('ACP sidecar is unavailable; the Agent binding cannot be made durable', 'ACP_BINDING_UNAVAILABLE')
      const durableSidecar = self.sidecar
      const session = self.sessionOf(sessionKey)
      let admissionProof: CurrentStepProof | undefined
      let messages: readonly import('@deepseek-ai/dsh-llm').UserMessage[]
      try {
        messages = admitCurrentStep(options, session, proof => {
          admissionProof = proof
        })
      } catch (error: unknown) {
        if (error instanceof AcpAdmissionError) throw new LlmError(error.message, error.code)
        throw error
      }
      const profile = generation?.config
      if (profile === undefined || generation === undefined) throw new LlmError(`ACP profile "${self.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
      if (!self.subprocess.ok) throw new LlmError(self.subprocess.message, 'ACP_SPAWN_FAILURE')
      const runtimeKey = `${sessionKey}:${generation.id}`
      const priorGeneration = [...self.runtimes.keys()].find(key => key.startsWith(`${sessionKey}:`))
      if (priorGeneration !== undefined && priorGeneration !== runtimeKey) {
        // M2 has no binding/recovery transaction yet.  Never silently start a
        // new ACP session after a profile identity edit: doing so would lose
        // the remote context while DSH still shows the old conversation.
        if (self.sidecar !== undefined) {
          await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'profile-changed', detail: 'The ACP profile changed while this DSH session was active; restore the original profile or explicitly rebind blank' })
        }
        throw new LlmError('ACP profile changed; recover or start a new DSH session before continuing', 'ACP_PROFILE_CHANGED')
      }
      const runtime = self.runtimes.get(runtimeKey) ?? self.runtimeFactory(self.runtimeOptionsFor(sessionKey, profile, session?.header?.cwd ?? (() => { throw new LlmError('ACP requires the DSH session working directory', 'ACP_SESSION_CWD_UNAVAILABLE') })()))
      self.runtimes.set(runtimeKey, runtime)
      let validatedPrompt: acp.ContentBlock[]
      // Capability negotiation is deliberately before session/new, restore,
      // WAL, or prompt. Invalid/unsupported input therefore cannot create an
      // ACP session or a durable dispatch record.
      try {
        // Only the real runtime exposes the side-effect-free initialize seam.
        // Legacy test/embedding runtimes must not be started here: start() may
        // create session/new, and doing it before fork/restore both duplicates
        // setup and makes a fork look like a blank session.
        if (runtime.initialize !== undefined) await runtime.initialize(options.signal)
        const prompt = await toAcpPrompt(messages, {
          system: options.system ?? '',
          imageEnabled: runtime.agentCapabilities?.promptCapabilities?.image === true,
          ...(self.attachments === undefined ? {} : { attachments: self.attachments }),
          signal: options.signal ?? new AbortController().signal,
        })
        if (prompt.length === 0) throw new AcpPromptContentError('dsh-acp: the claimed message(s) carry no supported content; nothing was sent to the ACP agent')
        // Store the validated prompt for the dispatch path below.
        validatedPrompt = prompt
      } catch (error: unknown) {
        await runtime.close().catch(() => undefined)
        self.runtimes.delete(runtimeKey)
        if (error instanceof AcpPromptContentError) throw new LlmError(error.message, 'ACP_INPUT_NOT_SUPPORTED')
        throw error
      }
      const prompt = validatedPrompt
      const dispatchKey = acpCanonicalHash16({
        provider: options.provider,
        model: options.model,
        generation: generation.id,
        acceptedMessageIds: messages.map(message => String(message.id)),
      })
      // The anchor is a host-side observability aid, not model input. It is
      // deliberately attempted after the direct-user admission proof and
      // before any ACP prompt; unsupported stock hosts degrade to sidecar
      // evidence and retain the native DSH surface unchanged.
      // The sidecar is the DSH-session ↔ ACP-session binding source of truth.
      // Read it before any ACP prompt and fail closed on a durable recovery
      // gate. A blank session may establish a new binding; an existing binding
      // must restore that exact remote session and never silently create one.
      const persistedRecovery = await self.sidecar?.readRecoveryState(sessionKey as never)
      // A rebind request is a durable, explicit instruction to establish a
      // new blank ACP session on the next turn while retaining the old binding
      // as audit history. This also survives a host restart between clicks.
      const forceBlank = persistedRecovery?.lastUserAction === 'rebind-blank'
      const priorBindingForRebind = forceBlank ? await self.sidecar?.readLatestBinding(sessionKey as never) : undefined
      const existingBinding = forceBlank ? undefined : await self.sidecar?.readLatestBinding(sessionKey as never)
      if (existingBinding?.status === 'outdated') {
        await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'binding-outdated', detail: 'The ACP binding record is malformed and cannot be used safely' })
      }
      if (persistedRecovery !== undefined && persistedRecovery.kind !== 'healthy' && !forceBlank) {
        throw new LlmError(persistedRecovery.detail ?? 'ACP session requires recovery before another prompt', 'ACP_RECOVERY_REQUIRED')
      }
      const binding = existingBinding?.status === 'ok' ? existingBinding.binding : undefined
      const currentFingerprint = await self.launchFingerprint(profile)
      const canonicalCwd = self.canonicalCwd(session?.header?.cwd)
      if (binding !== undefined) {
        if (binding.provider !== options.provider || binding.profileId !== self.profileId) {
          await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'backend-conflict', detail: 'The saved ACP binding belongs to another provider or profile' }, binding)
        }
        if (binding.canonicalCwd !== canonicalCwd) {
          await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'cwd-changed', detail: `The session working directory changed from ${binding.canonicalCwd} to ${canonicalCwd}` }, binding)
        }
        if (acpCanonicalHash16(binding.launchFingerprint) !== acpCanonicalHash16(currentFingerprint)) {
          await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'profile-changed', detail: 'The ACP launch configuration no longer matches the saved session binding' }, binding)
        }
        if (typeof runtime.restore !== 'function') {
          await self.blockRecovery(sessionKey, { kind: 'reconciliation-required', cause: 'capability-missing', detail: 'This ACP runtime cannot restore the saved Agent session' }, binding)
        }
        let replayUpdates = 0
        let replayChars = 0
        try {
          await runtime.restore!(binding, options.signal, (notification) => {
            replayUpdates += 1
            const update = notification.update
            if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') replayChars += update.content.text.length
            if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') replayChars += update.content.text.length
          })
          // Replay is staging/audit only. It is intentionally not compared to,
          // or appended over, DSH history; a provider may project it differently.
          await self.sidecar?.append(sessionKey as never, {
            kind: 'replay-assessment',
            data: { status: 'not-compared', detail: `ACP session restore completed (${String(replayUpdates)} staged updates, ${String(replayChars)} text characters)`, acpSessionId: binding.agentSessionId, generation: binding.generation },
          })
        } catch (error: unknown) {
          await runtime.close().catch(() => undefined)
          self.runtimes.delete(runtimeKey)
          const detail = `ACP session restore failed: ${error instanceof Error ? error.message : String(error)}`
          const missing = /(?:session[_ -]?)?(?:not[ -]?found|unknown[_ -]?session)|does not exist/i.test(detail)
          const capability = /does not advertise|cannot restore/i.test(detail)
          await self.blockRecovery(sessionKey, { kind: missing ? 'session-lost' : capability ? 'reconciliation-required' : 'reconnect-required', cause: missing ? 'id-not-found' : capability ? 'capability-missing' : 'load-failed', detail }, binding, missing ? 'ACP_SESSION_NOT_FOUND' : capability ? 'ACP_RECONCILIATION_REQUIRED' : 'ACP_RECONNECT_REQUIRED')
        }
        // Sessions established by an older adapter build may not yet carry
        // the display-only Native Agent Access facts. Idempotently migrate
        // them after the exact ACP binding has been restored.
        projectNativeAgentAccess(session)
      } else {
        let forkOutcome: 'inherited' | 'blank' | undefined
        let forkReason: AcpSessionForkReason | undefined
        let forkParentSessionId: string | undefined
        let forkParentAgentSessionId: string | undefined
        let forkParentBinding: AcpBindingData | undefined
        let forked = false
        const parentSessionId = session?.header?.parentSession
        if (parentSessionId !== undefined) {
          forkParentSessionId = parentSessionId
          const parentLookup = await self.sidecar.readLatestBinding(parentSessionId as never)
          const parentBinding = parentLookup?.status === 'ok' ? parentLookup.binding : undefined
          forkParentBinding = parentBinding
          forkParentAgentSessionId = parentBinding?.agentSessionId
          if (parentBinding === undefined) {
            forkReason = 'parent-binding-unavailable'
          } else if (parentBinding.provider !== options.provider || parentBinding.profileId !== self.profileId) {
            forkReason = 'parent-binding-mismatch'
          } else if (parentBinding.canonicalCwd !== canonicalCwd
            || acpCanonicalHash16(parentBinding.launchFingerprint) !== acpCanonicalHash16(currentFingerprint)) {
            forkReason = 'parent-binding-mismatch'
          } else {
            const parentRecovery = await self.sidecar.readRecoveryState(parentSessionId as never)
            if (parentRecovery !== undefined && parentRecovery.kind !== 'healthy') {
              forkReason = 'parent-recovery-required'
            } else if (self.sessionOf(parentSessionId) === undefined) {
              forkReason = 'parent-binding-unavailable'
            } else if (hasOpenTurn(self.sessionOf(parentSessionId))) {
              forkReason = 'parent-not-idle'
            } else if (!isLatestForkCut(session, parentSessionId, parentBinding, currentFingerprint)) {
              forkReason = 'seed-not-latest-semantic-boundary'
            } else if (typeof runtime.fork !== 'function') {
              forkReason = 'agent-does-not-advertise-fork'
            } else {
              try {
                await runtime.fork(parentBinding.agentSessionId, options.signal, { agent: parentBinding.agent, protocolVersion: parentBinding.protocolVersion }, async () => {
                  // The runtime has initialized and completed all pre-RPC
                  // checks. Persist intent immediately before session/fork so
                  // unsupported/precondition failures cannot leave a false gate.
                  try {
                    await durableSidecar.writeRecoveryState({
                      dshSessionId: sessionKey as never,
                      kind: 'outcome-unknown',
                      cause: 'fork-intent',
                      detail: 'ACP session/fork was dispatched; its child binding is not durable yet',
                      provider: options.provider,
                      acpSessionId: parentBinding.agentSessionId,
                      generation: parentBinding.generation,
                      updatedAt: Date.now(),
                    })
                  } catch (error) {
                    throw new Error(`ACP_FORK_INTENT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
                  }
                })
                forked = true
                forkOutcome = 'inherited'
                forkReason = 'inherited'
              } catch (error: unknown) {
                if (error instanceof Error && error.message === 'ACP_FORK_UNSUPPORTED') {
                  forkReason = 'agent-does-not-advertise-fork'
                } else if (error instanceof Error && error.message === 'ACP_FORK_PRECONDITION_FAILED') {
                  forkReason = 'parent-binding-mismatch'
                } else if (error instanceof Error && error.message.startsWith('ACP_FORK_INTENT_FAILED')) {
                  await runtime.close().catch(() => undefined)
                  self.runtimes.delete(runtimeKey)
                  throw new LlmError('ACP fork intent could not be persisted; no remote fork was sent', 'ACP_FORK_INTENT_FAILED')
                } else {
                  await runtime.close().catch(() => undefined)
                  self.runtimes.delete(runtimeKey)
                  const detail = `ACP session/fork outcome is unknown: ${error instanceof Error ? error.message : String(error)}`
                  await self.blockRecovery(sessionKey, { kind: 'outcome-unknown', cause: 'load-failed', detail }, parentBinding, 'ACP_FORK_FAILED')
                }
              }
            }
          }
          if (!forked) forkOutcome = 'blank'
        }
        // Runtime startup has no prompt side effect; do it before the WAL so a
        // missing executable/login/session creation does not poison recovery.
        if (!forked) {
          try {
            await runtime.start(options.signal)
          } catch (error: unknown) {
            // Session setup (including MCP capability validation) failed
            // before session/new. Reclaim the initialized connection so an
            // unsupported transport cannot strand a process/runtime entry.
            await runtime.close().catch(() => undefined)
            self.runtimes.delete(runtimeKey)
            throw error
          }
        }
        if (self.sidecar !== undefined) {
          const agent = runtime.agentInfo
          // The permission chip is a derived presentation fact for an already
          // established ACP runtime. Append it before taking the first binding
          // head so the durable binding covers the exact DSH event prefix it
          // created; a restart can never observe two uncommitted display-only
          // events after an otherwise healthy binding.
          projectNativeAgentAccess(session)
          const dshHead = (session === undefined ? [] : snapshotSessionEvents(session))
            .reduce((max, event) => Math.max(max, event.seq), admissionProof?.startSeq ?? 0)
          const bindingData: AcpBindingData = {
          provider: options.provider,
          agentSessionId: runtime.acpSessionId ?? (() => { throw new LlmError('ACP runtime did not return a session id', 'ACP_SESSION_UNAVAILABLE') })(),
          profileId: self.profileId,
          canonicalCwd,
          launchFingerprint: currentFingerprint,
          agent: {
            ...(agent?.name === undefined ? {} : { name: agent.name }),
            ...(agent?.version === undefined ? {} : { version: agent.version }),
          },
          protocolVersion: runtime.protocolVersion ?? 1,
          capabilityHash: acpCanonicalHash16(runtime.agentCapabilities ?? {}),
          configHash: acpCanonicalHash16({ profileId: self.profileId, command: profile.command, args: profile.args, envKeys: Object.keys(profile.env).sort() }),
          generation: self.nextGenerations.get(sessionKey) ?? (forceBlank ? (persistedRecovery?.generation ?? 1) : 1),
          bindingEpoch: self.nextGenerations.get(sessionKey) ?? (forceBlank && priorBindingForRebind?.status === 'ok' ? (priorBindingForRebind.binding.bindingEpoch ?? priorBindingForRebind.binding.generation) + 1 : 1),
          committedPromptOrdinal: 0,
          historyBaseSeq: forked && forkParentBinding !== undefined
            ? forkParentBinding.historyBaseSeq
            : forceBlank && priorBindingForRebind?.status === 'ok' ? priorBindingForRebind.binding.dshCommittedSeq : (admissionProof?.startSeq ?? 0),
          establishedAt: Date.now(),
          dshCommittedSeq: forceBlank && priorBindingForRebind?.status === 'ok' ? Math.max(priorBindingForRebind.binding.dshCommittedSeq, dshHead) : dshHead,
          }
          try {
            await self.sidecar.append(sessionKey as never, { kind: 'binding', data: bindingData })
            if (forkOutcome !== undefined && forkReason !== undefined) {
              await self.sidecar.append(sessionKey as never, {
                kind: 'session-fork',
                data: {
                  outcome: forkOutcome,
                  reason: forkReason,
                  ...(forkParentSessionId === undefined ? {} : { parentSessionId: forkParentSessionId }),
                  ...(forkParentAgentSessionId === undefined ? {} : { parentAgentSessionId: forkParentAgentSessionId }),
                  ...(forked ? { agentSessionId: bindingData.agentSessionId } : {}),
                },
              })
            }
            await self.sidecar.writeRecoveryState({ dshSessionId: sessionKey as never, kind: 'healthy', provider: options.provider, acpSessionId: bindingData.agentSessionId, generation: bindingData.generation, updatedAt: Date.now() })
            self.nextGenerations.delete(sessionKey)
          } catch (error: unknown) {
            await runtime.close().catch(() => undefined)
            self.runtimes.delete(runtimeKey)
            throw new LlmError(`ACP binding could not be persisted; no prompt was sent (${error instanceof Error ? error.message : String(error)})`, 'ACP_BINDING_PERSIST_FAILED')
          }
        }
      }
      // ACP configuration is session-scoped. Reconcile the stock DSH request
      // only after setup/restore has established the session, but before the
      // dispatch WAL: a rejected or unconfirmed change must cause zero WAL and
      // zero prompt, never a silent request with a different model/effort.
      try {
        await self.convergeConfig(runtime, options)
      } catch (error: unknown) {
        await runtime.close().catch(() => undefined)
        self.runtimes.delete(runtimeKey)
        if (error instanceof LlmError) throw error
        throw new LlmError(`ACP session configuration could not be applied: ${error instanceof Error ? error.message : String(error)}`, 'ACP_CONFIG_SYNC_FAILED', { cause: error })
      }
      try {
        await self.ledger.begin({ key: dispatchKey, dshSessionId: sessionKey, provider: options.provider, model: options.model, createdAt: Date.now(), ...(admissionProof === undefined ? {} : { provenance: admissionProof }) })
      } catch (error: unknown) {
        // A duplicate/uncertain durable dispatch is a host recovery fact, not
        // a generic provider exception. Persist a stable gate before exposing
        // the error; most importantly, do not cross into ACP prompt.
        try {
          await self.sidecar.writeRecoveryState({
            dshSessionId: sessionKey as never,
            kind: 'outcome-unknown',
            cause: 'load-failed',
            detail: `ACP dispatch was not started because its durable guard rejected the request: ${error instanceof Error ? error.message : String(error)}`,
            provider: options.provider,
            ...(runtime.acpSessionId === undefined ? {} : { acpSessionId: runtime.acpSessionId }),
            updatedAt: Date.now(),
          })
        } catch { /* original durable ledger error remains the primary cause */ }
        await runtime.close().catch(() => undefined)
        self.runtimes.delete(runtimeKey)
        throw new LlmError('ACP dispatch is blocked by a durable recovery guard; review the session before continuing', 'ACP_RECOVERY_REQUIRED')
      }
      const queue: StreamChunk[] = []
      let activityFallbackSeq = 0
      let activityWriteTail = Promise.resolve()
      const currentActivities = new Map<string, NormalizedActivity>()
      const externalDelegations: ExternalDelegationObservation[] = []
      const profileKind = descriptorOf(self.profileId, profile)?.id ?? self.profileId
      const delegationNormalizer = new ExternalDelegationNormalizer(profileKind)
      const toolChildren = new Map<string, Map<number, NormalizedActivity>>()
      // Tool ids are session-scoped, while sparse patch state belongs to this
      // one prompt projection.  Never carry a partially observed call into a
      // later DSH turn, even if an Agent reuses its id.
      const toolCallReducer = new AcpToolCallReducer(dispatchKey)
      const scheduleActivity = (activity: NormalizedActivity): void => {
        if (typeof durableSidecar.upsertActivity !== 'function') return
        currentActivities.set(activity.activityId, activity)
        const fallbackAnchor = admissionProof?.anchorMessageId ?? `prompt:${dispatchKey}`
        const stableActivityId = `${fallbackAnchor}:${activity.activityId}`
        activityWriteTail = activityWriteTail.then(async () => {
          try {
            await durableSidecar.upsertActivity({
              dshSessionId: sessionKey,
              ownerDshSessionId: sessionKey,
              promptAnchorMessageId: fallbackAnchor,
              // Tool ids are only unique within an ACP turn. Prefixing with
              // the DSH turn anchor prevents a later turn from replacing an
              // earlier row while preserving the vendor id in the suffix.
              activityId: stableActivityId,
              time: Date.now(),
              kind: activity.kind,
              status: activity.status,
              presentation: activity.presentation,
              ...(activity.rawDetail === undefined ? {} : { rawDetail: activity.rawDetail }),
            })
          } catch {
            // Activity detail is a presentation aid. A malformed/overlarge
            // detail must not block the ACP turn; binding and dispatch WAL
            // failures remain fail-closed above.
          }
        })
        activityFallbackSeq += 1
      }
      const settleRunningActivities = (status: 'completed' | 'failed' | 'cancelled'): void => {
        for (const activity of currentActivities.values()) {
          if (!isTerminalActivityStatus(activity.status)) scheduleActivity({ ...activity, status })
        }
      }
      let wake: (() => void) | undefined
      let done = false
      let failure: unknown
      let visibleContentEmitted = false
      // DSH block indices are global within one assistant message. ACP sends
      // thought, visible text, and native images as different update kinds.
      // Text/reasoning keep their index while contiguous; an image or fallback
      // closes that logical segment so later text receives a later index.
      let nextContentIndex = 0
      let textContentIndex: number | undefined
      let reasoningContentIndex: number | undefined
      const contentIndex = (kind: 'text' | 'reasoning'): number => {
        const current = kind === 'text' ? textContentIndex : reasoningContentIndex
        if (current !== undefined) return current
        const allocated = nextContentIndex
        nextContentIndex += 1
        if (kind === 'text') textContentIndex = allocated
        else reasoningContentIndex = allocated
        return allocated
      }
      const pushChunk = (chunk: StreamChunk): void => {
        queue.push(chunk)
        wake?.(); wake = undefined
      }
      const pushNonTextFallback = (content: AcpNonTextContent): void => {
        textContentIndex = undefined
        reasoningContentIndex = undefined
        pushChunk({ type: 'text-delta', index: contentIndex('text'), text: `\n\n${nonTextContentFallback(content)}\n\n` })
        visibleContentEmitted = true
        // Keep the fallback as its own block in ACP content order.
        textContentIndex = undefined
      }
      const emitAgentContent = async (content: acp.ContentBlock): Promise<void> => {
        if (content.type === 'text') {
          // DSH treats whitespace-only assistant content as non-visible. Keep
          // the same terminal-response rule here so formatting whitespace
          // cannot mask ACP_NO_VISIBLE_RESPONSE.
          if (content.text.trim().length > 0) visibleContentEmitted = true
          pushChunk({ type: 'text-delta', index: contentIndex('text'), text: content.text })
          return
        }
        if (content.type === 'image' && self.attachments?.saveImages !== undefined) {
          try {
            const [attachment] = await admitEncodedImages(self.attachments as AttachmentStore, [{
              mediaType: content.mimeType as ImageMediaType,
              data: content.data,
            }])
            if (attachment === undefined) throw new Error('attachment store returned no image reference')
            textContentIndex = undefined
            reasoningContentIndex = undefined
            const index = nextContentIndex
            nextContentIndex += 1
            pushChunk({ type: 'block-start', index, blockType: 'image' })
            pushChunk({ type: 'block-end', index, block: { type: 'image', attachment } })
            visibleContentEmitted = true
            return
          } catch {
            // Invalid/unsupported image bytes and storage failures remain
            // visible without exposing the raw base64 payload.
          }
        }
        pushNonTextFallback(content)
      }
      // Attachment admission is asynchronous while ACP notifications are not.
      // Serialize all assistant chunks through one tail so text/image/text
      // cannot be reordered by image validation or storage latency.
      let contentDeliveryTail = Promise.resolve()
      const scheduleContent = (task: () => void | Promise<void>): void => {
        contentDeliveryTail = contentDeliveryTail.then(async () => { await task() })
      }
      const onUpdate = (notification: AcpSessionNotification): void => {
        const update = notification.update
        const delegation = delegationNormalizer.acceptNotification(notification, Date.now())
        if (delegation !== undefined) externalDelegations.push(delegation)
        // Native child notifications are evidence for the projected child,
        // never assistant/tool output of the root DSH turn.
        if (runtime.acpSessionId !== undefined && notification.sessionId !== runtime.acpSessionId) return
        const isToolUpdate = update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
        const toolId = isToolUpdate && typeof update.toolCallId === 'string'
          ? update.toolCallId
          : `fallback:${String(activityFallbackSeq + 1)}`
        let toolCall: AcpToolCallSnapshot | undefined
        if (isToolUpdate) {
          const patch: AcpToolCallPatch = {
            callId: toolId,
            ...(update.title === undefined ? {} : { title: update.title }),
            ...(update.name === undefined ? {} : { name: update.name }),
            ...(update.kind === undefined ? {} : { kind: update.kind }),
            ...(update.status === undefined ? {} : { status: update.status }),
            ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
            ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
            ...(update.locations === undefined ? {} : { locations: update.locations }),
            ...(update.content === undefined ? {} : { content: update.content }),
          }
          toolCall = toolCallReducer.apply(patch)
        }
        const normalized = activitiesForNotification(
          notification,
          `${String(notification.sessionId)}:${String(activityFallbackSeq + 1)}`,
          toolCall,
        )
        if (isToolUpdate && toolCall !== undefined) {
          const previousChildren = toolChildren.get(toolId) ?? new Map<number, NormalizedActivity>()
          const nextChildren = new Map<number, NormalizedActivity>()
          const status = activityStatus(toolCall.status)
          if (Array.isArray(toolCall.content)) {
            for (const [index, item] of toolCall.content.entries()) {
              const child = normalizeActivityContent(`tool:${toolId}:${String(index)}`, item, status)
              if (child !== undefined) nextChildren.set(index, child)
            }
          }
          for (const [index, previous] of previousChildren) {
            const next = nextChildren.get(index)
            if ((next === undefined || next.activityId !== previous.activityId) && !isTerminalActivityStatus(previous.status)) {
              scheduleActivity({ ...previous, status: isTerminalActivityStatus(status) ? status : 'completed' })
            }
          }
          toolChildren.set(toolId, nextChildren)
        }
        for (const activity of normalized) scheduleActivity(activity)
        if (update.sessionUpdate === 'agent_message_chunk') {
          scheduleContent(async () => { await emitAgentContent(update.content) })
        } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
          const thought = update.content.text
          scheduleContent(() => {
            pushChunk({ type: 'reasoning-delta', index: contentIndex('reasoning'), text: thought })
          })
        }
      }
      const prompting = runtime.prompt(prompt, onUpdate, options.signal).then(async (response: acp.PromptResponse) => {
        try {
          await contentDeliveryTail
          settleRunningActivities(response.stopReason === 'cancelled' ? 'cancelled' : 'completed')
          await activityWriteTail
          // The response is not exposed to DSH until the terminal state is
          // durable. A WAL failure therefore leaves recovery required and is
          // surfaced as an adapter error rather than a false successful turn.
          await self.ledger.settle(sessionKey, dispatchKey)
          await self.persistRuntimeSnapshot(sessionKey, runtime)
          const committedBinding = await self.refreshBindingHead(sessionKey, session)
          const projectAfterFinish = async (): Promise<void> => {
            if (committedBinding === undefined || runtime.acpSessionId === undefined || self.projectExternalDelegation === undefined) return
            for (const delegation of externalDelegations) {
              try {
                const childSessionId = await self.projectExternalDelegation(delegation, {
                  profileId: self.profileId,
                  bindingGeneration: committedBinding.generation,
                  rootAcpSessionId: runtime.acpSessionId,
                  parentDshSessionId: sessionKey,
                  parentCwd: canonicalCwd,
                  ...(session?.header?.delegationDepth === undefined ? {} : { parentDelegationDepth: session.header.delegationDepth }),
                })
                if (childSessionId !== undefined) {
                  scheduleActivity({
                    activityId: `delegated-record:${delegation.vendorDelegationKey}`,
                    kind: 'delegated', status: 'completed', presentation: delegation.label,
                    rawDetail: activityRawDetail({
                      projectedChildSessionId: childSessionId,
                      resultCompleteness: delegation.result.completeness,
                      ...(delegation.sourceToolCallId === undefined ? {} : { sourceToolCallId: delegation.sourceToolCallId }),
                    }),
                  })
                }
              } catch (error) {
                  scheduleActivity({
                    activityId: `delegated-record:${delegation.vendorDelegationKey}`,
                    kind: 'delegated', status: 'failed', presentation: delegation.label,
                    rawDetail: activityRawDetail({
                      projection: 'unavailable', reason: error instanceof Error ? error.message : String(error),
                      ...(delegation.sourceToolCallId === undefined ? {} : { sourceToolCallId: delegation.sourceToolCallId }),
                    }),
                  })
              }
            }
            await activityWriteTail
          }
          let committedActivitySeq = 0
          if (typeof durableSidecar.activityHead === 'function') {
            try {
              committedActivitySeq = await durableSidecar.activityHead(sessionKey as never)
            } catch {
              // Activity is a presentation partition. A broken activity head
              // must not turn a successfully settled ACP prompt into an
              // outcome-unknown recovery gate.
              try {
                await durableSidecar.append(sessionKey as never, { kind: 'degradation', data: { code: 'unsupported-tool-content', items: [{ type: 'activity-head', reason: 'activity cursor unavailable at turn finish' }], keptPreviewChars: 0, truncated: false } })
              } catch { /* best effort diagnostic */ }
            }
          }
          const replayPayload = response.stopReason === 'cancelled' || committedBinding === undefined || runtime.acpSessionId === undefined
            ? undefined
            : {
                kind: 'dsh-acp' as const,
                version: 1 as const,
                ownerDshSessionId: sessionKey,
                profileId: self.profileId,
                profileGeneration: committedBinding.generation,
                agentSessionId: runtime.acpSessionId,
                bindingEpoch: committedBinding.bindingEpoch ?? committedBinding.generation,
                launchFingerprint: acpCanonicalHash16(committedBinding.launchFingerprint),
                committedPromptOrdinal: committedBinding.committedPromptOrdinal ?? 0,
                committedActivitySeq,
                ...(admissionProof?.anchorMessageId === undefined ? {} : { activityAnchorMessageId: admissionProof.anchorMessageId }),
                ...(admissionProof?.requestHeaderSeq === undefined ? {} : { activityRequestHeaderSeq: admissionProof.requestHeaderSeq }),
              }
          const responseFinish = finishReason(String(response.stopReason))
          // ACP deliberately separates private reasoning from the visible
          // assistant answer.  A successful turn that only emitted
          // agent_thought_chunk is therefore not a usable DSH answer.  Do not
          // promote reasoning to text (or guess a trailing sentence); surface
          // a stable provider error so DSH does not present an apparently
          // successful, answer-less turn.
          const finalReason = responseFinish.kind === 'stop' && !visibleContentEmitted
            ? { kind: 'error' as const, failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message: 'ACP agent completed without a visible response' } }
            : responseFinish
          // Start the projection transaction before publishing finish so its
          // canonical sidecar payload is already durable if the host exits.
          // The projector then waits at its parent barrier until DSH consumes
          // this finish and durably closes the parent turn. Projection is an
          // additive record and must never delay or rewrite the Agent answer.
          void projectAfterFinish()
          pushChunk({ type: 'finish', reason: finalReason, ...(replayPayload === undefined ? {} : { replayState: { response: replayPayload } }) })
        } catch (error: unknown) {
          settleRunningActivities('failed')
          await activityWriteTail
          try {
            await self.sidecar?.writeRecoveryState({
              dshSessionId: sessionKey,
              kind: 'outcome-unknown',
              cause: 'load-failed',
              detail: 'ACP completed but the host could not durably settle its dispatch record',
              provider: options.provider,
              ...(runtime.acpSessionId === undefined ? {} : { acpSessionId: runtime.acpSessionId }),
              updatedAt: Date.now(),
            })
          } catch { /* preserve the settlement error */ }
          await runtime.close().catch(() => undefined)
          self.runtimes.delete(runtimeKey)
          failure = error
        } finally {
          done = true
          wake?.(); wake = undefined
        }
      }, async (error: unknown) => {
        await contentDeliveryTail.catch(() => undefined)
        settleRunningActivities(options.signal?.aborted === true ? 'cancelled' : 'failed')
        await activityWriteTail
        // `auth_required` is a definitive JSON-RPC rejection, not an
        // ambiguous transport loss: the Agent confirmed that it did not run
        // the prompt. Keep the binding for an explicit reconnect after login,
        // but do not tell the user that the prior outcome is unknown.
        const authenticationRequired = error instanceof AcpClientError && error.kind === 'auth_required'
        try {
          await self.sidecar?.writeRecoveryState({
            dshSessionId: sessionKey,
            kind: authenticationRequired ? 'reconnect-required' : 'outcome-unknown',
            cause: authenticationRequired ? 'auth-required' : 'load-failed',
            detail: authenticationRequired
              ? 'The ACP Agent rejected the prompt because authentication is required. Sign in to the Agent, then reconnect this session.'
              : 'ACP prompt ended before its remote outcome was confirmed',
            provider: options.provider,
            ...(runtime.acpSessionId === undefined ? {} : { acpSessionId: runtime.acpSessionId }),
            updatedAt: Date.now(),
          })
        } catch { /* preserve the original transport error */ }
        await runtime.close().catch(() => undefined)
        self.runtimes.delete(runtimeKey)
        failure = error; done = true; wake?.(); wake = undefined
      })
      void prompting
      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve })
          const chunk = queue.shift()
          if (chunk !== undefined) yield chunk
        }
        if (failure !== undefined) {
          // Agent-loop only persists structured provider codes from LlmError.
          // Preserve the ACP taxonomy at that host boundary instead of letting
          // a classified AcpClientError degrade to UNKNOWN in the turn UI.
          if (failure instanceof AcpClientError) {
            throw new LlmError(failure.message, failure.code, { cause: failure })
          }
          throw failure
        }
      } finally {
        // AgentLoop closes the iterator as soon as an aborted turn observes a
        // final ACP update. Keep return() pending until the matching prompt has
        // confirmed cancellation and its dispatch record is durably settled;
        // otherwise an immediate next turn can see a false uncertain outcome.
        if (options.signal?.aborted === true) await prompting
      }
    })()
  }

  private canonicalCwd(cwd: string | undefined): string {
    if (cwd === undefined || cwd.length === 0) throw new LlmError('ACP requires the DSH session working directory', 'ACP_SESSION_CWD_UNAVAILABLE')
    try { return fs.realpathSync.native(cwd) } catch { return path.resolve(cwd) }
  }

  private async launchFingerprint(profile: AcpStubAgentConfig) {
    const descriptor = descriptorOf(this.profileId, profile)
    const env = await acpLaunchEnvironment({ config: profile })
    return acpLaunchFingerprint({ profileId: this.profileId, config: profile, descriptor, env })
  }

  private async blockRecovery(sessionId: string, state: Omit<AcpRecoveryState, 'dshSessionId' | 'updatedAt'>, binding?: { readonly provider?: string; readonly agentSessionId?: string; readonly generation?: number }, errorCode = 'ACP_RECONCILIATION_REQUIRED'): Promise<never> {
    const recovery: AcpRecoveryState = {
      dshSessionId: sessionId,
      ...state,
      ...(binding?.provider === undefined ? {} : { provider: binding.provider }),
      ...(binding?.agentSessionId === undefined ? {} : { acpSessionId: binding.agentSessionId }),
      ...(binding?.generation === undefined ? {} : { generation: binding.generation }),
      updatedAt: Date.now(),
    }
    try {
      await this.sidecar?.writeRecoveryState(recovery)
    } catch (error: unknown) {
      throw new LlmError(`ACP recovery state could not be persisted: ${error instanceof Error ? error.message : String(error)}`, 'ACP_RECOVERY_STATE_UNAVAILABLE')
    }
    throw new LlmError(state.detail ?? 'ACP session requires recovery before another prompt', errorCode)
  }

  private async refreshBindingHead(sessionId: string, session: SessionLike | undefined): Promise<AcpBindingData | undefined> {
    if (this.sidecar === undefined || session === undefined) return undefined
    const current = await this.sidecar.readLatestBinding(sessionId as never)
    if (current?.status !== 'ok') return undefined
    const head = snapshotSessionEvents(session).reduce((max, event) => Math.max(max, event.seq), current.binding.dshCommittedSeq)
    const next: AcpBindingData = {
      ...current.binding,
      dshCommittedSeq: Math.max(head, current.binding.dshCommittedSeq),
      committedPromptOrdinal: (current.binding.committedPromptOrdinal ?? 0) + 1,
    }
    await this.sidecar.append(sessionId as never, { kind: 'binding', data: next })
    return next
  }

  /** Explicitly discard only ACP-side continuity; DSH history is untouched. */
  async rebindBlank(sessionId: string): Promise<void> {
    if (this.sidecar === undefined) throw new LlmError('ACP sidecar is unavailable; the blank rebind cannot be made durable', 'ACP_BINDING_UNAVAILABLE')
    const binding = await this.sidecar.readLatestBinding(sessionId as never)
    const nextGeneration = binding?.status === 'ok' ? binding.binding.generation + 1 : 1
    this.nextGenerations.set(sessionId, nextGeneration)
    await this.closeSessionRuntime(sessionId)
    // Explicitly abandoning the old Agent context also resolves any
    // dispatch-uncertain guard; no remote prompt is retried automatically.
    await this.sidecar.clearDispatch(sessionId as never)
    await this.sidecar.writeRecoveryState({
      dshSessionId: sessionId as never,
      kind: 'healthy',
      ...(binding?.status === 'ok' ? { provider: binding.binding.provider, acpSessionId: binding.binding.agentSessionId } : {}),
      generation: nextGeneration,
      lastUserAction: 'rebind-blank',
      updatedAt: Date.now(),
    })
  }

  /** Allow a user-selected retry to reuse the original durable ACP binding. */
  async retryOriginal(sessionId: string): Promise<void> {
    if (this.sidecar === undefined) throw new LlmError('ACP sidecar is unavailable; the original binding cannot be restored', 'ACP_BINDING_UNAVAILABLE')
    const bindingResult = await this.sidecar.readLatestBinding(sessionId as never)
    if (bindingResult?.status !== 'ok') throw new LlmError('The original ACP binding is unavailable', 'ACP_BINDING_UNAVAILABLE')
    const binding = bindingResult.binding
    const profile = snapshotProfile(this.readConfig())
    const session = this.sessionOf(sessionId)
    if (profile === undefined || session === undefined) throw new LlmError('The original ACP profile or DSH session is unavailable', 'ACP_RECONCILIATION_REQUIRED')
    const cwd = this.canonicalCwd(session.header?.cwd)
    const fingerprint = await this.launchFingerprint(profile)
    if (binding.canonicalCwd !== cwd || acpCanonicalHash16(binding.launchFingerprint) !== acpCanonicalHash16(fingerprint)) {
      throw new LlmError('The original ACP profile and working directory must be restored before retry', 'ACP_RECONCILIATION_REQUIRED')
    }
    if (!this.subprocess.ok) throw new LlmError(this.subprocess.message, 'ACP_SPAWN_FAILURE')
    // Retry only replaces runtimes owned by this DSH session. Other DSH
    // sessions must keep their live Agent processes untouched.
    await this.closeSessionRuntime(sessionId)
    const generation: ProfileGeneration = { id: profileLaunchIdentityHash(this.profileId, profile), config: profile, probe: this.probeFactory(profile) }
    const runtimeKey = `${sessionId}:${generation.id}`
    const runtime = this.runtimeFactory(this.runtimeOptionsFor(sessionId, profile, cwd))
    try {
      if (typeof runtime.restore !== 'function') throw new Error('ACP runtime cannot restore the original session')
      await runtime.restore(binding)
      // The user explicitly reviewed the uncertain outcome. Remove only the
      // durable dispatch guard; the ACP binding and all DSH history remain.
      await this.sidecar.clearDispatch(sessionId as never)
      await this.sidecar.writeRecoveryState({ dshSessionId: sessionId as never, kind: 'healthy', provider: binding.provider, acpSessionId: binding.agentSessionId, generation: binding.generation, lastUserAction: 'retry-original', updatedAt: Date.now() })
      this.runtimes.set(runtimeKey, runtime)
    } catch (error: unknown) {
      await runtime.close().catch(() => undefined)
      const detail = `ACP retry failed: ${error instanceof Error ? error.message : String(error)}`
      const missing = /(?:session[_ -]?)?(?:not[ -]?found|unknown[_ -]?session)|does not exist/i.test(detail)
      const capability = /cannot restore|does not advertise/i.test(detail)
      await this.sidecar.writeRecoveryState({
        dshSessionId: sessionId as never,
        kind: missing ? 'session-lost' : capability ? 'reconciliation-required' : 'reconnect-required',
        cause: missing ? 'id-not-found' : capability ? 'capability-missing' : 'load-failed',
        detail,
        provider: binding.provider,
        acpSessionId: binding.agentSessionId,
        generation: binding.generation,
        updatedAt: Date.now(),
      })
      throw new LlmError(detail, missing ? 'ACP_SESSION_NOT_FOUND' : 'ACP_RETRY_FAILED')
    }
  }

  close(): Promise<void> {
    const closing = [...this.runtimes.values()].map((runtime) => runtime.close())
    this.runtimes.clear()
    return Promise.all(closing).then(() => undefined)
  }

  private async closeSessionRuntime(sessionId: string): Promise<void> {
    const keys = [...this.runtimes.keys()].filter(key => key.startsWith(`${sessionId}:`))
    await Promise.all(keys.map(async key => {
      const runtime = this.runtimes.get(key)
      this.runtimes.delete(key)
      await runtime?.close().catch(() => undefined)
    }))
  }

  /** Build one immutable native launch/capability surface for every lifecycle path. */
  private runtimeOptionsFor(
    sessionId: string,
    profile: AcpStubAgentConfig,
    cwd: string,
  ): ConstructorParameters<typeof AcpSessionRuntime>[0] {
    if (!this.subprocess.ok) throw new LlmError(this.subprocess.message, 'ACP_SPAWN_FAILURE')
    const processSeam = this.subprocess.seam
    // ACP client-capability operations are external side effects too.  Keep
    // their bounded, secret-free summaries in the existing sidecar so the
    // audit view can distinguish "handler was never entered" from a handler
    // that entered and then failed I/O.  The callbacks intentionally swallow
    // sidecar outages: a completed file/terminal operation is still a fact,
    // and an audit partition outage must not turn it into a false ACP failure.
    const appendFileAudit = this.sidecar === undefined
      ? undefined
      : async (event: AcpFileSystemAuditData): Promise<void> => {
        try { await this.sidecar!.append(sessionId as never, { kind: 'filesystem', data: event }) } catch { /* best effort after external I/O */ }
      }
    const appendTerminalAudit = this.sidecar === undefined
      ? undefined
      : async (event: AcpTerminalAuditData): Promise<void> => {
        try { await this.sidecar!.append(sessionId as never, { kind: 'terminal', data: event }) } catch { /* best effort after external process */ }
      }
    return {
      profileId: this.profileId,
      enableClaudeDraftSubagents: descriptorOf(this.profileId, profile)?.id === 'claude',
      ...(this.log === undefined ? {} : {
        onCapabilityDegraded: (message: string): void => {
          if (this.claudeDraftDegradationReported) return
          this.claudeDraftDegradationReported = true
          this.log?.(message)
        },
      }),
      config: profile,
      subprocess: processSeam,
      cwd,
      prepareLaunch: async (config, launchCwd): Promise<AcpRuntimeLaunch> => {
        const resolved = config as AcpStubAgentConfig
        const env = await acpLaunchEnvironment({ config: resolved })
        const plan = buildAcpSpawnPlan({ mode: 'danger-full-access', workspaceRoot: launchCwd, argv: [resolved.command, ...resolved.args], env })
        return { argv: plan.argv, env: plan.env, spawnPlan: plan }
      },
      createFileSystemHandlers: () => createAcpFileSystemHandlers({
        profileId: this.profileId,
        ...(appendFileAudit === undefined ? {} : { audit: appendFileAudit }),
      }),
      createTerminalHandlers: ({ cwd: launchCwd, env }) => createAcpTerminalHandlers({
        subprocess: processSeam,
        profileId: this.profileId,
        dshSessionId: sessionId,
        cwd: launchCwd,
        env,
        ...(appendTerminalAudit === undefined ? {} : { audit: appendTerminalAudit }),
      }),
      onPermissionRequest: async (params: acp.RequestPermissionRequest, signal?: AbortSignal): Promise<acp.RequestPermissionResponse> => {
        const binding = this.resolveQuestions?.(sessionId)
        if (binding === undefined) return { outcome: { outcome: 'cancelled' } }
        const audit: AcpPermissionAuditChannel | undefined = this.sidecar === undefined
          ? undefined
          : { append: record => this.sidecar!.append(sessionId as never, record) }
        return await createAcpNativePermissionHandler({
          ...(binding.userQuestions === undefined ? {} : { userQuestions: binding.userQuestions }),
          ...(binding.approval === undefined ? {} : { approval: binding.approval }),
          getAgent: binding.getAgent,
          ...(audit === undefined ? {} : { audit }),
        })(params, signal)
      },
      onElicitationRequest: async (params: acp.CreateElicitationRequest, signal?: AbortSignal): Promise<acp.CreateElicitationResponse> => {
        const binding = this.resolveQuestions?.(sessionId)
        if (binding?.userQuestions === undefined) return { action: 'cancel' }
        return await createAcpNativeElicitationHandler({ userQuestions: binding.userQuestions, getAgent: binding.getAgent })(params, signal)
      },
      onSessionUpdate: (): void => {
        // Keep the sidecar's last-known controls close to the ACP event. This
        // is a bounded write per protocol update (not a polling loop), so a
        // crash between turns still renders the most recently reported Agent
        // mode/context as stale instead of losing it entirely.
        const runtime = this.runtimeForSession(sessionId)
        if (runtime !== undefined) void this.persistRuntimeSnapshot(sessionId, runtime)
      },
    }
  }
}
