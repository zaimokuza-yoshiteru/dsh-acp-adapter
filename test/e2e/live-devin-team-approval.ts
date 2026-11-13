import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import type { AcpNativeUserQuestionService } from '../../src/domain/policy/elicitation.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
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
  getByRole(role: 'radio' | 'button', options?: { name?: string | RegExp; exact?: boolean }): ApprovalCard
  waitFor(): Promise<void>
  click(): Promise<void>
  screenshot(options: { path: string }): Promise<unknown>
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
  }[] = []
  const admissions: {
    sessionId: string
    callId: string
    tool: string
    rawInputHash: string
    input: unknown
    isError?: boolean
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
  const views = new Map<string, { request: Parameters<AcpNativeUserQuestionService['ask']>[0]; settled: boolean }>()
  const subjects = new Set<string>()
  let childReserved = false,
    messageReserved = false,
    taskOperations = 0
  const fail = (code: string): never => {
    violations.push(code)
    throw new Error(code)
  }
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
      admissions.push({
        sessionId: agent.id,
        callId: execution.callId,
        tool: execution.name,
        rawInputHash: inputHash,
        input: execution.arguments,
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
    const permission = permissions.find(
      (entry) =>
        entry.sessionId === admission.sessionId &&
        entry.tool === admission.tool &&
        entry.rawInputHash === admission.rawInputHash &&
        entry.effects.length === 0,
    )
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
    for (const entry of permissions.filter((entry) => entry.status === 'submitted')) {
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
      if (permissions.some((entry) => entry.requestId === requestId)) continue
      if (permissions.length >= 24) return fail('LIVE_TEAM_PERMISSION_BUDGET_EXCEEDED')
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
      let card = page.locator('[data-question-key]').filter({ visible: true }).filter({ hasText: question.question })
      if (question.header !== undefined) card = card.filter({ hasText: question.header })
      if ((await card.count()) === 0) continue
      expect(await card.count()).toBe(1)
      expect(await card.getByRole('radio').count()).toBe(row.data.options.length)
      for (const choice of row.data.options) await card.getByRole('radio', { name: choice.name, exact: true }).waitFor()
      const entry: (typeof permissions)[number] = {
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
      }
      permissions.push(entry)
      entry.screenshot = join(directory, `${token}-permission-${permissions.length}.png`)
      await card.screenshot({ path: entry.screenshot })
      // Recheck ownership, cancellation and current task facts immediately before the one-shot UI decision.
      if (view.request.signal?.aborted || !permitsDevinTeamTool(tool, input, scopeFor(owner)))
        return fail('LIVE_TEAM_PERMISSION_CHANGED_BEFORE_DECISION')
      await card.getByRole('radio', { name: option.name, exact: true }).click()
      await card.getByRole('button', { name: /^(Submit|Send)$/ }).click()
      entry.status = 'submitted'
      check.stage = 'submitted'
    }
  }
  return {
    answerPending,
    assertComplete() {
      expect(violations).toEqual([])
      for (const entry of permissions) {
        expect(entry.status).toBe('allowed-once')
        expect(entry.scope).toBe('once')
        expect(entry.effects).toHaveLength(1)
        expect(entry.effects[0]?.isError).toBe(false)
      }
    },
    dispose() {
      observer.mockRestore()
      disposeGuard()
      disposeResults()
    },
  }
}
