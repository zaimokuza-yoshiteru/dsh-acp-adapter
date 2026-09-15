import { it, expect, vi } from 'vitest'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

it('keeps long teammate cards and reserved notices aligned in both languages and themes', async () => {
  const host = await launchAdapterWorld({ teams: true })
  let browser
  try {
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: {
      name: 'Layout fixture', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')],
      env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_MCP_HTTP: '1' },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await chromium.launch({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_TEAM_LAYOUT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_TEAM_LAYOUT_READY', { exact: true }).waitFor()
    const approvals = page.locator('[data-acp-team-approvals]')
    await expect.poll(() => approvals.locator('[data-team-pending-member]').count()).toBe(2)
    await approvals.getByRole('button', { name: 'Reject all', exact: true }).click()
    const lead = host.ctx.agents.list().find(a => host.ctx.agentTeams.tryMembership(a)?.role === 'lead')
    const members = host.ctx.agentTeams.listMembers(lead).filter(m => m.role === 'teammate')
    await expect.poll(async () => Promise.all(members.map(async m => (await host.ctx.dshAcp.agentSessionSnapshot(m.id)).freshness))).toEqual(['stale', 'stale'])
    const panel = page.locator('[data-acp-team-management]')
    await panel.getByRole('button', { name: 'Manage members · 2', exact: true }).click()
    const cards = panel.locator('[data-acp-managed-member]')
    await expect.poll(() => cards.count()).toBe(2)
    const before = await cards.first().boundingBox()
    expect(before.height).toBeGreaterThanOrEqual(220)
    await host.ctx.dshAcp.setTeamMemberModel(lead.id, members[0].id, 'mock-model-b')
    await host.ctx.dshAcp.setTeamMemberMode(lead.id, members[0].id, 'plan')
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await cards.first().getByRole('button', { name: 'Agent · Plan', exact: true }).waitFor()
    expect(await cards.first().boundingBox()).toEqual(before)
    const notice = cards.first().locator('[data-member-mode-notice]')
    expect(await notice.evaluate(el => getComputedStyle(el).fontSize)).toBe('10px')
    expect((await notice.boundingBox()).height).toBe(13)
    const modeBoxes = await Promise.all((await cards.getByRole('button', { name: /^Agent ·/ }).all()).map(b => b.boundingBox()))
    expect(modeBoxes[0].y).toBe(modeBoxes[1].y)
    const dir = join(root, '.local/message-order-review')
    mkdirSync(dir, { recursive: true })
    for (const [locale, theme, heading] of [['en', 'light', 'Manage members'], ['zh', 'dark', '成员管理']]) {
      await host.ctx.settings.replace('locale', { preference: locale })
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await panel.getByText(heading, { exact: true }).waitFor()
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      await panel.getByRole('dialog').screenshot({ path: join(dir, `members.${locale}.png`), animations: 'disabled' })
    }
    await page.setViewportSize({ width: 420, height: 900 })
    expect(await panel.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const narrow = await Promise.all((await cards.all()).map(card => card.boundingBox()))
    expect(narrow[1].y).toBeGreaterThanOrEqual(narrow[0].y + narrow[0].height)
  } finally { await browser?.close(); await host.close() }
})
