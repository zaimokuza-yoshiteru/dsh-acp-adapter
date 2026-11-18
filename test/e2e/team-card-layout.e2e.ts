import { openMemberSettings, closeMemberSettings, memberSettingsDialog, openNativeMembers } from './native-team-ui.ts'
import { treeMembers } from './subagent-tree.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { installTeamFixtureApprovals, teamMemberSetupSteps } from './team-fixture-approval.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

it('keeps ACP member settings readable in native dialogs, with localized failure and narrow scrolling', async () => {
  let hostToClose: Awaited<ReturnType<typeof launchAdapterWorld>> | undefined
  let browser!: TestBrowser
  let passed = false
  const drivers: ReturnType<typeof installTeamFixtureApprovals>[] = []
  let evidencePage: Awaited<ReturnType<typeof newEnglishPage>> | undefined
  const screenshotDir = process.env.DSH_E2E_SCREENSHOTS
  const browserName = process.env.DSH_E2E_ELECTRON ? 'electron' : (process.env.DSH_E2E_BROWSER_CHANNEL ?? 'default')
  const failureDir = join(root, '.local/e2e-failures/team-card-layout', browserName)
  const stagePath = join(failureDir, 'team-card-layout.stage.log')
  let stage = 'launch host'
  let localeTheme = 'initial'
  const setStage = (nextStage: string) => {
    stage = nextStage
    mkdirSync(failureDir, { recursive: true })
    appendFileSync(stagePath, `${new Date().toISOString()} stage: ${stage}; locale/theme: ${localeTheme}\n`)
  }
  mkdirSync(failureDir, { recursive: true })
  rmSync(stagePath, { force: true })
  try {
    setStage('launch host')
    const host = await launchAdapterWorld({ teams: true })
    hostToClose = host
    setStage('host launched')
    setStage('configure fixture')
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        devin: {
          name: 'Layout fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_SESSION_NEW_DELAY_MS: '2500',
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    setStage('launch browser')
    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    const page = await newEnglishPage(browser)
    evidencePage = page
    page.setDefaultTimeout(10_000)
    setStage('load app')
    await page.goto(host.authenticatedUrl)
    setStage('connect workspace')
    await connectFreshWorkspace(page, host.workspaceCwd)
    const names = [
      [
        'worker-deepseek-harness',
        'Owner worker for reference/deepseek-harness (DSH agent harness, TypeScript monorepo). Review native message rendering and plugin compatibility.',
      ],
      [
        'worker-deer-flow',
        'Owner worker for reference/deer-flow (Python LangGraph + Node frontend). Review streaming, tools and approval boundaries.',
      ],
    ] as const
    const bootstrap = installTeamFixtureApprovals(host, {
      initialPrompt: 'E2E_TEAM_LAYOUT',
      entries: [
        { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {} },
        ...names.map(([name, description], index) => ({
          owner: 'lead',
          callId: `team-${index + 2}`,
          tool: 'subagent',
          args: { name, description, prompt: 'E2E_TEAM_MEMBER calculate 1+1' },
        })),
        ...names.flatMap(([name]) => teamMemberSetupSteps(name)),
      ],
    })
    drivers.push(bootstrap)
    setStage('send fixture message')
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_TEAM_LAYOUT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    setStage('wait for fixture response')
    await page.getByText('E2E_TEAM_LAYOUT_READY', { exact: true }).waitFor()
    const approvals = page.locator('[data-acp-team-approvals]')
    // The lead's marker only confirms spawn requests. Each child still has its own ACP startup.
    setStage('wait for teammate approvals')
    await expect.poll(() => approvals.locator('[data-team-pending-member]').count(), { timeout: 30_000 }).toBe(2)
    bootstrap.finish()
    const lead = bootstrap.root()
    const notices = installTeamFixtureApprovals(host, {
      root: lead,
      entries: [
        { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {}, optional: true },
        { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {}, optional: true },
      ],
    })
    drivers.push(notices)
    const members = (await treeMembers(host.ctx, lead)).filter((m) => m.role === 'teammate')
    const memberIds = new Set<string>(members.map((member) => member.id))
    const pendingShells = acpPermissionAudit(host, 'asked').filter(
      (entry) => memberIds.has(entry.sessionId) && entry.data.toolCall.toolCallId === 'member-shell',
    )
    expect(pendingShells).toHaveLength(2)
    expect(new Set(pendingShells.map((entry) => entry.sessionId)).size).toBe(2)
    setStage('reject teammate approvals')
    await approvals.getByRole('button', { name: 'Reject all', exact: true }).click()
    setStage('wait for teammate sessions to stop')
    // A stale snapshot can precede process teardown; join the owning activations before checking writability.
    await host.ctx.subagents.waitForTreeWork(lead)
    expect(
      await Promise.all(
        members.map(async (m) => {
          const snapshot = await (host.ctx.get('dshAcp') as AcpRemoteService).agentSessionSnapshot(m.id)
          return { freshness: snapshot.freshness, modeWritable: snapshot.modeWritable }
        }),
      ),
    ).toEqual([
      { freshness: 'stale', modeWritable: true },
      { freshness: 'stale', modeWritable: true },
    ])
    await lead.whenIdle()
    notices.finish()
    for (const pending of pendingShells) {
      const decided = required(
        acpPermissionAudit(host, 'decided').find((entry) => entry.data.requestId === pending.data.requestId),
      )
      expect(decided.sessionId).toBe(pending.sessionId)
      expect(decided.data).toMatchObject({
        toolCallId: 'member-shell',
        outcome: 'selected',
        optionId: 'deny',
        selectedOptionKind: 'reject_once',
        decisionVia: 'native-approval',
      })
    }
    const panel = memberSettingsDialog(page)
    setStage('open ACP settings through native catalog')
    await openMemberSettings(page)
    const cards = panel.locator('[data-acp-managed-member]')
    await expect.poll(() => cards.count()).toBe(2)
    await page.getByText('Loading ACP member settings…', { exact: true }).waitFor({ state: 'hidden' })
    const previousNames = await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-acp-managed-member')),
    )
    expect(previousNames).toEqual(names.map(([name]) => name))
    expect(await cards.getByRole('button', { name: /Open .*session/ }).count()).toBe(0)
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    await expect(service.setTeamMemberModel(lead.id, members[0].id, 'mock-model-b')).rejects.toMatchObject({
      code: 'dsh-acp/model-switch-unavailable',
    })
    await service.setTeamMemberMode(lead.id, members[0].id, 'plan')
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await cards
      .first()
      .getByRole('button', { name: /^(?:Session|会话) · Plan$/ })
      .waitFor()
    const teamMembers = service.teamMembers.bind(service)
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const heldRefresh = vi.spyOn(service, 'teamMembers').mockImplementation(async (sessionId) => {
      await refreshGate
      return teamMembers(sessionId)
    })
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    try {
      await page.getByText('Loading ACP member settings…', { exact: true }).waitFor()
      expect(
        await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-acp-managed-member')),
        ),
      ).toEqual(previousNames)
    } finally {
      releaseRefresh()
      heldRefresh.mockRestore()
    }
    await page.getByText('Loading ACP member settings…', { exact: true }).waitFor({ state: 'hidden' })
    const verifyMenu = async () => {
      const mode = cards.first().getByRole('button', { name: /^(?:Session|会话) ·/ })
      await mode.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const bounds = required(await menu.boundingBox())
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(required(page.viewportSize()).width)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await panel.isVisible()).toBe(true)
      expect(await mode.evaluate((element) => element === document.activeElement)).toBe(true)
    }
    const scrollEvidence: unknown[] = []
    for (const [locale, theme] of [
      ['en', 'light'],
      ['en', 'dark'],
      ['zh', 'light'],
      ['zh', 'dark'],
    ] as const) {
      localeTheme = `${locale}.${theme}`
      await host.ctx.settings.replace('locale', { preference: locale })
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await panel
        .getByRole('heading', { name: locale === 'en' ? 'ACP member settings' : 'ACP 成员设置', exact: true })
        .waitFor()
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const width of [1440, 390]) {
        setStage(`verify settings and menus ${width}px (${localeTheme})`)
        await page.setViewportSize({ width, height: 640 })
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        for (const card of await cards.all()) {
          expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
          const notice = card.locator('[data-member-mode-notice]')
          expect(await notice.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
          const bounds = required(await card.boundingBox())
          expect(bounds.width).toBeGreaterThan(0)
        }
        if (width === 390) {
          const first = required(await cards.first().boundingBox())
          const second = required(await cards.last().boundingBox())
          expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
        }
        await verifyMenu()
        const model = cards.first().locator('[data-acp-member-model] button')
        await model.click()
        const menu = page.getByRole('menu')
        await menu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).waitFor()
        expect(await menu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).isDisabled()).toBe(true)
        await page.keyboard.press('Escape')
        expect(await panel.isVisible()).toBe(true)
        if (screenshotDir !== undefined) {
          mkdirSync(screenshotDir, { recursive: true })
          await page.screenshot({
            path: join(screenshotDir, `team-settings.${locale}.${theme}.${width}.png`),
            fullPage: true,
            animations: 'disabled',
          })
        }
      }
      // Failed refresh preserves the visible settings but cannot leave stale controls writable.
      const failedRead = vi
        .spyOn(service, 'teamMembers')
        .mockRejectedValue(new Error('E2E_MEMBER_SETTINGS_UNAVAILABLE'))
      try {
        await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click()
        await panel.getByRole('alert').waitFor()
        expect(
          await cards.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-acp-managed-member')),
          ),
        ).toEqual(previousNames)
        await cards
          .first()
          .getByRole('button', { name: /^(?:Session|会话) ·/ })
          .click()
        const menu = page.getByRole('menu')
        await menu.getByRole('menuitem', { name: /^(?:Session Mode|Mode|模式)(?:\s|$)/ }).click()
        for (const option of await menu
          .getByRole('menuitem')
          .filter({ hasNotText: /Back to session settings|返回会话设置/ })
          .all())
          expect(await option.isDisabled()).toBe(true)
        await page.keyboard.press('Escape')
        await page.setViewportSize({ width: 390, height: 430 })
        const footer = panel.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).last()
        const footerBefore = required(await footer.boundingBox())
        const scroll = await cards.last().evaluate((element) => {
          let parent = element.parentElement
          while (parent !== null && parent.getAttribute('role') !== 'dialog') {
            if (getComputedStyle(parent).overflowY === 'auto' && parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop = parent.scrollHeight
              return { top: parent.scrollTop, height: parent.clientHeight, total: parent.scrollHeight }
            }
            parent = parent.parentElement
          }
          throw new Error('Native Modal content did not provide a scrollable surface')
        })
        expect(scroll.top).toBeGreaterThan(0)
        expect(await footer.boundingBox()).toEqual(footerBefore)
        expect(footerBefore.y + footerBefore.height).toBeLessThanOrEqual(430)
        scrollEvidence.push({ locale, theme, scroll, footer: footerBefore })
        if (screenshotDir !== undefined)
          await page.screenshot({
            path: join(screenshotDir, `team-settings.error.${locale}.${theme}.390.png`),
            fullPage: true,
            animations: 'disabled',
          })
      } finally {
        failedRead.mockRestore()
      }
      await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click()
      await panel.getByRole('alert').waitFor({ state: 'hidden' })
    }
    if (screenshotDir !== undefined)
      writeFileSync(join(screenshotDir, 'team-settings.scroll-geometry.json'), JSON.stringify(scrollEvidence, null, 2))
    await closeMemberSettings(page)
    const native = await openNativeMembers(page)
    for (const [name, description] of names) {
      const row = native.getByRole('treeitem').filter({ hasText: name })
      await row.waitFor()
      expect(await row.innerText()).toContain(description)
    }
    setStage('test assertions passed')
    passed = true
  } catch (error) {
    const failedStage = stage
    setStage('capture failure diagnostics')
    mkdirSync(failureDir, { recursive: true })
    const failureDetails = await Promise.all([
      evidencePage
        ?.locator('body')
        .innerText()
        .catch((cause) => `Could not read page text: ${String(cause)}`) ?? Promise.resolve('No page was created'),
      evidencePage
        ?.locator('[data-acp-team-panel]')
        .count()
        .catch(() => -1) ?? Promise.resolve(-1),
      evidencePage
        ?.locator('[data-acp-member-model] button')
        .count()
        .catch(() => -1) ?? Promise.resolve(-1),
      evidencePage
        ?.getByRole('menu')
        .count()
        .catch(() => -1) ?? Promise.resolve(-1),
    ])
    writeFileSync(
      join(failureDir, 'team-card-layout.failure.log'),
      [
        `stage: ${failedStage}`,
        `locale/theme: ${localeTheme}`,
        `error: ${String(error)}`,
        `team panel count: ${failureDetails[1]}`,
        `model trigger count: ${failureDetails[2]}`,
        `menu count: ${failureDetails[3]}`,
        'page text:',
        failureDetails[0],
      ].join('\n'),
    )
    await evidencePage
      ?.screenshot({ path: join(failureDir, 'team-card-layout.failure.png'), fullPage: true })
      .catch(() => undefined)
    throw error
  } finally {
    setStage('close browser')
    try {
      for (const driver of drivers) driver.dispose()
      await browser?.close()
    } finally {
      setStage('close host')
      await hostToClose?.close()
    }
    setStage('teardown complete')
    if (passed) {
      if (screenshotDir !== undefined) {
        mkdirSync(screenshotDir, { recursive: true })
        copyFileSync(stagePath, join(screenshotDir, 'team-card-layout.stages.log'))
      }
      rmSync(stagePath, { force: true })
    }
  }
})
