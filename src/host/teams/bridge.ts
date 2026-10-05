import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-tools'
import { RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { Server } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { AcpHostSettlementError } from '../../runtime/session/mcp-lease.ts'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'
import { ACP_PERMISSION_ID_MAX_BYTES, ACP_PERMISSION_OPTIONS_MAX } from '../../domain/policy/permissions.ts'
import { toolContent } from './tool-content.ts'
import { generatedContextBlock } from '../../runtime/text-block-boundary.ts'
import { ToolExecutionScheduler } from './tool-execution-scheduler.ts'
import { waitWithin } from '../../runtime/process/timeout.ts'
import {
  collectLiveDiagnostic,
  emitLiveDiagnostic,
  liveDiagnosticFingerprint,
  liveDiagnosticId,
  liveDiagnosticTraceEnabled,
  noteLiveDiagnosticFailure,
} from '../../contract/live-diagnostic-trace.ts'
import type {
  LiveDiagnosticErrorKind,
  LiveDiagnosticTargetRole,
  LiveDiagnosticTool,
} from '../../contract/live-diagnostic-trace.ts'
import { performance } from 'node:perf_hooks'

const TEAM_TOOLS = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const
function bridgeInstructions(names: ReadonlyMap<string, ToolDefinition>, hasTeams: boolean): string {
  const skillRoute = names.has('skill')
    ? 'The DSH MCP tool "skill" is listed; access DSH skill-catalog entries through that tool using its exact tools/list schema and names.'
    : names.has(RUN_CODE_NAME)
      ? `No direct DSH skill tool is listed. If DSH skill access is exposed through the generated SDK, call it inside "${RUN_CODE_NAME}" using the host-provided SDK instructions and listed schema; do not invent a direct skill tool.`
      : 'No DSH skill-loading entry point is listed. Do not claim DSH skill-catalog entries are available through an Agent-native skill tool; explain that this DSH connection has no listed skill entry point.'
  return `These are native DSH tools available to this session. Use the exact tool names and schemas from tools/list. Tools and skills discovered in DSH context, including skill-catalog entries, must use this session's DSH MCP tools; do not route them through the Agent's native skill invocation or private skill directory, and do not copy DSH skill files into that directory. This does not replace or modify the Agent's own skills. Do not assume or expose tools or permissions absent from this DSH connection. ${skillRoute}${hasTeams ? ' Team tools require an explicit user request for a team; members share the workspace and only fresh context is supported.' : ''}`
}
const isTeamTool = (name: string): boolean => (TEAM_TOOLS as readonly string[]).includes(name)
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
function diagnosticErrorKind(error: unknown): LiveDiagnosticErrorKind | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' && diagnosticErrorKinds.has(code as LiveDiagnosticErrorKind)
      ? (code as LiveDiagnosticErrorKind)
      : undefined
  } catch {
    noteLiveDiagnosticFailure()
    return undefined
  }
}
function diagnosticInboxCounts(agent: NonNullable<ReturnType<typeof bridgeDefinitions>>['agent']) {
  try {
    const sourceCounts = (messages: readonly { readonly source?: { readonly kind?: unknown } }[]) => {
      const counts = { user: 0, 'team-message': 0, system: 0, other: 0 }
      for (const message of messages) {
        const kind = message.source?.kind
        if (kind === 'user' || kind === 'team-message' || kind === 'system') counts[kind] += 1
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

const identities = new WeakMap<object, number>()
let nextIdentity = 0
function identity(value: object): number {
  let id = identities.get(value)
  if (id === undefined) {
    id = ++nextIdentity
    identities.set(value, id)
  }
  return id
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

function bridgeDefinitions(ctx: Context, sessionId: string, schemas: readonly ToolSchema[] | undefined) {
  if (schemas === undefined) return undefined
  const teams = ctx.get('agentTeams')
  const agent = ctx.get('agents', false)?.get(sessionId as never)
  const tools = ctx.get('tools', false)
  if (agent === undefined || tools === undefined) return undefined
  const hasTeams = teams !== undefined && teams.tryMembership(agent) !== undefined
  const visible = new Map<string, ToolSchema>()
  const duplicates = new Set<string>()
  for (const schema of schemas) {
    if (visible.has(schema.name)) duplicates.add(schema.name)
    else visible.set(schema.name, schema)
  }
  const definitions = new Map<string, ToolDefinition>()
  // Use the same scoped registry as native execution. No independent tool list:
  // plugin registration, scoped shadows and restrictions remain owned by DSH.
  for (const schema of tools.schemas(agent).sort((left, right) => left.name.localeCompare(right.name))) {
    const visibleSchema = visible.get(schema.name)
    if (visibleSchema === undefined || duplicates.has(schema.name)) continue
    if (isTeamTool(schema.name) && !hasTeams) continue
    const definition = tools.get(schema.name, agent)
    if (definition !== undefined) definitions.set(schema.name, definition)
  }
  const currentSchemaKey = schemaValueKey([...definitions.keys()].map((name) => visible.get(name)!))
  return definitions.size === 0 ? undefined : { agent, tools, teams, hasTeams, definitions, visible, currentSchemaKey }
}

/** Changes when the optional host feature or its scoped tool owner changes. */
export function teamBridgeKey(ctx: Context, sessionId: string, schemas?: readonly ToolSchema[]): unknown {
  const bridge = bridgeDefinitions(ctx, sessionId, schemas)
  return bridge === undefined
    ? undefined
    : JSON.stringify([
        identity(bridge.agent),
        bridge.currentSchemaKey,
        ...[...bridge.definitions].map(([name, definition]) => [name, identity(definition)]),
      ])
}

/** Discover native session tools without enabling any host plugin or Teams service. */
export async function createTeamBridge(
  ctx: Context,
  sessionId: string,
  capabilities: acp.AgentCapabilities | undefined,
  wireProfile?: string,
  resolveApprovalPolicy?: () => Promise<'auto' | 'ask'>,
  onPolicyContextChange?: () => void,
  schemas?: readonly ToolSchema[],
): Promise<AcpMcpLease | undefined> {
  const agents = ctx.get('agents', false)
  const bridge = bridgeDefinitions(ctx, sessionId, schemas)
  if (bridge === undefined || agents === undefined) return undefined
  const { tools, agent, teams, hasTeams, definitions, visible } = bridge
  const initialMembership = hasTeams ? teams?.tryMembership(agent) : undefined
  const lifetime = new AbortController()
  const diagnosticLeaseId = liveDiagnosticTraceEnabled()
    ? (liveDiagnosticId('mcp-lease', randomUUID()) ?? 'unavailable')
    : undefined
  let prompt: AbortSignal | undefined
  let promptGeneration = 0
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
    feedbackCommitFailed: boolean
    accepting: boolean
    remoteOutcomeKnown: boolean
    externallyAborted: boolean
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
  const scopedInstructions = bridgeInstructions(names, hasTeams)
  const presented = new Map<string, string>()
  const permissionFences = new WeakMap<object, { generation: number; prompt: AbortSignal }>()
  const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined
  }
  const qualifiedTool = (value: unknown): string | undefined =>
    typeof value === 'string' && value.startsWith(`mcp__${serverName}__`)
      ? value.slice(`mcp__${serverName}__`.length)
      : undefined
  const codebuddyDeferredInput = (
    call: acp.ToolCallUpdate,
  ): { readonly tool?: string; readonly params?: Record<string, unknown> } | undefined => {
    if (wireProfile !== 'codebuddy') return undefined
    const input = plainRecord(call.rawInput)
    const wrapper = call.name === 'DeferExecuteTool'
    const hasTarget = input !== undefined && Object.hasOwn(input, 'toolName')
    if (!wrapper && !hasTarget) return undefined
    const qualifiedTarget = qualifiedTool(input?.['toolName'])
    const params = plainRecord(input?.['params'])
    return {
      ...(qualifiedTarget === undefined || params === undefined ? {} : { tool: qualifiedTarget, params }),
    }
  }
  const identityOf = (call: acp.ToolCallUpdate): { tool?: string; source?: AcpPermissionCheck['identitySource'] } => {
    const qualified = qualifiedTool
    const input = plainRecord(call.rawInput)
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const candidates: Array<{ tool: string | undefined; source: AcpPermissionCheck['identitySource'] }> = []
    const deferred = codebuddyDeferredInput(call)
    if (deferred !== undefined) {
      const target = qualifiedTool(input?.['toolName'])
      candidates.push({
        tool: deferred.tool,
        source: 'codebuddy-deferred-input',
      })
      // A wrapper may omit name or use its documented wrapper label. A
      // complete MCP name is also accepted only when it agrees with the
      // nested target; every other nonempty name is conflicting evidence.
      if (
        call.name != null &&
        call.name !== 'DeferExecuteTool' &&
        (target === undefined || qualified(call.name) !== target)
      )
        candidates.push({ tool: undefined, source: 'codebuddy-deferred-input' })
    }
    if ((wireProfile === 'codex' || wireProfile === 'codebuddy') && call._meta?.is_mcp_tool_call === true)
      candidates.push({
        tool: input?.server === serverName && typeof input.tool === 'string' ? input.tool : undefined,
        source: 'codex-input',
      })
    if (meta?.toolName != null) candidates.push({ tool: qualified(meta.toolName), source: 'claude-meta' })
    if (call._meta?.['cognition.ai/toolName'] != null)
      candidates.push({ tool: qualified(call._meta['cognition.ai/toolName']), source: 'devin-meta' })
    if (typeof call.name === 'string' && call.name.startsWith('mcp__'))
      candidates.push({ tool: qualified(call.name), source: 'name' })
    // Only runtime-specific, complete labels identify a server. A bare native
    // name alone never grants approval; Devin may also repeat the exact native
    // name alongside its complete server label, which must agree byte-for-byte.
    if (candidates.length === 0 && (call.name == null || wireProfile === 'devin')) {
      if (wireProfile === 'devin' && typeof call.title === 'string') {
        const match = /^(?:Calling|Called) (.+) from dsh$/.exec(call.title)
        if (match?.[0] === call.title && (call.name == null || call.name === match[1])) {
          candidates.push({ tool: match[1], source: 'devin-title' })
        }
      } else if (wireProfile === 'kimi') candidates.push({ tool: qualified(call.title), source: 'kimi-title' })
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
        qualified(call.name) !== first.tool &&
        !(wireProfile === 'codebuddy' && deferred !== undefined && call.name === 'DeferExecuteTool'))
    )
      return { source: first.source }
    return { tool: first.tool, source: first.source }
  }
  const definitionOf = (call: acp.ToolCallUpdate): ToolDefinition | undefined => {
    const tool = identityOf(call).tool
    return tool === undefined ? undefined : names.get(tool)
  }
  // Freeze a durable session default before the first prompt. Failure stays
  // fail-closed in each permission resolver below.
  if (resolveApprovalPolicy !== undefined) await resolveApprovalPolicy().catch(() => undefined)
  // Cordis returns a caller-context proxy for each service lookup, so proxy identity is not service identity.
  const live = (): boolean =>
    !lifetime.signal.aborted &&
    agents.get(sessionId as never) === agent &&
    (!hasTeams ||
      (() => {
        const current = ctx.get('agentTeams') === undefined ? undefined : teams?.tryMembership(agent)
        if (
          current === undefined ||
          initialMembership === undefined ||
          current.id !== initialMembership.id ||
          current.root !== initialMembership.root ||
          current.role !== initialMembership.role
        )
          return false
        const root = initialMembership.root
        const lead = teams?.tryMembership(root)
        return (
          agents.get(root.id as never) === root &&
          lead?.role === 'lead' &&
          lead.root === root &&
          lead.id === initialMembership.id
        )
      })()) &&
    [...definitions].every(([name, definition]) => tools.get(name, agent) === definition)
  const inspectPermission: NonNullable<AcpMcpLease['inspectPermission']> = async (request) => {
    const capturedPrompt = prompt
    const capturedGeneration = promptGeneration
    const call = request.toolCall
    const identity = identityOf(call)
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const source = identity.source
    const titleName =
      wireProfile === 'devin' && typeof call.title === 'string'
        ? /^(?:Calling|Called) ([a-zA-Z0-9_]+) from dsh$/.exec(call.title)?.[1]
        : undefined
    const facts: Omit<AcpPermissionCheck, 'reason'> = {
      ...(source === undefined ? {} : { identitySource: source }),
      structuredIdentityPresent:
        call.name != null ||
        meta?.toolName != null ||
        call._meta?.['cognition.ai/toolName'] != null ||
        source === 'codex-input' ||
        source === 'codebuddy-deferred-input',
      titleMatchesCurrentTool: titleName !== undefined && names.has(titleName),
    }
    if (!live()) return { ...facts, reason: 'inactive-connection' }
    if (capturedPrompt === undefined || capturedPrompt.aborted) return { ...facts, reason: 'inactive-prompt' }
    const definition = definitionOf(call)
    if (definition === undefined) {
      // An identified call to our own server with an unknown name cannot
      // execute, even after approval. Do not ask a user to repair a protocol
      // error, and never strip markup or guess arguments to make it runnable.
      if (identity.tool !== undefined) {
        const reject = request.options.find((option) => option.kind === 'reject_once')
        return {
          ...facts,
          reason: 'invalid-tool-name',
          response: {
            outcome:
              reject === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reject.optionId },
          },
        }
      }
      return { ...facts, reason: 'identity-unmatched' }
    }
    const identified = { ...facts, toolName: definition.name }
    const policy = resolveApprovalPolicy === undefined ? 'ask' : await resolveApprovalPolicy().catch(() => undefined)
    if (prompt !== capturedPrompt || promptGeneration !== capturedGeneration || capturedPrompt.aborted || !live())
      return { ...identified, reason: 'inactive-prompt' }
    // Policy reads fail closed. A cancelled response prevents the Agent from
    // treating an unavailable host policy as permission to proceed.
    if (policy === undefined) {
      return { ...identified, reason: 'policy-unavailable', response: { outcome: { outcome: 'cancelled' } } }
    }
    if (policy !== 'auto') return { ...identified, reason: 'approval-required' }
    if (!live() || prompt !== capturedPrompt || promptGeneration !== capturedGeneration || capturedPrompt.aborted)
      return { ...identified, reason: 'inactive-prompt' }
    const allows = request.options.filter((option) => option.kind === 'allow_once')
    const ids = request.options.map((option) => option.optionId)
    const boundedOptions =
      request.options.length <= ACP_PERMISSION_OPTIONS_MAX &&
      Buffer.byteLength(request.toolCall.toolCallId, 'utf8') <= ACP_PERMISSION_ID_MAX_BYTES &&
      ids.every(
        (id) => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id, 'utf8') <= ACP_PERMISSION_ID_MAX_BYTES,
      )
    const allow = boundedOptions && allows.length === 1 && new Set(ids).size === ids.length ? allows[0] : undefined
    return allow === undefined
      ? { ...identified, reason: 'allow-once-unavailable' }
      : (permissionFences.set(request, { generation: capturedGeneration, prompt: capturedPrompt }),
        {
          ...identified,
          reason: 'auto-approved',
          response: { outcome: { outcome: 'selected', optionId: allow.optionId } },
        })
  }
  const sessions = new Set<Server>()
  const calls = new Set<Promise<unknown>>()
  const executionScheduler = new ToolExecutionScheduler()
  // Legacy cancellation is a separate stateless HTTP request handled by another Server instance.
  // Keep only active lease-local calls here so that notification can reach the executing request.
  const activeCalls = new Map<string | number, AbortController>()
  const http = createServer((request, response) => {
    if (
      !live() ||
      request.url !== path ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${port}`
    ) {
      response.writeHead(403).end()
      return
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
        .filter(([, definition]) => tools.get(definition.name, agent) === definition)
        .map(([name, definition]) => ({
          name,
          description: visible.get(name)!.description,
          inputSchema: {
            ...visible.get(name)!.parameters,
            type: 'object' as const,
            ...(definition.name !== 'spawn_teammate'
              ? {}
              : {
                  additionalProperties: false,
                  properties: {
                    ...(definition.parameters.properties as Record<string, unknown>),
                    context: {
                      type: 'string',
                      enum: ['fresh'],
                      description: 'Fresh ACP session; history fork is unsupported.',
                    },
                  },
                }),
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
      const callRecord: ToolCallRecord = {}
      callPrompt.calls.add(callRecord)
      const call = (async () => {
        const definition = names.get(request.params.name)
        if (!live() || prompt === undefined || prompt.aborted) throw new Error('ACP_TEAM_PROMPT_INACTIVE')
        if (definition === undefined || tools.get(definition.name, agent) !== definition)
          throw new Error('ACP_TEAM_TOOL_UNAVAILABLE')
        const args = request.params.arguments ?? {}
        if (
          definition.name === 'spawn_teammate' &&
          Object.keys(args).some((key) => !['name', 'description', 'prompt', 'context'].includes(key))
        )
          throw new Error('ACP_TEAM_ROUTE_OVERRIDE_UNSUPPORTED: teammates inherit the lead Agent and model')
        if (definition.name === 'spawn_teammate' && args.context !== undefined && args.context !== 'fresh')
          throw new Error('ACP_TEAM_FORK_UNSUPPORTED: use fresh context')
        const membership = definition.name === 'send_message' ? teams?.tryMembership(agent) : undefined
        const membershipRole = membership?.role
        const membershipId = membership?.id
        const membershipRoot = membership?.root
        const executedPrompt = prompt
        const executedGeneration = promptGeneration
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
              diagnosticTargetRole =
                args.target === 'lead'
                  ? 'lead'
                  : typeof args.target === 'string' &&
                      teams
                        ?.listMembers(agent)
                        .some((member) => member.name === args.target && member.role === 'teammate')
                    ? 'teammate'
                    : 'unknown'
            } catch {
              diagnosticTargetRole = 'unknown'
            }
          }
          releaseExecution = await executionScheduler.acquire(
            () =>
              tools.executionMode({
                callId: hostCallId as never,
                name: definition.name,
                arguments: args,
                agent,
                signal: dispatchSignal,
              }).kind,
            dispatchSignal,
          )
          if (
            releaseExecution === undefined ||
            dispatchSignal.aborted ||
            !callPrompt.accepting ||
            prompt !== executedPrompt ||
            promptGeneration !== executedGeneration ||
            !live()
          ) {
            // The request was admitted to this prompt but never crossed the
            // Host ToolRuntime boundary. A natural terminal must report this
            // known non-execution rather than treating it as settled success.
            callRecord.abortedBeforeDispatch = true
            throw new Error('ACP_TEAM_PROMPT_INACTIVE')
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
          const queuedTeamMessage =
            definition.name === 'wait_agent' &&
            agent.inbox.nextStep.some((message) => hasSourceKind(message, 'team-message'))
          if (queuedTeamMessage) {
            const text =
              'DSH_WAIT_DEFERRED_TEAM_MESSAGE: A Team message is already queued for this caller, so DSH did not execute wait_agent. End this ACP response now; DSH will deliver the queued message for you to handle.'
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
            return { isError: true, content: [{ type: 'text' as const, text }] }
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
          let result: Awaited<ReturnType<typeof tools.execute>>
          try {
            result = await tools.execute({
              callId: hostCallId as never,
              name: definition.name,
              arguments: args,
              agent,
              signal: bodySignal,
            })
            if (toolErrorInfoCode(result.error) === TOOL_ABORTED_BEFORE_DISPATCH)
              callRecord.abortedBeforeDispatch = true
            if (diagnosticEnabled && diagnosticBase !== undefined) {
              const diagnosticOutcome = collectLiveDiagnostic(() => ({
                hostResultIsError: result.isError === true,
                errorKind: diagnosticErrorKind(result.error),
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
            if (diagnosticEnabled && diagnosticBase !== undefined) {
              const errorKind = collectLiveDiagnostic(() => diagnosticErrorKind(error))
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
          const additionalContexts = result.additionalContexts ?? []
          for (const context of additionalContexts) injectFeedback(context, callPrompt)
          if (callPrompt.feedbackCommitFailed)
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: callPrompt.remoteOutcomeKnown,
            })
          try {
            onPolicyContextChange?.()
          } catch {
            // A UI/control subscriber cannot prevent tool feedback from entering the native inbox.
          }
          const repeatToolReminderPending = additionalContexts.some((context) =>
            hasSourceKind(context, 'repeat-tool-reminder'),
          )
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
            prompt === executedPrompt &&
            promptGeneration === executedGeneration &&
            live()
          )
            onSuccessfulToolResult?.()
          const currentMembership = teams?.tryMembership(agent)
          if (
            definition.name === 'send_message' &&
            args.target === 'lead' &&
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
            prompt === executedPrompt &&
            promptGeneration === executedGeneration &&
            live()
          ) {
            onTeamReport?.()
          }
          if (
            result.isError !== true &&
            result.concludesTurn === true &&
            executedPrompt !== undefined &&
            !executedPrompt.aborted &&
            !context.mcpReq.signal.aborted &&
            !cancellation.signal.aborted &&
            prompt === executedPrompt &&
            promptGeneration === executedGeneration &&
            live()
          )
            onTurnConcluded?.()
          if (result.concludesTurn === true)
            content.push({
              type: 'text',
              text: generatedContextBlock(
                'This DSH tool requests the end of the current turn. Finish this ACP response now without further tool calls.',
              ),
            })
          if (repeatToolReminderPending)
            content.push({
              type: 'text',
              text: generatedContextBlock(
                'DSH has queued feedback because this tool was repeated. Stop repeating the tool call and end this ACP response now so DSH can deliver the pending feedback. Then continue based on that feedback.',
              ),
            })
          // Do not steal or duplicate inbox messages. Only the native loop claims them.
          if (agent.inbox.nextStep.length > 0 && !repeatToolReminderPending)
            content.push({
              type: 'text',
              text: generatedContextBlock(
                'DSH has queued input for your next step. End this ACP response now with a brief progress update, without a final answer; DSH will deliver the pending input and continue the turn.',
              ),
            })
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
                pendingYieldAppended: agent.inbox.nextStep.length > 0 && !repeatToolReminderPending,
                concludesTurnReminderAppended: result.concludesTurn === true,
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
          const errorKind = diagnosticErrorKind(error)
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
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'ACP_TEAM_TOOL_FAILED' }],
        }
      } finally {
        calls.delete(call)
        callPrompt.calls.delete(callRecord)
        if (activeCalls.get(requestId) === cancellation) activeCalls.delete(requestId)
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
    instructions: `Current DSH tools connection: MCP server ${serverName}. ${scopedInstructions} Each session has its own connection and caller identity. Do not copy a connection address or server identity to another session.${hasTeams ? ' Team target names resolve within the caller’s Team. Create teams only when explicitly requested.' : ''} Pending DSH messages are delivered after you end the current response; give a brief progress update when asked to yield.`,
    servers,
    ...(diagnosticLeaseId === undefined ? {} : { diagnosticLeaseId }),
    beginPrompt(signal, reportCallback, promptOrdinal, concludedCallback, bodySignal, successfulToolResultCallback) {
      if (promptExecution?.accepting === true || calls.size > 0 || pendingFeedback.size > 0)
        throw new AcpHostSettlementError('ACP_HOST_GENERATION_STILL_ACTIVE')
      prompt = signal
      onTeamReport = reportCallback
      onTurnConcluded = concludedCallback
      onSuccessfulToolResult = successfulToolResultCallback
      promptGeneration++
      if (liveDiagnosticTraceEnabled()) leasePromptOrdinal++
      adapterPromptOrdinal = promptOrdinal
      presented.clear()
      promptExecution = {
        generation: promptGeneration,
        calls: new Set(),
        terminalCalls: new Set(),
        queueAbort: new AbortController(),
        bodySignal: bodySignal ?? signal,
        feedbackCommitFailed: false,
        accepting: true,
        remoteOutcomeKnown: false,
        externallyAborted: false,
      }
    },
    endPrompt(options) {
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
      prompt = undefined
      onTeamReport = undefined
      onTurnConcluded = undefined
      onSuccessfulToolResult = undefined
      promptGeneration++
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
          promptExecution === scope &&
          !scope.remoteOutcomeKnown &&
          !scope.externallyAborted
        )
          scope.accepting = true
        if (scope.calls.size === 0 && !scope.feedbackCommitFailed) drainingPrompts.delete(scope)
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
    async waitForCallsSettled() {
      while (calls.size > 0) await Promise.allSettled([...calls])
    },
    presentTool(call) {
      const identity = identityOf(call)
      const deferred = codebuddyDeferredInput(call)
      const acceptedDeferred =
        deferred?.tool !== undefined &&
        identity.source === 'codebuddy-deferred-input' &&
        identity.tool === deferred.tool
      const wrapperCall = deferred !== undefined
      const name = definitionOf(call)?.name ?? (wrapperCall ? undefined : presented.get(call.toolCallId))
      if (name === undefined) return call
      presented.set(call.toolCallId, name)
      // Same tool title as the native host. Transport capability names stay out of the conversation row.
      return {
        ...call,
        ...(acceptedDeferred && deferred.params !== undefined ? { rawInput: deferred.params } : {}),
        title: name,
        name,
        ...(name === 'bash' ? { kind: 'execute' as const } : {}),
      }
    },
    inspectPermission,
    validatePermissionDecision(request) {
      const fence = permissionFences.get(request)
      if (
        fence === undefined ||
        !live() ||
        prompt !== fence.prompt ||
        promptGeneration !== fence.generation ||
        fence.prompt.aborted
      )
        return false
      const definition = definitionOf(request.toolCall)
      return (
        definition !== undefined &&
        names.get(definition.name) === definition &&
        tools.get(definition.name, agent) === definition
      )
    },
    async permission(request) {
      return (await inspectPermission(request)).response
    },
    elicitationToolName(request, toolCall) {
      const form = request as { toolCallId?: unknown }
      if (
        wireProfile !== 'codex' ||
        !live() ||
        prompt === undefined ||
        prompt.aborted ||
        request.mode !== 'form' ||
        request._meta?.codex_approval_kind !== 'mcp_tool_call' ||
        toolCall === undefined ||
        form.toolCallId !== toolCall.toolCallId ||
        toolCall._meta?.is_mcp_tool_call !== true
      )
        return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string') return undefined
      // Presentation only: don't rewrite arbitrary messages or infer authority
      // by stripping a prefix. Preserve additional context from other requests.
      if (request.message !== `Allow the ${serverName} MCP server to run tool "${input.tool}"?`) return undefined
      return names.get(input.tool)?.name
    },
    async elicitation(request, toolCall) {
      const form = request as {
        toolCallId?: unknown
        requestedSchema?: { properties?: Record<string, unknown>; required?: unknown[] }
      }
      if (
        wireProfile !== 'codex' ||
        !live() ||
        prompt === undefined ||
        prompt.aborted ||
        request.mode !== 'form' ||
        request._meta?.codex_approval_kind !== 'mcp_tool_call' ||
        form.toolCallId === undefined ||
        toolCall === undefined ||
        toolCall.toolCallId !== form.toolCallId ||
        toolCall._meta?.is_mcp_tool_call !== true
      )
        return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string' || !names.has(input.tool)) return undefined
      const capturedPrompt = prompt
      const capturedGeneration = promptGeneration
      const policy = resolveApprovalPolicy === undefined ? 'ask' : await resolveApprovalPolicy().catch(() => undefined)
      if (
        policy !== 'auto' ||
        capturedPrompt === undefined ||
        capturedPrompt.aborted ||
        prompt !== capturedPrompt ||
        promptGeneration !== capturedGeneration ||
        !live()
      )
        return undefined
      // Codex may add the persistence selector to an otherwise empty tool-approval form.
      // Never answer unrelated fields or grant persistent permission.
      const properties = form.requestedSchema?.properties
      const required = form.requestedSchema?.required
      if (
        properties === null ||
        typeof properties !== 'object' ||
        Array.isArray(properties) ||
        Object.keys(properties).some((key) => key !== 'persist') ||
        (required !== undefined && (!Array.isArray(required) || required.some((key) => key !== 'persist')))
      )
        return undefined
      if (properties.persist === undefined) return { action: 'accept', content: {} }
      const persist = properties.persist as { oneOf?: Array<{ const?: unknown }>; enum?: unknown[] }
      if (
        persist === null ||
        typeof persist !== 'object' ||
        (!(Array.isArray(persist.oneOf) && persist.oneOf.some((option) => option?.const === 'once')) &&
          !(Array.isArray(persist.enum) && persist.enum.includes('once')))
      )
        return undefined
      return { action: 'accept', content: { persist: 'once' } }
    },
    close(graceMs = 5_000) {
      closing ??= (async () => {
        lifetime.abort(new Error('ACP DSH tools connection closed'))
        for (const dispose of listeners.splice(0)) dispose()
        if (promptExecution !== undefined) {
          promptExecution.accepting = false
          drainingPrompts.add(promptExecution)
          promptExecution = undefined
        }
        prompt = undefined
        presented.clear()
        http.closeAllConnections()
        await waitWithin(
          new Promise<void>((resolve) => {
            http.close(() => resolve())
          }),
          graceMs,
        )
        await waitWithin(Promise.allSettled([...sessions].map((server) => server.close())), graceMs)
        await waitWithin(lease.waitForCallsSettled!(), graceMs)
      })()
      return closing
    },
  }
  listeners.push(
    ctx.on('tools/change', () => {
      if (!live()) void lease.close()
    }),
  )
  listeners.push(
    ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === agent) void lease.close()
    }),
  )
  listeners.push(
    ctx.on('internal/service', (name) => {
      if (['agentTeams', 'agents', 'tools'].includes(name) && !live()) void lease.close()
    }),
  )
  return lease
}
