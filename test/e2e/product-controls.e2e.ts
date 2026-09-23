import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'

it('refreshes member controls during a running lead, retries roster failures and opens the native sidebar', async () => {
  const host = await launchAdapterWorld({ teams: true })
  let browser: TestBrowser | undefined
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { devin: {
      name: 'ACP controls', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_MCP_HTTP: '1' },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    // A blank composer has no session-header extension point yet.
    const initialTurn = host.whenTurnSettled(30_000)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await initialTurn
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const failedRoster = vi.spyOn(service, 'teamMembers').mockRejectedValue(new Error('E2E_ROSTER_UNAVAILABLE'))
    try {
      await page.reload()
      await page.getByRole('button', { name: 'Manage members · 0', exact: true }).click()
      await page.getByText('Cannot read member state. Refresh to retry.', { exact: true }).waitFor()
    } finally { failedRoster.mockRestore() }
    await page.getByRole('dialog', { name: 'Manage members', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => page.locator('[data-acp-team-management]').count()).toBe(0)
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, 'E2E_TEAM_START_HOLD')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop generating', exact: true }).first().waitFor()
    const trigger = page.getByRole('button', { name: 'Manage members · 1', exact: true })
    await trigger.waitFor()
    // The held lead cannot finish on its own. The control must update before it stops.
    const url = page.url()
    await trigger.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Manage members', exact: true })
    await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await panel.getByRole('button', { name: 'Open calculator’s session', exact: true }).click()
    await page.locator('[data-sidebar-chat]').waitFor()
    expect(page.url()).toBe(url)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-acp-team-panel]').count()).toBe(0)
  } finally {
    await browser?.close()
    await host.close()
  }
})
