import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it.each(['devin', 'codex'].flatMap(profile => ['allow', 'reject'].map(decision => ({ profile, decision }))))('handles eight $profile member approvals from the Lead: $decision, then leaves a later request pending', async ({ profile, decision }) => {
  // Native default includes the Lead in its 8-member limit. This test opts into 9.
  const host = await launchAdapterWorld({ teams: true, teamMembers: 9 })
  let browser!: TestBrowser
  let page!: Page
  const events: ObservedEvent[] = [], errors: string[] = []
  const log = join(host.workspaceCwd, 'team-approvals.log')
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { [profile]: {
      name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_MCP_HTTP: '1', MOCK_LOG: log },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === `acp-${profile}`)).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: `acp-${profile}`, model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_TEAM_EIGHT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_TEAM_EIGHT_READY', { exact: true }).waitFor({ timeout: 60000 })
    const lead = required(host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead'))
    expect(lead).toBeDefined()
    const card = page.locator('[data-acp-team-approvals]')
    await expect.poll(() => card.locator('[data-team-pending-member]').count(), { timeout: 30000 }).toBe(8)
    const url = page.url()
    mkdirSync(join(root, '.local/team-approvals'), { recursive: true })
    await page.screenshot({ path: join(root, `.local/team-approvals/eight-${profile}-${decision}.png`) })
    expect(await card.innerText()).toContain('echo E2E_TEAM_PERMISSION')
    const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
    // One inline action plus the batch proves both paths without opening a member.
    await card.locator('[data-team-pending-member="worker-8"]').getByRole('button', { name: decision === 'allow' ? 'Allow once' : 'Reject', exact: true }).click()
    await expect.poll(() => card.locator('[data-team-pending-member]').count()).toBe(7)
    // Pending requests survive transport replacement; stale carriers must not be answered.
    await page.reload()
    await expect.poll(() => card.locator('[data-team-pending-member]').count()).toBe(7)
    await page.setViewportSize({ width: 680, height: 900 })
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    await card.getByRole('button', { name: decision === 'allow' ? '全部允许' : '全部拒绝', exact: true }).click()
    await expect.poll(() => events.filter(event => event.type === 'approval/decided').length).toBe(8)
    expect(events.filter(event => event.type === 'approval/decided').every(event => event.data.outcome === outcome)).toBe(true)
    expect(new Set(events.filter(event => event.type === 'approval/decided').map(event => event.sessionId)).size).toBe(8)
    expect(events.filter(event => event.type === 'approval/decided').every(event => event.sessionId !== lead.id)).toBe(true)
    expect(page.url()).toBe(url)
    // A new request arrives after the batch and must remain unanswered.
    await expect.poll(() => card.locator('[data-team-pending-member]').count()).toBe(1)
    await card.locator('[data-team-approval-reason]').filter({ hasText: 'echo E2E_TEAM_LATE_PERMISSION' }).waitFor()
    expect(events.filter(event => event.type === 'approval/decided')).toHaveLength(8)
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => events.filter(event => event.type === 'approval/decided').length).toBe(9)
    expect(required(events.filter(event => event.type === 'approval/decided').at(-1)).data.outcome).toBe('rejected')
    await expect.poll(() => card.count()).toBe(0)
    expect(page.url()).toBe(url)
    expect(errors).toEqual([])
  } catch (error) {
    if (page) {
      mkdirSync(join(root, '.local/e2e-failures'), { recursive: true })
      await page.screenshot({ path: join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.png`), fullPage: true })
      writeFileSync(join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.log`), readFileSync(log, 'utf8'))
      writeFileSync(join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.json`), JSON.stringify(events, null, 2))
      writeFileSync(join(root, `.local/e2e-failures/team-batch-${profile}-${decision}.errors.json`), JSON.stringify(errors))
    }
    throw error
  } finally { await browser?.close(); await host.close() }
}, 120000)
