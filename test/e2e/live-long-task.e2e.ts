import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { LongTaskBudget, LongTaskScene } from './live-long-task-budget.ts'
import {
  admitLongTaskTool,
  createLongTaskBudget,
  LONG_TASK_BUDGET,
  longTaskEffectFingerprint,
  observeLongTaskProviderToolCall,
  recordLongTaskApprovalRequest,
  recordLongTaskToolResult,
} from './live-long-task-budget.ts'
import { createNativeReadObserver, wrapObservedCallback } from './live-long-task-native-read.ts'
import type { NativeReadEvidence, NativeReadSource } from './live-long-task-native-read.ts'
import { classifyExecutionRoute, createNativeExecuteObserver } from './live-long-task-native-execute.ts'
import type { ExecuteRegistration, ExecutionRoute } from './live-long-task-native-execute.ts'
import {
  confirmsRejectedCancellation,
  leadControlClaimMarker,
  type RejectedCancellationExpectation,
  type RejectedCancellationFacts,
} from './live-long-task-rejection-cancel.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTraceSink } from '../../src/contract/live-diagnostic-trace.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'

const SOURCE_COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84'
const UPSTREAM = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
const SOURCE_FILES = [
  'packages/core/agent-loop/src/inbox.ts',
  'packages/core/agent-loop/src/runtime-context.ts',
  'packages/core/agent-loop/src/tool-calls.ts',
  'packages/experimental/agent-team/src/mailbox.ts',
  'packages/experimental/agent-team/src/task-board.ts',
  'packages/experimental/agent-team/src/types.ts',
] as const
const SOURCE_MAX_BYTES = 64 * 1024

const agentProfiles = {
  devin: {
    id: 'devin',
    provider: 'acp-devin',
    command: 'devin',
    args: ['acp'],
    model: 'swe-2-high',
    versionArgs: ['--version'],
  },
  codebuddy: {
    id: 'codebuddy-code',
    provider: 'acp-codebuddy-code',
    command: 'codebuddy',
    args: ['--acp'],
    model: 'minimax-m2.7',
    versionArgs: ['--version'],
    runtime: 'codebuddy',
    catalogId: 'codebuddy-code',
  },
} as const
type ProfileName = keyof typeof agentProfiles
type ScenarioSelection = 'all' | 'teams' | 'controls' | 'stop-only'

function selectedScenarios(): ScenarioSelection {
  const selected = process.env.DSH_E2E_LIVE_LONG_TASK_SCENARIOS ?? 'all'
  if (selected !== 'all' && selected !== 'teams' && selected !== 'controls' && selected !== 'stop-only')
    throw new Error('DSH_E2E_LIVE_LONG_TASK_SCENARIOS must be all, teams, controls, or stop-only')
  return selected
}

type SessionEventRow = SessionEvent & { readonly sessionId: SessionId }
type ToolEvidence = {
  readonly name: string
  readonly session: string
  readonly callId: string
  readonly isError: boolean
  readonly readPath?: string
  readonly readOffset?: number
  readonly readLimit?: number
  readonly readLines?: number
  readonly operationId?: string
}
type RuntimePrompt = (
  this: {
    readonly acpSessionId?: string
    readonly configOptions?: readonly {
      readonly type: string
      readonly id?: string
      readonly category?: string
      readonly currentValue?: string
    }[]
    readonly options: { readonly diagnosticDshSessionId?: string }
  },
  ...args: unknown[]
) => unknown
type NativeRuntimeModule = { AcpSessionRuntime: { prototype: { prompt: RuntimePrompt } } }
type NativeDiagnosticModule = {
  installLiveDiagnosticTrace: (sink: LiveDiagnosticTraceSink) => () => void
  liveDiagnosticTraceFailureCount: () => number
  liveDiagnosticTraceEnabled: () => boolean
  liveDiagnosticId: (kind: string, value: unknown) => string | undefined
}

type PromptTrace = {
  readonly scene: LongTaskScene
  readonly phase: string
  readonly owner: string
  readonly acpSession: string
  readonly signal?: AbortSignal
  promptOrdinal?: number
  leaseId?: string
  stopReason?: string
  signalAbortedAtEnd?: boolean
}

type RejectedCancellationState = {
  readonly expected: RejectedCancellationExpectation
  readonly prompt: PromptTrace
  readonly requestIdRaw: string
  readonly requestEventIndex: number
  readonly destination: string
  turnEndEventIndex?: number
  permissionResponse?: {
    readonly callId: string
    readonly outcome: string
    readonly optionKind: string
    readonly signalAborted: boolean
    readonly responseCount: number
  }
  confirmed: boolean
  consumed: boolean
}

function explicitProfile(): ProfileName {
  const name = process.env.DSH_E2E_LIVE_LONG_TASK_PROFILE
  if (name !== 'devin' && name !== 'codebuddy')
    throw new Error('Set DSH_E2E_LIVE_LONG_TASK_PROFILE to devin or codebuddy')
  return name
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortSignalLike(value: unknown): AbortSignal | undefined {
  if (!isRecord(value) || typeof value.aborted !== 'boolean') return undefined
  return value as unknown as AbortSignal
}

function sourcePathFor(workspace: string, path: string): string {
  return join(workspace, 'public-dsh-source', ...path.split('/'))
}

function exportPinnedSource(workspace: string): {
  files: { path: string; bytes: number; sha256: string }[]
  totalBytes: number
} {
  const resolvedCommit = execFileSync('git', ['-C', UPSTREAM, 'rev-parse', `${SOURCE_COMMIT}^{commit}`], {
    encoding: 'utf8',
  }).trim()
  if (resolvedCommit !== SOURCE_COMMIT) throw new Error('LONG_TASK_SOURCE_COMMIT_MISMATCH')
  const files: { path: string; bytes: number; sha256: string }[] = []
  for (const relative of SOURCE_FILES) {
    const source = execFileSync('git', ['-C', UPSTREAM, 'show', `${SOURCE_COMMIT}:${relative}`], {
      maxBuffer: SOURCE_MAX_BYTES,
    })
    const destination = sourcePathFor(workspace, relative)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, source, { mode: 0o444 })
    chmodSync(destination, 0o444)
    files.push({
      path: relative,
      bytes: source.byteLength,
      sha256: createHash('sha256').update(source).digest('hex'),
    })
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (totalBytes > SOURCE_MAX_BYTES) throw new Error('LONG_TASK_SOURCE_INPUT_BUDGET')
  return { files, totalBytes }
}

function diagnosticSink(secret: Buffer, onEvent: (event: LiveDiagnosticEvent) => void): LiveDiagnosticTraceSink {
  const id = (kind: string, value: unknown): string => {
    const encoded = `${kind}\0${JSON.stringify(value)}`
    return `h:${createHmac('sha256', secret).update(encoded).digest('hex').slice(0, 24)}`
  }
  const fingerprint = (kind: string, value: unknown) => {
    const encoded = JSON.stringify(value)
    const bytes = Buffer.byteLength(encoded ?? '')
    return { hmac: id(kind, value), bytes, complete: true }
  }
  return Object.assign((event: LiveDiagnosticEvent) => onEvent(event), { id, fingerprint })
}

describe.skipIf(process.env.DSH_E2E_LIVE_LONG_TASK !== '1')('opt-in live ACP long-task regression', () => {
  it(
    'runs source reading, Teams, Ask, and cancellation scenarios for one exact Agent/model',
    async () => {
      const profileName = explicitProfile()
      const scenarios = selectedScenarios()
      const profile = agentProfiles[profileName]
      const runId = randomUUID()
      const evidenceDir = join(root, '.local', 'live-long-task', profileName, runId)
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
      chmodSync(evidenceDir, 0o700)
      const tracePath = join(evidenceDir, 'trace.jsonl')
      writePrivate(tracePath, '')
      let host!: AdapterWorld
      let browser: TestBrowser | undefined
      let page: Page | undefined
      let removeTrace: (() => void) | undefined
      let restoreRuntimePrompt: (() => void) | undefined
      const restoreRuntimePermissionHandlers: Array<() => void> = []
      const wrappedPermissionOptions = new WeakSet<object>()
      let removeJobEvents: (() => void) | undefined
      let runtimePromptChecks = 0
      let nativeTraceEvents = 0
      let nativeDiagnosticModule: NativeDiagnosticModule | undefined
      let primaryFailure: unknown
      let nativeReadSources: NativeReadSource[] = []
      const nativeReadEvidence: (NativeReadEvidence & { readonly scene: LongTaskScene })[] = []
      let completedRunRecord: Record<string, unknown> | undefined
      let runFailed = false
      let leadSessionId: SessionId | undefined
      let leadAgent: ReturnType<AdapterWorld['ctx']['agents']['get']> | undefined
      let activeScene: LongTaskScene = 'A'
      let sceneStartedAt = Date.now()
      let activePhase = 'setup'
      let phaseDeadlineAt = Date.now() + LONG_TASK_BUDGET.phaseMs
      const startedAt = Date.now()
      const budget: LongTaskBudget = createLongTaskBudget(startedAt)
      const scenarioStatuses: Record<'A' | 'B' | 'C' | 'D', 'pending' | 'passed' | 'partial' | 'not-run'> = {
        A: scenarios === 'all' ? 'pending' : 'not-run',
        B: scenarios === 'controls' || scenarios === 'stop-only' ? 'not-run' : 'pending',
        C: scenarios === 'stop-only' ? 'not-run' : 'pending',
        D: 'pending',
      }
      let runtimeReaderId: SessionId | undefined
      const events: SessionEventRow[] = []
      const tools: ToolEvidence[] = []
      const operationAdmissions = new Map<string, number>()
      const eventChangeWaiters = new Set<(failure?: Error) => void>()
      const jobEvidence: {
        readonly event: 'registered' | 'stopping' | 'settled' | 'removed'
        readonly id: string
        readonly owner?: string
        readonly kind: string
        readonly status: string
        readonly startedAt: number
        readonly finishedAt?: number
        readonly cause?: string
        readonly awaited?: boolean
        readonly label: string
      }[] = []
      let registeredLongCommand: string | undefined
      let dJobQuiescence: 'host-job-settlement' | 'unknown' = 'unknown'
      let dExecutionRoute: ExecutionRoute = 'unknown'
      const dJobSettled = (): boolean => dJobQuiescence === 'host-job-settlement'
      const dUsesHostTool = (): boolean => dExecutionRoute === 'host-tool'
      const pendingScreenshotPromises = new Set<Promise<void>>()
      const screenshotFailures: string[] = []
      const approvals: { scene: LongTaskScene; session: string; outcome: string }[] = []
      const approvalEvidence: {
        operation: string
        session: string
        request: string
        requestEventIndex: number
        toolName: string
        outcome: string
        permissionRoute?: 'host-approval' | 'native-permission' | 'both' | 'team-coordination'
      }[] = []
      const operationPermissionRoutes = new Map<
        string,
        'host-approval' | 'native-permission' | 'both' | 'team-coordination'
      >()
      const operationExecutionRoutes = new Map<string, ExecutionRoute>()
      const teamMessages: {
        scene: LongTaskScene
        session: string
        type: string
        eventIndex: number
        messageId?: string
        targetId?: string
        senderId?: string
        reportMarker?: string
      }[] = []
      const teamReceipts: {
        scene: LongTaskScene
        session: string
        messageId: string
        senderId?: string
        eventIndex: number
      }[] = []
      const memberSessionIds = new Set<string>()
      const teamMemberFacts: { id: string; name: string; role: string }[] = []
      const turns: { scene: LongTaskScene; session: string; turn?: number; reason: string }[] = []
      const claimedTurnByMarker = new Map<string, number>()
      const answers: { scene: LongTaskScene; session: string; text: string }[] = []
      const errorTexts: string[] = []
      let stickyViolation: string | undefined
      let expectingDStop = false
      let expectedDAbortTurn: number | undefined
      let cancelPromise: Promise<void> | undefined
      const modeBySession = new Map<string, string | null>()

      const cancelAll = (reason: string): Promise<void> => {
        stickyViolation ??= reason
        budget.violation ??= reason
        if (cancelPromise !== undefined) return cancelPromise
        cancelPromise = Promise.allSettled(
          host.ctx.agents
            .list()
            .filter((agent) => agent.options.provider === profile.provider)
            .map((agent) => agent.cancel({ kind: 'hook', reason }, { keepInbox: true })),
        ).then(() => undefined)
        return cancelPromise
      }

      const violate = (reason: string): void => {
        if (stickyViolation !== undefined) return
        stickyViolation = reason
        for (const waiter of [...eventChangeWaiters]) waiter(new Error(reason))
        queueMicrotask(() => void cancelAll(reason))
      }

      const assertHealthy = (): void => {
        if (screenshotFailures.length > 0) {
          violate('LONG_TASK_SCREENSHOT_FAILURE')
          throw new Error('LONG_TASK_SCREENSHOT_FAILURE')
        }
        if (errorTexts.length > 0) {
          violate('LONG_TASK_PAGE_ERROR')
          throw new Error('LONG_TASK_PAGE_ERROR')
        }
        if ((nativeDiagnosticModule?.liveDiagnosticTraceFailureCount() ?? 0) > 0) {
          violate('LONG_TASK_DIAGNOSTIC_TRACE_FAILURE')
          throw new Error('LONG_TASK_DIAGNOSTIC_TRACE_FAILURE')
        }
        if (stickyViolation !== undefined) throw new Error(stickyViolation)
        if (Date.now() - startedAt >= LONG_TASK_BUDGET.totalMs) {
          violate('LONG_TASK_TOTAL_DEADLINE')
          throw new Error('LONG_TASK_TOTAL_DEADLINE')
        }
        if (Date.now() - sceneStartedAt >= LONG_TASK_BUDGET.sceneMs) {
          violate(`LONG_TASK_SCENE_DEADLINE_${activeScene}`)
          throw new Error(`LONG_TASK_SCENE_DEADLINE_${activeScene}`)
        }
        if (Date.now() >= phaseDeadlineAt) {
          violate(`LONG_TASK_PHASE_DEADLINE_${activePhase}`)
          throw new Error(`LONG_TASK_PHASE_DEADLINE_${activePhase}`)
        }
      }

      const waitForEventChange = (): Promise<void> =>
        new Promise((resolve, reject) => {
          assertHealthy()
          let timer: ReturnType<typeof setTimeout> | undefined
          const waiter = (failure?: Error): void => {
            eventChangeWaiters.delete(waiter)
            if (timer !== undefined) clearTimeout(timer)
            if (failure === undefined) resolve()
            else reject(failure)
          }
          eventChangeWaiters.add(waiter)
          timer = setTimeout(
            () => {
              eventChangeWaiters.delete(waiter)
              try {
                assertHealthy()
                reject(new Error('LONG_TASK_EVENT_WAIT_TIMEOUT'))
              } catch (error: unknown) {
                reject(error)
              }
            },
            Math.max(1, phaseDeadlineAt - Date.now()),
          )
        })

      const withPhase = async <T>(
        phase: string,
        action: () => Promise<T>,
        phaseTimeoutMs: number = LONG_TASK_BUDGET.phaseMs,
      ): Promise<T> => {
        activePhase = phase
        phaseDeadlineAt = Math.min(
          Date.now() + phaseTimeoutMs,
          sceneStartedAt + LONG_TASK_BUDGET.sceneMs,
          startedAt + LONG_TASK_BUDGET.totalMs,
        )
        assertHealthy()
        let timer: ReturnType<typeof setTimeout> | undefined
        const work = action()
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  violate(`LONG_TASK_PHASE_DEADLINE_${phase}`)
                  reject(new Error(`LONG_TASK_PHASE_DEADLINE_${phase}`))
                },
                Math.max(0, phaseDeadlineAt - Date.now()),
              )
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }

      const capture = async (
        scene: LongTaskScene,
        stage: string,
        facts: Record<string, unknown> = {},
      ): Promise<void> => {
        if (page === undefined) return
        await page.screenshot({ path: join(evidenceDir, `${scene}-${stage}.png`), fullPage: true })
        writePrivate(
          join(evidenceDir, `${scene}-${stage}.json`),
          JSON.stringify(
            {
              runId,
              agent: profileName,
              model: profile.model,
              scene,
              stage,
              elapsedMs: Date.now() - startedAt,
              hostDispatches: budget.totalDispatches,
              sceneDispatches: budget.sceneDispatches[scene],
              approvalRequests: budget.approvalRequests,
              providerToolCalls: budget.providerToolCallIds.size,
              jobs: jobSnapshot(),
              ...facts,
            },
            null,
            2,
          ),
        )
      }

      const scheduleCapture = (scene: LongTaskScene, stage: string, facts: Record<string, unknown>): void => {
        let task!: Promise<void>
        task = capture(scene, stage, facts)
          .catch((error: unknown) => {
            screenshotFailures.push(error instanceof Error ? error.name : 'UnknownError')
          })
          .finally(() => pendingScreenshotPromises.delete(task))
        pendingScreenshotPromises.add(task)
      }

      const checkModelSnapshot = async (sessionId: string, source: string): Promise<void> => {
        const service = host.ctx.get('dshAcp') as AcpRemoteService
        const snapshot = await service.agentSessionSnapshot(sessionId)
        const option = snapshot.configOptions?.find(
          (candidate) => candidate.type === 'select' && (candidate.category === 'model' || candidate.id === 'model'),
        )
        if (snapshot.freshness !== 'live' || option?.type !== 'select') {
          throw new Error(`LONG_TASK_MODEL_SNAPSHOT_UNAVAILABLE:${source}:${snapshot.freshness}`)
        }
        if (option.currentValue !== profile.model) {
          throw new Error(`LONG_TASK_MODEL_SNAPSHOT_MISMATCH:${source}`)
        }
        const hasPreviousMode = modeBySession.has(sessionId)
        const modePreserved = hasPreviousMode && modeBySession.get(sessionId) === snapshot.currentModeId
        modeBySession.set(sessionId, snapshot.currentModeId)
        modelSnapshots.push({
          source,
          session: safeId(sessionId),
          freshness: snapshot.freshness,
          model: option.currentValue,
          modeObserved: snapshot.currentModeId !== null,
          ...(hasPreviousMode ? { modePreserved } : {}),
        })
      }
      const modelSnapshots: {
        source: string
        session: string
        freshness: string
        model: string
        modeObserved: boolean
        modePreserved?: boolean
      }[] = []

      const addEvent = (sessionId: SessionId, event: SessionEvent): void => {
        events.push({ sessionId, ...event })
        for (const waiter of [...eventChangeWaiters]) waiter()
        const scope = String(sessionId)
        const scene = activeScene
        if (
          event.type === 'user/message' &&
          scene === 'B' &&
          leadSessionId === undefined &&
          JSON.stringify(event.data.content).includes(`LONGTASK_B_${runId.slice(0, 8)}`)
        ) {
          leadSessionId = sessionId
          leadAgent = host.ctx.agents.get(sessionId)
        }
        if (event.type === 'turn/end') {
          turns.push({
            scene,
            session: safeId(scope),
            ...('turn' in event.data && typeof event.data.turn === 'number' ? { turn: event.data.turn } : {}),
            reason: event.data.reason.kind,
          })
          let acceptedRejectedCancellation = false
          const cancelState = rejectionCancellation
          if (
            event.data.reason.kind === 'aborted' &&
            cancelState !== undefined &&
            !cancelState.consumed &&
            'turn' in event.data
          ) {
            const nativeCalls = nativeExecuteObserver
              .evidence()
              .filter((entry) => entry.scene === 'C' && entry.operation === cancelState.expected.operation)
            const permission = cancelState.permissionResponse
            const decisionRow = events.find(
              (candidate, index) =>
                index > cancelState.requestEventIndex &&
                candidate.type === 'approval/decided' &&
                candidate.sessionId === sessionId &&
                candidate.data.id === cancelState.requestIdRaw,
            )
            const facts: RejectedCancellationFacts = {
              profile: profileName,
              scene,
              phase: activePhase,
              operation: cancelState.expected.operation,
              owner: nativeDiagnosticModule?.liveDiagnosticId('dsh-session', String(sessionId)) ?? 'unavailable',
              acpSession: cancelState.prompt.acpSession,
              requestId: safeId(`approval-request:${cancelState.requestIdRaw}`),
              decidedOutcome: decisionRow?.type === 'approval/decided' ? decisionRow.data.outcome : '',
              promptOrdinal: cancelState.prompt.promptOrdinal ?? -1,
              leaseId: cancelState.prompt.leaseId ?? '',
              stopReason: cancelState.prompt.stopReason ?? 'unknown',
              promptSignalAbortedAtEnd: cancelState.prompt.signalAbortedAtEnd ?? true,
              permissionCallId: permission?.callId ?? '',
              permissionOutcome: permission?.outcome ?? 'unknown',
              permissionOptionKind: permission?.optionKind ?? 'unknown',
              permissionResponses: permission?.responseCount ?? 0,
              permissionSignalAbortedAtReturn: permission?.signalAborted ?? true,
              nativeCalls: nativeCalls.map((entry) => ({ callId: entry.callId, status: entry.status })),
              turn: event.data.turn,
              turnReason: event.data.reason.kind,
              hostAdmissions: operationAdmissions.get(cancelState.expected.operation) ?? 0,
              hostResults: tools.filter((tool) => tool.operationId === cancelState.expected.operation).length,
              fileExists: existsSync(cancelState.destination),
              localStop: expectingDStop,
              guardCancelled:
                stickyViolation !== undefined || budget.violation !== undefined || cancelPromise !== undefined,
            }
            acceptedRejectedCancellation = confirmsRejectedCancellation(cancelState.expected, facts)
            if (acceptedRejectedCancellation) {
              cancelState.confirmed = true
              cancelState.consumed = true
              cancelState.turnEndEventIndex = events.length - 1
              rejectionCancellationEvidence.push({
                status: 'confirmed-remote-rejected-cancellation',
                operation: cancelState.expected.operation,
                owner: cancelState.expected.owner,
                acpSession: cancelState.expected.acpSession,
                request: cancelState.expected.requestId,
                promptOrdinal: cancelState.expected.promptOrdinal,
                leaseId: cancelState.expected.leaseId,
                nativeCall: cancelState.expected.callId,
                nativeStatus: nativeCalls[0]?.status ?? 'unknown',
                turn: event.data.turn,
                turnEndEventIndex: events.length - 1,
              })
            }
          }
          if (
            event.data.reason.kind !== 'completed' &&
            !acceptedRejectedCancellation &&
            !(
              scene === 'D' &&
              expectingDStop &&
              String(sessionId) === String(leadSessionId) &&
              event.data.reason.kind === 'aborted' &&
              'turn' in event.data &&
              event.data.turn === expectedDAbortTurn
            )
          )
            violate(`LONG_TASK_UNEXPECTED_TURN_END_${event.data.reason.kind}`)
        }
        if (event.type.startsWith('error/')) violate('LONG_TASK_SESSION_ERROR_EVENT')
        if (event.type === 'assistant/message') {
          const text = event.data.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
          if (text.length > 0) answers.push({ scene, session: safeId(scope), text })
        }
        if (event.type === 'approval/asked') {
          const violation = recordLongTaskApprovalRequest(budget, scene)
          if (violation !== undefined) violate(violation)
        }
        if (event.type === 'approval/decided') {
          approvals.push({ scene, session: safeId(scope), outcome: event.data.outcome })
        }
        if (event.type === 'team/message/queued')
          teamMessages.push({
            scene,
            session: safeId(scope),
            type: event.type,
            eventIndex: events.length - 1,
            messageId: String(event.data.message.id),
            targetId: String(event.data.message.targetId),
            senderId: String(event.data.message.senderId),
            reportMarker: ['B_REPORT_RUNTIME', 'B_REPORT_TEAMS'].find((marker) =>
              event.data.message.content.some(
                (block) => block.type === 'text' && block.text.includes(`${marker}_${runId.slice(0, 8)}`),
              ),
            ),
          })
        if (event.type === 'team/message/delivered')
          teamMessages.push({
            scene,
            session: safeId(scope),
            type: event.type,
            eventIndex: events.length - 1,
            messageId: String(event.data.messageId),
            targetId: String(event.data.targetId),
          })
        if (event.type === 'user/message') {
          const data = event.data as unknown as { source?: { kind?: string; messageId?: string; senderId?: string } }
          if (data.source?.kind === 'team-message' && typeof data.source.messageId === 'string')
            teamReceipts.push({
              scene,
              session: safeId(scope),
              messageId: data.source.messageId,
              senderId: data.source.senderId,
              eventIndex: events.length - 1,
            })
        }
      }

      const safeId = (value: string): string => createHmac('sha256', runSecret).update(value).digest('hex').slice(0, 24)
      const runSecret = randomBytes(32)
      const safeJobView = (job: {
        readonly id: string
        readonly owner?: string
        readonly kind: string
        readonly status: string
        readonly startedAt: number
        readonly finishedAt?: number
      }) => ({
        id: safeId(`job:${job.id}`),
        ...(job.owner === undefined ? {} : { owner: safeId(`dsh-session:${job.owner}`) }),
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      })
      const jobSnapshot = () => {
        if (leadSessionId === undefined)
          return { visibleJobs: [], exactCommandJobCount: 0, exactCommandActiveCount: 0, otherLiveJobCount: 0 }
        const visibleJobs = host.ctx.jobs.list(leadSessionId)
        const exactCommandJobs =
          registeredLongCommand === undefined ? [] : visibleJobs.filter((job) => job.label === registeredLongCommand)
        const exactCommandIds = new Set(exactCommandJobs.map((job) => String(job.id)))
        return {
          visibleJobs: visibleJobs.map(safeJobView),
          exactCommandJobCount: exactCommandJobs.length,
          exactCommandActiveCount: exactCommandJobs.filter(
            (job) => job.status === 'running' || job.status === 'stopping',
          ).length,
          otherLiveJobCount: visibleJobs.filter(
            (job) => !exactCommandIds.has(String(job.id)) && (job.status === 'running' || job.status === 'stopping'),
          ).length,
          unownedJobCount: visibleJobs.filter((job) => job.owner === undefined).length,
        }
      }
      const nativeExecuteRegistrations: ExecuteRegistration[] = []
      const nativeExecuteObserver = createNativeExecuteObserver({
        registrations: () => nativeExecuteRegistrations,
        hashIdentifier: (kind, value) => safeId(`${kind}:${value}`),
        onViolation: violate,
      })
      const registerNativeExecute = (registration: ExecuteRegistration): void => {
        nativeExecuteRegistrations.push(registration)
      }
      const modelRouteObservations: { provider: string; model: string; session: string }[] = []
      const runtimePromptObservations: { model: string; session: string }[] = []
      const promptTraces: PromptTrace[] = []
      const pendingPromptInvocations = new Map<string, PromptTrace[]>()
      let rejectionCancellation: RejectedCancellationState | undefined
      const rejectionCancellationEvidence: {
        readonly status: 'confirmed-remote-rejected-cancellation'
        readonly operation: string
        readonly owner: string
        readonly acpSession: string
        readonly request: string
        readonly promptOrdinal: number
        readonly leaseId: string
        readonly nativeCall: string
        readonly nativeStatus: string
        readonly turn: number
        readonly turnEndEventIndex: number
      }[] = []

      const postPrompt = async (
        text: string,
        marker: string,
        expectedSession?: SessionId,
      ): Promise<{ sessionId: SessionId; userIndex: number }> => {
        assertHealthy()
        const input = required(page).locator('[data-composer-input]').first()
        await writeComposerDraft(required(page), input, `${text} Reference marker: ${marker}`)
        const before = events.length
        await required(page).getByRole('button', { name: 'Send message', exact: true }).click()
        let userIndex = -1
        let sessionId: SessionId | undefined
        await vi.waitFor(
          () => {
            const candidate = events.findIndex(
              (event, index) =>
                index >= before && event.type === 'user/message' && JSON.stringify(event.data.content).includes(marker),
            )
            expect(candidate).toBeGreaterThanOrEqual(0)
            userIndex = candidate
            sessionId = events[candidate]?.sessionId
            expect(sessionId).toBeDefined()
          },
          { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 100 },
        )
        const id = required(sessionId)
        if (expectedSession !== undefined) expect(id).toBe(expectedSession)
        if (leadSessionId === undefined) leadSessionId = id
        if (leadSessionId === id) leadAgent = host.ctx.agents.get(id)
        return { sessionId: id, userIndex }
      }

      const waitForTurn = async (sessionId: SessionId, userIndex: number): Promise<void> => {
        await vi.waitFor(
          () => {
            assertHealthy()
            const ending = events.find(
              (event, index) => index > userIndex && event.sessionId === sessionId && event.type === 'turn/end',
            )
            expect(ending, 'Expected the prompt to end on its own session').toBeDefined()
            if (ending?.type === 'turn/end') expect(ending.data.reason.kind).toBe('completed')
            expect(
              events.some(
                (event, index) =>
                  index > userIndex && event.sessionId === sessionId && event.type === 'assistant/message',
              ),
            ).toBe(true)
          },
          { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
        )
        await checkModelSnapshot(String(sessionId), 'after-turn')
      }

      const sendPrompt = async (text: string, marker: string, expectedSession?: SessionId): Promise<SessionId> => {
        const posted = await postPrompt(text, marker, expectedSession)
        await waitForTurn(posted.sessionId, posted.userIndex)
        const userPrompt = required(page)
          .locator(`[data-conversation-session="${posted.sessionId}"] [data-chat-flow-kind="user"]`)
          .filter({ hasText: marker })
        await userPrompt.first().waitFor({
          state: 'visible',
          timeout: Math.max(1, Math.min(10_000, phaseDeadlineAt - Date.now())),
        })
        expect(await userPrompt.count()).toBe(1)
        return posted.sessionId
      }

      const requireRead = (sessionId: string, paths: readonly string[], fromToolIndex: number): void => {
        const observed = tools.slice(fromToolIndex)
        for (const path of paths)
          expect(
            observed.some(
              (tool) =>
                tool.session === safeId(sessionId) &&
                tool.name === 'read' &&
                tool.readPath === path &&
                (tool.readLines ?? 0) > 0 &&
                !tool.isError,
            ),
            `Expected this turn to successfully use DSH read for ${path}`,
          ).toBe(true)
      }

      const requireReadFromHostOrNative = (
        sessionId: string,
        paths: readonly string[],
        fromToolIndex: number,
      ): void => {
        const hostReads = tools.slice(fromToolIndex)
        for (const path of paths) {
          const source = nativeReadSources.find((candidate) => candidate.absolutePath === path)
          expect(source, `Expected a fixed public source mapping for ${path}`).toBeDefined()
          const hostVerified = hostReads.some(
            (tool) =>
              tool.session === safeId(sessionId) &&
              tool.name === 'read' &&
              tool.readPath === path &&
              (tool.readLines ?? 0) > 0 &&
              !tool.isError,
          )
          const nativeVerified = nativeReadEvidence.some(
            (read) =>
              read.scene === 'B' &&
              read.session === safeId(`dsh-session:${sessionId}`) &&
              read.path === source?.relativePath,
          )
          expect(
            hostVerified || nativeVerified,
            `Expected a successful Host or source-verified native read for ${path}`,
          ).toBe(true)
        }
      }

      const resetScene = (scene: LongTaskScene): void => {
        activeScene = scene
        sceneStartedAt = Date.now()
        phaseDeadlineAt = Math.min(sceneStartedAt + LONG_TASK_BUDGET.phaseMs, startedAt + LONG_TASK_BUDGET.totalMs)
        activePhase = `${scene}:start`
      }

      try {
        host = await launchAdapterWorld({ teams: true, teamMembers: 3 })
        removeJobEvents = host.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
          if (event.type === 'progress' || event.type === 'output') return
          if (jobEvidence.length >= 512) {
            violate('LONG_TASK_JOB_EVIDENCE_LIMIT')
            return
          }
          const job = event.job
          jobEvidence.push({
            event: event.type,
            id: safeId(`job:${String(job.id)}`),
            ...(job.owner === undefined ? {} : { owner: safeId(`dsh-session:${String(job.owner)}`) }),
            kind: job.kind,
            status: job.status,
            startedAt: job.startedAt,
            ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
            ...(event.type === 'settled' ? { cause: event.cause, awaited: event.awaited } : {}),
            label: job.label,
          })
        })
        const nativeLoader = host.ctx.loader as unknown as {
          internal?: unknown
          import(specifier: string): Promise<unknown>
        }
        if (nativeLoader.internal === undefined) throw new Error('LONG_TASK_NATIVE_LOADER_UNAVAILABLE')
        const runtimeModule = (await nativeLoader.import(
          pathToFileURL(resolve(root, 'lib/runtime/session/session-runtime.js')).href,
        )) as NativeRuntimeModule
        nativeDiagnosticModule = (await nativeLoader.import(
          pathToFileURL(resolve(root, 'lib/contract/live-diagnostic-trace.js')).href,
        )) as NativeDiagnosticModule
        if (
          typeof (nativeDiagnosticModule as { liveDiagnosticTraceEnabled?: unknown }).liveDiagnosticTraceEnabled !==
          'function'
        )
          throw new Error('LONG_TASK_NATIVE_DIAGNOSTIC_ENABLEMENT_CHECK_UNAVAILABLE')
        const runtimePrototype = (
          runtimeModule.AcpSessionRuntime as unknown as { prototype: { prompt: RuntimePrompt } }
        ).prototype
        const originalRuntimePrompt = runtimePrototype.prompt
        runtimePrototype.prompt = function (
          this: ThisParameterType<RuntimePrompt>,
          ...args: Parameters<RuntimePrompt>
        ) {
          runtimePromptChecks += 1
          const options = this.configOptions
          assertHealthy()
          const modelOption = options?.find(
            (option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'),
          )
          if (modelOption?.type !== 'select' || modelOption.currentValue !== profile.model) {
            violate('LONG_TASK_RUNTIME_MODEL_SNAPSHOT_MISMATCH')
            throw new Error('LONG_TASK_RUNTIME_MODEL_SNAPSHOT_MISMATCH')
          }
          const runtimeState = this as unknown as {
            readonly acpSessionId?: string
            readonly options: {
              readonly diagnosticDshSessionId?: string
              onPermissionRequest?: (this: unknown, ...callbackArgs: unknown[]) => Promise<unknown>
            }
          }
          const runtimeDshSessionId = runtimeState.options.diagnosticDshSessionId
          if (typeof runtimeDshSessionId === 'string')
            runtimePromptObservations.push({ model: modelOption.currentValue, session: safeId(runtimeDshSessionId) })
          const originalPermissionRequest = runtimeState.options.onPermissionRequest
          if (typeof originalPermissionRequest === 'function' && !wrappedPermissionOptions.has(runtimeState.options)) {
            const wrappedPermissionRequest = function (this: unknown, ...callbackArgs: unknown[]): Promise<unknown> {
              const params = callbackArgs[0]
              try {
                nativeExecuteObserver.observePermission(params, {
                  scene: activeScene,
                  ownerDshSessionId: runtimeDshSessionId,
                  activeAcpSessionId: runtimeState.acpSessionId,
                })
              } catch {
                violate('LONG_TASK_NATIVE_EXECUTE_OBSERVER_FAILURE')
              }
              const result = originalPermissionRequest.apply(this, callbackArgs)
              return result.then((response: unknown) => {
                try {
                  const state = rejectionCancellation
                  if (
                    state !== undefined &&
                    state.expected.scene === activeScene &&
                    state.expected.phase === activePhase &&
                    state.prompt.promptOrdinal === state.expected.promptOrdinal &&
                    state.prompt.leaseId === state.expected.leaseId &&
                    state.prompt.stopReason === undefined &&
                    state.expected.owner ===
                      nativeDiagnosticModule?.liveDiagnosticId('dsh-session', runtimeDshSessionId) &&
                    state.expected.acpSession ===
                      nativeDiagnosticModule?.liveDiagnosticId('acp-session', runtimeState.acpSessionId) &&
                    isRecord(params) &&
                    params.sessionId === runtimeState.acpSessionId &&
                    isRecord(params.toolCall) &&
                    typeof params.toolCall.toolCallId === 'string' &&
                    safeId(`acp-tool-call:${params.toolCall.toolCallId}`) === state.expected.callId
                  ) {
                    const signal = callbackArgs[1]
                    const signalAborted = !isRecord(signal) || signal.aborted !== false
                    const options = Array.isArray(params.options) ? params.options : []
                    const selected = isRecord(response) && isRecord(response.outcome) ? response.outcome : undefined
                    const selectedOptionId = selected?.optionId
                    const selectedOption =
                      typeof selectedOptionId === 'string'
                        ? options.find((option) => isRecord(option) && option.optionId === selectedOptionId)
                        : undefined
                    state.permissionResponse = {
                      callId: state.expected.callId,
                      outcome: typeof selected?.outcome === 'string' ? selected.outcome : 'unknown',
                      optionKind:
                        isRecord(selectedOption) && typeof selectedOption.kind === 'string'
                          ? selectedOption.kind
                          : 'unknown',
                      signalAborted,
                      responseCount: (state.permissionResponse?.responseCount ?? 0) + 1,
                    }
                  }
                } catch {
                  violate('LONG_TASK_NATIVE_EXECUTE_OBSERVER_FAILURE')
                }
                return response
              })
            }
            runtimeState.options.onPermissionRequest = wrappedPermissionRequest
            wrappedPermissionOptions.add(runtimeState.options)
            restoreRuntimePermissionHandlers.push(() => {
              if (runtimeState.options.onPermissionRequest === wrappedPermissionRequest)
                runtimeState.options.onPermissionRequest = originalPermissionRequest
            })
          }
          const originalOnUpdate = args[1]
          if (typeof originalOnUpdate !== 'function') {
            violate('LONG_TASK_NATIVE_READ_UPDATE_CALLBACK_UNAVAILABLE')
            return originalRuntimePrompt.apply(this, args)
          }
          let observeNativeRead: ((notification: unknown) => NativeReadEvidence[]) | undefined
          const wrappedOnUpdate = wrapObservedCallback(
            originalOnUpdate as (this: unknown, ...callbackArgs: unknown[]) => unknown,
            (notification) => {
              const activeAcpSessionId = runtimeState.acpSessionId
              nativeExecuteObserver.observeUpdate(notification, {
                scene: activeScene,
                ownerDshSessionId: runtimeDshSessionId,
              })
              if (
                activeAcpSessionId !== undefined &&
                typeof notification === 'object' &&
                notification !== null &&
                'sessionId' in notification &&
                notification.sessionId === activeAcpSessionId
              ) {
                observeNativeRead ??= createNativeReadObserver({
                  activeSessionId: activeAcpSessionId,
                  ...(typeof runtimeDshSessionId === 'string' ? { sessionEvidenceId: runtimeDshSessionId } : {}),
                  sources: nativeReadSources,
                  hashIdentifier: (kind, value) => safeId(`${kind}:${value}`),
                })
                nativeReadEvidence.push(
                  ...observeNativeRead(notification).map((read) => ({ ...read, scene: activeScene })),
                )
              }
            },
            () => violate('LONG_TASK_NATIVE_READ_OBSERVER_FAILURE'),
          )
          const wrappedArgs = [...args]
          wrappedArgs[1] = wrappedOnUpdate
          const promptTrace: PromptTrace = {
            scene: activeScene,
            phase: activePhase,
            owner: nativeDiagnosticModule?.liveDiagnosticId('dsh-session', runtimeDshSessionId) ?? 'unavailable',
            acpSession:
              nativeDiagnosticModule?.liveDiagnosticId('acp-session', runtimeState.acpSessionId) ?? 'unavailable',
            ...(abortSignalLike(args[2]) === undefined ? {} : { signal: abortSignalLike(args[2]) }),
          }
          const promptKey = JSON.stringify([promptTrace.owner, promptTrace.acpSession])
          const pendingPrompts = pendingPromptInvocations.get(promptKey) ?? []
          pendingPrompts.push(promptTrace)
          pendingPromptInvocations.set(promptKey, pendingPrompts)
          const removePendingPrompt = (): void => {
            const current = pendingPromptInvocations.get(promptKey)
            if (current === undefined) return
            const index = current.indexOf(promptTrace)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) pendingPromptInvocations.delete(promptKey)
          }
          try {
            const result = originalRuntimePrompt.apply(this, wrappedArgs)
            if (isRecord(result) && typeof result.then === 'function')
              return Promise.resolve(result).finally(removePendingPrompt)
            removePendingPrompt()
            return result
          } catch (error: unknown) {
            removePendingPrompt()
            throw error
          }
        }
        restoreRuntimePrompt = () => {
          runtimePrototype.prompt = originalRuntimePrompt
        }
        const cliVersionOutput = execFileSync(profile.command, profile.versionArgs, {
          encoding: 'utf8',
          timeout: 10_000,
        }).trim()
        const cliVersion = cliVersionOutput.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/u)?.[0]
        if (cliVersion === undefined) throw new Error('LONG_TASK_CLI_VERSION_UNAVAILABLE')
        const configuredEnvKeys = (process.env[`DSH_E2E_LIVE_LONG_TASK_${profileName.toUpperCase()}_ENV_KEYS`] ?? '')
          .split(',')
          .filter(Boolean)
        const env = Object.fromEntries(
          configuredEnvKeys.map((key) => {
            if (process.env[key] === undefined)
              throw new Error(`Missing explicitly listed environment variable: ${key}`)
            return [key, process.env[key]]
          }),
        )
        const agentConfig = {
          name: profileName,
          command: profile.command,
          args: [...profile.args],
          env,
          ...('runtime' in profile ? { runtime: profile.runtime } : {}),
          ...('catalogId' in profile ? { catalogId: profile.catalogId } : {}),
        }
        await host.ctx.settings.replace('dsh-acp-adapter', {
          toolApprovalDefault: 'auto',
          agents: { [profile.id]: agentConfig },
        })
        await vi.waitFor(() =>
          expect(host.ctx.llm.listProviders().some((entry) => entry.id === profile.provider)).toBe(true),
        )
        const models = await host.ctx.llm.listModels(profile.provider)
        expect(
          models.some((entry) => entry.id === profile.model),
          `Exact candidate ${profile.model} is absent from live catalog`,
        ).toBe(true)
        await host.ctx.agentDefaultModel.saveSelection({ provider: profile.provider, model: profile.model })

        const allowedTeamTools = new Set(['spawn_teammate', 'wait_agent', 'list_agents'])
        const sourcePaths = new Set(
          SOURCE_FILES.map((path) => sourcePathFor(join(host.workspaceCwd, 'workspace'), path)),
        )
        const operationCommands = new Map<string, string>()
        const operationOwners = new Map<string, string>()
        const dLongCallIds = new Set<string>()
        let taskCreateAttempts = 0
        let dLongAdmissions = 0
        host.ctx.tools.guard((execution) => {
          if (execution.agent?.options.provider !== profile.provider) return undefined
          const scene = activeScene
          const toolName = execution.name
          try {
            assertHealthy()
          } catch {
            const violation = stickyViolation ?? 'LONG_TASK_DEADLINE'
            violate(violation)
            return `LIVE_LONG_TASK_BUDGET:${violation}`
          }
          const actorId = String(execution.agent.id)
          const args = execution.arguments as Record<string, unknown> | undefined
          let allowed = false
          if (scene === 'A') {
            allowed = toolName === 'read' && typeof args?.file_path === 'string' && sourcePaths.has(args.file_path)
          } else if (scene === 'B') {
            const membership = host.ctx.agentTeams.tryMembership(execution.agent)
            const isLead = membership?.role === 'lead' && String(membership.root.id) === String(leadSessionId)
            const isExpectedMember =
              membership?.role === 'teammate' &&
              String(membership.root.id) === String(leadSessionId) &&
              ['runtime-reader', 'teams-reader'].includes(membership.name)
            if (toolName === 'team_task_create') {
              if (!isLead) {
                violate('LONG_TASK_TEAM_ROLE_VIOLATION')
                return 'LIVE_LONG_TASK_SCOPE_TEAM_ROLE'
              }
              taskCreateAttempts += 1
              if (taskCreateAttempts > 2) {
                violate('LONG_TASK_TASK_CREATE_BUDGET')
                return 'LIVE_LONG_TASK_SCOPE_TASK_CREATE_BUDGET'
              }
            }
            const teamTaskAllowed =
              toolName.startsWith('team_task_') &&
              (isLead || (isExpectedMember && ['team_task_get', 'team_task_update'].includes(toolName)))
            const target = typeof args?.target === 'string' ? args.target : ''
            const teamMessageAllowed =
              toolName === 'send_message' &&
              ((isExpectedMember && target === 'lead') ||
                (isLead && ['runtime-reader', 'teams-reader'].includes(target)))
            allowed =
              (toolName === 'read' && typeof args?.file_path === 'string' && sourcePaths.has(args.file_path)) ||
              (allowedTeamTools.has(toolName) &&
                (toolName !== 'spawn_teammate' || isLead) &&
                (toolName !== 'wait_agent' || isLead) &&
                (toolName !== 'list_agents' || isLead || isExpectedMember)) ||
              teamTaskAllowed ||
              teamMessageAllowed
          } else if (scene === 'C') {
            const command = typeof args?.command === 'string' ? args.command : ''
            const relay = typeof args?.message === 'string' ? args.message : ''
            const expectedRelay = [...operationCommands.values()].some((command) => relay.includes(command))
            const operationRelay = [...operationCommands.keys()].some((id) => relay.includes(`${id}-${runId}`))
            const operation = [...operationCommands].find(([, expected]) => expected === command)?.[0]
            if (operation !== undefined && (operationAdmissions.get(operation) ?? 0) > 0) {
              violate('LONG_TASK_OPERATION_DUPLICATE_DISPATCH')
              return 'LIVE_LONG_TASK_OPERATION_DUPLICATE_DISPATCH'
            }
            allowed =
              (toolName === 'send_message' &&
                ((actorId === String(leadSessionId) && args?.target === 'runtime-reader' && expectedRelay) ||
                  (memberSessionIds.has(actorId) && args?.target === 'lead' && operationRelay))) ||
              (toolName === 'bash' && operation !== undefined && operationOwners.get(operation) === actorId)
          } else {
            const command = typeof args?.command === 'string' ? args.command : ''
            const timeout = args?.timeoutMs
            const runInBackground = args?.run_in_background
            const foregroundMode = (timeout === undefined || timeout === 120_000) && runInBackground !== true
            allowed = toolName === 'bash' && command === operationCommands.get('D:long-running') && foregroundMode
            if (allowed && dLongAdmissions > 0) {
              violate('LONG_TASK_STOPPED_COMMAND_DUPLICATE_DISPATCH')
              return 'LIVE_LONG_TASK_STOPPED_COMMAND_DUPLICATE_DISPATCH'
            }
          }
          if (!allowed) {
            violate(`LONG_TASK_TOOL_SCOPE_${scene}_${toolName}`)
            return `LIVE_LONG_TASK_SCOPE_DENIED:${scene}:${toolName}`
          }
          const scopedCallId = `${actorId}:${String(execution.callId)}`
          const effectFingerprint = ['bash', 'write', 'edit', 'apply_patch', 'create_file', 'send_message'].includes(
            toolName,
          )
            ? longTaskEffectFingerprint(runSecret.toString('hex'), toolName, { actorId, args })
            : undefined
          const violation = admitLongTaskTool(budget, {
            scene,
            toolName,
            callId: scopedCallId,
            effectFingerprint,
          })
          if (violation !== undefined) {
            violate(violation)
            return `LIVE_LONG_TASK_BUDGET:${violation}`
          }
          if (scene === 'C' && toolName === 'bash') {
            const operation = [...operationCommands].find(([, command]) => command === args?.command)?.[0]
            if (operation !== undefined)
              operationAdmissions.set(operation, (operationAdmissions.get(operation) ?? 0) + 1)
          }
          if (scene === 'D' && toolName === 'bash') {
            dLongAdmissions += 1
            dLongCallIds.add(scopedCallId)
          }
          if (toolName === 'read' && (scene === 'A' || scene === 'B')) {
            const path = typeof args?.file_path === 'string' ? args.file_path : ''
            scheduleCapture(scene, `tool-admitted-${safeId(path).slice(0, 6)}`, {
              toolAdmission: 'accepted',
              readPath: path,
              captureRequestedAt: 'guard-accepted-before-tool-body',
            })
          }
          return undefined
        })
        host.ctx.on('tools/result', (execution, result) => {
          if (execution.agent?.options.provider !== profile.provider) return
          const sessionId = String(execution.agent.id)
          const args = execution.arguments as Record<string, unknown> | undefined
          const readPath = execution.name === 'read' && typeof args?.file_path === 'string' ? args.file_path : undefined
          const readResult = result as unknown as { value?: { lines?: unknown } }
          const readLines = Array.isArray(readResult.value?.lines) ? readResult.value.lines.length : undefined
          const command = typeof args?.command === 'string' ? args.command : ''
          const operation = command.match(
            new RegExp(`(lead-allow|member-allow|lead-reject|member-reject)-${runId}`, 'u'),
          )
          const operationId = command === operationCommands.get('D:long-running') ? 'D:long-running' : operation?.[1]
          const evidence: ToolEvidence = {
            name: execution.name,
            session: safeId(sessionId),
            callId: safeId(String(execution.callId)),
            isError: result.isError,
            ...(readPath === undefined ? {} : { readPath }),
            ...(typeof args?.offset === 'number' ? { readOffset: args.offset } : {}),
            ...(typeof args?.limit === 'number' ? { readLimit: args.limit } : {}),
            ...(readLines === undefined ? {} : { readLines }),
            ...(operationId === undefined ? {} : { operationId }),
          }
          tools.push(evidence)
          recordLongTaskToolResult(budget, `${sessionId}:${String(execution.callId)}`, result.isError)
        })
        host.ctx.on('session/event', (session, event) => addEvent(session.id, event))
        host.ctx.on('agent/inbox/claimed', (value: unknown) => {
          const claim = value as {
            agent?: { id?: string }
            message?: { content?: unknown }
            turn?: number
          }
          if (claim.agent?.id !== String(leadSessionId) || typeof claim.turn !== 'number') return
          const content = JSON.stringify(claim.message?.content ?? '')
          const cMarker = leadControlClaimMarker(content, runId.slice(0, 8))
          if (cMarker !== undefined) claimedTurnByMarker.set(cMarker, claim.turn)
          for (const marker of ['LONGTASK_D_RUNNING_', 'LONGTASK_D_QUEUED_', 'LONGTASK_D_RESUME_']) {
            const match = content.match(new RegExp(`${marker}[a-f0-9]{8}`, 'u'))
            if (match !== null) {
              claimedTurnByMarker.set(match[0], claim.turn)
              if (marker === 'LONGTASK_D_RUNNING_') expectedDAbortTurn = claim.turn
            }
          }
        })
        host.ctx.on('llm/stream', (request: GenerateOptions, next) => {
          if (request.provider !== profile.provider || request.model !== profile.model) {
            violate('LONG_TASK_UNEXPECTED_PROVIDER_OR_MODEL')
            throw new Error('LONG_TASK_UNEXPECTED_PROVIDER_OR_MODEL')
          }
          assertHealthy()
          const sessionId = String(request.sessionId)
          modelRouteObservations.push({ provider: request.provider, model: request.model, session: safeId(sessionId) })
          return next()
        })
        if (nativeDiagnosticModule === undefined) throw new Error('LONG_TASK_NATIVE_DIAGNOSTIC_MODULE_UNAVAILABLE')
        const removeSink = nativeDiagnosticModule.installLiveDiagnosticTrace(
          diagnosticSink(runSecret, (event) => {
            nativeTraceEvents += 1
            if (event.type === 'adapter-prompt/start') {
              const key = JSON.stringify([event.sessionId, event.acpSessionId ?? 'unavailable'])
              const pending = pendingPromptInvocations.get(key) ?? []
              const matchingIndexes = pending
                .map((candidate, index) => ({ candidate, index }))
                .filter(
                  ({ candidate }) =>
                    candidate.scene === activeScene &&
                    candidate.phase === activePhase &&
                    candidate.promptOrdinal === undefined,
                )
              if (matchingIndexes.length > 1) violate('LONG_TASK_PROMPT_TRACE_AMBIGUOUS')
              const invocationIndex = matchingIndexes.length === 1 ? matchingIndexes[0]?.index : undefined
              const invocation = invocationIndex === undefined ? undefined : pending[invocationIndex]
              if (invocation !== undefined && invocationIndex !== undefined) {
                invocation.promptOrdinal = event.promptOrdinal
                invocation.leaseId = event.leaseId
                pending.splice(invocationIndex, 1)
                if (pending.length === 0) pendingPromptInvocations.delete(key)
                promptTraces.push(invocation)
              }
            } else if (event.type === 'adapter-prompt/end') {
              const prompt = promptTraces.find(
                (candidate) =>
                  candidate.owner === event.sessionId &&
                  candidate.acpSession === event.acpSessionId &&
                  candidate.promptOrdinal === event.promptOrdinal &&
                  candidate.leaseId === event.leaseId &&
                  candidate.stopReason === undefined,
              )
              if (prompt !== undefined) {
                prompt.stopReason = event.stopReason ?? 'unknown'
                prompt.signalAbortedAtEnd = prompt.signal?.aborted ?? true
              }
            }
            const safeEvent: Record<string, unknown> = {
              ...event,
              sessionId: safeId(event.sessionId),
              ...(event.acpSessionId === undefined ? {} : { acpSessionId: safeId(event.acpSessionId) }),
              ...('leaseId' in event && event.leaseId !== undefined ? { leaseId: safeId(event.leaseId) } : {}),
              ...('mcpRequestId' in event && event.mcpRequestId !== undefined
                ? { mcpRequestId: safeId(event.mcpRequestId) }
                : {}),
              ...('hostCallId' in event && event.hostCallId !== undefined
                ? { hostCallId: safeId(event.hostCallId) }
                : {}),
              ...('providerModelCallId' in event && event.providerModelCallId !== undefined
                ? { providerModelCallId: safeId(event.providerModelCallId) }
                : {}),
              ...('providerToolCallId' in event && event.providerToolCallId !== undefined
                ? { providerToolCallId: safeId(event.providerToolCallId) }
                : {}),
              ...('messageId' in event && event.messageId !== undefined ? { messageId: safeId(event.messageId) } : {}),
              phase: activePhase,
              elapsedMs: Date.now() - startedAt,
            }
            appendFileSync(tracePath, `${JSON.stringify(safeEvent)}\n`)
            if (event.type === 'acp-tool/update' && event.adapterPromptOrdinal !== undefined) {
              const scopedId = `${event.acpSessionId ?? event.sessionId}:${event.providerToolCallId}`
              if (observeLongTaskProviderToolCall(budget, scopedId) && budget.violation !== undefined)
                violate(budget.violation)
            }
          }),
        )
        removeTrace = removeSink
        if (!nativeDiagnosticModule.liveDiagnosticTraceEnabled())
          throw new Error('LONG_TASK_NATIVE_DIAGNOSTIC_SINK_NOT_ENABLED')

        const evidenceSource = exportPinnedSource(join(host.workspaceCwd, 'workspace'))
        expect(evidenceSource.totalBytes).toBeLessThanOrEqual(SOURCE_MAX_BYTES)
        nativeReadSources = evidenceSource.files.map((file) => ({
          absolutePath: sourcePathFor(join(host.workspaceCwd, 'workspace'), file.path),
          relativePath: file.path,
          content: readFileSync(sourcePathFor(join(host.workspaceCwd, 'workspace'), file.path), 'utf8'),
        }))
        const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
        const browserOptions = {
          headless: process.env.DSH_E2E_RETAIN !== '1',
          ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
        }
        browser = await launchBrowser(browserOptions)
        page = await newEnglishPage(browser)
        page.setDefaultTimeout(10_000)
        page.on('pageerror', (error) => errorTexts.push(error.message))
        await page.goto(host.authenticatedUrl)
        await connectFreshWorkspace(page, host.workspaceCwd)

        writePrivate(
          join(evidenceDir, 'run.json'),
          JSON.stringify(
            {
              status: 'running',
              agent: profileName,
              provider: profile.provider,
              model: profile.model,
              cliVersion,
              dshCommit: SOURCE_COMMIT,
              dshPluginVersion: packageJson.version,
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              source: evidenceSource,
              scenarios: scenarioStatuses,
              startedAt: new Date(startedAt).toISOString(),
            },
            null,
            2,
          ),
        )

        // A: six real turns on one ACP session, each using the DSH filesystem read tool.
        if (scenarios === 'all') {
          resetScene('A')
          await capture('A', 'start', { session: 'pending' })
          const aPrompts = [
            ['inbox.ts', 'Read the exact inbox module. Explain its responsibility and cite paths.'],
            [
              'tool-calls.ts',
              'Read tool-calls.ts. Refine your explanation of how the agent loop admits and dispatches tools.',
            ],
            ['mailbox.ts', 'Read mailbox.ts. Compare message delivery to the inbox behavior you already read.'],
            ['task-board.ts', 'Read task-board.ts. Revise the summary to explain task ownership and revision checks.'],
            ['types.ts', 'Read types.ts. Identify the source types that constrain the APIs you summarized.'],
            [
              'runtime-context.ts',
              'Re-read runtime-context.ts. Answer this challenge by correcting or defending your earlier summary with exact source paths.',
            ],
          ] as const
          for (let index = 0; index < aPrompts.length; index += 1) {
            const [fileName, instruction] = aPrompts[index]
            const fullPath = sourcePathFor(
              join(host.workspaceCwd, 'workspace'),
              SOURCE_FILES.find((path) => path.endsWith(fileName))!,
            )
            const fullPaths =
              index === 0
                ? [fullPath, sourcePathFor(join(host.workspaceCwd, 'workspace'), SOURCE_FILES[1])]
                : [fullPath]
            const readInstruction = fullPaths
              .map((path) => `Use the DSH filesystem read tool (not shell cat or grep) to read ${path}.`)
              .join(' ')
            const marker = `LONGTASK_A_${index + 1}_${runId.slice(0, 8)}`
            await withPhase(`A${index + 1}`, async () => {
              const toolIndex = tools.length
              const answerIndex = answers.length
              const id = await sendPrompt(
                `${instruction} ${readInstruction} Keep the answer concise and point to source paths.`,
                marker,
                leadSessionId,
              )
              leadSessionId ??= id
              requireRead(String(id), fullPaths, toolIndex)
              expect(
                answers
                  .slice(answerIndex)
                  .some((answer) => answer.session === safeId(String(id)) && answer.text.includes(fileName)),
                `Expected this turn's answer to cite ${fileName}`,
              ).toBe(true)
            })
            if (index === 0) await capture('A', 'progress', { completedRounds: 1 })
          }
          expect(leadSessionId).toBeDefined()
          expect(new Set(turns.filter((turn) => turn.scene === 'A').map((turn) => turn.session)).size).toBe(1)
          await capture('A', 'end', {
            completedRounds: 6,
            sourceReads: tools.filter((tool) => tool.name === 'read').length,
          })
          scenarioStatuses.A = 'passed'
        } else {
          writePrivate(
            join(evidenceDir, 'A-not-run.json'),
            JSON.stringify({ status: 'not-run', reason: `DSH_E2E_LIVE_LONG_TASK_SCENARIOS=${scenarios}` }),
          )
        }

        if (scenarios === 'controls' || scenarios === 'stop-only') {
          writePrivate(
            join(evidenceDir, 'B-not-run.json'),
            JSON.stringify({ status: 'not-run', reason: `DSH_E2E_LIVE_LONG_TASK_SCENARIOS=${scenarios}` }),
          )
        } else {
          // B: create exactly two real DSH members, source-read distinct module groups, then consume their messages.
          resetScene('B')
          await capture('B', 'start', { expectedMembers: 3 })
          const teamMarker = `LONGTASK_B_${runId.slice(0, 8)}`
          const teamSourcePaths = SOURCE_FILES.map((path) => sourcePathFor(join(host.workspaceCwd, 'workspace'), path))
          const bToolIndex = tools.length
          await withPhase(
            'B:team',
            async () => {
              await sendPrompt(
                `Use only the DSH Agent Teams tools shown by the current DSH MCP connection. Create two shared tasks and exactly two members named runtime-reader and teams-reader. Then use task update to assign each task to its named owner. Assign runtime-reader to read these exact files with the DSH filesystem read tool: ${teamSourcePaths.slice(0, 3).join(', ')}. Assign teams-reader to read: ${teamSourcePaths.slice(3).join(', ')}. Each member must actually use read, update its task to completed, and send the Lead one concise source-based report with file paths; the runtime-reader report must include B_REPORT_RUNTIME_${runId.slice(0, 8)}, and the teams-reader report must include B_REPORT_TEAMS_${runId.slice(0, 8)}. After assigning both tasks, finish this turn without waiting for the reports; I will ask you to inspect and consume them in a follow-up. Do not use external subagents or shell to read source. Reference marker ${teamMarker}.`,
                teamMarker,
                leadSessionId,
              )
            },
            180_000,
          )
          const lead = required(leadAgent)
          const roster = host.ctx.agentTeams.listMembers(lead)
          expect(roster).toHaveLength(3)
          const runtimeReader = required(roster.find((member) => member.name === 'runtime-reader'))
          runtimeReaderId = runtimeReader.id
          const teamsReader = required(roster.find((member) => member.name === 'teams-reader'))
          const memberIds = [runtimeReader.id, teamsReader.id]
          memberIds.forEach((id) => memberSessionIds.add(String(id)))
          teamMemberFacts.push(
            ...[runtimeReader, teamsReader].map((member) => ({
              id: String(member.id),
              name: member.name,
              role: String(member.role),
            })),
          )
          await withPhase(
            'B:members-and-receipts',
            async () => {
              await vi.waitFor(
                () => {
                  assertHealthy()
                  const tasks = host.ctx.agentTeams.listTasks(lead)
                  expect(
                    tasks.filter((task) => ['runtime-reader', 'teams-reader'].includes(task.ownerName ?? '')),
                  ).toHaveLength(2)
                  expect(
                    tasks
                      .filter((task) => ['runtime-reader', 'teams-reader'].includes(task.ownerName ?? ''))
                      .every((task) => task.status === 'completed'),
                  ).toBe(true)
                  const queued = teamMessages.filter(
                    (message) =>
                      message.scene === 'B' &&
                      message.session === safeId(String(leadSessionId)) &&
                      message.type === 'team/message/queued' &&
                      message.reportMarker !== undefined,
                  )
                  const delivered = teamMessages.filter(
                    (message) =>
                      message.scene === 'B' &&
                      message.session === safeId(String(leadSessionId)) &&
                      message.type === 'team/message/delivered' &&
                      queued.some((entry) => entry.messageId === message.messageId),
                  )
                  const receipts = teamReceipts.filter(
                    (receipt) => receipt.scene === 'B' && queued.some((entry) => entry.messageId === receipt.messageId),
                  )
                  expect(queued).toHaveLength(2)
                  expect(delivered).toHaveLength(2)
                  expect(receipts).toHaveLength(2)
                  expect(delivered.map((message) => message.messageId).sort()).toEqual(
                    queued.map((message) => message.messageId).sort(),
                  )
                  expect(receipts.map((receipt) => receipt.messageId).sort()).toEqual(
                    queued.map((message) => message.messageId).sort(),
                  )
                  expect(receipts.every((receipt) => receipt.session === safeId(String(leadSessionId)))).toBe(true)
                  expect(new Set(queued.map((message) => message.senderId))).toEqual(new Set(memberIds.map(String)))
                  expect(
                    memberIds.every((id) =>
                      turns.some(
                        (turn) =>
                          turn.scene === 'B' && turn.session === safeId(String(id)) && turn.reason === 'completed',
                      ),
                    ),
                  ).toBe(true)
                  expect(
                    receipts.every((receipt) =>
                      queued.some(
                        (message) => message.messageId === receipt.messageId && message.senderId === receipt.senderId,
                      ),
                    ),
                  ).toBe(true)
                  expect(new Set(queued.map((message) => message.targetId))).toEqual(new Set([String(leadSessionId)]))
                  expect(new Set(delivered.map((message) => message.targetId))).toEqual(
                    new Set([String(leadSessionId)]),
                  )
                  for (const queuedMessage of queued) {
                    const receipt = required(receipts.find((entry) => entry.messageId === queuedMessage.messageId))
                    const delivery = required(delivered.find((entry) => entry.messageId === queuedMessage.messageId))
                    expect(queuedMessage.eventIndex).toBeLessThan(receipt.eventIndex)
                    expect(receipt.eventIndex).toBeLessThan(delivery.eventIndex)
                  }
                },
                { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 500 },
              )
            },
            180_000,
          )
          for (const [memberId, paths] of [
            [runtimeReader.id, SOURCE_FILES.slice(0, 3)],
            [teamsReader.id, SOURCE_FILES.slice(3)],
          ] as const) {
            requireReadFromHostOrNative(
              String(memberId),
              paths.map((path) => sourcePathFor(join(host.workspaceCwd, 'workspace'), path)),
              bToolIndex,
            )
            expect(
              runtimePromptObservations.some(
                (observation) =>
                  observation.session === safeId(String(memberId)) && observation.model === profile.model,
              ),
            ).toBe(true)
            expect(
              modelRouteObservations.some(
                (observation) =>
                  observation.session === safeId(String(memberId)) &&
                  observation.provider === profile.provider &&
                  observation.model === profile.model,
              ),
            ).toBe(true)
          }
          const leadExecutions = tools.filter((tool) => tool.session === safeId(String(leadSessionId)) && !tool.isError)
          expect(tools.filter((tool) => tool.name === 'spawn_teammate' && !tool.isError)).toHaveLength(2)
          expect(leadExecutions.some((tool) => tool.name === 'team_task_create')).toBe(true)
          for (const memberId of memberIds) {
            const memberTools = tools.filter((tool) => tool.session === safeId(String(memberId)) && !tool.isError)
            expect(memberTools.some((tool) => tool.name === 'team_task_get')).toBe(true)
            expect(memberTools.some((tool) => tool.name === 'team_task_update')).toBe(true)
          }
          expect(
            tools.filter(
              (tool) =>
                memberIds.some((id) => tool.session === safeId(String(id))) &&
                tool.name === 'send_message' &&
                !tool.isError,
            ),
          ).toHaveLength(2)
          const bConsumeStart = events.length
          await withPhase('B:lead-consumes-reports', async () => {
            await sendPrompt(
              `Use the task list tool to confirm both assigned tasks are completed, then use the task get tool for each task to inspect its result. Retrieve both member reports and compare their source-based findings. Cite actual module paths and explain one relationship between session/runtime and Teams. Do not run shell or alter files. Marker ${teamMarker}_CONSUME.`,
              `${teamMarker}_CONSUME`,
              leadSessionId,
            )
          })
          const bConsumeEnd = events.findIndex(
            (event, index) => index >= bConsumeStart && event.sessionId === lead.id && event.type === 'turn/end',
          )
          expect(bConsumeEnd).toBeGreaterThan(bConsumeStart)
          const consumedLeadExecutions = tools.filter(
            (tool) => tool.session === safeId(String(leadSessionId)) && !tool.isError,
          )
          for (const toolName of ['team_task_list', 'team_task_get', 'team_task_update'])
            expect(consumedLeadExecutions.some((tool) => tool.name === toolName)).toBe(true)
          expect(
            teamReceipts
              .filter((receipt) => receipt.scene === 'B')
              .every((receipt) => receipt.eventIndex < bConsumeEnd),
          ).toBe(true)
          const leadLog = await host.ctx.sessionPersistence.open(lead.id, 'read')
          try {
            const log = (await leadLog.read()).events
            expect(log.some((event) => event.type === 'assistant/message')).toBe(true)
            const lastAssistant = log.findLast((event) => event.type === 'assistant/message')
            const answer = lastAssistant?.data.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
            expect(answer).toContain('inbox.ts')
            expect(answer).toContain('mailbox.ts')
          } finally {
            await leadLog.close()
          }
          await capture('B', 'end', {
            roster: roster.map((member) => member.name),
            tasks: host.ctx.agentTeams.listTasks(lead).length,
            nativeReads: nativeReadEvidence.filter((read) => read.scene === 'B'),
          })
          scenarioStatuses.B = 'passed'
        }

        // C: Ask controls run either Lead-only or Lead-and-member according to the selected lane.
        resetScene('C')
        const controlsLane = scenarios === 'controls' || scenarios === 'stop-only'
        const operationIds =
          scenarios === 'stop-only'
            ? ([] as const)
            : controlsLane
              ? (['lead-allow', 'lead-reject'] as const)
              : (['lead-allow', 'member-allow', 'lead-reject', 'member-reject'] as const)
        await capture('C', 'start', {
          coverage:
            scenarios === 'stop-only'
              ? 'not-run'
              : controlsLane
                ? 'lead-only-2-decisions'
                : 'lead-and-member-4-decisions',
          requiredDecisions: operationIds.length,
          memberDecisions: controlsLane ? 'not-run' : 'included',
        })
        if (controlsLane) {
          writePrivate(
            join(evidenceDir, 'C-members-not-run.json'),
            JSON.stringify({
              status: 'not-run',
              reason:
                scenarios === 'stop-only'
                  ? 'stop-only lane skips all C approvals'
                  : 'controls lane covers Lead approvals only',
            }),
          )
          await withPhase('C:lead-warmup', async () => {
            const toolCount = tools.length
            const dispatchCount = budget.totalDispatches
            const marker = `LONGTASK_CONTROLS_WARMUP_${runId.slice(0, 8)}`
            await sendPrompt(`Reply exactly READY without using any tools. Marker ${marker}.`, marker)
            expect(leadSessionId).toBeDefined()
            expect(leadAgent).toBeDefined()
            expect(tools).toHaveLength(toolCount)
            expect(budget.totalDispatches).toBe(dispatchCount)
          })
        }
        if (scenarios === 'stop-only')
          writePrivate(
            join(evidenceDir, 'C-not-run.json'),
            JSON.stringify({ status: 'not-run', reason: 'stop-only lane validates D without C approvals' }),
          )
        const operationDir = join(host.workspaceCwd, 'workspace', 'long-task-operations')
        mkdirSync(operationDir, { recursive: true, mode: 0o700 })
        const destinations = new Map(operationIds.map((id) => [id, join(operationDir, `${id}-${runId}.txt`)]))
        for (const target of destinations.values()) expect(existsSync(target)).toBe(false)
        await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(required(leadAgent).id, {
          policy: 'ask',
        })

        const handleApproval = async (
          actor: 'lead' | 'member',
          operation: (typeof operationIds)[number],
          outcome: 'Allow once' | 'Reject',
        ): Promise<void> => {
          const memberId = runtimeReaderId
          if (actor === 'member' && memberId === undefined) throw new Error('LONG_TASK_MEMBER_CONTROLS_NOT_RUN')
          const owner = actor === 'lead' ? String(leadSessionId) : String(required(memberId))
          const destination = required(destinations.get(operation))
          const command = `printf '%s' '${operation}-${runId}' >> '${destination}'`
          const operationMarker = `${operation}-${runId}`
          operationCommands.set(operation, command)
          operationOwners.set(operation, owner)
          registerNativeExecute({ scene: 'C', ownerDshSessionId: owner, operation, command })
          const start = events.length
          const posted = await postPrompt(
            actor === 'lead'
              ? `Use the native DSH bash tool to run exactly this command once: ${command}. It writes only a unique file under the test workspace. Do not use a different tool. Wait for DSH Ask approval. If rejected, do not retry; report the rejection and complete the turn. Marker LONGTASK_C_${operation}_${runId.slice(0, 8)}.`
              : `Use the DSH send_message tool to ask runtime-reader to run exactly this command once using its normal bash tool: ${command}. Tell it not to retry if rejected and to report the result to you, including operation ID ${operationMarker}. Wait for its result and report the outcome. Marker LONGTASK_C_${operation}_${runId.slice(0, 8)}.`,
            `LONGTASK_C_${operation}_${runId.slice(0, 8)}`,
            leadSessionId,
          )
          const handledRequestIds = new Set<string>()
          let targetDecisionSeen = false
          let operationActorCompleted = false
          while (!operationActorCompleted) {
            assertHealthy()
            const ownerEnd =
              actor === 'member'
                ? events.find(
                    (event, index) =>
                      index >= start && event.sessionId === required(runtimeReaderId) && event.type === 'turn/end',
                  )
                : undefined
            const leadEnd = events.find(
              (event, index) =>
                index >= posted.userIndex && event.sessionId === posted.sessionId && event.type === 'turn/end',
            )
            operationActorCompleted =
              targetDecisionSeen &&
              (actor === 'member'
                ? ownerEnd?.type === 'turn/end' && ownerEnd.data.reason.kind === 'completed'
                : (leadEnd?.type === 'turn/end' && leadEnd.data.reason.kind === 'completed') ||
                  (profileName === 'codebuddy' &&
                    actor === 'lead' &&
                    operation === 'lead-reject' &&
                    rejectionCancellation?.confirmed === true))
            if (operationActorCompleted) break
            const pendingAsk = events
              .slice(start)
              .find(
                (event) =>
                  event.type === 'approval/asked' &&
                  !handledRequestIds.has(event.data.id) &&
                  !events.some(
                    (candidate) =>
                      candidate.type === 'approval/decided' &&
                      candidate.sessionId === event.sessionId &&
                      candidate.data.id === event.data.id,
                  ),
              )
            if (pendingAsk === undefined) {
              await waitForEventChange()
              continue
            }
            const asked = pendingAsk
            if (asked?.type !== 'approval/asked') throw new Error('LONG_TASK_APPROVAL_REQUEST_MISSING')
            handledRequestIds.add(asked.data.id)
            const requestEventIndex = events.findIndex(
              (event) =>
                event.type === 'approval/asked' &&
                event.sessionId === asked.sessionId &&
                event.data.id === asked.data.id,
            )
            expect(requestEventIndex).toBeGreaterThan(posted.userIndex)
            const requestOwner = String(asked.sessionId)
            expect(JSON.stringify(asked.data)).toContain(operationMarker)
            const card =
              requestOwner === String(leadSessionId)
                ? required(page).locator('[data-approval-key]').filter({ hasText: operationMarker })
                : required(page)
                    .locator('[data-acp-team-approvals] [data-team-pending-member="runtime-reader"]')
                    .filter({ hasText: operationMarker })
            await card.waitFor({ state: 'visible', timeout: Math.max(1, phaseDeadlineAt - Date.now()) })
            expect(await card.count()).toBe(1)
            const cardText = await card.innerText()
            const nativeApproval = nativeExecuteObserver.matchApproval({
              scene: 'C',
              ownerDshSessionId: requestOwner,
              operation,
              reason: asked.data.reason,
              cardText,
            })
            const isHostOperation = asked.data.toolName === 'bash' && requestOwner === owner
            const isNativeOperation = nativeApproval !== undefined
            const isOperation = isHostOperation || isNativeOperation
            const isCoordinationAsk = !isOperation && actor === 'member' && asked.data.toolName === 'send_message'
            const permissionRoute =
              isNativeOperation && isHostOperation
                ? 'both'
                : isNativeOperation
                  ? 'native-permission'
                  : isHostOperation
                    ? 'host-approval'
                    : 'team-coordination'
            assertHealthy()
            expect(isOperation || isCoordinationAsk).toBe(true)
            if (isNativeOperation) {
              const command = required(operationCommands.get(operation))
              expect(asked.data.reason).toContain(command)
              expect(cardText).toContain(command)
              expect(asked.data.reason).toContain(operationMarker)
              expect(cardText).toContain(operationMarker)
            }
            if (
              profileName === 'codebuddy' &&
              actor === 'lead' &&
              operation === 'lead-reject' &&
              outcome === 'Reject' &&
              isOperation &&
              isNativeOperation
            ) {
              if (rejectionCancellation !== undefined) throw new Error('LONG_TASK_REJECTION_GATE_ALREADY_ACTIVE')
              const diagnosticOwner = nativeDiagnosticModule?.liveDiagnosticId('dsh-session', requestOwner)
              const prompt = [...promptTraces]
                .reverse()
                .find(
                  (candidate) =>
                    candidate.scene === 'C' &&
                    candidate.phase === activePhase &&
                    candidate.owner === diagnosticOwner &&
                    candidate.promptOrdinal !== undefined &&
                    candidate.leaseId !== undefined &&
                    candidate.stopReason === undefined,
                )
              const promptOrdinal = prompt?.promptOrdinal
              const leaseId = prompt?.leaseId
              const marker = `LONGTASK_C_${operation}_${runId.slice(0, 8)}`
              const turn = claimedTurnByMarker.get(marker)
              if (
                prompt === undefined ||
                diagnosticOwner === undefined ||
                turn === undefined ||
                promptOrdinal === undefined ||
                leaseId === undefined ||
                nativeApproval === undefined
              )
                throw new Error('LONG_TASK_REJECTION_GATE_EVIDENCE_UNAVAILABLE')
              rejectionCancellation = {
                expected: {
                  profile: 'codebuddy',
                  scene: 'C',
                  phase: activePhase,
                  operation,
                  owner: diagnosticOwner,
                  acpSession: prompt.acpSession,
                  requestId: safeId(`approval-request:${asked.data.id}`),
                  promptOrdinal,
                  leaseId,
                  turn,
                  callId: nativeApproval.callId,
                },
                prompt,
                requestIdRaw: asked.data.id,
                requestEventIndex,
                destination,
                confirmed: false,
                consumed: false,
              }
            }
            if (isOperation) expect(existsSync(destination)).toBe(false)
            await capture('C', `${operation}-pending-${handledRequestIds.size}`, {
              actor,
              session: safeId(requestOwner),
              expectedOutcome: isOperation ? outcome : 'Allow once',
              approvalTool: asked.data.toolName,
              permissionRoute,
            })
            await card.getByRole('button', { name: isOperation ? outcome : 'Allow once', exact: true }).click()
            const expectedDecision = isOperation
              ? outcome === 'Allow once'
                ? 'allowed-once'
                : 'rejected'
              : 'allowed-once'
            await vi.waitFor(
              () => {
                assertHealthy()
                const decided = events.find(
                  (event) =>
                    event.type === 'approval/decided' &&
                    String(event.sessionId) === requestOwner &&
                    event.data.id === asked.data.id,
                )
                expect(decided?.type === 'approval/decided' ? decided.data.outcome : undefined).toBe(expectedDecision)
              },
              { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
            )
            approvalEvidence.push({
              operation,
              session: safeId(requestOwner),
              request: safeId(asked.data.id),
              requestEventIndex,
              toolName: asked.data.toolName,
              outcome: expectedDecision,
              permissionRoute,
            })
            if (isNativeOperation) {
              const remoteCancelledReject =
                profileName === 'codebuddy' &&
                actor === 'lead' &&
                operation === 'lead-reject' &&
                outcome === 'Reject' &&
                rejectionCancellation !== undefined
              if (!remoteCancelledReject) {
                const terminal = outcome === 'Allow once' ? ['completed'] : ['failed', 'cancelled']
                await vi.waitFor(
                  () => {
                    assertHealthy()
                    const matching = nativeExecuteObserver
                      .evidence()
                      .filter(
                        (entry) =>
                          entry.scene === 'C' &&
                          entry.owner === safeId(`dsh-session:${requestOwner}`) &&
                          entry.operation === operation,
                      )
                    expect(matching).toHaveLength(1)
                    expect(terminal).toContain(matching[0]?.status)
                  },
                  { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
                )
              }
            }
            if (isOperation) operationPermissionRoutes.set(operation, permissionRoute)
            if (isOperation) targetDecisionSeen = true
          }
          expect(
            approvalEvidence.filter(
              (entry) => entry.operation === operation && entry.permissionRoute !== 'team-coordination',
            ),
          ).toHaveLength(1)
          if (outcome === 'Allow once') {
            await vi.waitFor(() => expect(readFileSync(destination, 'utf8')).toBe(`${operation}-${runId}`), {
              timeout: Math.max(1, phaseDeadlineAt - Date.now()),
            })
          } else expect(existsSync(destination)).toBe(false)
          if (actor === 'lead') {
            if (rejectionCancellation?.expected.operation !== operation || !rejectionCancellation.confirmed)
              await waitForTurn(posted.sessionId, posted.userIndex)
          } else {
            await vi.waitFor(
              () => {
                assertHealthy()
                const memberEnd = events.find(
                  (event, index) =>
                    index >= start && event.sessionId === required(runtimeReaderId) && event.type === 'turn/end',
                )
                expect(memberEnd?.type === 'turn/end' ? memberEnd.data.reason.kind : undefined).toBe('completed')
              },
              { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
            )
            await waitForTurn(posted.sessionId, posted.userIndex)
          }
          await capture('C', `${operation}-settled`, { actor, outcome, fileWritten: outcome === 'Allow once' })
          const nativeCalls = nativeExecuteObserver
            .evidence()
            .filter((entry) => entry.scene === 'C' && entry.operation === operation)
          const operationTools = tools.filter((tool) => tool.operationId === operation)
          const classifiedExecutionRoute = classifyExecutionRoute({
            decision: outcome === 'Allow once' ? 'allow' : 'reject',
            hostAdmissions: operationAdmissions.get(operation) ?? 0,
            hostResults: operationTools,
            nativeCalls,
            fileExists: existsSync(destination),
            fileContents: existsSync(destination) ? readFileSync(destination, 'utf8') : undefined,
            expectedContents: `${operation}-${runId}`,
          })
          const executionRoute =
            profileName === 'codebuddy' &&
            actor === 'lead' &&
            operation === 'lead-reject' &&
            rejectionCancellation?.confirmed === true
              ? 'not-dispatched'
              : classifiedExecutionRoute
          operationExecutionRoutes.set(operation, executionRoute)
          if (outcome === 'Allow once') expect(['host-tool', 'native-execute']).toContain(executionRoute)
          else expect(executionRoute).toBe('not-dispatched')
        }
        const approvalPlan =
          scenarios === 'stop-only'
            ? ([] as const)
            : controlsLane
              ? ([
                  ['lead', 'lead-allow', 'Allow once'],
                  ['lead', 'lead-reject', 'Reject'],
                ] as const)
              : ([
                  ['lead', 'lead-allow', 'Allow once'],
                  ['member', 'member-allow', 'Allow once'],
                  ['lead', 'lead-reject', 'Reject'],
                  ['member', 'member-reject', 'Reject'],
                ] as const)
        for (const [actor, operation, outcome] of approvalPlan)
          await withPhase(`C:${operation}`, () => handleApproval(actor, operation, outcome))
        for (const operation of operationIds) {
          const allowed = operation.endsWith('-allow')
          if (allowed) expect(readFileSync(required(destinations.get(operation)), 'utf8')).toBe(`${operation}-${runId}`)
          else expect(existsSync(required(destinations.get(operation)))).toBe(false)
          const route = required(operationExecutionRoutes.get(operation))
          if (allowed) expect(['host-tool', 'native-execute']).toContain(route)
          else expect(route).toBe('not-dispatched')
        }
        if (operationIds.length > 0) {
          const resumeMarker = `LONGTASK_C_RESUME_${runId.slice(0, 8)}`
          const resumeStartIndex = events.length
          const resumedSession = await withPhase('C:resume-summary', () =>
            sendPrompt(
              `Continue the same session. Summarize these approval outcomes using their operation IDs: ${operationIds.join(', ')}. Do not run more tools. Marker LONGTASK_C_RESUME_${runId.slice(0, 8)}.`,
              resumeMarker,
              leadSessionId,
            ),
          )
          await checkModelSnapshot(String(resumedSession), 'after-approval-resume')
          if (rejectionCancellation !== undefined) {
            const resumeOwner = nativeDiagnosticModule?.liveDiagnosticId('dsh-session', String(resumedSession))
            const resumePrompt = [...promptTraces]
              .reverse()
              .find(
                (candidate) =>
                  candidate.scene === 'C' &&
                  candidate.phase === 'C:resume-summary' &&
                  candidate.owner === resumeOwner &&
                  candidate.stopReason !== undefined,
              )
            expect(resumePrompt, 'Expected the follow-up to use a real ACP prompt').toBeDefined()
            expect(resumePrompt?.acpSession).toBe(rejectionCancellation.expected.acpSession)
            expect(resumePrompt?.stopReason).toBe('end_turn')
            const resumeUserIndex = events.findIndex(
              (event) =>
                event.sessionId === resumedSession &&
                event.type === 'user/message' &&
                JSON.stringify(event.data.content).includes(resumeMarker),
            )
            expect(resumeUserIndex).toBeGreaterThanOrEqual(0)
            const previousOperationMarker = `LONGTASK_C_lead-reject_${runId.slice(0, 8)}`
            expect(
              events.some(
                (event, index) =>
                  index < resumeUserIndex &&
                  event.sessionId === resumedSession &&
                  event.type === 'user/message' &&
                  JSON.stringify(event.data.content).includes(previousOperationMarker),
              ),
            ).toBe(true)
            const endIndex = rejectionCancellation.turnEndEventIndex
            if (controlsLane && rejectionCancellation.confirmed) {
              expect(endIndex).toBeDefined()
              const recoveryMessages = events.filter(
                (event, index) =>
                  index > required(endIndex) && event.sessionId === resumedSession && event.type === 'user/message',
              )
              expect(recoveryMessages).toHaveLength(1)
              expect(
                recoveryMessages.some(
                  (event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(resumeMarker),
                ),
              ).toBe(true)
            }
            await capture(
              'C',
              rejectionCancellation.confirmed ? 'after-rejected-cancel-resume' : 'after-approval-resume',
              {
                sameAcpBinding: true,
                rejectedCancellationConfirmed: rejectionCancellation.confirmed,
                priorOperationRetainedInSessionEvents: true,
                followupAssistantObserved: events.some(
                  (event, index) =>
                    index >= resumeStartIndex &&
                    event.sessionId === resumedSession &&
                    event.type === 'assistant/message',
                ),
                followupMarker: resumeMarker,
                followupUserCount: controlsLane ? 1 : 'not-counted',
              },
            )
          }
        }
        const cModelSnapshots = modelSnapshots.filter((entry) => entry.session === safeId(String(leadSessionId)))
        if (cModelSnapshots.some((entry) => entry.modeObserved))
          expect(
            cModelSnapshots.filter((entry) => entry.modeObserved).every((entry) => entry.modePreserved !== false),
          ).toBe(true)
        await capture('C', scenarios === 'stop-only' ? 'not-run' : 'end', {
          coverage:
            scenarios === 'stop-only'
              ? 'not-run'
              : controlsLane
                ? 'lead-only-2-decisions'
                : 'lead-and-member-4-decisions',
          memberDecisions: controlsLane ? 'not-run' : 'completed',
          allowed: operationIds.filter((operation) => operation.endsWith('-allow')).length,
          rejected: operationIds.filter((operation) => operation.endsWith('-reject')).length,
          acpExecutePermissions: nativeExecuteObserver.evidence().filter((entry) => entry.scene === 'C'),
          rejectedCancellation: rejectionCancellationEvidence,
          permissionRoutes: Object.fromEntries(operationPermissionRoutes),
          executionRoutes: Object.fromEntries(operationExecutionRoutes),
          sideEffects: {
            allowed: operationIds.filter((operation) => operation.endsWith('-allow')).length,
            rejected: 0,
          },
        })
        scenarioStatuses.C = scenarios === 'stop-only' ? 'not-run' : controlsLane ? 'partial' : 'passed'

        // D: a genuine shell process is interrupted, the page reloads, and queued input remains unsent.
        resetScene('D')
        await capture('D', 'start', { session: safeId(String(leadSessionId)) })
        const longStarted = join(operationDir, `long-start-${runId}.txt`)
        const longFinished = join(operationDir, `long-finished-${runId}.txt`)
        const queuedMarker = `LONGTASK_D_QUEUED_${runId.slice(0, 8)}`
        const longMarker = `LONGTASK_D_RUNNING_${runId.slice(0, 8)}`
        const resumeMarker = `LONGTASK_D_RESUME_${runId.slice(0, 8)}`
        const shellCommand = `printf '%s' '${longMarker}' >> '${longStarted}'; sleep 120; printf '%s' '${runId}' > '${longFinished}'`
        registeredLongCommand = shellCommand
        operationCommands.set('D:long-running', shellCommand)
        registerNativeExecute({
          scene: 'D',
          ownerDshSessionId: String(leadSessionId),
          operation: 'D:long-running',
          command: shellCommand,
        })
        await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(required(leadAgent).id, {
          policy: 'ask',
        })
        const turnBefore = events.filter(
          (event) => event.sessionId === leadSessionId && event.type === 'user/message',
        ).length
        const dText = `Use the native DSH bash tool to run exactly this long shell command once: ${shellCommand}. Set timeoutMs to 120000 and run_in_background to false. Do not cancel it yourself and do not run another command. Marker ${longMarker}.`
        await withPhase('D:stop-refresh-queue-resume', async () => {
          await writeComposerDraft(required(page), required(page).locator('[data-composer-input]').first(), dText)
          const dBefore = events.length
          await required(page).getByRole('button', { name: 'Send message', exact: true }).click()
          await vi.waitFor(
            () =>
              expect(
                events
                  .slice(dBefore)
                  .some(
                    (event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(longMarker),
                  ),
              ).toBe(true),
            {
              timeout: Math.max(1, phaseDeadlineAt - Date.now()),
            },
          )
          const dUserIndex = events.findIndex(
            (event, index) =>
              index >= dBefore &&
              event.type === 'user/message' &&
              JSON.stringify(event.data.content).includes(longMarker),
          )
          const approval = required(page).locator('[data-approval-key]')
          await approval.waitFor({ timeout: Math.max(1, phaseDeadlineAt - Date.now()) })
          const dAsked = events
            .slice(dBefore)
            .find(
              (event) =>
                event.type === 'approval/asked' &&
                event.sessionId === leadSessionId &&
                event.data.reason?.includes(shellCommand),
            )
          const dNativeMatch = nativeExecuteObserver.matchApproval({
            scene: 'D',
            ownerDshSessionId: String(leadSessionId),
            operation: 'D:long-running',
            reason: dAsked?.type === 'approval/asked' ? dAsked.data.reason : undefined,
            cardText: await approval.innerText(),
          })
          assertHealthy()
          const dHostApproval = dAsked?.type === 'approval/asked' && dAsked.data.toolName === 'bash'
          const dPermissionRoute =
            dNativeMatch !== undefined && dHostApproval
              ? 'both'
              : dNativeMatch !== undefined
                ? 'native-permission'
                : 'host-approval'
          operationPermissionRoutes.set('D:long-running', dPermissionRoute)
          expect(dNativeMatch !== undefined || dHostApproval).toBe(true)
          if (dNativeMatch !== undefined) {
            expect(dAsked?.type === 'approval/asked' ? dAsked.data.reason : undefined).toContain(shellCommand)
            expect(await approval.innerText()).toContain(shellCommand)
            expect(dAsked?.type === 'approval/asked' ? dAsked.data.reason : undefined).toContain(longMarker)
            expect(await approval.innerText()).toContain(longMarker)
          }
          await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
          if (dAsked?.type === 'approval/asked') {
            const requestEventIndex = events.findIndex(
              (event) =>
                event.type === 'approval/asked' &&
                event.sessionId === dAsked.sessionId &&
                event.data.id === dAsked.data.id,
            )
            approvalEvidence.push({
              operation: 'D:long-running',
              session: safeId(String(leadSessionId)),
              request: safeId(dAsked.data.id),
              requestEventIndex,
              toolName: dAsked.data.toolName,
              outcome: 'allowed-once',
              permissionRoute: dPermissionRoute,
            })
          }
          await vi.waitFor(() => expect(readFileSync(longStarted, 'utf8')).toBe(longMarker), {
            timeout: Math.max(1, phaseDeadlineAt - Date.now()),
          })
          dExecutionRoute =
            dLongAdmissions === 1 && dLongCallIds.size === 1
              ? 'host-tool'
              : dLongAdmissions === 0 && dLongCallIds.size === 0 && dNativeMatch !== undefined
                ? 'native-execute'
                : 'unknown'
          operationExecutionRoutes.set('D:long-running', dExecutionRoute)
          expect(dExecutionRoute).not.toBe('unknown')
          const composer = required(page).locator('[data-composer-input]').first()
          await writeComposerDraft(required(page), composer, queuedMarker)
          await required(page).getByRole('button', { name: 'Queue message', exact: true }).click()
          const queued = required(page)
            .locator('[data-queue-dock]')
            .getByRole('listitem')
            .filter({ hasText: queuedMarker })
          await queued.waitFor()
          await vi.waitFor(
            async () => {
              assertHealthy()
              expect(await queued.getAttribute('data-submission-echo')).toBeNull()
            },
            { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
          )
          expect(
            events.find(
              (event, index) => index >= dUserIndex && event.sessionId === leadSessionId && event.type === 'turn/end',
            ),
          ).toBeUndefined()
          await capture('D', 'running-queued', {
            startedMarker: true,
            queued: true,
            acpExecutePermissions: nativeExecuteObserver.evidence().filter((entry) => entry.scene === 'D'),
            jobs: jobSnapshot(),
          })
          await required(page).reload()
          await queued.waitFor()
          await vi.waitFor(
            async () => {
              assertHealthy()
              expect(await queued.getAttribute('data-submission-echo')).toBeNull()
            },
            { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
          )
          await capture('D', 'after-refresh', {
            queued: true,
            acpExecutePermissions: nativeExecuteObserver.evidence().filter((entry) => entry.scene === 'D'),
            jobs: jobSnapshot(),
          })
          expect(
            events.find(
              (event, index) => index > dUserIndex && event.sessionId === leadSessionId && event.type === 'turn/end',
            ),
          ).toBeUndefined()
          expect(tools.filter((tool) => tool.operationId === 'D:long-running')).toHaveLength(0)
          expect(expectedDAbortTurn).toBe(claimedTurnByMarker.get(longMarker))
          expectingDStop = true
          await required(page).getByRole('button', { name: 'Stop generating', exact: true }).click()
          await vi.waitFor(
            () => {
              assertHealthy()
              const end = events.find(
                (event, index) =>
                  index > dUserIndex &&
                  event.sessionId === leadSessionId &&
                  event.type === 'turn/end' &&
                  event.data.turn === expectedDAbortTurn,
              )
              expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('aborted')
            },
            { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
          )
          expectingDStop = false
          expect(readFileSync(longStarted, 'utf8')).toBe(longMarker)
          expect(existsSync(longFinished)).toBe(false)
          if (dNativeMatch !== undefined) {
            await vi.waitFor(
              () => {
                assertHealthy()
                const matching = nativeExecuteObserver
                  .evidence()
                  .filter((entry) => entry.scene === 'D' && entry.operation === 'D:long-running')
                expect(matching).toHaveLength(1)
                expect(['completed', 'failed', 'cancelled']).toContain(matching[0]?.status)
                if (dExecutionRoute === 'native-execute') expect(['failed', 'cancelled']).toContain(matching[0]?.status)
              },
              { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
            )
          }
          const expectedJobOwner = safeId(`dsh-session:${String(leadSessionId)}`)
          const matchingJobEvents = () =>
            jobEvidence.filter(
              (entry) => entry.label === shellCommand && entry.owner === expectedJobOwner && entry.kind === 'bash',
            )
          if (matchingJobEvents().length > 0) {
            await vi.waitFor(
              () => {
                assertHealthy()
                const settledByHost = matchingJobEvents().some(
                  (entry) => entry.event === 'settled' && entry.cause === 'kill' && entry.awaited === true,
                )
                expect(settledByHost).toBe(true)
                expect(jobSnapshot().exactCommandActiveCount).toBe(0)
              },
              { timeout: Math.max(1, phaseDeadlineAt - Date.now()), interval: 150 },
            )
            dJobQuiescence = 'host-job-settlement'
          }
          const dNativeEvidence = nativeExecuteObserver
            .evidence()
            .filter((entry) => entry.scene === 'D' && entry.operation === 'D:long-running')
          if (dExecutionRoute === 'host-tool') {
            expect(dLongAdmissions).toBe(1)
            expect(dLongCallIds.size).toBe(1)
            expect(tools.filter((tool) => tool.operationId === 'D:long-running')).toHaveLength(1)
            expect(required(tools.find((tool) => tool.operationId === 'D:long-running')).isError).toBe(true)
          } else {
            expect(tools.filter((tool) => tool.operationId === 'D:long-running')).toHaveLength(0)
            expect(dNativeEvidence).toHaveLength(1)
            expect(['failed', 'cancelled']).toContain(dNativeEvidence[0]?.status)
          }
          expect(
            events.filter(
              (event, index) =>
                index > dUserIndex &&
                event.sessionId === leadSessionId &&
                event.type === 'user/message' &&
                JSON.stringify(event.data.content).includes(queuedMarker),
            ),
          ).toHaveLength(0)
          await queued.waitFor()
          await capture('D', 'stopped-queued', {
            turnAborted: true,
            queued: true,
            acpExecutePermissions: nativeExecuteObserver.evidence().filter((entry) => entry.scene === 'D'),
            jobs: jobSnapshot(),
          })
          await writeComposerDraft(
            required(page),
            composer,
            `Resume queued input once, then reply without tools. Marker ${resumeMarker}`,
          )
          await required(page).getByRole('button', { name: 'Send message', exact: true }).click()
          while (true) {
            assertHealthy()
            try {
              expect(
                events.filter(
                  (event) =>
                    event.sessionId === leadSessionId &&
                    event.type === 'user/message' &&
                    JSON.stringify(event.data.content).includes(queuedMarker),
                ),
              ).toHaveLength(1)
              expect(
                events.filter(
                  (event) =>
                    event.sessionId === leadSessionId &&
                    event.type === 'user/message' &&
                    JSON.stringify(event.data.content).includes(resumeMarker),
                ),
              ).toHaveLength(1)
              const queuedIndex = events.findIndex(
                (event, index) =>
                  index > dUserIndex &&
                  event.sessionId === leadSessionId &&
                  event.type === 'user/message' &&
                  JSON.stringify(event.data.content).includes(queuedMarker),
              )
              const resumeIndex = events.findIndex(
                (event, index) =>
                  index > dUserIndex &&
                  event.sessionId === leadSessionId &&
                  event.type === 'user/message' &&
                  JSON.stringify(event.data.content).includes(resumeMarker),
              )
              expect(queuedIndex).toBeGreaterThan(dUserIndex)
              expect(resumeIndex).toBeGreaterThan(queuedIndex)
              expect(
                events.filter(
                  (event, index) =>
                    index > dUserIndex &&
                    event.sessionId === leadSessionId &&
                    event.type === 'turn/end' &&
                    event.data.reason.kind === 'completed',
                ),
              ).toHaveLength(2)
              const queuedTurn = claimedTurnByMarker.get(queuedMarker)
              const resumeTurn = claimedTurnByMarker.get(resumeMarker)
              expect(queuedTurn).toBeDefined()
              expect(resumeTurn).toBeDefined()
              expect(queuedTurn).not.toBe(resumeTurn)
              const completedTurns = events
                .filter(
                  (event, index) =>
                    index > dUserIndex &&
                    event.sessionId === leadSessionId &&
                    event.type === 'turn/end' &&
                    event.data.reason.kind === 'completed',
                )
                .map((event) => (event.type === 'turn/end' ? event.data.turn : undefined))
              expect(completedTurns).toContain(queuedTurn)
              expect(completedTurns).toContain(resumeTurn)
              break
            } catch {
              assertHealthy()
              await waitForEventChange()
            }
          }
          assertHealthy()
          expect(
            events.filter((event) => event.sessionId === leadSessionId && event.type === 'user/message'),
          ).toHaveLength(turnBefore + 3)
          const finalDRoute = required(operationExecutionRoutes.get('D:long-running'))
          expect(dLongAdmissions).toBe(finalDRoute === 'host-tool' ? 1 : 0)
          expect(tools.filter((tool) => tool.operationId === 'D:long-running')).toHaveLength(
            finalDRoute === 'host-tool' ? 1 : 0,
          )
          await checkModelSnapshot(String(leadSessionId), 'after-stop-queue-resume')
          const dModelSnapshots = modelSnapshots.filter((entry) => entry.session === safeId(String(leadSessionId)))
          if (dModelSnapshots.some((entry) => entry.modeObserved))
            expect(
              dModelSnapshots.filter((entry) => entry.modeObserved).every((entry) => entry.modePreserved !== false),
            ).toBe(true)
          await capture('D', 'end', {
            turnAborted: true,
            longCommandFinished: false,
            queuedInputDeliveredOnce: true,
            acpExecutePermissions: nativeExecuteObserver.evidence().filter((entry) => entry.scene === 'D'),
            jobs: jobSnapshot(),
            jobQuiescence: {
              hostJobSettlement: dJobQuiescence,
              managedRangeExit: 'not-observed',
            },
            acpExecutePermissionFacts: {
              executionRoute: dExecutionRoute,
              permissionRoute: dPermissionRoute,
              count: dNativeEvidence.length,
              status: dNativeEvidence[0]?.status ?? 'not-observed',
            },
          })
        })
        scenarioStatuses.D = dJobSettled() && dUsesHostTool() ? 'passed' : 'partial'

        expect(stickyViolation).toBeUndefined()
        expect(errorTexts).toEqual([])
        expect(nativeDiagnosticModule.liveDiagnosticTraceFailureCount()).toBe(0)
        expect(nativeTraceEvents).toBeGreaterThan(0)
        expect(screenshotFailures).toEqual([])
        await Promise.all([...pendingScreenshotPromises])
        expect(screenshotFailures).toEqual([])
        expect(modelRouteObservations.length).toBeGreaterThan(0)
        expect(
          modelRouteObservations.every((entry) => entry.provider === profile.provider && entry.model === profile.model),
        ).toBe(true)
        expect(modelSnapshots.length).toBeGreaterThan(0)
        expect(modelSnapshots.every((entry) => entry.freshness === 'live' && entry.model === profile.model)).toBe(true)
        expect(runtimePromptChecks).toBeGreaterThan(0)
        const finalSource = evidenceSource.files.map((file) => {
          const digest = createHash('sha256')
            .update(readFileSync(sourcePathFor(join(host.workspaceCwd, 'workspace'), file.path)))
            .digest('hex')
          expect(digest, `Pinned source changed during the run: ${file.path}`).toBe(file.sha256)
          return { path: file.path, sha256: digest }
        })
        completedRunRecord = {
          status: Object.values(scenarioStatuses).some((status) => status === 'not-run' || status === 'partial')
            ? 'passed-with-skipped-scenarios'
            : 'passed',
          scenarios: scenarioStatuses,
          scenarioSelection: scenarios,
          nativeReads: nativeReadEvidence,
          acpExecutePermissions: nativeExecuteObserver.evidence(),
          permissionRoutes: Object.fromEntries(operationPermissionRoutes),
          executionRoutes: Object.fromEntries(operationExecutionRoutes),
          rejectedCancellation: rejectionCancellationEvidence,
          jobQuiescence: {
            hostJobSettlement: dJobQuiescence,
            managedRangeExit: 'not-observed',
          },
          jobEvents: jobEvidence.map(({ event, id, owner, kind, status, startedAt, finishedAt, cause, awaited }) => ({
            event,
            id,
            ...(owner === undefined ? {} : { owner }),
            kind,
            status,
            startedAt,
            ...(finishedAt === undefined ? {} : { finishedAt }),
            ...(cause === undefined ? {} : { cause }),
            ...(awaited === undefined ? {} : { awaited }),
          })),
          agent: profileName,
          provider: profile.provider,
          model: profile.model,
          cliVersion,
          dshCommit: SOURCE_COMMIT,
          dshPluginVersion: packageJson.version,
          platform: process.platform,
          arch: process.arch,
          durationMs: Date.now() - startedAt,
          budget: {
            hostDispatches: budget.totalDispatches,
            sceneDispatches: budget.sceneDispatches,
            approvalRequests: budget.approvalRequests,
            providerToolCallsSoft: budget.providerToolCallIds.size,
            spawnAttempts: budget.spawnAttempts,
            repeatedEffects: [...budget.successfulEffectCounts.values()],
          },
          source: evidenceSource,
          sourceEnd: finalSource,
          tools,
          approvals,
          approvalEvidence,
          teamMessages: teamMessages.map((message) => ({
            scene: message.scene,
            session: message.session,
            type: message.type,
            ...(message.messageId === undefined ? {} : { messageId: safeId(message.messageId) }),
            ...(message.targetId === undefined ? {} : { target: safeId(message.targetId) }),
            ...(message.senderId === undefined ? {} : { sender: safeId(message.senderId) }),
            ...(message.reportMarker === undefined ? {} : { reportMarker: message.reportMarker }),
          })),
          teamReceipts: teamReceipts.map((receipt) => ({
            scene: receipt.scene,
            session: receipt.session,
            messageId: safeId(receipt.messageId),
            sender: receipt.senderId === undefined ? 'unavailable' : safeId(receipt.senderId),
            eventIndex: receipt.eventIndex,
          })),
          turns,
          teamMembers: teamMemberFacts.map((member) => ({ ...member, id: safeId(member.id) })),
          modelSnapshots,
          modelRouteObservations,
          runtimePromptObservations,
          nativeRuntimePromptChecks: runtimePromptChecks,
          nativeTraceEvents,
          pageErrors: errorTexts,
          modelReviewFile: 'model-review.json',
        }
        writePrivate(join(evidenceDir, 'model-review.json'), JSON.stringify(answers, null, 2))
      } catch (error) {
        primaryFailure = error
        runFailed = true
        await capture(activeScene, 'failed', {
          phase: activePhase,
          failure: error instanceof Error ? error.name : 'UnknownError',
          violation: stickyViolation,
        }).catch(() => undefined)
        writePrivate(join(evidenceDir, 'model-review.json'), JSON.stringify(answers, null, 2))
        writePrivate(
          join(evidenceDir, 'run.json'),
          JSON.stringify(
            {
              status: 'failed',
              scenarios: scenarioStatuses,
              scenarioSelection: scenarios,
              nativeReads: nativeReadEvidence,
              acpExecutePermissions: nativeExecuteObserver.evidence(),
              rejectedCancellation: rejectionCancellationEvidence,
              permissionRoutes: Object.fromEntries(operationPermissionRoutes),
              executionRoutes: Object.fromEntries(operationExecutionRoutes),
              jobQuiescence: {
                hostJobSettlement: dJobQuiescence,
                managedRangeExit: 'not-observed',
              },
              jobEvents: jobEvidence.map(
                ({ event, id, owner, kind, status, startedAt, finishedAt, cause, awaited }) => ({
                  event,
                  id,
                  ...(owner === undefined ? {} : { owner }),
                  kind,
                  status,
                  startedAt,
                  ...(finishedAt === undefined ? {} : { finishedAt }),
                  ...(cause === undefined ? {} : { cause }),
                  ...(awaited === undefined ? {} : { awaited }),
                }),
              ),
              agent: profileName,
              provider: profile.provider,
              model: profile.model,
              phase: activePhase,
              violation: stickyViolation,
              dispatches: budget.totalDispatches,
              approvals: budget.approvalRequests,
              tools,
              approvalEvidence,
              teamMessages: teamMessages.map((message) => ({
                scene: message.scene,
                session: message.session,
                type: message.type,
                ...(message.messageId === undefined ? {} : { messageId: safeId(message.messageId) }),
              })),
              teamReceipts: teamReceipts.map((receipt) => ({
                scene: receipt.scene,
                session: receipt.session,
                messageId: safeId(receipt.messageId),
                eventIndex: receipt.eventIndex,
              })),
              turns,
              teamMembers: teamMemberFacts.map((member) => ({ ...member, id: safeId(member.id) })),
              modelSnapshots,
              modelRouteObservations,
              runtimePromptObservations,
              pageErrors: errorTexts,
              modelReviewFile: 'model-review.json',
              nativeRuntimePromptChecks: runtimePromptChecks,
              nativeTraceEvents,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            },
            null,
            2,
          ),
        )
        await cancelAll('LONG_TASK_PRIMARY_FAILURE')
        throw error
      } finally {
        let cleanupFailure: unknown
        try {
          if (host) {
            await Promise.all([...pendingScreenshotPromises])
            if (screenshotFailures.length > 0) cleanupFailure = new Error('LONG_TASK_SCREENSHOT_FAILURE')
            if (stickyViolation !== undefined) await cancelAll(stickyViolation)
            await host.close()
            if (
              stickyViolation !== undefined ||
              errorTexts.length > 0 ||
              (nativeDiagnosticModule?.liveDiagnosticTraceFailureCount() ?? 0) > 0
            )
              cleanupFailure = new Error(stickyViolation ?? 'LONG_TASK_FAILURE_DURING_CLEANUP')
          }
        } catch (error) {
          cleanupFailure = error
        } finally {
          removeJobEvents?.()
          for (const restorePermissionHandler of restoreRuntimePermissionHandlers.reverse()) restorePermissionHandler()
          restoreRuntimePrompt?.()
          removeTrace?.()
          try {
            await browser?.close()
          } catch (error) {
            cleanupFailure ??= error
          }
        }
        if (!runFailed && cleanupFailure === undefined && completedRunRecord !== undefined)
          writePrivate(join(evidenceDir, 'run.json'), JSON.stringify(completedRunRecord, null, 2))
        if (cleanupFailure !== undefined) {
          if (primaryFailure === undefined) throw cleanupFailure
          writePrivate(
            join(evidenceDir, 'cleanup.json'),
            JSON.stringify({
              errorName: cleanupFailure instanceof Error ? cleanupFailure.name : 'UnknownError',
              violation: stickyViolation,
            }),
          )
        }
      }
    },
    22 * 60_000,
  )
})
