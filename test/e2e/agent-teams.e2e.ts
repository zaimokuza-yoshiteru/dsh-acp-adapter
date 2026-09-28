import { required } from './required.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Locator } from 'playwright'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'
import type { Page } from 'playwright'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft, expandOwningTurnProcess } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

describe.each([['claude', false], ['devin', true], ['codex', true], ['kimi', false]])('native Teams over ACP: %s, HTTP=%s', (profile, http) => {
  it.each(['allow', 'deny', 'cancel'])('creates matching members, uses native roster/tasks, routes %s on the original approval and continues messaging', async decision => {
    let host!: AdapterWorld
    let browser!: TestBrowser
    let page!: Page
    let log!: string
    const errors: string[] = []
    const events: ObservedEvent[] = []
    const executions: { name: string; isError: boolean }[] = []
    try {
      host = await launchAdapterWorld({ teams: true })
      host.ctx.on('session/event', (session, event) => { events.push({ sessionId: session.id, ...event }) })
      host.ctx.on('tools/result', (execution, result) => { executions.push({ name: execution.name, isError: result.isError }) })
      log = join(host.workspaceCwd, 'teams-agent.log')
      const policyGate = join(host.workspaceCwd, 'teams-policy-ready')
      const provider = `acp-${profile}`
      await host.ctx.settings.replace('dsh-acp-adapter', { toolApprovalDefault: 'auto', agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
        env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_MCP_HTTP: http ? '1' : '0', MOCK_LOG: log, MOCK_TEAM_POLICY_GATE: policyGate },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const send = async (text: string) => {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      await send('E2E_TEAM_START: explicitly create an Agent Team to compute 1+1')
      await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor({ timeout: 30_000 })
      const spawn = page.locator('[data-tool="spawn_teammate"]').first()
      await spawn.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, spawn)
      await spawn.waitFor()
      expect(await page.locator('body').innerText()).not.toMatch(/mcp__dshteam_[a-f0-9]+__/)
      const lead = required(host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead'))
      expect(lead).toBeDefined()
      await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead)).toHaveLength(2))
      const member = required(host.ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate'))
      await vi.waitFor(() => expect(readdirSync(host.workspaceCwd).filter(name => name.startsWith('teams-policy-ready.') && name.endsWith('.ready'))).toHaveLength(1), { timeout: 30000 })
      // Inspect inherited policy while the child composer is still available.
      // Once a permission card replaces the composer, its input-left menu is
      // intentionally absent; the policy remains available again afterwards.
      await page.getByRole('button', { name: /^Manage members ·/ }).click()
      const management = page.getByRole('dialog', { name: 'Manage members', exact: true })
      await management.getByRole('button', { name: 'Open calculator’s session', exact: true }).click()
      await management.getByRole('button', { name: 'Close member management', exact: true }).click()
      const sidebar = page.locator('[data-sidebar-chat]')
      await sidebar.waitFor()
      const memberSettings = sidebar.getByRole('button', { name: /^Session ·/ })
      await memberSettings.waitFor()
      await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'ask' })
      await memberSettings.click()
      const policyRow = page.getByRole('menuitem', { name: /^DSH tool approval/ })
      await policyRow.waitFor()
      await policyRow.click()
      const policyOptions = page.getByRole('menu')
      expect(await policyOptions.innerText()).toContain('Following the Lead’s current policy; read-only.')
      const inheritedAsk = policyOptions.getByRole('menuitem', { name: /^Ask each time/ })
      await inheritedAsk.waitFor()
      expect(await inheritedAsk.isDisabled()).toBe(true)
      await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'auto' })
      await expect.poll(() => policyOptions.innerText()).toContain('Auto approve')
      await expect.poll(() => policyOptions.getByRole('menuitem', { name: /^Auto approve/ }).locator('svg').count()).toBe(1)
      await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'ask' })
      await expect.poll(() => policyOptions.innerText()).toContain('Ask each time')
      await expect.poll(() => inheritedAsk.locator('svg').count()).toBe(1)
      await page.keyboard.press('Escape')
      // Coordination setup itself produced no cards before the gated tool request.
      expect(await page.locator('[data-approval-key], [data-question-key]').count()).toBe(0)
      writeFileSync(policyGate, 'ready')
      await vi.waitFor(() => {
        const initial = events.find(event => event.sessionId === member.id && event.type === 'user/message' && 'form' in event.data.source && event.data.source.form === 'snapshot')
        expect(JSON.stringify(initial)).toContain('Approval policy: ask.')
        expect(JSON.stringify(initial)).not.toContain('Approval prompts are disabled in this session')
        expect(JSON.stringify(initial)).not.toContain('operations that require approval are rejected automatically')
      })
      const child = required(host.ctx.agents.get(member.id))
      expect(child.options).toMatchObject({ provider, model: 'mock-model-a' })
      expect(child.session.header.cwd).toBe(lead.session.header.cwd)
      await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).waitFor({ timeout: 20_000 })
      const action = page.locator('[data-team-action]')
      await action.getByRole('button', { name: /Agent Team/ }).click()
      const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true })
      await panel.getByText('Compute fixture', { exact: true }).first().waitFor()
      await panel.getByText('calculator', { exact: true }).first().waitFor()
      if (profile === 'devin' && decision === 'allow') await verifyTaskBoard(panel, host, lead)
      await action.getByRole('button', { name: /Agent Team/ }).click()
      await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).click()
      await sidebar.waitFor()
      await page.locator('[data-acp-team-approvals]').waitFor()
      const approval = sidebar.locator('[data-approval-key]')
      await approval.waitFor()
      expect(await approval.innerText()).toContain('echo E2E_TEAM_PERMISSION')
      // All decision paths exercise this original Ask-created request. Keep
      // subsequent Lead completion/cancel coordination on Auto to avoid
      // unrelated approval cards, while proving this card stays pending.
      await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'auto' })
      expect(await approval.getByRole('button', { name: 'Allow once', exact: true }).isVisible()).toBe(true)
      // Native addressed children expose no model-switch control or /model entry.
      expect(await sidebar.getByRole('button', { name: /Select model/ }).count()).toBe(0)
      expect(await page.locator('[data-composer-input]').count()).toBeGreaterThanOrEqual(2)
      if (decision === 'deny') {
        await approval.getByRole('button', { name: 'Reject', exact: true }).click()
        await page.getByText('E2E_TEAM_MEMBER_DENIED', { exact: true }).waitFor()
      } else if (decision === 'cancel') {
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        lead.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'E2E_TEAM_INTERRUPT' }] }))
        await vi.waitFor(() => expect(events.some(event => event.sessionId === child.id && event.type === 'turn/end')).toBe(true), { timeout: 20_000 })
      }
      if (decision === 'cancel') expect(readFileSync(log, 'utf8')).toContain('session/cancel')
      if (decision !== 'allow') {
        await vi.waitFor(() => expect(required(host.ctx.agentTeams.listMembers(lead).find(item => item.id === child.id)).status).not.toBe('running'), { timeout: 20_000 })
        expect(readFileSync(log, 'utf8')).not.toContain('E2E_TEAM_MEMBER_DONE')
        expect(events.filter(event => event.type === 'approval/asked').map(event => event.data.toolName)).toEqual(['bash'])
        expect(errors).toEqual([])
        return
      }
      writeFileSync(`${policyGate}.continue`, 'ready')
      // Changing the session policy after this request is already pending does
      // not dismiss or auto-answer its native approval card.
      expect(await approval.getByRole('button', { name: 'Allow once', exact: true }).isVisible()).toBe(true)
      await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      await page.getByText('E2E_TEAM_MEMBER_DONE', { exact: true }).waitFor({ timeout: 30_000 })
      await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toContain('E2E_TEAM_LEAD_RECEIVED'), { timeout: 30_000 })
      expect(events.some(event => event.sessionId === lead.id && event.type === 'team/message/queued' && JSON.stringify(event.data).includes('E2E_TEAM_REPLY'))).toBe(true)
      // Native steering while viewing the child verifies background Team continuation.
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      lead.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'E2E_TEAM_WAKE' }] }))
      await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toContain('E2E_TEAM_MEMBER_CONTINUED'), { timeout: 30_000 })
      lead.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'E2E_TEAM_INTERRUPT' }] }))
      await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toContain('E2E_TEAM_INTERRUPTED'), { timeout: 30_000 })
      expect(new Set(executions.filter(item => !item.isError).map(item => item.name)).size).toBe(9)
      expect(events.filter(event => event.type === 'approval/asked').map(event => event.data.toolName)).toEqual(['bash'])
      expect(readFileSync(log, 'utf8')).not.toContain('team failed')
      expect(errors).toEqual([])
    } catch (error) {
      const directory = join(root, '.local/e2e-failures')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `teams-${profile}-${decision}.json`), JSON.stringify({ error: String(error), errors, events, body: await page?.locator('body').innerText(), log: log && existsSync(log) ? readFileSync(log, 'utf8') : '' }, null, 2))
      if (page) await page.screenshot({ path: join(directory, `teams-${profile}-${decision}.png`), fullPage: true })
      throw error
    } finally {
      await browser?.close()
      await host?.close()
    }
  }, 120_000)
})

/** 0.1.7's native task panel is read-only; host-owned updates appear on refresh. */
async function verifyTaskBoard(panel: Locator, host: AdapterWorld, lead: Agent) {
  const task = required(host.ctx.agentTeams.listTasks(lead).find(task => task.subject === 'Compute fixture'))
  expect(await panel.getByRole('button', { name: 'Complete', exact: true }).count()).toBe(0)
  await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'edit', description: 'Concurrent update' })
  await expect(host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'complete' })).rejects.toThrow()
  await panel.getByText('Concurrent update', { exact: true }).waitFor()
  const current = () => required(host.ctx.agentTeams.listTasks(lead).find(item => item.id === task.id))
  await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: current().revision, action: 'complete' })
  await panel.locator('article').filter({ hasText: 'Compute fixture' }).getByText('Completed', { exact: true }).waitFor()
  await panel.locator('article').filter({ hasText: 'Blocked fixture' }).getByText('Ready', { exact: true }).waitFor()
  await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: current().revision, action: 'reopen' })
  await panel.locator('article').filter({ hasText: 'Compute fixture' }).getByText('Pending', { exact: true }).waitFor()
}
