import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

describe.each([['claude', false], ['devin', true], ['codex', true], ['kimi', false]])('native Teams over ACP: %s, HTTP=%s', (profile, http) => {
  it.each(['allow', 'deny', 'cancel'])('creates matching members, uses native roster/tasks, routes %s on the original approval and continues messaging', async decision => {
    let host, browser, page, log
    const errors = []
    const events = []
    const executions = []
    try {
      host = await launchAdapterWorld({ teams: true })
      host.ctx.on('session/event', (session, event) => { events.push({ sessionId: session.id, ...event }) })
      host.ctx.on('tools/result', (execution, result) => { executions.push({ name: execution.name, isError: result.isError }) })
      log = join(host.workspaceCwd, 'teams-agent.log')
      const provider = `acp-${profile}`
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: `Fixture ${profile}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')],
        env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_MCP_HTTP: http ? '1' : '0', MOCK_LOG: log },
      } } })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === provider)).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
      browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
      page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const send = async text => {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      await send('E2E_TEAM_START: explicitly create an Agent Team to compute 1+1')
      await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor({ timeout: 30_000 })
      await page.getByText('spawn_teammate', { exact: true }).first().waitFor()
      expect(await page.locator('body').innerText()).not.toMatch(/mcp__dshteam_[a-f0-9]+__/)
      const lead = host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead')
      expect(lead).toBeDefined()
      await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead)).toHaveLength(2))
      const member = host.ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate')
      await vi.waitFor(() => {
        const initial = events.find(event => event.sessionId === member.id && event.type === 'user/message' && event.data.source?.form === 'snapshot')
        expect(JSON.stringify(initial)).toContain('Approval policy: ask.')
        expect(JSON.stringify(initial)).not.toContain('Approval prompts are disabled in this session')
        expect(JSON.stringify(initial)).not.toContain('operations that require approval are rejected automatically')
      })
      const child = host.ctx.agents.get(member.id)
      expect(child.options).toMatchObject({ provider, model: 'mock-model-a' })
      expect(child.session.header.cwd).toBe(lead.session.header.cwd)
      // Coordination completed without taking over the Lead composer.
      expect(await page.locator('[data-approval-key], [data-question-key]').count()).toBe(0)
      await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).waitFor({ timeout: 20_000 })
      const action = page.locator('[data-team-action]')
      await action.getByRole('button', { name: /Agent Team/ }).click()
      await action.getByText('Compute fixture', { exact: true }).first().waitFor()
      await action.getByText('calculator', { exact: true }).first().waitFor()
      if (profile === 'devin' && decision === 'allow') await verifyTaskBoard(action, host, lead)
      await action.getByRole('button', { name: /Agent Team/ }).click()
      await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).click()
      const approval = page.locator('[data-approval-key]')
      await approval.waitFor()
      expect(await approval.innerText()).toContain('echo E2E_TEAM_PERMISSION')
      // Native addressed children expose no model-switch control or /model entry.
      expect(await page.getByRole('button', { name: /Select model/ }).count()).toBe(0)
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
        await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead).find(item => item.id === child.id).status).not.toBe('running'), { timeout: 20_000 })
        expect(readFileSync(log, 'utf8')).not.toContain('E2E_TEAM_MEMBER_DONE')
        expect(events.filter(event => event.type === 'approval/asked').map(event => event.data.toolName)).toEqual(['bash'])
        expect(errors).toEqual([])
        return
      }
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

/** Native task UI + a concurrent host write exercise the actual Remote/CAS path. */
async function verifyTaskBoard(action, host, lead) {
  const task = host.ctx.agentTeams.listTasks(lead).find(task => task.subject === 'Compute fixture')
  await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'edit', description: 'Concurrent update' })
  await action.locator('article').filter({ hasText: 'Compute fixture' }).getByRole('button', { name: 'Complete', exact: true }).click()
  await action.getByRole('alert').filter({ hasText: 'Task state changed' }).waitFor()
  const first = action.locator('article').filter({ hasText: 'Compute fixture' })
  await first.getByRole('button', { name: 'Complete', exact: true }).click()
  await first.getByText('Completed', { exact: true }).waitFor()
  await action.locator('article').filter({ hasText: 'Blocked fixture' }).getByText('Ready', { exact: true }).waitFor()
  await first.getByRole('button', { name: 'Reopen', exact: true }).click()
  await first.getByText('Pending', { exact: true }).waitFor()
  await action.getByRole('button', { name: 'New task', exact: true }).click()
  await action.getByPlaceholder('Task subject', { exact: true }).fill('Review task')
  await action.getByPlaceholder('Task description', { exact: true }).fill('Created in the native panel')
  await action.getByRole('button', { name: 'Save', exact: true }).click()
  const created = action.locator('article').filter({ hasText: 'Review task' })
  await created.getByRole('button', { name: 'Edit', exact: true }).click()
  await action.getByPlaceholder('Task description', { exact: true }).fill('Edited in the native panel')
  await action.getByRole('button', { name: 'Save', exact: true }).click()
  await created.getByText('Edited in the native panel', { exact: true }).waitFor()
  await created.getByRole('combobox').selectOption('calculator')
  await vi.waitFor(() => expect(host.ctx.agentTeams.listTasks(lead).find(task => task.subject === 'Review task').ownerName).toBe('calculator'))
  await created.getByRole('button', { name: 'Delete', exact: true }).click()
  await vi.waitFor(() => expect(host.ctx.agentTeams.listTasks(lead).some(task => task.subject === 'Review task')).toBe(false))
}
