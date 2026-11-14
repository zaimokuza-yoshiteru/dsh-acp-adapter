import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import type { AcpNativeUserQuestionService } from '../../src/domain/policy/elicitation.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTrace } from '../../src/contract/live-diagnostic-trace.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { longTaskEffectFingerprint } from './live-long-task-budget.ts'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'
import {
  exactOnceOption,
  intactPermissionInput,
  isKnownDevinManualTitleRequest,
  permitsDevinTeamTool,
  type DevinTeamScope,
} from './live-devin-team-scope.ts'
import { required } from './required.ts'

/** The UI operations exercised by this fixture, usable without importing the browser scaffold in unit tests. */
interface ApprovalCard {
  filter(options: { visible?: boolean; hasText?: string }): ApprovalCard
  count(): Promise<number>
  evaluateAll<T>(read: (elements: Element[]) => T): Promise<T>
  getByRole(role: 'radio' | 'button', options?: { name?: string | RegExp; exact?: boolean }): ApprovalCard
  click(options?: { timeout: number }): Promise<void>
  screenshot(options: { path: string; timeout?: number }): Promise<unknown>
}

export interface DevinManualApprovalContext {
  readonly cliVersion: string
  /** Fixture has no native MCP servers/imports: its only dsh endpoint is the session-owned bridge.
   * This supports a known-CLI manual answer only; the bridge/owner/hash/scope checks still apply. */
  assertIsolatedSessionMcp(cwd: string): Promise<void>
}

/** Only this opted-in real Devin task is answered, through the original native UI. */
export function installLiveDevinTeamApprovals({
  host,
  page,
  token,
  memberName,
  model,
  getLead,
  evidence,
  directory,
  manualTitle,
}: {
  host: { ctx: Context }
  page: { locator(selector: string): ApprovalCard }
  token: string
  memberName: string
  model: string
  getLead: () => Agent | undefined
  evidence: Record<string, unknown>
  directory: string
  manualTitle?: DevinManualApprovalContext | undefined
}) {
  const permissions: {
    sessionId: string
    agentSessionId: string
    requestId: string
    callId: string
    tool: string
    rawInputHash: string
    input: unknown
    options: unknown
    optionId: string
    scope: 'once'
    identity: 'devin-meta' | 'known-cli-manual'
    status: 'pending' | 'submitted' | 'allowed-once'
    decision?: unknown
    screenshot?: string
    effects: { callId: string; isError: boolean }[]
    deferredWait?: { leaseId: string; mcpRequestId: string; activityId?: string }
  }[] = []
  const admissions: {
    sessionId: string
    callId: string
    tool: string
    rawInputHash: string
    input: unknown
    isError?: boolean
    permissionRequestId?: string
  }[] = []
  const violations: string[] = []
  const permissionChecks: {
    requestId: string
    stage: string
    asked: unknown
    bridge?: unknown
    detailPresent: boolean
  }[] = []
  const nativeQuestions = host.ctx.get('userQuestions') as AcpNativeUserQuestionService
  // Two successive tasks can share a lead session. Verify only requests generated within this task.
  const previousRequests = new Set(acpPermissionAudit(host, 'asked').map((row) => row.data.requestId))
  const verifiedOwners = new Set<string>()
  const views = new Map<string, { request: Parameters<AcpNativeUserQuestionService['ask']>[0]; settled: boolean }>()
  const subjects = new Set<string>()
  let childReserved = false,
    messageReserved = false,
    taskOperations = 0
  const fail = (code: string): never => {
    violations.push(code)
    throw new Error(code)
  }
  const unclaimed = (entry: (typeof permissions)[number]) =>
    entry.deferredWait === undefined && !admissions.some((item) => item.permissionRequestId === entry.requestId)
  // The Host can execute before the next browser poll. Its authorization must already be durable at dispatch.
  const decidedOnce = (entry: (typeof permissions)[number]) => {
    const rows = acpPermissionAudit(host, 'decided').filter((row) => row.data.requestId === entry.requestId)
    const decision = rows[0]
    return (
      rows.length === 1 &&
      decision?.sessionId === entry.sessionId &&
      decision.data.agentSessionId === entry.agentSessionId &&
      decision.data.toolCallId === entry.callId &&
      decision.data.outcome === 'selected' &&
      decision.data.decisionVia === 'native-question' &&
      decision.data.selectedOptionKind === 'allow_once' &&
      decision.data.optionId === entry.optionId
    )
  }
  const diagnostics = required(host.ctx.get('acpLiveDiagnostics', false)) as LiveDiagnosticTrace
  if (diagnostics.enabled()) throw new Error('LIVE_TEAM_DIAGNOSTIC_OWNER_BUSY')
  const initialTraceFailures = diagnostics.failureCount()
  const secret = randomBytes(32).toString('hex')
  const id = (kind: string, value: unknown) => `h:${longTaskEffectFingerprint(secret, kind, value).slice(0, 24)}`
  const stopDiagnostics = diagnostics.install(
    Object.assign(
      (event: LiveDiagnosticEvent) => {
        // The bridge returns this exact result before Host dispatch when a peer message is queued.
        if (
          event.type !== 'mcp-handler/returned' ||
          event.tool !== 'wait_agent' ||
          event.hostCallId !== undefined ||
          event.resultStatus !== 'error' ||
          event.handlerIsError !== true ||
          event.inboxCountStatus !== 'available' ||
          event.inboxSnapshotStage !== 'before-host-call' ||
          (event.nextStepTeamMessageCount ?? 0) < 1 ||
          event.argsFingerprintComplete !== true ||
          !event.leaseId?.startsWith('h:') ||
          !event.mcpRequestId?.startsWith('h:')
        )
          return
        const matches = permissions.filter(
          (entry) =>
            entry.tool === 'wait_agent' &&
            unclaimed(entry) &&
            id('dsh-session', entry.sessionId) === event.sessionId &&
            id('mcp-tool-arguments', entry.input) === event.argsHmac &&
            decidedOnce(entry),
        )
        if (matches.length === 0) return
        if (matches.length !== 1) return fail('LIVE_TEAM_DEFERRED_WAIT_NOT_UNIQUE')
        required(matches[0]).deferredWait = { leaseId: event.leaseId, mcpRequestId: event.mcpRequestId }
      },
      {
        id,
        fingerprint: (kind: string, value: unknown) => ({
          hmac: id(kind, value),
          bytes: Buffer.byteLength(JSON.stringify(value)),
          complete: true,
        }),
      },
    ),
  )
  const roleOf = (agent: Agent): 'lead' | 'member' | undefined => {
    const lead = getLead()
    if (lead === undefined || host.ctx.agents.get(lead.id) !== lead || host.ctx.agents.get(agent.id) !== agent)
      return undefined
    if (agent.options.provider !== 'acp-devin' || host.ctx.subagents.rootOf(agent) !== lead) return undefined
    if (agent === lead) return 'lead'
    return agent.session.header.parentSession === lead.id &&
      host.ctx.subagents.namesOf(agent).self === memberName &&
      agent.options.model === model
      ? 'member'
      : undefined
  }
  const scopeFor = (agent: Agent): DevinTeamScope => {
    const role = roleOf(agent)
    if (role === undefined) return fail('LIVE_TEAM_PERMISSION_OWNER_OUT_OF_SCOPE')
    // The Host releases finished members. Retain this task's verified identity solely for its historical audit.
    verifiedOwners.add(agent.id)
    const lead = required(getLead())
    return {
      role,
      token,
      memberName,
      provider: 'acp-devin',
      model,
      tasks: host.ctx.agentTeams
        .listTasks(lead)
        .filter((task) => task.subject === `Compute ${token}` || task.subject === `Review ${token}`),
      childExists:
        childReserved ||
        host.ctx.agents
          .list()
          .some(
            (entry) =>
              entry.session.header.parentSession === lead.id && host.ctx.subagents.namesOf(entry).self === memberName,
          ),
      messageSent: messageReserved,
    }
  }
  const originalAsk = nativeQuestions.ask.bind(nativeQuestions)
  const observer = vi.spyOn(nativeQuestions, 'ask').mockImplementation((request) => {
    const view = { request, settled: false }
    for (const question of request.questions) views.set(question.id, view)
    return originalAsk(request).finally(() => {
      view.settled = true
    })
  })
  const disposeGuard = host.ctx.tools.guard((execution) => {
    const lead = getLead(),
      agent = execution.agent
    if (lead === undefined || agent === undefined || host.ctx.subagents.rootOf(agent) !== lead) return
    try {
      if (violations.length > 0) throw new Error(required(violations[0]))
      const scope = scopeFor(agent)
      const inputHash = summarizeRawInputForAudit(execution.arguments).hash
      const existing = admissions.find((entry) => entry.sessionId === agent.id && entry.callId === execution.callId)
      if (existing !== undefined) {
        if (existing.tool !== execution.name || existing.rawInputHash !== inputHash)
          return fail('LIVE_TEAM_REUSED_CALL_ID_CHANGED')
        return
      }
      if (!permitsDevinTeamTool(execution.name, execution.arguments, scope)) return fail('LIVE_TEAM_TOOL_OUT_OF_SCOPE')
      if (admissions.length >= 32 || (execution.name.startsWith('team_task_') && ++taskOperations > 24))
        return fail('LIVE_TEAM_TOOL_BUDGET_EXCEEDED')
      if (execution.name === 'team_task_create') {
        const subject = (execution.arguments as { subject: string }).subject
        if (subjects.has(subject)) return fail('LIVE_TEAM_DUPLICATE_TASK')
        subjects.add(subject)
      }
      if (execution.name === 'subagent') childReserved = true
      if (execution.name === 'send_message') messageReserved = true
      const matches = permissions.filter(
        (entry) =>
          entry.sessionId === agent.id &&
          entry.tool === execution.name &&
          entry.rawInputHash === inputHash &&
          unclaimed(entry) &&
          decidedOnce(entry),
      )
      if (matches.length > 1) return fail('LIVE_TEAM_ADMISSION_PERMISSION_AMBIGUOUS')
      admissions.push({
        sessionId: agent.id,
        callId: execution.callId,
        tool: execution.name,
        rawInputHash: inputHash,
        input: execution.arguments,
        ...(matches[0] === undefined ? {} : { permissionRequestId: matches[0].requestId }),
      })
    } catch {
      if (violations.length === 0) violations.push('LIVE_TEAM_FIXTURE_SCOPE_REJECTED')
      return {
        reason: 'Live Teams fixture scope rejected this call',
        info: {
          name: 'LiveTeamFixtureError',
          code: required(violations[0]),
        },
      }
    }
  })
  const disposeResults = host.ctx.on('tools/result', (execution, result) => {
    const admission = admissions.find(
      (entry) => entry.sessionId === execution.agent?.id && entry.callId === execution.callId,
    )
    if (admission === undefined) return
    admission.isError = result.isError
    const permission = permissions.find((entry) => entry.requestId === admission.permissionRequestId)
    permission?.effects.push({ callId: admission.callId, isError: result.isError })
  })
  Object.assign(evidence, {
    devinPermissions: permissions,
    devinToolAdmissions: admissions,
    devinScopeViolations: violations,
    devinPermissionChecks: permissionChecks,
  })

  const answerPending = async () => {
    if (violations.length > 0) throw new Error(required(violations[0]))
    const lead = getLead()
    if (lead === undefined) return
    const activeViews = [...views.entries()].filter(([, view]) => !view.settled && view.request.agent === lead)
    if (activeViews.length === 0 && permissions.length === 0) return
    const asked = acpPermissionAudit(host, 'asked')
    const checked = acpPermissionAudit(host, 'bridge')
    const decided = acpPermissionAudit(host, 'decided')
    for (const entry of permissions.filter((entry) => entry.status !== 'allowed-once')) {
      const rows = decided.filter((row) => row.data.requestId === entry.requestId)
      if (rows.length === 0) continue
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        sessionId: entry.sessionId,
        data: {
          agentSessionId: entry.agentSessionId,
          toolCallId: entry.callId,
          outcome: 'selected',
          selectedOptionKind: 'allow_once',
          optionId: entry.optionId,
          decisionVia: 'native-question',
        },
      })
      entry.decision = rows[0]
      entry.status = 'allowed-once'
    }
    for (const [questionId, view] of activeViews) {
      if (!questionId.startsWith('acp-permission:')) return fail('LIVE_TEAM_UNEXPECTED_NATIVE_QUESTION')
      const requestId = questionId.slice('acp-permission:'.length)
      const pending = permissions.find((entry) => entry.requestId === requestId)
      if (pending !== undefined && pending.status !== 'pending') continue
      if (pending === undefined && permissions.length >= 24) return fail('LIVE_TEAM_PERMISSION_BUDGET_EXCEEDED')
      if (view.request.signal?.aborted) continue
      const rows = asked.filter((row) => row.data.requestId === requestId)
      const check = permissionChecks.find((entry) => entry.requestId === requestId) ?? {
        requestId,
        stage: 'asked',
        asked: rows,
        detailPresent: view.request.questions[0]?.detail !== undefined,
      }
      if (!permissionChecks.includes(check)) permissionChecks.push(check)
      expect(rows).toHaveLength(1)
      const row = required(rows[0])
      const owner = required(host.ctx.agents.list().find((agent) => agent.id === row.sessionId))
      const scope = scopeFor(owner)
      check.stage = 'bridge-identity'
      const bridges = checked.filter(
        (item) =>
          item.sessionId === row.sessionId &&
          item.data.agentSessionId === row.data.agentSessionId &&
          item.data.toolCallId === row.data.toolCall.toolCallId,
      )
      check.bridge = bridges
      expect(bridges).toHaveLength(1)
      const bridge = required(bridges[0]).data
      let identity: 'devin-meta' | 'known-cli-manual'
      if (
        bridge.reason === 'approval-required' &&
        bridge.structuredIdentityPresent === true &&
        bridge.identitySource === 'devin-meta'
      )
        identity = 'devin-meta'
      else {
        if (manualTitle === undefined || !isKnownDevinManualTitleRequest(manualTitle.cliVersion, row.data, bridge))
          return fail('LIVE_TEAM_MANUAL_PERMISSION_IDENTITY_UNPROVEN')
        check.stage = 'isolated-session-mcp'
        await manualTitle.assertIsolatedSessionMcp(required(owner.session.header.cwd))
        identity = 'known-cli-manual'
      }
      const tool = required(bridge.toolName)
      check.stage = 'native-question-identity'
      expect(view.request.questions).toHaveLength(1)
      const question = required(view.request.questions[0])
      expect(question.id).toBe(questionId)
      check.stage = 'original-input-hash'
      const input = intactPermissionInput(
        row.data.toolCall.rawInputSummary,
        row.data.toolCall.rawInputHash,
        question.detail,
      )
      check.stage = 'tool-scope'
      if (!permitsDevinTeamTool(tool, input, scope)) return fail('LIVE_TEAM_PERMISSION_TOOL_OUT_OF_SCOPE')
      expect(row.data.optionCount).toBe(row.data.options.length)
      expect(row.data.omittedOptionCount ?? 0).toBe(0)
      const option = exactOnceOption(row.data.options)
      check.stage = 'native-options'
      expect(question.options?.map((item) => item.label)).toEqual(row.data.options.map((item) => item.name))
      check.stage = 'native-ui'
      // The native composer can replace its foreground card between awaits.
      // Snapshot once, then pin all actions to that DOM identity, never to the
      // next question that happens to have the same Allow/Submit buttons.
      let candidate = page
        .locator('[data-question-key]')
        .filter({ visible: true })
        .filter({ hasText: question.question })
      if (question.header !== undefined) candidate = candidate.filter({ hasText: question.header })
      const cards = await candidate.evaluateAll((elements) =>
        elements.map((element) => ({
          key: element.getAttribute('data-question-key'),
          labels: Array.from(element.querySelectorAll('[role="radio"]')).map((radio) =>
            radio.getAttribute('aria-label'),
          ),
        })),
      )
      if (cards.length === 0 || view.settled || view.request.signal?.aborted) continue
      expect(cards).toHaveLength(1)
      const snapshot = required(cards[0])
      expect(snapshot.labels).toEqual(row.data.options.map((choice) => choice.name))
      const key = required(snapshot.key)
      const card = page.locator(`[data-question-key=${JSON.stringify(key)}]`).filter({ visible: true })
      const stillOwned = () =>
        views.get(questionId) === view &&
        !view.settled &&
        !view.request.signal?.aborted &&
        permitsDevinTeamTool(tool, input, scopeFor(owner))
      let entry = pending
      try {
        const screenshot = join(
          directory,
          `${token}-permission-${permissions.length + (pending === undefined ? 1 : 0)}.png`,
        )
        if (entry === undefined) await card.screenshot({ path: screenshot, timeout: 1_000 })
        if (!stillOwned()) return fail('LIVE_TEAM_PERMISSION_CHANGED_BEFORE_DECISION')
        if (entry === undefined) {
          entry = {
            sessionId: row.sessionId,
            agentSessionId: row.data.agentSessionId,
            requestId,
            callId: row.data.toolCall.toolCallId,
            tool,
            rawInputHash: required(row.data.toolCall.rawInputHash),
            input,
            options: row.data.options,
            optionId: option.optionId,
            scope: 'once',
            identity,
            status: 'pending',
            effects: [],
            screenshot,
          }
          permissions.push(entry)
        }
        await card.getByRole('radio', { name: option.name, exact: true }).click({ timeout: 1_000 })
        if (!stillOwned()) return fail('LIVE_TEAM_PERMISSION_CHANGED_BEFORE_DECISION')
        await card.getByRole('button', { name: /^(Submit|Send)$/ }).click({ timeout: 1_000 })
      } catch (error) {
        // A different pending question can take the foreground. Leave this one
        // pending and let the outer poll answer the visible request; do not
        // retry a UI action on a replacement card or suppress other failures.
        if (error instanceof Error && error.name === 'TimeoutError' && (await card.count()) === 0) continue
        throw error
      }
      entry.status = 'submitted'
      check.stage = 'submitted'
    }
  }
  return {
    answerPending,
    reviewedCalls(sessionId: string) {
      return permissions
        .filter((entry) => entry.sessionId === sessionId && entry.status === 'allowed-once')
        .map(({ callId, tool }) => ({ callId, tool }))
    },
    async assertComplete() {
      expect(violations).toEqual([])
      expect(diagnostics.failureCount()).toBe(initialTraceFailures)
      const lead = required(getLead())
      const answeredIds = permissions.map((entry) => entry.requestId).sort()
      const presentedIds = [...views]
        .filter(([, view]) => view.request.agent === lead)
        .map(([questionId]) => questionId.slice('acp-permission:'.length))
        .sort()
      expect(presentedIds).toEqual(answeredIds)
      const asked = acpPermissionAudit(host, 'asked').filter(
        (row) =>
          (row.sessionId === lead.id || verifiedOwners.has(row.sessionId)) && !previousRequests.has(row.data.requestId),
      )
      expect(asked.map((row) => row.data.requestId).sort()).toEqual(answeredIds)
      expect(
        permissions.some((entry) => entry.effects.some((effect) => !effect.isError)),
        'A real native Ask must authorize a successful Host call',
      ).toBe(true)
      for (const entry of permissions) {
        expect(entry.status).toBe('allowed-once')
        expect(entry.scope).toBe('once')
        if (entry.deferredWait !== undefined) {
          expect(entry.effects).toHaveLength(0)
          const service = host.ctx.get('dshAcp') as AcpRemoteService
          const snapshot = await service.activitySnapshot(entry.sessionId, { limit: 100 })
          const rows = snapshot.activities.filter(
            (row) =>
              row.ownerDshSessionId === entry.sessionId &&
              row.dshSessionId === entry.sessionId &&
              row.kind === 'tool' &&
              row.activityId.endsWith(`:tool:${entry.callId}`),
          )
          expect(rows).toHaveLength(1)
          const activity = await service.activityDetail(entry.sessionId, required(rows[0]))
          expect(activity.status).toBe('failed')
          const detail = JSON.parse(required(activity.rawDetail)) as { toolName?: unknown; rawInput?: unknown }
          expect(detail.toolName).toBe('wait_agent')
          expect(detail.rawInput).toEqual(entry.input)
          entry.deferredWait.activityId = activity.activityId
          continue
        }
        expect(entry.effects).toHaveLength(1)
        expect(entry.effects[0]?.isError).toBe(false)
      }
    },
    dispose() {
      observer.mockRestore()
      disposeGuard()
      disposeResults()
      void stopDiagnostics()
    },
  }
}
