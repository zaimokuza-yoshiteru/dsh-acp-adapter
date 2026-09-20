import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

// These use the real host and plugin UI. Only the ACP peer is deterministic/keyless.
describe.each(['kimi', 'devin', 'codex', 'claude'])('Agent controls: %s', profile => {
  it.each(['response', 'deferred'])('shows %s options during the first turn, follows changes and unlocks on stop', async delivery => {
    const host = await launchAdapterWorld()
    let browser!: TestBrowser
    let page!: Page
    const errors: string[] = []
    const consoleMessages: { type: string; text: string }[] = []
    let phase = 'setup'
    const readyFile = join(host.workspaceCwd, 'controls-ready')
    const provider = `acp-${profile}`
    try {
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
        env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_CONTROLS_DELIVERY: delivery, MOCK_CONTROLS_READY_FILE: readyFile },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => {
        if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() })
      })
      page.setDefaultTimeout(10000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const controls = () => page.getByRole('button', { name: /^Session ·/ })
      const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
      const ask = page.getByRole('menuitem', { name: /^Ask(?:\s|$)/ })
      const openControls = async () => {
        await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('false')
        await controls().click()
        await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('true')
        if (profile === 'codex' && delivery === 'response') {
          const directory = join(root, '.local/ui-review')
          mkdirSync(directory, { recursive: true })
          await page.screenshot({ path: join(directory, 'session-settings.png') })
        }
        await page.getByRole('menuitem', { name: /^Session Mode/ }).click()
        await ask.waitFor()
        if (profile === 'codex' && delivery === 'response') await page.screenshot({ path: join(root, '.local/ui-review/session-options.png') })
      }
      const send = async (text: string) => {
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
      phase = 'running options'
      await openControls()
      expect(await ask.isDisabled()).toBe(true)
      await page.keyboard.press('Escape')
      await ask.waitFor({ state: 'hidden' })
      // Reconnect while the same first turn is still running; no new prompt or reload.
      phase = 'reconnect'
      try {
        await page.context().setOffline(true)
        await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
      } finally { await page.context().setOffline(false) }
      await page.getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ }).waitFor({ state: 'hidden' })
      await expect.poll(() => controls().innerText()).toMatch(/plan/i)
      phase = 'stop'
      await stop.click()
      await stopped
      // Host turn/end precedes the browser's running projection and composer
      // layout update. Wait for native idle UI before clicking the menu anchor.
      await stop.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
      phase = 'stopped options'
      await openControls()
      await expect.poll(() => ask.isDisabled()).toBe(false)
      await page.getByRole('menuitem', { name: 'Back to session settings', exact: true }).click()
      await expect.poll(() => ask.count()).toBe(0)
      await page.getByRole('menuitem', { name: /^Session Mode/ }).click()
      await ask.click()
      await ask.waitFor({ state: 'hidden' })
      await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => controls().innerText()).toMatch(/ask/i)
      // A blank conversation cannot inherit the previous session's options.
      phase = 'new session'
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await expect.poll(() => controls().count()).toBe(0)
      const next = host.whenTurnSettled(30000)
      await send('E2E_MESSAGE')
      await next
      if (delivery === 'response') await expect.poll(() => controls().innerText()).toContain('Code')
      expect(errors).toEqual([])
      await page.context().tracing.stop()
    } catch (error) {
      if (page) {
        const directory = join(root, '.local/e2e-failures')
        mkdirSync(directory, { recursive: true })
        const prefix = join(directory, `controls-${profile}-${delivery}`)
        // Collect independently so a closed page cannot hide the original
        // failure or prevent the trace from being saved.
        const evidence = await Promise.allSettled([
          page.locator('body').innerText().then(body => writeFileSync(`${prefix}.json`, JSON.stringify({ phase, body, errors, consoleMessages, failure: String(error) }, null, 2))),
          page.screenshot({ path: `${prefix}.png`, timeout: 5000 }),
          page.context().tracing.stop({ path: `${prefix}.trace.zip` }),
        ])
        for (const result of evidence) if (result.status === 'rejected') console.warn('Could not save controls failure evidence:', result.reason)
      }
      throw error
    } finally {
      try { await browser?.close() } finally { await host.close() }
    }
  })
})
