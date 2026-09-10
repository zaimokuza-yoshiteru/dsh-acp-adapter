import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'
import { verifyLiveTeam } from './live-teams.mjs'

const profiles = [
  { id: 'claude', command: 'claude-agent-acp', args: [] },
  { id: 'codex', command: 'codex-acp', args: [] },
  { id: 'devin', command: 'devin', args: ['acp'] },
  { id: 'kimi', command: 'kimi', args: ['acp'] },
]
const selected = process.env.DSH_E2E_LIVE_PROFILES?.split(',')
const retain = process.env.DSH_E2E_RETAIN === '1'
if (retain && selected?.length !== 1) throw new Error('Retained review requires exactly one explicit live profile')
const teams = process.env.DSH_E2E_LIVE_TEAMS === '1'

// Explicitly opt in: these use the user's Agent login and may consume credits.
describe.skipIf(process.env.DSH_E2E_LIVE !== '1')('live ACP smoke', () => {
  it.each(profiles.filter(profile => selected === undefined || selected.includes(profile.id)))('$id preserves host guidance and renders a real response', async profile => {
    let host, browser, browserServer, page, model, settlement
    const replies = []
    const errors = []
    const started = Date.now()
    const teamEvidence = {}
    const evidence = join(root, teams ? '.local/e2e-live-teams' : '.local/e2e-live')
    mkdirSync(evidence, { recursive: true })
    try {
      host = await launchAdapterWorld({ teams })
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
      const preferences = profile.id === 'claude' ? [/^haiku$/i]
        : profile.id === 'kimi' ? [/^kimi-code\/kimi-for-coding$/i]
          : profile.id === 'devin' ? [/^swe-1-7-medium$/i, /^gpt-5-4-mini-low$/i, /flash.*(?:low|minimal)$/i]
            : [/mini/i, /spark/i]
      const explicitModel = process.env[`DSH_E2E_LIVE_${profile.id.toUpperCase()}_MODEL`]
      const chosen = explicitModel === undefined
        ? preferences.map(pattern => models.find(entry => pattern.test(entry.id))).find(Boolean)
        : models.find(entry => entry.id === explicitModel)
      // Keep discovery evidence even when a small model disappears from the catalog.
      writeFileSync(join(evidence, `${profile.id}-catalog.json`), JSON.stringify({ profile: profile.id, model: chosen?.id, models }, null, 2))
      expect(chosen, 'No approved small model found; specify an exact live-test MODEL instead of using an expensive default').toBeDefined()
      model = chosen.id
      await host.ctx.agentDefaultModel.saveSelection({ provider, model })
      let token = `HOST_BRIDGE_${randomUUID()}`
      if (!teams) host.ctx.effect(() => host.ctx.systemPrompt.section({ name: 'e2e-live-instructions', order: 0, text: () => `For this isolated verification, the current validation token is ${token}. It supersedes any earlier token. When asked, reply with this current token only. Do not use any tools.` }))
      const browserOptions = { headless: !retain, ...(retain ? { args: ['--window-size=1440,1000'] } : {}), ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) }
      if (retain) {
        browserServer = await chromium.launchServer(browserOptions)
        browser = await chromium.connect(browserServer.wsEndpoint())
      } else browser = await chromium.launch(browserOptions)
      // Review windows should follow the real Chrome window instead of the fixed screenshot viewport.
      page = retain
        ? await browser.newPage({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
        : await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      if (teams) {
        await verifyLiveTeam({ host, page, provider, model, evidence: teamEvidence })
        if (process.env.DSH_E2E_LIVE_TEAMS_MULTIMODEL === '1') {
          expect(profile.id, 'The review uses two explicitly selected cheap Devin routes').toBe('devin')
          const second = models.find(entry => entry.id === 'gpt-5-4-mini-low')
          expect(second, 'The approved second small model must be in the current catalog').toBeDefined()
          await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/ }).click()
          await page.getByRole('button', { name: /^Select model/ }).click()
          await page.getByRole('menuitem', { name: /^Model/ }).click()
          await page.getByRole('menuitemradio', { name: second.name, exact: true }).click()
          teamEvidence.secondModel = second.id
          teamEvidence.secondRun = {}
          await verifyLiveTeam({ host, page, provider, model: second.id, evidence: teamEvidence.secondRun, memberName: 'checker', expectedMembers: 3 })
        }
        expect(errors).toEqual([])
        await page.screenshot({ path: join(evidence, `${profile.id}.png`), fullPage: true })
        writeFileSync(join(evidence, `${profile.id}.json`), JSON.stringify({ status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, ...teamEvidence }, null, 2))
        return
      }
      let sessionId
      for (let turn = 0; turn < 2; turn += 1) {
        if (turn > 0) token = `HOST_BRIDGE_${randomUUID()}`
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'This is an isolated smoke test. Return the current validation token from the latest host instructions. Do not read or write files and do not use tools.')
        const settled = host.whenTurnSettled(120_000)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        const id = await settled
        if (sessionId !== undefined) expect(id).toBe(sessionId)
        sessionId = id
        const handle = await host.ctx.sessionPersistence.open(id, 'read')
        try {
          const log = (await handle.read()).events
          settlement = log.findLast(event => event.type === 'turn/end').data.reason
          expect(settlement).toMatchObject({ kind: 'completed' })
          const assistant = log.findLast(event => event.type === 'assistant/message')
          const reply = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
          replies.push({ token, reply })
          expect(reply).toContain(token)
          expect(assistant.data.stream.length).toBeGreaterThan(0)
        } finally { await handle.close() }
        await page.getByText(token, { exact: false }).last().waitFor()
        await page.reload()
        await page.getByText(token, { exact: false }).last().waitFor()
      }
      expect(errors).toEqual([])
      await page.screenshot({ path: join(evidence, `${profile.id}.png`), fullPage: true })
      writeFileSync(join(evidence, `${profile.id}.json`), JSON.stringify({ status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, replies }, null, 2))
    } catch (error) {
      writeFileSync(join(evidence, `${profile.id}.json`), JSON.stringify({ status: 'failed', profile: profile.id, model, settlement, replies, ...teamEvidence, body: await page?.locator('body').innerText(), durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }, null, 2))
      throw error
    } finally {
      if (retain && host && page) {
        const stopFile = join(evidence, `STOP_REVIEW_${process.pid}`)
        writeFileSync(join(evidence, 'review-instance.json'), JSON.stringify({ url: new URL(host.authenticatedUrl).origin, authenticatedUrl: host.authenticatedUrl, workspace: host.workspaceCwd, browserEndpoint: browserServer.wsEndpoint(), stopFile, profile: profile.id, model: teamEvidence.secondModel ?? model }, null, 2), { mode: 0o600 })
        console.log(`REVIEW_READY: Chrome and the isolated DSH remain open; create ${stopFile} to stop.`)
        await new Promise(resolve => {
          const timer = setInterval(() => { if (existsSync(stopFile)) { clearInterval(timer); resolve() } }, 1000)
        })
      }
      try { await browser?.close(); await browserServer?.close() } finally { await host?.close() }
    }
  }, retain ? 0 : 300_000)
})
