import {
  openMemberSettings,
  closeMemberSettings,
  memberSettingsDialog,
  openNativeMembers,
  openNativeMemberAside,
} from './native-team-ui.ts'
import { treeMembers } from './subagent-tree.ts'
import { basename, dirname, join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

/** Native subagent creation returning does not mean the independent child has finished setup. */
async function waitForMemberSetup(gate: string, deadlineAt: number): Promise<void> {
  const directory = dirname(gate)
  const prefix = `${basename(gate)}.`
  await vi.waitFor(
    () => {
      const ready = readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith('.ready'))
      expect(ready).toHaveLength(1)
      expect(readFileSync(join(directory, ready[0]!), 'utf8')).toBe('ready')
    },
    { timeout: Math.max(1, deadlineAt - Date.now()) },
  )
}

it('refreshes member controls during a running lead, retries metadata failures and opens the native sidebar', async () => {
  const host = await launchAdapterWorld({ teams: true })
  let browser: TestBrowser | undefined
  let setup: ReturnType<typeof installTeamFixtureApprovals> | undefined
  const permissionGate = join(host.workspaceCwd, 'teams-controls-permission.ready')
  const diagnostics = process.env.DSH_E2E_NATIVE_CATALOG_DIAGNOSTICS === '1'
  const evidenceDirectory = join(
    process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/e2e-evidence'),
    'native-catalog',
  )
  const observations: Record<string, unknown> = {}
  const publicApiLimits: string[] = []
  mkdirSync(evidenceDirectory, { recursive: true })
  const saveObservations = () =>
    writeFileSync(
      join(evidenceDirectory, 'contracts.json'),
      JSON.stringify({ observations, publicApiLimits, strictAcceptance: diagnostics }, null, 2),
    )
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        devin: {
          name: 'ACP controls',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_TEAM_PERMISSION_GATE: permissionGate,
            MOCK_SESSION_NEW_DELAY_MS: '3000',
          },
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
    // Compare the same empty native catalog with and without the ACP footer.
    // A registered footer can affect its owner even when the component renders null.
    const plugins = await host.ctx.pluginManager.listPlugins()
    const nativeTeamUi = required(plugins.find((entry) => entry.moduleName === '@deepseek-ai/dsh-client-ui-agent-team'))
    const adapterEntry = required(plugins.find((entry) => entry.moduleName === '@zaimokuza/dsh-acp-adapter'))
    expect(await host.ctx.pluginManager.setPluginEnabled(nativeTeamUi.entryId, false)).toMatchObject({
      application: 'applied',
    })
    await page.reload()
    await page.locator('[data-composer-input]').first().waitFor()
    await page
      .getByRole('button', { name: /^(?:Session|会话) ·/ })
      .first()
      .waitFor()
    const nativeTrigger = page.locator('[data-subagent-action] button[aria-haspopup="dialog"]').first()
    const withEmptyAcpFooter = await nativeTrigger.isVisible()
    if (withEmptyAcpFooter) {
      const emptyCatalog = await openNativeMembers(page)
      expect(await emptyCatalog.getByRole('treeitem').count()).toBe(0)
      expect(await emptyCatalog.locator('[data-acp-team-management]').count()).toBe(0)
      if (diagnostics) await page.screenshot({ path: join(evidenceDirectory, 'empty-acp-footer.png') })
    }
    expect(await host.ctx.pluginManager.setPluginEnabled(adapterEntry.entryId, false)).toMatchObject({
      application: 'applied',
    })
    await page.reload()
    await page.locator('[data-composer-input]').first().waitFor()
    await expect.poll(() => page.getByRole('button', { name: /^(?:Session|会话) ·/ }).count()).toBe(0)
    const withoutAcpFooter = await nativeTrigger.isVisible()
    observations.emptyFooter = { withEmptyAcpFooter, withoutAcpFooter }
    if (withEmptyAcpFooter && !withoutAcpFooter)
      publicApiLimits.push('An empty ACP footer makes the native empty catalog entry visible')
    saveObservations()
    expect(await host.ctx.pluginManager.setPluginEnabled(adapterEntry.entryId, true)).toMatchObject({
      application: 'applied',
    })
    expect(await host.ctx.pluginManager.setPluginEnabled(nativeTeamUi.entryId, true)).toMatchObject({
      application: 'applied',
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await page.reload()
    await page.locator('[data-composer-input]').first().waitFor()
    await page
      .getByRole('button', { name: /^(?:Session|会话) ·/ })
      .first()
      .waitFor()
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const input = page.locator('[data-composer-input]').first()
    const steps = [...teamStartSteps(host), ...teamMemberSetupSteps('calculator')]
    setup = installTeamFixtureApprovals(host, { root: lead, entries: steps })
    const setupDeadline = Date.now() + 30_000
    await writeComposerDraft(page, input, 'E2E_TEAM_START_HOLD')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    await waitForMemberSetup(permissionGate, setupDeadline)
    expect(
      acpPermissionAudit(host, 'decided').filter((entry) => setup!.requestIds.has(entry.data.requestId)),
    ).toHaveLength(steps.length)
    setup.finish()
    setup = undefined
    writeFileSync(permissionGate, 'ready')
    await page.getByRole('button', { name: 'Stop generating', exact: true }).first().waitFor()
    await openNativeMembers(page)
    const trigger = page.locator('[data-acp-team-management]').getByRole('button')
    await trigger.waitFor()
    // The held lead cannot finish on its own. The control must update before it stops.
    const url = page.url()
    const failedMetadata = vi.spyOn(service, 'teamMembers').mockRejectedValue(new Error('E2E_METADATA_UNAVAILABLE'))
    await trigger.focus()
    await page.keyboard.press('Enter')
    const panel = memberSettingsDialog(page)
    try {
      await panel.getByText('Cannot read member state. Refresh to retry.', { exact: true }).waitFor()
      expect((await treeMembers(host.ctx, lead)).some((member) => member.name === 'calculator')).toBe(true)
      expect(await panel.locator('[data-acp-managed-member]').count()).toBe(0)
    } finally {
      failedMetadata.mockRestore()
    }
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.locator('[data-acp-mode-group="devin"]').waitFor()
    await panel.getByText('Cannot read member state. Refresh to retry.', { exact: true }).waitFor({ state: 'detached' })
    const sessionControl = panel.locator('[data-acp-managed-member="calculator"]').getByRole('button', {
      name: /^(?:Session|会话) ·/,
    })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await sessionControl.locator('svg').evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sessionControl.locator('svg').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await sessionControl.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await menu.waitFor()
    await expect.poll(() => menu.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect(await memberSettingsDialog(page).count()).toBe(1)
    expect(await sessionControl.evaluate((element) => element === document.activeElement)).toBe(true)
    const closes = panel.getByRole('button', { name: 'Close', exact: true })
    await closes.last().focus()
    await page.keyboard.press('Tab')
    expect(await closes.first().evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await closes.last().evaluate((element) => element === document.activeElement)).toBe(true)
    const observeReturnFocus = async (method: 'close-button' | 'escape') => {
      await panel.waitFor({ state: 'hidden' })
      const focus = await page.evaluate(() => {
        const active = document.activeElement
        return {
          tag: active?.tagName,
          body: active === document.body,
          nativeTrigger: active !== null && active.closest('[data-subagent-action]') !== null,
          modalOrMenu: active !== null && active.closest('[role="dialog"], [role="menu"]') !== null,
          connected: active?.isConnected,
        }
      })
      expect(focus.modalOrMenu).toBe(false)
      if (!focus.nativeTrigger)
        publicApiLimits.push(`Native Modal did not return focus to its catalog trigger after ${method}`)
      await page.keyboard.press('Tab')
      const tabReachedControl = await page.evaluate(() => {
        const active = document.activeElement
        return (
          active instanceof HTMLElement &&
          active !== document.body &&
          active.isConnected &&
          active.getClientRects().length > 0 &&
          active.closest('[inert], [hidden]') === null
        )
      })
      expect(tabReachedControl).toBe(true)
      observations[method] = { ...focus, tabReachedControl }
      saveObservations()
    }
    await page.keyboard.press('Enter')
    await observeReturnFocus('close-button')
    await openMemberSettings(page)
    // An ordinary click in the portaled Modal dismisses its native catalog opener.
    await panel.getByRole('heading', { name: 'ACP member settings', exact: true }).click()
    await expect.poll(() => page.locator('[data-subagent-panel]:visible').count()).toBe(0)
    await page.keyboard.press('Escape')
    await observeReturnFocus('escape')
    await openNativeMemberAside(page, 'calculator')
    expect(page.url()).toBe(url)
    expect(await memberSettingsDialog(page).count()).toBe(0)
    expect(
      await page.locator('[data-slot="conversation.session.header.utilities"] [data-acp-team-management]').count(),
    ).toBe(0)
    // The diagnostic run is deliberately stricter than the current upstream API.
    // Normal CI checks usable keyboard paths and records limitations without certifying them as fixed UX.
    if (diagnostics) expect(publicApiLimits).toEqual([])
  } finally {
    setup?.dispose()
    await browser?.close()
    await host.close()
  }
})

it('keeps ACP child controls and approvals across Team mode changes and native catalog hot restart', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  let setup: ReturnType<typeof installTeamFixtureApprovals> | undefined
  const permissionGate = join(host.workspaceCwd, 'teams-lifecycle-permission.ready')
  const errors: string[] = []
  try {
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
            MOCK_SESSION_NEW_DELAY_MS: '3000',
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string) => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }
    const firstTurn = host.whenTurnSettled()
    await send('E2E_MESSAGE')
    const leadId = await firstTurn
    const lead = required(host.ctx.agents.get(leadId))
    const url = page.url()
    expect(host.ctx.agentTeams.isEnabled(lead)).toBe(false)
    expect(await page.locator('[data-acp-team-management]').count()).toBe(0)
    await host.ctx.agentTeams.setEnabled(lead, true)
    const steps = [...teamStartSteps(host), ...teamMemberSetupSteps('calculator')]
    setup = installTeamFixtureApprovals(host, { root: lead, entries: steps })
    const deadline = Date.now() + 30_000
    await send('E2E_TEAM_START')
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor({ timeout: 30000 })
    await waitForMemberSetup(permissionGate, deadline)
    expect(
      acpPermissionAudit(host, 'decided').filter((entry) => setup!.requestIds.has(entry.data.requestId)),
    ).toHaveLength(steps.length)
    setup.finish()
    setup = undefined
    const child = required((await treeMembers(host.ctx, lead)).find((member) => member.name === 'calculator'))
    writeFileSync(permissionGate, 'ready')
    const approvals = page.locator('[data-acp-team-approvals]')
    const childApproval = approvals.locator('[data-team-pending-member="calculator"]')
    await childApproval.getByRole('button', { name: 'Reject', exact: true }).waitFor()
    // Disabling Team removes task capability, never the established child or its pending user decision.
    const tasks = host.ctx.agentTeams.listTasks(lead)
    const projectedTasks = host.ctx.sessionProjections.snapshot(lead.session, ['agentTeam']).values.agentTeam?.tasks
    await host.ctx.agentTeams.setEnabled(lead, false)
    expect(host.ctx.agentTeams.isEnabled(lead)).toBe(false)
    expect(() => host.ctx.agentTeams.listTasks(lead)).toThrow(expect.objectContaining({ code: 'TEAM_DISABLED' }))
    expect(host.ctx.sessionProjections.snapshot(lead.session, ['agentTeam']).values.agentTeam?.tasks).toEqual(
      projectedTasks,
    )
    expect((await treeMembers(host.ctx, lead)).some((member) => member.id === child.id)).toBe(true)
    expect(await childApproval.getByRole('button', { name: 'Reject', exact: true }).count()).toBe(1)
    await openMemberSettings(page)
    await memberSettingsDialog(page).locator('[data-acp-managed-member="calculator"]').waitFor()
    expect(
      await page.locator('[data-slot="conversation.session.header.utilities"] [data-acp-team-management]').count(),
    ).toBe(0)
    const nativeUi = required(
      (await host.ctx.pluginManager.listPlugins()).find(
        (entry) => entry.moduleName === '@deepseek-ai/dsh-client-ui-subagent',
      ),
    )
    expect(await host.ctx.pluginManager.setPluginEnabled(nativeUi.entryId, false)).toMatchObject({
      application: 'applied',
    })
    await expect.poll(() => page.locator('[data-subagent-action]').count()).toBe(0)
    await expect.poll(() => memberSettingsDialog(page).count()).toBe(0)
    await expect.poll(() => page.locator('[data-acp-team-management]').count()).toBe(0)
    expect(await childApproval.getByRole('button', { name: 'Reject', exact: true }).count()).toBe(1)
    expect((await treeMembers(host.ctx, lead)).some((member) => member.id === child.id)).toBe(true)
    expect(await host.ctx.pluginManager.setPluginEnabled(nativeUi.entryId, true)).toMatchObject({
      application: 'applied',
    })
    await openMemberSettings(page)
    await memberSettingsDialog(page).locator('[data-acp-managed-member="calculator"]').waitFor()
    await closeMemberSettings(page)
    await childApproval.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect
      .poll(
        () =>
          acpPermissionAudit(host, 'decided').find(
            (entry) => entry.sessionId === child.id && entry.data.toolCallId === 'member-shell',
          )?.data,
      )
      .toMatchObject({ optionId: 'deny', selectedOptionKind: 'reject_once' })
    await host.ctx.subagents.waitForTreeWork(lead)
    await lead.whenIdle()
    await host.ctx.agentTeams.setEnabled(lead, true)
    expect(host.ctx.agentTeams.listTasks(lead)).toEqual(tasks)
    await openNativeMembers(page)
    expect(await page.locator('[data-team-panel]').count()).toBe(1)
    expect((await treeMembers(host.ctx, lead)).some((member) => member.id === child.id)).toBe(true)
    expect(page.url()).toBe(url)
    expect(errors).toEqual([])
  } finally {
    setup?.dispose()
    await browser?.close()
    await host.close()
  }
}, 120_000)
