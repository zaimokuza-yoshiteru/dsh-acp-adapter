/** ACP profile as an ordinary DSH LLM provider route. */
/// <reference types="node" />

import { activityPresentation, type AcpActivityPresentation } from '../../domain/policy/activity-presentation.ts'
import { ACP_ACTIVITY_RAW_MAX, modeIntentBindingKey } from '../../persistence/sidecar.ts'
import { teamModeChoices } from '../../contract/session-modes.ts'
import { projectNativeAgentAccess } from './native-agent-access.ts'

import fs from 'node:fs'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  ToolSchema,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AcpStubAdapter, reasoningInfoFromConfigOptions } from './llm-stub.ts'
import type { AcpProbeCacheEntry } from './llm-stub.ts'
import type { AcpStubAgentConfig } from '../../domain/session/agent-config.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import {
  AcpSessionRefreshAbortedError,
  AcpSessionRefreshRetryError,
  AcpSessionRuntime,
} from '../../runtime/session/session-runtime.ts'
import type { AcpRuntimeContextUsage } from '../../runtime/session/session-runtime.ts'
import {
  acpLaunchEnvironment,
  acpLaunchFingerprint,
  acpLaunchFingerprintsCompatible,
  profileLaunchIdentityHash,
} from '../../domain/session/launch-fingerprint.ts'
import { prepareAgentLaunch } from './agent-launch.ts'
import { buildAcpSpawnPlan } from '../../domain/policy/sandbox.ts'
import { effectiveRuntimeOf } from '../../contract/agent-config.ts'
import { reasoningRequestIsCurrent, sessionProtocolExtensions } from '../../domain/session/agent-compatibility.ts'
import { DispatchLedger } from '../../runtime/session/dispatch-ledger.ts'
import { StreamHandoff } from './stream-handoff.ts'
import type { DispatchLedgerStore } from '../../runtime/session/dispatch-ledger.ts'
import { admitCurrentStep } from '../../domain/session/current-step-admission.ts'
import { AcpAdmissionError } from '../../domain/session/current-step-admission.ts'
import type { CurrentStepProof, SessionLike } from '../../domain/session/current-step-admission.ts'
import { ExternalDelegationNormalizer } from '../../domain/subagent/external-delegation.ts'
import {
  EXTERNAL_DELEGATION_PENDING_LIMIT,
  type ExternalDelegationLiveFact,
  type ExternalDelegationObservation,
} from '../../domain/subagent/external-delegation.ts'
import { acpCanonicalHash16 } from '../../persistence/sidecar.ts'
import { acpOptionsSnapshotOf } from '../../persistence/options-snapshot.ts'
import type {
  AcpActivityKind,
  AcpActivityStatus,
  AcpBindingData,
  AcpFileSystemAuditData,
  AcpRecoveryState,
  AcpSidecar,
} from '../../persistence/sidecar.ts'
import type { AcpSessionForkReason, AcpTerminalAuditData } from '../../domain/policy/events.ts'
import { isSensitiveActivityField, redactSecretText } from '../../domain/observability/redaction.ts'
import { hostSystemPrompt } from '../../domain/session/host-system-prompt.ts'
import { AcpPromptContentError, skillRouteForTools, toAcpPrompt } from '../../domain/session/prompt-content.ts'
import { createAcpFileSystemHandlers } from '../../runtime/client-capabilities/filesystem.ts'
import { createAcpTerminalHandlers } from '../../runtime/client-capabilities/terminal.ts'
import type { AcpTerminalJobStarter } from '../../runtime/client-capabilities/terminal-job.ts'
import { createAcpNativePermissionHandler, type AcpNativeApprovalService } from '../../domain/policy/permissions.ts'
import { createPermissionCheckAudit } from '../../domain/policy/events.ts'
import type { AcpPermissionAuditChannel } from '../../domain/policy/permissions.ts'
import { createAcpNativeElicitationHandler } from '../../domain/policy/elicitation.ts'
import type { AcpNativeUserQuestionService } from '../../domain/policy/elicitation.ts'
import { isAcpModelOrReasoningOption, normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import {
  assertHostExecutionQuiescent,
  clearHostExecutionOwners,
  clearSharedRecoveryFallback,
  getSharedRecoveryFallback,
  retainHostExecutionOwner,
  setSharedRecoveryFallback,
} from './host-execution-owners.ts'
import { AcpHostSettlementError } from '../../runtime/session/mcp-lease.ts'
import { AcpSteeringRequestError } from '../../protocol/v1/connection.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import { nonTextContentFallback } from '../../domain/session/assistant-content.ts'
import type { AcpNonTextContent } from '../../domain/session/assistant-content.ts'
import { AcpToolCallReducer } from './tool-call-reducer.ts'
import type { AcpToolCallPatch, AcpToolCallSnapshot } from './tool-call-reducer.ts'
import {
  AcpLocalSettlementError,
  localSettlementStatus as readLocalSettlementStatus,
  observeLocalSettlement,
  registerLocalSettlementSink,
  settleLocally,
  settlePendingLocally,
  waitForLocalSettlement,
} from './local-settlement.ts'
import type { AcpLocalSettlementStatus } from './local-settlement.ts'

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

export type AcpLocalSettlementViewStatus = AcpLocalSettlementStatus | 'finishing-tools'

interface BindingSettlementTarget {
  readonly profileId: string
  readonly agentSessionId: string
  readonly generation: number
  readonly bindingEpoch: number
  readonly basePromptOrdinal: number
  readonly targetPromptOrdinal: number
  readonly baseDshCommittedSeq: number
}

interface BindingSettlementCommit extends BindingSettlementTarget {
  readonly dshCommittedSeq: number
}

interface AcpLocalSettlementSink {
  settleDispatch(sessionId: string, key: string): Promise<void>
  readDispatch(sessionId: string, key: string): ReturnType<DispatchLedger['read']>
  writeRuntimeSnapshot(sessionId: string, snapshot: ReturnType<typeof acpOptionsSnapshotOf>): Promise<void>
  refreshBindingHead(
    sessionId: string,
    session: SessionLike | undefined,
    target: BindingSettlementCommit,
  ): Promise<AcpBindingData | undefined>
}

type AcpAttachmentStore = Pick<AttachmentStore, 'readImage' | 'imageLimits'> &
  Partial<Pick<AttachmentStore, 'saveImages'>>
interface AgentSessionModeView {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}
interface AgentSessionSelectValueView {
  readonly value: string
  readonly name: string
  readonly description?: string | null
}
interface AgentSessionSelectGroupView {
  readonly group: string
  readonly name: string
  readonly options: readonly AgentSessionSelectValueView[]
}
type AgentSessionConfigOptionView =
  | {
      readonly type: 'select'
      readonly id: string
      readonly name: string
      readonly description?: string | null
      readonly category?: string | null
      readonly currentValue: string
      readonly options: readonly (AgentSessionSelectValueView | AgentSessionSelectGroupView)[]
    }
  | {
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
  readonly modeWritable?: boolean
  readonly pendingModeId?: string | null
  readonly freshness: 'live' | 'stale'
  readonly editable: boolean
  readonly configOptions: readonly AgentSessionConfigOptionView[] | null
  readonly modes: readonly AgentSessionModeView[] | null
  readonly currentModeId: string | null
  readonly contextUsage: {
    readonly used: number
    readonly size: number
    readonly percent: number
    readonly cost: { readonly amount: number; readonly currency: string } | null
  } | null
  readonly note: string | null
}
type AgentSessionOptionWrite =
  | { readonly kind: 'config'; readonly id: string; readonly value: string | boolean }
  | { readonly kind: 'mode'; readonly id: string }

/** Prove the child seed ends at the parent's durable ACP binding head. */
function isLatestForkCut(
  session: SessionLike | undefined,
  parentSessionId: string,
  parentBinding: AcpBindingData,
): boolean {
  if (session === undefined || session.facts.inheritedRemaining !== 0) return false
  const payload = session.facts.forkReplay ?? undefined
  return (
    payload !== undefined &&
    payload.ownerDshSessionId === parentSessionId &&
    payload.profileId === parentBinding.profileId &&
    payload.profileGeneration === parentBinding.generation &&
    payload.agentSessionId === parentBinding.agentSessionId &&
    payload.bindingEpoch === parentBinding.bindingEpoch &&
    payload.launchFingerprint === acpCanonicalHash16(parentBinding.launchFingerprint) &&
    payload.committedPromptOrdinal === parentBinding.committedPromptOrdinal
  )
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

function finishReason(stopReason: string, locale?: string): FinishReason {
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  const isChinese = locale !== undefined && /^zh(?:[-_]|$)/i.test(locale)
  if (stopReason === 'refusal')
    return {
      kind: 'error',
      failure: {
        code: 'ACP_REFUSAL',
        message: isChinese ? 'ACP 智能体拒绝了此请求。' : 'The ACP agent declined to answer this request.',
      },
    }
  if (stopReason === 'max_turn_requests')
    return {
      kind: 'error',
      failure: {
        code: 'ACP_MAX_TURN_REQUESTS',
        message: isChinese ? 'ACP 智能体已达到本轮请求次数上限。' : 'The ACP agent reached its turn request limit.',
      },
    }
  if (stopReason === 'cancelled')
    return { kind: 'aborted', failure: { code: 'ACP_ABORTED', message: 'ACP prompt was cancelled' } }
  return { kind: 'stop' }
}

class SteeringFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly remoteRequestSent: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'SteeringFailure'
  }
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
      result[key] =
        redactSecretText(key).toLowerCase() !== key.toLowerCase() || isSensitiveActivityField(key, item)
          ? '[redacted]'
          : redactActivityValue(item, depth + 1)
    }
    return result
  }
  return value
}

function activityRawDetail(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(redactActivityValue(value))
  } catch {
    return '[activity detail unavailable]'
  }
}

function activityStatus(value: unknown, fallback: AcpActivityStatus = 'running'): AcpActivityStatus {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'unfinished') return 'unfinished'
  return fallback
}

function isTerminalActivityStatus(value: AcpActivityStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'unfinished'
}

interface NormalizedActivity {
  readonly display?: AcpActivityPresentation
  readonly activityId: string
  readonly kind: AcpActivityKind
  readonly status: AcpActivityStatus
  readonly presentation: string
  readonly rawDetail?: string
}

function normalizeActivityContent(
  parentId: string,
  content: unknown,
  status: AcpActivityStatus,
): NormalizedActivity | undefined {
  if (typeof content !== 'object' || content === null) return undefined
  const item = content as { type?: unknown; path?: unknown; terminalId?: unknown }
  if (item.type === 'diff') {
    const name = typeof item.path === 'string' ? path.basename(item.path) : 'file'
    const display = activityPresentation(content, 'diff')
    return {
      activityId: `${parentId}:diff`,
      kind: 'diff',
      status,
      presentation: `File change · ${name}`,
      rawDetail: activityRawDetail(content),
      ...(display === undefined ? {} : { display }),
    }
  }
  if (item.type === 'terminal')
    return {
      activityId: `${parentId}:terminal`,
      kind: 'terminal',
      status,
      presentation: 'Terminal activity',
      rawDetail: activityRawDetail(content),
    }
  if (item.type === 'resource' || item.type === 'resource_link' || item.type === 'image' || item.type === 'audio')
    return {
      activityId: `${parentId}:resource`,
      kind: 'resource',
      status,
      presentation: 'Agent resource',
      rawDetail: activityRawDetail(content),
    }
  return {
    activityId: `${parentId}:content`,
    kind: 'other',
    status,
    presentation: 'Tool output',
    rawDetail: activityRawDetail(content),
  }
}

function activitiesForNotification(
  notification: AcpSessionNotification,
  fallbackId: string,
  toolCall?: AcpToolCallSnapshot,
  externalDelegations: readonly ExternalDelegationLiveFact[] = [],
): readonly NormalizedActivity[] {
  const update = notification.update as unknown as Record<string, unknown>
  const type = update.sessionUpdate
  if (type === 'tool_call' || type === 'tool_call_update') {
    const toolId = toolCall?.callId ?? (typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId)
    const status = activityStatus(toolCall?.status ?? update.status)
    const title =
      typeof toolCall?.title === 'string' && toolCall.title.length > 0
        ? toolCall.title
        : typeof toolCall?.name === 'string' && toolCall.name.length > 0
          ? toolCall.name
          : 'Agent tool activity'
    const detail = toolCall ?? update
    const display = activityPresentation(
      { toolKind: detail.kind, rawInput: detail.rawInput, content: detail.content },
      'tool',
    )
    const result: NormalizedActivity[] = [
      {
        ...(display === undefined ? {} : { display }),
        activityId: `tool:${toolId}`,
        kind: 'tool',
        status,
        presentation: title,
        rawDetail: toolActivityRawDetail(
          {
            toolKind: detail.kind,
            toolName: detail.name,
            rawInput: detail.rawInput,
            rawOutput: detail.rawOutput,
            locations: detail.locations,
            content: detail.content,
          },
          externalDelegations,
        ),
      },
    ]
    if (Array.isArray(detail.content)) {
      for (const [index, content] of detail.content.entries()) {
        const normalized = normalizeActivityContent(`part:${toolId}:${String(index)}`, content, status)
        if (normalized !== undefined) result.push(normalized)
      }
    }
    return result
  }
  if (type === 'plan' || type === 'plan_update') {
    const entries = type === 'plan' && Array.isArray(update.entries) ? update.entries : undefined
    const plan = type === 'plan_update' ? update.plan : entries
    const planId =
      isPlainRecord(update._meta) && typeof update._meta.activityId === 'string' ? update._meta.activityId : 'session'
    const display = activityPresentation(plan, 'plan')
    const complete = display?.plan !== undefined && display.plan.every((entry) => entry.status === 'completed')
    return [
      {
        activityId: `plan:${planId}`,
        kind: 'plan',
        status: complete ? 'completed' : 'running',
        presentation: 'Agent plan',
        rawDetail: activityRawDetail(plan),
        ...(display === undefined ? {} : { display }),
      },
    ]
  }
  if (type === 'plan_removed') {
    const planId = typeof update.planId === 'string' ? update.planId : 'session'
    return [
      {
        activityId: `plan:${planId}`,
        kind: 'plan',
        status: 'completed',
        presentation: 'Agent plan',
        display: { plan: [] },
        rawDetail: activityRawDetail(update),
      },
    ]
  }
  if (type === 'delegated' || type === 'subagent')
    return [
      {
        activityId: `delegated:${typeof update.activityId === 'string' ? update.activityId : fallbackId}`,
        kind: 'delegated',
        status: activityStatus(update.status),
        presentation: 'Delegated Agent activity',
        rawDetail: activityRawDetail(update),
      },
    ]
  if (type === 'subagent_spawned')
    return [
      {
        activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
        kind: 'delegated',
        status: 'running',
        presentation: typeof update.name === 'string' && update.name.length > 0 ? update.name : 'Agent delegation',
        rawDetail: activityRawDetail({ task: update.task, capabilities: update.capabilities }),
      },
    ]
  if (type === 'subagent_state_update')
    return [
      {
        activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
        kind: 'delegated',
        status: update.state === 'completed' ? 'completed' : update.state === 'cancelled' ? 'cancelled' : 'failed',
        presentation: 'Agent delegation',
        rawDetail: activityRawDetail({ state: update.state }),
      },
    ]
  if (
    type === 'agent_message_chunk' ||
    type === 'agent_thought_chunk' ||
    type === 'user_message_chunk' ||
    type === 'config_option_update' ||
    type === 'current_mode_update' ||
    type === 'available_commands_update' ||
    type === 'usage_update' ||
    type === 'session_info_update'
  )
    return []
  return [
    {
      activityId: `other:${fallbackId}`,
      kind: 'other',
      status: 'completed',
      presentation: 'Agent activity',
      rawDetail: activityRawDetail(update),
    },
  ]
}

function withExternalDelegations(
  activity: NormalizedActivity,
  delegations: readonly ExternalDelegationLiveFact[],
): NormalizedActivity {
  if (activity.kind !== 'tool' || delegations.length === 0) return activity
  let detail: unknown = activity.rawDetail
  try {
    detail = JSON.parse(activity.rawDetail ?? 'null') as unknown
  } catch {
    /* Preserve the existing detail as a value if it was not valid JSON. */
  }
  const detailRecord = isPlainRecord(detail) ? detail : { toolDetail: detail }
  return {
    ...activity,
    rawDetail: toolActivityRawDetail(detailRecord, delegations),
  }
}

function toolActivityRawDetail(
  detail: Record<string, unknown>,
  delegations: readonly ExternalDelegationLiveFact[],
): string {
  if (delegations.length === 0) return activityRawDetail(detail)
  const externalDelegationDetails = compactExternalDelegationDetails(delegations)
  const rawDetail = activityRawDetail({ ...detail, externalDelegations: externalDelegationDetails })
  if (rawDetail.length <= ACP_ACTIVITY_RAW_MAX) return rawDetail
  const compact = (labelLimit: number, toolNameLimit: number, toolKindLimit: number): string =>
    activityRawDetail({
      ...(typeof detail.toolKind === 'string'
        ? { toolKind: boundedExternalPreview(detail.toolKind, toolKindLimit) }
        : {}),
      ...(typeof detail.toolName === 'string'
        ? { toolName: boundedExternalPreview(detail.toolName, toolNameLimit) }
        : {}),
      externalDelegations: compactExternalDelegationDetails(delegations, labelLimit),
      detailsOmitted: true,
    })
  for (const [labelLimit, toolNameLimit, toolKindLimit] of [
    [24, 96, 32],
    [8, 32, 16],
  ] as const) {
    const fallback = compact(labelLimit, toolNameLimit, toolKindLimit)
    if (fallback.length <= ACP_ACTIVITY_RAW_MAX) return fallback
  }
  // All bounded Agent-controlled strings can be omitted if escaping still made
  // the verbose fallback unexpectedly large; every child status remains.
  return activityRawDetail({
    externalDelegations: compactExternalDelegationDetails(delegations, 0),
    detailsOmitted: true,
  })
}

/** The row owns the exact source tool id, so its persisted child facts need only
 * the small fields the read-only presentation consumes. Keep Agent labels as
 * verbatim metadata until this display boundary, then cap them for both the
 * 16 KiB activity envelope and the native tool name. */
function compactExternalDelegationDetails(
  delegations: readonly ExternalDelegationLiveFact[],
  labelLimit = 96,
): readonly { readonly label: string; readonly status: ExternalDelegationLiveFact['status'] }[] {
  return delegations.map(({ label, status }) => ({
    label: boundedExternalPreview(label, labelLimit),
    status,
  }))
}

function boundedExternalPreview(value: string, maxCodePoints: number): string {
  const safe = redactSecretText(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return Array.from(safe, (point) =>
    point.length === 1 && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff ? '�' : point,
  )
    .slice(0, maxCodePoints)
    .join('')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotProfile(profile: AcpStubAgentConfig | undefined): AcpStubAgentConfig | undefined {
  return profile === undefined ? undefined : { ...profile, args: [...profile.args], env: { ...profile.env } }
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

interface HandoffOwner {
  stream: StreamHandoff
  generation: ProfileGeneration | undefined
  options: GenerateOptions
  off?: () => void
}

export interface AcpProfileRuntime {
  /** Negotiate capabilities without creating session/new. */
  initialize?(signal?: AbortSignal): Promise<void>
  start(signal?: AbortSignal): Promise<void>
  /** Fork a parent ACP session; absent means the Agent cannot fork. */
  fork?(
    parentSessionId: string,
    signal?: AbortSignal,
    expected?: { readonly agent?: AcpBindingData['agent']; readonly protocolVersion?: number },
    beforeDispatch?: () => Promise<void>,
  ): Promise<acp.ForkSessionResponse>
  /** Restore an existing binding; absent implementations fail closed. */
  restore?(
    binding: Pick<AcpBindingData, 'agentSessionId'>,
    signal?: AbortSignal,
    onReplay?: (notification: AcpSessionNotification) => void,
  ): Promise<'reused' | 'resumed' | 'loaded'>
  /** Retire a cancelled vendor process after its response and local settlement complete. */
  retireCancelledSession?(): Promise<void>
  readonly acpSessionId?: string | undefined
  readonly agentInfo?: acp.Implementation | null | undefined
  readonly agentCapabilities?: acp.AgentCapabilities | undefined
  readonly protocolVersion?: number | undefined
  /** Latest ACP session-scoped configuration; presence means this runtime supports M6 config convergence. */
  readonly configOptions?: readonly acp.SessionConfigOption[] | undefined
  readonly currentModeId?: string | undefined
  readonly modes?: acp.SessionModeState | undefined
  readonly contextUsage?: AcpRuntimeContextUsage | undefined
  readonly lastRestoreRefreshedCancelledSession?: boolean | undefined
  readonly cancelledSessionRefreshPending?: boolean | undefined
  readonly cancelledSessionRefreshBindingId?: string | undefined
  readonly isBusy?: boolean
  hasPendingHostCalls?(): boolean
  hasUncommittedHostFeedback?(): boolean
  hasRetainedHostFeedback?(): boolean
  waitForHostCallsSettled?(): Promise<void>
  readonly hostSettlementPending?: boolean
  flushHostFeedback?(): Promise<void>
  readonly canSteer?: boolean
  /**
   * Implementations that send steering must call `onDispatch` immediately
   * before the RPC request is handed to the transport. Returning `injected`
   * without calling it is treated as acceptance-unknown; a response-time call
   * is too late to project intervening notifications safely.
   */
  steer?(content: acp.ContentBlock[], onDispatch?: () => void): Promise<'injected' | 'promptRequired'>
  /** ACP session-scoped writes. Implementations must confirm the resulting snapshot. */
  setConfigOption?(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void>
  setMode?(modeId: string, signal?: AbortSignal): Promise<void>
  prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: AcpSessionNotification) => void,
    signal?: AbortSignal,
    onTeamReport?: () => void,
    onTurnConcluded?: () => void,
    onSuccessfulToolResult?: () => void,
  ): Promise<acp.PromptResponse>
  close(): Promise<void>
}

/** Host-owned DSH user-question seam resolved for the current DSH session. */
export interface AcpNativeQuestionBinding {
  readonly userQuestions?: AcpNativeUserQuestionService
  readonly approval?: AcpNativeApprovalService
  readonly getAgent: () => unknown
  readonly locale?: string
}

interface UserModeChoice {
  readonly kind: 'legacy' | 'config'
  readonly id: string
  readonly value?: string | boolean
}

interface ConfirmedUserModeSelection extends UserModeChoice {
  readonly bindingKey: string
  readonly agentSessionId: string
  readonly owner: object
  readonly needsRestore: boolean
}

/** One independent adapter and runtime per configured ACP profile. */
export class AcpProfileAdapter extends LlmAdapter {
  private probeGeneration: ProfileGeneration | undefined
  private readonly runtimes = new Map<string, AcpProfileRuntime>()
  private readonly runtimeOwners = new WeakMap<AcpProfileRuntime, object>()
  private readonly nextGenerations = new Map<string, number>()
  private readonly admittedToolSchemas = new Map<string, readonly ToolSchema[] | undefined>()
  private readonly admittedToolSchemaOwners = new Map<string, object>()
  /** Explicit user choices survive a same-process CodeBuddy cancel/reload only. */
  private readonly confirmedUserModes = new Map<string, ConfirmedUserModeSelection>()
  private claudeDraftDegradationReported = false
  private readonly ledger: DispatchLedger
  private readonly settlementSink: AcpLocalSettlementSink
  private settlementOwnerDisposer: (() => Promise<void>) | undefined
  private readonly settlementCloseController = new AbortController()
  private readonly settlementSessionWaitControllers = new Map<
    string,
    Set<{ readonly owner: object | undefined; readonly controller: AbortController }>
  >()
  private readonly handoffs = new Map<string, HandoffOwner>()
  private readonly inMemoryRecoveryRequired = new Map<string, number>()
  private readonly inMemoryRecoveryStates = new Map<string, AcpRecoveryState>()
  private readonly sessionControlWrites = new Map<string, Promise<void>>()

  constructor(
    readonly profileId: string,
    private readonly readConfig: () => AcpStubAgentConfig | undefined,
    private readonly subprocess: SubprocessSeamResolution,
    private readonly sessionOf: (sessionId: string) => SessionLike | undefined = () => undefined,
    ledgerStore: DispatchLedgerStore,
    private readonly probeFactory: (config: AcpStubAgentConfig) => ProfileGeneration['probe'] = (config) =>
      createNativeProfileProbe(profileId, subprocess, config),
    private readonly runtimeFactory: (
      options: ConstructorParameters<typeof AcpSessionRuntime>[0],
    ) => AcpProfileRuntime = (options) => new AcpSessionRuntime(options),
    private readonly sidecar?: AcpSidecar,
    private readonly attachments?: AcpAttachmentStore,
    private readonly resolveQuestions?: (dshSessionId: string) => AcpNativeQuestionBinding | undefined,
    private readonly projectExternalDelegation?: (
      observation: ExternalDelegationObservation,
      context: {
        readonly profileId: string
        readonly bindingGeneration: number
        readonly rootAcpSessionId: string
        readonly parentDshSessionId: string
        readonly parentCwd: string
        readonly parentDelegationDepth?: number
      },
    ) => Promise<string | undefined>,
    private readonly log?: (message: string) => void,
    private readonly terminalJobs?: (sessionId: string) => AcpTerminalJobStarter | undefined,
    private readonly createMcpLease?: (
      sessionId: string,
      capabilities: acp.AgentCapabilities | undefined,
      wireProfile?: string,
      schemas?: readonly ToolSchema[],
    ) => Promise<import('../../runtime/session/mcp-lease.ts').AcpMcpLease | undefined>,
    private readonly mcpKey?: (sessionId: string, schemas?: readonly ToolSchema[]) => unknown,
    private readonly controlsChanged?: (sessionId: string) => void,
    private readonly hostRoot?: Context,
  ) {
    super()
    this.ledger = new DispatchLedger(ledgerStore)
    this.settlementSink = this.localSettlementSink()
    this.settlementOwnerDisposer = registerLocalSettlementSink(
      this.hostRoot ?? this,
      this.profileId,
      this,
      this.settlementSink,
    )
    this.probeGeneration = this.generationOfSnapshot(snapshotProfile(readConfig()))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `${this.readConfig()?.name ?? this.profileId} · ACP` }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const generation = this.currentProbeGeneration()
    if (generation === undefined) return []
    // Preserve provider-local failures for the native catalog's error row.
    // An empty success hides the route and can remain cached after recovery.
    return await generation.probe.listModels(provider)
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
    if (generation === undefined)
      throw new LlmError(`ACP profile "${this.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
    const models = await generation.probe.listModels(provider)
    const found = models.find((entry) => entry.id === model)
    const reasoning = reasoningInfoFromConfigOptions(
      this.profileId,
      generation.config,
      generation.probe.configOptionsForModel?.(provider, model) ?? generation.probe.configOptions?.(provider),
    )
    return found === undefined
      ? { provider, id: model, name: model, ...(reasoning === undefined ? {} : { reasoning }) }
      : { ...found, ...(reasoning === undefined ? {} : { reasoning }) }
  }

  /** Capture the current profile generation before model dispatch. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const generation = this.generationOf(snapshotProfile(this.readConfig()))
    if (generation === undefined)
      throw new LlmError(`ACP profile "${this.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
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

  private async resolveModelForGeneration(
    provider: string,
    model: string,
    generation: ProfileGeneration,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const models = await generation.probe.listModels(provider)
    if (signal?.aborted) signal.throwIfAborted()
    const found = models.find((entry) => entry.id === model)
    const reasoning = reasoningInfoFromConfigOptions(
      this.profileId,
      generation.config,
      generation.probe.configOptionsForModel?.(provider, model) ?? generation.probe.configOptions?.(provider),
    )
    return found === undefined
      ? { provider, id: model, name: model, ...(reasoning === undefined ? {} : { reasoning }) }
      : { ...found, ...(reasoning === undefined ? {} : { reasoning }) }
  }

  /** Narrow session-scoped control/read surface for the additive Agent dock. */
  async agentSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshotView> {
    await this.waitForSessionControlWrite(sessionId)
    return await this.readAgentSessionSnapshotView(sessionId)
  }

  private async readAgentSessionSnapshotView(sessionId: string): Promise<AgentSessionSnapshotView> {
    const snapshot = await this.readAgentSessionSnapshot(sessionId)
    const binding = await this.sidecar?.readLatestBinding(sessionId as never)
    const intent = await this.sidecar?.readModeIntent(sessionId as never)
    const profile = this.readConfig()
    const recovery =
      this.recoveryStateFallback(sessionId) ?? (await this.sidecar?.readRecoveryState(sessionId as never))
    const compatible =
      binding?.status === 'ok' &&
      binding.binding.provider === `acp-${this.profileId}` &&
      profile !== undefined &&
      acpLaunchFingerprintsCompatible(binding.binding.launchFingerprint, await this.launchFingerprint(profile)) &&
      (recovery === undefined || recovery.kind === 'healthy')
    const pending = compatible && intent?.bindingKey === modeIntentBindingKey(binding.binding) ? intent.modeId : null
    return {
      ...snapshot,
      modeWritable: compatible && (snapshot.freshness === 'stale' || snapshot.editable),
      pendingModeId:
        pending !== null &&
        !teamModeChoices(snapshot).some(
          (choice) => choice.id === pending && choice.current && snapshot.freshness === 'live',
        )
          ? pending
          : null,
    }
  }

  /** In-memory fail-closed fallback exposed through the existing recovery snapshot seam. */
  recoveryStateFallback(sessionId: string): AcpRecoveryState | undefined {
    const shared = this.hostRoot === undefined ? undefined : getSharedRecoveryFallback(this.hostRoot, sessionId)
    if (shared !== undefined) return shared
    const retained = this.inMemoryRecoveryStates.get(sessionId)
    if (retained !== undefined) return retained
    const updatedAt = this.inMemoryRecoveryRequired.get(sessionId)
    if (updatedAt === undefined) return undefined
    return {
      dshSessionId: sessionId,
      kind: 'outcome-unknown',
      cause: 'load-failed',
      detail: 'ACP steering acceptance could not be confirmed; inspect the Agent session before retrying',
      updatedAt,
    }
  }

  /** Read-only UI state for local writes after a confirmed remote terminal. */
  localSettlementStatus(sessionId: string): AcpLocalSettlementViewStatus | undefined {
    const root = this.hostRoot ?? this
    observeLocalSettlement(root, sessionId, this, () => this.controlsChanged?.(sessionId))
    const localStatus = readLocalSettlementStatus(root, sessionId)
    if (localStatus !== undefined) return localStatus
    const runtime = this.runtimeForSession(sessionId)
    if (runtime?.hostSettlementPending === true) return 'finishing-tools'
    return undefined
  }

  /** Mode changes for dormant members are durable settings; they never create a session or send a prompt. */
  async setTeamMemberMode(sessionId: string, modeId: string): Promise<AgentSessionSnapshotView> {
    if (this.sidecar === undefined)
      throw new LlmError('This member mode cannot be changed', 'ACP_SESSION_OPTIONS_READ_ONLY')
    await this.serializeSessionControlWrite(sessionId, async () => {
      const current = await this.readAgentSessionSnapshotView(sessionId)
      const currentChoice = teamModeChoices(current).find((candidate) => candidate.id === modeId)
      if (!current.modeWritable || currentChoice === undefined)
        throw new LlmError('This member mode cannot be changed', 'ACP_SESSION_OPTIONS_READ_ONLY')
      if (this.handoffs.has(sessionId))
        throw new LlmError('Member started running; retry after it settles', 'ACP_SESSION_OPTIONS_READ_ONLY')
      const binding = await this.sidecar!.readLatestBinding(sessionId as never)
      if (binding?.status !== 'ok' || binding.binding.provider !== `acp-${this.profileId}`)
        throw new LlmError('The original ACP binding is unavailable', 'ACP_BINDING_UNAVAILABLE')
      const currentRuntime = this.runtimeForSession(sessionId)
      if (currentRuntime?.isBusy || (current.freshness === 'stale' && currentRuntime !== undefined))
        throw new LlmError('Member started running; retry after it settles', 'ACP_SESSION_OPTIONS_READ_ONLY')
      const intent = { bindingKey: modeIntentBindingKey(binding.binding), modeId }
      // Save before contacting the Agent: a disconnected write remains visible and is retried before the next prompt.
      await this.sidecar!.writeModeIntent(sessionId as never, intent)
      try {
        if (current.freshness === 'live' && currentRuntime && !currentRuntime.isBusy) {
          await this.restoreCancelledRuntimeForControl(sessionId, currentRuntime)
          if (this.runtimeForSession(sessionId) !== currentRuntime || Boolean(currentRuntime.isBusy))
            throw new LlmError('Member started running; retry after it settles', 'ACP_SESSION_OPTIONS_READ_ONLY')
          await this.applyMemberMode(sessionId, currentRuntime)
        }
      } finally {
        this.controlsChanged?.(sessionId)
      }
    })
    return await this.agentSessionSnapshot(sessionId)
  }

  private async applyMemberMode(sessionId: string, runtime: AcpProfileRuntime): Promise<void> {
    const intent = await this.sidecar?.readModeIntent(sessionId as never)
    if (intent === undefined) return
    const binding = await this.sidecar?.readLatestBinding(sessionId as never)
    if (binding?.status !== 'ok' || intent.bindingKey !== modeIntentBindingKey(binding.binding)) {
      await this.sidecar?.clearModeIntent(sessionId as never, intent)
      return
    }
    const choice = teamModeChoices(this.liveAgentSessionSnapshot(sessionId, runtime)).find(
      (choice) => choice.id === intent.modeId,
    )
    if (choice === undefined)
      throw new LlmError(
        'The saved member mode is no longer supported; choose another mode before continuing',
        'ACP_CONFIG_UNSUPPORTED',
      )
    if (!choice.current) {
      if (choice.write.kind === 'mode') {
        if (!runtime.setMode) throw new LlmError('Agent mode control is unavailable', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setMode(choice.write.id)
      } else {
        if (!runtime.setConfigOption) throw new LlmError('Agent mode control is unavailable', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setConfigOption(choice.write.id, choice.write.value)
      }
      if (
        !teamModeChoices(this.liveAgentSessionSnapshot(sessionId, runtime)).some(
          (choice) => choice.id === intent.modeId && choice.current,
        )
      )
        throw new LlmError('Agent did not confirm the saved member mode', 'ACP_CONFIG_SYNC_FAILED')
    }
    await this.persistRuntimeSnapshot(sessionId, runtime)
    this.rememberConfirmedUserMode(
      sessionId,
      runtime,
      choice.write.kind === 'mode'
        ? { kind: 'legacy', id: choice.write.id }
        : { kind: 'config', id: choice.write.id, value: choice.write.value },
      binding.binding,
    )
    // Consume only the confirmed choice. A later user selection must survive this completion.
    await this.sidecar?.clearModeIntent(sessionId as never, intent)
    this.controlsChanged?.(sessionId)
  }

  private async readAgentSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshotView> {
    const runtime = this.runtimeForSession(sessionId)
    if (runtime !== undefined) return this.liveAgentSessionSnapshot(sessionId, runtime)
    if (this.sidecar === undefined) throw new LlmError('ACP sidecar is unavailable', 'ACP_BINDING_UNAVAILABLE')
    const lookup = await this.sidecar.readLatestBinding(sessionId as never)
    if (lookup?.status !== 'ok')
      throw new LlmError('No established ACP Agent session is available', 'ACP_SESSION_UNAVAILABLE')
    const snapshot = await this.sidecar.readOptionSnapshot(sessionId as never)
    if (snapshot === undefined)
      throw new LlmError('No last-known Agent session controls are available', 'ACP_SESSION_OPTIONS_UNAVAILABLE')
    const configOptions = snapshot.options.map((option) =>
      typeof option.value === 'boolean'
        ? {
            type: 'boolean' as const,
            id: option.id,
            name: option.name,
            ...(option.category === null ? {} : { category: option.category }),
            currentValue: option.value,
          }
        : {
            type: 'select' as const,
            id: option.id,
            name: option.name,
            ...(option.category === null ? {} : { category: option.category }),
            currentValue: option.value,
            options: (option.values ?? []).map((value) => ({
              value,
              name:
                (normalizeAcpConfigOptionKey(option.id) === 'mode' ||
                normalizeAcpConfigOptionKey(option.category ?? '') === 'mode'
                  ? snapshot.modes?.availableModes.find((mode) => mode.id === value)?.name
                  : undefined) ?? value,
            })),
          },
    )
    return {
      sessionId,
      profileId: this.profileId,
      freshness: 'stale',
      editable: false,
      configOptions,
      modes: snapshot.modes?.availableModes ?? null,
      currentModeId: snapshot.currentModeId,
      contextUsage:
        snapshot.contextUsage === undefined || snapshot.contextUsage === null
          ? null
          : {
              used: snapshot.contextUsage.used,
              size: snapshot.contextUsage.size,
              percent:
                snapshot.contextUsage.size > 0
                  ? Math.round((snapshot.contextUsage.used / snapshot.contextUsage.size) * 1000) / 10
                  : 0,
              cost: snapshot.contextUsage.cost ?? null,
            },
      note: 'Last known Agent session state; controls are read-only until the Agent reconnects.',
    }
  }

  async setAgentSessionOption(sessionId: string, request: AgentSessionOptionWrite): Promise<AgentSessionSnapshotView> {
    return await this.serializeSessionControlWrite(sessionId, async () => {
      const runtime = this.runtimeForSession(sessionId)
      if (runtime === undefined || runtime.isBusy === true || this.handoffs.has(sessionId))
        throw new LlmError('Agent session is not live or is currently running', 'ACP_SESSION_OPTIONS_READ_ONLY')
      await this.restoreCancelledRuntimeForControl(sessionId, runtime)
      if (this.runtimeForSession(sessionId) !== runtime || Boolean(runtime.isBusy))
        throw new LlmError(
          'Agent session changed or started running; retry after it settles',
          'ACP_SESSION_OPTIONS_READ_ONLY',
        )
      const selectionBeforeWrite = this.modeSelectionForRequest(runtime, request)
      const selectionBindingBefore =
        selectionBeforeWrite === undefined ? undefined : await this.readBindingForUserMode(sessionId)
      if (selectionBeforeWrite !== undefined && selectionBindingBefore === undefined)
        throw new LlmError('The ACP session binding is unavailable for this mode change', 'ACP_BINDING_UNAVAILABLE')
      if (request.kind === 'mode') {
        if (runtime.setMode === undefined)
          throw new LlmError('This Agent does not expose mode controls', 'ACP_CONFIG_UNSUPPORTED')
        if (runtime.modes === undefined || !runtime.modes.availableModes.some((mode) => mode.id === request.id))
          throw new LlmError(`Agent mode "${request.id}" is not available`, 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setMode(request.id)
      } else {
        const option = runtime.configOptions?.find((candidate) => candidate.id === request.id)
        if (option === undefined || isAcpModelOrReasoningOption(option)) {
          throw new LlmError(
            'Model and reasoning controls are managed by the DSH model picker',
            'ACP_CONFIG_UNSUPPORTED',
          )
        }
        if (
          option.type === 'select' &&
          (typeof request.value !== 'string' || !this.selectValues(option).has(request.value))
        )
          throw new LlmError(`Agent option "${request.id}" does not allow that value`, 'ACP_CONFIG_UNSUPPORTED')
        if (option.type === 'boolean' && typeof request.value !== 'boolean')
          throw new LlmError(`Agent option "${request.id}" expects a boolean`, 'ACP_CONFIG_UNSUPPORTED')
        if (runtime.setConfigOption === undefined)
          throw new LlmError('This Agent does not expose session controls', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setConfigOption(request.id, request.value)
      }
      if (
        request.kind === 'mode' ||
        runtime.configOptions?.some(
          (option) =>
            option.id === request.id &&
            (normalizeAcpConfigOptionKey(option.id) === 'mode' ||
              normalizeAcpConfigOptionKey(option.category ?? '') === 'mode'),
        )
      ) {
        const intent = await this.sidecar?.readModeIntent(sessionId as never)
        if (intent !== undefined) await this.sidecar?.clearModeIntent(sessionId as never, intent)
      }
      await this.persistRuntimeSnapshot(sessionId, runtime)
      if (selectionBeforeWrite !== undefined) {
        if (!this.confirmedModeSelection(runtime, selectionBeforeWrite))
          throw new LlmError('Agent did not confirm the selected mode', 'ACP_CONFIG_SYNC_FAILED')
        const bindingAfter = await this.readBindingForUserMode(sessionId)
        if (
          bindingAfter === undefined ||
          modeIntentBindingKey(bindingAfter) !== modeIntentBindingKey(selectionBindingBefore!)
        )
          throw new LlmError('The ACP session binding changed while saving its mode', 'ACP_BINDING_UNAVAILABLE')
        this.rememberConfirmedUserMode(sessionId, runtime, selectionBeforeWrite, bindingAfter)
      }
      return this.liveAgentSessionSnapshot(sessionId, runtime)
    })
  }

  private modeSelectionForRequest(
    runtime: AcpProfileRuntime,
    request: AgentSessionOptionWrite,
  ): UserModeChoice | undefined {
    if (request.kind === 'mode') return { kind: 'legacy', id: request.id }
    const option = runtime.configOptions?.find((candidate) => candidate.id === request.id)
    if (
      option === undefined ||
      (normalizeAcpConfigOptionKey(option.id) !== 'mode' &&
        normalizeAcpConfigOptionKey(option.category ?? '') !== 'mode')
    )
      return undefined
    if (typeof request.value !== 'string') return undefined
    return { kind: 'config', id: request.id, value: request.value }
  }

  private async readBindingForUserMode(sessionId: string): Promise<AcpBindingData | undefined> {
    const lookup = await this.sidecar?.readLatestBinding(sessionId as never)
    if (
      lookup?.status !== 'ok' ||
      lookup.binding.provider !== `acp-${this.profileId}` ||
      lookup.binding.profileId !== this.profileId
    )
      return undefined
    return lookup.binding
  }

  private rememberConfirmedUserMode(
    sessionId: string,
    runtime: AcpProfileRuntime,
    selection: UserModeChoice,
    binding: AcpBindingData,
  ): void {
    const owner = this.runtimeOwners.get(runtime)
    if (owner === undefined) {
      this.confirmedUserModes.delete(sessionId)
      return
    }
    this.confirmedUserModes.set(sessionId, {
      ...selection,
      bindingKey: modeIntentBindingKey(binding),
      agentSessionId: binding.agentSessionId,
      owner,
      needsRestore: false,
    })
  }

  private markConfirmedUserModeForRestore(sessionId: string, runtime: AcpProfileRuntime): void {
    if (runtime.cancelledSessionRefreshPending !== true) return
    const selection = this.confirmedUserModes.get(sessionId)
    if (
      selection === undefined ||
      selection.agentSessionId !== runtime.cancelledSessionRefreshBindingId ||
      selection.owner !== this.runtimeOwners.get(runtime)
    )
      return
    // A vendor may change modes while handling the turn. Preserve only the
    // last mode the user explicitly selected; never overwrite a newer Agent
    // mode update with that older choice after the cancelled session reloads.
    if (!this.confirmedModeSelection(runtime, selection)) {
      this.confirmedUserModes.delete(sessionId)
      return
    }
    this.confirmedUserModes.set(sessionId, { ...selection, needsRestore: true })
  }

  private confirmedModeSelection(runtime: AcpProfileRuntime, selection: UserModeChoice): boolean {
    if (selection.kind === 'legacy') return (runtime.currentModeId ?? runtime.modes?.currentModeId) === selection.id
    return (
      runtime.configOptions?.some((option) => option.id === selection.id && option.currentValue === selection.value) ===
      true
    )
  }

  private async restoreConfirmedUserMode(
    sessionId: string,
    runtime: AcpProfileRuntime,
    binding: AcpBindingData,
  ): Promise<boolean> {
    const selection = this.confirmedUserModes.get(sessionId)
    if (selection === undefined) return true
    if (
      selection.bindingKey !== modeIntentBindingKey(binding) ||
      selection.agentSessionId !== binding.agentSessionId ||
      selection.owner !== this.runtimeOwners.get(runtime)
    ) {
      this.confirmedUserModes.delete(sessionId)
      return true
    }
    if (!selection.needsRestore) return true
    if (selection.kind === 'legacy') {
      if (!runtime.modes?.availableModes.some((mode) => mode.id === selection.id)) return false
      if ((runtime.currentModeId ?? runtime.modes.currentModeId) !== selection.id) {
        if (runtime.setMode === undefined) return false
        await runtime.setMode(selection.id)
      }
    } else {
      const option = runtime.configOptions?.find((candidate) => candidate.id === selection.id)
      if (option === undefined || option.type !== 'select' || !this.selectValues(option).has(String(selection.value)))
        return false
      if (option.currentValue !== selection.value) {
        if (runtime.setConfigOption === undefined) return false
        await runtime.setConfigOption(selection.id, selection.value!)
      }
    }
    if (!this.confirmedModeSelection(runtime, selection)) return false
    this.confirmedUserModes.set(sessionId, { ...selection, needsRestore: false })
    return true
  }

  private async restoreCancelledRuntimeForControl(sessionId: string, runtime: AcpProfileRuntime): Promise<void> {
    if (runtime.cancelledSessionRefreshPending !== true) return
    if (runtime.restore === undefined || this.sidecar === undefined)
      throw new LlmError(
        'The cancelled ACP session cannot be restored for this control change',
        'ACP_BINDING_UNAVAILABLE',
      )
    const lookup = await this.sidecar.readLatestBinding(sessionId as never)
    const profile = this.readConfig()
    if (
      lookup?.status !== 'ok' ||
      lookup.binding.provider !== `acp-${this.profileId}` ||
      lookup.binding.profileId !== this.profileId ||
      lookup.binding.agentSessionId !== runtime.cancelledSessionRefreshBindingId ||
      profile === undefined ||
      !acpLaunchFingerprintsCompatible(lookup.binding.launchFingerprint, await this.launchFingerprint(profile))
    )
      throw new LlmError(
        'The original ACP session binding is unavailable for this control change',
        'ACP_BINDING_UNAVAILABLE',
      )
    const binding = lookup.binding
    const recovery = this.recoveryStateFallback(sessionId) ?? (await this.sidecar.readRecoveryState(sessionId as never))
    if (recovery !== undefined && recovery.kind !== 'healthy')
      throw new LlmError(
        'The ACP session must be recovered before its controls can be changed',
        'ACP_RECOVERY_REQUIRED',
      )
    const session = this.sessionOf(sessionId)
    const expectedOwner = session?.identity ?? session
    if (expectedOwner !== undefined && this.runtimeOwners.get(runtime) !== expectedOwner)
      throw new LlmError(
        'The ACP session owner changed before its controls could be restored',
        'ACP_BINDING_UNAVAILABLE',
      )
    await runtime.restore({ agentSessionId: binding.agentSessionId })
    const latest = await this.sidecar.readLatestBinding(sessionId as never)
    const latestRecovery =
      this.recoveryStateFallback(sessionId) ?? (await this.sidecar.readRecoveryState(sessionId as never))
    if (
      this.runtimeForSession(sessionId) !== runtime ||
      runtime.isBusy === true ||
      (expectedOwner !== undefined && this.runtimeOwners.get(runtime) !== expectedOwner) ||
      (latestRecovery !== undefined && latestRecovery.kind !== 'healthy') ||
      latest?.status !== 'ok' ||
      latest.binding.provider !== binding.provider ||
      latest.binding.agentSessionId !== binding.agentSessionId ||
      latest.binding.generation !== binding.generation ||
      latest.binding.bindingEpoch !== binding.bindingEpoch
    )
      throw new LlmError('The ACP session changed while restoring its controls', 'ACP_SESSION_OPTIONS_READ_ONLY')
  }

  private async serializeSessionControlWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionControlWrites.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.sessionControlWrites.set(sessionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.sessionControlWrites.get(sessionId) === tail) this.sessionControlWrites.delete(sessionId)
    }
  }

  private async waitForSessionControlWrite(sessionId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.sessionControlWrites.get(sessionId)
    if (pending === undefined) return
    if (signal?.aborted === true) signal.throwIfAborted()
    if (signal === undefined) return await pending
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      signal.throwIfAborted()
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private runtimeForSession(sessionId: string): AcpProfileRuntime | undefined {
    for (const [key, runtime] of this.runtimes) if (key.startsWith(`${sessionId}:`)) return runtime
    return undefined
  }

  private liveAgentSessionSnapshot(sessionId: string, runtime: AcpProfileRuntime): AgentSessionSnapshotView {
    const options =
      runtime.configOptions === undefined
        ? null
        : runtime.configOptions.map((option) => {
            if (option.type === 'boolean')
              return {
                type: 'boolean' as const,
                id: option.id,
                name: option.name,
                ...(option.description === undefined ? {} : { description: option.description }),
                ...(option.category === undefined ? {} : { category: option.category }),
                currentValue: option.currentValue,
              }
            return {
              type: 'select' as const,
              id: option.id,
              name: option.name,
              ...(option.description === undefined ? {} : { description: option.description }),
              ...(option.category === undefined ? {} : { category: option.category }),
              currentValue: option.currentValue,
              options: option.options.map((entry) =>
                'options' in entry
                  ? {
                      group: entry.group,
                      name: entry.name,
                      options: entry.options.map((value) => ({
                        value: value.value,
                        name: value.name,
                        ...(value.description === undefined ? {} : { description: value.description }),
                      })),
                    }
                  : {
                      value: entry.value,
                      name: entry.name,
                      ...(entry.description === undefined ? {} : { description: entry.description }),
                    },
              ),
            }
          })
    const modes: readonly AgentSessionModeView[] | null =
      runtime.modes?.availableModes?.map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(mode.description === undefined ? {} : { description: mode.description }),
      })) ?? null
    const usage = runtime.contextUsage
    return {
      sessionId,
      profileId: this.profileId,
      freshness: 'live',
      editable: runtime.isBusy !== true,
      configOptions: options,
      modes,
      currentModeId: runtime.currentModeId ?? runtime.modes?.currentModeId ?? null,
      contextUsage:
        usage === undefined
          ? null
          : {
              used: usage.used,
              size: usage.size,
              percent: usage.size > 0 ? Math.round((usage.used / usage.size) * 1000) / 10 : 0,
              cost: usage.cost === undefined ? null : usage.cost,
            },
      note: null,
    }
  }

  private async persistRuntimeSnapshot(sessionId: string, runtime: AcpProfileRuntime, strict = false): Promise<void> {
    if (this.runtimeForSession(sessionId) !== runtime) {
      if (strict) throw new Error('ACP runtime changed before its terminal snapshot could be persisted')
      return
    }
    if (!strict) this.controlsChanged?.(sessionId)
    if (this.sidecar === undefined) {
      if (strict) throw new Error('ACP sidecar is unavailable for terminal snapshot persistence')
      return
    }
    try {
      const profile = snapshotProfile(this.readConfig())
      if (profile === undefined) {
        if (strict) throw new Error('ACP profile is unavailable for terminal snapshot persistence')
        return
      }
      await this.sidecar.writeOptionSnapshot(
        sessionId as never,
        acpOptionsSnapshotOf(
          runtime.configOptions,
          runtime.currentModeId,
          profileLaunchIdentityHash(this.profileId, profile),
          Date.now(),
          {
            contextUsage: runtime.contextUsage === undefined ? null : runtime.contextUsage,
            modes:
              runtime.modes === undefined
                ? null
                : {
                    currentModeId: runtime.modes.currentModeId,
                    availableModes: runtime.modes.availableModes.map((mode) => ({
                      id: mode.id,
                      name: mode.name,
                      ...(mode.description === undefined ? {} : { description: mode.description }),
                    })),
                  },
          },
        ),
      )
    } catch (error) {
      if (strict) throw error
      /* last-known presentation is best effort */
    }
  }

  /** Flatten ACP select values without assuming whether the agent groups them. */
  private selectValues(option: acp.SessionConfigOption | undefined): Set<string> {
    if (option?.type !== 'select') return new Set()
    return new Set(
      option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry])).map((entry) => entry.value),
    )
  }

  private findSelectOption(
    options: readonly acp.SessionConfigOption[],
    kind: 'model' | 'reasoning',
  ): Extract<acp.SessionConfigOption, { type: 'select' }> | undefined {
    return options.find((option): option is Extract<acp.SessionConfigOption, { type: 'select' }> => {
      if (option.type !== 'select') return false
      if (kind === 'model')
        return (
          normalizeAcpConfigOptionKey(option.category ?? '') === 'model' ||
          normalizeAcpConfigOptionKey(option.id) === 'model'
        )
      const id = normalizeAcpConfigOptionKey(option.id)
      return (
        normalizeAcpConfigOptionKey(option.category ?? '') === 'thought_level' ||
        normalizeAcpConfigOptionKey(option.category ?? '') === 'reasoning_effort' ||
        id === 'thought_level' ||
        id === 'reasoning_effort'
      )
    })
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
    if (snapshot === undefined)
      throw new LlmError(
        'ACP session did not advertise configuration options required by the selected model',
        'ACP_CONFIG_UNSUPPORTED',
      )
    const modelOption = this.findSelectOption(snapshot, 'model')
    // ACP option lists describe values that may be selected now. They do not
    // necessarily repeat a legacy value that an older, resumed session is
    // already using. Treat the Agent-confirmed current value as valid even
    // when it has disappeared from the selectable catalog; only a requested
    // change must still be present in `options`.
    if (
      modelOption === undefined ||
      (modelOption.currentValue !== options.model && !this.selectValues(modelOption).has(options.model))
    ) {
      throw new LlmError(`ACP session does not allow model "${options.model}"`, 'ACP_CONFIG_UNSUPPORTED')
    }
    const previousModel = modelOption.currentValue
    const modelChanged = previousModel !== options.model
    const applyOption = async (
      option: Extract<acp.SessionConfigOption, { type: 'select' }>,
      value: string,
    ): Promise<void> => {
      if (runtime.setConfigOption === undefined)
        throw new LlmError('ACP runtime cannot change its model configuration', 'ACP_CONFIG_UNSUPPORTED')
      try {
        await runtime.setConfigOption(option.id, value, options.signal)
      } catch (error) {
        throw new LlmError(
          `ACP configuration could not be applied: ${error instanceof Error ? error.message : String(error)}`,
          'ACP_CONFIG_SYNC_FAILED',
          { cause: error },
        )
      }
      if (runtime.configOptions?.find((entry) => entry.id === option.id)?.currentValue !== value) {
        throw new LlmError(`ACP agent did not confirm configuration "${option.id}"`, 'ACP_CONFIG_SYNC_FAILED')
      }
    }
    if (!modelChanged && options.reasoningEffort === undefined) return
    if (modelChanged) await applyOption(modelOption, options.model)
    if (options.reasoningEffort === undefined) return
    // A model change can change the available reasoning values. Always inspect
    // the confirmed response snapshot rather than the pre-change object.
    const confirmedSnapshot = runtime.configOptions
    if (confirmedSnapshot === undefined)
      throw new LlmError('ACP agent did not return a configuration snapshot', 'ACP_CONFIG_SYNC_FAILED')
    const reasoningOption = this.findSelectOption(confirmedSnapshot, 'reasoning')
    try {
      const requestedReasoning = String(options.reasoningEffort)
      if (
        reasoningOption === undefined ||
        (!reasoningRequestIsCurrent(
          effectiveRuntimeOf(this.profileId, this.readConfig()),
          reasoningOption,
          requestedReasoning,
        ) &&
          !this.selectValues(reasoningOption).has(requestedReasoning))
      ) {
        throw new LlmError(
          `ACP session does not allow reasoning effort "${String(options.reasoningEffort)}"`,
          'ACP_CONFIG_UNSUPPORTED',
        )
      }
      if (
        !reasoningRequestIsCurrent(
          effectiveRuntimeOf(this.profileId, this.readConfig()),
          reasoningOption,
          requestedReasoning,
        )
      ) {
        await applyOption(reasoningOption, requestedReasoning)
      }
    } catch (error) {
      if (!modelChanged) throw error
      // A model switch may invalidate the requested effort. Restore the
      // previous model before failing closed so a half-applied configuration
      // cannot surprise the next turn.
      try {
        const rollbackOption = this.findSelectOption(runtime.configOptions ?? [], 'model')
        if (rollbackOption === undefined || !this.selectValues(rollbackOption).has(previousModel))
          throw new Error('previous model is no longer selectable')
        await applyOption(rollbackOption, previousModel)
      } catch (rollbackError) {
        throw new LlmError(
          `ACP configuration failed and the previous model could not be restored; inspect the Agent session (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
          'ACP_CONFIG_SYNC_FAILED',
          { cause: error },
        )
      }
      throw new LlmError(
        `ACP reasoning configuration is unavailable for the selected model; the previous model was restored (${error instanceof Error ? error.message : String(error)})`,
        error instanceof LlmError ? error.code : 'ACP_CONFIG_SYNC_FAILED',
        { cause: error },
      )
    }
  }

  private streamWithGeneration(
    options: GenerateOptions,
    generation: ProfileGeneration | undefined,
  ): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (options.purpose !== undefined)
        throw new LlmError('ACP does not execute auxiliary title or compaction requests', 'ACP_AUXILIARY_CALL')
      const key = String(options.sessionId ?? '')
      if (key.length > 0) {
        const session = self.sessionOf(key)
        const sessionOwner = session === undefined ? undefined : (session.identity ?? session)
        const settlementWait = self.settlementWaitSignal(key, sessionOwner, options.signal)
        const settlementSignal = settlementWait.signal
        try {
          if (settlementSignal.aborted) throw abortReason(settlementSignal)
          const settleExisting = settlePendingLocally(self.hostRoot ?? self, key, self.settlementSink, self.profileId)
          try {
            await awaitWithSignal(settleExisting, settlementSignal)
          } catch (error) {
            if (settlementSignal.aborted) throw abortReason(settlementSignal)
            if (!(error instanceof AcpLocalSettlementError)) throw error
            await waitForLocalSettlement(self.hostRoot ?? self, key, settlementSignal)
          }
          if (settlementSignal.aborted) throw abortReason(settlementSignal)
        } finally {
          settlementWait.dispose()
        }
      }
      const sharedFallback = self.hostRoot === undefined ? undefined : getSharedRecoveryFallback(self.hostRoot, key)
      if (sharedFallback !== undefined && sharedFallback.kind !== 'healthy')
        throw new LlmError(
          sharedFallback.detail ?? 'ACP session requires recovery before another prompt',
          'ACP_RECOVERY_REQUIRED',
        )
      if (self.hostRoot !== undefined) {
        try {
          assertHostExecutionQuiescent(self.hostRoot, key)
        } catch (error) {
          throw new LlmError(
            'ACP Host tool execution is still active; recovery must wait for it to settle',
            'ACP_RECOVERY_REQUIRED',
            { cause: error },
          )
        }
      }
      if (self.inMemoryRecoveryRequired.has(key))
        throw new LlmError('ACP steering outcome requires explicit recovery before continuing', 'ACP_RECOVERY_REQUIRED')
      const carry: StreamChunk[] = []
      let owner = self.handoffs.get(key)
      const retire = async (candidate: HandoffOwner, collectRemainder = false): Promise<void> => {
        try {
          await candidate.stream.drain()
          if (collectRemainder) carry.push(...candidate.stream.takeRemainder())
        } finally {
          self.detachHandoffOwner(key, candidate)
        }
      }
      if (owner?.stream.closing) {
        await retire(owner)
        owner = undefined
      }
      if (owner !== undefined) {
        if (!owner.stream.suspended) throw new LlmError('ACP stream is already active', 'ACP_PROMPT_ALREADY_ACTIVE')
        const sameToolDirectory =
          self.mcpKey === undefined || self.mcpKey(key, owner.options.tools) === self.mcpKey(key, options.tools)
        const compatible =
          owner.generation === generation &&
          owner.options.provider === options.provider &&
          owner.options.model === options.model &&
          owner.options.reasoningEffort === options.reasoningEffort &&
          sameToolDirectory &&
          owner.options.signal?.aborted !== true &&
          options.signal?.aborted !== true &&
          options.purpose === undefined
        let resumed = false
        try {
          resumed = compatible && (await owner.stream.resume?.(options)) === true
        } catch (error) {
          const localFailure = error instanceof SteeringFailure && !error.remoteRequestSent
          const remoteRequestSent = !localFailure
          if (remoteRequestSent) {
            const recovery: AcpRecoveryState = {
              dshSessionId: key,
              kind: 'outcome-unknown',
              cause: 'load-failed',
              detail: 'ACP steering acceptance could not be confirmed; inspect the Agent session before retrying',
              provider: options.provider,
              updatedAt: Date.now(),
            }
            try {
              if (self.sidecar === undefined) throw new Error('ACP sidecar is unavailable')
              await self.sidecar.writeRecoveryState(recovery)
            } catch {
              self.rememberRecoveryFallback(recovery)
            }
            await retire(owner).catch(() => undefined)
          }
          throw new LlmError(error instanceof Error ? error.message : String(error), 'ACP_STEERING_FAILED', {
            cause: error,
          })
        }
        if (!resumed) {
          await retire(owner, true)
          owner = undefined
        }
      }
      if (owner === undefined) {
        const stream = new StreamHandoff()
        owner = { stream, generation, options }
        const indices = new Map<number, number>()
        for (const chunk of carry) {
          if (chunk.type === 'finish') {
            // Cancellation is expected when replacing an idle/changed route.
            // Provider failures and limits must never become a successful retry.
            if (chunk.reason.kind === 'stop' || chunk.reason.kind === 'aborted') continue
            yield chunk
            return
          }
          if ('index' in chunk) {
            if (!indices.has(chunk.index)) indices.set(chunk.index, indices.size)
            yield { ...chunk, index: indices.get(chunk.index)! }
          } else yield chunk
        }
        stream.attach(self.executionStream(options, generation, stream, indices.size))
        self.handoffs.set(key, owner)
        const captured = owner
        const cleanup = async (abandonSettlementWait = false): Promise<void> => {
          if (self.handoffs.get(key) !== captured || !stream.suspended) return
          try {
            if (abandonSettlementWait) await stream.drainAfterAbandon()
            else await stream.drain()
          } finally {
            self.detachHandoffOwner(key, captured)
          }
        }
        const view = self.sessionOf(key)
        const offEnd = view?.watchTurnEnd?.(() => {
          void cleanup(true).catch(() => {
            try {
              self.log?.('ACP suspended stream cleanup failed')
            } catch {
              /* cleanup diagnostics are best effort */
            }
          })
        })
        const offRoute = view?.watchRouteChange?.(options.provider, () => cleanup(true))
        owner.off = () => {
          try {
            offEnd?.()
          } finally {
            offRoute?.()
          }
        }
      }
      const segment = owner.stream.segment()[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await segment.next()
          if (next.done) break
          yield next.value
          if (next.value.type === 'finish') await owner.stream.acknowledgeTerminalFinish()
        }
      } finally {
        try {
          await segment.return?.(undefined)
        } finally {
          if (!owner.stream.suspended) self.detachHandoffOwner(key, owner)
        }
      }
    })()
  }

  private detachHandoffOwner(key: string, owner: HandoffOwner): void {
    try {
      owner.off?.()
    } catch {
      try {
        this.log?.('ACP stream listener cleanup failed')
      } catch {
        /* listener cleanup diagnostics must not block owner retirement */
      }
    } finally {
      if (this.handoffs.get(key) === owner) this.handoffs.delete(key)
    }
  }

  private executionStream(
    options: GenerateOptions,
    generation: ProfileGeneration | undefined,
    handoff: StreamHandoff,
    contentOffset = 0,
  ): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (options.purpose !== undefined) {
        throw new LlmError('ACP does not execute auxiliary title or compaction requests', 'ACP_AUXILIARY_CALL')
      }
      const sessionKey = String(options.sessionId ?? '')
      if (sessionKey.length === 0) throw new LlmError('ACP requires a DSH session id', 'ACP_SESSION_UNAVAILABLE')
      await self.waitForSessionControlWrite(sessionKey, options.signal)
      if (self.sidecar === undefined)
        throw new LlmError(
          'ACP sidecar is unavailable; the Agent binding cannot be made durable',
          'ACP_BINDING_UNAVAILABLE',
        )
      const durableSidecar = self.sidecar
      const session = self.sessionOf(sessionKey)
      let admissionProof: CurrentStepProof | undefined
      let messages: readonly import('@deepseek-ai/dsh-llm').UserMessage[]
      try {
        messages = admitCurrentStep(options, session, (proof) => {
          admissionProof = proof
        })
      } catch (error: unknown) {
        if (error instanceof AcpAdmissionError) throw new LlmError(error.message, error.code)
        throw error
      }
      const captureRemoteCancellationHook = (proof: CurrentStepProof | undefined) =>
        proof === undefined
          ? undefined
          : session?.captureRemoteCancelledTurn?.({ turn: proof.turn, step: proof.step, startSeq: proof.startSeq })
      let remoteCancellationHook = captureRemoteCancellationHook(admissionProof)
      // Only admitted model requests may change the native tool directory.
      // Missing schemas are retained as missing and therefore fail closed.
      self.admittedToolSchemas.set(sessionKey, options.tools)
      self.admittedToolSchemaOwners.set(sessionKey, session?.identity ?? session ?? self)
      const profile = generation?.config
      if (profile === undefined || generation === undefined)
        throw new LlmError(`ACP profile "${self.profileId}" is no longer configured`, 'ACP_UNKNOWN_PROFILE')
      if (!self.subprocess.ok) throw new LlmError(self.subprocess.message, 'ACP_SPAWN_FAILURE')
      const runtimeKey = `${sessionKey}:${generation.id}`
      const priorGeneration = [...self.runtimes.keys()].find((key) => key.startsWith(`${sessionKey}:`))
      if (priorGeneration !== undefined && priorGeneration !== runtimeKey) {
        // M2 has no binding/recovery transaction yet.  Never silently start a
        // new ACP session after a profile identity edit: doing so would lose
        // the remote context while DSH still shows the old conversation.
        if (self.sidecar !== undefined) {
          await self.blockRecovery(sessionKey, {
            kind: 'reconciliation-required',
            cause: 'profile-changed',
            detail:
              'The ACP profile changed while this DSH session was active; restore the original profile or explicitly rebind blank',
          })
        }
        throw new LlmError(
          'ACP profile changed; recover or start a new DSH session before continuing',
          'ACP_PROFILE_CHANGED',
        )
      }
      const runtime =
        self.runtimes.get(runtimeKey) ??
        self.runtimeFactory(
          self.runtimeOptionsFor(
            sessionKey,
            profile,
            session?.header?.cwd ??
              (() => {
                throw new LlmError('ACP requires the DSH session working directory', 'ACP_SESSION_CWD_UNAVAILABLE')
              })(),
          ),
        )
      self.runtimes.set(runtimeKey, runtime)
      if (session !== undefined) self.runtimeOwners.set(runtime, session.identity ?? session)
      let retainHealthyRuntimeAfterNotDispatched = false
      let retainCancelledRuntimeForRefreshRetry = false
      let bindingForModeRestore: AcpBindingData | undefined
      let terminalSettlementLifetime: (() => void) | undefined
      try {
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
          const modelContextSnapshots = session?.currentModelContextSnapshots?.()
          const prompt = await toAcpPrompt(messages, {
            system: hostSystemPrompt(options),
            ...(modelContextSnapshots === undefined ? {} : { modelContextSnapshots }),
            skillRoute: skillRouteForTools(options.tools),
            imageEnabled: runtime.agentCapabilities?.promptCapabilities?.image === true,
            ...(self.attachments === undefined ? {} : { attachments: self.attachments }),
            signal: options.signal ?? new AbortController().signal,
          })
          if (prompt.length === 0)
            throw new AcpPromptContentError(
              'dsh-acp: the claimed message(s) carry no supported content; nothing was sent to the ACP agent',
            )
          // Store the validated prompt for the dispatch path below.
          validatedPrompt = prompt
        } catch (error: unknown) {
          await self.releaseRuntime(runtimeKey, runtime)
          if (error instanceof AcpPromptContentError) throw new LlmError(error.message, 'ACP_INPUT_NOT_SUPPORTED')
          throw error
        }
        const prompt = validatedPrompt
        const dispatchKey = acpCanonicalHash16({
          provider: options.provider,
          model: options.model,
          generation: generation.id,
          acceptedMessageIds: messages.map((message) => String(message.id)),
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
        const priorBindingForRebind = forceBlank
          ? await self.sidecar?.readLatestBinding(sessionKey as never)
          : undefined
        const existingBinding = forceBlank ? undefined : await self.sidecar?.readLatestBinding(sessionKey as never)
        if (existingBinding?.status === 'outdated') {
          await self.blockRecovery(sessionKey, {
            kind: 'reconciliation-required',
            cause: 'binding-outdated',
            detail: 'The ACP binding record is malformed and cannot be used safely',
          })
        }
        if (persistedRecovery !== undefined && persistedRecovery.kind !== 'healthy' && !forceBlank) {
          throw new LlmError(
            persistedRecovery.detail ?? 'ACP session requires recovery before another prompt',
            'ACP_RECOVERY_REQUIRED',
          )
        }
        const binding = existingBinding?.status === 'ok' ? existingBinding.binding : undefined
        bindingForModeRestore = binding
        if (binding === undefined) self.confirmedUserModes.delete(sessionKey)
        const currentFingerprint = await self.launchFingerprint(profile)
        const canonicalCwd = self.canonicalCwd(session?.header?.cwd)
        if (binding !== undefined) {
          if (binding.provider !== options.provider || binding.profileId !== self.profileId) {
            await self.blockRecovery(
              sessionKey,
              {
                kind: 'reconciliation-required',
                cause: 'backend-conflict',
                detail: 'The saved ACP binding belongs to another provider or profile',
              },
              binding,
            )
          }
          if (binding.canonicalCwd !== canonicalCwd) {
            await self.blockRecovery(
              sessionKey,
              {
                kind: 'reconciliation-required',
                cause: 'cwd-changed',
                detail: `The session working directory changed from ${binding.canonicalCwd} to ${canonicalCwd}`,
              },
              binding,
            )
          }
          if (!acpLaunchFingerprintsCompatible(binding.launchFingerprint, currentFingerprint)) {
            await self.blockRecovery(
              sessionKey,
              {
                kind: 'reconciliation-required',
                cause: 'profile-changed',
                detail: 'The ACP launch configuration no longer matches the saved session binding',
              },
              binding,
            )
          }
          if (typeof runtime.restore !== 'function') {
            await self.blockRecovery(
              sessionKey,
              {
                kind: 'reconciliation-required',
                cause: 'capability-missing',
                detail: 'This ACP runtime cannot restore the saved Agent session',
              },
              binding,
            )
          }
          let replayUpdates = 0
          let replayChars = 0
          try {
            const method = await runtime.restore!(binding, options.signal, (notification) => {
              replayUpdates += 1
              const update = notification.update
              if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
                replayChars += update.content.text.length
              if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text')
                replayChars += update.content.text.length
            })
            // Replay is staging/audit only. It is intentionally not compared to,
            // or appended over, DSH history; a provider may project it differently.
            try {
              await self.sidecar?.append(sessionKey as never, {
                kind: 'replay-assessment',
                data: {
                  status: 'not-compared',
                  method,
                  detail: `ACP session ${method} (${String(replayUpdates)} staged updates, ${String(replayChars)} text characters)`,
                  acpSessionId: binding.agentSessionId,
                  generation: binding.generation,
                },
              })
            } catch (error) {
              if (!runtime.lastRestoreRefreshedCancelledSession) throw error
              // Replay assessment is staging-only evidence. A local audit write
              // cannot invalidate a successful same-session refresh.
            }
          } catch (error: unknown) {
            const cancelledRefreshPending = runtime.cancelledSessionRefreshPending === true
            if (
              (error instanceof AcpSessionRefreshRetryError || error instanceof AcpSessionRefreshAbortedError) &&
              cancelledRefreshPending
            ) {
              // The previous prompt has a confirmed cancelled terminal and its
              // result is already settled. Keep the original binding/runtime
              // marker so a later user request can retry session/load without
              // creating a recovery gate or dispatching this prompt.
              retainCancelledRuntimeForRefreshRetry = true
              throw new LlmError(error.message, error.code, { cause: error })
            }
            if (options.signal?.aborted === true && cancelledRefreshPending) {
              retainCancelledRuntimeForRefreshRetry = true
              throw abortReason(options.signal)
            }
            await self.releaseRuntime(runtimeKey, runtime)
            const detail = `ACP session restore failed: ${error instanceof Error ? error.message : String(error)}`
            const missing = /(?:session[_ -]?)?(?:not[ -]?found|unknown[_ -]?session)|does not exist/i.test(detail)
            const capability = /does not advertise|cannot restore/i.test(detail)
            await self.blockRecovery(
              sessionKey,
              {
                kind: missing ? 'session-lost' : capability ? 'reconciliation-required' : 'reconnect-required',
                cause: missing ? 'id-not-found' : capability ? 'capability-missing' : 'load-failed',
                detail,
              },
              binding,
              missing ? 'ACP_SESSION_NOT_FOUND' : capability ? 'ACP_RECONCILIATION_REQUIRED' : 'ACP_RECONNECT_REQUIRED',
            )
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
            } else if (
              parentBinding.canonicalCwd !== canonicalCwd ||
              !acpLaunchFingerprintsCompatible(parentBinding.launchFingerprint, currentFingerprint)
            ) {
              forkReason = 'parent-binding-mismatch'
            } else {
              const parentRecovery = await self.sidecar.readRecoveryState(parentSessionId as never)
              if (parentRecovery !== undefined && parentRecovery.kind !== 'healthy') {
                forkReason = 'parent-recovery-required'
              } else if (self.sessionOf(parentSessionId) === undefined) {
                forkReason = 'parent-binding-unavailable'
              } else if (self.sessionOf(parentSessionId)?.facts.turnOpen === true) {
                forkReason = 'parent-not-idle'
              } else if (!isLatestForkCut(session, parentSessionId, parentBinding)) {
                forkReason = 'seed-not-latest-semantic-boundary'
              } else if (typeof runtime.fork !== 'function') {
                forkReason = 'agent-does-not-advertise-fork'
              } else {
                try {
                  await runtime.fork(
                    parentBinding.agentSessionId,
                    options.signal,
                    { agent: parentBinding.agent, protocolVersion: parentBinding.protocolVersion },
                    async () => {
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
                        throw new Error(
                          `ACP_FORK_INTENT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
                        )
                      }
                    },
                  )
                  forked = true
                  forkOutcome = 'inherited'
                  forkReason = 'inherited'
                } catch (error: unknown) {
                  if (error instanceof Error && error.message === 'ACP_FORK_UNSUPPORTED') {
                    forkReason = 'agent-does-not-advertise-fork'
                  } else if (error instanceof Error && error.message === 'ACP_FORK_PRECONDITION_FAILED') {
                    forkReason = 'parent-binding-mismatch'
                  } else if (error instanceof Error && error.message.startsWith('ACP_FORK_INTENT_FAILED')) {
                    await self.releaseRuntime(runtimeKey, runtime)
                    throw new LlmError(
                      'ACP fork intent could not be persisted; no remote fork was sent',
                      'ACP_FORK_INTENT_FAILED',
                    )
                  } else {
                    await self.releaseRuntime(runtimeKey, runtime)
                    const detail = `ACP session/fork outcome is unknown: ${error instanceof Error ? error.message : String(error)}`
                    await self.blockRecovery(
                      sessionKey,
                      { kind: 'outcome-unknown', cause: 'load-failed', detail },
                      parentBinding,
                      'ACP_FORK_FAILED',
                    )
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
              await self.releaseRuntime(runtimeKey, runtime)
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
            const dshHead = Math.max((session?.seq ?? 0) - 1, admissionProof?.startSeq ?? 0)
            const bindingData: AcpBindingData = {
              provider: options.provider,
              agentSessionId:
                runtime.acpSessionId ??
                (() => {
                  throw new LlmError('ACP runtime did not return a session id', 'ACP_SESSION_UNAVAILABLE')
                })(),
              profileId: self.profileId,
              canonicalCwd,
              launchFingerprint: currentFingerprint,
              agent: {
                ...(agent?.name === undefined ? {} : { name: agent.name }),
                ...(agent?.version === undefined ? {} : { version: agent.version }),
              },
              protocolVersion: runtime.protocolVersion ?? 1,
              capabilityHash: acpCanonicalHash16(runtime.agentCapabilities ?? {}),
              configHash: acpCanonicalHash16({
                profileId: self.profileId,
                command: profile.command,
                args: profile.args,
                envKeys: Object.keys(profile.env).sort(),
              }),
              generation:
                self.nextGenerations.get(sessionKey) ?? (forceBlank ? (persistedRecovery?.generation ?? 1) : 1),
              bindingEpoch:
                self.nextGenerations.get(sessionKey) ??
                (forceBlank && priorBindingForRebind?.status === 'ok'
                  ? (priorBindingForRebind.binding.bindingEpoch ?? priorBindingForRebind.binding.generation) + 1
                  : 1),
              committedPromptOrdinal: 0,
              historyBaseSeq:
                forked && forkParentBinding !== undefined
                  ? forkParentBinding.historyBaseSeq
                  : forceBlank && priorBindingForRebind?.status === 'ok'
                    ? priorBindingForRebind.binding.dshCommittedSeq
                    : (admissionProof?.startSeq ?? 0),
              establishedAt: Date.now(),
              dshCommittedSeq:
                forceBlank && priorBindingForRebind?.status === 'ok'
                  ? Math.max(priorBindingForRebind.binding.dshCommittedSeq, dshHead)
                  : dshHead,
            }
            try {
              await self.sidecar.append(sessionKey as never, { kind: 'binding', data: bindingData })
              bindingForModeRestore = bindingData
              if (forkOutcome !== undefined && forkReason !== undefined) {
                await self.sidecar.append(sessionKey as never, {
                  kind: 'session-fork',
                  data: {
                    outcome: forkOutcome,
                    reason: forkReason,
                    ...(forkParentSessionId === undefined ? {} : { parentSessionId: forkParentSessionId }),
                    ...(forkParentAgentSessionId === undefined
                      ? {}
                      : { parentAgentSessionId: forkParentAgentSessionId }),
                    ...(forked ? { agentSessionId: bindingData.agentSessionId } : {}),
                  },
                })
              }
              await self.sidecar.writeRecoveryState({
                dshSessionId: sessionKey as never,
                kind: 'healthy',
                provider: options.provider,
                acpSessionId: bindingData.agentSessionId,
                generation: bindingData.generation,
                updatedAt: Date.now(),
              })
              self.nextGenerations.delete(sessionKey)
            } catch (error: unknown) {
              await self.releaseRuntime(runtimeKey, runtime)
              throw new LlmError(
                `ACP binding could not be persisted; no prompt was sent (${error instanceof Error ? error.message : String(error)})`,
                'ACP_BINDING_PERSIST_FAILED',
              )
            }
          }
        }
        // ACP configuration is session-scoped. Reconcile the stock DSH request
        // only after setup/restore has established the session, but before the
        // dispatch WAL: a rejected or unconfirmed change must cause zero WAL and
        // zero prompt, never a silent request with a different model/effort.
        const savedMode = self.confirmedUserModes.get(sessionKey)
        const restoreSavedMode =
          savedMode?.needsRestore === true &&
          bindingForModeRestore !== undefined &&
          savedMode.bindingKey === modeIntentBindingKey(bindingForModeRestore) &&
          savedMode.agentSessionId === bindingForModeRestore.agentSessionId
        if (
          savedMode !== undefined &&
          bindingForModeRestore !== undefined &&
          (savedMode.bindingKey !== modeIntentBindingKey(bindingForModeRestore) ||
            savedMode.agentSessionId !== bindingForModeRestore.agentSessionId)
        )
          self.confirmedUserModes.delete(sessionKey)
        try {
          await self.convergeConfig(runtime, options)
          await self.applyMemberMode(sessionKey, runtime)
          if (restoreSavedMode) {
            // A mode is restored only after the same-bound session was loaded.
            // If it disappeared from the Agent's supported choices, keep the
            // live controls available and send no prompt under a different mode.
            retainHealthyRuntimeAfterNotDispatched = true
            if (!(await self.restoreConfirmedUserMode(sessionKey, runtime, bindingForModeRestore!)))
              throw new LlmError(
                'The Agent no longer supports the selected mode. Choose a supported mode to continue; no prompt was sent.',
                'ACP_CONFIG_UNSUPPORTED',
              )
          }
          await self.persistRuntimeSnapshot(sessionKey, runtime)
        } catch (error: unknown) {
          if (!restoreSavedMode) await self.releaseRuntime(runtimeKey, runtime)
          if (error instanceof LlmError) throw error
          throw new LlmError(
            `ACP session configuration could not be applied: ${error instanceof Error ? error.message : String(error)}`,
            'ACP_CONFIG_SYNC_FAILED',
            { cause: error },
          )
        }
        const bindingSettlementTarget = await self.readBindingSettlementTarget(sessionKey)
        try {
          await self.ledger.begin({
            key: dispatchKey,
            dshSessionId: sessionKey,
            provider: options.provider,
            model: options.model,
            createdAt: Date.now(),
            ...(admissionProof === undefined ? {} : { provenance: admissionProof }),
          })
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
          } catch {
            /* original durable ledger error remains the primary cause */
          }
          await self.releaseRuntime(runtimeKey, runtime)
          throw new LlmError(
            'ACP dispatch is blocked by a durable recovery guard; review the session before continuing',
            'ACP_RECOVERY_REQUIRED',
          )
        }
        let localSettlementTask: ((sink: AcpLocalSettlementSink) => Promise<void>) | undefined
        let committedBindingAfterSettle: AcpBindingData | undefined
        const settleKnownRemoteTerminal = (): Promise<AcpBindingData | undefined> => {
          if (localSettlementTask === undefined) {
            const dshCommittedSeq = Math.max(
              Math.max((session?.seq ?? 0) - 1, 0),
              bindingSettlementTarget?.baseDshCommittedSeq ?? 0,
            )
            const bindingCommit: BindingSettlementCommit | undefined =
              bindingSettlementTarget === undefined ? undefined : { ...bindingSettlementTarget, dshCommittedSeq }
            let feedbackFlushed = false
            let ledgerSettled = false
            let runtimeSnapshotPersisted = false
            let bindingHeadRefreshed = bindingCommit === undefined
            let runtimeSnapshotCaptureFailed = false
            let runtimeSnapshot: ReturnType<typeof acpOptionsSnapshotOf> | undefined
            try {
              runtimeSnapshot = acpOptionsSnapshotOf(
                runtime.configOptions,
                runtime.currentModeId,
                profileLaunchIdentityHash(self.profileId, profile),
                Date.now(),
                {
                  contextUsage: runtime.contextUsage === undefined ? null : runtime.contextUsage,
                  modes:
                    runtime.modes === undefined
                      ? null
                      : {
                          currentModeId: runtime.modes.currentModeId,
                          availableModes: runtime.modes.availableModes.map((mode) => ({
                            id: mode.id,
                            name: mode.name,
                            ...(mode.description === undefined ? {} : { description: mode.description }),
                          })),
                        },
                },
              )
            } catch {
              runtimeSnapshotCaptureFailed = true
              self.log?.('ACP_RUNTIME_SNAPSHOT_PROJECTION_FAILED')
            }
            localSettlementTask = async (sink: AcpLocalSettlementSink) => {
              if (!feedbackFlushed) {
                if (runtime.flushHostFeedback !== undefined) await runtime.flushHostFeedback()
                else if (runtime.hostSettlementPending === true)
                  throw new Error('ACP runtime retained Host feedback without a local flush operation')
                feedbackFlushed = true
              }
              if (!ledgerSettled) {
                try {
                  await sink.settleDispatch(sessionKey, dispatchKey)
                } catch (error) {
                  const settled = await sink.readDispatch(sessionKey, dispatchKey)
                  if (settled?.state !== 'settled') throw error
                }
                ledgerSettled = true
              }
              if (!runtimeSnapshotPersisted) {
                // Projection-invalid runtime metadata is a presentation failure,
                // not a failed local write. Preserve the last valid snapshot.
                if (runtimeSnapshotCaptureFailed) runtimeSnapshotPersisted = true
              }
              if (!runtimeSnapshotPersisted) {
                if (runtimeSnapshot === undefined)
                  throw new Error('ACP sidecar is unavailable for terminal snapshot persistence')
                await sink.writeRuntimeSnapshot(sessionKey, runtimeSnapshot)
                runtimeSnapshotPersisted = true
              }
              if (!bindingHeadRefreshed && bindingCommit !== undefined) {
                committedBindingAfterSettle = await sink.refreshBindingHead(sessionKey, session, bindingCommit)
                bindingHeadRefreshed = true
              }
            }
          }
          const task = localSettlementTask
          if (task === undefined) throw new Error('ACP local settlement task was not initialized')
          return settleLocally(
            self.hostRoot ?? self,
            sessionKey,
            dispatchKey,
            task,
            self,
            () => self.controlsChanged?.(sessionKey),
            self.settlementSink,
            self.profileId,
          ).then(() => committedBindingAfterSettle)
        }
        const queue: StreamChunk[] = []
        let activityFallbackSeq = 0
        let activityWriteTail = Promise.resolve()
        const currentActivities = new Map<string, NormalizedActivity>()
        const externalDelegations: ExternalDelegationObservation[] = []
        const profileKind = effectiveRuntimeOf(self.profileId, profile) ?? self.profileId
        const delegationNormalizer = new ExternalDelegationNormalizer(profileKind)
        const externalFactsByTool = new Map<string, Map<string, ExternalDelegationLiveFact>>()
        const toolActivityBases = new Map<string, NormalizedActivity>()
        let externalFactCount = 0
        const rememberExternalFact = (fact: ExternalDelegationLiveFact): void => {
          const toolCallId = fact.sourceToolCallId
          if (toolCallId === undefined) return
          let facts = externalFactsByTool.get(toolCallId)
          if (facts === undefined) {
            if (externalFactCount >= EXTERNAL_DELEGATION_PENDING_LIMIT) return
            facts = new Map()
            externalFactsByTool.set(toolCallId, facts)
          }
          if (!facts.has(fact.vendorDelegationKey)) {
            if (externalFactCount >= EXTERNAL_DELEGATION_PENDING_LIMIT) return
            externalFactCount += 1
          }
          facts.set(fact.vendorDelegationKey, fact)
        }
        const factsForTool = (toolCallId: string): readonly ExternalDelegationLiveFact[] => [
          ...(externalFactsByTool.get(toolCallId)?.values() ?? []),
        ]
        const factFromObservation = (
          observation: ExternalDelegationObservation,
          observedAt: number,
        ): ExternalDelegationLiveFact | undefined => {
          if (observation.sourceToolCallId === undefined) return undefined
          return {
            profileKind: observation.profileKind,
            vendorDelegationKey: observation.vendorDelegationKey,
            ...(observation.vendorChildId === undefined ? {} : { vendorChildId: observation.vendorChildId }),
            sourceToolCallId: observation.sourceToolCallId,
            label: observation.label,
            status: observation.status,
            observedStartedAt: observation.timing.observedStartedAt,
            observedAt,
          }
        }
        const toolChildren = new Map<string, Map<number, NormalizedActivity>>()
        // Tool ids are session-scoped, while sparse patch state belongs to this
        // one prompt projection.  Never carry a partially observed call into a
        // later DSH turn, even if an Agent reuses its id.
        const toolCallReducer = new AcpToolCallReducer(dispatchKey)
        const activityPositions = new Map<string, number>()
        let currentAnchor = admissionProof?.anchorMessageId ?? `prompt:${dispatchKey}`
        let activityIndexOffset = 0
        const activityOwners = new Map<string, { anchor: string; offset: number }>()
        const scheduleActivity = (activity: NormalizedActivity): void => {
          if (typeof durableSidecar.upsertActivity !== 'function') return
          currentActivities.set(activity.activityId, activity)
          let activityOwner = activityOwners.get(activity.activityId)
          if (activityOwner === undefined) {
            activityOwner = { anchor: currentAnchor, offset: activityIndexOffset }
            activityOwners.set(activity.activityId, activityOwner)
          }
          const fallbackAnchor = activityOwner.anchor
          const stableActivityId = `${fallbackAnchor}:${activity.activityId}`
          const rawPosition = activityPositions.get(activity.activityId)
          const position = rawPosition === undefined ? undefined : Math.max(0, rawPosition - activityOwner.offset)
          activityWriteTail = activityWriteTail.then(async () => {
            try {
              await durableSidecar.upsertActivity({
                ...(position === undefined ? {} : { contentIndex: position }),
                dshSessionId: sessionKey,
                ownerDshSessionId: sessionKey,
                promptAnchorMessageId: fallbackAnchor,
                // Tool ids are only unique within an ACP turn. Prefixing with
                // the DSH turn anchor prevents a later turn from replacing an
                // earlier row while preserving the vendor id in the suffix.
                activityId: stableActivityId,
                time: Date.now(),
                kind: activity.kind,
                ...(activity.display === undefined ? {} : { display: activity.display }),
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
        const settleRunningActivities = (status: 'completed' | 'failed' | 'cancelled' | 'unfinished'): void => {
          for (const activity of currentActivities.values()) {
            if (activity.kind !== 'plan' && !isTerminalActivityStatus(activity.status))
              scheduleActivity({ ...activity, status })
          }
        }
        let wake: (() => void) | undefined
        let done = false
        let failure: unknown
        let cancelledRuntimeRetirement: Promise<void> | undefined
        let visibleContentEmitted = false
        const unsupportedChunkContents: Array<{ type: string; reason: string }> = []
        let unsupportedChunkContentsTruncated = false
        let contentBreakVersion = 0
        // Only contiguous content belongs to the same native block. Never
        // return to an older text/reasoning index after another segment.
        let nextContentIndex = contentOffset
        let contentSegment: { kind: 'text' | 'reasoning'; index: number; messageId?: string } | undefined
        const breakContent = (): void => {
          contentBreakVersion += 1
          contentSegment = undefined
        }
        const contentIndex = (kind: 'text' | 'reasoning', messageId?: string | null): number => {
          if (
            contentSegment?.kind !== kind ||
            (messageId != null && contentSegment.messageId !== undefined && messageId !== contentSegment.messageId)
          ) {
            contentSegment = { kind, index: nextContentIndex++ }
          }
          if (messageId != null) contentSegment.messageId = messageId
          return contentSegment.index
        }
        const pushChunk = (chunk: StreamChunk): void => {
          queue.push(chunk)
          wake?.()
          wake = undefined
        }
        const noteUnsupportedChunk = (type: string, reason: string): void => {
          if (unsupportedChunkContents.length < 32) unsupportedChunkContents.push({ type, reason })
          else unsupportedChunkContentsTruncated = true
        }
        const pushNonTextFallback = (content: AcpNonTextContent): void => {
          breakContent()
          noteUnsupportedChunk(content.type, 'non-text ACP answer content was rendered with a safe text fallback')
          pushChunk({
            type: 'text-delta',
            index: contentIndex('text'),
            text: `\n\n${nonTextContentFallback(content)}\n\n`,
          })
          visibleContentEmitted = true
          // Keep the fallback as its own block in ACP content order.
          breakContent()
        }
        const emitAgentContent = async (content: acp.ContentBlock, messageId?: string | null): Promise<void> => {
          if (content.type === 'text') {
            // DSH treats whitespace-only assistant content as non-visible. Keep
            // the same terminal-response rule here so formatting whitespace
            // cannot mask ACP_NO_VISIBLE_RESPONSE.
            if (content.text.trim().length > 0) visibleContentEmitted = true
            pushChunk({ type: 'text-delta', index: contentIndex('text', messageId), text: content.text })
            return
          }
          if (content.type === 'image' && self.attachments?.saveImages !== undefined) {
            try {
              const [attachment] = await admitEncodedImages(self.attachments as AttachmentStore, [
                {
                  mediaType: content.mimeType as ImageMediaType,
                  data: content.data,
                },
              ])
              if (attachment === undefined) throw new Error('attachment store returned no image reference')
              breakContent()
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
        const writeUnsupportedChunkAudit = async (): Promise<void> => {
          if (unsupportedChunkContents.length === 0 || self.sidecar === undefined) return
          try {
            await self.sidecar.append(sessionKey as never, {
              kind: 'degradation',
              data: {
                code: 'unsupported-chunk-content',
                items: unsupportedChunkContents,
                keptPreviewChars: 0,
                truncated: unsupportedChunkContentsTruncated,
              },
            })
          } catch {
            /* best effort: audit failure never changes the prompt outcome */
          }
        }
        // Attachment admission is asynchronous while ACP notifications are not.
        // Serialize all assistant chunks through one tail so text/image/text
        // cannot be reordered by image validation or storage latency.
        let contentDeliveryTail = Promise.resolve()
        const scheduleContent = (task: () => void | Promise<void>): void => {
          contentDeliveryTail = contentDeliveryTail.then(async () => {
            await task()
          })
        }
        const toolContentBoundaries = new Map<string, boolean>()
        const onUpdate = (notification: AcpSessionNotification): void => {
          const update = notification.update
          const observedAt = Date.now()
          const delegation = delegationNormalizer.acceptNotification(notification, observedAt)
          if (delegation !== undefined) externalDelegations.push(delegation)
          const completedFact = delegation === undefined ? undefined : factFromObservation(delegation, observedAt)
          // Native child notifications are evidence for the projected child,
          // never assistant/tool output of the root DSH turn.
          if (runtime.acpSessionId !== undefined && notification.sessionId !== runtime.acpSessionId) return
          if (completedFact !== undefined) rememberExternalFact(completedFact)
          const isToolUpdate = update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
          const toolId =
            isToolUpdate && typeof update.toolCallId === 'string'
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
            const terminal = isTerminalActivityStatus(activityStatus(toolCall.status))
            const previousTerminal = toolContentBoundaries.get(toolId)
            if (previousTerminal === undefined || (previousTerminal && !terminal)) {
              // A tool's first observation (or a new active lifecycle after a
              // terminal one) marks its insertion point in the answer stream.
              // A late terminal notification only updates activity state; it
              // must not split answer text that arrived after the tool began.
              scheduleContent(breakContent)
            }
            toolContentBoundaries.set(toolId, terminal)
          }
          if (isToolUpdate && toolCall !== undefined) {
            const previousChildren = toolChildren.get(toolId) ?? new Map<number, NormalizedActivity>()
            const nextChildren = new Map<number, NormalizedActivity>()
            const status = activityStatus(toolCall.status)
            if (Array.isArray(toolCall.content)) {
              for (const [index, item] of toolCall.content.entries()) {
                const child = normalizeActivityContent(`part:${toolId}:${String(index)}`, item, status)
                if (child !== undefined) nextChildren.set(index, child)
              }
            }
            for (const [index, previous] of previousChildren) {
              const next = nextChildren.get(index)
              if (
                (next === undefined || next.activityId !== previous.activityId) &&
                !isTerminalActivityStatus(previous.status)
              ) {
                scheduleContent(() =>
                  scheduleActivity({ ...previous, status: isTerminalActivityStatus(status) ? status : 'completed' }),
                )
              }
            }
            toolChildren.set(toolId, nextChildren)
          }
          if (toolCall !== undefined) {
            const terminal = activityStatus(toolCall.status)
            if (terminal === 'completed' || terminal === 'failed' || terminal === 'cancelled') {
              for (const fact of delegationNormalizer.resolveToolCall(toolId, terminal, observedAt))
                rememberExternalFact(fact)
            } else {
              for (const fact of delegationNormalizer.liveForToolCall(toolId)) rememberExternalFact(fact)
            }
          }
          if (toolCall === undefined && completedFact?.sourceToolCallId !== undefined) {
            const sourceToolCallId = completedFact.sourceToolCallId
            scheduleContent(() => {
              const base = toolActivityBases.get(sourceToolCallId)
              const current = base === undefined ? undefined : currentActivities.get(base.activityId)
              if (base === undefined || current === undefined) return
              scheduleActivity(
                withExternalDelegations({ ...base, status: current.status }, factsForTool(sourceToolCallId)),
              )
            })
          }
          const externalFacts = toolCall === undefined ? [] : factsForTool(toolId)
          const normalized = activitiesForNotification(
            notification,
            `${String(notification.sessionId)}:${String(activityFallbackSeq + 1)}`,
            toolCall,
            externalFacts,
          )
          scheduleContent(() => {
            const plan = normalized.find((activity) => activity.kind === 'plan')?.display?.plan
            if (plan !== undefined) session?.publishPlan?.(plan)
            for (const activity of normalized) {
              if (activity.kind === 'tool' && toolCall !== undefined) toolActivityBases.set(toolId, activity)
              const parentOwner = isToolUpdate ? activityOwners.get(`tool:${toolId}`) : undefined
              if (!activityOwners.has(activity.activityId) && parentOwner !== undefined)
                activityOwners.set(activity.activityId, parentOwner)
              if (!activityPositions.has(activity.activityId)) {
                // A tool's detail rows are nested under its original call;
                // late output must not split an unrelated streaming sentence.
                const parentPosition = isToolUpdate ? activityPositions.get(`tool:${toolId}`) : undefined
                if (parentPosition === undefined) breakContent()
                activityPositions.set(activity.activityId, parentPosition ?? nextContentIndex)
              }
              scheduleActivity(activity)
            }
          })
          if (update.sessionUpdate === 'agent_message_chunk') {
            scheduleContent(async () => {
              await emitAgentContent(update.content, update.messageId)
            })
          } else if (update.sessionUpdate === 'agent_thought_chunk') {
            const thought = update.content
            scheduleContent(() => {
              const text =
                thought.type === 'text'
                  ? thought.text
                  : (() => {
                      noteUnsupportedChunk(
                        thought.type,
                        'non-text ACP thought content was omitted from the safe reasoning preview',
                      )
                      return `[ACP ${thought.type} reasoning content omitted.]`
                    })()
              pushChunk({ type: 'reasoning-delta', index: contentIndex('reasoning', update.messageId), text })
            })
          }
        }
        const finishExternalDelegations = (): void => {
          for (const fact of delegationNormalizer.finishPrompt(Date.now())) {
            rememberExternalFact(fact)
            const toolCallId = fact.sourceToolCallId
            const base = toolCallId === undefined ? undefined : toolActivityBases.get(toolCallId)
            const current = base === undefined ? undefined : currentActivities.get(base.activityId)
            if (toolCallId === undefined || base === undefined || current === undefined) continue
            scheduleActivity(withExternalDelegations({ ...base, status: current.status }, factsForTool(toolCallId)))
          }
        }
        // Interrupt only the ACP execution. The native turn remains alive and
        // owns the queued message, its pre-step hooks, and its eventual commit.
        // No second prompt may cross the wire before the first one settles.
        const inputAbort = new AbortController()
        const promptSignal =
          options.signal === undefined ? inputAbort.signal : AbortSignal.any([options.signal, inputAbort.signal])
        const terminalSettlementWait = self.settlementWaitSignal(
          sessionKey,
          session === undefined ? undefined : (session.identity ?? session),
          options.signal,
        )
        terminalSettlementLifetime = terminalSettlementWait.dispose
        const terminalSettlementClose = new AbortController()
        const terminalSettlementSignal = AbortSignal.any([
          terminalSettlementWait.signal,
          terminalSettlementClose.signal,
        ])
        let interruptedForInput = false
        let remoteSettled = false
        let teammateReportEligible = true
        let teammateReportConfirmed = false
        let turnConclusionEligible = true
        let turnConclusionConfirmed = false
        let successfulToolResultEligible = true
        let successfulToolResultConfirmed = false
        handoff.cancel = () => {
          inputAbort.abort(new Error('ACP stream consumer ended'))
        }
        const settlementAbandonReason = new DOMException('ACP stream consumer ended', 'AbortError')
        handoff.abandon = () => {
          terminalSettlementClose.abort(settlementAbandonReason)
        }
        const watchInput = (): (() => void) | undefined =>
          session?.watchSteering?.(() => {
            if (remoteSettled || promptSignal.aborted) return
            if (runtime.canSteer === true && runtime.steer !== undefined) {
              handoff.request()
              return
            }
            interruptedForInput = true
            inputAbort.abort(new Error('ACP interrupted for pending DSH input'))
          })
        let stopWatchingInput = watchInput()
        handoff.resume = async (nextOptions) => {
          let nextProof: CurrentStepProof | undefined
          let nextPrompt: acp.ContentBlock[]
          try {
            const nextMessages = admitCurrentStep(nextOptions, session, (proof) => {
              nextProof = proof
            })
            if (nextProof?.turn !== admissionProof?.turn) return false
            const modelContextSnapshots = session?.currentModelContextSnapshots?.()
            nextPrompt = await toAcpPrompt(nextMessages, {
              system: hostSystemPrompt(nextOptions),
              ...(modelContextSnapshots === undefined ? {} : { modelContextSnapshots }),
              skillRoute: skillRouteForTools(nextOptions.tools),
              imageEnabled: runtime.agentCapabilities?.promptCapabilities?.image === true,
              ...(self.attachments === undefined ? {} : { attachments: self.attachments }),
              signal: promptSignal,
            })
            if (nextPrompt.length === 0) throw new AcpPromptContentError('Steering input contains no supported content')
            if (remoteSettled || runtime.canSteer !== true || runtime.steer === undefined) return false
            // Finish notifications already admitted before the steering request.
            // Agents may emit new tools before acknowledging injection, so the
            // request boundary, rather than its response, owns their projection.
            await contentDeliveryTail
            if (remoteSettled) return false
          } catch (error) {
            throw new SteeringFailure(error, false)
          }
          const previousAnchor = currentAnchor
          const previousOffset = activityIndexOffset
          const previousSegment = contentSegment
          const previousReportEligible = teammateReportEligible
          const previousReportConfirmed = teammateReportConfirmed
          const previousTurnConclusionEligible = turnConclusionEligible
          const previousTurnConclusionConfirmed = turnConclusionConfirmed
          const previousSuccessfulToolResultEligible = successfulToolResultEligible
          const previousSuccessfulToolResultConfirmed = successfulToolResultConfirmed
          const previousRemoteCancellationHook = remoteCancellationHook
          let projectedAtDispatch = false
          let segmentBoundaryVersion = contentBreakVersion
          let segmentBoundaryIndex = nextContentIndex
          const applyProjectionAtDispatch = (): void => {
            projectedAtDispatch = true
            remoteCancellationHook = captureRemoteCancellationHook(nextProof)
            currentAnchor = nextProof!.anchorMessageId
            // A pending pull may contain the old segment's final text. It will
            // occupy a block in the next native reply before injected output.
            activityIndexOffset = Math.min(
              nextContentIndex,
              handoff.pendingIndex ?? nextContentIndex,
              ...queue.flatMap((chunk) => ('index' in chunk ? [chunk.index] : [])),
            )
            breakContent()
            segmentBoundaryVersion = contentBreakVersion
            segmentBoundaryIndex = nextContentIndex
            teammateReportEligible = false
            teammateReportConfirmed = false
            turnConclusionEligible = false
            turnConclusionConfirmed = false
            successfulToolResultEligible = false
            successfulToolResultConfirmed = false
          }
          const restoreProjection = (): void => {
            remoteCancellationHook = previousRemoteCancellationHook
            currentAnchor = previousAnchor
            activityIndexOffset = previousOffset
            teammateReportEligible = previousReportEligible
            teammateReportConfirmed = previousReportConfirmed
            turnConclusionEligible = previousTurnConclusionEligible
            turnConclusionConfirmed = previousTurnConclusionConfirmed
            successfulToolResultEligible = previousSuccessfulToolResultEligible
            successfulToolResultConfirmed = previousSuccessfulToolResultConfirmed
            // Restore the prior text segment only when nothing arrived after
            // the request boundary; never revisit an index already emitted.
            if (
              projectedAtDispatch &&
              contentBreakVersion === segmentBoundaryVersion &&
              nextContentIndex === segmentBoundaryIndex &&
              contentSegment === undefined
            )
              contentSegment = previousSegment
          }
          let result: 'injected' | 'promptRequired'
          try {
            result = await runtime.steer(nextPrompt, applyProjectionAtDispatch)
          } catch (error) {
            // From the point the RPC is invoked, rejection no longer proves
            // whether the Agent accepted the injected prompt. Only the concrete
            // connection marker can prove it failed before SDK dispatch.
            const remoteRequestSent = !(error instanceof AcpSteeringRequestError) || error.remoteRequestSent
            if (!remoteRequestSent) restoreProjection()
            throw new SteeringFailure(error, remoteRequestSent)
          }
          if (result === 'injected' && !projectedAtDispatch)
            throw new SteeringFailure(new Error('ACP steering runtime did not confirm its dispatch boundary'), true)
          if (result !== 'injected') {
            restoreProjection()
            return false
          }
          // A racing later insertion gets its own native admission boundary.
          stopWatchingInput?.()
          stopWatchingInput = watchInput()
          return true
        }
        // This callback is host-owned evidence from a completed native send_message.
        // Steering a newly admitted request disables the evidence for this prompt.
        const promptResult = runtime.prompt(
          prompt,
          onUpdate,
          promptSignal,
          () => {
            if (teammateReportEligible) teammateReportConfirmed = true
          },
          () => {
            if (turnConclusionEligible) turnConclusionConfirmed = true
          },
          () => {
            if (successfulToolResultEligible) successfulToolResultConfirmed = true
          },
        )
        self.controlsChanged?.(sessionKey)
        const waitForKnownTerminalSettlement = async (): Promise<void> => {
          try {
            await waitForLocalSettlement(self.hostRoot ?? self, sessionKey, terminalSettlementSignal)
            if (terminalSettlementSignal.aborted) throw abortReason(terminalSettlementSignal)
          } catch (error) {
            // Record only an error proven to come from this local waiter. A
            // remote prompt can independently reject with the same signal's
            // reason, and must still propagate as a provider failure.
            if (terminalSettlementSignal.aborted && error === abortReason(terminalSettlementSignal))
              handoff.localSettlementAbortReason = error
            throw error
          }
        }
        const settleKnownRemoteTerminalAndWait = async (): Promise<AcpBindingData | undefined> => {
          const settling = settleKnownRemoteTerminal()
          try {
            // Let the first short, foreground local batch finish even when the
            // remote prompt was cancelled. Only a retained background retry is
            // a cancellable wait; a successful known-terminal settle must land
            // before the aborted consumer returns.
            return await settling
          } catch (error) {
            if (!(error instanceof AcpLocalSettlementError)) throw error
            await waitForKnownTerminalSettlement()
            return committedBindingAfterSettle
          }
        }
        const handlePromptResponse = async (
          response: acp.PromptResponse,
          settlementAlreadyComplete = false,
        ): Promise<void> => {
          remoteSettled = true
          stopWatchingInput?.()
          if (response.stopReason === 'cancelled') self.markConfirmedUserModeForRestore(sessionKey, runtime)
          const confirmedRemoteCancellation =
            response.stopReason === 'cancelled' &&
            options.signal?.aborted !== true &&
            !promptSignal.aborted &&
            !interruptedForInput
          const unresolvedActivityStatus =
            response.stopReason === 'cancelled' || options.signal?.aborted === true ? 'cancelled' : 'unfinished'
          try {
            await contentDeliveryTail
            finishExternalDelegations()
            settleRunningActivities(unresolvedActivityStatus)
            await activityWriteTail
            // Keep the native turn open until the known terminal response has
            // been durably settled. A local write failure waits on its retained
            // task; it never turns the already completed ACP prompt into recovery.
            const committedBinding = settlementAlreadyComplete
              ? committedBindingAfterSettle
              : await settleKnownRemoteTerminalAndWait()
            const projectAfterFinish = async (): Promise<void> => {
              if (committedBinding === undefined || self.projectExternalDelegation === undefined) return
              for (const delegation of externalDelegations) {
                try {
                  const childSessionId = await self.projectExternalDelegation(delegation, {
                    profileId: self.profileId,
                    bindingGeneration: committedBinding.generation,
                    rootAcpSessionId: committedBinding.agentSessionId,
                    parentDshSessionId: sessionKey,
                    parentCwd: canonicalCwd,
                    ...(session?.header?.delegationDepth === undefined
                      ? {}
                      : { parentDelegationDepth: session.header.delegationDepth }),
                  })
                  if (childSessionId !== undefined) {
                    scheduleActivity({
                      activityId: `delegated-record:${delegation.vendorDelegationKey}`,
                      kind: 'delegated',
                      status: 'completed',
                      presentation: delegation.label,
                      rawDetail: activityRawDetail({
                        projectedChildSessionId: childSessionId,
                        resultCompleteness: delegation.result.completeness,
                        ...(delegation.sourceToolCallId === undefined
                          ? {}
                          : { sourceToolCallId: delegation.sourceToolCallId }),
                      }),
                    })
                  }
                } catch (error) {
                  scheduleActivity({
                    activityId: `delegated-record:${delegation.vendorDelegationKey}`,
                    kind: 'delegated',
                    status: 'failed',
                    presentation: delegation.label,
                    rawDetail: activityRawDetail({
                      projection: 'unavailable',
                      reason: error instanceof Error ? error.message : String(error),
                      ...(delegation.sourceToolCallId === undefined
                        ? {}
                        : { sourceToolCallId: delegation.sourceToolCallId }),
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
                  await durableSidecar.append(sessionKey as never, {
                    kind: 'degradation',
                    data: {
                      code: 'activity-head-unavailable',
                      items: [{ type: 'activity-head', reason: 'activity cursor could not be read at turn finish' }],
                      keptPreviewChars: 0,
                      truncated: false,
                    },
                  })
                } catch {
                  /* best effort diagnostic */
                }
              }
            }
            await writeUnsupportedChunkAudit()
            const replayPayload =
              (response.stopReason === 'cancelled' && !confirmedRemoteCancellation) ||
              committedBinding === undefined ||
              committedBinding.agentSessionId.length === 0
                ? undefined
                : {
                    kind: 'dsh-acp' as const,
                    version: 1 as const,
                    ownerDshSessionId: sessionKey,
                    profileId: self.profileId,
                    profileGeneration: committedBinding.generation,
                    agentSessionId: committedBinding.agentSessionId,
                    bindingEpoch: committedBinding.bindingEpoch ?? committedBinding.generation,
                    launchFingerprint: acpCanonicalHash16(committedBinding.launchFingerprint),
                    committedPromptOrdinal: committedBinding.committedPromptOrdinal ?? 0,
                    committedActivitySeq,
                    ...(admissionProof?.anchorMessageId === undefined
                      ? {}
                      : { activityAnchorMessageId: admissionProof.anchorMessageId }),
                  }
            let responseLocale: string | undefined
            if (response.stopReason === 'refusal' || response.stopReason === 'max_turn_requests') {
              try {
                responseLocale = self.resolveQuestions?.(sessionKey)?.locale
              } catch {
                /* locale lookup is presentation-only and cannot change a settled prompt outcome */
              }
            }
            const responseFinish =
              interruptedForInput &&
              options.signal?.aborted !== true &&
              response.stopReason !== 'refusal' &&
              response.stopReason !== 'max_turn_requests'
                ? { kind: 'stop' as const }
                : finishReason(String(response.stopReason), responseLocale)
            // ACP deliberately separates private reasoning from the visible
            // assistant answer.  A successful turn that only emitted
            // agent_thought_chunk is therefore not a usable DSH answer.  Do not
            // promote reasoning to text (or guess a trailing sentence); surface
            // a stable provider error so DSH does not present an apparently
            // successful, answer-less turn.
            const hasCompletedReport =
              response.stopReason === 'end_turn' &&
              teammateReportConfirmed &&
              !promptSignal.aborted &&
              options.signal?.aborted !== true
            const hasConcludedTurnTool =
              response.stopReason === 'end_turn' &&
              turnConclusionConfirmed &&
              !promptSignal.aborted &&
              options.signal?.aborted !== true
            const hasSuccessfulToolResult =
              response.stopReason === 'end_turn' &&
              successfulToolResultConfirmed &&
              !promptSignal.aborted &&
              options.signal?.aborted !== true
            // This records a delivered Host tool result, not completion of the user's broader task.
            const finalReason =
              responseFinish.kind === 'stop' &&
              !visibleContentEmitted &&
              !interruptedForInput &&
              !hasCompletedReport &&
              !hasConcludedTurnTool &&
              !hasSuccessfulToolResult
                ? {
                    kind: 'error' as const,
                    failure: {
                      code: 'ACP_NO_VISIBLE_RESPONSE',
                      message: 'ACP agent completed without a visible response',
                    },
                  }
                : responseFinish
            // Start the projection transaction before publishing finish so its
            // canonical sidecar payload is already durable if the host exits.
            // The projector then waits at its parent barrier until DSH consumes
            // this finish and durably closes the parent turn. Projection is an
            // additive record and must never delay or rewrite the Agent answer.
            void projectAfterFinish()
            if (response.stopReason === 'cancelled') {
              handoff.afterTerminalFinish(async () => {
                // Only a vendor-initiated cancellation is mirrored into the
                // native AgentLoop. User Stop and normal input steering already
                // own their native cancellation boundary.
                if (
                  confirmedRemoteCancellation &&
                  options.signal?.aborted !== true &&
                  !promptSignal.aborted &&
                  !interruptedForInput
                )
                  remoteCancellationHook?.()
                await cancelledRuntimeRetirement
              })
            }
            pushChunk({
              type: 'finish',
              reason: finalReason,
              ...(replayPayload === undefined ? {} : { replayState: { response: replayPayload } }),
            })
            if (response.stopReason === 'cancelled') {
              // Retire the vendor process after response settlement. This also
              // runs for native Stop, whose aborted consumer may never request
              // another iterator item to acknowledge the finish callback.
              cancelledRuntimeRetirement = (async () => {
                try {
                  await runtime.retireCancelledSession?.()
                } catch {
                  try {
                    self.log?.('ACP cancelled runtime cleanup failed')
                  } catch {
                    /* cleanup diagnostics cannot change persisted output */
                  }
                }
              })()
            }
          } catch (error: unknown) {
            settleRunningActivities(unresolvedActivityStatus)
            await activityWriteTail
            if (terminalSettlementSignal.aborted) {
              // Even if response projection failed before the first settle
              // call, this confirmed remote terminal still needs a retained
              // local task. Start/retain it without making Stop wait for I/O.
              if (localSettlementTask === undefined) void settleKnownRemoteTerminal().catch(() => undefined)
              retainHealthyRuntimeAfterNotDispatched = true
              failure = abortReason(terminalSettlementSignal)
              return
            }
            let localSettlementFailure: unknown = error instanceof AcpLocalSettlementError ? error : undefined
            try {
              if (localSettlementFailure === undefined) await settleKnownRemoteTerminalAndWait()
              else {
                await waitForKnownTerminalSettlement()
                localSettlementFailure = undefined
              }
            } catch (settlementError) {
              localSettlementFailure = settlementError
            }
            if (terminalSettlementSignal.aborted) {
              if (localSettlementTask === undefined) void settleKnownRemoteTerminal().catch(() => undefined)
              retainHealthyRuntimeAfterNotDispatched = true
              failure = abortReason(terminalSettlementSignal)
              return
            }
            retainHealthyRuntimeAfterNotDispatched = true
            failure =
              localSettlementFailure === undefined
                ? new LlmError(
                    'The ACP Agent completed, but the response could not be projected into the DSH turn.',
                    'ACP_RESPONSE_PROJECTION_FAILED',
                    { cause: error },
                  )
                : new LlmError(
                    localSettlementFailure instanceof Error
                      ? localSettlementFailure.message
                      : 'ACP results are not saved yet; local storage will retry automatically.',
                    'ACP_LOCAL_SETTLEMENT_FAILED',
                    { cause: localSettlementFailure },
                  )
          } finally {
            done = true
            wake?.()
            wake = undefined
          }
        }
        const prompting = promptResult.then(handlePromptResponse, async (error: unknown) => {
          remoteSettled = true
          stopWatchingInput?.()
          const settlementFailure = error instanceof AcpHostSettlementError ? error : undefined
          if (
            settlementFailure?.code === 'ACP_HOST_FEEDBACK_COMMIT_FAILED' &&
            settlementFailure.remoteOutcomeKnown === true
          ) {
            const response = settlementFailure.remoteResponse
            if (response !== undefined) {
              if (response.stopReason === 'cancelled') self.markConfirmedUserModeForRestore(sessionKey, runtime)
              try {
                await settleKnownRemoteTerminalAndWait()
                await handlePromptResponse(response, true)
              } catch (settlementError) {
                if (terminalSettlementSignal.aborted) {
                  retainHealthyRuntimeAfterNotDispatched = true
                  failure = abortReason(terminalSettlementSignal)
                  done = true
                  wake?.()
                  wake = undefined
                  return
                }
                await contentDeliveryTail.catch(() => undefined)
                await writeUnsupportedChunkAudit()
                finishExternalDelegations()
                settleRunningActivities(options.signal?.aborted === true ? 'cancelled' : 'unfinished')
                await activityWriteTail
                retainHealthyRuntimeAfterNotDispatched = true
                failure = new LlmError(
                  settlementError instanceof Error
                    ? settlementError.message
                    : 'ACP results are not saved yet; local storage will retry automatically.',
                  'ACP_LOCAL_SETTLEMENT_FAILED',
                  { cause: settlementError },
                )
                done = true
                wake?.()
                wake = undefined
              }
              return
            }
            try {
              await settleKnownRemoteTerminal()
              retainHealthyRuntimeAfterNotDispatched = true
              failure = new LlmError(
                'The ACP Agent completed, but its response could not be recovered to finish the turn.',
                'ACP_HOST_FEEDBACK_COMMIT_FAILED',
                { cause: error },
              )
            } catch (settlementError) {
              retainHealthyRuntimeAfterNotDispatched = true
              failure = new LlmError(
                settlementError instanceof Error
                  ? settlementError.message
                  : 'ACP results are not saved yet; local storage will retry automatically.',
                'ACP_LOCAL_SETTLEMENT_FAILED',
                { cause: settlementError },
              )
            }
            done = true
            wake?.()
            wake = undefined
            return
          }
          await contentDeliveryTail.catch(() => undefined)
          await writeUnsupportedChunkAudit()
          finishExternalDelegations()
          settleRunningActivities(options.signal?.aborted === true ? 'cancelled' : 'unfinished')
          await activityWriteTail
          // `auth_required` is a definitive JSON-RPC rejection, not an
          // ambiguous transport loss: the Agent confirmed that it did not run
          // the prompt. Keep the binding for an explicit reconnect after login,
          // but do not tell the user that the prior outcome is unknown.
          const authenticationRequired = error instanceof AcpClientError && error.kind === 'auth_required'
          if (settlementFailure?.code === 'ACP_HOST_TOOL_NOT_DISPATCHED') {
            try {
              await settleKnownRemoteTerminal()
              retainHealthyRuntimeAfterNotDispatched = true
              failure = new LlmError(
                'The ACP Agent ended its response before the DSH Host tool was dispatched',
                'ACP_HOST_TOOL_NOT_DISPATCHED',
                { cause: error },
              )
            } catch (settlementError) {
              retainHealthyRuntimeAfterNotDispatched = true
              failure = new LlmError(
                settlementError instanceof Error
                  ? settlementError.message
                  : 'ACP results are not saved yet; local storage will retry automatically.',
                'ACP_LOCAL_SETTLEMENT_FAILED',
                { cause: settlementError },
              )
            }
            done = true
            wake?.()
            wake = undefined
            return
          }
          const reconciliationRequired =
            settlementFailure?.code === 'ACP_HOST_TOOL_RECONCILIATION_REQUIRED' ||
            settlementFailure?.code === 'ACP_HOST_FEEDBACK_COMMIT_FAILED'
          const recoveryState: AcpRecoveryState = {
            dshSessionId: sessionKey,
            kind: authenticationRequired
              ? 'reconnect-required'
              : reconciliationRequired
                ? 'reconciliation-required'
                : 'outcome-unknown',
            cause: authenticationRequired ? 'auth-required' : 'load-failed',
            detail: authenticationRequired
              ? 'The ACP Agent rejected the prompt because authentication is required. Sign in to the Agent, then reconnect this session.'
              : settlementFailure?.code === 'ACP_HOST_FEEDBACK_COMMIT_FAILED'
                ? 'The ACP tool feedback commit into the native Agent inbox could not be confirmed; inspect the Agent session before continuing.'
                : reconciliationRequired
                  ? 'The ACP Agent ended its response while a DSH Host tool was still executing; inspect both sides before continuing.'
                  : settlementFailure?.code === 'ACP_HOST_CALL_DRAIN_TIMEOUT'
                    ? 'ACP prompt ended while a DSH Host tool was still active and its outcome could not be confirmed.'
                    : 'ACP prompt ended before its remote outcome was confirmed',
            provider: options.provider,
            ...(runtime.acpSessionId === undefined ? {} : { acpSessionId: runtime.acpSessionId }),
            updatedAt: Date.now(),
          }
          try {
            if (self.sidecar === undefined) throw new Error('ACP sidecar unavailable')
            await self.sidecar?.writeRecoveryState(recoveryState)
          } catch {
            self.rememberRecoveryFallback(recoveryState)
          }
          await self.releaseRuntime(runtimeKey, runtime)
          failure =
            settlementFailure === undefined
              ? error
              : new LlmError(
                  recoveryState.detail!,
                  reconciliationRequired ? 'ACP_RECONCILIATION_REQUIRED' : 'ACP_RECOVERY_REQUIRED',
                  { cause: error },
                )
          done = true
          wake?.()
          wake = undefined
        })
        void prompting
        try {
          while (!done || queue.length > 0) {
            if (queue.length === 0)
              await new Promise<void>((resolve) => {
                wake = resolve
              })
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
          stopWatchingInput?.()
          terminalSettlementWait.dispose()
          // AgentLoop closes the iterator as soon as an aborted turn observes a
          // final ACP update. Keep return() pending until the matching prompt has
          // confirmed cancellation and its dispatch record is durably settled;
          // otherwise an immediate next turn can see a false uncertain outcome.
          if (options.signal?.aborted === true) {
            await prompting
            await cancelledRuntimeRetirement
          }
        }
      } catch (error: unknown) {
        terminalSettlementLifetime?.()
        // Setup/read/recovery gates can fail after initialize has spawned the
        // Agent. Existing classified failure paths may already have released it.
        if (!retainHealthyRuntimeAfterNotDispatched && !retainCancelledRuntimeForRefreshRetry)
          await self.releaseRuntime(runtimeKey, runtime)
        throw error
      }
    })()
  }

  private canonicalCwd(cwd: string | undefined): string {
    if (cwd === undefined || cwd.length === 0)
      throw new LlmError('ACP requires the DSH session working directory', 'ACP_SESSION_CWD_UNAVAILABLE')
    try {
      return fs.realpathSync.native(cwd)
    } catch {
      return path.resolve(cwd)
    }
  }

  private async launchFingerprint(profile: AcpStubAgentConfig) {
    return acpLaunchFingerprint({ profileId: this.profileId, config: profile })
  }

  private async blockRecovery(
    sessionId: string,
    state: Omit<AcpRecoveryState, 'dshSessionId' | 'updatedAt'>,
    binding?: { readonly provider?: string; readonly agentSessionId?: string; readonly generation?: number },
    errorCode = 'ACP_RECONCILIATION_REQUIRED',
  ): Promise<never> {
    const recovery: AcpRecoveryState = {
      dshSessionId: sessionId,
      ...state,
      ...(binding?.provider === undefined ? {} : { provider: binding.provider }),
      ...(binding?.agentSessionId === undefined ? {} : { acpSessionId: binding.agentSessionId }),
      ...(binding?.generation === undefined ? {} : { generation: binding.generation }),
      updatedAt: Date.now(),
    }
    try {
      if (this.sidecar === undefined) throw new Error('ACP sidecar is unavailable')
      await this.sidecar.writeRecoveryState(recovery)
    } catch (error: unknown) {
      this.rememberRecoveryFallback(recovery)
      throw new LlmError(
        `ACP recovery state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
        'ACP_RECOVERY_STATE_UNAVAILABLE',
      )
    }
    throw new LlmError(state.detail ?? 'ACP session requires recovery before another prompt', errorCode)
  }

  private async refreshBindingHead(
    sessionId: string,
    session: SessionLike | undefined,
    settlementTarget?: BindingSettlementCommit,
  ): Promise<AcpBindingData | undefined> {
    if (this.sidecar === undefined) {
      if (settlementTarget !== undefined) throw new Error('ACP sidecar is unavailable for terminal binding commit')
      return undefined
    }
    if (session === undefined && settlementTarget === undefined) return undefined
    const current = await this.sidecar.readLatestBinding(sessionId as never)
    if (current?.status !== 'ok') {
      if (settlementTarget !== undefined) throw new Error('ACP binding disappeared before terminal settlement')
      return undefined
    }
    if (settlementTarget !== undefined) {
      const binding = current.binding
      const identityMatches =
        binding.profileId === settlementTarget.profileId &&
        binding.agentSessionId === settlementTarget.agentSessionId &&
        binding.generation === settlementTarget.generation &&
        (binding.bindingEpoch ?? binding.generation) === settlementTarget.bindingEpoch
      if (!identityMatches) throw new Error('ACP binding identity changed before terminal settlement')
      const ordinal = binding.committedPromptOrdinal ?? 0
      if (ordinal === settlementTarget.targetPromptOrdinal) {
        if (binding.dshCommittedSeq < settlementTarget.dshCommittedSeq) {
          const repaired: AcpBindingData = {
            ...binding,
            dshCommittedSeq: settlementTarget.dshCommittedSeq,
          }
          await this.sidecar.append(sessionId as never, { kind: 'binding', data: repaired })
          return repaired
        }
        return binding
      }
      if (ordinal !== settlementTarget.basePromptOrdinal)
        throw new Error('ACP binding prompt ordinal advanced while terminal settlement was pending')
      const next: AcpBindingData = {
        ...binding,
        dshCommittedSeq: Math.max(binding.dshCommittedSeq, settlementTarget.dshCommittedSeq),
        committedPromptOrdinal: settlementTarget.targetPromptOrdinal,
      }
      await this.sidecar.append(sessionId as never, { kind: 'binding', data: next })
      return next
    }
    const head = Math.max((session?.seq ?? 0) - 1, current.binding.dshCommittedSeq)
    const next: AcpBindingData = {
      ...current.binding,
      dshCommittedSeq: Math.max(head, current.binding.dshCommittedSeq),
      committedPromptOrdinal: (current.binding.committedPromptOrdinal ?? 0) + 1,
    }
    await this.sidecar.append(sessionId as never, { kind: 'binding', data: next })
    return next
  }

  private async readBindingSettlementTarget(sessionId: string): Promise<BindingSettlementTarget | undefined> {
    const current = await this.sidecar?.readLatestBinding(sessionId as never)
    if (current?.status !== 'ok') return undefined
    const binding = current.binding
    const basePromptOrdinal = binding.committedPromptOrdinal ?? 0
    return {
      profileId: binding.profileId,
      agentSessionId: binding.agentSessionId,
      generation: binding.generation,
      bindingEpoch: binding.bindingEpoch ?? binding.generation,
      basePromptOrdinal,
      targetPromptOrdinal: basePromptOrdinal + 1,
      baseDshCommittedSeq: binding.dshCommittedSeq,
    }
  }

  private localSettlementSink(): AcpLocalSettlementSink {
    return {
      settleDispatch: (sessionId, key) => this.ledger.settle(sessionId, key),
      readDispatch: (sessionId, key) => this.ledger.read(sessionId, key),
      writeRuntimeSnapshot: async (sessionId, snapshot) => {
        if (this.sidecar === undefined) throw new Error('ACP sidecar is unavailable for terminal snapshot persistence')
        await this.sidecar.writeOptionSnapshot(sessionId as never, snapshot)
      },
      refreshBindingHead: (sessionId, session, target) => this.refreshBindingHead(sessionId, session, target),
    }
  }

  private settlementWaitSignal(
    sessionId: string,
    owner: object | undefined,
    requestSignal?: AbortSignal,
  ): { readonly signal: AbortSignal; readonly dispose: () => void } {
    const controller = new AbortController()
    let waiters = this.settlementSessionWaitControllers.get(sessionId)
    if (waiters === undefined) this.settlementSessionWaitControllers.set(sessionId, (waiters = new Set()))
    const entry = { owner, controller }
    waiters.add(entry)
    const signal = AbortSignal.any([
      this.settlementCloseController.signal,
      controller.signal,
      ...(requestSignal ? [requestSignal] : []),
    ])
    return {
      signal,
      dispose: () => {
        waiters.delete(entry)
        if (waiters.size === 0 && this.settlementSessionWaitControllers.get(sessionId) === waiters)
          this.settlementSessionWaitControllers.delete(sessionId)
      },
    }
  }

  /** Explicitly discard only ACP-side continuity; DSH history is untouched. */
  async rebindBlank(sessionId: string): Promise<void> {
    this.assertNoQuarantinedHostCalls(sessionId, true)
    if (this.sidecar === undefined)
      throw new LlmError(
        'ACP sidecar is unavailable; the blank rebind cannot be made durable',
        'ACP_BINDING_UNAVAILABLE',
      )
    const binding = await this.sidecar.readLatestBinding(sessionId as never)
    const nextGeneration = binding?.status === 'ok' ? binding.binding.generation + 1 : 1
    this.nextGenerations.set(sessionId, nextGeneration)
    await this.closeSessionRuntime(sessionId)
    this.assertNoQuarantinedHostCalls(sessionId, true)
    // Explicitly abandoning the old Agent context also resolves any
    // dispatch-uncertain guard; no remote prompt is retried automatically.
    const healthyState: AcpRecoveryState = {
      dshSessionId: sessionId as never,
      kind: 'healthy',
      ...(binding?.status === 'ok'
        ? { provider: binding.binding.provider, acpSessionId: binding.binding.agentSessionId }
        : {}),
      generation: nextGeneration,
      lastUserAction: 'rebind-blank',
      updatedAt: Date.now(),
    }
    try {
      await this.sidecar.writeRecoveryState(healthyState, { clearDispatch: true })
    } catch (error) {
      this.rememberRecoveryFallback({
        ...healthyState,
        kind: 'outcome-unknown',
        cause: 'load-failed',
        detail: 'Blank rebind did not complete durably; the previous ACP outcome still requires recovery.',
        updatedAt: Date.now(),
      })
      throw new LlmError('ACP blank rebind could not be completed durably', 'ACP_RECOVERY_STATE_UNAVAILABLE', {
        cause: error,
      })
    }
    if (this.hostRoot !== undefined) {
      clearHostExecutionOwners(this.hostRoot, sessionId)
      clearSharedRecoveryFallback(this.hostRoot, sessionId)
    }
    this.inMemoryRecoveryRequired.delete(sessionId)
    this.inMemoryRecoveryStates.delete(sessionId)
  }

  /** Allow a user-selected retry to reuse the original durable ACP binding. */
  async retryOriginal(sessionId: string): Promise<void> {
    this.assertNoQuarantinedHostCalls(sessionId, true)
    if (this.sidecar === undefined)
      throw new LlmError(
        'ACP sidecar is unavailable; the original binding cannot be restored',
        'ACP_BINDING_UNAVAILABLE',
      )
    const bindingResult = await this.sidecar.readLatestBinding(sessionId as never)
    if (bindingResult?.status !== 'ok')
      throw new LlmError('The original ACP binding is unavailable', 'ACP_BINDING_UNAVAILABLE')
    const binding = bindingResult.binding
    const profile = snapshotProfile(this.readConfig())
    const session = this.sessionOf(sessionId)
    if (profile === undefined || session === undefined)
      throw new LlmError('The original ACP profile or DSH session is unavailable', 'ACP_RECONCILIATION_REQUIRED')
    const cwd = this.canonicalCwd(session.header?.cwd)
    const fingerprint = await this.launchFingerprint(profile)
    if (binding.canonicalCwd !== cwd || !acpLaunchFingerprintsCompatible(binding.launchFingerprint, fingerprint)) {
      throw new LlmError(
        'The original ACP profile and working directory must be restored before retry',
        'ACP_RECONCILIATION_REQUIRED',
      )
    }
    if (!this.subprocess.ok) throw new LlmError(this.subprocess.message, 'ACP_SPAWN_FAILURE')
    // Retry only replaces runtimes owned by this DSH session. Other DSH
    // sessions must keep their live Agent processes untouched.
    await this.closeSessionRuntime(sessionId)
    this.assertNoQuarantinedHostCalls(sessionId, true)
    const generation: ProfileGeneration = {
      id: profileLaunchIdentityHash(this.profileId, profile),
      config: profile,
      probe: this.probeFactory(profile),
    }
    const runtimeKey = `${sessionId}:${generation.id}`
    const runtime = this.runtimeFactory(this.runtimeOptionsFor(sessionId, profile, cwd))
    this.runtimes.set(runtimeKey, runtime)
    this.runtimeOwners.set(runtime, session.identity ?? session)
    try {
      if (typeof runtime.restore !== 'function') throw new Error('ACP runtime cannot restore the original session')
      await runtime.restore(binding)
      if (this.runtimes.get(runtimeKey) !== runtime) throw new Error('ACP session was disposed during recovery')
      await this.persistRuntimeSnapshot(sessionId, runtime)
      // The user explicitly reviewed the uncertain outcome. Remove only the
      // durable dispatch guard; the ACP binding and all DSH history remain.
      const healthyState: AcpRecoveryState = {
        dshSessionId: sessionId as never,
        kind: 'healthy',
        provider: binding.provider,
        acpSessionId: binding.agentSessionId,
        generation: binding.generation,
        lastUserAction: 'retry-original',
        updatedAt: Date.now(),
      }
      await this.sidecar.writeRecoveryState(healthyState, { clearDispatch: true })
      if (this.hostRoot !== undefined) {
        clearHostExecutionOwners(this.hostRoot, sessionId)
        clearSharedRecoveryFallback(this.hostRoot, sessionId)
      }
      this.inMemoryRecoveryRequired.delete(sessionId)
      this.inMemoryRecoveryStates.delete(sessionId)
    } catch (error: unknown) {
      await this.releaseRuntime(runtimeKey, runtime)
      const detail = `ACP retry failed: ${error instanceof Error ? error.message : String(error)}`
      const missing = /(?:session[_ -]?)?(?:not[ -]?found|unknown[_ -]?session)|does not exist/i.test(detail)
      const capability = /cannot restore|does not advertise/i.test(detail)
      const recoveryFailure: AcpRecoveryState = {
        dshSessionId: sessionId as never,
        kind: missing ? 'session-lost' : capability ? 'reconciliation-required' : 'reconnect-required',
        cause: missing ? 'id-not-found' : capability ? 'capability-missing' : 'load-failed',
        detail,
        provider: binding.provider,
        acpSessionId: binding.agentSessionId,
        generation: binding.generation,
        updatedAt: Date.now(),
      }
      try {
        await this.sidecar.writeRecoveryState(recoveryFailure)
      } catch {
        this.rememberRecoveryFallback(recoveryFailure)
      }
      throw new LlmError(detail, missing ? 'ACP_SESSION_NOT_FOUND' : 'ACP_RETRY_FAILED')
    }
  }

  close(): Promise<void> {
    this.settlementCloseController.abort(new DOMException('Adapter closed', 'AbortError'))
    this.settlementSessionWaitControllers.clear()
    const retireSettlement = this.settlementOwnerDisposer?.() ?? Promise.resolve()
    this.settlementOwnerDisposer = undefined
    const handoffs = [...this.handoffs.entries()]
    for (const [key, owner] of handoffs) {
      this.detachHandoffOwner(key, owner)
      try {
        owner.stream.cancel?.()
      } catch {
        /* continue retiring the remaining owners */
      }
    }
    this.handoffs.clear()
    this.inMemoryRecoveryRequired.clear()
    this.confirmedUserModes.clear()
    this.admittedToolSchemas.clear()
    this.admittedToolSchemaOwners.clear()
    const keys = [...this.runtimes.keys()]
    const runtimes = [...this.runtimes.entries()]
    this.runtimes.clear()
    for (const key of keys) this.controlsChanged?.(key.slice(0, key.lastIndexOf(':')))
    return (async () => {
      await retireSettlement
      await Promise.all(
        runtimes.map(async ([key, runtime]) => {
          if (this.hostRoot !== undefined)
            retainHostExecutionOwner(this.hostRoot, key.slice(0, key.lastIndexOf(':')), runtime)
          await runtime.close()
        }),
      )
      await Promise.all(
        handoffs
          .map(([, owner]) => owner)
          .filter((owner) => owner.stream.suspended)
          .map((owner) => owner.stream.drain()),
      )
    })()
  }

  private async releaseRuntime(key: string, runtime: AcpProfileRuntime): Promise<void> {
    // An old asynchronous failure must not evict a replacement with the same key.
    if (this.runtimes.get(key) !== runtime) return
    if (this.hostRoot !== undefined)
      retainHostExecutionOwner(this.hostRoot, key.slice(0, key.lastIndexOf(':')), runtime)
    this.runtimes.delete(key)
    this.controlsChanged?.(key.slice(0, key.lastIndexOf(':')))
    await runtime.close().catch(() => undefined)
  }

  private assertNoQuarantinedHostCalls(sessionId: string, recoveryAction = false): void {
    if (this.hostRoot === undefined) return
    try {
      assertHostExecutionQuiescent(this.hostRoot, sessionId, recoveryAction)
    } catch (error) {
      throw new LlmError(
        'ACP Host tool execution is still active; wait for it to settle before recovery',
        'ACP_RECOVERY_REQUIRED',
        { cause: error },
      )
    }
  }

  private rememberRecoveryFallback(state: AcpRecoveryState): void {
    this.inMemoryRecoveryRequired.set(state.dshSessionId, state.updatedAt)
    this.inMemoryRecoveryStates.set(state.dshSessionId, state)
    if (this.hostRoot !== undefined) setSharedRecoveryFallback(this.hostRoot, state)
    try {
      this.controlsChanged?.(state.dshSessionId)
    } catch {
      /* the local gate remains authoritative if a UI subscriber fails */
    }
  }

  /** Release only the disposed host session's runtimes; keep its durable history. */
  async disposeSession(session: { readonly id: string; readonly identity?: object }): Promise<void> {
    const owner = session.identity ?? session
    const waiters = this.settlementSessionWaitControllers.get(session.id)
    if (waiters !== undefined) {
      for (const waiter of [...waiters]) {
        if (waiter.owner === owner) {
          waiter.controller.abort(new DOMException('Session disposed', 'AbortError'))
          waiters.delete(waiter)
        }
      }
      if (waiters.size === 0) this.settlementSessionWaitControllers.delete(session.id)
    }
    await this.closeSessionRuntime(session.id, owner)
    if (this.confirmedUserModes.get(session.id)?.owner === owner) this.confirmedUserModes.delete(session.id)
    if (this.admittedToolSchemaOwners.get(session.id) === owner) {
      this.admittedToolSchemaOwners.delete(session.id)
      this.admittedToolSchemas.delete(session.id)
    }
  }

  private async closeSessionRuntime(sessionId: string, owner?: object): Promise<void> {
    const keys = [...this.runtimes.keys()].filter((key) => key.startsWith(`${sessionId}:`))
    const handoff = this.handoffs.get(sessionId)
    if (
      handoff !== undefined &&
      (owner === undefined ||
        keys.some((key) => {
          const runtime = this.runtimes.get(key)
          return runtime !== undefined && this.runtimeOwners.get(runtime) === owner
        }))
    ) {
      handoff.off?.()
      handoff.stream.cancel?.()
      this.handoffs.delete(sessionId)
      // An active consumer owns its outstanding pull, including late setup
      // failure. Only abandoned suspended segments need a replacement consumer.
      if (handoff.stream.suspended)
        void handoff.stream.drain().catch((error) => this.log?.(`ACP disposed stream cleanup: ${String(error)}`))
    }
    await Promise.all(
      keys.map(async (key) => {
        const runtime = this.runtimes.get(key)
        if (runtime === undefined || (owner !== undefined && this.runtimeOwners.get(runtime) !== owner)) return
        await this.releaseRuntime(key, runtime)
      }),
    )
    if (owner === undefined || this.admittedToolSchemaOwners.get(sessionId) === owner) {
      this.admittedToolSchemaOwners.delete(sessionId)
      this.admittedToolSchemas.delete(sessionId)
    }
  }

  /** Build one immutable native launch/capability surface for every lifecycle path. */
  private runtimeOptionsFor(
    sessionId: string,
    profile: AcpStubAgentConfig,
    cwd: string,
  ): ConstructorParameters<typeof AcpSessionRuntime>[0] {
    if (!this.subprocess.ok) throw new LlmError(this.subprocess.message, 'ACP_SPAWN_FAILURE')
    const processSeam = this.subprocess.seam
    const runtime = effectiveRuntimeOf(this.profileId, profile)
    // ACP client-capability operations are external side effects too.  Keep
    // their bounded, secret-free summaries in the existing sidecar so the
    // audit view can distinguish "handler was never entered" from a handler
    // that entered and then failed I/O.  The callbacks intentionally swallow
    // sidecar outages: a completed file/terminal operation is still a fact,
    // and an audit partition outage must not turn it into a false ACP failure.
    const appendFileAudit =
      this.sidecar === undefined
        ? undefined
        : async (event: AcpFileSystemAuditData): Promise<void> => {
            try {
              await this.sidecar!.append(sessionId as never, { kind: 'filesystem', data: event })
            } catch {
              /* best effort after external I/O */
            }
          }
    const appendTerminalAudit =
      this.sidecar === undefined
        ? undefined
        : async (event: AcpTerminalAuditData): Promise<void> => {
            try {
              await this.sidecar!.append(sessionId as never, { kind: 'terminal', data: event })
            } catch {
              /* best effort after external process */
            }
          }
    const handlePermission = async (
      params: acp.RequestPermissionRequest,
      signal?: AbortSignal,
    ): Promise<acp.RequestPermissionResponse> => {
      const binding = this.resolveQuestions?.(sessionId)
      if (binding === undefined) return { outcome: { outcome: 'cancelled' } }
      const audit: AcpPermissionAuditChannel | undefined =
        this.sidecar === undefined
          ? undefined
          : { append: (record) => this.sidecar!.append(sessionId as never, record) }
      return await createAcpNativePermissionHandler({
        ...(binding.userQuestions === undefined ? {} : { userQuestions: binding.userQuestions }),
        ...(binding.approval === undefined ? {} : { approval: binding.approval }),
        getAgent: binding.getAgent,
        ...(binding.locale === undefined ? {} : { locale: binding.locale }),
        ...(audit === undefined ? {} : { audit }),
      })(params, signal)
    }
    return {
      profileId: this.profileId,
      diagnosticDshSessionId: sessionId,
      ...(runtime === 'codebuddy' ? { refreshSessionAfterCancelledPrompt: true } : {}),
      onHostSettlementChanged: () => this.controlsChanged?.(sessionId),
      ...sessionProtocolExtensions(runtime),
      ...(this.mcpKey === undefined
        ? {}
        : { mcpKey: () => this.mcpKey!(sessionId, this.admittedToolSchemas.get(sessionId)) }),
      ...(this.createMcpLease === undefined
        ? {}
        : {
            createMcpLease: (capabilities: acp.AgentCapabilities | undefined) =>
              this.createMcpLease!(sessionId, capabilities, runtime, this.admittedToolSchemas.get(sessionId)),
          }),
      ...(this.log === undefined
        ? {}
        : {
            onCapabilityDegraded: (message: string): void => {
              if (this.claudeDraftDegradationReported) return
              this.claudeDraftDegradationReported = true
              this.log?.(message)
            },
          }),
      config: profile,
      subprocess: processSeam,
      cwd,
      prepareLaunch: (config, launchCwd) =>
        prepareAgentLaunch(
          runtime,
          config as AcpStubAgentConfig,
          launchCwd,
          processSeam,
          this.createMcpLease === undefined
            ? undefined
            : (capabilities) =>
                this.createMcpLease!(sessionId, capabilities, runtime, this.admittedToolSchemas.get(sessionId)),
        ),
      createFileSystemHandlers: () =>
        createAcpFileSystemHandlers({
          profileId: this.profileId,
          ...(appendFileAudit === undefined ? {} : { audit: appendFileAudit }),
        }),
      createTerminalHandlers: ({ cwd: launchCwd, env }) =>
        createAcpTerminalHandlers({
          subprocess: processSeam,
          profileId: this.profileId,
          dshSessionId: sessionId,
          cwd: launchCwd,
          env,
          ...(this.terminalJobs === undefined ? {} : { startJob: this.terminalJobs(sessionId) }),
          ...(appendTerminalAudit === undefined ? {} : { audit: appendTerminalAudit }),
        }),
      onPermissionRequest: handlePermission,
      onPermissionCheck: async (check, request) => {
        await this.sidecar?.append(sessionId as never, {
          kind: 'permission',
          time: Date.now(),
          data: createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId),
        })
      },
      onElicitationRequest: async (
        params: acp.CreateElicitationRequest,
        signal?: AbortSignal,
        hostToolName?: string,
        hostToolCall?: acp.ToolCallUpdate,
      ): Promise<acp.CreateElicitationResponse> => {
        const binding = this.resolveQuestions?.(sessionId)
        if (binding?.userQuestions === undefined) return { action: 'cancel' }
        return await createAcpNativeElicitationHandler({
          userQuestions: binding.userQuestions,
          getAgent: binding.getAgent,
          ...(binding.locale === undefined ? {} : { locale: binding.locale }),
          ...(hostToolName === undefined ? {} : { hostToolName }),
          ...(hostToolName === undefined || hostToolCall === undefined || binding.approval === undefined
            ? {}
            : {
                approveDelegatedOnce: async (approvalSignal?: AbortSignal): Promise<boolean> => {
                  const scope = params as { sessionId?: unknown }
                  if (typeof scope.sessionId !== 'string') return false
                  const raw = hostToolCall.rawInput as { arguments?: unknown } | undefined
                  const response = await handlePermission(
                    {
                      sessionId: scope.sessionId,
                      toolCall: {
                        ...hostToolCall,
                        name: hostToolName,
                        title: hostToolName,
                        ...(hostToolName === 'bash' ? { kind: 'execute' as const } : {}),
                        rawInput: raw?.arguments ?? hostToolCall.rawInput,
                      },
                      options: [
                        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
                        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
                      ],
                    },
                    approvalSignal,
                  )
                  return response.outcome.outcome === 'selected' && response.outcome.optionId === 'once'
                },
              }),
        })(params, signal)
      },
      onSessionUpdate: (notification): void => {
        const kind = notification.update.sessionUpdate
        if (kind !== 'config_option_update' && kind !== 'current_mode_update' && kind !== 'usage_update') return
        // Keep the sidecar's last-known controls close to the ACP event. This
        // is a bounded write per protocol update (not a polling loop), so a
        // crash between turns still renders the most recently reported Agent
        // mode/context as stale instead of losing it entirely.
        const runtime = this.runtimeForSession(sessionId)
        if (runtime !== undefined && runtime.acpSessionId === notification.sessionId)
          void this.persistRuntimeSnapshot(sessionId, runtime)
      },
    }
  }
}
