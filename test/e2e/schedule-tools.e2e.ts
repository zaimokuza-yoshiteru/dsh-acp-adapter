import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { required } from './required.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'
const TOOLS = ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'] as const

async function setup() {
  let host: AdapterWorld | undefined
  let browser: TestBrowser | undefined
  try {
    const ownedHost = await launchAdapterWorld({ teams: true, schedule: true })
    host = ownedHost
    const fixtureLog = join(ownedHost.workspaceCwd, 'schedule-agent.jsonl')
    const activeDueFile = join(ownedHost.workspaceCwd, 'schedule-active-due')
    await ownedHost.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        devin: {
          name: 'ACP Schedule fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: ownedHost.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_SCHEDULE_RESULTS: fixtureLog,
            MOCK_SCHEDULE_ACTIVE_DUE_FILE: activeDueFile,
          },
        },
      },
    })
    await vi.waitFor(() => expect(ownedHost.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await ownedHost.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    const ownedBrowser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    browser = ownedBrowser
    const page = await newEnglishPage(ownedBrowser)
    await page.goto(ownedHost.authenticatedUrl)
    await connectFreshWorkspace(page, ownedHost.workspaceCwd)
    const send = async (text: string) => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      const settled = ownedHost.whenTurnSettled(30_000)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      return settled
    }
    return { host: ownedHost, browser: ownedBrowser, page, fixtureLog, activeDueFile, send }
  } catch (error) {
    await Promise.allSettled([
      ...(browser === undefined ? [] : [browser.close()]),
      ...(host === undefined ? [] : [host.close()]),
    ])
    throw error
  }
}

it('discovers and calls all four native Schedule tools through the ACP session MCP bridge', async () => {
  const { host, browser, page, fixtureLog, send } = await setup()
  try {
    const sessionId = await send('E2E_SCHEDULE_CRUD')
    await page.getByText('E2E_SCHEDULE_CRUD_DONE', { exact: true }).waitFor()
    const fixture = JSON.parse(readFileSync(fixtureLog, 'utf8').trim()) as {
      names: string[]
      records: { name: string; result: Record<string, unknown> }[]
    }
    expect(fixture.names).toEqual(expect.arrayContaining([...TOOLS]))
    expect(fixture.records.map((record) => record.name)).toEqual([
      'schedule_create',
      'schedule_list',
      'schedule_update',
      'schedule_list',
      'schedule_delete',
    ])
    expect(fixture.records[0]?.result).toMatchObject({ title: 'ACP CRUD fixture', kind: 'after' })
    expect(fixture.records[2]?.result).toMatchObject({ title: 'ACP updated fixture' })
    expect(fixture.records[4]?.result).toMatchObject({ deleted: true })

    const lead = required(host.ctx.agents.get(sessionId))
    expect(TOOLS.every((name) => host.ctx.tools.get(name, lead) !== undefined)).toBe(true)
    const member = await host.ctx.agentTeams.spawnTeammate(lead, {
      name: 'schedule-scope-check',
      description: 'Schedule tool scope regression',
      prompt: [{ type: 'text', text: 'Check your tool list, then finish.' }],
      context: 'fresh',
      provider: 'spawn',
      signal: new AbortController().signal,
    })
    const teammate = required(host.ctx.agents.get(member.member.id))
    expect(TOOLS.map((name) => host.ctx.tools.get(name, teammate))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(
      (await host.ctx.schedule.catalog()).some(
        (task) => task.sessionId === sessionId && task.title === 'ACP updated fixture',
      ),
    ).toBe(false)
  } finally {
    try {
      await browser.close()
    } finally {
      await host.close()
    }
  }
}, 90_000)

it('delivers reminders into the owning ACP Session while idle and while a turn is active', async () => {
  const { host, browser, page, fixtureLog, activeDueFile, send } = await setup()
  try {
    const idleSessionId = await send('E2E_SCHEDULE_IDLE')
    await page.getByText('E2E_SCHEDULE_IDLE_CREATED', { exact: true }).waitFor()
    const idleTask = await vi.waitFor(
      async () => {
        const found = (await host.ctx.schedule.catalog()).find(
          (task) => task.sessionId === idleSessionId && task.title === 'ACP idle delivery',
        )
        expect(found?.lastDelivery).toBeDefined()
        return required(found)
      },
      { timeout: 15_000, interval: 100 },
    )
    expect(idleTask.lastDelivery).toMatchObject({ scheduledAt: expect.any(String), deliveredAt: expect.any(String) })
    const idleHistory = await host.ctx.schedule.history({ id: idleTask.id, sessionId: idleSessionId, limit: 5 })
    expect(idleHistory).toMatchObject({
      id: idleTask.id,
      records: [expect.objectContaining({ prompt: 'E2E_SCHEDULE_DELIVERY_IDLE' })],
    })
    await page.getByText('E2E_SCHEDULE_DELIVERED_IDLE', { exact: true }).waitFor()
    const fixtureRows = readFileSync(fixtureLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const idleScenario = required(fixtureRows.find((row) => row.scenario === 'E2E_SCHEDULE_IDLE'))
    const idleDelivery = fixtureRows.filter((row) => row.kind === 'delivery-consumed' && row.delivery === 'IDLE')
    expect(idleDelivery).toHaveLength(1)
    expect(idleDelivery[0]).toMatchObject({
      acpSessionId: idleScenario.acpSessionId,
      prompt: expect.stringContaining('E2E_SCHEDULE_DELIVERY_IDLE'),
    })
    expect(idleDelivery[0]?.prompt).toContain('This is a scheduled message from the user')
    const idleConversation = page.locator(`[data-conversation-session="${idleTask.sessionId}"]`)
    await idleConversation.getByText('E2E_SCHEDULE_DELIVERED_IDLE', { exact: true }).waitFor()

    const activeSettled = send('E2E_SCHEDULE_ACTIVE')
    const activeSessionId = await vi.waitFor(() => {
      const agent = host.ctx.agents
        .list()
        .find((item) => item.status === 'running' && item.options.provider === 'acp-devin')
      expect(agent).toBeDefined()
      return required(agent).id
    })
    await vi.waitFor(() => expect(existsSync(activeDueFile)).toBe(true), { timeout: 10_000, interval: 50 })
    const activeLead = required(host.ctx.agents.get(activeSessionId))
    const activeTask = await vi.waitFor(
      async () => {
        const found = (await host.ctx.schedule.catalog()).find(
          (task) => task.sessionId === activeSessionId && task.title === 'ACP active delivery',
        )
        expect(found?.lastDelivery).toBeDefined()
        expect(activeLead.status).toBe('running')
        return required(found)
      },
      { timeout: 15_000, interval: 100 },
    )
    expect(activeTask.sessionId).toBe(activeSessionId)
    const activeHistory = await host.ctx.schedule.history({ id: activeTask.id, sessionId: activeSessionId, limit: 5 })
    expect(activeHistory).toMatchObject({
      id: activeTask.id,
      records: [expect.objectContaining({ prompt: 'E2E_SCHEDULE_DELIVERY_ACTIVE' })],
    })
    expect(activeLead.status).toBe('running')
    expect(await activeSettled).toBe(activeSessionId)
    await page.getByText('E2E_SCHEDULE_ACTIVE_CREATED', { exact: true }).waitFor()
    await page.getByText('E2E_SCHEDULE_DELIVERED_ACTIVE', { exact: true }).waitFor()
    const activeRows = readFileSync(fixtureLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const activeScenario = required(activeRows.find((row) => row.scenario === 'E2E_SCHEDULE_ACTIVE'))
    const activeDelivery = activeRows.filter((row) => row.kind === 'delivery-consumed' && row.delivery === 'ACTIVE')
    expect(activeDelivery).toHaveLength(1)
    expect(activeDelivery[0]).toMatchObject({
      acpSessionId: activeScenario.acpSessionId,
      prompt: expect.stringContaining('E2E_SCHEDULE_DELIVERY_ACTIVE'),
    })
    expect(activeDelivery[0]?.prompt).toContain('This is a scheduled message from the user')
    const activeConversation = page.locator(`[data-conversation-session="${activeTask.sessionId}"]`)
    await activeConversation.getByText('E2E_SCHEDULE_DELIVERED_ACTIVE', { exact: true }).waitFor()
  } finally {
    try {
      await browser.close()
    } finally {
      await host.close()
    }
  }
}, 90_000)

it('preserves a pending Schedule task when the official bundle is disabled and remounted', async () => {
  const { host, browser, page, fixtureLog, send } = await setup()
  try {
    const recoverySessionId = await send('E2E_SCHEDULE_PERSIST')
    await page.getByText('E2E_SCHEDULE_PERSIST_CREATED', { exact: true }).waitFor()
    const log = readFileSync(fixtureLog, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { scenario?: string; records?: { name: string; result: Record<string, unknown> }[] },
      )
    const persistLog = required(log.findLast((item) => item.scenario === 'E2E_SCHEDULE_PERSIST'))
    const taskId = String(required(persistLog.records?.[0]).result.id)
    const pendingTask = required(
      (await host.ctx.schedule.catalog()).find((task) => task.id === taskId && task.sessionId === recoverySessionId),
    )
    const scheduledAt = Date.parse(pendingTask.scheduledAt)
    expect(scheduledAt).toBeGreaterThan(Date.now())
    const scheduleManager = host.ctx.pluginManager
    const bundle = required((await scheduleManager.listBundles()).find((row) => row.name === SCHEDULE_BUNDLE))
    expect(bundle).toMatchObject({ enabled: true, optional: true })
    const lead = required(host.ctx.agents.get(recoverySessionId))
    const staleDelete = required(host.ctx.tools.get('schedule_delete', lead))
    expect(await scheduleManager.setBundleEnabled(bundle.name, false)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('schedule')).toBeUndefined())
    expect(TOOLS.map((name) => host.ctx.tools.get(name, lead))).toEqual([undefined, undefined, undefined, undefined])
    const staleArgs = { id: 'schedule-stale-tool-after-disable' }
    const staleResult = await staleDelete.execute(staleArgs, {
      callId: ToolCallId('schedule-stale-call'),
      rootCallId: ToolCallId('schedule-stale-call'),
      token: Symbol('schedule-stale-tool-after-disable') as ToolExecutionToken,
      name: 'schedule_delete',
      arguments: staleArgs,
      agent: lead,
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
    })
    expect(staleResult).toMatchObject({ code: 'internal_error' })
    const disabledAt = Date.now()
    expect(disabledAt).toBeLessThan(scheduledAt)
    await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now() + 100))
    expect(Date.now()).toBeGreaterThan(scheduledAt)

    expect(await scheduleManager.setBundleEnabled(bundle.name, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('schedule')).toBeDefined())
    await vi.waitFor(() => expect(TOOLS.every((name) => host.ctx.tools.get(name, lead) !== undefined)).toBe(true))
    await vi.waitFor(
      async () => {
        expect((await host.ctx.schedule.catalog()).find((task) => task.id === taskId)?.lastDelivery).toBeDefined()
      },
      { timeout: 15_000, interval: 100 },
    )
    const recovered = required((await host.ctx.schedule.catalog()).find((task) => task.id === taskId))
    expect(Date.parse(required(recovered.lastDelivery).deliveredAt)).toBeGreaterThanOrEqual(disabledAt)
    const recoveryConversation = page.locator(`[data-conversation-session="${recovered.sessionId}"]`)
    await recoveryConversation.getByText('E2E_SCHEDULE_DELIVERED_ACTIVE', { exact: true }).waitFor()
    const recoveryRows = readFileSync(fixtureLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const recoveryFixture = required(recoveryRows.find((row) => row.scenario === 'E2E_SCHEDULE_PERSIST'))
    const deliveries = recoveryRows.filter((row) => row.kind === 'delivery-consumed' && row.delivery === 'ACTIVE')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      acpSessionId: recoveryFixture.acpSessionId,
      prompt: expect.stringContaining('E2E_SCHEDULE_DELIVERY_ACTIVE'),
    })
  } finally {
    try {
      await browser.close()
    } finally {
      await host.close()
    }
  }
}, 90_000)
