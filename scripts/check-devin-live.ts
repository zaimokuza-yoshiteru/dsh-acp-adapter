/** Authenticated real Devin + published DSH AgentLoop/Teams. Logs only assertions, never wire transcripts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { safeLiveDiagnostic } from './live-diagnostics.ts'
import type { SafeLiveDiagnostic } from './live-diagnostics.ts'
import { assertDevinModelRoute, assertDevinTeamModelRoutes, selectDevinTestModel } from './devin-test-model.ts'
import { createDevinLiveToolBudget, devinLiveWaitCondition, recordDevinLiveToolAttempt } from './devin-live-budget.ts'
import { classifyDevinWaitResult } from './devin-live-wait.ts'
import { settleDevinLiveResult } from './devin-live-result.ts'
import type { DevinLiveActorRole, DevinLivePhase, DevinLiveToolKind } from './devin-live-budget.ts'
import { DevinLiveTrace } from './devin-live-trace.ts'
import {
  collectLiveDiagnostic,
  installLiveDiagnosticTrace,
  liveDiagnosticTraceFailureCount,
} from '../src/contract/live-diagnostic-trace.ts'
import { initProfile, loadProfileDirectory, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'

const executable = process.argv[2]
if (typeof executable !== 'string' || executable.length === 0) throw new Error('LIVE_CONFIG_EXECUTABLE_REQUIRED')
if (typeof process.env.WINDSURF_API_KEY !== 'string' || process.env.WINDSURF_API_KEY.length === 0)
  throw new Error('LIVE_CONFIG_TOKEN_REQUIRED')
if (process.platform === 'win32')
  if (userInfo().username !== 'dsh-acp-ci') throw new Error('LIVE_CONFIG_WINDOWS_USER_INVALID')
const token = process.env.WINDSURF_API_KEY
const originalCwd = process.cwd()
const root = await mkdtemp(join(tmpdir(), 'dsh-devin-live-'))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let traceWriteFailure = false
const traceDirectory = process.env.DEVIN_LIVE_TRACE_DIR ?? join(packageRoot, '.local', 'devin-live-diagnostics')
const trace = new DevinLiveTrace({ directory: traceDirectory, onWriteFailure: () => (traceWriteFailure = true) })
const removeTraceObserver = installLiveDiagnosticTrace(
  Object.assign(
    (event: import('../src/contract/live-diagnostic-trace.ts').LiveDiagnosticEvent) => {
      const { type, ...fields } = event
      trace.record(type, fields)
    },
    { id: trace.id.bind(trace), fingerprint: trace.fingerprint.bind(trace) },
  ),
)
const traceEvent = (event: string, fields: Record<string, unknown> = {}): void => trace.record(event, fields)
const workflowNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
traceEvent('run/metadata', {
  runId: trace.runId,
  workflowRun: workflowNumber(process.env.DEVIN_LIVE_WORKFLOW_RUN) ?? workflowNumber(process.env.GITHUB_RUN_ID),
  workflowAttempt:
    workflowNumber(process.env.DEVIN_LIVE_WORKFLOW_ATTEMPT) ?? workflowNumber(process.env.GITHUB_RUN_ATTEMPT),
  platform: process.platform,
})
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const requireHost = createRequire(installAnchor)
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const profileDir = join(home, 'profiles', 'devin-e2e')
let host: Awaited<ReturnType<typeof runProfile>> | undefined
let removeLiveToolGuard: (() => void) | undefined
let liveDeadlineAt: number | undefined
let liveDeadlineTimer: ReturnType<typeof setTimeout> | undefined
let timeBudgetViolation: string | undefined
const executions: Array<{
  name: string
  sessionId: string
  success: boolean
  diagnostic?: SafeLiveDiagnostic
}> = []
const received: Array<{ id: string; senderId: string; targetId: string; text: string }> = []
const receipts = new Map<string, { sessionId: string; seq: number }>()
const expectedReplyMarkers = new Map<string, Set<string>>()
const replyEvidence = new Map<string, Map<string, { echoSeq?: number; exactSeq?: number; exactTurn?: number }>>()
const phases = new Map<string, DevinLivePhase>()
const toolBudget = createDevinLiveToolBudget()
const lastSendBySession = new Map<string, { target: unknown; message: string }>()
const cancellationQueuedFor = new Set<string>()
let observedToolResults = 0
const queuedMessageIds = new Set<string>()
const receiptMessageIds = new Set<string>()
const deliveredMessageIds = new Set<string>()
const queuedMarkerMessageIds = new Set<string>()
const receiptMarkerMessageIds = new Set<string>()
const messageRolePairs = new Map<string, number>()
const receiptRolePairs = new Map<string, number>()
const deliveryRolePairs = new Map<string, number>()
const created = new Map<string, string>()
const modelRoutes = new Map<
  string,
  { creationModelId: string | undefined; requestModelIds: Array<string | undefined> }
>()
const roles = new Map<string, string>()
const hostRequestOrdinals = new Map<string, number>()
const bodyFingerprintsByMessageId = new Map<string, { hmac: string; bytes: number | null; complete: boolean }>()
const toolStartedAtByCallId = new Map<
  string,
  { readonly startedAt: number; readonly signal: AbortSignal; readonly onAbort: () => void }
>()
let currentStage = 'HOST_SETUP'
let finalTestResult: 'pass' | 'fail' = 'fail'
const completedTurns = new Map<string, number>()
const completedTurnIds = new Map<string, Set<number>>()
const failures: Array<{ actor: string; diagnostic: ReturnType<typeof safeLiveDiagnostic> }> = []
// The dispatch guard does not cap provider token generation or native tools,
// so bound elapsed time separately once the first real Lead prompt is sent.
const liveInteractionTimeoutMs = 4 * 60_000
const safeRole = (sessionId: string): DevinLiveActorRole => {
  const role = roles.get(sessionId)
  if (role?.startsWith('lead-')) return 'lead'
  if (role?.startsWith('member-')) return 'teammate'
  return 'unknown'
}
const safeActorLabel = (sessionId: string): string => {
  const role = roles.get(sessionId)
  return role !== undefined && /^(lead|member)-[01]$/.test(role) ? role : 'unknown'
}
const safeModel = (modelId: string | undefined): string =>
  modelId === 'swe-2-high' || modelId === 'swe-1-6-fast' ? modelId : 'other'
const safeWaitName = (label: string): string => {
  const match =
    /^(?:lead|team) (0|1) (spawn|real call|exact delivery|consumes teammate message and replies|idle|explicit follow-up)$/.exec(
      label,
    )
  if (match === null) return label === 'provider registration' ? 'provider-registration' : 'unknown'
  const [, index, action] = match
  const byAction: Record<string, string> = {
    spawn: `spawn-lead-${index}`,
    'real call': `member-call-${index}`,
    'exact delivery': `message-delivery-${index}`,
    'consumes teammate message and replies': `lead-reply-${index}`,
    idle: `team-idle-${index}`,
    'explicit follow-up': `followup-${index}`,
  }
  return byAction[action!] ?? 'unknown'
}
const safeErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'unavailable'
  try {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string' && /^ACP_[A-Z0-9_]{1,60}$/.test(code)) return code
    const message = (error as { readonly message?: unknown }).message
    const fixedMessages = new Set([
      'LIVE_WAIT_TIMED_OUT',
      'LIVE_TURN_FAILURES_PRESENT',
      'LIVE_EXIT_CODE_NONZERO_DURING_CLEANUP',
      'LIVE_BUDGET_VIOLATION_DURING_CLEANUP',
      'LIVE_TRACE_UNAVAILABLE',
      'LIVE_CONFIG_EXECUTABLE_REQUIRED',
      'LIVE_CONFIG_TOKEN_REQUIRED',
      'LIVE_CONFIG_WINDOWS_USER_INVALID',
    ])
    return typeof message === 'string' && fixedMessages.has(message) ? message : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
const safeFailureDiagnostic = (error: unknown): SafeLiveDiagnostic => {
  try {
    return safeLiveDiagnostic(
      isRecord(error) ? (error as SafeLiveDiagnostic & { message?: unknown; info?: unknown }) : {},
    )
  } catch {
    return {}
  }
}
const safeInboxCounts = (agent: {
  readonly inbox: { readonly nextStep: readonly unknown[]; readonly nextTurn: readonly unknown[] }
}) => {
  try {
    const countSources = (messages: readonly unknown[]) => {
      const counts = { user: 0, 'team-message': 0, system: 0, other: 0 }
      for (const message of messages) {
        const source = isRecord(message) && isRecord(message.source) ? message.source.kind : undefined
        if (source === 'user' || source === 'team-message' || source === 'system') counts[source] += 1
        else counts.other += 1
      }
      return counts
    }
    const nextStep = countSources(agent.inbox.nextStep)
    const nextTurn = countSources(agent.inbox.nextTurn)
    return {
      pendingPromptCount: agent.inbox.nextStep.length + agent.inbox.nextTurn.length,
      nextStepCount: agent.inbox.nextStep.length,
      nextTurnCount: agent.inbox.nextTurn.length,
      nextStepTeamMessageCount: nextStep['team-message'],
      nextTurnTeamMessageCount: nextTurn['team-message'],
      nextStepSourceCounts: nextStep,
      nextTurnSourceCounts: nextTurn,
      callerInboxPending: agent.inbox.nextStep.length > 0,
      callerInboxSources: nextStep,
      inboxCountStatus: 'available' as const,
    }
  } catch {
    return { inboxCountStatus: 'unavailable' as const }
  }
}
const hasExactMarker = (text: string): boolean =>
  [...expectedReplyMarkers.values()].some((markers) => markers.has(text.trim()))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const spawnArgumentPresence = (args: Record<string, unknown> | undefined) => ({
  nameNonblank: typeof args?.name === 'string' && args.name.trim().length > 0,
  descriptionNonblank: typeof args?.description === 'string' && args.description.trim().length > 0,
  promptNonblank: typeof args?.prompt === 'string' && args.prompt.trim().length > 0,
  contextFresh: args?.context === 'fresh',
})
const countRolePair = (counts: Map<string, number>, from: DevinLiveActorRole, to: DevinLiveActorRole): void => {
  const key = `${from}->${to}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
const cancelActiveDevinAgents = (reason: string): void => {
  if (host === undefined) return
  try {
    for (const agent of host.ctx.agents.list()) {
      if (agent.options.provider !== 'acp-devin') continue
      try {
        agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
      } catch {
        // Keep cancelling other test Agents if one has already been disposed.
      }
    }
  } catch {
    // Host shutdown below remains the final cleanup if the registry is closing.
  }
}
const expireLiveBudget = (): void => {
  if (timeBudgetViolation !== undefined) return
  timeBudgetViolation = 'LIVE_TIME_BUDGET_EXCEEDED'
  toolBudget.violation ??= timeBudgetViolation
  cancelActiveDevinAgents('LIVE_TIME_BUDGET')
}
const diagnosticFailureCode = (): string | undefined => {
  if (trace.writeFailed || traceWriteFailure) return 'LIVE_TRACE_WRITE_FAILED'
  if (liveDiagnosticTraceFailureCount() > 0) return 'LIVE_TRACE_OBSERVER_FAILED'
  if (trace.diagnosticIncomplete) return 'LIVE_TRACE_INCOMPLETE'
  return undefined
}
const assertLiveBudget = (): void => {
  const diagnosticFailure = diagnosticFailureCode()
  if (diagnosticFailure !== undefined) {
    toolBudget.violation ??= diagnosticFailure
    cancelActiveDevinAgents('LIVE_TRACE_FAILURE')
    throw new Error(diagnosticFailure)
  }
  if (timeBudgetViolation !== undefined) throw new Error(timeBudgetViolation)
  if (liveDeadlineAt !== undefined && performance.now() >= liveDeadlineAt) {
    expireLiveBudget()
    throw new Error(timeBudgetViolation)
  }
  if (toolBudget.violation !== undefined) throw new Error(toolBudget.violation)
}
const startLiveBudget = (): void => {
  if (liveDeadlineAt !== undefined) return
  liveDeadlineAt = performance.now() + liveInteractionTimeoutMs
  liveDeadlineTimer = setTimeout(expireLiveBudget, liveInteractionTimeoutMs)
}
const stopLiveBudget = (): void => {
  if (liveDeadlineTimer !== undefined) clearTimeout(liveDeadlineTimer)
  liveDeadlineTimer = undefined
}
const wait = async (condition: () => boolean, label: string) => {
  const waitName = safeWaitName(label)
  const startedAt = performance.now()
  const deadline = performance.now() + 90_000
  traceEvent('test/wait/start', { waitName, resultSource: 'host-condition' })
  while (true) {
    assertLiveBudget()
    if (performance.now() >= deadline) {
      traceEvent('test/wait/end', {
        waitName,
        waitResult: 'timedOut',
        resultSource: 'host-condition',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      })
      throw new Error('LIVE_WAIT_TIMED_OUT')
    }
    if (
      devinLiveWaitCondition(() => {
        assertLiveBudget()
        assert.equal(failures.length, 0, JSON.stringify(failures))
        return condition()
      }, toolBudget.violation)
    ) {
      assertLiveBudget()
      traceEvent('test/wait/end', {
        waitName,
        waitResult: 'observedChange',
        resultSource: 'host-condition',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      })
      return
    }
    await delay(100)
  }
}
const expectReplyMarker = (sessionId: string, marker: string) => {
  const markers = expectedReplyMarkers.get(sessionId) ?? new Set<string>()
  markers.add(marker)
  expectedReplyMarkers.set(sessionId, markers)
}
try {
  if (trace.writeFailed || traceWriteFailure) throw new Error('LIVE_TRACE_UNAVAILABLE')
  await mkdir(workspace, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DSH_SKILL_ROOTS = join(root, 'skills')
  process.chdir(workspace)
  const bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    '@zaimokuza/dsh-acp-adapter',
  ]
  initProfile(profileDir, bundles)
  for (const name of bundles) {
    const directory = name.startsWith('@zaimokuza/')
      ? packageRoot
      : dirname(requireHost.resolve(`${name}/package.json`))
    const link = join(profileDir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(directory, link, 'junction')
  }
  // All services are native. Disable unrelated model calls, telemetry and workspace instruction discovery.
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    JSON.stringify([
      ...[
        'session-title-llm',
        'llm-deepseek',
        'llm-pi-ai',
        'agent-instructions',
        'skill-filesystem',
        'session-telemetry-otel',
      ].map((id) => ({ id, disabled: true })),
      { id: 'agent-team', config: { maxMembers: 2, maxTasks: 8 } },
      { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
    ]),
  )
  const profile = loadProfileDirectory('devin-e2e', profileDir, installAnchor)
  currentStage = 'HOST_START'
  host = await runProfile({
    environment: loadLayeredEnv('devin-e2e'),
    profile: 'devin-e2e',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [],
  })
  traceEvent('host/ready', { provider: 'other' })
  traceEvent('phase/completed', { phaseCode: 'HOST_BOOT' })
  currentStage = 'PROVIDER_SETUP'
  const ctx = host.ctx
  removeLiveToolGuard = ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent?.options.provider !== 'acp-devin') return undefined

    const sessionId = agent.id
    const diagnosticFailure = diagnosticFailureCode()
    if (diagnosticFailure !== undefined) toolBudget.violation ??= diagnosticFailure
    if (liveDeadlineAt !== undefined && performance.now() >= liveDeadlineAt) expireLiveBudget()
    const role = safeRole(sessionId)
    const phase = phases.get(sessionId) ?? 'unknown'
    const tool: DevinLiveToolKind =
      execution.name === 'spawn_teammate' ||
      execution.name === 'send_message' ||
      execution.name === 'bash' ||
      execution.name === 'wait_agent'
        ? execution.name
        : 'other'
    const violation = recordDevinLiveToolAttempt(toolBudget, { sessionKey: sessionId, role, phase, tool })
    const args = isRecord(execution.arguments) ? execution.arguments : undefined
    const sendTarget = args?.target === 'lead' ? 'lead' : args?.target === 'checker' ? 'checker' : 'unknown'
    let repeatPrevious: boolean | undefined
    let exactExpectedMarker: boolean | undefined
    if (tool === 'send_message') {
      const message = typeof args?.message === 'string' ? args.message : ''
      const previous = lastSendBySession.get(sessionId)
      repeatPrevious = previous !== undefined && previous.target === args?.target && previous.message === message
      exactExpectedMarker = hasExactMarker(message)
      lastSendBySession.set(sessionId, { target: args?.target, message })
    }

    const argsFingerprint = trace.fingerprint('host-tool-arguments', execution.arguments)
    const messageFingerprint =
      tool === 'send_message' && typeof args?.message === 'string'
        ? trace.fingerprint('team-message-body', args.message)
        : undefined
    const callId = typeof execution.callId === 'string' ? execution.callId : undefined
    const inboxSnapshot = safeInboxCounts(agent)
    if (violation === undefined && callId !== undefined) {
      const startedAt = performance.now()
      const onAbort = (): void =>
        traceEvent('tool/cancelled', {
          actorId: trace.id('dsh-session', sessionId),
          hostCallId: trace.id('host-call', callId),
          actorRole: role,
          actorLabel: safeActorLabel(sessionId),
          phase,
          tool,
          resultStatus: 'cancelled',
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          durationSource: 'host-tool-result',
          mcpRequestIdStatus: 'unavailable',
        })
      execution.signal.addEventListener('abort', onAbort, { once: true })
      toolStartedAtByCallId.set(callId, { startedAt, signal: execution.signal, onAbort })
    }
    traceEvent('tool/admission', {
      actorId: trace.id('dsh-session', sessionId),
      hostCallId: callId === undefined ? 'unavailable' : trace.id('host-call', callId),
      rootHostCallId:
        typeof execution.rootCallId === 'string' ? trace.id('host-call', execution.rootCallId) : 'unavailable',
      actorRole: role,
      actorLabel: safeActorLabel(sessionId),
      phase,
      tool,
      dispatchAttempt: toolBudget.dispatchAttempts,
      admission: violation === undefined ? 'admitted' : 'denied',
      allowed: violation === undefined,
      phaseCode: violation ?? 'LIVE_TOOL_ALLOWED',
      mcpRequestIdStatus: 'unavailable',
      argsHmac: argsFingerprint.hmac,
      argsBytes: argsFingerprint.bytes,
      argsFingerprintComplete: argsFingerprint.complete,
      ...(messageFingerprint === undefined
        ? {}
        : {
            bodyHmac: messageFingerprint.hmac,
            bodyBytes: messageFingerprint.bytes,
            bodyFingerprintComplete: messageFingerprint.complete,
          }),
      ...inboxSnapshot,
      ...(tool === 'send_message'
        ? {
            targetRole: sendTarget === 'lead' ? 'lead' : sendTarget === 'checker' ? 'teammate' : 'unknown',
            callerInboxPending: inboxSnapshot.callerInboxPending ?? null,
            exactExpectedMarker,
            repeatPrevious,
          }
        : {}),
      ...(tool === 'spawn_teammate' ? spawnArgumentPresence(args) : {}),
    })

    if (violation === undefined) {
      const lateDiagnosticFailure = diagnosticFailureCode()
      if (lateDiagnosticFailure === undefined) return undefined
      toolBudget.violation ??= lateDiagnosticFailure
      toolBudget.allowedDispatches = Math.max(0, toolBudget.allowedDispatches - 1)
      toolBudget.deniedDispatches += 1
    }
    if (!cancellationQueuedFor.has(sessionId)) {
      cancellationQueuedFor.add(sessionId)
      queueMicrotask(() => agent.cancel({ kind: 'hook', reason: 'LIVE_TOOL_BUDGET' }, { keepInbox: true }))
    }
    return 'LIVE_TOOL_BUDGET'
  })
  const env = {
    WINDSURF_API_KEY: token,
    HOME: join(root, 'native-home'),
    XDG_CONFIG_HOME: join(root, 'native-config'),
    XDG_DATA_HOME: join(root, 'native-data'),
    XDG_CACHE_HOME: join(root, 'native-cache'),
  }
  await ctx.settings.replace('dsh-acp-adapter', {
    agents: { devin: { name: 'Devin CI', command: executable, args: ['acp'], env } },
  })
  await wait(() => ctx.llm.listProviders().some((p) => p.id === 'acp-devin'), 'provider registration')
  traceEvent('phase/completed', { phaseCode: 'PROVIDER_REGISTERED' })
  const models = await ctx.llm.listModels('acp-devin')
  const model = selectDevinTestModel(models, process.env.DEVIN_TEST_MODEL)
  traceEvent('provider/ready', { provider: 'acp-devin' })
  traceEvent('model/selected', { provider: 'acp-devin', model: safeModel(model.id) })
  currentStage = 'RUN_TEAMS'
  ctx.on('agent/created', ({ agent }) => {
    if (agent.options.provider === 'acp-devin') assertLiveBudget()
    const previousRoute = modelRoutes.get(agent.id)
    modelRoutes.set(agent.id, {
      creationModelId: agent.options.model,
      requestModelIds: previousRoute?.requestModelIds ?? [],
    })
    if (agent.options.provider !== undefined) created.set(agent.id, agent.options.provider)
    // Team membership is journaled before the child Agent is started. Resolve
    // the parent Lead here so a fast teammate tool call is labeled correctly.
    const parentRole =
      agent.session.header.parentSession === undefined ? undefined : roles.get(agent.session.header.parentSession)
    if (parentRole?.startsWith('lead-')) {
      assertDevinModelRoute('teammate', model.id, agent.options.model)
      roles.set(agent.id, `member-${parentRole.slice('lead-'.length)}`)
      phases.set(agent.id, 'initial')
    }
    traceEvent('agent/created', {
      actorId: trace.id('dsh-session', agent.id),
      actorRole: safeRole(agent.id),
      actorLabel: safeActorLabel(agent.id),
      provider: agent.options.provider === 'acp-devin' ? 'acp-devin' : 'other',
      model: safeModel(agent.options.model),
      parentSessionId:
        typeof agent.session.header.parentSession === 'string'
          ? trace.id('dsh-session', agent.session.header.parentSession)
          : 'unavailable',
    })
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider === 'acp-devin') {
      observedToolResults += 1
      const sessionId = execution.agent.id
      const role = safeRole(sessionId)
      const phase = phases.get(sessionId) ?? 'unknown'
      const tool: DevinLiveToolKind =
        execution.name === 'spawn_teammate' ||
        execution.name === 'send_message' ||
        execution.name === 'bash' ||
        execution.name === 'wait_agent'
          ? execution.name
          : 'other'
      const diagnostic = result.isError ? safeFailureDiagnostic(result.error) : undefined
      const argumentsRecord = isRecord(execution.arguments) ? execution.arguments : undefined
      const resultRecord = !result.isError && isRecord(result.value) ? result.value : undefined
      const sendTarget =
        argumentsRecord?.target === 'lead' ? 'lead' : argumentsRecord?.target === 'checker' ? 'checker' : 'unknown'
      const sendStatus = result.isError
        ? 'error'
        : resultRecord?.status === 'accepted' || resultRecord?.status === 'queued'
          ? resultRecord.status
          : 'unknown'
      const hostCallId = typeof execution.callId === 'string' ? execution.callId : undefined
      const messageId = typeof resultRecord?.messageId === 'string' ? resultRecord.messageId : undefined
      const messageFingerprint =
        tool === 'send_message' && typeof argumentsRecord?.message === 'string'
          ? trace.fingerprint('team-message-body', argumentsRecord.message)
          : undefined
      if (messageId !== undefined) {
        const body = messageFingerprint ?? { hmac: 'unavailable', bytes: null, complete: false }
        bodyFingerprintsByMessageId.set(messageId, body)
      }
      const started = hostCallId === undefined ? undefined : toolStartedAtByCallId.get(hostCallId)
      const startedAt = started?.startedAt
      if (hostCallId !== undefined) {
        if (started !== undefined) started.signal.removeEventListener('abort', started.onAbort)
        toolStartedAtByCallId.delete(hostCallId)
      }
      const waitResult = tool === 'wait_agent' ? classifyDevinWaitResult(result.value) : undefined
      executions.push({
        name: execution.name,
        sessionId,
        success: !result.isError,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      })
      const diagnosticError = result.isError ? safeFailureDiagnostic(result.error) : undefined
      const argumentFingerprint = collectLiveDiagnostic(() =>
        trace.fingerprint('host-tool-arguments', execution.arguments),
      ) ?? {
        hmac: 'unavailable',
        bytes: null,
        complete: false,
      }
      traceEvent('tool/settled', {
        actorId: trace.id('dsh-session', sessionId),
        hostCallId: hostCallId === undefined ? 'unavailable' : trace.id('host-call', hostCallId),
        rootHostCallId:
          typeof execution.rootCallId === 'string' ? trace.id('host-call', execution.rootCallId) : 'unavailable',
        actorRole: role,
        actorLabel: safeActorLabel(sessionId),
        phase,
        tool,
        success: !result.isError,
        resultStatus: result.isError
          ? 'error'
          : sendStatus === 'accepted' || sendStatus === 'queued'
            ? sendStatus
            : 'success',
        durationMs: startedAt === undefined ? null : Math.max(0, Math.round(performance.now() - startedAt)),
        durationSource: startedAt === undefined ? 'unavailable' : 'host-tool-result',
        argsHmac: argumentFingerprint.hmac,
        argsBytes: argumentFingerprint.bytes,
        argsFingerprintComplete: argumentFingerprint.complete,
        ...(messageFingerprint === undefined
          ? {}
          : {
              bodyHmac: messageFingerprint.hmac,
              bodyBytes: messageFingerprint.bytes,
              bodyFingerprintComplete: messageFingerprint.complete,
            }),
        messageId: messageId === undefined ? 'unavailable' : trace.id('team-message', messageId),
        messageIdStatus: messageId === undefined ? 'unavailable' : 'available',
        mcpRequestIdStatus: 'unavailable',
        ...(waitResult === undefined ? {} : { waitResult }),
        ...(diagnosticError?.code === undefined ? {} : { errorCode: diagnosticError.code }),
        ...(tool === 'send_message'
          ? {
              targetRole: sendTarget === 'lead' ? 'lead' : sendTarget === 'checker' ? 'teammate' : 'unknown',
              sendStatus,
              callerInboxPending: safeInboxCounts(execution.agent).callerInboxPending ?? null,
              exactExpectedMarker: hasExactMarker(
                typeof argumentsRecord?.message === 'string' ? argumentsRecord.message : '',
              ),
            }
          : {}),
        ...(tool === 'spawn_teammate' ? spawnArgumentPresence(argumentsRecord) : {}),
      })
    }
  })
  ctx.on('session/event', (_session, event) => {
    const sessionId = _session.id
    const sessionTraceId = trace.id('dsh-session', sessionId)
    const base = {
      sessionId: sessionTraceId,
      actorId: sessionTraceId,
      actorRole: safeRole(sessionId),
      actorLabel: safeActorLabel(sessionId),
      phase: phases.get(sessionId) ?? 'unknown',
      hostEvent: event.type,
      nativeEventSeq: event.seq,
      ...(typeof event.data === 'object' && event.data !== null && 'turn' in event.data
        ? {
            turn: Number.isSafeInteger(event.data.turn) ? event.data.turn : undefined,
            turnId: trace.id('dsh-turn', { sessionId, turn: event.data.turn }),
          }
        : {}),
      ...(typeof event.data === 'object' && event.data !== null && 'step' in event.data
        ? {
            step: Number.isSafeInteger(event.data.step) ? event.data.step : undefined,
            stepId: trace.id('dsh-step', {
              sessionId,
              turn: 'turn' in event.data ? event.data.turn : 'unavailable',
              step: event.data.step,
            }),
          }
        : {}),
    }
    const eventFields: Record<string, unknown> = { ...base }
    if (event.type === 'request/header') {
      const route = modelRoutes.get(_session.id) ?? { creationModelId: undefined, requestModelIds: [] }
      route.requestModelIds.push(event.data.header.config.model)
      modelRoutes.set(_session.id, route)
      const ordinal = (hostRequestOrdinals.get(sessionId) ?? 0) + 1
      hostRequestOrdinals.set(sessionId, ordinal)
      eventFields.requestModelOrdinal = ordinal
      eventFields.model = safeModel(event.data.header.config.model)
    }
    if (event.type === 'team/message/queued') {
      const message = event.data.message
      const text = message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      queuedMessageIds.add(message.id)
      if (hasExactMarker(text)) queuedMarkerMessageIds.add(message.id)
      const senderRole = safeRole(message.senderId)
      const targetRole = safeRole(message.targetId)
      countRolePair(messageRolePairs, senderRole, targetRole)
      received.push({
        id: message.id,
        senderId: message.senderId,
        targetId: message.targetId,
        text,
      })
      const bodyFingerprint = trace.fingerprint('team-message-body', text)
      bodyFingerprintsByMessageId.set(message.id, bodyFingerprint)
      traceEvent('team/message/queued', {
        ...eventFields,
        messageId: trace.id('team-message', message.id),
        senderId: trace.id('dsh-session', message.senderId),
        targetId: trace.id('dsh-session', message.targetId),
        senderRole,
        senderLabel: safeActorLabel(message.senderId),
        targetRole,
        targetLabel: safeActorLabel(message.targetId),
        bodyHmac: bodyFingerprint.hmac,
        bodyBytes: bodyFingerprint.bytes,
        bodyFingerprintComplete: bodyFingerprint.complete,
        exactExpectedMarker: hasExactMarker(text),
        uniqueQueuedMessages: queuedMessageIds.size,
        nativeReceiptStatus: 'pending',
      })
    }
    if (event.type === 'team/message/delivered') {
      const message = received.find((candidate) => candidate.id === event.data.messageId)
      deliveredMessageIds.add(event.data.messageId)
      const senderRole = message === undefined ? 'unknown' : safeRole(message.senderId)
      const targetRole = safeRole(event.data.targetId)
      countRolePair(deliveryRolePairs, senderRole, targetRole)
      const bodyFingerprint = bodyFingerprintsByMessageId.get(event.data.messageId)
      traceEvent('team/message/delivered', {
        ...eventFields,
        messageId: trace.id('team-message', event.data.messageId),
        senderId: message === undefined ? 'unavailable' : trace.id('dsh-session', message.senderId),
        targetId: trace.id('dsh-session', event.data.targetId),
        senderRole,
        senderLabel: message === undefined ? 'unknown' : safeActorLabel(message.senderId),
        targetRole,
        targetLabel: safeActorLabel(event.data.targetId),
        ...(bodyFingerprint === undefined
          ? { bodyHmac: 'unavailable', bodyBytes: null, bodyFingerprintComplete: false }
          : {
              bodyHmac: bodyFingerprint.hmac,
              bodyBytes: bodyFingerprint.bytes,
              bodyFingerprintComplete: bodyFingerprint.complete,
            }),
        matchedQueuedMessage: queuedMessageIds.has(event.data.messageId),
        exactExpectedMarker: message === undefined ? false : hasExactMarker(message.text),
        uniqueDeliveredMessages: deliveredMessageIds.size,
      })
    }
    if (event.type === 'user/message' && event.data.source.kind === 'team-message') {
      const source = event.data.source
      receipts.set(source.messageId, { sessionId: _session.id, seq: event.seq })
      receiptMessageIds.add(source.messageId)
      const senderRole = safeRole(source.senderId)
      const targetRole = safeRole(_session.id)
      countRolePair(receiptRolePairs, senderRole, targetRole)
      const message = received.find((candidate) => candidate.id === source.messageId)
      const exactExpectedMarker = message === undefined ? false : hasExactMarker(message.text)
      if (exactExpectedMarker) receiptMarkerMessageIds.add(source.messageId)
      if (targetRole !== 'unknown') phases.set(_session.id, 'mailbox')
      const bodyFingerprint = bodyFingerprintsByMessageId.get(source.messageId)
      traceEvent('team-message/receipt', {
        ...eventFields,
        messageId: trace.id('team-message', source.messageId),
        senderId: trace.id('dsh-session', source.senderId),
        targetId: trace.id('dsh-session', _session.id),
        senderRole,
        senderLabel: safeActorLabel(source.senderId),
        targetRole,
        targetLabel: safeActorLabel(_session.id),
        ...(bodyFingerprint === undefined
          ? { bodyHmac: 'unavailable', bodyBytes: null, bodyFingerprintComplete: false }
          : {
              bodyHmac: bodyFingerprint.hmac,
              bodyBytes: bodyFingerprint.bytes,
              bodyFingerprintComplete: bodyFingerprint.complete,
            }),
        matchedQueuedMessage: queuedMessageIds.has(source.messageId),
        exactExpectedMarker,
        uniqueReceipts: receiptMessageIds.size,
      })
    }
    if (event.type === 'assistant/message' && event.data.interrupted !== true) {
      const text = event.data.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      const phase = phases.get(_session.id) ?? 'unknown'
      if (phase === 'mailbox' || phase === 'followup') {
        traceEvent('session/event', {
          ...eventFields,
          hostEvent: 'assistant/message',
          exactExpectedMarker: hasExactMarker(text),
          exactMessageMatch: [...(expectedReplyMarkers.get(_session.id) ?? [])].some(
            (marker) => text.trim() === marker,
          ),
          mcpRequestIdStatus: 'unavailable',
        })
      }
      for (const marker of expectedReplyMarkers.get(_session.id) ?? []) {
        if (!text.includes(marker)) continue
        const byMarker =
          replyEvidence.get(_session.id) ??
          new Map<string, { echoSeq?: number; exactSeq?: number; exactTurn?: number }>()
        const evidence = byMarker.get(marker) ?? {}
        evidence.echoSeq = event.seq
        if (text.trim() === marker) {
          evidence.exactSeq = event.seq
          evidence.exactTurn = event.data.turn
        }
        byMarker.set(marker, evidence)
        replyEvidence.set(_session.id, byMarker)
      }
    }
    if (event.type === 'turn/end') {
      const actorRole = safeRole(_session.id)
      const reason = event.data.reason
      if (reason.kind === 'error') failures.push({ actor: actorRole, diagnostic: safeFailureDiagnostic(reason.error) })
      else if (reason.kind === 'completed') {
        completedTurns.set(_session.id, (completedTurns.get(_session.id) ?? 0) + 1)
        const turns = completedTurnIds.get(_session.id) ?? new Set<number>()
        turns.add(event.data.turn)
        completedTurnIds.set(_session.id, turns)
      }
      traceEvent('session/event', {
        ...eventFields,
        hostEvent: 'turn/end',
        resultStatus: reason.kind === 'error' ? 'error' : reason.kind === 'completed' ? 'success' : 'unknown',
        errorCode: reason.kind === 'error' ? safeErrorCode(reason.error) : 'unavailable',
        acpFinishReason: 'unavailable',
      })
    }
    if (
      event.type !== 'assistant/message' &&
      event.type !== 'turn/end' &&
      event.type !== 'team/message/queued' &&
      event.type !== 'team/message/delivered' &&
      event.type !== 'user/message'
    )
      traceEvent('session/event', eventFields)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const source = collectLiveDiagnostic(() => {
      const rawSource = (message as unknown as { readonly source?: unknown }).source
      return isRecord(rawSource) ? rawSource : undefined
    })
    const rawMessageId =
      source?.kind === 'team-message' && typeof source.messageId === 'string' ? source.messageId : undefined
    const bodyFingerprint = rawMessageId === undefined ? undefined : bodyFingerprintsByMessageId.get(rawMessageId)
    traceEvent('agent/inbox/claimed', {
      actorId: trace.id('dsh-session', agent.id),
      sessionId: trace.id('dsh-session', agent.id),
      actorRole: safeRole(agent.id),
      actorLabel: safeActorLabel(agent.id),
      turn,
      messageId: rawMessageId === undefined ? 'unavailable' : trace.id('team-message', rawMessageId),
      senderId:
        source?.kind === 'team-message' && typeof source.senderId === 'string'
          ? trace.id('dsh-session', source.senderId)
          : 'unavailable',
      nativeReceiptStatus: rawMessageId === undefined ? 'unavailable' : 'claimed',
      ...(bodyFingerprint === undefined
        ? { bodyHmac: 'unavailable', bodyBytes: null, bodyFingerprintComplete: false }
        : {
            bodyHmac: bodyFingerprint.hmac,
            bodyBytes: bodyFingerprint.bytes,
            bodyFingerprintComplete: bodyFingerprint.complete,
          }),
    })
  })
  // Two independent leads exercise a single shared native MCP entry concurrently.
  const leads = await Promise.all(
    [0, 1].map(async (index) => {
      assertLiveBudget()
      const handle = await ctx.agents.create({
        sessionId: randomUUID() as SessionId,
        meta: { cwd: workspace },
        agentOptions: { provider: 'acp-devin', model: model.id },
      })
      assertLiveBudget()
      assertDevinModelRoute('Lead', model.id, handle.agent.options.model)
      roles.set(handle.agent.id, `lead-${index}`)
      phases.set(handle.agent.id, 'initial')
      const marker = `CI_${index}_${randomUUID().slice(0, 8)}`
      expectReplyMarker(handle.agent.id, marker)
      return { handle, marker, index }
    }),
  )
  startLiveBudget()
  for (const { handle, marker } of leads) {
    assertLiveBudget()
    const memberPrompt = `Call send_message exactly once with target "lead" and message "${marker}". Then stop. Do not call any more tools, send any other messages, or do extra work.`
    const spawnArguments = JSON.stringify({
      name: 'checker',
      description: 'Report the exact marker to the Lead and stop.',
      context: 'fresh',
      prompt: memberPrompt,
    })
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: `This is an explicitly authorized DSH Agent Teams test. Use only the DSH MCP server named dsh. Call spawn_teammate exactly once with this exact JSON argument object: ${spawnArguments}. Do not use send_message yourself. Do not use shell, files, web, or native subagent tools. After creating the teammate, end your response so DSH can deliver its reply. When the teammate's exact marker arrives, echo ${marker} as your response and stop; do not call any more tools or send any team messages.`,
          },
        ],
      }),
    )
  }
  for (const { handle, index, marker } of leads) {
    const lead = handle.agent
    await wait(
      () => executions.some((e) => e.sessionId === lead.id && e.name === 'spawn_teammate' && e.success),
      `lead ${index} spawn`,
    )
    const members = ctx.agentTeams.listMembers(lead)
    assert.equal(members.length, 2, 'Exactly one real teammate per lead')
    const member = members.find((m) => m.role === 'teammate')!
    roles.set(member.id, `member-${index}`)
    assert.equal(member.name, 'checker', 'Same member name must resolve within its own Team')
    assert.equal(created.get(member.id), 'acp-devin', 'Native DSH must create a real ACP teammate')
    await wait(
      () => executions.some((e) => e.sessionId === member.id && e.name === 'send_message' && e.success),
      `teammate ${index} real call`,
    )
    await wait(
      () => received.some((m) => m.senderId === member.id && m.targetId === lead.id && m.text.includes(marker)),
      `team ${index} exact delivery`,
    )
    // A teammate reply can enter the Lead's next step before its first turn
    // closes. Verify target-side consumption and a subsequent reply, not a
    // timing-dependent requirement that delivery creates a second turn.
    await wait(
      () =>
        received.some((message) => {
          const receipt = receipts.get(message.id)
          const answer = replyEvidence.get(lead.id)?.get(marker)
          return (
            message.senderId === member.id &&
            message.targetId === lead.id &&
            message.text.includes(marker) &&
            receipt?.sessionId === lead.id &&
            answer?.echoSeq !== undefined &&
            answer.echoSeq > receipt.seq
          )
        }),
      `lead ${index} consumes teammate message and replies`,
    )
    await wait(() => ctx.agentTeams.listMembers(lead).every((m) => m.status === 'inactive'), `team ${index} idle`)
    assert.ok(
      !received.some((m) => m.senderId === member.id && m.targetId !== lead.id),
      'Teammate must not send to another lead',
    )
  }
  // Independently require an explicit follow-up after both teams have settled.
  // This exercises established ACP bindings even when mailbox delivery stayed
  // within the first native turn. Responses remain in memory and are not logged.
  await Promise.all(
    leads.map(async ({ handle, index }) => {
      assertLiveBudget()
      phases.set(handle.agent.id, 'followup')
      const before = completedTurns.get(handle.agent.id) ?? 0
      assert.ok(before >= 1, 'Initial Lead turn must have completed')
      const marker = `FOLLOWUP_${index}_${randomUUID().slice(0, 8)}`
      expectReplyMarker(handle.agent.id, marker)
      assertLiveBudget()
      handle.agent.followup(
        createUserMessage({
          source: { kind: 'user' },
          content: [
            { type: 'text', text: `Reply with exactly ${marker}. Do not call any tools or send any team messages.` },
          ],
        }),
      )
      await wait(() => {
        const reply = replyEvidence.get(handle.agent.id)?.get(marker)
        return (
          (completedTurns.get(handle.agent.id) ?? 0) > before &&
          reply?.exactSeq !== undefined &&
          reply.exactTurn !== undefined &&
          completedTurnIds.get(handle.agent.id)?.has(reply.exactTurn) === true
        )
      }, `lead ${index} explicit follow-up`)
    }),
  )
  for (const { handle, index } of leads) {
    const lead = handle.agent
    const member = ctx.agentTeams.listMembers(lead).find((candidate) => candidate.role === 'teammate')!
    assert.ok(
      !received.some((message) => message.senderId === member.id && message.targetId !== lead.id),
      `Teammate ${index} must not message another Team`,
    )
  }
  for (const { handle } of leads) {
    const member = ctx.agentTeams.listMembers(handle.agent).find((candidate) => candidate.role === 'teammate')!
    assertDevinTeamModelRoutes(model.id, modelRoutes.get(handle.agent.id), modelRoutes.get(member.id))
  }
  assertLiveBudget()
  assert.equal(failures.length, 0, 'LIVE_TURN_FAILURES_PRESENT')
  assert.equal(toolBudget.violation, undefined)
  assert.notEqual(
    ctx.agentTeams.listMembers(leads[0]!.handle.agent)[1]!.id,
    ctx.agentTeams.listMembers(leads[1]!.handle.agent)[1]!.id,
  )
  stopLiveBudget()
  for (const { handle } of leads) await handle.dispose()
  finalTestResult = 'pass'
} catch (error) {
  traceEvent('test/fail', {
    phaseCode: 'LIVE_TEST_FAILED',
    stageCode: currentStage,
    errorCode: safeErrorCode(error),
    errorSource: 'structured-code-only',
  })
  process.exitCode = 1
} finally {
  traceEvent('cleanup/start', { exitCode: process.exitCode ?? 0 })
  try {
    if (process.exitCode === 1) cancelActiveDevinAgents('LIVE_TEST_CLEANUP')
    try {
      await host?.shutdown.shutdown(process.exitCode === 1 ? 1 : 0)
    } catch (error) {
      finalTestResult = 'fail'
      process.exitCode = 1
      traceEvent('test/fail', {
        phaseCode: 'LIVE_TEST_FAILED',
        stageCode: 'CLEANUP',
        errorCode: safeErrorCode(error),
        errorSource: 'cleanup',
      })
    }
  } finally {
    stopLiveBudget()
    try {
      removeLiveToolGuard?.()
    } catch {
      finalTestResult = 'fail'
      process.exitCode = 1
      traceEvent('test/fail', {
        phaseCode: 'LIVE_TEST_FAILED',
        stageCode: 'CLEANUP',
        errorCode: 'unavailable',
        errorSource: 'cleanup',
      })
    }
    traceEvent('cleanup/end', { exitCode: process.exitCode ?? 0 })
    const traceObserverFailures = liveDiagnosticTraceFailureCount()
    if (traceObserverFailures > 0 || trace.writeFailed || traceWriteFailure || trace.diagnosticIncomplete) {
      finalTestResult = 'fail'
      process.exitCode = 1
      traceEvent('test/fail', {
        phaseCode: 'LIVE_TEST_FAILED',
        stageCode: 'DIAGNOSTICS',
        errorCode: 'unavailable',
        errorSource:
          trace.writeFailed || traceWriteFailure
            ? 'trace-write'
            : traceObserverFailures > 0
              ? 'trace-observer'
              : 'trace-incomplete',
      })
    }
    removeTraceObserver()
    try {
      process.chdir(originalCwd)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      finalTestResult = 'fail'
      process.exitCode = 1
      traceEvent('test/fail', {
        phaseCode: 'LIVE_TEST_FAILED',
        stageCode: 'CLEANUP',
        errorCode: 'unavailable',
        errorSource: 'cleanup',
      })
    }
    const settlementFailure = settleDevinLiveResult({
      currentResult: finalTestResult,
      exitCode: process.exitCode,
      budgetViolation: toolBudget.violation,
      turnFailureCount: failures.length,
    })
    if (settlementFailure !== undefined) {
      finalTestResult = 'fail'
      process.exitCode = 1
      traceEvent('test/fail', {
        phaseCode: 'LIVE_TEST_FAILED',
        stageCode: 'CLEANUP',
        errorCode: settlementFailure,
        errorSource: 'cleanup',
      })
    }
    if (finalTestResult === 'pass') {
      traceEvent('test/assertions-passed', { testResult: 'pass', diagnosticComplete: true })
    } else {
      traceEvent('test/fail', { testResult: 'fail', phaseCode: 'LIVE_TEST_FAILED', stageCode: 'CLEANUP' })
    }
    trace.finish(finalTestResult, {
      diagnosticComplete:
        traceObserverFailures === 0 && !trace.writeFailed && !traceWriteFailure && !trace.diagnosticIncomplete,
      failureCount: failures.length,
      writeFailureCount: traceObserverFailures + Number(trace.writeFailed || traceWriteFailure),
      incompleteReasons: trace.diagnosticIncomplete ? 1 : 0,
      dispatchAttempts: toolBudget.dispatchAttempts,
      allowedDispatches: toolBudget.allowedDispatches,
      deniedDispatches: toolBudget.deniedDispatches,
      observedToolResults,
      queuedMessages: queuedMessageIds.size,
      deliveredMessages: deliveredMessageIds.size,
      receipts: receiptMessageIds.size,
      receiptsMatchingQueued: [...receiptMessageIds].filter((id) => queuedMessageIds.has(id)).length,
      workflowRun: workflowNumber(process.env.DEVIN_LIVE_WORKFLOW_RUN) ?? workflowNumber(process.env.GITHUB_RUN_ID),
      workflowAttempt:
        workflowNumber(process.env.DEVIN_LIVE_WORKFLOW_ATTEMPT) ?? workflowNumber(process.env.GITHUB_RUN_ATTEMPT),
      platform: process.platform,
    })
    if (trace.writeFailed || traceWriteFailure) {
      finalTestResult = 'fail'
      process.exitCode = 1
    }
    if (finalTestResult === 'pass' && process.exitCode !== 1) console.log('LIVE_TEST_PASS')
    else console.error('LIVE_TEST_FAILED')
  }
}
