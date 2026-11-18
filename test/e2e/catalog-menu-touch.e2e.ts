import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace } from '#host-support'
import { launchBrowser, type TestBrowser } from './browser.ts'
import { expectCatalogMenuFits } from './catalog-menu.helpers.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

// Electron's helper cannot emulate touch input; the Desktop checks are separate.
it.skipIf(Boolean(process.env.DSH_E2E_ELECTRON))(
  'keeps the native ACP catalog menu reachable through the 390px touch drawer without changing drafts',
  async () => {
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    let page: Page | undefined
    const evidence = join(root, '.local/rc1-catalog-menu/touch')
    mkdirSync(evidence, { recursive: true })
    const errors: string[] = []
    const requests: string[] = []
    const releaseRequests = host.ctx.on('session/event', (_session, event) => {
      if (event.type === 'request/header') requests.push(event.type)
    })
    let stage = 'setup'
    let passed = false
    try {
      browser = await launchBrowser({
        headless: true,
        ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
      })
      page = await browser.newPage({
        viewport: { width: 1680, height: 1000 },
        locale: 'en-US',
        timezoneId: 'Asia/Shanghai',
        hasTouch: true,
        isMobile: true,
      })
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      stage = 'open native drawer'
      await page.locator('[data-sidebar-opener]:visible').tap()
      const detail = await openAcpPluginDetail(page)
      await expect.poll(() => detail.evaluate((element) => element.closest('[inert]') === null)).toBe(true)
      const settingsBefore = host.ctx.settings.describe().find((item) => item.ns === 'dsh-acp-adapter')?.value
      const add = detail.getByRole('button', { name: 'Add Agent', exact: true })
      const menu = page.getByRole('menu')
      const touchPage = page
      for (const theme of ['light', 'dark'] as const) {
        stage = `${theme}: catalog menu`
        await host.ctx.settings.replace('ui-theme', { preference: theme })
        await expect.poll(() => touchPage.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
        await add.tap()
        await menu.waitFor({ state: 'visible' })
        await expectCatalogMenuFits(menu)
        await page.screenshot({ path: join(evidence, `catalog-390-${theme}.png`), animations: 'disabled' })

        // Exercise both a scrolling catalog row and the pinned manual entry.
        // Selection opens an unsaved editor; no Agent or model is launched.
        stage = `${theme}: select entry`
        await menu
          .getByRole('menuitem', { name: theme === 'light' ? /^Codex ·/ : 'Add manually', exact: theme === 'dark' })
          .tap()
        const name = detail.getByLabel('Display name', { exact: true })
        await name.waitFor({ state: 'visible' })
        const draft = `Unsent catalog draft ${theme}`
        await name.fill(draft)
        await add.tap()
        await menu.waitFor({ state: 'visible' })
        await expectCatalogMenuFits(menu)
        // The native viewport margin is outside the menu and contains no action.
        // A real touch outside dismisses without selecting or discarding the editor.
        await page.touchscreen.tap(2, 420)
        await menu.waitFor({ state: 'hidden' })
        expect(await name.inputValue()).toBe(draft)
        await page.screenshot({ path: join(evidence, `draft-390-${theme}.png`), animations: 'disabled' })
        await detail.getByRole('button', { name: 'Cancel', exact: true }).tap()
      }
      expect(host.ctx.settings.describe().find((item) => item.ns === 'dsh-acp-adapter')?.value).toEqual(settingsBefore)
      expect(requests).toEqual([])
      expect(errors).toEqual([])
      passed = true
    } finally {
      try {
        if (!passed && page !== undefined) {
          await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' })
          writeFileSync(join(evidence, 'failure.txt'), await page.locator('body').innerText())
        }
        writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed, stage, requests, errors }, null, 2))
      } finally {
        releaseRequests()
        try {
          await browser?.close()
        } finally {
          await host.close()
        }
      }
    }
  },
  90_000,
)
