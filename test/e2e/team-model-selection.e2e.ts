import type { AcpRemoteService } from '../../src/remote/service.js'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it('persists teammate model selection, applies it on wake, and protects Team boundaries', async () => {
  const host = await launchAdapterWorld({ teams: true })
  let browser!: TestBrowser
  let page!: Page
  const log = join(host.workspaceCwd, 'team-model-selection.log')
  const events: ObservedEvent[] = []
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { devin: {
      name: 'ACP model fixture', command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_MCP_HTTP: '1', MOCK_LOG: log },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(provider => provider.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })

    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string) => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }

    await send('E2E_TEAM_START')
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    const lead = required(host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead'))
    const child = required(host.ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate'))
    expect(lead).toBeDefined()
    expect(child).toMatchObject({ name: 'calculator' })

    // The member's first prompt is waiting for approval, so its running turn is
    // not mutable. Invalid ownership/targets are rejected before model lookup.
    const approvals = page.locator('[data-acp-team-approvals]')
    await approvals.locator('[data-team-pending-member="calculator"]').waitFor()
    await expect((host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, child.id, 'mock-model-b')).rejects.toThrow()
    await expect((host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels('foreign-lead', child.id)).rejects.toThrow()
    await expect((host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, lead.id)).rejects.toThrow()

    // Settle the approval and wait until the member has become dormant. A
    // dormant selection must be persisted without starting another request.
    await approvals.locator('[data-team-pending-member="calculator"]').getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => host.ctx.agentTeams.listMembers(lead).find(member => member.id === child.id)?.status, { timeout: 30000 }).toSatisfy(status => status === 'idle' || status === 'inactive')
    await expect((host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, child.id, 'unknown-model')).rejects.toThrow()
    const beforeSaveLog = readFileSync(log, 'utf8')
    const saved = await (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, child.id, 'mock-model-b')
    expect(saved).toMatchObject({ currentModel: 'mock-model-a', pendingModel: 'mock-model-b', writable: true })
    expect(readFileSync(log, 'utf8')).toBe(beforeSaveLog)

    const initial = await (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id)
    expect(initial).toMatchObject({ currentModel: 'mock-model-a', pendingModel: 'mock-model-b', writable: true })
    expect(initial.models).toEqual(expect.arrayContaining([
      { id: 'mock-model-a', name: 'Mock Model A' },
      { id: 'mock-model-b', name: 'Mock Model B' },
    ]))

    const panel = page.locator('[data-acp-team-management], [data-acp-team-panel]')
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    const row = panel.locator('[data-acp-managed-member="calculator"]')
    await row.getByRole('status').filter({ hasText: /mock[ -]model[ -]a/i }).waitFor()
    const modelButton = row.getByRole('button', { name: 'Choose a model for calculator', exact: true })
    await modelButton.waitFor()
    // IDs stay lower-case on the wire; all visible labels use catalog names,
    // including before the picker has ever been opened.
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    expect(await row.locator('[data-member-model-notice]').textContent()).toBe('Applies next request; current: Mock Model A')
    await modelButton.click()
    const modelMenu = page.getByRole('menu')
    await modelMenu.getByRole('menuitem', { name: 'Mock Model A', exact: true }).waitFor()
    await modelMenu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).waitFor()
    await modelMenu.getByRole('menuitem', { name: 'Mock Model A', exact: true }).click()
    await expect.poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id)).toMatchObject({ pendingModel: null })
    await expect.poll(() => row.locator('[data-member-model-notice]').textContent()).toBe('')
    expect(await modelButton.textContent()).toBe('Mock Model A')
    const beforeModelNotice = await row.boundingBox()
    const beforeModeButton = await row.getByRole('button', { name: /^(?:Session|会话) ·/ }).boundingBox()
    expect(required((await row.locator('[data-member-model-notice]').boundingBox())).height).toBe(13)
    await modelButton.click()
    expect(await row.getByRole('searchbox').count()).toBe(0)
    await modelMenu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).click()
    await row.getByRole('status').filter({ hasText: /mock[ -]model[ -]a/i }).waitFor()
    expect(await row.boundingBox()).toEqual(beforeModelNotice)
    expect(await row.getByRole('button', { name: /^(?:Session|会话) ·/ }).boundingBox()).toEqual(beforeModeButton)
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // Closing and reopening remounts the card. Display names must not revert
    // to IDs or depend on a previous click of the model selector.
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // A transport reload restores current A plus pending B from the sidecar.
    await page.reload()
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    await row.getByRole('status').filter({ hasText: /mock[ -]model[ -]a/i }).waitFor()
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    expect(await row.locator('[data-member-model-notice]').textContent()).toBe('Applies next request; current: Mock Model A')
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // team-turn logs configOptions.model for each request. This is the request
    // header evidence: the first wake must carry B and the second must retain it.
    const countModelB = () => (readFileSync(log, 'utf8').match(/team model=mock-model-b/g) ?? []).length
    const firstBCount = countModelB()
    await send('E2E_TEAM_WAKE')
    await expect.poll(() => readFileSync(log, 'utf8'), { timeout: 30000 }).toContain('team model=mock-model-b')
    await expect.poll(countModelB, { timeout: 30000 }).toBeGreaterThan(firstBCount)
    await expect.poll(() => events.filter(event => event.sessionId === child.id && JSON.stringify(event).includes('E2E_TEAM_MEMBER_CONTINUED')).length, { timeout: 30000 }).toBeGreaterThan(0)
    await expect.poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id), { timeout: 30000 }).toMatchObject({ currentModel: 'mock-model-b', pendingModel: null, writable: true })

    const secondBCount = countModelB()
    await send('E2E_TEAM_WAKE')
    await expect.poll(countModelB, { timeout: 30000 }).toBeGreaterThan(secondBCount)
    await expect.poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id), { timeout: 30000 }).toMatchObject({ currentModel: 'mock-model-b', pendingModel: null, writable: true })

    expect(required(host.ctx.get('agentDefaultModel')).currentSelection()).toMatchObject({ provider: 'acp-devin', model: 'mock-model-a' })
    expect(lead.session.requestHeader()?.config.model).toBe('mock-model-a')
    expect(events.filter(event => event.type === 'request/header').filter(event => event.sessionId === child.id).slice(-2).map(event => event.data.header.config.model)).toEqual(['mock-model-b', 'mock-model-b'])
    await send('E2E_TEAM_SECOND')
    await page.getByText('E2E_TEAM_SECOND_READY', { exact: true }).waitFor()
    const sibling = required(host.ctx.agentTeams.listMembers(lead).find(member => member.name === 'calculator-b'))
    await expect.poll(() => events.filter(event => event.type === 'request/header').findLast(event => event.sessionId === sibling.id)?.data.header.config.model).toBe('mock-model-a')
    expect((await (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id)).currentModel).toBe('mock-model-b')
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120000)
