import type { AcpRemoteService } from '../../src/remote/service.js'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { waitForTeamSettlement } from './team-settlement.ts'
import {
  installTeamFixtureApprovals,
  teamMemberSetupSteps,
  teamReplySteps,
  teamStartSteps,
} from './team-fixture-approval.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it('persists teammate model selection, applies it on wake, and protects Team boundaries', async ({
  onTestFinished,
}) => {
  const host = await launchAdapterWorld({ teams: true })
  let browser!: TestBrowser
  let page!: Page
  const log = join(host.workspaceCwd, 'team-model-selection.log')
  const policyGate = join(host.workspaceCwd, 'team-model-policy-ready')
  const events: ObservedEvent[] = []
  const drivers: ReturnType<typeof installTeamFixtureApprovals>[] = []
  const setupDecisions = (options: Parameters<typeof installTeamFixtureApprovals>[1]) => {
    const driver = installTeamFixtureApprovals(host, options)
    drivers.push(driver)
    return driver
  }
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  const diagnosticDirectory = join(root, '.local/team-model-selection')
  let stage = 'setup'
  const audit = (phase: 'asked' | 'decided') => {
    try {
      return acpPermissionAudit(host, phase)
    } catch {
      return { unavailable: true }
    }
  }
  const capture = (nextStage = stage, name = 'progress.json') => {
    stage = nextStage
    mkdirSync(diagnosticDirectory, { recursive: true })
    writeFileSync(
      join(diagnosticDirectory, name),
      JSON.stringify(
        {
          stage,
          at: Date.now(),
          workspaceCwd: host.workspaceCwd,
          events,
          approvals: audit('asked'),
          decisions: audit('decided'),
        },
        null,
        2,
      ),
    )
    if (existsSync(log)) writeFileSync(join(diagnosticDirectory, 'mock.log'), readFileSync(log))
  }
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      for (const driver of drivers) driver.dispose()
      try {
        await browser?.close()
      } finally {
        await host.close()
      }
    })())
  // A test timeout does not reject the body await. Preserve the actual wait
  // stage and dispose this fixture through the runner's lifecycle as well.
  onTestFinished(async () => {
    if (!cleanupPromise) {
      try {
        capture(stage, 'runner-finished.json')
      } finally {
        await cleanup()
      }
    }
  })
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        devin: {
          name: 'ACP model fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_LOG: log,
            MOCK_TEAM_PERMISSION_GATE: policyGate,
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-devin')).toBe(true),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })

    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string) => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }

    const bootstrap = setupDecisions({
      initialPrompt: 'E2E_TEAM_START',
      entries: [...teamStartSteps(host), ...teamMemberSetupSteps('calculator')],
    })
    capture('bootstrap-send')
    await send('E2E_TEAM_START')
    await page.getByText('E2E_TEAM_READY', { exact: true }).waitFor()
    const lead = required(
      host.ctx.agents.list().find((agent) => host.ctx.agentTeams.tryMembership(agent)?.role === 'lead'),
    )
    await vi.waitFor(
      () =>
        expect(
          readdirSync(host.workspaceCwd).filter(
            (name) => name.startsWith('team-model-policy-ready.') && name.endsWith('.ready'),
          ),
        ).toHaveLength(1),
      { timeout: 30000 },
    )
    bootstrap.finish()
    await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'ask' })
    writeFileSync(policyGate, 'ready')
    const child = required(host.ctx.agentTeams.listMembers(lead).find((member) => member.role === 'teammate'))
    expect(lead).toBeDefined()
    expect(child).toMatchObject({ name: 'calculator' })

    // The member's first prompt is waiting for approval, so its running turn is
    // not mutable. Invalid ownership/targets are rejected before model lookup.
    const approvals = page.locator('[data-acp-team-approvals]')
    await approvals.locator('[data-team-pending-member="calculator"]').waitFor()
    await expect(
      (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, child.id, 'mock-model-b'),
    ).rejects.toThrow()
    await expect(
      (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels('foreign-lead', child.id),
    ).rejects.toThrow()
    await expect((host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, lead.id)).rejects.toThrow()

    // Settle the approval and wait until the member has become dormant. A
    // dormant selection must be persisted without starting another request.
    const initialSettlementAfter = events.length
    await approvals
      .locator('[data-team-pending-member="calculator"]')
      .getByRole('button', { name: 'Allow once', exact: true })
      .click()
    await expect
      .poll(() => host.ctx.agentTeams.listMembers(lead).find((member) => member.id === child.id)?.status, {
        timeout: 30000,
      })
      .toSatisfy((status) => status === 'idle' || status === 'inactive')
    capture('initial-member-settlement')
    await waitForTeamSettlement(events, { parentId: lead.id, childId: child.id, after: initialSettlementAfter })
    await (host.ctx.get('dshAcp') as AcpRemoteService).setToolApprovalPolicy(lead.id, { policy: 'auto' })
    await expect(
      (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(lead.id, child.id, 'unknown-model'),
    ).rejects.toThrow()
    const beforeSaveLog = readFileSync(log, 'utf8')
    const saved = await (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberModel(
      lead.id,
      child.id,
      'mock-model-b',
    )
    expect(saved).toMatchObject({ currentModel: 'mock-model-a', pendingModel: 'mock-model-b', writable: true })
    expect(readFileSync(log, 'utf8')).toBe(beforeSaveLog)

    const initial = await (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id)
    expect(initial).toMatchObject({ currentModel: 'mock-model-a', pendingModel: 'mock-model-b', writable: true })
    expect(initial.models).toEqual(
      expect.arrayContaining([
        { id: 'mock-model-a', name: 'Mock Model A' },
        { id: 'mock-model-b', name: 'Mock Model B' },
      ]),
    )

    const panel = page.locator('[data-acp-team-management], [data-acp-team-panel]')
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const catalog = await service.teamMemberModels(lead.id, child.id)
    // Exercise the mounted picker with an opaque catalog id that resembles
    // the menu's synthetic placeholder namespace. The host fixture does not
    // advertise such an id, so adapt its catalog response and capture the
    // actual write handler call, then remount against the real catalog.
    const catalogSpy = vi.spyOn(service, 'teamMemberModels').mockResolvedValue({
      ...catalog,
      models: [...catalog.models, { id: '__vendor_model', name: 'Vendor model' }],
    })
    const writeSpy = vi.spyOn(service, 'setTeamMemberModel').mockImplementation(async (_lead, _member, model) => {
      if (model === '__vendor_model') return { ...catalog, pendingModel: model }
      return catalog
    })
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    const row = panel.locator('[data-acp-managed-member="calculator"]')
    try {
      const opaqueModelButton = row.getByRole('button', { name: 'Choose a model for calculator', exact: true })
      await opaqueModelButton.waitFor()
      await opaqueModelButton.click()
      await page.getByRole('menu').getByRole('menuitem', { name: 'Vendor model', exact: true }).click()
      await expect.poll(() => writeSpy.mock.calls.some((call) => call[2] === '__vendor_model')).toBe(true)
    } finally {
      writeSpy.mockRestore()
      catalogSpy.mockRestore()
    }
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    await row
      .getByRole('status')
      .filter({ hasText: /mock[ -]model[ -]a/i })
      .waitFor()
    const modelButton = row.getByRole('button', { name: 'Choose a model for calculator', exact: true })
    await modelButton.waitFor()
    // IDs stay lower-case on the wire; all visible labels use catalog names,
    // including before the picker has ever been opened.
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    expect(await row.locator('[data-member-model-notice]').textContent()).toBe(
      'Applies next request; current: Mock Model A',
    )
    await modelButton.click()
    const modelMenu = page.getByRole('menu')
    await modelMenu.getByRole('menuitem', { name: 'Mock Model A', exact: true }).waitFor()
    await modelMenu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).waitFor()
    await modelMenu.getByRole('menuitem', { name: 'Mock Model A', exact: true }).click()
    await expect
      .poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id))
      .toMatchObject({ pendingModel: null })
    await expect.poll(() => row.locator('[data-member-model-notice]').textContent()).toBe('')
    expect(await modelButton.textContent()).toBe('Mock Model A')
    const beforeModelNotice = await row.boundingBox()
    const beforeModeButton = await row.getByRole('button', { name: /^(?:Session|会话) ·/ }).boundingBox()
    expect(required(await row.locator('[data-member-model-notice]').boundingBox()).height).toBeGreaterThanOrEqual(18)
    await modelButton.click()
    expect(await row.getByRole('searchbox').count()).toBe(0)
    await modelMenu.getByRole('menuitem', { name: 'Mock Model B', exact: true }).click()
    await row
      .getByRole('status')
      .filter({ hasText: /mock[ -]model[ -]a/i })
      .waitFor()
    expect(await row.boundingBox()).toMatchObject({
      x: beforeModelNotice!.x,
      y: beforeModelNotice!.y,
      width: beforeModelNotice!.width,
    })
    expect(await row.locator('[data-member-model-notice]').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(
      true,
    )
    expect(await row.getByRole('button', { name: /^(?:Session|会话) ·/ }).boundingBox()).toMatchObject({
      x: beforeModeButton!.x,
      width: beforeModeButton!.width,
      height: beforeModeButton!.height,
    })
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // Closing and reopening remounts the card. Display names must not revert
    // to IDs or depend on a previous click of the model selector.
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // A transport reload restores current A plus pending B from the sidecar.
    capture('reload-model-picker')
    await page.reload()
    await panel.getByRole('button', { name: 'Manage members · 1', exact: true }).click()
    await row
      .getByRole('status')
      .filter({ hasText: /mock[ -]model[ -]a/i })
      .waitFor()
    await expect.poll(() => modelButton.textContent()).toBe('Mock Model B')
    expect(await row.locator('[data-member-model-notice]').textContent()).toBe(
      'Applies next request; current: Mock Model A',
    )
    await panel.getByRole('button', { name: 'Close member management', exact: true }).click()

    // team-turn logs configOptions.model for each request. This is the request
    // header evidence: the first wake must carry B and the second must retain it.
    const countModelB = () => (readFileSync(log, 'utf8').match(/team model=mock-model-b/g) ?? []).length
    const wakeDecisions = () =>
      setupDecisions({
        root: lead,
        entries: [
          { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {} },
          {
            owner: 'lead',
            callId: 'team-2',
            tool: 'send_message',
            args: { target: 'calculator', message: 'E2E_TEAM_CONTINUE' },
          },
          { owner: 'calculator', callId: 'team-1', tool: 'list_agents', args: {} },
          {
            owner: 'calculator',
            callId: 'team-2',
            tool: 'send_message',
            args: { target: 'lead', message: 'E2E_TEAM_REPLY continued' },
          },
          ...teamReplySteps(),
        ],
      })
    capture('first-wake')
    const firstWakeAfter = events.length
    const firstWake = wakeDecisions()
    const firstBCount = countModelB()
    await send('E2E_TEAM_WAKE')
    await expect.poll(() => readFileSync(log, 'utf8'), { timeout: 30000 }).toContain('team model=mock-model-b')
    await expect.poll(countModelB, { timeout: 30000 }).toBeGreaterThan(firstBCount)
    await expect
      .poll(
        () =>
          events.filter(
            (event) => event.sessionId === child.id && JSON.stringify(event).includes('E2E_TEAM_MEMBER_CONTINUED'),
          ).length,
        { timeout: 30000 },
      )
      .toBeGreaterThan(0)
    await expect
      .poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id), { timeout: 30000 })
      .toMatchObject({ currentModel: 'mock-model-b', pendingModel: null, writable: true })

    capture('first-wake-native-settlement')
    await waitForTeamSettlement(events, { parentId: lead.id, childId: child.id, after: firstWakeAfter })
    await lead.whenIdle()
    firstWake.finish()
    capture('second-wake')
    const secondWakeAfter = events.length
    const secondWake = wakeDecisions()
    const secondBCount = countModelB()
    await send('E2E_TEAM_WAKE')
    await expect.poll(countModelB, { timeout: 30000 }).toBeGreaterThan(secondBCount)
    await expect
      .poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id), { timeout: 30000 })
      .toMatchObject({ currentModel: 'mock-model-b', pendingModel: null, writable: true })

    capture('second-wake-native-settlement')
    await waitForTeamSettlement(events, { parentId: lead.id, childId: child.id, after: secondWakeAfter })
    await lead.whenIdle()
    secondWake.finish()
    expect(required(host.ctx.get('agentDefaultModel')).currentSelection()).toMatchObject({
      provider: 'acp-devin',
      model: 'mock-model-a',
    })
    expect(lead.session.requestHeader()?.config.model).toBe('mock-model-a')
    expect(
      events
        .filter((event) => event.type === 'request/header')
        .filter((event) => event.sessionId === child.id)
        .slice(-2)
        .map((event) => event.data.header.config.model),
    ).toEqual(['mock-model-b', 'mock-model-b'])
    const siblingSetup = setupDecisions({
      root: lead,
      entries: [
        { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {} },
        {
          owner: 'lead',
          callId: 'team-2',
          tool: 'spawn_teammate',
          args: {
            name: 'calculator-b',
            description: 'Model B member',
            prompt: 'E2E_TEAM_MEMBER calculate 1+1',
            context: 'fresh',
          },
        },
        ...teamMemberSetupSteps('calculator-b'),
      ],
    })
    capture('second-member-send')
    await send('E2E_TEAM_SECOND')
    // A teammate's settlement notice can continue the same native Turn and
    // fold this earlier reply. Readiness is its durable message plus the
    // visible management entry, not whether process text remains expanded.
    const secondReady = () =>
      events.find(
        (event) =>
          event.sessionId === lead.id &&
          event.type === 'assistant/message' &&
          event.data.message.content.some((block) => block.type === 'text' && block.text === 'E2E_TEAM_SECOND_READY'),
      )
    await expect.poll(secondReady, { timeout: 30000 }).toBeDefined()
    capture('second-member-management-ready')
    await panel.getByRole('button', { name: 'Manage members · 2', exact: true }).waitFor()
    const sibling = required(host.ctx.agentTeams.listMembers(lead).find((member) => member.name === 'calculator-b'))
    await expect
      .poll(
        () =>
          acpPermissionAudit(host, 'asked').filter(
            (entry) => entry.sessionId === sibling.id && entry.data.toolCall.toolCallId === 'member-shell',
          ),
        { timeout: 30000 },
      )
      .toHaveLength(1)
    siblingSetup.finish()
    await expect
      .poll(
        () =>
          events.filter((event) => event.type === 'request/header').findLast((event) => event.sessionId === sibling.id)
            ?.data.header.config.model,
      )
      .toBe('mock-model-a')
    expect((await (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id)).currentModel).toBe(
      'mock-model-b',
    )

    // Keep the ACP controls mounted across a member turn. The live status
    // transition refreshes metadata, while current and next model facts stay
    // distinct until the pending choice is consumed.
    const management = page.locator('[data-acp-team-management], [data-acp-team-panel]')
    const managementPanel = page.locator('[data-acp-team-panel]')
    const manageMembersButton = management.getByRole('button', { name: 'Manage members · 2', exact: true })
    await manageMembersButton.click()
    await modelButton.click()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Mock Model A', exact: true }).click()
    expect(await row.locator('[data-member-model-notice]').textContent()).toBe(
      'Applies next request; current: Mock Model B',
    )
    const countModelA = () => (readFileSync(log, 'utf8').match(/team model=mock-model-a/g) ?? []).length
    const secondACount = countModelA()
    capture('final-model-a-continuation')
    const continuationAfter = events.length
    const continuation = setupDecisions({
      root: lead,
      entries: [
        { owner: 'calculator', callId: 'team-1', tool: 'list_agents', args: {} },
        {
          owner: 'calculator',
          callId: 'team-2',
          tool: 'send_message',
          args: { target: 'lead', message: 'E2E_TEAM_REPLY continued' },
        },
        ...teamReplySteps(),
      ],
    })
    await host.ctx.agentTeams.sendMessage(lead, {
      target: 'calculator',
      content: [{ type: 'text', text: 'E2E_TEAM_CONTINUE' }],
      signal: new AbortController().signal,
    })
    await expect.poll(countModelA, { timeout: 30000 }).toBeGreaterThan(secondACount)
    await expect
      .poll(() => host.ctx.agentTeams.listMembers(lead).find((member) => member.id === child.id)?.status, {
        timeout: 30000,
      })
      .toSatisfy((status) => status === 'idle' || status === 'inactive')
    await expect
      .poll(() => (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id), { timeout: 30000 })
      .toMatchObject({ currentModel: 'mock-model-a', pendingModel: null, writable: true })
    capture('final-continuation-native-settlement')
    await waitForTeamSettlement(events, { parentId: lead.id, childId: child.id, after: continuationAfter })
    await lead.whenIdle()
    continuation.finish()
    await expect.poll(() => modelButton.textContent(), { timeout: 30000 }).toBe('Mock Model A')
    await expect.poll(() => row.locator('[data-member-model-notice]').textContent(), { timeout: 30000 }).toBe('')
    await expect.poll(() => modelButton.isEnabled(), { timeout: 30000 }).toBe(true)
    await modelButton.click()
    await expect(
      page.getByRole('menu').getByRole('menuitem', { name: 'Mock Model B', exact: true }).isEnabled(),
    ).resolves.toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    await expect.poll(() => managementPanel.count()).toBe(1)
    await expect.poll(() => modelButton.evaluate((button) => button.getAttribute('aria-expanded'))).toBe('false')
    await expect.poll(() => modelButton.evaluate((button) => button === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => managementPanel.count()).toBe(0)
    await expect.poll(() => manageMembersButton.evaluate((button) => button === document.activeElement)).toBe(true)
    capture('completed')
  } catch (error) {
    capture()
    const directory = join(root, '.local/team-model-selection')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'events.json'), JSON.stringify(events, null, 2))
    if (page) {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {})
      const state = await page
        .getByText('E2E_TEAM_SECOND_READY', { exact: true })
        .evaluateAll((elements) =>
          elements.map((element) => {
            const ancestors = []
            for (let parent: Element | null = element; parent !== null; parent = parent.parentElement) {
              const style = getComputedStyle(parent)
              ancestors.push({
                tag: parent.tagName,
                attributes: Object.fromEntries([...parent.attributes].map(({ name, value }) => [name, value])),
                display: style.display,
                visibility: style.visibility,
                contentVisibility: style.contentVisibility,
              })
            }
            return ancestors
          }),
        )
        .catch(() => [])
      writeFileSync(join(directory, 'marker-ancestors.json'), JSON.stringify(state, null, 2))
    }
    throw error
  } finally {
    await cleanup()
  }
}, 120000)
