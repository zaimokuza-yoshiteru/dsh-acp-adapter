import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { connectFreshWorkspace } from '#host-support'
import { supportsLocalApprovalReview } from '../../src/contract/approval-review.ts'
import { en, zh } from '../../src/client/ui/locales.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it.skipIf(!supportsLocalApprovalReview(process.platform))(
  'shows a checked CLI version that cannot review requests in English and Chinese plugin details',
  async () => {
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    try {
      const output = process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/review-version-settings')
      mkdirSync(output, { recursive: true })
      const command = join(host.workspaceCwd, 'opencode')
      const fixture = pathToFileURL(join(root, 'test/mock-agent/mock-agent.ts')).href
      writeFileSync(
        command,
        [
          '#!' + process.execPath,
          "if (process.argv[2] === '--version') console.log('fixture launcher')",
          'else import(' + JSON.stringify(fixture) + ')',
        ].join('\n'),
        { mode: 0o700 },
      )
      const name = 'OpenCode'
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: {
          local: {
            name,
            command,
            args: ['acp'],
            env: {
              HOME: host.workspaceCwd,
              MOCK_AGENT_NAME: 'OpenCode',
              MOCK_SCENARIO: 'regression',
            },
          },
        },
      })

      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const english = await openAcpPluginDetail(page)
      const englishRegion = english.getByRole('region', { name: en.aiApproval, exact: true })
      const toggle = englishRegion.getByRole('switch', { name: en.aiApproval, exact: true })
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      const card = english.locator('[data-dsh-acp-agent="local"]')
      await card.getByRole('button', { name: 'Re-check', exact: true }).click()
      await card.getByText('Check passed', { exact: true }).waitFor()
      const message = (locale: typeof en) =>
        locale.reviewVersionUnsupported.replace('{name}', name).replace('{version}', '1.0.0')
      const notice = englishRegion.getByText(message(en), { exact: true })
      expect(await notice.count()).toBe(0)
      await toggle.click()
      await notice.waitFor()
      expect(await englishRegion.getByRole('button', { name: en.reviewModelFor.replace('{name}', name) }).count()).toBe(
        0,
      )
      await notice.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, 'review-version-en.png'), animations: 'disabled' })

      await host.ctx.settings.replace('locale', { preference: 'zh' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      const chinese = await openAcpPluginDetail(page, 'zh')
      const chineseRegion = chinese.getByRole('region', { name: zh.aiApproval, exact: true })
      const chineseNotice = chineseRegion.getByText(message(zh), { exact: true })
      await chineseNotice.waitFor()
      await chineseNotice.scrollIntoViewIfNeeded()
      expect(await chineseRegion.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: join(output, 'review-version-zh.png'), animations: 'disabled' })
      await chineseRegion.getByRole('switch', { name: zh.aiApproval, exact: true }).click()
      await chineseNotice.waitFor({ state: 'hidden' })
    } finally {
      try {
        await browser?.close()
      } finally {
        await host.close()
      }
    }
  },
  120_000,
)
