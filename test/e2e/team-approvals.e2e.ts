import { acpPermissionAudit } from './acp-permission-audit.ts'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'
import type { AcpPermissionAuditData } from '../../src/domain/policy/events.ts'

it.each(['devin', 'codex'].flatMap((profile) => ['allow', 'reject'].map((decision) => ({ profile, decision }))))(
  'handles eight $profile member approvals from the Lead: $decision, then leaves a later request pending',
  async ({ profile, decision }) => {
    // Native default includes the Lead in its 8-member limit. This test opts into 9.
    const host = await launchAdapterWorld({ teams: true, teamMembers: 9 })
    let browser!: TestBrowser
    let page!: Page
    const events: ObservedEvent[] = [],
      errors: string[] = []
    const bootstrapAnswers: {
      sessionId: string
      requestId: string
      toolCallId: string
      optionId: string
    }[] = []
    let releaseSecondChildRead!: () => void
    let notifySecondChildReadStarted!: () => void
    const secondChildReadGate = new Promise<void>((resolve) => {
      releaseSecondChildRead = resolve
    })
    const secondChildReadStarted = new Promise<void>((resolve) => {
      notifySecondChildReadStarted = resolve
    })
    const log = join(host.workspaceCwd, 'team-approvals.log')
    const policyGate = join(host.workspaceCwd, 'team-approval-policy-ready')
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    try {
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'auto',
        agents: {
          [profile]: {
            name: `Fixture ${profile}`,
            command: process.execPath,
            args: [join(root, 'test/mock-agent/mock-agent.ts')],
            env: {
              HOME: host.workspaceCwd,
              MOCK_SCENARIO: 'regression',
              MOCK_PROFILE: profile,
              MOCK_MCP_HTTP: '1',
              MOCK_LOG: log,
              MOCK_TEAM_PERMISSION_GATE: policyGate,
              MOCK_TEAM_APPROVAL_ONCE_ONLY: '1',
            },
          },
        },
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === `acp-${profile}`)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider: `acp-${profile}`, model: 'mock-model-a' })
      browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
      page = await newEnglishPage(browser)
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      // Devin Auto still requires a human decision for its independent ACP
      // requests. This driver supplies explicit one-time setup answers through
      // the native answerer, then removes itself before releasing the shell gate.
      let bootstrapRoot: Agent | undefined
      const bootstrapCounts = new Map<string, number>()
      const releaseBootstrap =
        profile === 'devin'
          ? host.ctx.on(
              'approval/request',
              async (request, next) => {
                if (
                  request.signal?.aborted ||
                  host.ctx.agents.get(request.agent.id) !== request.agent ||
                  request.agent.options.provider !== 'acp-devin'
                )
                  return next()
                const isRoot = host.ctx.agents.roots().includes(request.agent)
                if (isRoot) {
                  if (bootstrapRoot !== undefined && request.agent !== bootstrapRoot) return next()
                  const roots = host.ctx.agents.roots().filter((agent) => agent.options.provider === 'acp-devin')
                  if (roots.length !== 1 || roots[0] !== request.agent) return next()
                } else {
                  const membership = host.ctx.agentTeams.tryMembership(request.agent)
                  if (
                    bootstrapRoot === undefined ||
                    host.ctx.agents.get(bootstrapRoot.id) !== bootstrapRoot ||
                    membership?.role !== 'teammate' ||
                    membership.root !== bootstrapRoot ||
                    !/^worker-[1-8]$/.test(membership.name) ||
                    !host.ctx.agents.isOwnedBy(request.agent.id, bootstrapRoot) ||
                    !host.ctx.agentTeams
                      .listMembers(bootstrapRoot)
                      .some((member) => member.id === request.agent.id && member.name === membership.name)
                  )
                    return next()
                  expect(host.ctx.approval.overrideOf(request.agent.session)).toBe('never')
                }
                const index = bootstrapCounts.get(request.agent.id) ?? 0
                if (index >= (isRoot ? 9 : 2) || request.callId !== `team-${index + 1}`) return next()
                const asked = acpPermissionAudit(host, 'asked').findLast(
                  (entry) => entry.sessionId === request.agent.id && entry.data.toolCall.toolCallId === request.callId,
                )
                if (asked?.data.toolCall.title !== (index === 0 ? 'list_agents' : 'spawn_teammate')) return next()
                expect(asked.data.options).toEqual([
                  { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
                  { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
                ])
                expect(JSON.parse(required(asked.data.toolCall.rawInputSummary))).toEqual(
                  index === 0
                    ? {}
                    : isRoot
                      ? {
                          name: `worker-${index}`,
                          description: 'Batch approval member',
                          prompt: `E2E_TEAM_MEMBER calculate 1+1${index === 1 ? ' E2E_TEAM_FOLLOWUP_PERMISSION' : ''}`,
                          context: 'fresh',
                        }
                      : { name: 'nested', description: 'Denied nested spawn', prompt: 'do nothing' },
                )
                if (isRoot) bootstrapRoot = request.agent
                bootstrapCounts.set(request.agent.id, index + 1)
                bootstrapAnswers.push({
                  sessionId: request.agent.id,
                  requestId: asked.data.requestId,
                  toolCallId: required(request.callId),
                  optionId: 'allow',
                })
                return 'allowed-once'
              },
              { prepend: true },
            )
          : undefined
      try {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_TEAM_EIGHT')
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        await page.getByText('E2E_TEAM_EIGHT_READY', { exact: true }).waitFor({ timeout: 60000 })
        await vi.waitFor(
          () =>
            expect(
              readdirSync(host.workspaceCwd).filter(
                (name) => name.startsWith('team-approval-policy-ready.') && name.endsWith('.ready'),
              ),
            ).toHaveLength(8),
          { timeout: 30000 },
        )
      } finally {
        releaseBootstrap?.()
      }
      const lead = required(
        host.ctx.agents.list().find((agent) => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead'),
      )
      const memberIds = new Set<string>(
        host.ctx.agentTeams
          .listMembers(lead)
          .filter((member) => member.role === 'teammate')
          .map((member) => member.id),
      )
      expect(memberIds.size).toBe(8)
      if (profile === 'devin') {
        expect(bootstrapRoot).toBe(lead)
        expect(bootstrapAnswers).toHaveLength(25)
        expect(bootstrapCounts.get(lead.id)).toBe(9)
        for (const memberId of memberIds) expect(bootstrapCounts.get(memberId)).toBe(2)
      }
      const bootstrapRequestIds = bootstrapAnswers.map((answer) => answer.requestId)
      expect(
        acpPermissionAudit(host, 'asked')
          .map((event) => event.data.requestId)
          .sort(),
      ).toEqual([...bootstrapRequestIds].sort())
      const setupDecisions = acpPermissionAudit(host, 'decided')
      expect(setupDecisions).toHaveLength(bootstrapAnswers.length)
      for (const answer of bootstrapAnswers) {
        const decided = required(setupDecisions.find((event) => event.data.requestId === answer.requestId))
        expect(decided.sessionId).toBe(answer.sessionId)
        expect(decided.data.toolCallId).toBe(answer.toolCallId)
        expect(decided.data.optionId).toBe(answer.optionId)
        expect(decided.data.selectedOptionKind === 'allow_once' && decided.data.decisionVia === 'native-approval').toBe(
          true,
        )
      }
      const memberAudit = <P extends 'asked' | 'decided'>(phase: P) =>
        acpPermissionAudit(host, phase).filter((event) => {
          const data: AcpPermissionAuditData = event.data
          const callId = data.phase === 'asked' ? data.toolCall.toolCallId : data.toolCallId
          return memberIds.has(event.sessionId) && ['member-shell', 'member-late-shell'].includes(callId)
        })
      const remote = host.ctx.get('dshAcp') as AcpRemoteService
      await remote.setToolApprovalPolicy(lead.id, { policy: 'ask' })
      const readApprovalChildren = remote.approvalChildren.bind(remote)
      let childReads = 0
      let failNextChildRead = false
      vi.spyOn(remote, 'approvalChildren').mockImplementation(async (session) => {
        childReads++
        if (failNextChildRead) {
          failNextChildRead = false
          throw new RemoteError('dsh-acp/user-rejected', 'E2E_STABLE_CHILD_DISCOVERY_FAILURE', {
            kind: null,
            correlationId: null,
          })
        }
        if (childReads === 1) throw new Error('E2E_TEMPORARY_CHILD_DISCOVERY_FAILURE')
        if (childReads >= 2) {
          if (childReads === 2) notifySecondChildReadStarted()
          await secondChildReadGate
        }
        return readApprovalChildren(session)
      })
      writeFileSync(policyGate, 'ready')
      expect(lead).toBeDefined()
      const card = page.locator('[data-acp-team-approvals]')
      await secondChildReadStarted
      await expect.poll(() => card.locator('strong[role="status"]').innerText()).toBe('Loading pending requests…')
      expect(await card.locator('strong[role="status"]').count()).toBe(1)
      expect(await card.locator('p[role="status"]').count()).toBe(0)
      expect(await card.locator('[data-team-pending-member]').count()).toBe(0)
      expect(await card.innerText()).not.toContain('Child sessions needing your attention · 0')
      const collapseLoading = card.getByRole('button', { name: 'Collapse', exact: true })
      await collapseLoading.click()
      const expandLoading = card.getByRole('button', { name: 'Expand', exact: true })
      expect(await expandLoading.getAttribute('aria-expanded')).toBe('false')
      await expandLoading.click()
      expect(await card.getByRole('button', { name: 'Collapse', exact: true }).getAttribute('aria-expanded')).toBe(
        'true',
      )
      releaseSecondChildRead()
      await expect.poll(() => card.locator('[data-team-pending-member]').count(), { timeout: 30000 }).toBe(8)
      expect(childReads).toBeGreaterThanOrEqual(2)
      const url = page.url()
      mkdirSync(join(root, '.local/team-approvals'), { recursive: true })
      await page.screenshot({ path: join(root, `.local/team-approvals/eight-${profile}-${decision}.png`) })
      expect(await card.innerText()).toContain('echo E2E_TEAM_PERMISSION')
      failNextChildRead = true
      await card
        .locator('[data-team-pending-member="worker-8"]')
        .getByRole('button', { name: 'Reject', exact: true })
        .click()
      await expect
        .poll(() => card.getByText('Child pending requests could not be verified.', { exact: true }).count())
        .toBe(1)
      expect(await card.locator('strong[role="status"]').count()).toBe(1)
      expect(memberAudit('decided')).toHaveLength(0)
      const outcome = decision === 'allow' ? 'allow_once' : 'reject_once'
      // One inline action plus the batch proves both paths without opening a member.
      await card
        .locator('[data-team-pending-member="worker-8"]')
        .getByRole('button', { name: decision === 'allow' ? 'Allow once' : 'Reject', exact: true })
        .click()
      await expect.poll(() => card.locator('[data-team-pending-member]').count()).toBe(7)
      // Pending requests survive transport replacement; stale carriers must not be answered.
      await page.reload()
      await expect.poll(() => card.locator('[data-team-pending-member]').count()).toBe(7)
      await page.setViewportSize({ width: 680, height: 900 })
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      await host.ctx.settings.replace('locale', { preference: 'zh' })
      await card.getByRole('button', { name: decision === 'allow' ? '全部允许' : '全部拒绝', exact: true }).click()
      await expect.poll(() => memberAudit('decided').length).toBe(8)
      expect(memberAudit('decided').every((event) => event.data.selectedOptionKind === outcome)).toBe(true)
      expect(new Set(memberAudit('decided').map((event) => event.sessionId)).size).toBe(8)
      expect(memberAudit('decided').every((event) => event.sessionId !== lead.id)).toBe(true)
      expect(page.url()).toBe(url)
      // The Agent sends a second request only after receiving its first answer.
      // Wait for that durable producer boundary before testing the UI delivery.
      await expect.poll(() => memberAudit('asked').length, { timeout: 10_000 }).toBe(9)
      // The batch is bounded to the original request identities.
      expect(memberAudit('decided')).toHaveLength(8)
      await expect.poll(() => card.locator('[data-team-pending-member]').count(), { timeout: 10_000 }).toBe(1)
      await card.locator('[data-team-approval-reason]').filter({ hasText: 'echo E2E_TEAM_LATE_PERMISSION' }).waitFor()
      expect(memberAudit('decided')).toHaveLength(8)
      await card.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect.poll(() => memberAudit('decided').length).toBe(9)
      expect(required(memberAudit('decided').at(-1)).data.selectedOptionKind).toBe('reject_once')
      const askedAudit = memberAudit('asked')
      const decidedAudit = memberAudit('decided')
      expect(askedAudit).toHaveLength(9)
      expect(askedAudit.map((entry) => entry.data.requestId).sort()).toEqual(
        decidedAudit.map((entry) => entry.data.requestId).sort(),
      )
      expect(decidedAudit.every((entry) => entry.data.decisionVia === 'native-approval')).toBe(true)
      // Separating setup must not hide an unexpected permission request or reply.
      expect(
        acpPermissionAudit(host, 'asked')
          .map((entry) => entry.data.requestId)
          .sort(),
      ).toEqual([...bootstrapRequestIds, ...askedAudit.map((entry) => entry.data.requestId)].sort())
      expect(
        acpPermissionAudit(host, 'decided')
          .map((entry) => entry.data.requestId)
          .sort(),
      ).toEqual([...bootstrapRequestIds, ...decidedAudit.map((entry) => entry.data.requestId)].sort())
      await expect.poll(() => card.count()).toBe(0)
      expect(page.url()).toBe(url)
      expect(errors).toEqual([])
    } catch (error) {
      mkdirSync(join(root, '.local/e2e-failures'), { recursive: true })
      writeFileSync(
        join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.audit.json`),
        JSON.stringify(
          {
            error: String(error),
            bootstrapAnswers,
            asked: acpPermissionAudit(host, 'asked'),
            decided: acpPermissionAudit(host, 'decided'),
          },
          null,
          2,
        ),
      )
      if (page) {
        mkdirSync(join(root, '.local/e2e-failures'), { recursive: true })
        await page.screenshot({
          path: join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.png`),
          fullPage: true,
        })
        writeFileSync(
          join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.log`),
          readFileSync(log, 'utf8'),
        )
        writeFileSync(
          join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.json`),
          JSON.stringify(events, null, 2),
        )
        writeFileSync(
          join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.errors.json`),
          JSON.stringify(errors),
        )
      }
      throw error
    } finally {
      releaseSecondChildRead()
      await browser?.close()
      await host.close()
    }
  },
  120000,
)
