import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createDshToolBridge } from '../../src/host/tools/bridge.ts'
import { required } from './required.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'] as const

async function setup() {
  let host: AdapterWorld | undefined
  let browser: TestBrowser | undefined
  try {
    // web-app supplies Schedule; its standard preset owns the native tools.
    const ownedHost = await launchAdapterWorld({ teams: true })
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
      'schedule_view',
      'schedule_edit',
      'schedule_list',
      'schedule_edit',
    ])
    const created = required(fixture.records[0]).result
    expect(created).toMatchObject({
      title: 'ACP CRUD fixture',
      kind: 'rrule',
      target: { kind: 'session', sessionId },
    })
    expect(fixture.records[2]?.result).toMatchObject({ id: created.id, title: 'ACP CRUD fixture' })
    expect(fixture.records[3]?.result).toMatchObject({
      id: created.id,
      title: 'ACP updated fixture',
      target: { kind: 'session', sessionId },
    })
    expect(fixture.records[4]?.result).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: created.id, title: 'ACP updated fixture' })]),
      shown: expect.any(Number),
      total: expect.any(Number),
    })
    expect(fixture.records[5]?.result).toMatchObject({ id: created.id, deleted: true })

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
    // The default preset mounts the tools for every Agent; native execution
    // refuses delegated callers before reading or mutating the Schedule store.
    const beforeRefusedCalls = await host.ctx.schedule.catalog()
    for (const [name, args] of [
      [
        'schedule_create',
        {
          title: 'Refused teammate reminder',
          prompt: 'never create this',
          rrule: 'DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1',
          target: 'this_session',
        },
      ],
      ['schedule_list', {}],
      ['schedule_view', { id: 'foreign-task' }],
      ['schedule_edit', { id: 'foreign-task', action: 'update', title: 'never update this' }],
      ['schedule_edit', { id: 'foreign-task', action: 'delete' }],
    ] as const) {
      expect(host.ctx.tools.get(name, teammate)).toBeDefined()
      const refused = await host.ctx.tools
        .execute({
          calls: [
            { type: 'tool-call', id: ToolCallId(`schedule-child-${name}`), name, arguments: JSON.stringify(args) },
          ],
          agent: teammate,
          signal: new AbortController().signal,
        })
        .then((batch) => required(batch.results[0]).result)
      expect(refused.isError).toBe(false)
      expect(refused.value).toMatchObject({ code: 'subagent_session' })
    }
    expect(await host.ctx.schedule.catalog()).toEqual(beforeRefusedCalls)
    expect((await host.ctx.schedule.catalog()).some((task) => task.id === created.id)).toBe(false)
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
          (task) =>
            task.target.kind === 'session' &&
            task.target.sessionId === idleSessionId &&
            task.title === 'ACP idle delivery',
        )
        expect(found?.lastDelivery).toBeDefined()
        return required(found)
      },
      { timeout: 15_000, interval: 100 },
    )
    expect(idleTask.lastDelivery).toMatchObject({
      scheduledAt: expect.any(String),
      deliveredAt: expect.any(String),
      targetSessionId: idleSessionId,
    })
    // History is task-wide in RC.1; the receipt, not the caller/creator, names
    // the Session that actually acknowledged this delivery.
    const idleHistory = await host.ctx.schedule.history({ id: idleTask.id, limit: 5 })
    expect(idleHistory).toMatchObject({
      id: idleTask.id,
      records: [expect.objectContaining({ prompt: 'E2E_SCHEDULE_DELIVERY_IDLE', targetSessionId: idleSessionId })],
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
    const idleConversation = page.locator(`[data-conversation-session="${idleSessionId}"]`)
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
          (task) =>
            task.target.kind === 'session' &&
            task.target.sessionId === activeSessionId &&
            task.title === 'ACP active delivery',
        )
        expect(found?.lastDelivery).toBeDefined()
        expect(activeLead.status).toBe('running')
        return required(found)
      },
      { timeout: 15_000, interval: 100 },
    )
    expect(activeTask.target).toEqual({ kind: 'session', sessionId: activeSessionId })
    expect(activeTask.lastDelivery).toMatchObject({ targetSessionId: activeSessionId })
    const activeHistory = await host.ctx.schedule.history({ id: activeTask.id, limit: 5 })
    expect(activeHistory).toMatchObject({
      id: activeTask.id,
      records: [expect.objectContaining({ prompt: 'E2E_SCHEDULE_DELIVERY_ACTIVE', targetSessionId: activeSessionId })],
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
    const activeConversation = page.locator(`[data-conversation-session="${activeSessionId}"]`)
    await activeConversation.getByText('E2E_SCHEDULE_DELIVERED_ACTIVE', { exact: true }).waitFor()
  } finally {
    try {
      await browser.close()
    } finally {
      await host.close()
    }
  }
}, 90_000)

it('preserves a pending Schedule task when the native plugin is disabled and remounted', async () => {
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
    const pendingTask = required((await host.ctx.schedule.catalog()).find((task) => task.id === taskId))
    expect(pendingTask.target).toEqual({ kind: 'session', sessionId: recoverySessionId })
    const scheduledAt = Date.parse(pendingTask.scheduledAt)
    expect(scheduledAt).toBeGreaterThan(Date.now())
    const scheduleManager = host.ctx.pluginManager
    const plugin = required(
      (await scheduleManager.listPlugins()).find((row) => row.moduleName === '@deepseek-ai/dsh-schedule'),
    )
    expect(plugin).toMatchObject({ enabled: true, patchId: 'schedule' })
    expect(plugin.readOnlyReason).toBeUndefined()
    const lead = required(host.ctx.agents.get(recoverySessionId))
    const staleEdit = required(host.ctx.tools.get('schedule_edit', lead))
    const lease = required(
      await createDshToolBridge(
        host.ctx,
        recoverySessionId,
        { mcpCapabilities: { http: true } },
        'devin',
        undefined,
        undefined,
        host.ctx.tools.schemas(lead),
      ),
    )
    const client = new Client({ name: 'schedule-remount-e2e', version: '1' })
    try {
      const server = required(lease.servers[0])
      if (!('type' in server) || server.type !== 'http')
        throw new Error('Schedule remount fixture requires its HTTP MCP transport')
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...TOOLS]))
      lease.beginPrompt(new AbortController().signal)
      expect(await scheduleManager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ application: 'applied' })
      await vi.waitFor(() => expect(host.ctx.get('schedule')).toBeUndefined())
      // Removing a captured tool closes the bridge's entire capability lease;
      // the old client cannot query a smaller catalog or dispatch another call.
      expect(lease.signal.aborted).toBe(true)
      expect(lease.signal.reason).toMatchObject({ message: 'ACP DSH tools connection closed' })
      // Native invalidation has already started close; await its idempotent
      // completion rather than racing the transport teardown.
      await lease.close()
      await expect(client.listTools()).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
      await expect(
        client.callTool({ name: 'schedule_edit', arguments: { id: taskId, action: 'delete' } }),
      ).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
    } finally {
      lease.endPrompt()
      try {
        await client.close()
      } finally {
        await lease.close()
      }
    }
    expect(TOOLS.map((name) => host.ctx.tools.get(name, lead))).toEqual([undefined, undefined, undefined, undefined])
    const staleArgs = { id: 'schedule-stale-tool-after-disable', action: 'delete' }
    const staleResult = await staleEdit.execute(staleArgs, {
      callId: ToolCallId('schedule-stale-call'),
      rootCallId: ToolCallId('schedule-stale-call'),
      token: Symbol('schedule-stale-tool-after-disable') as ToolExecutionToken,
      name: 'schedule_edit',
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
    expect(
      readFileSync(fixtureLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.kind === 'delivery-consumed'),
    ).toEqual([])

    expect(await scheduleManager.setPluginEnabled(plugin.entryId, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.get('schedule')).toBeDefined())
    await vi.waitFor(() => expect(TOOLS.every((name) => host.ctx.tools.get(name, lead) !== undefined)).toBe(true))
    await vi.waitFor(
      async () => {
        expect((await host.ctx.schedule.catalog()).find((task) => task.id === taskId)?.lastDelivery).toBeDefined()
      },
      { timeout: 15_000, interval: 100 },
    )
    const recovered = required((await host.ctx.schedule.catalog()).find((task) => task.id === taskId))
    expect(recovered).toMatchObject({
      id: taskId,
      target: { kind: 'session', sessionId: recoverySessionId },
      title: pendingTask.title,
      prompt: pendingTask.prompt,
      scheduledAt: pendingTask.scheduledAt,
    })
    expect(Date.parse(required(recovered.lastDelivery).deliveredAt)).toBeGreaterThanOrEqual(disabledAt)
    expect(recovered.lastDelivery).toMatchObject({ targetSessionId: recoverySessionId })
    const recoveryHistory = await host.ctx.schedule.history({ id: recovered.id, limit: 5 })
    expect(recoveryHistory).toMatchObject({
      id: recovered.id,
      records: [
        expect.objectContaining({ prompt: 'E2E_SCHEDULE_DELIVERY_ACTIVE', targetSessionId: recoverySessionId }),
      ],
    })
    const recoveryConversation = page.locator(`[data-conversation-session="${recoverySessionId}"]`)
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
