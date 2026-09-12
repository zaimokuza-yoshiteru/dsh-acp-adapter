import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, it, expect, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

// These use the real host and plugin UI. Only the ACP peer is deterministic/keyless.
describe.each(['kimi', 'devin', 'codex', 'claude'])('Agent controls: %s', profile => {
  it.each(['response', 'deferred'])('shows %s options during the first turn, follows changes and unlocks on stop', async delivery => {
    const host = await launchAdapterWorld()
    let browser, page
    const errors = []
    const readyFile = join(host.workspaceCwd, 'controls-ready')
    const provider = `acp-${profile}`
    try {
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')],
        env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_CONTROLS_DELIVERY: delivery, MOCK_CONTROLS_READY_FILE: readyFile },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      page.setDefaultTimeout(10000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const controls = () => page.getByRole('button', { name: /^Agent ·/ })
      const send = async text => {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      const stopped = host.whenTurnSettled(30000)
      await send('E2E_CONTROLS_WAIT')
      await page.getByText('E2E_CONTROLS_RUNNING', { exact: true }).waitFor()
      if (delivery === 'response') {
        // No session/update has carried any controls: only session/new provided them.
        await controls().waitFor()
        expect(await controls().innerText()).toContain('Code')
      } else {
        expect(await controls().count()).toBe(0)
      }
      writeFileSync(readyFile, 'ready')
      await page.getByText('E2E_CONTROLS_UPDATED', { exact: false }).waitFor()
      await expect.poll(() => controls().innerText()).toMatch(/plan/i)
      // Leaving an active conversation must detach its subscription without stopping the Agent.
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await expect.poll(() => controls().count()).toBe(0)
      await page.getByText('E2E_CONTROLS_WAIT', { exact: true }).click()
      await expect.poll(() => controls().innerText()).toMatch(/plan/i)
      await controls().click()
      const ask = page.getByRole('menuitem', { name: 'Session Mode: Ask', exact: true })
      await ask.waitFor()
      expect(await ask.isDisabled()).toBe(true)
      await page.keyboard.press('Escape')
      // Reconnect while the same first turn is still running; no new prompt or reload.
      try {
        await page.context().setOffline(true)
        await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
      } finally { await page.context().setOffline(false) }
      await page.getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ }).waitFor({ state: 'hidden' })
      await expect.poll(() => controls().innerText()).toMatch(/plan/i)
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
      await stopped
      await controls().click()
      await expect.poll(() => ask.isDisabled()).toBe(false)
      await ask.click()
      await expect.poll(() => controls().innerText()).toMatch(/ask/i)
      // A blank conversation cannot inherit the previous session's options.
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await expect.poll(() => controls().count()).toBe(0)
      const next = host.whenTurnSettled(30000)
      await send('E2E_MESSAGE')
      await next
      if (delivery === 'response') await expect.poll(() => controls().innerText()).toContain('Code')
      expect(errors).toEqual([])
    } catch (error) {
      if (page) {
        const directory = join(root, '.local/e2e-failures')
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, `controls-${profile}-${delivery}.json`), JSON.stringify({ body: await page.locator('body').innerText(), errors }, null, 2))
        await page.screenshot({ path: join(directory, `controls-${profile}-${delivery}.png`) })
      }
      throw error
    } finally {
      try { await browser?.close() } finally { await host.close() }
    }
  })
})
