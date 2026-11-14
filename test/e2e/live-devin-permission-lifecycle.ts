import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { Locator, Page } from 'playwright'
import { expect, vi } from 'vitest'
import { writeComposerDraft } from '#host-support'
import type { AdapterWorld } from './scaffold.ts'
import type { DevinLiveFixtureContext } from './live-devin-environment.ts'
import type { AcpNativeUserQuestionService } from '../../src/domain/policy/elicitation.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTrace } from '../../src/contract/live-diagnostic-trace.ts'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'
import { DevinLiveTrace } from '../../scripts/devin-live-trace.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { openNativeMemberAside } from './native-team-ui.ts'
import { required } from './required.ts'
import { assertDevinDiscovery, captureDevinDiscovery, type ReviewedDevinCall } from './live-devin-discovery.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import {
  assertDevinMarkerDecision,
  validateDevinMarkerPermission,
  type MarkerWrite,
} from './live-devin-permission-lifecycle-scope.ts'

/** A fixture-created real child exercises its own ACP permissions; no native sandbox policy is rewritten. */
export async function verifyLiveDevinPermissionLifecycle({
  host,
  page,
  provider,
  model,
  evidence,
  context,
}: {
  host: AdapterWorld
  page: Page
  provider: string
  model: string
  evidence: Record<string, unknown> & { directory: string }
  context: DevinLiveFixtureContext
}) {
  if (provider !== 'acp-devin' || model.trim() === '') throw new Error('LIVE_DEVIN_PERMISSION_EXPLICIT_ROUTE_REQUIRED')
  const token = `PERMISSION_${randomUUID().slice(0, 8)}`
  const memberName = `permission-${token.slice(-8)}`
  mkdirSync(evidence.directory, { recursive: true })
  const phases = (['allow', 'reject', 'stop'] as const).map((kind) => ({
    kind,
    expected: { file_path: join(host.workspaceCwd, `${token}-${kind}.txt`), content: `${token}_${kind}` },
    requestId: undefined as string | undefined,
    admissions: [] as { callId: string; isError?: boolean }[],
  }))
  const violations: string[] = []
  const turns: { sessionId: string; turn: number; reason: string }[] = []
  const prompts: Extract<LiveDiagnosticEvent, { type: 'adapter-prompt/start' | 'adapter-prompt/end' }>[] = []
  const results: Record<string, unknown>[] = []
  const reviewed: ReviewedDevinCall[] = []
  const captureDiscovery = async () => {
    const discovery = await captureDevinDiscovery(
      host.ctx.get('dshAcp') as AcpRemoteService,
      required(childId),
      context.tempDirectory,
      reviewed,
    )
    evidence.discovery = discovery
    return discovery
  }
  const diagnostics = required(host.ctx.get('acpLiveDiagnostics', false)) as LiveDiagnosticTrace
  if (diagnostics.enabled()) throw new Error('LIVE_DEVIN_PERMISSION_DIAGNOSTIC_OWNER_BUSY')
  const trace = new DevinLiveTrace({ directory: evidence.directory })
  const initialTraceFailures = diagnostics.failureCount()
  const stopTrace = diagnostics.install(
    Object.assign(
      (event: LiveDiagnosticEvent) => {
        if (event.type === 'adapter-prompt/start' || event.type === 'adapter-prompt/end') prompts.push(event)
        trace.record(event.type, { ...event })
      },
      { id: trace.id.bind(trace), fingerprint: trace.fingerprint.bind(trace) },
    ),
  )
  const native = required(host.ctx.get('userQuestions')) as AcpNativeUserQuestionService
  type Question = Parameters<AcpNativeUserQuestionService['ask']>[0]
  const questions = new Map<string, { request: Question; settled: boolean }>()
  const ask = native.ask.bind(native)
  const observer = vi.spyOn(native, 'ask').mockImplementation((request) => {
    const view = { request, settled: false }
    for (const question of request.questions) questions.set(question.id, view)
    return ask(request).finally(() => {
      view.settled = true
    })
  })
  let lead: Agent | undefined
  let childId: SessionId | undefined
  let activation: SubagentActivation | undefined
  let phase: (typeof phases)[number] | undefined
  let passed = false
  let originalAcpSession: string | undefined
  const fail = (code: string): never => {
    violations.push(code)
    throw new Error(code)
  }
  const healthy = () => {
    if (violations.length > 0) throw new Error(required(violations[0]))
    if (trace.writeFailed || diagnostics.failureCount() !== initialTraceFailures)
      fail('LIVE_DEVIN_PERMISSION_TRACE_FAILED')
  }
  const stopEvents = host.ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end')
      turns.push({ sessionId: session.id, turn: event.data.turn, reason: event.data.reason.kind })
  })
  const stopCreated = host.ctx.on('subagent/start', (entry) => {
    const child = host.ctx.agents.get(entry.id)
    if (
      lead === undefined ||
      child === undefined ||
      entry.parentSessionId !== lead.id ||
      host.ctx.subagents.namesOf(child).self !== memberName
    )
      return
    if (childId !== undefined && childId !== child.id) fail('LIVE_DEVIN_PERMISSION_CHILD_REPLACED')
    childId = child.id
  })
  const stopGuard = host.ctx.tools.guard((execution) => {
    if (childId === undefined || execution.agent?.id !== childId) return
    const exact =
      phase !== undefined &&
      execution.name === 'write' &&
      summarizeRawInputForAudit(execution.arguments).hash === summarizeRawInputForAudit(phase.expected).hash
    const decision = acpPermissionAudit(host, 'decided').findLast(
      (row) => row.sessionId === childId && row.data.requestId === phase?.requestId,
    )?.data
    if (
      host.ctx.agents.get(childId) !== execution.agent ||
      host.ctx.subagents.rootOf(execution.agent) !== lead ||
      !exact ||
      phase?.kind !== 'allow' ||
      decision?.outcome !== 'selected' ||
      decision.selectedOptionKind !== 'allow_once'
    ) {
      violations.push('LIVE_DEVIN_PERMISSION_UNAUTHORIZED_TOOL_ADMISSION')
      return {
        reason: 'Only the exact once-approved fixture write may execute',
        info: { name: 'LiveDevinPermissionFixtureError', code: 'LIVE_DEVIN_PERMISSION_UNAUTHORIZED_TOOL_ADMISSION' },
      }
    }
    if (phase.admissions.some((entry) => entry.callId === execution.callId)) return undefined
    if (phase.admissions.length !== 0) {
      violations.push('LIVE_DEVIN_PERMISSION_DUPLICATE_WRITE')
      return {
        reason: 'The fixture permits one write, not a second tool call',
        info: { name: 'LiveDevinPermissionFixtureError', code: 'LIVE_DEVIN_PERMISSION_DUPLICATE_WRITE' },
      }
    }
    phase.admissions.push({ callId: execution.callId })
    return undefined
  })
  const stopResults = host.ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.id !== childId) return
    const admission = phases.flatMap((entry) => entry.admissions).find((entry) => entry.callId === execution.callId)
    if (admission !== undefined) admission.isError = result.isError
  })
  Object.assign(evidence, {
    token,
    provider,
    model,
    memberName,
    results,
    violations,
    prompts,
    turns,
    childCreation: 'fixture-controlled-native-startActivation',
    permissionRoute: 'real-Devin-ACP-original-options-via-native-question',
    toolSchemaInjection: false,
    stopScope: 'pending-ACP-permission-via-native-child-Stop; no running-shell claim',
    traceFile: trace.filePath,
  })
  const send = async (scope: Locator, text: string) => {
    const input = scope.locator('[data-composer-input][contenteditable=true]').first()
    await writeComposerDraft(page, input, text)
    await expect.poll(() => input.innerText()).toBe(text)
    await scope.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const writePrompt = (expected: MarkerWrite) =>
    `Please use DSH to create the file ${expected.file_path} in this empty workspace. Write exactly ${expected.content}, with no trailing newline. Normal read-only tool discovery is allowed. Do not use shell tools, read other workspace files or delegate this task. Request my approval for this one write. If I reject or stop it, leave the file absent and finish without retrying. After success, reply with ${expected.content}.`
  const childPane = () =>
    page.locator('[data-sidebar-chat]').filter({
      has: page.locator(`[data-conversation-session="${String(childId)}"]`),
    })
  const currentChild = () => {
    const child = required(host.ctx.agents.get(required(childId)))
    expect(host.ctx.subagents.rootOf(child)).toBe(lead)
    expect(child.session.header.parentSession).toBe(lead?.id)
    expect(child.session.requestHeader()?.config ?? child.options).toMatchObject({ provider, model })
    return child
  }
  const waitForEnd = async (after: number) => {
    await expect
      .poll(
        () => {
          healthy()
          return turns.slice(after).find((entry) => entry.sessionId === childId)
        },
        { timeout: 120_000 },
      )
      .toBeDefined()
    healthy()
    return required(turns.slice(after).find((entry) => entry.sessionId === childId))
  }
  try {
    const ready = `${token}_ROOT_READY`
    const settled = host.whenTurnSettled(90_000)
    void settled.catch(() => undefined)
    await send(page.locator('body'), `Reply only ${ready}. Do not use tools.`)
    lead = required(host.ctx.agents.get(await settled))
    expect(host.ctx.subagents.rootOf(lead)).toBe(lead)
    expect(lead.session.requestHeader()?.config).toMatchObject({ provider, model })
    evidence.leadId = lead.id
    const rootUrl = page.url()
    for (const entry of phases) expect(existsSync(entry.expected.file_path)).toBe(false)
    phase = phases[0]
    let phaseTurnStart = turns.length
    activation = await host.ctx.subagents.startActivation({
      parent: lead,
      provider: 'spawn',
      name: memberName,
      label: 'Devin permission lifecycle',
      delivery: 'caller',
      agentOptions: { provider, model },
      prompt: [{ type: 'text', text: writePrompt(phase.expected) }],
      signal: new AbortController().signal,
    })
    void activation.result.catch(() => undefined)
    expect(activation.childId).toBe(childId)
    evidence.childId = childId
    for (let index = 0; index < phases.length; index++) {
      phase = phases[index]!
      if (index > 0) {
        phaseTurnStart = turns.length
        await send(childPane(), writePrompt(phase.expected))
      }
      const currentPhase = phase
      let state = 'waiting'
      await expect
        .poll(
          () => {
            healthy()
            const rows = acpPermissionAudit(host, 'asked').filter((row) => row.sessionId === childId)
            if (rows.length > index + 1) return (state = 'too-many-requests')
            const asked = rows[index]
            if (asked !== undefined && questions.get(`acp-permission:${asked.data.requestId}`)?.settled === false)
              return (state = 'pending')
            if (turns.slice(phaseTurnStart).some((entry) => entry.sessionId === childId))
              return (state = 'ended-without-permission')
            return (state = 'waiting')
          },
          { timeout: 120_000 },
        )
        .not.toBe('waiting')
      healthy()
      expect(state).toBe('pending')
      const child = currentChild()
      const asked = required(acpPermissionAudit(host, 'asked').filter((row) => row.sessionId === childId)[index]).data
      phase.requestId = asked.requestId
      originalAcpSession ??= asked.agentSessionId
      expect(asked.agentSessionId).toBe(originalAcpSession)
      const view = required(questions.get(`acp-permission:${asked.requestId}`))
      expect(view.request.agent).toBe(lead)
      expect(view.request.questions).toHaveLength(1)
      const question = required(view.request.questions[0])
      const bridges = acpPermissionAudit(host, 'bridge').filter(
        (row) =>
          row.sessionId === childId &&
          row.data.agentSessionId === asked.agentSessionId &&
          row.data.toolCallId === asked.toolCall.toolCallId,
      )
      expect(bridges).toHaveLength(1)
      const validated = validateDevinMarkerPermission({
        asked,
        bridge: required(bridges[0]).data,
        detail: question.detail,
        expected: phase.expected,
        cliVersion: context.cliVersion,
      })
      await context.assertIsolatedSessionMcp(required(child.session.header.cwd))
      expect(question.options?.map((item) => item.label)).toEqual(asked.options.map((item) => item.name))
      const card = page.locator('[data-question-key]:visible').filter({ hasText: question.question })
      await card.waitFor()
      expect(await card.count()).toBe(1)
      expect(await card.getByRole('radio').count()).toBe(asked.options.length)
      for (const option of asked.options) await card.getByRole('radio', { name: option.name, exact: true }).waitFor()
      expect(existsSync(phase.expected.file_path)).toBe(false)
      expect(phase.admissions).toEqual([])
      expect(view.request.signal?.aborted).not.toBe(true)
      await card.screenshot({ path: join(evidence.directory, `${token}-${phase.kind}-pending.png`) })
      const row: Record<string, unknown> = {
        phase: phase.kind,
        asked,
        identity: validated.identity,
        admissions: phase.admissions,
      }
      results.push(row)
      const standingApproval = host.ctx.approval.overrideOf(child.session)
      const standingSandbox = host.ctx.sandboxPolicy.resolve({ session: child.session }).mode
      const assertPending = () => {
        healthy()
        expect(currentChild()).toBe(child)
        expect(view.settled).toBe(false)
        expect(view.request.signal?.aborted).not.toBe(true)
        expect(existsSync(currentPhase.expected.file_path)).toBe(false)
        expect(currentPhase.admissions).toEqual([])
      }
      assertPending()
      if (phase.kind === 'stop') {
        await openNativeMemberAside(page, memberName)
        assertPending()
        await childPane().getByRole('button', { name: 'Stop generating', exact: true }).click()
        row.stopRoute = 'native-child-composer/subagents.interruptByUser'
      } else {
        const option = phase.kind === 'allow' ? validated.allow : validated.reject
        await card.getByRole('radio', { name: option.name, exact: true }).click()
        assertPending()
        await card.getByRole('button', { name: /^(Submit|Send)$/ }).click()
      }
      await expect
        .poll(
          () => acpPermissionAudit(host, 'decided').filter((item) => item.data.requestId === asked.requestId).length,
          { timeout: 30_000 },
        )
        .toBe(1)
      const decision = required(
        acpPermissionAudit(host, 'decided').find((item) => item.data.requestId === asked.requestId),
      )
      expect(decision.sessionId).toBe(childId)
      assertDevinMarkerDecision(asked, decision.data, phase.kind)
      expect(decision.data.presentation).toEqual({ rootSessionId: lead.id, path: [childId] })
      reviewed.push({ callId: asked.toolCall.toolCallId, tool: 'write' })
      row.decision = decision.data
      row.turn = await waitForEnd(phaseTurnStart)
      expect(host.ctx.approval.overrideOf(child.session)).toBe(standingApproval)
      expect(host.ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe(standingSandbox)
      if (phase.kind === 'allow') {
        expect((row.turn as { reason: string }).reason).toBe('completed')
        expect(readFileSync(phase.expected.file_path, 'utf8')).toBe(phase.expected.content)
        expect(phase.admissions).toEqual([{ callId: expect.any(String), isError: false }])
        await activation.result
      } else {
        expect(existsSync(phase.expected.file_path)).toBe(false)
        expect(phase.admissions).toEqual([])
        if (phase.kind === 'stop') {
          expect((row.turn as { reason: string }).reason).toBe('aborted')
          expect(view.request.signal?.aborted).toBe(true)
          const stopped = prompts.findLast(
            (item) => item.type === 'adapter-prompt/end' && item.sessionId === trace.id('dsh-session', childId),
          )
          expect(stopped?.stopReason === 'cancelled' || stopped?.errorCode === 'ACP_ABORTED').toBe(true)
          row.acpCancellation = stopped
        } else expect((row.turn as { reason: string }).reason).toBe('completed')
      }
      await card.waitFor({ state: 'hidden' })
      expect(page.url()).toBe(rootUrl)
      await openNativeMemberAside(page, memberName)
      await childPane().locator('[data-composer-input][contenteditable=true]').waitFor()
      await page.screenshot({
        path: join(evidence.directory, `${token}-${currentPhase.kind}-settled.png`),
        fullPage: true,
      })
    }
    phase = undefined
    const resumeTurnStart = turns.length
    const promptStart = prompts.length
    const resumeMarker = `${token}_RESUMED`
    await send(
      childPane(),
      `The previous operation was cancelled. Do not retry any file operation or use tools. Reply only ${resumeMarker}.`,
    )
    expect((await waitForEnd(resumeTurnStart)).reason).toBe('completed')
    await childPane().getByText(resumeMarker, { exact: true }).waitFor()
    const resumed = prompts.slice(promptStart).filter((item) => item.sessionId === trace.id('dsh-session', childId))
    expect(resumed.filter((item) => item.type === 'adapter-prompt/start')).toHaveLength(1)
    expect(resumed.every((item) => item.acpSessionId === trace.id('acp-session', originalAcpSession))).toBe(true)
    expect(resumed.some((item) => item.type === 'adapter-prompt/end' && item.stopReason === 'end_turn')).toBe(true)
    expect(acpPermissionAudit(host, 'asked').filter((row) => row.sessionId === childId)).toHaveLength(3)
    expect(acpPermissionAudit(host, 'decided').filter((row) => row.sessionId === childId)).toHaveLength(3)
    for (const entry of phases.slice(1)) expect(existsSync(entry.expected.file_path)).toBe(false)
    expect(await page.locator('[data-question-key]:visible, [data-acp-team-approvals]').count()).toBe(0)
    await page.reload()
    await openNativeMemberAside(page, memberName)
    await childPane().getByText(resumeMarker, { exact: true }).waitFor()
    expect(await page.locator('[data-question-key]:visible, [data-acp-team-approvals]').count()).toBe(0)
    healthy()
    assertDevinDiscovery(await captureDiscovery())
    Object.assign(evidence, { status: 'passed', sameDurableChild: true, sameAcpSession: true, resumed, phases })
    passed = true
  } catch (error) {
    if (childId !== undefined && evidence.discovery === undefined) {
      try {
        await captureDiscovery()
      } catch {
        evidence.discoveryCaptureError = 'Activity evidence unavailable'
      }
    }
    throw error
  } finally {
    try {
      if (childId !== undefined) {
        const child = host.ctx.agents.get(childId)
        host.ctx.subagents.interrupt(childId, { kind: 'user' })
        await child?.whenIdle()
      }
      await activation?.dispose()
    } finally {
      stopResults()
      stopGuard()
      stopCreated()
      stopEvents()
      observer.mockRestore()
      await stopTrace()
      trace.finish(passed ? 'pass' : 'fail', {})
      if (!passed) Object.assign(evidence, { status: 'failed', phases })
    }
  }
}
