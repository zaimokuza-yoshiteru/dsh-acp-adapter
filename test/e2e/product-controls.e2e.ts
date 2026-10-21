import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { installTeamFixtureApprovals, teamMemberSetupSteps, teamStartSteps } from './team-fixture-approval.ts'

it('refreshes member controls during a running lead, retries metadata failures and opens the native sidebar', async () => {
  const host = await launchAdapterWorld({ teams: true })
  let browser: TestBrowser | undefined
  let setup: ReturnType<typeof installTeamFixtureApprovals> | undefined
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        devin: {
          name: 'ACP controls',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_MCP_HTTP: '1' },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    // A blank composer has no session-header extension point yet.
    const initialTurn = host.whenTurnSettled(30_000)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const lead = required(host.ctx.agents.get(await initialTurn))
    await expect.poll(() => page.locator('[data-acp-team-management]').count()).toBe(0)
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const input = page.locator('[data-composer-input]').first()
    setup = installTeamFixtureApprovals(host, {
      root: lead,
      entries: [...teamStartSteps(host), ...teamMemberSetupSteps('calculator')],
    })
    await writeComposerDraft(page, input, 'E2E_TEAM_START_HOLD')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    await expect
      .poll(
        () => acpPermissionAudit(host, 'decided').filter((entry) => setup!.requestIds.has(entry.data.requestId)).length,
      )
      .toBe(17)
    setup.finish()
    setup = undefined
    await page.getByRole('button', { name: 'Stop generating', exact: true }).first().waitFor()
    const trigger = page.getByRole('button', { name: 'Manage members · 1', exact: true })
    await trigger.waitFor()
    // The held lead cannot finish on its own. The control must update before it stops.
    const url = page.url()
    const failedMetadata = vi.spyOn(service, 'teamMembers').mockRejectedValue(new Error('E2E_METADATA_UNAVAILABLE'))
    await trigger.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Manage members', exact: true })
    try {
      await panel.getByText('Cannot read member state. Refresh to retry.', { exact: true }).waitFor()
      // ACP metadata failure must not erase the native projected member.
      expect(await panel.locator('[data-acp-managed-member="calculator"]').count()).toBe(1)
      const sessionControl = panel.locator('[data-acp-managed-member="calculator"]').getByRole('button', {
        name: /^(?:Session|会话) ·/,
      })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      expect(await sessionControl.locator('svg').evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe(
        '0s',
      )
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await sessionControl.locator('svg').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    } finally {
      failedMetadata.mockRestore()
    }
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.locator('[data-acp-mode-group="devin"]').waitFor()
    await panel.getByText('Cannot read member state. Refresh to retry.', { exact: true }).waitFor({ state: 'detached' })
    await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await panel.getByRole('button', { name: 'Open calculator’s session', exact: true }).click()
    await page.locator('[data-sidebar-chat]').waitFor()
    expect(page.url()).toBe(url)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-acp-team-panel]').count()).toBe(0)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
  } finally {
    setup?.dispose()
    await browser?.close()
    await host.close()
  }
})

it('follows the native Teams bundle and UI lifecycle while retaining the same conversation and roster', async () => {
  const host = await launchAdapterWorld({ optionalBundles: ['agent-team-profile'] })
  let browser: TestBrowser | undefined
  let setup: ReturnType<typeof installTeamFixtureApprovals> | undefined
  const permissionGate = join(host.workspaceCwd, 'teams-lifecycle-permission.ready')
  const errors: string[] = []
  try {
    const manager = host.ctx.pluginManager
    const bundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
    // Start the browser with Teams disabled through the official profile owner.
    expect(await manager.setBundleEnabled(bundle, false)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('agentTeams')).toBeUndefined())
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        devin: {
          name: 'ACP Teams lifecycle',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_TEAM_PERMISSION_GATE: permissionGate,
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    const remote = host.ctx.get('dshAcp') as AcpRemoteService
    const memberReads = vi.spyOn(remote, 'teamMembers')
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string): Promise<void> => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }
    const firstTurn = host.whenTurnSettled()
    await send('E2E_MESSAGE')
    const leadId = await firstTurn
    const lead = required(host.ctx.agents.get(leadId))
    const url = page.url()
    const nativeTeam = page.locator('[data-team-action]')
    const management = page.locator('[data-acp-team-management]')
    const approvals = page.locator('[data-acp-team-approvals]')
    await expect.poll(() => nativeTeam.count()).toBe(0)
    await expect.poll(() => management.count()).toBe(0)
    await expect.poll(() => approvals.count()).toBe(0)
    expect(memberReads).not.toHaveBeenCalled()

    expect(await manager.setBundleEnabled(bundle, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('agentTeams')).toBeDefined())
    await nativeTeam.waitFor()
    await expect.poll(() => management.count()).toBe(0)
    setup = installTeamFixtureApprovals(host, {
      root: lead,
      entries: [...teamStartSteps(host), ...teamMemberSetupSteps('calculator')],
    })
    await send('E2E_TEAM_START')
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor({ timeout: 30000 })
    await expect
      .poll(
        () => acpPermissionAudit(host, 'decided').filter((entry) => setup!.requestIds.has(entry.data.requestId)).length,
      )
      .toBe(17)
    setup.finish()
    setup = undefined
    // Resolve the real child request explicitly before exercising the Teams
    // lifecycle. Generic managed-child approvals are independent of Teams UI.
    const child = required(host.ctx.agentTeams.listMembers(lead).find((member) => member.name === 'calculator'))
    const childAgent = required(host.ctx.agents.get(child.id))
    writeFileSync(permissionGate, 'ready')
    const childApproval = approvals.locator('[data-team-pending-member="calculator"]')
    await childApproval.getByRole('button', { name: 'Reject', exact: true }).waitFor()
    expect(
      acpPermissionAudit(host, 'decided').filter(
        (entry) => entry.sessionId === child.id && entry.data.toolCallId === 'member-shell',
      ),
    ).toEqual([])
    await childApproval.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect
      .poll(
        () =>
          acpPermissionAudit(host, 'decided').find(
            (entry) => entry.sessionId === child.id && entry.data.toolCallId === 'member-shell',
          )?.data,
      )
      .toMatchObject({ optionId: 'deny', selectedOptionKind: 'reject_once' })
    await childAgent.whenIdle()
    await lead.whenIdle()
    await expect.poll(() => approvals.count()).toBe(0)
    const trigger = page.getByRole('button', { name: 'Manage members · 1', exact: true })
    await trigger.waitFor()
    await trigger.click()
    await page.locator('[data-acp-team-panel] [data-acp-managed-member="calculator"]').waitFor()
    await vi.waitFor(() => expect(memberReads).toHaveBeenCalled())
    const roster = required(host.ctx.sessionProjections.stateOf(lead.session, 'agentTeam'))
    expect(roster.members.some((member) => member.name === 'calculator')).toBe(true)

    // Isolate UI removal from Team domain removal: the native projection and
    // live roster stay available, so a cached projection cannot hide the bug.
    const nativeUi = required(
      (await manager.listPlugins()).find(
        (entry) => entry.moduleName === '@deepseek-ai/dsh-experimental-client-ui-agent-team',
      ),
    )
    expect(await manager.setPluginEnabled(nativeUi.entryId, false)).toMatchObject({ application: 'applied' })
    await expect.poll(() => nativeTeam.count()).toBe(0)
    await expect.poll(() => management.count()).toBe(0)
    await expect.poll(() => page.locator('[data-acp-team-panel]').count()).toBe(0)
    await expect.poll(() => approvals.count()).toBe(0)
    expect(host.ctx.agentTeams.listMembers(lead).some((member) => member.name === 'calculator')).toBe(true)
    expect(host.ctx.sessionProjections.stateOf(lead.session, 'agentTeam')?.members).toEqual(roster.members)
    const readsWhileDisabled = memberReads.mock.calls.length
    await page.locator('[data-composer-input]').first().click()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(memberReads).toHaveBeenCalledTimes(readsWhileDisabled)

    expect(await manager.setPluginEnabled(nativeUi.entryId, true)).toMatchObject({ application: 'applied' })
    await nativeTeam.waitFor()
    await trigger.waitFor()
    expect(page.url()).toBe(url)
    expect(await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')).toBe(
      leadId,
    )

    expect(await manager.setBundleEnabled(bundle, false)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('agentTeams')).toBeUndefined())
    await expect.poll(() => nativeTeam.count()).toBe(0)
    await expect.poll(() => management.count()).toBe(0)
    await expect.poll(() => approvals.count()).toBe(0)
    expect(await manager.setBundleEnabled(bundle, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('agentTeams')).toBeDefined())
    await nativeTeam.waitFor()
    await trigger.waitFor()
    expect(host.ctx.agentTeams.listMembers(lead).some((member) => member.name === 'calculator')).toBe(true)
    expect(page.url()).toBe(url)
    expect(errors).toEqual([])
  } finally {
    setup?.dispose()
    await browser?.close()
    await host.close()
  }
}, 120_000)
