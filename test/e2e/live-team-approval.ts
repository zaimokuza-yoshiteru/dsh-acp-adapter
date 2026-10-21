import { required } from './required.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { Page } from 'playwright'
import type { ObservedEvent } from './types.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { writeComposerDraft } from '#host-support'
import { installLiveTeamApprovalPolicy } from './live-team-approval-policy.ts'

/** A fresh real member must reach the native approval before its first file side effect. */
export async function verifyLiveTeamApproval({
  host,
  page,
  provider,
  evidence,
}: {
  host: AdapterWorld
  page: Page
  provider: string
  evidence: Record<string, unknown> & { directory: string }
}) {
  const token = `APPROVAL_${randomUUID().slice(0, 8)}`
  const fileName = `${token}.txt`
  const lead = required(
    host.ctx.agents
      .list()
      .find(
        (agent) => agent.options.provider === provider && host.ctx.agentTeams.tryMembership(agent)?.role === 'lead',
      ),
  )
  const destination = join(required(lead.session.header.cwd), fileName)
  const command = `printf '${token}' > ${fileName}`
  const baselineModes = new Map(
    host.ctx.agents.list().map((agent) => [agent, host.ctx.sandboxPolicy.resolve({ session: agent.session }).mode]),
  )
  const policy = installLiveTeamApprovalPolicy(host.ctx, { lead, memberName: 'permission-review', command, token })
  const events: ObservedEvent[] = []
  const commandResults: { sessionId: string; callId: string; isError: boolean }[] = []
  let absentWhenAsked = false
  let absentWhenDecided = false
  let sandboxWhenAsked: string | undefined
  let sandboxWhenDecided: string | undefined
  let sandboxAtCommandResult: string | undefined
  const disposeEvents = host.ctx.on('session/event', (session, event) => {
    if (['approval/asked', 'approval/decided', 'approval/policy', 'sandbox/mode', 'turn/end'].includes(event.type))
      events.push({ sessionId: session.id, ...event })
    if (session === policy.member?.session && event.type === 'approval/asked') {
      absentWhenAsked = !existsSync(destination)
      sandboxWhenAsked = host.ctx.sandboxPolicy.resolve({ session }).mode
    }
    if (session === policy.member?.session && event.type === 'approval/decided') {
      absentWhenDecided = !existsSync(destination)
      sandboxWhenDecided = host.ctx.sandboxPolicy.resolve({ session }).mode
    }
  })
  const disposeResults = host.ctx.on('tools/result', (execution, result) => {
    if (execution.agent === undefined || execution.agent !== policy.member || execution.name !== 'bash') return
    commandResults.push({ sessionId: execution.agent.id, callId: execution.callId, isError: result.isError })
    sandboxAtCommandResult = host.ctx.sandboxPolicy.resolve({ session: execution.agent.session }).mode
  })
  Object.assign(evidence, {
    token,
    events,
    commandResults,
    violations: policy.violations,
    approvalRoute: 'native-dsh-bash-sandbox-escalation',
    fixtureSandbox: 'read-only-at-exact-tool-admission',
    fixtureNativeApproval: 'explicit-test-only-ask-at-exact-tool-admission',
    requestedSandbox: 'danger-full-access',
  })
  let completed = false
  let phase: 'waiting' | 'pending' | 'invalid-fixture-call' | 'ended-without-approval' = 'waiting'
  try {
    // verifyLiveTeam leaves the native team panel open.
    await page
      .locator('[data-team-action]')
      .getByRole('button', { name: /Agent Team/ })
      .click()
    const prompt = `This is an authorized approval regression in this empty temporary workspace. Use the DSH Teams MCP spawn_teammate tool to create exactly one fresh member named permission-review. This test explicitly switches only its exact marker tool call to native Ask approval and a read-only DSH file policy at admission; other delegated calls keep their native policy. Tell it to call the DSH MCP bash tool exactly once with command ${JSON.stringify(command)}, description "Write the isolated approval marker", sandbox_permissions "danger-full-access", justification "Allow the single temporary workspace marker ${token}", and no workdir or background execution. This is a one-shot native sandbox escalation: wait for the human approval before execution. Do not use the Agent's private shell, another tool, an editing API, or a command without these escalation arguments. The command writes only the unique temporary workspace file ${fileName}. After successful execution send the lead ${token} using DSH send_message, then finish. Do not execute the command yourself or create any other members. End your response after creating the member so the human can handle its approval.`
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const card = page.locator('[data-acp-team-approvals]')
    const pendingButton = card.getByRole('button', { name: 'permission-review · Pending request', exact: true })
    // A completed member with no request is a failed precondition, not a reason
    // to wait another two minutes for a card the native policy never produced.
    await expect
      .poll(
        async () => {
          if (await pendingButton.isVisible()) return (phase = 'pending')
          if (policy.violations.length > 0) return (phase = 'invalid-fixture-call')
          if (
            policy.member !== undefined &&
            events.some((event) => event.sessionId === policy.member?.id && event.type === 'turn/end')
          )
            return (phase = 'ended-without-approval')
          return (phase = 'waiting')
        },
        { timeout: 120_000 },
      )
      .not.toBe('waiting')
    evidence.pendingPhase = phase
    expect(policy.violations).toEqual([])
    expect(phase, 'The member must reach a real native approval, not just complete its turn').toBe('pending')
    const member = required(policy.member)
    expect(host.ctx.agentTeams.listMembers(lead).find((entry) => entry.name === 'permission-review')?.id).toBe(
      member.id,
    )
    expect(member.session.header.cwd).toBe(lead.session.header.cwd)
    evidence.memberId = member.id
    const asked = events.filter((event) => event.type === 'approval/asked')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      sessionId: member.id,
      data: {
        toolName: 'bash',
        callId: required(policy.admittedCallId),
        reason: expect.stringContaining('escalate sandbox to danger-full-access:'),
      },
    })
    expect(asked[0]?.data).toMatchObject({ reason: expect.stringContaining(token) })
    expect(policy.originalApproval).toBe('never')
    expect(policy.approvalAtAdmission).toBe('ask')
    expect(policy.admissionPolicy).toMatchObject({ effective: 'read-only' })
    expect(sandboxWhenAsked).toBe('read-only')
    expect(absentWhenAsked, 'No file effect may precede the native approval request').toBe(true)
    expect(existsSync(destination), 'Command must not run before approval').toBe(false)
    expect(commandResults).toEqual([])
    expect(events.filter((event) => event.type === 'approval/decided')).toEqual([])
    const handle = await host.ctx.sessionPersistence.open(member.id, 'read')
    try {
      const log = (await handle.read()).events
      const firstPrompt = log.find(
        (event) =>
          event.type === 'user/message' && 'form' in event.data.source && event.data.source.form === 'snapshot',
      )
      expect(JSON.stringify(firstPrompt)).toContain('Approval prompts are disabled in this session')
      expect(JSON.stringify(firstPrompt)).toContain('Your own Agent tools use your normal permission request mechanism')
      expect(JSON.stringify(firstPrompt)).not.toContain('operations that require approval are rejected automatically')
    } finally {
      await handle.close()
    }
    await page.screenshot({ path: join(evidence.directory, 'pending-approval.png'), fullPage: true })
    // Answer from the Lead; opening the member would miss Teams forwarding.
    const leadUrl = page.url()
    const pendingMember = card.locator('[data-team-pending-member="permission-review"]')
    expect(await pendingMember.locator('[data-team-approval-reason]').innerText()).toContain(token)
    await pendingMember.getByRole('button', { name: 'Allow once', exact: true }).click()
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'approval/decided')).toHaveLength(1))
    expect(events.find((event) => event.type === 'approval/decided')).toMatchObject({
      sessionId: member.id,
      data: { id: asked[0]?.data.id, outcome: 'allowed-once' },
    })
    expect(sandboxWhenDecided, 'The native decision grants only the call, not standing policy').toBe('read-only')
    expect(absentWhenDecided, 'The decision must commit before the command file effect').toBe(true)
    expect(page.url()).toBe(leadUrl)
    await vi.waitFor(() => expect(existsSync(destination)).toBe(true), { timeout: 60_000 })
    expect(readFileSync(destination, 'utf8')).toBe(token)
    await vi.waitFor(() =>
      expect(commandResults).toEqual([{ sessionId: member.id, callId: policy.admittedCallId, isError: false }]),
    )
    await vi.waitFor(
      () =>
        expect(
          host.ctx.agentTeams.listMembers(lead).every((entry) => ['idle', 'inactive'].includes(entry.status)),
        ).toBe(true),
      { timeout: 120_000, interval: 500 },
    )
    expect(policy.violations).toEqual([])
    expect(events.filter((event) => event.type === 'approval/asked')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'approval/decided')).toHaveLength(1)
    expect(sandboxAtCommandResult, 'Allow once must not widen standing policy for the native command').toBe('read-only')
    for (const [agent, mode] of baselineModes)
      expect(
        host.ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
        `Unrelated session ${agent.id} policy must remain unchanged`,
      ).toBe(mode)
    await vi.waitFor(async () => expect(await card.count()).toBe(0))
    expect(page.url()).toBe(leadUrl)
    Object.assign(evidence, {
      approvedFromLead: true,
      absentWhenAsked,
      absentWhenDecided,
      originalDelegatedApproval: policy.originalApproval,
      nativeApprovalAtAdmission: policy.approvalAtAdmission,
      admissionPolicy: policy.admissionPolicy,
      sandboxWhenAsked,
      sandboxWhenDecided,
      sandboxAtCommandResult,
      standingSandboxAfter: host.ctx.sandboxPolicy.resolve({ session: member.session }).mode,
    })
    await page
      .locator('[data-team-action]')
      .getByRole('button', { name: /Agent Team/ })
      .click()
    completed = true
  } finally {
    try {
      if (!completed) {
        // Keep the admission guard and observers alive until failed fixture
        // activity has drained, including a still-pending native approval.
        const active = [lead, ...(policy.member === undefined ? [] : [policy.member])]
        for (const agent of active) agent.cancel({ kind: 'hook', reason: 'LIVE_TEAM_APPROVAL_FIXTURE_FAILED' })
        await Promise.all(active.map((agent) => agent.whenIdle()))
      }
    } finally {
      disposeResults()
      disposeEvents()
      policy.dispose()
    }
  }
}
