import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { required } from './required.ts'
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
        'codebuddy-code': { name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'], env: {} },
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
      const service = host.ctx.get('dshAcp') as AcpRemoteService
      await service.health({ agentId: 'codex', recheck: true })
      const [first] = await host.ctx.llm.listModels('acp-codex')
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: required(first).id })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await page.getByRole('button', { name: 'View plan and quota' }).click()
      const panel = page.getByRole('region', { name: 'Plan and quota' })
      await panel.getByText('Plan', { exact: true }).waitFor({ timeout: 35_000 })
      await panel.getByRole('progressbar').first().waitFor({ timeout: 35_000 })
      await panel.getByRole('button', { name: 'Close plan details' }).click()
      const detail = await openAcpPluginDetail(page)
      const row = (id: string) => detail.locator(`[data-dsh-acp-account="${id}"]`)
      const buddy = row('codebuddy-code')
      await buddy
        .getByRole('link', { name: /usage guide/i })
        .first()
        .waitFor()
      expect(await buddy.locator('dt').count()).toBe(0)
      for (const id of ['codex', 'devin']) {
        await row(id).getByText('Plan', { exact: true }).waitFor({ timeout: 35_000 })
        if (id === 'codex') await row(id).getByRole('progressbar').first().waitFor({ timeout: 35_000 })
      }
      if (process.platform === 'darwin') {
        await row('antigravity').getByRole('button', { name: 'View plan and quota' }).click()
        await row('antigravity').getByText('Plan', { exact: true }).waitFor({ timeout: 65_000 })
        await row('antigravity').getByRole('progressbar').first().waitFor({ timeout: 65_000 })
      }
    } finally {
      await browser?.close()
      await host.close()
    }
  },
  165_000,
)
