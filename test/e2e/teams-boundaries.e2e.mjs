import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

class NativeTeamControl extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Native team control' } }
  async listModels(provider) { return ['native-a', 'native-b'].map(id => ({ provider, id, name: id })) }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
  async *stream(options) {
    expect(options.tools.some(tool => tool.name === 'spawn_teammate')).toBe(true)
    const text = `NATIVE_TEAM_DONE ${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(teams, native = false) {
  const host = await launchAdapterWorld({ teams })
  const profile = id => ({ name: `Fixture ${id}`, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')], env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: id, MOCK_MCP_HTTP: '1' } })
  await host.ctx.settings.replace('dsh-acp', { agents: { devin: profile('devin'), codex: profile('codex') } })
  await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === 'acp-devin')).toBe(true))
  if (native) host.ctx.effect(() => host.ctx.llm.registerAdapter(['native-control'], new NativeTeamControl()))
  await host.ctx.agentDefaultModel.saveSelection(native ? { provider: 'native-control', model: 'native-a' } : { provider: 'acp-devin', model: 'mock-model-a' })
  const browser = await chromium.launch({ channel: process.env.DSH_E2E_BROWSER_CHANNEL, headless: true })
  const page = await newEnglishPage(browser)
  await page.goto(host.authenticatedUrl)
  await connectFreshWorkspace(page, host.workspaceCwd)
  const send = async text => {
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  return { host, browser, page, send }
}

it('does not expose Teams UI or services when the native profile is off', async () => {
  const { host, browser, page, send } = await setup(false)
  try {
    await send('E2E_MESSAGE')
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(await page.locator('[data-team-action]').count()).toBe(0)
    expect(host.ctx.get('agentTeams')).toBeUndefined()
    expect(host.ctx.tools.get('spawn_teammate', host.ctx.agents.list()[0])).toBeUndefined()
  } finally { await browser.close(); await host.close() }
})

it('keeps one ACP Agent across multiple models, isolates approvals and prevents cross-Agent teams', async () => {
  const { host, browser, page, send } = await setup(true)
  mkdirSync(join(root, '.local/teams-review'), { recursive: true })
  const evidence = {}, events = []
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await send('E2E_TEAM_START')
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    const lead = host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead')
    const childAId = host.ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate').id
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByLabel('Fixture devin · ACP', { exact: true }).getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    await page.getByRole('button', { name: /^Select model, current Mock Model B/ }).waitFor()
    expect(await page.getByRole('dialog').count()).toBe(0)
    await send('E2E_TEAM_SECOND')
    await page.getByText('E2E_TEAM_SECOND_READY', { exact: true }).waitFor()
    const childBId = host.ctx.agentTeams.listMembers(lead).find(member => member.name === 'calculator-b').id
    expect(host.ctx.agents.get(childBId).options).toMatchObject({ provider: 'acp-devin', model: 'mock-model-b' })
    expect(host.ctx.agents.get(childAId).options).toMatchObject({ provider: 'acp-devin', model: 'mock-model-a' })
    await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).waitFor()
    await page.getByRole('button', { name: 'calculator-b · Pending request', exact: true }).waitFor()
    for (const name of ['calculator-b', 'calculator']) {
      await page.getByRole('button', { name: `${name} · Pending request`, exact: true }).click()
      await page.locator('[data-approval-key]').waitFor()
      expect(await page.getByRole('button', { name: /^Select model/ }).count()).toBe(0)
      const id = name === 'calculator' ? childAId : childBId
      await page.locator('[data-approval-key]').getByRole('button', { name: 'Allow once', exact: true }).click()
      await page.getByText('E2E_TEAM_MEMBER_DONE', { exact: true }).waitFor()
      await vi.waitFor(() => expect(events.some(event => event.sessionId === id && event.type === 'turn/end')).toBe(true), { timeout: 20_000 })
      await page.locator('header nav').getByRole('button', { name: 'E2E_TEAM_START', exact: true }).click()
      if (name === 'calculator-b') {
        await page.getByRole('button', { name: 'calculator · Pending request', exact: true }).waitFor()
        expect(events.some(event => event.sessionId === childAId && event.type === 'turn/end')).toBe(false)
      }
    }
    await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead).every(member => ['idle', 'inactive'].includes(member.status))).toBe(true), { timeout: 30_000 })
    // Cold resume A after the Lead changed to B: A must keep its own configuration.
    const before = events.filter(event => event.sessionId === childAId && event.type === 'request/header').length
    await host.ctx.agentTeams.sendMessage(lead, { target: 'calculator', content: [{ type: 'text', text: 'E2E_TEAM_CONTINUE' }], signal: new AbortController().signal })
    await vi.waitFor(() => expect(events.filter(event => event.sessionId === childAId && event.type === 'request/header').length).toBeGreaterThan(before), { timeout: 30_000 })
    expect(events.findLast(event => event.sessionId === childAId && event.type === 'request/header').data.header.config).toMatchObject({ provider: 'acp-devin', model: 'mock-model-a' })
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByLabel('Fixture codex · ACP', { exact: true }).getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'New session required' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    const selected = host.ctx.sessionProjections.stateOf(lead.session, 'modelSelection')
    expect(selected.pending ?? selected.lastUsed).toMatchObject({ provider: 'acp-devin', model: 'mock-model-b' })
    Object.assign(evidence, { leadId: lead.id, childAId, childBId, selected, roster: host.ctx.agentTeams.listMembers(lead), ordinaryApprovals: events.filter(event => event.type === 'approval/asked').map(event => ({ sessionId: event.sessionId, tool: event.data.toolName })) })
    expect(evidence.ordinaryApprovals).toHaveLength(2)
    await page.screenshot({ path: join(root, '.local/teams-review/multiple-models.png'), fullPage: true })
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByLabel('Fixture codex · ACP', { exact: true }).getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
    await send('E2E_MESSAGE')
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    const destinationId = events.findLast(event => event.type === 'request/header' && event.data.header.config.provider === 'acp-codex').sessionId
    expect(destinationId).not.toBe(lead.id)
    expect(host.ctx.agentTeams.listMembers(host.ctx.agents.get(destinationId))).toHaveLength(1)
    expect(host.ctx.agentTeams.listMembers(lead)).toHaveLength(3)
    evidence.crossAgentDestinationId = destinationId
    // No browser coordinator is present: a direct Remote selection must not bypass host execution policy.
    await page.goto('about:blank')
    await vi.waitFor(() => expect(lead.status).toBe('idle'), { timeout: 30_000 })
    await host.ctx.sessionController.selectModel({ sessionId: lead.id, provider: 'acp-codex', model: 'mock-model-a' })
    await host.ctx.sessionController.prompt({ requestId: 'cross-agent-negative', sessionId: lead.id, mode: 'queue', content: [{ type: 'text', text: 'E2E_MESSAGE' }] }, new AbortController().signal)
    await vi.waitFor(() => expect(events.some(event => event.sessionId === lead.id && event.type === 'turn/end' && event.data.reason.kind === 'error' && event.data.reason.error.message.includes('changes the execution backend'))).toBe(true), { timeout: 20_000 })
    expect(events.some(event => event.sessionId === lead.id && event.type === 'request/header' && event.data.header.config.provider === 'acp-codex')).toBe(false)
    evidence.crossAgentExecutionRejected = true
  } finally {
    mkdirSync(join(root, '.local/teams-review'), { recursive: true })
    writeFileSync(join(root, '.local/teams-review/routing.json'), JSON.stringify({ ...evidence, events }, null, 2))
    await browser.close(); await host.close()
  }
}, 120_000)

it('preserves native Teams model inheritance and switching with the ACP plugin installed', async () => {
  const { host, browser, page, send } = await setup(true, true)
  const headers = []
  host.ctx.on('session/event', (session, event) => { if (event.type === 'request/header') headers.push({ id: session.id, config: event.data.header.config }) })
  try {
    await send('native baseline')
    await page.getByText('NATIVE_TEAM_DONE native-a', { exact: true }).first().waitFor()
    const lead = host.ctx.agents.list().find(agent => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead')
    const spawn = name => host.ctx.agentTeams.spawnTeammate(lead, { name, description: name, prompt: [{ type: 'text', text: 'Calculate 1+1' }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal })
    const first = await spawn('native-first')
    await vi.waitFor(() => expect(headers.some(item => item.id === first.member.id && item.config.model === 'native-a')).toBe(true), { timeout: 20_000 })
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'native-b', exact: true }).click()
    await send('use model B')
    await page.getByText('NATIVE_TEAM_DONE native-b', { exact: true }).first().waitFor()
    const second = await spawn('native-second')
    await vi.waitFor(() => expect(headers.some(item => item.id === second.member.id && item.config.model === 'native-b')).toBe(true), { timeout: 20_000 })
    expect(headers.filter(item => item.id === first.member.id).every(item => item.config.model === 'native-a')).toBe(true)
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.locator('[data-team-action]').isVisible()).toBe(true)
    expect(host.ctx.tools.get('spawn_teammate', lead).parameters.properties.context.enum).toContain('fork')
  } finally { await browser.close(); await host.close() }
}, 90_000)
