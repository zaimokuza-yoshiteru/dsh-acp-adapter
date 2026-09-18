import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

// Explicit opt-in: one real ACP turn in an isolated temporary workspace.
it.skipIf(process.env.DSH_E2E_LIVE_STREAM !== '1')('renders a real Codex shell call through native Bash live and after reload', async () => {
  const host = await launchAdapterWorld()
  let browser
  const errors = []
  try {
    await host.ctx.settings.replace('dsh-acp', { agents: { codex: { name: 'Codex', command: 'codex-acp', args: [] } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === 'acp-codex')).toBe(true))
    const model = process.env.DSH_E2E_LIVE_CODEX_MODEL
    expect(model, 'Choose an explicit live model').toBeTruthy()
    expect((await host.ctx.llm.listModels('acp-codex')).some(m => m.id === model)).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model })
    browser = await chromium.launch({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL ?? 'chrome' })
    const page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(),
      'For this UI verification, use your shell tool exactly once to execute printf ACP_STREAM_NATIVE_OK. Do not read or write files, access the network, or call other tools. Then reply with ACP_STREAM_NATIVE_DONE.')
    const settled = host.whenTurnSettled(120_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await settled
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      const counter = page.locator('[data-turn-process-tool-calls="1"]')
      await counter.waitFor()
      if (await counter.getAttribute('aria-expanded') === 'false') await counter.click()
      const call = page.locator('[data-chat-call-id^="acp:"]')
      const tool = call.locator('[data-variant="bash"]')
      await tool.waitFor()
      expect(await tool.innerText()).toContain('Bash')
      await tool.click()
      await call.locator('[data-terminal]').getByText('ACP_STREAM_NATIVE_OK', { exact: true }).first().waitFor()
    }
    expect(errors).toEqual([])
    const directory = join(root, '.local/main-stream-review')
    mkdirSync(directory, { recursive: true })
    await page.screenshot({ path: join(directory, 'real-codex.png'), fullPage: true })
    writeFileSync(join(directory, 'real-codex.json'), JSON.stringify({ model, sessionId: id, status: 'passed', toolCalls: 1, errors }, null, 2))
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0]
    if (page) {
      mkdirSync(join(root, '.local/main-stream-review'), { recursive: true })
      await page.screenshot({ path: join(root, '.local/main-stream-review/real-failure.png'), fullPage: true })
      console.error(await page.locator('body').innerText(), errors)
    }
    throw error
  } finally { await browser?.close(); await host.close() }
}, 180_000)
