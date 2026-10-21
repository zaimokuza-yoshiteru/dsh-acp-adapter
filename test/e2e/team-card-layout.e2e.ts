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

it('keeps long teammate cards and reserved notices aligned in both languages and themes', async () => {
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
          tool: 'spawn_teammate',
          args: { name, description, prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' },
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
    const members = host.ctx.agentTeams.listMembers(lead).filter((m) => m.role === 'teammate')
    const memberIds = new Set<string>(members.map((member) => member.id))
    const pendingShells = acpPermissionAudit(host, 'asked').filter(
      (entry) => memberIds.has(entry.sessionId) && entry.data.toolCall.toolCallId === 'member-shell',
    )
    expect(pendingShells).toHaveLength(2)
    expect(new Set(pendingShells.map((entry) => entry.sessionId)).size).toBe(2)
    setStage('reject teammate approvals')
    await approvals.getByRole('button', { name: 'Reject all', exact: true }).click()
    setStage('wait for teammate sessions to stop')
    await expect
      .poll(async () =>
        Promise.all(
          members.map(
            async (m) => (await (host.ctx.get('dshAcp') as AcpRemoteService).agentSessionSnapshot(m.id)).freshness,
          ),
        ),
      )
      .toEqual(['stale', 'stale'])
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
    const panel = page.locator('[data-acp-team-management], [data-acp-team-panel]')
    setStage('open team management panel')
    await panel.getByRole('button', { name: 'Manage members · 2', exact: true }).click()
    const cards = panel.locator('[data-acp-managed-member]')
    setStage('wait for teammate cards')
    await expect.poll(() => cards.count()).toBe(2)
    await page.getByText('Loading ACP member settings…', { exact: true }).waitFor({ state: 'hidden' })
    const before = required(await cards.first().boundingBox())
    const previousCardNames = await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-acp-managed-member')),
    )
    // Electron and Chromium can round the two half-pixel borders differently.
    expect(before.height + 1).toBeGreaterThanOrEqual(220)
    setStage('configure teammate model and mode')
    await (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, members[0].id, 'mock-model-b')
    await (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberMode(lead.id, members[0].id, 'plan')
    const service = host.ctx.get('dshAcp') as AcpRemoteService
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
      const loading = page.getByText('Loading ACP member settings…', { exact: true })
      await loading.waitFor()
      expect(await cards.count()).toBe(2)
      expect(
        await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-acp-managed-member')),
        ),
      ).toEqual(previousCardNames)
    } finally {
      releaseRefresh()
      heldRefresh.mockRestore()
    }
    await page.getByText('Loading ACP member settings…', { exact: true }).waitFor({ state: 'hidden' })
    await cards
      .first()
      .getByRole('button', { name: /^(?:Session|会话) · Plan$/ })
      .waitFor()
    expect(await cards.first().boundingBox()).toMatchObject({ x: before.x, y: before.y, width: before.width })
    const notice = cards.first().locator('[data-member-mode-notice]')
    expect(await notice.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')
    expect(required(await notice.boundingBox()).height).toBeGreaterThanOrEqual(18)
    expect(await notice.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    const modeBoxes = await Promise.all(
      (await cards.getByRole('button', { name: /^(?:Session|会话) ·/ }).all()).map((b) => b.boundingBox()),
    )
    expect(required(modeBoxes[0]).y).toBe(required(modeBoxes[1]).y)
    const verifyTooltips = async () => {
      let tooltipIndex = 0
      for (const button of await cards.getByRole('button', { name: /^(?:Session|会话) ·/ }).all()) {
        setStage(`verify tooltip ${tooltipIndex} (${localeTheme})`)
        await button.hover()
        const tooltip = page.getByRole('tooltip').filter({ hasText: /Configure modes and options|设置当前 Agent 会话/ })
        await tooltip.waitFor()
        expect(await tooltip.evaluate((el) => el.parentElement === document.body)).toBe(true)
        const anchor = required(await button.boundingBox())
        const bubble = required(await tooltip.boundingBox())
        const viewport = required(page.viewportSize())
        expect(bubble.x).toBeGreaterThanOrEqual(0)
        expect(bubble.x + bubble.width).toBeLessThanOrEqual(viewport.width)
        expect(bubble.x).toBeLessThan(anchor.x + anchor.width)
        expect(bubble.x + bubble.width).toBeGreaterThan(anchor.x)
        expect(
          Math.min(Math.abs(bubble.y + bubble.height - anchor.y), Math.abs(bubble.y - anchor.y - anchor.height)),
        ).toBeLessThanOrEqual(9)
        expect(await page.locator('[data-acp-team-panel]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
          true,
        )
        await page.mouse.move(0, 0)
        await tooltip.waitFor({ state: 'hidden' })
        tooltipIndex += 1
      }
    }
    for (const [locale, theme, heading] of [
      ['en', 'light', 'Manage members'],
      ['en', 'dark', 'Manage members'],
      ['zh', 'light', '成员管理'],
      ['zh', 'dark', '成员管理'],
    ]) {
      localeTheme = `${locale}.${theme}`
      setStage(`set locale and theme (${localeTheme})`)
      await host.ctx.settings.replace('locale', { preference: locale })
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      setStage(`wait for heading (${localeTheme})`)
      await panel.getByText(heading, { exact: true }).waitFor()
      setStage(`wait for color scheme (${localeTheme})`)
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      const panelSurface = page.locator('[data-acp-team-panel][data-menu-material="translucent"]')
      const inspectSurface = (element: Element) => {
        const material = element.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')
        if (material === null) throw new Error('native MenuSurface is missing its material layer')
        const rootStyle = getComputedStyle(element)
        const materialStyle = getComputedStyle(material)
        return {
          portal: element.parentElement === document.body,
          materialContract: element.getAttribute('data-menu-material'),
          materialTag: material.tagName,
          materialAriaHidden: material.getAttribute('aria-hidden'),
          rootFilter: rootStyle.backdropFilter,
          rootBackground: rootStyle.backgroundColor,
          rootRadius: rootStyle.borderRadius,
          materialFilter: materialStyle.backdropFilter,
          materialBackground: materialStyle.backgroundColor,
          materialRadius: materialStyle.borderRadius,
          materialPointerEvents: materialStyle.pointerEvents,
        }
      }
      const modelMenuTrigger = cards.first().locator('[data-acp-member-model] button')
      setStage(`open native model menu (${localeTheme})`)
      await modelMenuTrigger.click()
      const nativeModelMenu = page.getByRole('menu').last()
      setStage(`wait for native model menu (${localeTheme})`)
      await nativeModelMenu.waitFor()
      setStage(`compare menu materials (${localeTheme})`)
      const teamSurface = await panelSurface.evaluate(inspectSurface)
      const modelSurface = await nativeModelMenu.evaluate(inspectSurface)
      expect(teamSurface.portal).toBe(true)
      expect(teamSurface).toEqual(modelSurface)
      // Native MenuSurface puts blur on its material child; its positioning root remains unfiltered.
      expect(teamSurface.rootFilter).toBe('none')
      expect(teamSurface.materialFilter).toMatch(/blur\([1-9][\d.]*px\)/)
      expect(teamSurface.materialBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(teamSurface.materialPointerEvents).toBe('none')
      if (screenshotDir !== undefined) {
        setStage(`capture menu comparison (${localeTheme})`)
        mkdirSync(screenshotDir, { recursive: true })
        await page.screenshot({
          path: join(screenshotDir, `team-members-native-model-menu.${locale}.${theme}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      }
      setStage(`close native model menu (${localeTheme})`)
      await page.keyboard.press('Escape')
      await nativeModelMenu.waitFor({ state: 'hidden' })
      await expect.poll(() => panelSurface.isVisible()).toBe(true)
      setStage(`verify tooltips (${localeTheme})`)
      await verifyTooltips()
      if (screenshotDir !== undefined) {
        setStage(`capture team panel (${localeTheme})`)
        await panelSurface.screenshot({
          path: join(screenshotDir, `team-members.${locale}.${theme}.png`),
          animations: 'disabled',
        })
      }
    }
    setStage('verify narrow layout')
    await page.setViewportSize({ width: 390, height: 900 })
    await verifyTooltips()
    expect(await page.locator('[data-acp-team-panel]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const narrow = await Promise.all((await cards.all()).map((card) => card.boundingBox()))
    expect(required(narrow[1]).y).toBeGreaterThanOrEqual(required(narrow[0]).y + required(narrow[0]).height)
    if (screenshotDir !== undefined) {
      mkdirSync(screenshotDir, { recursive: true })
      await page.screenshot({
        path: join(screenshotDir, 'team-members.narrow.png'),
        fullPage: true,
        animations: 'disabled',
      })
    }

    // Drive the real native roster through provisioning -> failed. Only the
    // provider activation is gated: DSH owns events, persistence and projection.
    const diagnostic = 'Fixture provider could not start: /workspace/a-very-long-directory-name/worker-entry-point.ts'
    let releaseActivation!: () => void
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const activation = vi.spyOn(host.ctx.subagents, 'startActivation').mockImplementationOnce(async () => {
      await activationGate
      throw new Error(diagnostic)
    })
    const spawn = host.ctx.agentTeams
      .spawnTeammate(lead, {
        name: 'unavailable-worker',
        description: 'Native provisioning and failure diagnostics',
        provider: 'acp:devin',
        context: 'fresh',
        prompt: [{ type: 'text', text: 'UI failure fixture; no model request should run.' }],
        signal: new AbortController().signal,
      })
      .then(
        () => {
          throw new Error('Fixture activation unexpectedly succeeded')
        },
        (error: unknown) => error,
      )
    const unavailable = panel.locator('[data-acp-managed-member="unavailable-worker"]')
    const scroller = page.locator('[data-acp-team-scroll-body]')
    const inspectScrollSurface = () =>
      page.locator('[data-acp-team-panel]').evaluate((element) => {
        const material = element.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')
        const body = element.querySelector<HTMLElement>('[data-acp-team-scroll-body]')
        const toolbar = element.querySelector<HTMLElement>('[data-acp-team-toolbar]')
        if (material === null || body === null || toolbar === null) throw new Error('Missing team scroll surface')
        const rect = (node: Element) => {
          const box = node.getBoundingClientRect()
          return { top: box.top, right: box.right, bottom: box.bottom, left: box.left }
        }
        return {
          panel: rect(element),
          material: rect(material),
          toolbar: rect(toolbar),
          body: rect(body),
          rootScrollTop: element.scrollTop,
          rootOverflow: getComputedStyle(element).overflowY,
          bodyScrollTop: body.scrollTop,
          bodyOverflow: getComputedStyle(body).overflowY,
          bodyClientHeight: body.clientHeight,
          bodyScrollHeight: body.scrollHeight,
        }
      })
    const scrollEvidence: unknown[] = []
    try {
      setStage('verify native provisioning and failure states at 390px')
      await unavailable.waitFor()
      for (const phase of ['provisioning', 'failed'] as const) {
        if (phase === 'failed') {
          releaseActivation()
          expect(await spawn).toMatchObject({ message: diagnostic })
          await unavailable.getByRole('alert').waitFor()
        }
        for (const locale of ['en', 'zh']) {
          for (const theme of ['light', 'dark']) {
            localeTheme = `${locale}.${theme}`
            await host.ctx.settings.replace('locale', { preference: locale })
            await host.ctx.settings.replace('ui-theme', { preference: theme })
            await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
            await unavailable
              .getByText(
                locale === 'en' ? (phase === 'failed' ? 'Failed' : 'Starting') : phase === 'failed' ? '失败' : '创建中',
                { exact: true },
              )
              .waitFor()
            expect(
              await unavailable
                .getByRole('button', {
                  name: locale === 'en' ? 'Open unavailable-worker’s session' : '查看 unavailable-worker 的会话',
                  exact: true,
                })
                .isDisabled(),
            ).toBe(true)
            expect(
              await unavailable.locator(`[data-state="${phase === 'failed' ? 'error' : 'ongoing'}"]`).count(),
            ).toBe(1)
            expect(await cards.first().locator('[data-state="idle"]').count()).toBe(1)
            expect(await cards.first().locator('[data-state="done"]').count()).toBe(0)
            expect(await unavailable.getByRole('alert').count()).toBe(phase === 'failed' ? 1 : 0)
            if (phase === 'failed') expect(await unavailable.getByRole('alert').innerText()).toBe(diagnostic)
            expect(await unavailable.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
            expect(await page.locator('[data-acp-team-panel]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
              true,
            )
            // The native material belongs to the stationary MenuSurface, while
            // only its body scrolls. Computed colors alone miss a layer that
            // scrolls offscreen and leaves the bottom of the panel transparent.
            await scroller.evaluate((element) => {
              element.scrollTop = 0
            })
            const initialSurface = await inspectScrollSurface()
            expect(initialSurface.bodyScrollHeight).toBeGreaterThan(initialSurface.bodyClientHeight)
            const verifyScrollSurface = (surface: Awaited<ReturnType<typeof inspectScrollSurface>>) => {
              expect(surface.rootScrollTop).toBe(0)
              expect(surface.rootOverflow).toBe('hidden')
              expect(surface.bodyOverflow).toBe('auto')
              for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
                expect(Math.abs(surface.material[edge] - surface.panel[edge])).toBeLessThanOrEqual(1)
                expect(Math.abs(surface.toolbar[edge] - initialSurface.toolbar[edge])).toBeLessThanOrEqual(1)
              }
              expect(surface.toolbar.top).toBeGreaterThanOrEqual(surface.panel.top)
              expect(surface.toolbar.bottom).toBeLessThanOrEqual(surface.body.top)
              expect(surface.body.bottom).toBeLessThanOrEqual(surface.panel.bottom)
            }
            verifyScrollSurface(initialSurface)
            scrollEvidence.push({ phase, locale, theme, fraction: 0, ...initialSurface })
            for (const fraction of [0.5, 1]) {
              await scroller.evaluate((element, fraction) => {
                element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction
              }, fraction)
              const surface = await inspectScrollSurface()
              expect(surface.bodyScrollTop).toBeGreaterThan(0)
              verifyScrollSurface(surface)
              if (fraction === 1) {
                const memberBox = required(await unavailable.boundingBox())
                expect(memberBox.y).toBeGreaterThanOrEqual(surface.body.top - 1)
                expect(memberBox.y + memberBox.height).toBeLessThanOrEqual(surface.body.bottom + 1)
              }
              scrollEvidence.push({ phase, locale, theme, fraction, ...surface })
            }
            await scroller.evaluate((element) => {
              element.scrollTop = 0
            })
            if (screenshotDir !== undefined) {
              await page.screenshot({
                path: join(screenshotDir, `team-members.${phase}.${locale}.${theme}.390.png`),
                fullPage: true,
                animations: 'disabled',
              })
              const scrollTop = await scroller.evaluate((element) => element.scrollTop)
              try {
                await unavailable.scrollIntoViewIfNeeded()
                verifyScrollSurface(await inspectScrollSurface())
                await page.screenshot({
                  path: join(screenshotDir, `team-members.${phase}.${locale}.${theme}.390.detail.png`),
                  fullPage: true,
                  animations: 'disabled',
                })
              } finally {
                await scroller.evaluate((element, top) => {
                  element.scrollTop = top
                }, scrollTop)
              }
            }
          }
        }
      }
      if (screenshotDir !== undefined) {
        writeFileSync(join(screenshotDir, 'team-members.scroll-geometry.json'), JSON.stringify(scrollEvidence, null, 2))
      }
    } finally {
      releaseActivation()
      await spawn
      activation.mockRestore()
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
