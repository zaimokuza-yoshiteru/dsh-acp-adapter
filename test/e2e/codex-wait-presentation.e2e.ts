import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, expandOwningTurnProcess, writeComposerDraft } from '#host-support'
import type { AcpRemoteService } from '../../src/remote/service.js'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { required } from './required.ts'
import type { ObservedEvent } from './types.ts'
import { waitForTeamSettlement } from './team-settlement.ts'

const directory = process.env.DSH_E2E_WAIT_CONTROL_DIRECTORY ?? join(root, '.local/codex-wait-presentation')
const before = process.env.DSH_E2E_WAIT_CONTROL_BASELINE === '1'

it('proves deferred Codex wait through the native MCP bridge and keeps untrusted errors visible', async (context) => {
  mkdirSync(directory, { recursive: true })
  let host: AdapterWorld | undefined
  let browser: TestBrowser | undefined
  let page: Page | undefined
  const events: ObservedEvent[] = []
  const executions: { name: string; isError: boolean }[] = []
  const errors: string[] = []
  const evidence: Record<string, unknown> = {
    kind: 'keyless real Host/MCP/browser, scripted Codex wire',
    before,
    screenshots: [],
  }
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        if (host) {
          const log = join(host.workspaceCwd, 'wait-control-agent.log')
          if (existsSync(log)) writeFileSync(join(directory, 'fixture.log'), readFileSync(log))
          for (const name of ['control-invalid-wait.json', 'control-deferred-wait.json', 'control-child-send.json'])
            if (existsSync(join(host.workspaceCwd, name)))
              writeFileSync(join(directory, name), readFileSync(join(host.workspaceCwd, name)))
        }
        writeFileSync(
          join(directory, 'evidence.json'),
          JSON.stringify({ ...evidence, events, executions, errors }, null, 2),
        )
      } finally {
        try {
          await browser?.close()
        } finally {
          await host?.close()
        }
      }
    })())
  context.onTestFinished(cleanup)
  try {
    host = await launchAdapterWorld({ teams: true, adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
    const activeHost = host
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    host.ctx.on('tools/result', (execution, result) => {
      executions.push({ name: execution.name, isError: result.isError })
    })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        codex: {
          name: 'Codex wait protocol fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_MCP_HTTP: '1',
            MOCK_LOG: join(host.workspaceCwd, 'wait-control-agent.log'),
            MOCK_WAIT_CONTROL_GATE_DIR: host.workspaceCwd,
            MOCK_WAIT_CONTROL_BASELINE: before ? '1' : '0',
          },
        },
      },
    })
    await vi.waitFor(() => expect(activeHost.ctx.llm.listProviders().some((p) => p.id === 'acp-codex')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    await host.ctx.settings.replace('ui-chat', { transcriptView: 'standard', collapseTiming: 'next-input' })
    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    page = await newEnglishPage(browser)
    const activePage = page
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_CONTROL_WAIT_START')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await vi.waitFor(() => expect(existsSync(join(activeHost.workspaceCwd, 'control-parent-ready'))).toBe(true), {
      timeout: 30_000,
    })
    const lead = required(host.ctx.agents.roots().find((agent) => agent.options.provider === 'acp-codex'))
    evidence.leadId = lead.id
    const child = await host.ctx.agentTeams.spawnTeammate(lead, {
      name: 'courier',
      description: 'Send one real native relay',
      context: 'fresh',
      provider: 'spawn',
      prompt: [{ type: 'text', text: 'E2E_CONTROL_WAIT_CHILD' }],
      signal: context.signal,
    })
    evidence.childId = child.member.id
    await vi.waitFor(
      () =>
        expect(
          lead.inbox.nextStep.some(
            (message) =>
              message.source.kind === 'agent-message' &&
              'senderSessionId' in message.source &&
              message.source.senderSessionId === child.member.id &&
              JSON.stringify(message.content).includes('E2E_CONTROL_WAIT_REPLY'),
          ),
        ).toBe(true),
      { timeout: 30_000 },
    )
    evidence.queuedBeforeWait = lead.inbox.nextStep
    const nativeWaitsBefore = executions.filter((execution) => execution.name === 'wait_agent').length
    writeFileSync(join(host.workspaceCwd, 'control-run-wait'), 'go')
    await vi.waitFor(() => expect(existsSync(join(activeHost.workspaceCwd, 'control-result-ready'))).toBe(true), {
      timeout: 30_000,
    })
    expect(executions.filter((execution) => execution.name === 'wait_agent')).toHaveLength(nativeWaitsBefore)
    expect(
      lead.inbox.nextStep.some((message) => JSON.stringify(message.content).includes('E2E_CONTROL_WAIT_REPLY')),
    ).toBe(true)
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const readRows = async () => {
      const snapshot = await service.activitySnapshot(lead.id, { limit: 100 })
      return Promise.all(
        snapshot.activities.filter((row) => row.kind === 'tool').map((row) => service.activityDetail(lead.id, row)),
      )
    }
    await vi.waitFor(async () => {
      const rows = await readRows()
      const deferred = required(rows.find((row) => row.activityId.endsWith(':control-deferred-wait')))
      expect(deferred.status).toBe('failed')
      if (before) expect(JSON.parse(required(deferred.rawDetail))).not.toHaveProperty('hostControlOutcome')
      else
        expect(JSON.parse(required(deferred.rawDetail))).toMatchObject({
          hostControlOutcome: {
            source: 'dsh-tool-bridge',
            kind: 'deferred-team-message',
            dshSessionId: lead.id,
            toolCallId: 'control-deferred-wait',
            tool: 'wait_agent',
            executed: false,
          },
        })
      for (const suffix of ['control-invalid-wait', 'control-untrusted-marker']) {
        const row = required(rows.find((row) => row.activityId.endsWith(`:${suffix}`)))
        expect(row.status).toBe('failed')
        expect(JSON.parse(required(row.rawDetail))).not.toHaveProperty('hostControlOutcome')
      }
    })
    evidence.activityBeforeReload = await readRows()
    const oldCard = activePage.locator('[data-chat-call-id$=":control-deferred-wait"] [data-tool="wait_agent"]')
    const control = () =>
      before
        ? oldCard.locator('[data-disclosure-row][role="button"]').first()
        : activePage.locator('[data-disclosure-row][role="button"]').filter({ hasText: 'Wait for team reply' })
    await control().waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, control())
    if ((await control().getAttribute('aria-expanded')) !== 'true') await control().click()
    const body = before ? oldCard : page.locator('[data-acp-host-control="deferred-team-message"]')
    await body.waitFor()
    expect(await page.locator('[data-tool="wait_agent"][data-state="error"]').count()).toBe(before ? 3 : 2)
    if (before) {
      expect(await body.innerText()).toContain('DSH_WAIT_DEFERRED_TEAM_MESSAGE:')
      expect(await body.innerText()).toContain('structuredContent')
    } else {
      expect(await body.innerText()).toContain('A team reply is queued.')
      expect(await body.innerText()).not.toMatch(/DSH_WAIT_|End this ACP|structuredContent|zaimokuza.dsh\/acp-control/)
      expect(JSON.stringify(evidence.activityBeforeReload)).toContain('DSH_WAIT_DEFERRED_TEAM_MESSAGE:')
    }
    const screenshot = async (name: string) => {
      await activePage.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' })
      ;(evidence.screenshots as string[]).push(`${name}.png`)
    }
    await screenshot('running-wide-light')
    writeFileSync(join(host.workspaceCwd, 'control-finish-turn'), 'go')
    await page.getByText('E2E_CONTROL_WAIT_RECEIVED', { exact: true }).waitFor()
    await waitForTeamSettlement(events, { parentId: lead.id, childId: child.member.id, after: 0 })
    await lead.whenIdle()
    expect(await control().getAttribute('aria-expanded')).toBe('true')
    expect(
      events.some(
        (event) =>
          event.sessionId === lead.id &&
          event.type === 'user/message' &&
          JSON.stringify(event.data.content).includes('E2E_CONTROL_WAIT_REPLY'),
      ),
    ).toBe(true)
    expect(
      events
        .filter((event) => event.sessionId === lead.id && event.type === 'turn/end')
        .every((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed'),
    ).toBe(true)
    await page.reload()
    await control().waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, control())
    // A new page follows the native disclosure default; open it if necessary.
    // State preservation is required across streaming settlement, not invented across reload.
    if ((await control().getAttribute('aria-expanded')) !== 'true') await control().click()
    await body.waitFor()
    evidence.activityAfterReload = await readRows()
    for (const theme of ['light', 'dark']) {
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => activePage.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const width of [1680, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await control().scrollIntoViewIfNeeded()
        const bounds = required(await control().boundingBox())
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
        if (!before) expect(await body.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await control().getAttribute('aria-expanded')).toBe('true')
        await screenshot(`restored-${theme}-${width}`)
      }
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    if (!before)
      await page.locator('[data-disclosure-row][role="button"]').filter({ hasText: '等待团队回信' }).waitFor()
    await screenshot('restored-wide-zh-dark')
    expect(errors).toEqual([])
    evidence.result = 'passed'
  } catch (error) {
    evidence.result = 'failed'
    evidence.error = error instanceof Error ? error.stack : String(error)
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await cleanup()
  }
}, 120_000)
