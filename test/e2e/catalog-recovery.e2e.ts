import { required } from './required.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

describe.each(['devin', 'kimi', 'claude', 'codex'])('catalog recovery: %s', profile => {
  it('updates the mounted picker after a failed probe and explicit recheck, keeping the original session', async () => {
    const host = await launchAdapterWorld()
    let browser!: TestBrowser
    const unavailable = join(host.workspaceCwd, 'agent-unavailable')
    try {
      const provider = `acp-${profile}`
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
        env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_UNAVAILABLE_FILE: unavailable },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
      const page = await newEnglishPage(browser)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const send = async (text: string) => {
        const settled = host.whenTurnSettled(30000)
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        return await settled
      }
      const id = await send('E2E_MESSAGE')
      const session = required(host.ctx.sessions.get(id))
      const before = session.snapshotEvents()
      writeFileSync(unavailable, 'offline')
      await (host.ctx.get('dshAcp') as AcpRemoteService).health({ recheck: true, agentId: profile })
      const catalog = await host.ctx.sessionController.modelCatalog()
      expect(catalog.failures.some(failure => failure.id === provider)).toBe(true)
      await page.getByRole('button', { name: /^Select model/ }).click()
      await page.getByRole('menuitem', { name: /^Model/ }).click()
      await expect.poll(() => page.getByRole('menuitemradio', { name: 'Mock Model A', exact: true }).count()).toBe(0)
      // Network return may itself reload a failed catalogue; recheck must still update it afterwards.
      try {
        await page.context().setOffline(true)
        await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
      } finally { await page.context().setOffline(false) }
      await page.getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ }).waitFor({ state: 'hidden' })
      rmSync(unavailable)
      await (host.ctx.get('dshAcp') as AcpRemoteService).health({ recheck: true, agentId: profile })
      await page.getByRole('menuitemradio', { name: 'Mock Model A', exact: true }).waitFor()
      expect(session.snapshotEvents()).toEqual(before)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      expect(await send('E2E_RECOVERED')).toBe(id)
      await page.getByText('E2E_RECOVERED_DONE', { exact: true }).waitFor()
      expect(errors).toEqual([])
    } finally { await browser?.close(); await host.close() }
  })
})
