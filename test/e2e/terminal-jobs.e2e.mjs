import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

// All Agent profiles use the same real ACP terminal requests and native UI.
// File-controlled processes make completion independent of model speed.
describe.each(['claude', 'codex', 'devin', 'kimi'])('native terminal jobs: %s', profile => {
  it('shows running jobs across reload, isolates owners, and settles without extra model turns', async () => {
    const host = await launchAdapterWorld()
    let browser, page
    const errors = []
    const observed = []
    const provider = `acp-${profile}`
    const agentLog = join(host.workspaceCwd, 'jobs-agent.log')
    try {
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath,
        args: [join(root, 'test/mock-agent/mock-agent.mjs')],
        env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_LOG: agentLog },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      host.ctx.on('llm/stream', (request, next) => { if (request.provider === provider) observed.push(request); return next() })
      browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      let sent = 0
      async function send(target, text) {
        await writeComposerDraft(target, target.locator('[data-composer-input]').first(), text)
        const settled = host.whenTurnSettled(30_000)
        await target.getByRole('button', { name: 'Send message', exact: true }).click()
        sent += 1
        const id = await settled
        expect(observed).toHaveLength(sent)
        return id
      }
      const id = await send(page, 'E2E_JOB_START')
      const owner = host.ctx.agents.get(id)
      const jobs = () => host.ctx.jobs.list(owner).filter(job => job.kind === 'acp-terminal')
      const latestFixture = () => JSON.parse(readFileSync(agentLog, 'utf8').split('\n').filter(line => line.includes('regression job=')).at(-1).split('regression job=')[1])
      await expect.poll(() => jobs().length).toBe(1)
      const first = jobs()[0]
      const fixture = latestFixture()
      await expect.poll(() => existsSync(fixture.readyFile)).toBe(true)
      expect(first.ownerSession).toBe(id)
      const running = page.getByRole('button', { name: '1 background job running', exact: true })
      await running.waitFor()
      await running.click()
      const list = page.getByRole('list', { name: 'Background jobs', exact: true })
      expect(await list.innerText()).toContain('acp-terminal')
      expect(await list.innerText()).toContain('E2E_JOB_TICK')
      await page.reload()
      await running.waitFor()
      expect(jobs().map(job => job.id)).toEqual([first.id])

      // A different session must neither see nor be allowed to cancel this job.
      const otherPage = await newEnglishPage(browser)
      try {
        await otherPage.goto(host.authenticatedUrl)
        await otherPage.getByRole('button', { name: 'New session', exact: true }).last().click()
        const otherId = await send(otherPage, 'E2E_JOB_OTHER')
        expect(otherId).not.toBe(id)
        expect(host.ctx.jobs.list(host.ctx.agents.get(otherId))).toEqual([])
        expect(() => host.ctx.jobs.kill(first.id, host.ctx.agents.get(otherId))).toThrow()
        expect(await otherPage.getByRole('button', { name: /background job/ }).count()).toBe(0)
      } finally { await otherPage.close() }

      // Finish while disconnected: the native control baseline must recover
      // the settled status without resending a prompt or creating a new job.
      try {
        await page.context().setOffline(true)
        await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
        writeFileSync(fixture.stopFile, '0')
        await expect.poll(() => host.ctx.jobs.get(first.id, owner).status).toBe('completed')
      } finally { await page.context().setOffline(false) }
      await page.getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ }).waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '1 background job', exact: true }).waitFor()
      expect(host.ctx.jobs.get(first.id, owner).reported).toBe(true)
      expect(jobs().map(job => job.id)).toEqual([first.id])
      await page.reload()
      await page.getByRole('button', { name: '1 background job', exact: true }).click()
      expect(await list.innerText()).toContain('exit code: 0')
      expect(observed).toHaveLength(sent)
      await send(page, 'E2E_JOB_READ')
      await expect.poll(() => page.locator('body').innerText()).toContain('E2E_JOB_OUTPUT {"output":"E2E_JOB_TICK')
      expect(host.ctx.jobs.get(first.id, owner).status).toBe('completed')

      // Nonzero exit is failure, not completion, and uses the same native row.
      await send(page, 'E2E_JOB_START')
      const failed = jobs().at(-1)
      const failFixture = latestFixture()
      await expect.poll(() => existsSync(failFixture.readyFile)).toBe(true)
      writeFileSync(failFixture.stopFile, '7')
      await expect.poll(() => host.ctx.jobs.get(failed.id, owner).status).toBe('failed')
      expect(host.ctx.jobs.get(failed.id, owner).detail).toContain('7')
      expect(host.ctx.jobs.get(failed.id, owner).reported).toBe(true)
      await send(page, 'E2E_JOB_READ')

      // Native cancellation operates on the same terminal still owned by ACP.
      await send(page, 'E2E_JOB_START')
      const nativeKilled = jobs().at(-1)
      await expect.poll(() => existsSync(latestFixture().readyFile)).toBe(true)
      host.ctx.jobs.kill(nativeKilled.id, owner, 'e2e native cancellation')
      expect(host.ctx.jobs.get(nativeKilled.id, owner).status).toBe('stopping')
      await expect.poll(() => host.ctx.jobs.get(nativeKilled.id, owner).status).toBe('killed')
      await send(page, 'E2E_JOB_READ')

      // ACP cancellation publishes the same stopping/terminal lifecycle.
      await send(page, 'E2E_JOB_START')
      const acpKilled = jobs().at(-1)
      await expect.poll(() => existsSync(latestFixture().readyFile)).toBe(true)
      await send(page, 'E2E_JOB_STOP')
      await expect.poll(() => host.ctx.jobs.get(acpKilled.id, owner).status).toBe('killed')
      await send(page, 'E2E_JOB_READ')

      // A foreground terminal can finish while the parent prompt is still
      // active. It must not inject a second step into that turn either.
      await send(page, 'E2E_JOB_START_IMMEDIATE')
      const immediate = jobs().at(-1)
      await expect.poll(() => host.ctx.jobs.get(immediate.id, owner).status).toBe('completed')
      expect(host.ctx.jobs.get(immediate.id, owner).reported).toBe(true)
      await send(page, 'E2E_JOB_READ')
      await page.reload()
      await page.getByRole('button', { name: '5 background jobs', exact: true }).click()
      expect(await list.locator('li').count()).toBe(5)
      expect(await list.innerText()).toContain('signal:')
      expect(observed).toHaveLength(sent)
      expect(errors).toEqual([])
    } catch (error) {
      if (page) {
        const dir = join(root, '.local/e2e-failures')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `jobs-${profile}.json`), JSON.stringify({ errors, body: await page.locator('body').innerText() }, null, 2))
        await page.screenshot({ path: join(dir, `jobs-${profile}.png`), fullPage: true })
      }
      throw error
    } finally {
      try { await browser?.close() } finally { await host.close() }
    }
  })
})
