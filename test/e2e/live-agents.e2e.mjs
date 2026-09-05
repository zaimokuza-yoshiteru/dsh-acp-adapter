import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

const profiles = [
  { id: 'claude', command: 'claude-agent-acp', args: [] },
  { id: 'codex', command: 'codex-acp', args: [] },
  { id: 'devin', command: 'devin', args: ['acp'] },
  { id: 'kimi', command: 'kimi', args: ['acp'] },
]
const selected = process.env.DSH_E2E_LIVE_PROFILES?.split(',')

// Explicitly opt in: these use the user's Agent login and may consume credits.
describe.skipIf(process.env.DSH_E2E_LIVE !== '1')('live ACP smoke', () => {
  it.each(profiles.filter(profile => selected === undefined || selected.includes(profile.id)))('$id preserves host guidance and renders a real response', async profile => {
    let host, browser, page, model, reply, settlement
    const errors = []
    const started = Date.now()
    const evidence = join(root, '.local/e2e-live')
    mkdirSync(evidence, { recursive: true })
    try {
      host = await launchAdapterWorld()
      const provider = `acp-${profile.id}`
      const envKeys = (process.env[`DSH_E2E_LIVE_${profile.id.toUpperCase()}_ENV_KEYS`] ?? '').split(',').filter(Boolean)
      const env = Object.fromEntries(envKeys.map(key => {
        if (process.env[key] === undefined) throw new Error(`Explicit live-test environment variable is absent: ${key}`)
        return [key, process.env[key]]
      }))
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile.id]: { name: profile.id, command: profile.command, args: profile.args, env } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(true))
      const models = await host.ctx.llm.listModels(provider)
      expect(models.length, 'Agent must return an authenticated model catalog').toBeGreaterThan(0)
      const preferences = profile.id === 'claude' ? [/haiku/i, /sonnet/i]
        : profile.id === 'kimi' ? [/fast/i, /coding/i]
          : [/(?:^|[-_\s])mini(?:$|[-_\s])/i, /flash/i, /haiku/i, /spark/i]
      model = (preferences.map(pattern => models.find(entry => pattern.test(`${entry.id} ${entry.name}`))).find(Boolean)
        ?? models.find(entry => entry.id === 'default') ?? models[0]).id
      writeFileSync(join(evidence, `${profile.id}-catalog.json`), JSON.stringify({ profile: profile.id, model, models }, null, 2))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model })
      host.ctx.effect(() => host.ctx.systemPrompt.section({ name: 'e2e-live-instructions', order: 0, text: 'For this isolated verification, the validation token is HOST_BRIDGE_OK. When asked, reply with that token only. Do not use any tools.' }))
      browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'This is an isolated smoke test. Return the validation token from the current host instructions. Do not read or write files and do not use tools.')
      const settled = host.whenTurnSettled(120_000)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const id = await settled
      const handle = await host.ctx.sessionPersistence.open(id, 'read')
      try {
        const log = await handle.read()
        settlement = log.findLast(event => event.type === 'turn/end').data.reason
        expect(settlement).toMatchObject({ kind: 'completed' })
        const assistant = log.findLast(event => event.type === 'assistant/message')
        reply = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        expect(reply).toContain('HOST_BRIDGE_OK')
        expect(assistant.data.stream.length).toBeGreaterThan(0)
      } finally { await handle.close() }
      await page.getByText('HOST_BRIDGE_OK', { exact: false }).last().waitFor()
      await page.reload()
      await page.getByText('HOST_BRIDGE_OK', { exact: false }).last().waitFor()
      expect(errors).toEqual([])
      writeFileSync(join(evidence, `${profile.id}.json`), JSON.stringify({ status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, reply }, null, 2))
    } catch (error) {
      writeFileSync(join(evidence, `${profile.id}.json`), JSON.stringify({ status: 'failed', profile: profile.id, model, settlement, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }, null, 2))
      throw error
    } finally {
      try { await browser?.close() } finally { await host?.close() }
    }
  }, 180_000)
})
