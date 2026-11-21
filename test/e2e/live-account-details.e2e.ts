import { expect, it } from 'vitest'
import { connectFreshWorkspace } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { launchAdapterWorld } from './scaffold.ts'

// Opt in only with existing accounts. Do not record account values or capture the account page.
it.skipIf(process.env.DSH_E2E_LIVE_ACCOUNT_DETAILS !== '1')(
  'reads existing CLI plans on the plugin page and starts the macOS quota reader only on request',
  async () => {
    const host = await launchAdapterWorld()
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
    try {
      const agents = {
        codex: { name: 'Codex', command: process.env.DSH_E2E_LIVE_CODEX_ACP ?? 'codex-acp', args: [], env: {} },
        devin: { name: 'Devin', command: process.env.DSH_E2E_LIVE_DEVIN_COMMAND ?? 'devin', args: ['acp'], env: {} },
        ...(process.platform === 'darwin'
          ? {
              antigravity: {
                name: 'Antigravity',
                command: process.env.DSH_E2E_LIVE_AGY_COMMAND ?? 'agy',
                args: ['acp'],
                env: {},
              },
            }
          : {}),
      }
      await host.ctx.settings.replace('dsh-acp-adapter', { agents })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const detail = await openAcpPluginDetail(page)
      const row = (id: string) => detail.locator(`[data-dsh-acp-account="${id}"]`)
      for (const id of ['codex', 'devin']) {
        await expect
          .poll(
            async () => {
              const content = await row(id)
                .textContent({ timeout: 1000 })
                .catch(() => '')
              return content?.includes('Plan · ') && (id === 'devin' || content.includes('% remaining'))
            },
            { timeout: 35_000 },
          )
          .toBe(true)
      }
      if (process.platform === 'darwin') {
        await row('antigravity').getByRole('button', { name: 'View plan and quota' }).click()
        await expect
          .poll(
            async () => {
              const content = await row('antigravity').textContent()
              return content?.includes('Plan · ') && content.includes('% remaining')
            },
            { timeout: 65_000 },
          )
          .toBe(true)
      }
    } finally {
      await browser?.close()
      await host.close()
    }
  },
  165_000,
)
