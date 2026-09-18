import { required } from './required.ts'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold } from '#host-scaffold'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { root } from './scaffold.ts'

it('unloads and remounts ACP through the native plugin manager without restarting DSH', async () => {
  const host = await launchWebScaffold({ profile: { packages: [{ dir: root, enabled: true }] } })
  let browser!: TestBrowser
  const errors: string[] = []
  try {
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: {
      name: 'Lifecycle fixture', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin' },
    } } })
    const routed = () => host.ctx.llm.listProviders().some(row => row.id === 'acp-devin')
    await vi.waitFor(() => expect(routed()).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
    const page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string) => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }
    let settled = host.whenTurnSettled()
    await send('E2E_MESSAGE')
    await settled
    const controls = page.getByRole('button', { name: /^Session ·/ })
    await controls.waitFor()
    const manager = host.ctx.pluginManager
    const entry = required((await manager.listPlugins()).find(row => row.moduleName === '@zaimokuza/dsh-acp-adapter'))
    expect(entry.readOnlyReason).toBeUndefined()
    for (const active of [false, true]) {
      if (active) {
        settled = host.whenTurnSettled()
        await send('E2E_CONTROLS_WAIT')
        await page.getByText('E2E_CONTROLS_RUNNING', { exact: true }).waitFor()
      }
      expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
      await vi.waitFor(() => expect(routed()).toBe(false))
      await controls.waitFor({ state: 'hidden' })
      if (active) await settled
      expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
      await vi.waitFor(() => expect(routed()).toBe(true))
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      settled = host.whenTurnSettled()
      await send('E2E_MESSAGE')
      await settled
      await controls.waitFor()
    }
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
