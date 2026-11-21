import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { ReadStepToolAdmission } from './step-tool-admissions.ts'
import { ToolDirectoryOwner } from './tool-directory-owner.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { Server } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { AcpHostSettlementError } from '../../runtime/session/mcp-lease.ts'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'
import { rejectPermissionOnce, withDshTeamPermissionPresentation } from '../../domain/policy/permissions.ts'
import {
  isAntigravityInteractionCall,
  antigravityToolIdentity,
  antigravityTitledTool,
  antigravityPresentationTool,
} from '../../agents/antigravity.ts'
import { codeBuddyDeferredInput } from '../../agents/codebuddy.ts'
import { codexMcpInput, codexElicitationTool, codexConflictsWithTool } from '../../agents/codex.ts'
import { devinTitledTool, devinToolTitleHint } from '../../agents/devin.ts'
import { qualifiedMcpTool } from '../../agents/mcp-tool.ts'
import { toolContent } from './tool-content.ts'
import { generatedContextBlock } from '../../runtime/text-block-boundary.ts'
import { ToolExecutionScheduler } from './tool-execution-scheduler.ts'
import { waitWithin } from '../../runtime/process/timeout.ts'
import type {} from '../composition/live-diagnostics.ts'
import type {
  LiveDiagnosticErrorKind,
  LiveDiagnosticTrace,
  LiveDiagnosticTargetRole,
  LiveDiagnosticTool,
} from '../../contract/live-diagnostic-trace.ts'
import { performance } from 'node:perf_hooks'
import { normalizeAntigravityPresentation, resolveAntigravityNativeTool } from './antigravity.ts'
import { createTeamToolContext } from '../teams/tool-context.ts'
import { DEFERRED_WAIT_TEXT, DeferredWaitReceipts } from './deferred-wait-receipts.ts'
import { redactSecretText } from '../../contract/redaction.ts'
import { createAcpLogger } from '../../domain/observability/logging.ts'
import { toolDiscoveryInstructions } from '../../agents/compatibility.ts'

const TEAM_TOOLS = [
  'subagent',
  'subagent_fork',
  'subagent_oar',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const
function bridgeInstructions(names: ReadonlyMap<string, ToolSchema>): string {
  const skillRoute = names.has('skill')
    ? 'The DSH MCP tool "skill" is listed; access DSH skill-catalog entries through that tool using its exact tools/list schema and names.'
    : names.has(RUN_CODE_NAME)
      ? `No direct DSH skill tool is listed. If DSH skill access is exposed through the generated SDK, call it inside "${RUN_CODE_NAME}" using the host-provided SDK instructions and listed schema; do not invent a direct skill tool.`
      : 'No DSH skill-loading entry point is listed. Do not claim DSH skill-catalog entries are available through an Agent-native skill tool; explain that this DSH connection has no listed skill entry point.'
  return `These are native DSH tools available to this session. DSH sandbox and approval policies apply to these tools; your own Agent tools retain their separate policies. Use the exact tool names and schemas from tools/list. Tools and skills discovered in DSH context, including skill-catalog entries, must use this session's DSH MCP tools; do not route them through the Agent's native skill invocation or private skill directory, and do not copy DSH skill files into that directory. This does not replace or modify the Agent's own skills. Do not assume or expose tools or permissions absent from this DSH connection. ${skillRoute}`
}
const diagnosticTools = new Set<string>(TEAM_TOOLS)
const diagnosticErrorKinds = new Set<LiveDiagnosticErrorKind>([
  'ACP_PROTOCOL_ERROR',
  'ACP_RESOURCE_EXHAUSTED',
  'ACP_TIMEOUT',
  'ACP_ABORTED',
  'ACP_STEERING_OUTCOME_UNKNOWN',
  'ACP_TEAM_TOOL_FAILED',
  'TEAM_INVALID_ARGUMENT',
  'TEAM_INVALID_TARGET',
  'TEAM_SELF_MESSAGE',
  'TEAM_MAILBOX_FULL',
  'UNKNOWN_TOOL',
  'INVALID_ARGS',
  'TOOL_TIMEOUT',
])
function diagnosticTool(name: string): LiveDiagnosticTool {
  return diagnosticTools.has(name) ? (name as LiveDiagnosticTool) : 'other'
}
function diagnosticErrorKind(
  error: unknown,
  trace: LiveDiagnosticTrace | undefined,
): LiveDiagnosticErrorKind | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' && diagnosticErrorKinds.has(code as LiveDiagnosticErrorKind)
      ? (code as LiveDiagnosticErrorKind)
      : undefined
  } catch {
    trace?.noteFailure()
    return undefined
  }
}
function diagnosticInboxCounts(agent: NonNullable<ReturnType<typeof bridgeDefinitions>>['agent']) {
  try {
    const sourceCounts = (messages: readonly { readonly source?: { readonly kind?: unknown } }[]) => {
      const counts = { user: 0, 'team-message': 0, system: 0, other: 0 }
      for (const message of messages) {
        const kind = message.source?.kind
        // Keep the diagnostic wire bucket stable across the Host's mailbox → inbox migration.
        if (isPendingPeerMessage(message)) counts['team-message'] += 1
        else if (kind === 'user' || kind === 'system') counts[kind] += 1
        else counts.other += 1
      }
      return counts
    }
    const nextStep = agent.inbox.nextStep
    const nextTurn = agent.inbox.nextTurn
    const nextStepSources = sourceCounts(nextStep)
    const nextTurnSources = sourceCounts(nextTurn)
    return {
      nextStepCount: nextStep.length,
      nextTurnCount: nextTurn.length,
      nextStepTeamMessageCount: nextStepSources['team-message'],
      nextTurnTeamMessageCount: nextTurnSources['team-message'],
      nextStepSourceCounts: nextStepSources,
      nextTurnSourceCounts: nextTurnSources,
    }
  } catch {
    return undefined
  }
}
function hasSourceKind(value: unknown, kind: string): boolean {
  if (typeof value !== 'object' || value === null || !('source' in value)) return false
  const source = (value as { readonly source?: unknown }).source
  return typeof source === 'object' && source !== null && 'kind' in source && source.kind === kind
}
/** Current Agent inbox relay attribution, plus already persisted Team mailbox messages. */
function isPendingPeerMessage(value: unknown): boolean {
  if (hasSourceKind(value, 'team-message')) return true
  if (!hasSourceKind(value, 'agent-message')) return false
  const source = (value as { readonly source: { readonly form?: unknown; readonly senderSessionId?: unknown } }).source
  return source.form === 'relay' && typeof source.senderSessionId === 'string' && source.senderSessionId.length > 0
}
type FeedbackMessage = { readonly id?: unknown; readonly source?: unknown; readonly content?: unknown }
type FeedbackAgent = NonNullable<ReturnType<typeof bridgeDefinitions>>['agent']
type FeedbackBoundary = {
  readonly eventCount?: number
  readonly existingAccepted: boolean
}
type FeedbackContinuity = {
  readonly sessionId: string
  readonly eventCount: number
  readonly headerDigest: string
  readonly prefixDigest: string
  readonly lastUserMessage: { readonly id: string; readonly seq: number }
}
type FeedbackAcceptance = 'accepted' | 'missing' | 'unknown'

function toolErrorInfoCode(error: unknown): unknown {
  try {
    if (typeof error !== 'object' || error === null || !('info' in error)) return undefined
    const info = (error as { readonly info?: unknown }).info
    return typeof info === 'object' && info !== null && 'code' in info
      ? (info as { readonly code?: unknown }).code
      : undefined
  } catch {
    return undefined
  }
}

function feedbackMessageKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined
  const message = value as FeedbackMessage
  if (typeof message.id !== 'string' || message.id.length === 0) return undefined
  try {
    const stable = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(stable)
      if (item === null || typeof item !== 'object') return item
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, stable(entry)]),
      )
    }
    return JSON.stringify(stable({ id: message.id, source: message.source, content: message.content }))
  } catch {
    return undefined
  }
}

function canonicalJson(value: unknown): string | undefined {
  const ancestors = new WeakSet<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object') throw new TypeError('non-JSON value')
    if (ancestors.has(item)) throw new TypeError('cyclic value')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        const output: unknown[] = []
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new TypeError('sparse array')
          output.push(normalize(item[index]))
        }
        return output
      }
      const prototype = Reflect.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-plain object')
      const output = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(item).sort()) output[key] = normalize((item as Record<string, unknown>)[key])
      return output
    } finally {
      ancestors.delete(item)
    }
  }
  try {
    const json = JSON.stringify(normalize(value))
    return typeof json === 'string' ? json : undefined
  } catch {
    return undefined
  }
}

function digest(value: unknown): string | undefined {
  const json = canonicalJson(value)
  return json === undefined ? undefined : createHash('sha256').update(json, 'utf8').digest('hex')
}

/** Capture immutable continuity evidence only when an inject failure needs retention. */
function feedbackContinuityOf(sessionValue: unknown, eventCount: number | undefined): FeedbackContinuity | undefined {
  if (eventCount === undefined || typeof sessionValue !== 'object' || sessionValue === null) return undefined
  try {
    const session = sessionValue as {
      readonly id?: unknown
      readonly header?: { readonly id?: unknown }
      readonly seq?: unknown
      readonly snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly unknown[]
    }
    if (
      typeof session.id !== 'string' ||
      session.id.length === 0 ||
      session.header?.id !== session.id ||
      typeof session.seq !== 'number' ||
      !Number.isSafeInteger(session.seq) ||
      (session.seq as number) < eventCount ||
      typeof session.snapshotEvents !== 'function'
    )
      return undefined
    const headerDigest = digest(session.header)
    if (headerDigest === undefined) return undefined
    const prefix = session.snapshotEvents.call(sessionValue, 0, eventCount)
    if (!Array.isArray(prefix) || prefix.length !== eventCount) return undefined
    for (let index = 0; index < prefix.length; index++) {
      const event = prefix[index]
      if (typeof event !== 'object' || event === null || !('seq' in event) || event.seq !== index) return undefined
    }
    let lastUserMessage: FeedbackContinuity['lastUserMessage'] | undefined
    for (const event of prefix) {
      if (typeof event !== 'object' || event === null || !('type' in event) || event.type !== 'user/message') continue
      if (!('data' in event) || typeof event.data !== 'object' || event.data === null || !('id' in event.data))
        return undefined
      const id = event.data.id
      if (typeof id !== 'string' || id.length === 0 || !('seq' in event) || !Number.isSafeInteger(event.seq))
        return undefined
      lastUserMessage = { id, seq: event.seq as number }
    }
    if (lastUserMessage === undefined) return undefined
    const prefixDigest = digest(prefix)
    if (prefixDigest === undefined) return undefined
    return {
      sessionId: session.id,
      eventCount,
      headerDigest,
      prefixDigest,
      lastUserMessage,
    }
  } catch {
    return undefined
  }
}

function matchesFeedbackContinuity(session: unknown, expected: FeedbackContinuity | undefined): boolean {
  if (expected === undefined) return false
  const actual = feedbackContinuityOf(session, expected.eventCount)
  return (
    actual !== undefined &&
    actual.sessionId === expected.sessionId &&
    actual.eventCount === expected.eventCount &&
    actual.headerDigest === expected.headerDigest &&
    actual.prefixDigest === expected.prefixDigest &&
    actual.lastUserMessage.id === expected.lastUserMessage.id &&
    actual.lastUserMessage.seq === expected.lastUserMessage.seq
  )
}

function eventContainsFeedback(event: unknown, key: string): boolean {
  if (typeof event !== 'object' || event === null || !('type' in event) || !('data' in event)) return false
  const entry = event as { readonly type?: unknown; readonly data?: unknown }
  if (entry.type === 'user/message') return feedbackMessageKey(entry.data) === key
  if (entry.type !== 'agent/inbox/spliced' || typeof entry.data !== 'object' || entry.data === null) return false
  const inserted = (entry.data as { readonly inserted?: unknown }).inserted
  return Array.isArray(inserted) && inserted.some((message) => feedbackMessageKey(message) === key)
}

function inboxContainsFeedback(agent: FeedbackAgent, key: string): boolean | undefined {
  try {
    return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some((message) => feedbackMessageKey(message) === key)
  } catch {
    return undefined
  }
}

function feedbackBoundary(agent: FeedbackAgent, context: unknown): FeedbackBoundary {
  const key = feedbackMessageKey(context)
  if (key !== undefined && inboxContainsFeedback(agent, key) === true) return { existingAccepted: true }
  try {
    const eventCount = (agent.session as { readonly seq?: unknown }).seq
    if (typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0)
      return { eventCount, existingAccepted: false }
  } catch {
    /* An unavailable sequence boundary makes missing acceptance unprovable. */
  }
  return { existingAccepted: false }
}

function observeFeedbackAcceptance(
  agent: FeedbackAgent,
  context: unknown,
  boundary: FeedbackBoundary,
): FeedbackAcceptance {
  const key = feedbackMessageKey(context)
  if (key === undefined) return 'unknown'
  if (inboxContainsFeedback(agent, key) === true) return 'accepted'
  if (boundary.eventCount === undefined) return 'unknown'
  try {
    const session = agent.session as {
      readonly seq?: unknown
      snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly unknown[]
    }
    const currentSeq = session.seq
    if (
      typeof currentSeq !== 'number' ||
      !Number.isSafeInteger(currentSeq) ||
      currentSeq < boundary.eventCount ||
      session.snapshotEvents === undefined
    )
      return 'unknown'
    const delta = session.snapshotEvents.call(agent.session, boundary.eventCount, currentSeq)
    if (!Array.isArray(delta) || delta.length !== currentSeq - boundary.eventCount) return 'unknown'
    if (delta.some((event) => eventContainsFeedback(event, key))) return 'accepted'
    return 'missing'
  } catch {
    return 'unknown'
  }
}

function schemaValueKey(schemas: readonly ToolSchema[]): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
  return JSON.stringify(
    [...schemas].sort((left, right) => left.name.localeCompare(right.name)).map((schema) => stable(schema)),
  )
}

function bridgeDefinitions(
  ctx: Context,
  sessionId: string,
  schemas: readonly ToolSchema[] | undefined,
  readAdmission?: ReadStepToolAdmission,
) {
  if (schemas === undefined) return undefined
  const agent = ctx.get('agents', false)?.get(sessionId as never)
  const tools = ctx.get('tools', false)
  if (agent === undefined || tools === undefined) return undefined
  const admission = readAdmission?.(agent)
  if (readAdmission !== undefined && admission === undefined) return undefined
  const teamContext = createTeamToolContext(ctx, agent)
  const visible = new Map<string, ToolSchema>()
  const duplicates = new Set<string>()
  for (const schema of schemas) {
    if (visible.has(schema.name)) duplicates.add(schema.name)
    else visible.set(schema.name, schema)
  }
  const definitions = new Map<string, ToolSchema>()
  const registrations = new Map<string, ToolDefinition>()
  // The request owns callable declarations: PTC's run_code is deliberately
  // outside the capability registry. Its nested calls still use this step's set.
  for (const [name, schema] of [...visible].sort(([left], [right]) => left.localeCompare(right))) {
    if (duplicates.has(name)) continue
    if (name === RUN_CODE_NAME) {
      definitions.set(name, schema)
      continue
    }
    const definition = admission === undefined ? tools.executable(name, agent) : admission.definitions.get(name)
    if (definition === undefined || tools.get(name, agent) !== definition) continue
    definitions.set(name, definition)
    registrations.set(name, definition)
  }
  const currentSchemaKey = schemaValueKey([...definitions.keys()].map((name) => visible.get(name)!))
  return definitions.size === 0
    ? undefined
    : { agent, tools, teamContext, definitions, registrations, visible, currentSchemaKey }
}

/** Registry-owned identity keys track scoped tool and visible schema changes. */
export function createDshToolBridgeKey(readAdmission?: ReadStepToolAdmission) {
  const identities = new WeakMap<object, number>()
  let nextIdentity = 0
  const identity = (value: object): number => {
    let id = identities.get(value)
    if (id === undefined) {
      id = ++nextIdentity
      identities.set(value, id)
    }
    return id
  }
  return (ctx: Context, sessionId: string, schemas?: readonly ToolSchema[]): unknown => {
    const bridge = bridgeDefinitions(ctx, sessionId, schemas, readAdmission)
    return bridge === undefined
      ? undefined
      : JSON.stringify([
          identity(bridge.agent),
          bridge.currentSchemaKey,
          ...[...bridge.registrations].map(([name, definition]) => [name, identity(definition)]),
        ])
  }
}

/**
 * Bridge the request's declared tools without enabling Host plugins. Production
 * callers pass the Host admission reader; omission permits only unconditional
 * registrations and executor-owned transport for standalone callers.
 */
const TOOL_FAILURE_DETAIL_MAX = 1_000

/** Report a batch failure by its cause; the wrapper message alone cannot be diagnosed. */
function toolFailureText(error: unknown): string {
  if (!(error instanceof Error)) return 'ACP_TEAM_TOOL_FAILED'
  const safe = (value: string) =>
    redactSecretText(value)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .slice(0, TOOL_FAILURE_DETAIL_MAX)
  if (!(error instanceof ToolBatchExecutionError)) return safe(error.message)
  const cause = error.cause
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return safe(detail.length === 0 ? error.message : `${error.message}: ${detail}`)
}

export async function createDshToolBridge(
  ctx: Context,
  sessionId: string,
  capabilities: acp.AgentCapabilities | undefined,
  wireProfile?: string,
  schemas?: readonly ToolSchema[],
  readAdmission?: ReadStepToolAdmission,
): Promise<AcpMcpLease | undefined> {
  const trace = ctx.get('acpLiveDiagnostics', false)
  const liveDiagnosticTraceEnabled = () => trace?.enabled() === true
  const liveDiagnosticId = (kind: string, value: unknown) => trace?.id(kind, value)
  const liveDiagnosticFingerprint = (kind: string, value: unknown) => trace?.fingerprint(kind, value)
  const collectLiveDiagnostic = <T>(factory: () => T): T | undefined => trace?.collect(factory)
  const emitLiveDiagnostic = (event: Parameters<LiveDiagnosticTrace['emit']>[0]) => trace?.emit(event)
  const agents = ctx.get('agents', false)
  const bridge = bridgeDefinitions(ctx, sessionId, schemas, readAdmission)
  if (bridge === undefined || agents === undefined) return undefined
  const { tools, agent, teamContext, definitions, registrations, visible } = bridge
  const hasTeams = teamContext !== undefined
  const lifetime = new AbortController()
  const directory = new ToolDirectoryOwner({
    agent,
    tools,
    definitions,
    registrations,
    lifetime: lifetime.signal,
    ...(readAdmission === undefined ? {} : { readAdmission }),
    // Cordis service lookup proxies do not establish actual owner identity.
    isConnectionAvailable: () =>
      ctx.get('tools', false) !== undefined &&
      ctx.get('agents', false)?.get(sessionId as never) === agent &&
      (teamContext?.isLive() ?? true),
  })
  const deferredWaitReceipts = new DeferredWaitReceipts(sessionId)
  const identifiedWaitCalls = new Set<string>()
  const waitCallsWithOtherContent = new Set<string>()
  const diagnosticLeaseId = liveDiagnosticTraceEnabled()
    ? (liveDiagnosticId('mcp-lease', randomUUID()) ?? 'unavailable')
    : undefined
  let leasePromptOrdinal = 0
  let adapterPromptOrdinal: number | undefined
  let onTeamReport: (() => void) | undefined
  let onTurnConcluded: (() => void) | undefined
  let onSuccessfulToolResult: (() => void) | undefined
  type PromptExecution = {
    readonly generation: number
    readonly calls: Set<ToolCallRecord>
    readonly terminalCalls: Set<ToolCallRecord>
    readonly queueAbort: AbortController
    readonly bodySignal?: AbortSignal
    batchFailed: boolean
    feedbackCommitFailed: boolean
    accepting: boolean
    remoteOutcomeKnown: boolean
    externallyAborted: boolean
    handoff: 'none' | 'yield' | 'concluded'
  }
  type PendingFeedback = {
    readonly context: unknown
    readonly scope: PromptExecution
    readonly key: string
    /** Original complete-log boundary, reused for retries without rescanning history. */
    readonly boundary: FeedbackBoundary
    /** The first Session object remains the only permissible source of a continuity baseline. */
    readonly baselineSession: unknown
    continuity: FeedbackContinuity | undefined
  }
  type ToolCallRecord = {
    promise?: Promise<unknown>
    abortedBeforeDispatch?: boolean
  }
  let promptExecution: PromptExecution | undefined
  const drainingPrompts = new Set<PromptExecution>()
  const pendingFeedback = new Map<string, PendingFeedback>()
  let feedbackIdentity = 0
  let seenRequestIds: Set<string | number> | undefined = liveDiagnosticTraceEnabled() ? new Set() : undefined
  let requestHistoryTruncated = false
  let previousArgsByTool: Map<string, string | undefined> | undefined = liveDiagnosticTraceEnabled()
    ? new Map()
    : undefined
  const pendingFeedbackKey = (context: unknown): string => {
    const key = feedbackMessageKey(context)
    return key === undefined ? `local-feedback-${++feedbackIdentity}` : key
  }
  const rememberPendingFeedback = (context: unknown, scope: PromptExecution, boundary: FeedbackBoundary): void => {
    const key = pendingFeedbackKey(context)
    if (!pendingFeedback.has(key))
      pendingFeedback.set(key, {
        context,
        scope,
        key,
        boundary,
        baselineSession: agent.session,
        continuity: feedbackContinuityOf(agent.session, boundary.eventCount),
      })
    scope.feedbackCommitFailed = true
    scope.accepting = false
  }
  const injectFeedback = (context: unknown, scope: PromptExecution): void => {
    const firstBoundary = feedbackBoundary(agent, context)
    if (firstBoundary.existingAccepted) return
    try {
      agent.inject(context as never)
      return
    } catch {
      const afterFirst = observeFeedbackAcceptance(agent, context, firstBoundary)
      if (afterFirst === 'accepted') return
      if (afterFirst !== 'missing') {
        rememberPendingFeedback(context, scope, firstBoundary)
        return
      }
    }

    const retryBoundary = feedbackBoundary(agent, context)
    if (retryBoundary.existingAccepted) return
    if (retryBoundary.eventCount === undefined) {
      rememberPendingFeedback(context, scope, retryBoundary)
      return
    }
    try {
      agent.inject(context as never)
      return
    } catch {
      if (observeFeedbackAcceptance(agent, context, retryBoundary) !== 'accepted')
        rememberPendingFeedback(context, scope, firstBoundary)
    }
  }
  const nonce = randomBytes(8).toString('hex')
  const serverName = wireProfile === 'devin' ? 'dsh' : `dshteam_${nonce}`
  const path = `/${randomBytes(32).toString('hex')}`
  // The connection owns caller identity. Keep native tool names intact so
  // upstream prompts, descriptions and plugin instructions share one contract.
  const names = definitions
  const scopedInstructions = bridgeInstructions(names)
  const presented = new Map<string, string>()
  const identityOf = (call: acp.ToolCallUpdate): { tool?: string; source?: AcpPermissionCheck['identitySource'] } => {
    if (wireProfile === 'antigravity') return antigravityToolIdentity(call, serverName)
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const candidates: Array<{ tool: string | undefined; source: AcpPermissionCheck['identitySource'] }> = []
    const deferred = wireProfile === 'codebuddy' ? codeBuddyDeferredInput(call, serverName) : undefined
    if (deferred) candidates.push({ tool: deferred.tool, source: 'codebuddy-deferred-input' })
    if (wireProfile === 'codex' || wireProfile === 'codebuddy') {
      const input = codexMcpInput(call, serverName)
      if (input) candidates.push({ tool: input.tool, source: 'codex-input' })
    }
    if (meta?.toolName != null)
      candidates.push({ tool: qualifiedMcpTool(serverName, meta.toolName), source: 'claude-meta' })
    if (call._meta?.['cognition.ai/toolName'] != null)
      candidates.push({ tool: qualifiedMcpTool(serverName, call._meta['cognition.ai/toolName']), source: 'devin-meta' })
    if (typeof call.name === 'string' && call.name.startsWith('mcp__'))
      candidates.push({ tool: qualifiedMcpTool(serverName, call.name), source: 'name' })
    // Only runtime-specific, complete labels identify a server. A bare native
    // name alone never grants approval; Devin may also repeat the exact native
    // name alongside its complete server label, which must agree byte-for-byte.
    if (candidates.length === 0 && wireProfile === 'devin') {
      const title = devinTitledTool(call.title)
      if (title !== undefined && (call.name == null || call.name === title))
        candidates.push({ tool: title, source: 'devin-title' })
    }
    const first = candidates[0]
    if (first === undefined) return call.name == null ? {} : { source: 'name' }
    // A CodeBuddy connection may also send ordinary ACP-qualified calls; keep
    // that pre-existing exact-name path. Codex metadata alone is not a
    // substitute for CodeBuddy's deferred envelope on this runtime.
    if (
      wireProfile === 'codebuddy' &&
      deferred === undefined &&
      !candidates.some((candidate) => candidate.source === 'name')
    )
      return { source: first.source }
    if (
      first.tool === undefined ||
      candidates.some((candidate) => candidate.tool !== first.tool) ||
      (call.name != null &&
        call.name !== first.tool &&
        qualifiedMcpTool(serverName, call.name) !== first.tool &&
        !(wireProfile === 'codebuddy' && deferred !== undefined && call.name === 'DeferExecuteTool'))
    )
      return { source: first.source }
    return { tool: first.tool, source: first.source }
  }
  const definitionOf = (call: acp.ToolCallUpdate): ToolSchema | undefined => {
    const tool = identityOf(call).tool
    return tool === undefined ? undefined : names.get(tool)
  }
  const elicitationTarget = (request: acp.CreateElicitationRequest, call: acp.ToolCallUpdate | undefined) => {
    const tool = wireProfile === 'codex' ? codexElicitationTool(request, call, serverName) : undefined
    return tool === undefined ? undefined : names.get(tool)
  }
  const inspectPermission: NonNullable<AcpMcpLease['inspectPermission']> = async (request) => {
    directory.clearPermission(request)
    const captured = directory.capturePrompt()
    const capturedPrompt = captured.signal
    const call = request.toolCall
    const identity = identityOf(call)
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const source = identity.source
    const titleName =
      wireProfile === 'devin'
        ? devinToolTitleHint(call.title)
        : wireProfile === 'antigravity'
          ? antigravityTitledTool(call.title, serverName)
          : undefined
    const facts: Omit<AcpPermissionCheck, 'reason'> = {
      ...(source === undefined ? {} : { identitySource: source }),
      structuredIdentityPresent:
        call.name != null ||
        meta?.toolName != null ||
        call._meta?.['cognition.ai/toolName'] != null ||
        source === 'codex-input' ||
        source === 'codebuddy-deferred-input' ||
        source === 'antigravity-meta',
      titleMatchesCurrentTool: titleName !== undefined && names.has(titleName),
    }
    // This lease owns only its advertised DSH tools. A native Agent tool has
    // the ACP prompt/connection lifetime even when an unrelated Host tool
    // registration has retired this bridge. A matching DSH title remains
    // ambiguous evidence and must not bypass the bridge's liveness fence.
    if (identity.tool === undefined && !facts.titleMatchesCurrentTool) return { ...facts, reason: 'identity-unmatched' }
    if (!directory.isLive()) return { ...facts, reason: 'inactive-connection' }
    if (capturedPrompt === undefined || capturedPrompt.aborted) return { ...facts, reason: 'inactive-prompt' }
    const captureFence = (definition: ToolSchema, revocationOnly = false): AbortSignal =>
      directory.capturePermission(request, captured, definition, revocationOnly)
    const definition = identity.tool === undefined ? undefined : names.get(identity.tool)
    if (definition === undefined) {
      // An identified call to our own server with an unknown name cannot
      // execute, even after approval. Do not ask a user to repair a protocol
      // error, and never strip markup or guess arguments to make it runnable.
      if (identity.tool !== undefined)
        return { ...facts, reason: 'invalid-tool-name', response: rejectPermissionOnce(request) }
      // A matching title alone cannot authorize execution. It only
      // keeps this ambiguous manual question revocable with its advertised target.
      const titleTarget = titleName === undefined ? undefined : names.get(titleName)
      if (titleTarget !== undefined) captureFence(titleTarget, true)
      return { ...facts, reason: 'identity-unmatched' }
    }
    // The tool was replaced or revoked after this connection advertised it.
    // Approval could not make it executable, so refuse this one request and
    // leave the connection's remaining tools usable.
    if (!directory.isDefinitionLive(definition.name, definition))
      return {
        ...facts,
        toolName: definition.name,
        reason: 'invalid-tool-name',
        response: rejectPermissionOnce(request),
      }
    captureFence(definition)
    return { ...facts, toolName: definition.name, reason: 'approval-required' }
  }
  const sessions = new Set<Server>()
  const calls = new Set<Promise<unknown>>()
  const waitForAcceptedCalls = async (): Promise<void> => {
    while (calls.size > 0) await Promise.allSettled([...calls])
  }
  // MCP GET streams can stay open indefinitely. Only admitted POST response
  // tails carry a request result that must drain before transport disposal.
  const responseTails = new Set<Promise<void>>()
  const executionScheduler = new ToolExecutionScheduler()
  // Legacy cancellation is a separate stateless HTTP request handled by another Server instance.
  // Keep only active lease-local calls here so that notification can reach the executing request.
  const activeCalls = new Map<string | number, AbortController>()
  // Accepted calls by tool, so withdrawing one tool cancels its own work and nothing else.
  const callsByTool = new Map<string, Set<AbortController>>()
  // A replacement withdraws and republishes a name in one synchronous burst;
  // judge after it settles. A name still absent then was revoked (restricted,
  // or its provider removed) and its accepted calls must not keep running.
  const cancelWithdrawnToolCalls = (): void => {
    queueMicrotask(() => {
      if (lifetime.signal.aborted) return
      for (const [name, running] of callsByTool) {
        if (name === RUN_CODE_NAME || tools.get(name, agent) !== undefined) continue
        for (const cancellation of running) cancellation.abort(new Error('DSH tool withdrawn'))
      }
    })
  }
  let retirePipelineConsumer: (() => Promise<void>) | undefined
  let pipelineOwnerClosing = false
  let pipeline: ToolExecutionPipeline | undefined
  const pipelineOwner = await ctx.inject(['tools'], (child) => {
    pipeline = new ToolExecutionPipeline(child)
    child.effect(() => async () => {
      pipelineOwnerClosing = true
      lifetime.abort(new Error('DSH tools provider unloaded'))
      try {
        await retirePipelineConsumer?.()
      } finally {
        // Transport grace is not a bound on accepted native execution. Keep
        // this actual tools consumer alive through result/feedback settlement.
        await waitForAcceptedCalls()
      }
    })
  })
  const executionPipeline = pipeline
  if (executionPipeline === undefined || pipelineOwnerClosing) {
    await pipelineOwner.dispose()
    return undefined
  }
  const http = createServer((request, response) => {
    if (
      !directory.isLive(false) ||
      request.url !== path ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${port}`
    ) {
      response.writeHead(403).end()
      return
    }
    if (request.method === 'POST') {
      let resolve!: () => void
      const tail = new Promise<void>((done) => {
        resolve = done
      })
      responseTails.add(tail)
      const settled = (): void => {
        response.off('finish', settled)
        response.off('close', settled)
        responseTails.delete(tail)
        resolve()
      }
      response.once('finish', settled)
      response.once('close', settled)
    }
    const server = new Server(
      { name: 'DSH tools', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions: scopedInstructions,
      },
    )
    sessions.add(server)
    server.setNotificationHandler('notifications/cancelled', async (notification) => {
      const requestId = notification.params.requestId
      if (requestId !== undefined) activeCalls.get(requestId)?.abort()
    })
    server.setRequestHandler('tools/list', async () => ({
      tools: [...names]
        .filter(([name, definition]) => directory.isDefinitionLive(name, definition, false))
        .map(([name]) => ({
          name,
          description: visible.get(name)!.description,
          inputSchema: {
            ...visible.get(name)!.parameters,
            type: 'object' as const,
          },
        })),
    }))
    server.setRequestHandler('tools/call', async (request, context) => {
      const requestId = context.mcpReq.id
      let diagnosticHandlerBase:
        | {
            sessionId: string
            leaseId: string
            leasePromptOrdinal: number
            adapterPromptOrdinal?: number
            mcpRequestId: string
            hostCallId?: string
            tool: LiveDiagnosticTool
          }
        | undefined
      if (requestId === undefined)
        return { isError: true, content: [{ type: 'text' as const, text: 'ACP_TEAM_REQUEST_ID_MISSING' }] }
      if (activeCalls.has(requestId)) {
        if (liveDiagnosticTraceEnabled()) {
          emitLiveDiagnostic({
            type: 'mcp/tool/rejected',
            sessionId: liveDiagnosticId('dsh-session', sessionId) ?? 'unavailable',
            leaseId: diagnosticLeaseId ?? 'unavailable',
            leasePromptOrdinal,
            mcpRequestId: liveDiagnosticId('mcp-request', requestId) ?? 'unavailable',
            tool: diagnosticTool(request.params.name),
            argsHmac: 'unavailable',
            argsBytes: null,
            argsFingerprintComplete: false,
            inboxCountStatus: 'unavailable',
            mcpRequestIdScope: 'lease-local',
            mcpRequestHistoryTruncated: requestHistoryTruncated,
            sameArgsAsPreviousToolCall: 'unavailable',
            idReusedWithinLease: true,
            transportRetryRelation: 'unavailable',
            rejectionReason: 'request-id-collision',
          })
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'ACP_TEAM_REQUEST_ID_COLLISION' }],
        }
      }
      const cancellation = new AbortController()
      activeCalls.set(requestId, cancellation)
      const callPrompt = promptExecution
      if (callPrompt === undefined || !callPrompt.accepting) {
        activeCalls.delete(requestId)
        return { isError: true, content: [{ type: 'text' as const, text: 'ACP_TEAM_PROMPT_INACTIVE' }] }
      }
      const callAdmission = readAdmission?.(agent)
      const sameAdmission = () =>
        readAdmission === undefined || (readAdmission(agent) === callAdmission && callAdmission?.isActive() === true)
      const callRecord: ToolCallRecord = {}
      callPrompt.calls.add(callRecord)
      const call = (async () => {
        const definition = names.get(request.params.name)
        if (!directory.isLive() || !sameAdmission() || directory.prompt === undefined || directory.prompt.aborted)
          throw new Error('ACP_TEAM_PROMPT_INACTIVE')
        if (definition === undefined || !directory.isDefinitionLive(definition.name, definition))
          throw new Error('ACP_TEAM_TOOL_UNAVAILABLE')
        const running = callsByTool.get(definition.name) ?? new Set()
        callsByTool.set(definition.name, running.add(cancellation))
        const args = request.params.arguments ?? {}
        const membership = definition.name === 'send_message' ? teamContext?.membership() : undefined
        const membershipRole = membership?.role
        const membershipId = membership?.id
        const membershipRoot = membership?.root
        const executedPrompt = directory.prompt
        const executedGeneration = directory.generation
        const hostCallId = `acp-team-${randomUUID()}`
        const dispatchSignal = AbortSignal.any([
          lifetime.signal,
          executedPrompt,
          callPrompt.queueAbort.signal,
          context.mcpReq.signal,
          cancellation.signal,
        ])
        const bodySignal = AbortSignal.any([
          lifetime.signal,
          ...(callPrompt.bodySignal === undefined ? [] : [callPrompt.bodySignal]),
          context.mcpReq.signal,
          cancellation.signal,
        ])
        let releaseExecution: (() => void) | undefined
        try {
          const diagnosticEnabled = liveDiagnosticTraceEnabled()
          const diagnosticSessionId = diagnosticEnabled
            ? (liveDiagnosticId('dsh-session', sessionId) ?? 'unavailable')
            : 'unavailable'
          const diagnosticMcpRequestId = diagnosticEnabled
            ? (liveDiagnosticId('mcp-request', requestId) ?? 'unavailable')
            : 'unavailable'
          const diagnosticHostCallId = diagnosticEnabled
            ? (liveDiagnosticId('host-call', hostCallId) ?? 'unavailable')
            : 'unavailable'
          const diagnosticArgs = diagnosticEnabled ? liveDiagnosticFingerprint('mcp-tool-arguments', args) : undefined
          const rawMessage =
            diagnosticEnabled && definition.name === 'send_message'
              ? collectLiveDiagnostic(() => args.message)
              : undefined
          const diagnosticBody =
            diagnosticEnabled && typeof rawMessage === 'string'
              ? liveDiagnosticFingerprint('team-message-body', rawMessage)
              : undefined
          const idReusedWithinLease =
            diagnosticEnabled && !requestHistoryTruncated ? (seenRequestIds?.has(requestId) ?? false) : undefined
          if (diagnosticEnabled) {
            seenRequestIds ??= new Set()
            seenRequestIds.add(requestId)
            if (seenRequestIds.size > 4096) {
              const first = seenRequestIds.values().next().value
              if (first !== undefined) seenRequestIds.delete(first)
              requestHistoryTruncated = true
            }
          }
          if (diagnosticEnabled) previousArgsByTool ??= new Map()
          const argsFingerprint =
            diagnosticArgs?.complete === true && /^h:[a-f0-9]{24}$/.test(diagnosticArgs.hmac)
              ? diagnosticArgs.hmac
              : undefined
          const previousFingerprint = previousArgsByTool?.get(definition.name)
          const sameArgsAsPreviousToolCall: 'same' | 'different' | 'unavailable' =
            argsFingerprint === undefined
              ? 'unavailable'
              : previousFingerprint === undefined
                ? 'unavailable'
                : previousFingerprint === argsFingerprint
                  ? 'same'
                  : 'different'
          if (diagnosticEnabled) previousArgsByTool?.set(definition.name, argsFingerprint)
          let diagnosticTargetRole: LiveDiagnosticTargetRole | undefined
          if (diagnosticEnabled && definition.name === 'send_message') {
            try {
              diagnosticTargetRole = teamContext?.isLeadReference(args.agent) === true ? 'lead' : 'unknown'
            } catch {
              diagnosticTargetRole = 'unknown'
            }
          }
          releaseExecution = await executionScheduler.acquire(
            () =>
              executionPipeline.executionMode({
                callId: hostCallId as never,
                name: definition.name,
                arguments: args,
                agent,
                ...(callAdmission === undefined ? {} : { toolSet: callAdmission.toolSet }),
                signal: dispatchSignal,
              }).kind,
            dispatchSignal,
          )
          if (
            releaseExecution === undefined ||
            dispatchSignal.aborted ||
            !callPrompt.accepting ||
            directory.prompt !== executedPrompt ||
            directory.generation !== executedGeneration ||
            !sameAdmission() ||
            !directory.isLive()
          ) {
            // The request was admitted to this prompt but never crossed the
            // Host ToolRuntime boundary. A natural terminal must report this
            // known non-execution rather than treating it as settled success.
            callRecord.abortedBeforeDispatch = true
            throw new Error('ACP_TEAM_PROMPT_INACTIVE')
          }
          if (!directory.isDefinitionLive(definition.name, definition)) {
            // Replaced or revoked while queued: a known non-execution of this tool only.
            callRecord.abortedBeforeDispatch = true
            throw new Error('ACP_TEAM_TOOL_UNAVAILABLE')
          }
          const inboxCounts = diagnosticEnabled ? diagnosticInboxCounts(agent) : undefined
          const diagnosticBase =
            diagnosticEnabled && diagnosticLeaseId !== undefined && diagnosticArgs !== undefined
              ? {
                  sessionId: diagnosticSessionId,
                  leaseId: diagnosticLeaseId,
                  leasePromptOrdinal,
                  ...(adapterPromptOrdinal === undefined ? {} : { adapterPromptOrdinal }),
                  mcpRequestId: diagnosticMcpRequestId,
                  hostCallId: diagnosticHostCallId,
                  tool: diagnosticTool(definition.name),
                  ...(diagnosticTargetRole === undefined ? {} : { targetRole: diagnosticTargetRole }),
                  argsHmac: diagnosticArgs.hmac,
                  argsBytes: diagnosticArgs.bytes,
                  argsFingerprintComplete: diagnosticArgs.complete,
                  ...(diagnosticBody === undefined
                    ? {}
                    : {
                        bodyHmac: diagnosticBody.hmac,
                        bodyBytes: diagnosticBody.bytes,
                        bodyFingerprintComplete: diagnosticBody.complete,
                      }),
                  ...(inboxCounts ?? {}),
                  inboxCountStatus: inboxCounts === undefined ? ('unavailable' as const) : ('available' as const),
                  inboxSnapshotStage:
                    inboxCounts === undefined ? ('unavailable' as const) : ('before-host-call' as const),
                  mcpRequestIdScope: 'lease-local' as const,
                  mcpRequestIdStatus: 'available' as const,
                  modelToolCallIdStatus: 'unavailable' as const,
                  clientReceiptStatus: 'unavailable' as const,
                  transportRetryRelation: 'unavailable' as const,
                  ...(idReusedWithinLease === undefined ? {} : { idReusedWithinLease }),
                  mcpRequestHistoryTruncated: requestHistoryTruncated,
                  sameArgsAsPreviousToolCall,
                }
              : undefined
          if (diagnosticBase !== undefined) diagnosticHandlerBase = diagnosticBase
          const queuedTeamMessage = definition.name === 'wait_agent' && agent.inbox.nextStep.some(isPendingPeerMessage)
          if (queuedTeamMessage) {
            if (callPrompt.handoff !== 'concluded') callPrompt.handoff = 'yield'
            const text = DEFERRED_WAIT_TEXT
            if (diagnosticEnabled && diagnosticBase !== undefined) {
              // This is an MCP-level deferred error, not a Host call; omit hostCallId and host-execute events.
              const { hostCallId: notExecutedHostCall, ...withoutHostCall } = diagnosticBase
              void notExecutedHostCall
              const queuedCounts = collectLiveDiagnostic(() => diagnosticInboxCounts(agent))
              emitLiveDiagnostic({
                type: 'mcp-handler/returned',
                ...withoutHostCall,
                ...(queuedCounts ?? {}),
                inboxCountStatus: queuedCounts === undefined ? 'unavailable' : 'available',
                inboxSnapshotStage: queuedCounts === undefined ? 'unavailable' : 'before-host-call',
                resultStatus: 'error',
                handlerIsError: true,
              })
            }
            const receipt = wireProfile === 'codex' ? deferredWaitReceipts.issue() : undefined
            return {
              isError: true,
              content: [{ type: 'text' as const, text }],
              ...(receipt === undefined ? {} : { _meta: receipt }),
            }
          }
          const dispatchStartedAt = performance.now()
          let cancellationObserved = false
          const onDispatchAbort = (): void => {
            if (!diagnosticEnabled || diagnosticBase === undefined || cancellationObserved) return
            cancellationObserved = true
            emitLiveDiagnostic({
              type: 'mcp/tool/cancelled',
              ...diagnosticBase,
              durationMs: Math.max(0, Math.round(performance.now() - dispatchStartedAt)),
              resultStatus: 'cancelled',
            })
          }
          if (diagnosticEnabled && diagnosticBase !== undefined) {
            emitLiveDiagnostic({ type: 'host-execute/start', ...diagnosticBase })
            bodySignal.addEventListener('abort', onDispatchAbort, { once: true })
            if (bodySignal.aborted) onDispatchAbort()
          }
          let result: ToolExecutionResult
          let batch: ToolBatchResult
          try {
            batch = await agents.withInitiator(agent, () =>
              tools.execute({
                calls: [
                  {
                    type: 'tool-call',
                    id: hostCallId as never,
                    name: definition.name,
                    arguments: JSON.stringify(args),
                  },
                ],
                agent,
                ...(callAdmission === undefined ? {} : { toolSet: callAdmission.toolSet }),
                signal: bodySignal,
              }),
            )
            if (batch.results.length !== 1 || batch.results[0]?.callId !== hostCallId) {
              throw new ToolBatchExecutionError(new Error('ACP_HOST_TOOL_RESULT_MISMATCH'), batch)
            }
            result = batch.results[0].result
            if (toolErrorInfoCode(result.error) === TOOL_ABORTED_BEFORE_DISPATCH)
              callRecord.abortedBeforeDispatch = true
            if (diagnosticEnabled && diagnosticBase !== undefined) {
              const diagnosticOutcome = collectLiveDiagnostic(() => ({
                hostResultIsError: result.isError === true,
                errorKind: diagnosticErrorKind(result.error, trace),
              }))
              emitLiveDiagnostic({
                type: 'host-execute/settled',
                ...diagnosticBase,
                durationMs: Math.max(0, Math.round(performance.now() - dispatchStartedAt)),
                ...(diagnosticOutcome === undefined
                  ? { resultStatus: 'unknown' as const }
                  : {
                      resultStatus: diagnosticOutcome.hostResultIsError ? ('error' as const) : ('success' as const),
                      hostResultIsError: diagnosticOutcome.hostResultIsError,
                      ...(diagnosticOutcome.errorKind === undefined ? {} : { errorKind: diagnosticOutcome.errorKind }),
                    }),
              })
            }
          } catch (error) {
            if (error instanceof ToolBatchExecutionError) {
              // The wrapper's message is fixed; only its cause names the failure.
              try {
                if (ctx.logger !== undefined)
                  createAcpLogger(ctx.logger).warn(`dsh-acp: ${toolFailureText(error)}`, {
                    dshSessionId: sessionId,
                    operation: 'tool-execute',
                    result: 'batch-failed',
                  })
              } catch {
                // Logging cannot change the settlement of an accepted call.
              }
              for (const context of error.partial.additionalContexts) injectFeedback(context, callPrompt)
              callPrompt.batchFailed = true
              callPrompt.accepting = false
              callPrompt.queueAbort.abort(error)
            }
            if (diagnosticEnabled && diagnosticBase !== undefined) {
              const errorKind = collectLiveDiagnostic(() => diagnosticErrorKind(error, trace))
              emitLiveDiagnostic({
                type: 'host-execute/settled',
                ...diagnosticBase,
                durationMs: Math.max(0, Math.round(performance.now() - dispatchStartedAt)),
                resultStatus: 'error',
                ...(errorKind === undefined ? {} : { errorKind }),
              })
            }
            throw error
          } finally {
            bodySignal.removeEventListener('abort', onDispatchAbort)
          }
          const additionalContexts = batch.additionalContexts
          for (const context of additionalContexts) injectFeedback(context, callPrompt)
          if (callPrompt.feedbackCommitFailed)
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: callPrompt.remoteOutcomeKnown,
            })
          const content = await toolContent(
            result.content,
            bodySignal,
            capabilities?.promptCapabilities?.image === true,
            ctx.get('attachments', false),
          )
          if (
            result.isError !== true &&
            executedPrompt !== undefined &&
            !executedPrompt.aborted &&
            !bodySignal.aborted &&
            !context.mcpReq.signal.aborted &&
            !cancellation.signal.aborted &&
            directory.prompt === executedPrompt &&
            directory.generation === executedGeneration &&
            sameAdmission() &&
            directory.isLive()
          )
            onSuccessfulToolResult?.()
          const currentMembership = teamContext?.membership()
          if (
            definition.name === 'send_message' &&
            teamContext?.isLeadReference(args.agent) === true &&
            typeof args.message === 'string' &&
            args.message.trim().length > 0 &&
            result.isError !== true &&
            membershipRole === 'teammate' &&
            currentMembership?.role === 'teammate' &&
            currentMembership.id === membershipId &&
            currentMembership.root === membershipRoot &&
            executedPrompt !== undefined &&
            !executedPrompt.aborted &&
            !context.mcpReq.signal.aborted &&
            !cancellation.signal.aborted &&
            directory.prompt === executedPrompt &&
            directory.generation === executedGeneration &&
            sameAdmission() &&
            directory.isLive()
          ) {
            onTeamReport?.()
          }
          if (
            result.isError !== true &&
            batch.concluded &&
            executedPrompt !== undefined &&
            !executedPrompt.aborted &&
            !context.mcpReq.signal.aborted &&
            !cancellation.signal.aborted &&
            directory.prompt === executedPrompt &&
            directory.generation === executedGeneration &&
            sameAdmission() &&
            directory.isLive()
          )
            onTurnConcluded?.()
          // A tool can fold queued input into its result. Read the native inbox at return time,
          // after async content conversion, and only retract guidance issued by this prompt.
          const nextStep = agent.inbox.nextStep
          const shouldYield = !batch.concluded && callPrompt.handoff !== 'concluded' && nextStep.length > 0
          const repeatToolReminderPending =
            shouldYield &&
            additionalContexts.some(
              (context) =>
                hasSourceKind(context, 'repeat-tool-reminder') && nextStep.some((message) => message.id === context.id),
            )
          if (batch.concluded) {
            callPrompt.handoff = 'concluded'
            content.push({
              type: 'text',
              text: generatedContextBlock(
                'This DSH tool requests the end of the current turn. Finish this ACP response now without further tool calls.',
              ),
            })
          } else if (shouldYield) {
            callPrompt.handoff = 'yield'
            content.push({
              type: 'text',
              text: generatedContextBlock(
                repeatToolReminderPending
                  ? 'DSH has queued feedback because this tool was repeated. Stop repeating the tool call and end this ACP response now so DSH can deliver the pending feedback. Then continue based on that feedback.'
                  : 'DSH has queued input for your next step. End this ACP response now with a brief progress update, without a final answer; DSH will deliver the pending input and continue the turn.',
              ),
            })
          } else if (callPrompt.handoff === 'yield') {
            callPrompt.handoff = 'none'
            content.push({
              type: 'text',
              text: generatedContextBlock(
                'DSH no longer has queued input for this step. Continue any unfinished work in this ACP response.',
              ),
            })
          }
          if (diagnosticEnabled && diagnosticBase !== undefined)
            collectLiveDiagnostic(() => {
              const returnInbox = diagnosticInboxCounts(agent)
              let repeatReminderContextCount = 0
              for (const additionalContext of additionalContexts) {
                if (hasSourceKind(additionalContext, 'repeat-tool-reminder')) repeatReminderContextCount += 1
              }
              const handlerIsError = result.isError === true
              emitLiveDiagnostic({
                type: 'mcp-handler/returned',
                ...diagnosticBase,
                ...(returnInbox ?? {}),
                inboxCountStatus: returnInbox === undefined ? ('unavailable' as const) : ('available' as const),
                inboxSnapshotStage: returnInbox === undefined ? ('unavailable' as const) : ('handler-return' as const),
                additionalContextsCount: additionalContexts.length,
                repeatReminderContextCount,
                pendingYieldAppended: shouldYield && !repeatToolReminderPending,
                concludesTurnReminderAppended: batch.concluded,
                durationMs: Math.max(0, Math.round(performance.now() - dispatchStartedAt)),
                handlerIsError,
                resultStatus: handlerIsError ? 'error' : 'success',
              })
            })
          return { content, isError: result.isError }
        } finally {
          releaseExecution?.()
        }
      })()
      callRecord.promise = call
      calls.add(call)
      try {
        return await call
      } catch (error) {
        if (liveDiagnosticTraceEnabled() && diagnosticHandlerBase !== undefined) {
          const errorKind = diagnosticErrorKind(error, trace)
          emitLiveDiagnostic({
            type: 'mcp-handler/returned',
            ...diagnosticHandlerBase,
            resultStatus: 'error',
            handlerIsError: true,
            ...(errorKind === undefined ? {} : { errorKind }),
          })
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toolFailureText(error) }],
        }
      } finally {
        calls.delete(call)
        callPrompt.calls.delete(callRecord)
        if (activeCalls.get(requestId) === cancellation) activeCalls.delete(requestId)
        callsByTool.get(request.params.name)?.delete(cancellation)
      }
    })
    const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true })
    response.on('close', () => {
      sessions.delete(server)
      void server.close().catch(() => undefined)
    })
    void server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end()
        else response.end()
      })
  })
  let port = 0
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      const address = http.address()
      if (address === null || typeof address === 'string') return reject(new Error('ACP_TEAM_LISTEN_FAILED'))
      port = address.port
      resolve()
    })
  }).catch(async (error) => {
    await pipelineOwner.dispose()
    throw error
  })
  const url = `http://127.0.0.1:${port}${path}`
  const servers: acp.McpServer[] =
    capabilities?.mcpCapabilities?.http === true
      ? [{ type: 'http', name: serverName, url, headers: [] }]
      : [
          {
            name: serverName,
            command: process.execPath,
            args: [fileURLToPath(new URL('../../runtime/session/team-mcp-stdio.js', import.meta.url))],
            env: [
              { name: 'DSH_ACP_TEAM_MCP_URL', value: url },
              { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            ],
          },
        ]
  let closing: Promise<void> | undefined
  const listeners: Array<() => unknown> = []
  const lease: AcpMcpLease = {
    signal: lifetime.signal,
    needsRefresh: () => directory.needsRefresh(),
    instructions: `Current DSH tools connection: MCP server ${serverName}. ${toolDiscoveryInstructions(wireProfile)} ${scopedInstructions} Each session has its own connection and caller identity. Do not copy a connection address or server identity to another session.${hasTeams ? ' Agent names resolve within the caller’s subagent tree.' : ''} Pending DSH messages are delivered after you end the current response; give a brief progress update when asked to yield.`,
    servers,
    ...(diagnosticLeaseId === undefined ? {} : { diagnosticLeaseId }),
    beginPrompt(signal, reportCallback, promptOrdinal, concludedCallback, bodySignal, successfulToolResultCallback) {
      if ([...drainingPrompts].some((scope) => scope.batchFailed))
        throw new AcpHostSettlementError('ACP_HOST_TOOL_RECONCILIATION_REQUIRED')
      if (promptExecution?.accepting === true || calls.size > 0 || pendingFeedback.size > 0)
        throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
      directory.beginPrompt(signal)
      onTeamReport = reportCallback
      onTurnConcluded = concludedCallback
      onSuccessfulToolResult = successfulToolResultCallback
      if (liveDiagnosticTraceEnabled()) leasePromptOrdinal++
      adapterPromptOrdinal = promptOrdinal
      presented.clear()
      deferredWaitReceipts.clear()
      identifiedWaitCalls.clear()
      waitCallsWithOtherContent.clear()
      promptExecution = {
        generation: directory.generation,
        calls: new Set(),
        terminalCalls: new Set(),
        queueAbort: new AbortController(),
        bodySignal: bodySignal ?? signal,
        batchFailed: false,
        feedbackCommitFailed: false,
        accepting: true,
        remoteOutcomeKnown: false,
        externallyAborted: false,
        handoff: 'none',
      }
    },
    endPrompt(options) {
      directory.endPrompt()
      const ended = promptExecution
      if (ended !== undefined) {
        ended.accepting = false
        ended.externallyAborted = options?.externallyAborted === true
        ended.remoteOutcomeKnown = options?.remoteOutcomeKnown === true || options?.stopReason !== undefined
        if (ended.remoteOutcomeKnown) for (const call of ended.calls) ended.terminalCalls.add(call)
        ended.queueAbort.abort(new Error('ACP prompt ended'))
        drainingPrompts.add(ended)
      }
      promptExecution = undefined
      onTeamReport = undefined
      onTurnConcluded = undefined
      onSuccessfulToolResult = undefined
      adapterPromptOrdinal = undefined
      presented.clear()
    },
    async drainPrompt() {
      const pending = [...drainingPrompts]
      await Promise.all(
        pending.map(async (scope) => {
          while (scope.calls.size > 0)
            await Promise.allSettled(
              [...scope.calls].flatMap((call) => (call.promise === undefined ? [] : [call.promise])),
            )
          if (scope.batchFailed)
            throw new AcpHostSettlementError('ACP_HOST_TOOL_RECONCILIATION_REQUIRED', {
              remoteOutcomeKnown: scope.remoteOutcomeKnown,
            })
          if ([...pendingFeedback.values()].some((entry) => entry.scope === scope))
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: scope.remoteOutcomeKnown,
            })
          if (
            scope.remoteOutcomeKnown &&
            !scope.externallyAborted &&
            scope.bodySignal?.aborted !== true &&
            [...scope.terminalCalls].some((call) => call.abortedBeforeDispatch === true)
          ) {
            drainingPrompts.delete(scope)
            throw new AcpHostSettlementError('ACP_HOST_TOOL_NOT_DISPATCHED')
          }
          drainingPrompts.delete(scope)
        }),
      )
    },
    async flushHostFeedback() {
      for (const [key, pending] of [...pendingFeedback]) {
        // Adapter replacement can replace both Agent and Session objects. A
        // replacement Session is eligible only when its immutable header and
        // complete original event prefix match the retained baseline.
        const serviceContext = ctx.root ?? ctx
        const currentAgents = serviceContext.get('agents', false) ?? (ctx.root === undefined ? agents : undefined)
        const currentAgent = currentAgents?.get(sessionId as never)
        const sessions = serviceContext.get('sessions', false)
        const currentSession = sessions?.get(sessionId as never)
        if (
          currentAgent === undefined ||
          currentAgent.id !== sessionId ||
          (sessions !== undefined && currentSession !== currentAgent.session)
        )
          throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
            remoteOutcomeKnown: pending.scope.remoteOutcomeKnown,
          })
        if (currentAgent.session !== pending.baselineSession) {
          pending.continuity ??= feedbackContinuityOf(pending.baselineSession, pending.boundary.eventCount)
          if (!matchesFeedbackContinuity(currentAgent.session, pending.continuity))
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: pending.scope.remoteOutcomeKnown,
            })
        }
        const acceptance = observeFeedbackAcceptance(currentAgent, pending.context, pending.boundary)
        if (acceptance === 'accepted') {
          pendingFeedback.delete(key)
          continue
        }
        if (acceptance !== 'missing')
          throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
            remoteOutcomeKnown: pending.scope.remoteOutcomeKnown,
          })
        try {
          currentAgent.inject(pending.context as never)
          pendingFeedback.delete(key)
        } catch {
          if (observeFeedbackAcceptance(currentAgent, pending.context, pending.boundary) === 'accepted')
            pendingFeedback.delete(key)
          else
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: pending.scope.remoteOutcomeKnown,
            })
        }
      }
      const scopes = new Set(drainingPrompts)
      if (promptExecution !== undefined) scopes.add(promptExecution)
      for (const scope of scopes) {
        scope.feedbackCommitFailed = [...pendingFeedback.values()].some((entry) => entry.scope === scope)
        if (
          !scope.feedbackCommitFailed &&
          !scope.batchFailed &&
          promptExecution === scope &&
          !scope.remoteOutcomeKnown &&
          !scope.externallyAborted
        )
          scope.accepting = true
        if (scope.calls.size === 0 && !scope.feedbackCommitFailed && !scope.batchFailed) drainingPrompts.delete(scope)
      }
    },
    hasPendingCalls() {
      return calls.size > 0
    },
    hasUncommittedFeedback() {
      return pendingFeedback.size > 0
    },
    hasRetainedFeedback() {
      return pendingFeedback.size > 0
    },
    waitForCallsSettled: waitForAcceptedCalls,
    presentTool(call) {
      if (wireProfile === 'antigravity' && isAntigravityInteractionCall(call)) return call
      const identity = identityOf(call)
      const deferred = wireProfile === 'codebuddy' ? codeBuddyDeferredInput(call, serverName) : undefined
      const acceptedDeferred =
        deferred?.tool !== undefined &&
        identity.source === 'codebuddy-deferred-input' &&
        identity.tool === deferred.tool
      const wrapperCall = deferred !== undefined
      const definition = identity.tool === undefined ? undefined : names.get(identity.tool)
      if (wireProfile === 'codex') {
        // Nonempty ACP content may contain new diagnostics independent of the
        // prior rawOutput. Never hide it behind a remembered control receipt.
        if (call.content != null) {
          if (call.content.length > 0) waitCallsWithOtherContent.add(call.toolCallId)
          else waitCallsWithOtherContent.delete(call.toolCallId)
        }
        if (codexConflictsWithTool(call, serverName, 'wait_agent')) {
          identifiedWaitCalls.delete(call.toolCallId)
          deferredWaitReceipts.revoke(call.toolCallId)
        } else if (
          definition?.name === 'wait_agent' &&
          directory.isLive() &&
          directory.isDefinitionLive(definition.name, definition) &&
          directory.prompt !== undefined &&
          !directory.prompt.aborted
        ) {
          identifiedWaitCalls.add(call.toolCallId)
        } else if (identity.source !== undefined && !(identity.source === 'name' && call.name === 'wait_agent')) {
          identifiedWaitCalls.delete(call.toolCallId)
          deferredWaitReceipts.revoke(call.toolCallId)
        }
        if (
          call.rawOutput !== undefined &&
          directory.isLive() &&
          directory.prompt !== undefined &&
          !directory.prompt.aborted &&
          identifiedWaitCalls.has(call.toolCallId)
        ) {
          deferredWaitReceipts.observe(call.toolCallId, call.rawOutput)
        }
        if (waitCallsWithOtherContent.has(call.toolCallId)) deferredWaitReceipts.revoke(call.toolCallId)
      }
      let name = definition?.name ?? (wrapperCall ? undefined : presented.get(call.toolCallId))
      if (name === undefined && wireProfile === 'antigravity') {
        const tool = antigravityPresentationTool(call, serverName)
        name = (tool !== undefined && names.has(tool) ? tool : undefined) ?? resolveAntigravityNativeTool(call)
      }
      if (name === undefined) return call
      presented.set(call.toolCallId, name)
      const presentTeam = (result: acp.ToolCallUpdate): acp.ToolCallUpdate =>
        teamContext !== undefined &&
        definition !== undefined &&
        (definition.name === 'subagent' ||
          definition.name === 'subagent_fork' ||
          definition.name === 'subagent_oar' ||
          definition.name === 'send_message') &&
        directory.isLive() &&
        directory.isDefinitionLive(definition.name, definition) &&
        directory.prompt !== undefined &&
        !directory.prompt.aborted
          ? withDshTeamPermissionPresentation(result, {
              tool: definition.name,
              ...(typeof agent.session?.header.cwd === 'string' ? { workspace: agent.session.header.cwd } : {}),
            })
          : result

      if (wireProfile !== 'antigravity') {
        return presentTeam({
          ...call,
          ...(acceptedDeferred && deferred.params !== undefined ? { rawInput: deferred.params } : {}),
          title: name,
          name,
          ...(name === 'bash' ? { kind: 'execute' as const } : {}),
        })
      }

      const { rawInput, rawOutput, content, title } = normalizeAntigravityPresentation(
        call.rawInput,
        call.rawOutput,
        call.content,
        name,
      )

      // Same tool title as the native host. Transport capability names stay out of the conversation row.
      return presentTeam({
        ...call,
        rawInput,
        rawOutput,
        ...(content !== undefined ? { content } : {}),
        title: typeof title === 'string' && title.trim() ? title : name,
        name,
        ...(name === 'bash' || name === 'pwsh' || name.startsWith('terminal_') ? { kind: 'execute' as const } : {}),
        ...(name === 'read' || name === 'read_image' ? { kind: 'read' as const } : {}),
        ...(name === 'edit' || name === 'write' || name === 'str_replace_editor' ? { kind: 'edit' as const } : {}),
        ...(name === 'glob' || name === 'grep' ? { kind: 'search' as const } : {}),
        ...(name === 'web_fetch' || name === 'web_search' ? { kind: 'fetch' as const } : {}),
      })
    },
    toolControlOutcome(toolCallId) {
      return directory.isLive() && directory.prompt !== undefined && !directory.prompt.aborted
        ? deferredWaitReceipts.outcome(toolCallId)
        : undefined
    },
    inspectPermission,
    permissionSignal(request) {
      return directory.permissionSignal(request)
    },
    validatePermissionDecision(request) {
      return directory.validatePermission(request, () => definitionOf(request.toolCall))
    },
    elicitationSignal(request, toolCall) {
      const existing = directory.permissionSignal(request)
      if (existing !== undefined) return existing
      const target = elicitationTarget(request, toolCall)
      const captured = directory.capturePrompt()
      return target === undefined || captured.signal === undefined
        ? undefined
        : directory.capturePermission(request, captured, target)
    },
    validateElicitationDecision(request, toolCall) {
      if (directory.permissionSignal(request) === undefined) return undefined
      return directory.validatePermission(request, () => elicitationTarget(request, toolCall))
    },
    elicitationToolName(request, toolCall) {
      if (!directory.isLive() || directory.prompt === undefined || directory.prompt.aborted) return undefined
      const definition = elicitationTarget(request, toolCall)
      if (definition === undefined || !directory.isDefinitionLive(definition.name, definition)) return undefined
      // Only the plain, exact Agent question can be relabelled without losing extra context.
      return request.message === `Allow the ${serverName} MCP server to run tool "${definition.name}"?`
        ? definition.name
        : undefined
    },
    close(graceMs = 5_000) {
      closing ??= (async () => {
        lifetime.abort(new Error('ACP DSH tools connection closed'))
        deferredWaitReceipts.clear()
        identifiedWaitCalls.clear()
        waitCallsWithOtherContent.clear()
        for (const dispose of listeners.splice(0)) dispose()
        if (promptExecution !== undefined) {
          promptExecution.accepting = false
          drainingPrompts.add(promptExecution)
          promptExecution = undefined
        }
        directory.endPrompt()
        presented.clear()
        // Revoke execution and stop admission immediately, but keep admitted
        // HTTP responses alive until their handlers have delivered settlement.
        // Destroying sockets first loses the cancellation/result tail even
        // when the native tool has already observed the revoked lifetime.
        const closed = new Promise<void>((resolve) => {
          http.close(() => resolve())
        })
        await waitWithin(Promise.allSettled([...responseTails]), graceMs)
        http.closeAllConnections()
        await waitWithin(closed, graceMs)
        await waitWithin(Promise.allSettled([...sessions].map((server) => server.close())), graceMs)
        await waitWithin(waitForAcceptedCalls(), graceMs)
      })()
      return closing.then(async () => {
        // Owner-triggered close must not await its own disposer. Ordinary
        // transport close stays bounded. Cordis retains this consumer's
        // committed tools dependency until its accepted-call drain completes,
        // even when provider withdrawal starts after consumer disposal.
        if (pipelineOwnerClosing) return
        const retirement = pipelineOwner.dispose()
        if (calls.size === 0) return await retirement
        void retirement.catch((error) => ctx.logger.error(error))
      })
    },
  }
  retirePipelineConsumer = () => lease.close()
  if (pipelineOwnerClosing) {
    await lease.close()
    return undefined
  }
  const refreshDirectory = (): void => {
    if (!directory.isLive(false)) {
      void lease.close()
      return
    }
    // Revocation is sticky for this advertised owner. Even an empty directory
    // keeps the transport alive for accepted responses and native Agent work.
    // A later prompt must resolve a fresh directory; never bind names in place.
    directory.revokeStaleTools()
    cancelWithdrawnToolCalls()
  }
  listeners.push(ctx.on('tools/change', refreshDirectory))
  listeners.push(
    ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === agent) void lease.close()
    }),
  )
  listeners.push(
    ctx.on('internal/service', (name) => {
      if (!['subagents', 'agents', 'tools'].includes(name)) return
      refreshDirectory()
    }),
  )
  return lease
}
