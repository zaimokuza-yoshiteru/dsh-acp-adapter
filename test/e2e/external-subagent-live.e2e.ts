import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'

it('shows external Devin children live, then persists only successful terminal children read-only', async () => {
  const host = await launchAdapterWorld()
  const evidenceDirectory = process.env.DSH_ACP_UI_EVIDENCE
  const evidence = evidenceDirectory ?? host.workspaceCwd
  if (evidenceDirectory !== undefined) mkdirSync(evidenceDirectory, { recursive: true })
  const gateDirectory = join(host.workspaceCwd, 'external-subagent-live-gate')
  const agentLog = join(host.workspaceCwd, 'external-subagent-mock-agent.log')
  mkdirSync(gateDirectory, { recursive: true })
  let browser!: TestBrowser
  const sessionEvents: { sessionId: string; type: string; data: unknown }[] = []
  host.ctx.on('session/event', (session, event) => {
    sessionEvents.push({ sessionId: session.id, type: event.type, data: event.data })
  })
  const releaseGates = [
    'release-success-launch-tool',
    'release-success-child-terminal',
    'release-failure-launch-tool',
    'release-failure-child-terminal',
    'release-parent-cancelled-launch-tool',
    'release-parent-cancelled-child-terminal',
  ]
  const gate = (name: string) => join(gateDirectory, name)
  const waitForGate = async (name: string) =>
    await vi.waitFor(() => expect(existsSync(gate(name))).toBe(true), { timeout: 30_000 })
  const externalChildren = async () =>
    (await host.ctx.sessionPersistence.list()).filter((item) => item.header.origin === 'subagent')
  const capturePassEvidence = async (page: Page, name: string) => {
    if (evidenceDirectory === undefined) return
    await page.screenshot({ path: join(evidenceDirectory, `external-subagent-${name}.png`), fullPage: true })
  }
  const expectExactlyOneToolRow = async (row: Locator) => {
    await expect.poll(() => row.count(), { timeout: 8_000 }).toBe(1)
    await row.waitFor({ state: 'visible' })
  }
  const expandTurnProcess = async (page: Page, turn: number) => {
    const control = page.locator(`[data-turn-process="${turn}"][data-turn-process-tool-calls]`)
    await control.waitFor({ state: 'visible' })
    if ((await control.getAttribute('aria-expanded')) === 'false') {
      expect(await control.isEnabled()).toBe(true)
      await control.click()
    }
    await expect.poll(() => control.getAttribute('aria-expanded')).toBe('true')
    const stepProcess = page.locator(`[data-step-process][data-chat-turn="${turn}"] > div > button`)
    await stepProcess.waitFor({ state: 'visible' })
    if ((await stepProcess.getAttribute('aria-expanded')) === 'false') {
      expect(await stepProcess.isEnabled()).toBe(true)
      await stepProcess.click()
    }
    await expect.poll(() => stepProcess.getAttribute('aria-expanded')).toBe('true')
  }
  const expectNoChildControlForRow = async (page: Page, row: Locator) => {
    const owner = row.locator(
      'xpath=ancestor::*[@data-chat-flow-kind="acp-activity" or @data-chat-flow-kind="tool-call"][1]',
    )
    await owner.waitFor({ state: 'visible' })
    await expect.poll(() => owner.getByRole('button', { name: /Open read-only record/ }).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: /Open read-only record/ }).count()).toBeLessThanOrEqual(1)
  }
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        devin: {
          name: 'Gated Devin child fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_EXTERNAL_CHILD_GATE_DIR: gateDirectory,
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    const send = async (scenario: 'SUCCESS' | 'FAILURE' | 'PARENT_CANCELLED') => {
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), `E2E_EXTERNAL_CHILD_${scenario}`)
      const settled = host.whenTurnSettled(60_000)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const key = scenario.toLowerCase().replaceAll('_', '-')
      await waitForGate(`${key}-started.ready`)
      const rowFor = (status: string) =>
        page.getByRole('button', {
          name: new RegExp(`External agent.*${key} research.*${status}.*Inspect fixture`, 'i'),
        })
      const parentValidation = page.getByRole('button', { name: /Parent validation/ })
      const running = rowFor('Running')
      try {
        await expectExactlyOneToolRow(running)
        if (scenario === 'SUCCESS') await expectExactlyOneToolRow(parentValidation)
      } catch (error) {
        await page.screenshot({ path: join(evidence, 'external-subagent-failure-running-dom.png'), fullPage: true })
        writeFileSync(join(evidence, 'external-subagent-failure-running-dom.html'), await page.content())
        writeFileSync(
          join(evidence, 'external-subagent-failure-running-dom.txt'),
          await page.locator('body').innerText(),
        )
        const diagnostics: Record<string, unknown> = { scenario, sessionEvents }
        diagnostics.fixtureLog = existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '[missing]'
        try {
          const sessions = await host.ctx.sessionPersistence.list()
          diagnostics.sessions = sessions.map((item) => ({ id: item.header.id, header: item.header }))
          const remote = host.ctx.get('dshAcp') as {
            activitySnapshot: (id: string) => Promise<unknown>
            activityPage: (id: string, request?: { afterRevision?: number; limit?: number }) => Promise<unknown>
          }
          diagnostics.activity = await Promise.all(
            sessions.map(async (item) => {
              const id = item.header.id
              const result: Record<string, unknown> = { id }
              try {
                result.snapshot = await remote.activitySnapshot(id)
                result.page = await remote.activityPage(id, { afterRevision: 0, limit: 200 })
              } catch (readError) {
                result.readError = String(readError)
              }
              try {
                const handle = await host.ctx.sessionPersistence.open(id, 'read')
                try {
                  result.events = (await handle.read()).events
                } finally {
                  await handle.close()
                }
              } catch (readError) {
                result.sessionReadError = String(readError)
              }
              return result
            }),
          )
        } catch (diagnosticError) {
          diagnostics.captureError = String(diagnosticError)
        }
        writeFileSync(join(evidence, 'external-subagent-failure-host-state.json'), JSON.stringify(diagnostics, null, 2))
        throw error
      }
      await capturePassEvidence(page, `${key}-running`)
      await expect.poll(async () => (await externalChildren()).length).toBe(scenario === 'SUCCESS' ? 0 : 1)
      await expectNoChildControlForRow(page, running)

      writeFileSync(gate(`release-${key}-launch-tool`), 'release')
      await waitForGate(`${key}-launch-tool-completed.ready`)
      // The launch tool is terminal while the remote child remains live.
      await expect.poll(async () => (await externalChildren()).length).toBe(scenario === 'SUCCESS' ? 0 : 1)
      const unconfirmed = rowFor('State unconfirmed')
      await expectExactlyOneToolRow(unconfirmed)
      if (scenario === 'SUCCESS') await expectExactlyOneToolRow(parentValidation)
      await capturePassEvidence(page, `${key}-unconfirmed`)
      await expectNoChildControlForRow(page, unconfirmed)
      return { key, rowFor, parentValidation, settled }
    }

    const success = await send('SUCCESS')
    await expectExactlyOneToolRow(success.parentValidation)
    expect((await externalChildren()).length).toBe(0)
    writeFileSync(gate('release-success-child-terminal'), 'release')
    await waitForGate('success-child-terminal.ready')
    await page.getByText('E2E_EXTERNAL_CHILD_SUCCESS_DONE', { exact: true }).waitFor()
    const successfulParentId = await success.settled
    await expandTurnProcess(page, 1)
    const completed = success.rowFor('Completed')
    await expectExactlyOneToolRow(completed)
    await expectExactlyOneToolRow(success.parentValidation)
    await capturePassEvidence(page, 'success-completed')
    await expect.poll(async () => (await externalChildren()).length).toBe(1)
    const successfulChild = required((await externalChildren())[0])
    expect(successfulChild.header.parentSession).toBe(successfulParentId)
    await vi.waitFor(
      async () => {
        const handle = await host.ctx.sessionPersistence.open(successfulChild.header.id, 'read')
        try {
          const childLog = await handle.read()
          expect(childLog.events.map((event) => event.type)).toEqual([
            'subagent/descriptor',
            'turn/start',
            'step/start',
            'user/message',
            'assistant/message',
            'step/end',
            'turn/end',
          ])
        } finally {
          await handle.close()
        }
      },
      { timeout: 15_000 },
    )
    const childHandle = await host.ctx.sessionPersistence.open(successfulChild.header.id, 'read')
    try {
      const childLog = await childHandle.read()
      expect(childHandle.header).toMatchObject({ origin: 'subagent', parentSession: successfulParentId })
      expect(childLog.events.map((event) => event.type)).toEqual([
        'subagent/descriptor',
        'turn/start',
        'step/start',
        'user/message',
        'assistant/message',
        'step/end',
        'turn/end',
      ])
      expect(JSON.stringify(childLog.events)).toContain('Inspection complete for success.')
    } finally {
      await childHandle.close()
    }

    const expectPersistedSuccessRecord = async (keepExpanded = false) => {
      try {
        expect((await externalChildren()).map((item) => item.header.id)).toEqual([successfulChild.header.id])
        const successStep = page.locator('[data-step-process][data-chat-turn="1"]')
        await expect.poll(() => successStep.count()).toBe(1)
        const successTurnNumber = await successStep.getAttribute('data-chat-turn')
        const successProcess = page.locator(`[data-turn-process="${successTurnNumber}"][data-turn-process-tool-calls]`)
        await expect.poll(() => successProcess.count()).toBe(1)
        const stepToggle = successStep.locator(':scope > div > button')
        const turnWasExpanded = (await successProcess.getAttribute('aria-expanded')) === 'true'
        const stepWasExpanded = (await stepToggle.getAttribute('aria-expanded')) === 'true'
        if (!turnWasExpanded) await successProcess.click()
        if (!stepWasExpanded) await stepToggle.click()

        await expectExactlyOneToolRow(completed)
        await expectExactlyOneToolRow(page.getByRole('button', { name: /Parent validation/ }))
        const owner = completed.locator(
          'xpath=ancestor::*[@data-chat-flow-kind="acp-activity" or @data-chat-flow-kind="tool-call"][1]',
        )
        await expect.poll(() => owner.getByRole('button', { name: /Open read-only record/ }).count()).toBe(1)
        await expect.poll(() => page.getByRole('button', { name: /Open read-only record/ }).count()).toBe(1)

        if (!keepExpanded && !stepWasExpanded) {
          await stepToggle.click()
          await expect.poll(() => stepToggle.getAttribute('aria-expanded')).toBe('false')
        }
        if (!keepExpanded && !turnWasExpanded) {
          await successProcess.click()
          await expect.poll(() => successProcess.getAttribute('aria-expanded')).toBe('false')
        }
      } catch (error) {
        await page.screenshot({
          path: join(evidence, 'external-subagent-success-record-reopen-failure.png'),
          fullPage: true,
        })
        writeFileSync(join(evidence, 'external-subagent-success-record-reopen-failure.html'), await page.content())
        writeFileSync(
          join(evidence, 'external-subagent-success-record-reopen-failure.txt'),
          await page.locator('body').innerText(),
        )
        writeFileSync(
          join(evidence, 'external-subagent-success-record-reopen-failure.json'),
          JSON.stringify(
            {
              error: String(error),
              persistedExternalChildIds: (await externalChildren()).map((item) => item.header.id),
              visibleReadOnlyRecordCount: await page.getByRole('button', { name: /Open read-only record/ }).count(),
              successfulChildId: successfulChild.header.id,
            },
            null,
            2,
          ),
        )
        throw error
      }
    }

    const failure = await send('FAILURE')
    writeFileSync(gate('release-failure-child-terminal'), 'release')
    await waitForGate('failure-child-terminal.ready')
    await page.getByText('E2E_EXTERNAL_CHILD_FAILURE_DONE', { exact: true }).waitFor()
    await failure.settled
    await expandTurnProcess(page, 2)
    const failed = failure.rowFor('Failed')
    await expectExactlyOneToolRow(failed)
    await capturePassEvidence(page, 'failure-failed')
    await expectNoChildControlForRow(page, failed)
    expect((await externalChildren()).map((item) => item.header.id)).toEqual([successfulChild.header.id])
    await expectPersistedSuccessRecord()
    await page.reload()
    await expectPersistedSuccessRecord(true)
    await capturePassEvidence(page, 'success-reloaded')

    const cancelledEventsStart = sessionEvents.length
    const cancelled = await send('PARENT_CANCELLED')
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await cancelled.settled
    // Cancellation before any assistant message keeps the lossless ACP journal
    // fallback flat. Native stopped turns stay open and have no step disclosure.
    const stopped = page.locator('[data-turn-process="3"]')
    await stopped.waitFor({ state: 'visible' })
    expect(await stopped.innerText()).toBe('Stopped')
    expect(await stopped.isDisabled()).toBe(true)
    expect(await stopped.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('[data-step-process][data-chat-turn="3"]').count()).toBe(0)
    expect(await page.locator('[data-chat-flow-kind="acp-activity"][data-chat-turn="3"]').count()).toBe(1)
    const cancelledEvents = sessionEvents
      .slice(cancelledEventsStart)
      .filter((event) => event.sessionId === successfulParentId)
    expect(cancelledEvents.some((event) => event.type === 'assistant/message')).toBe(false)
    expect(cancelledEvents.find((event) => event.type === 'assistant/attempt')?.data).toMatchObject({ stream: [] })
    expect(cancelledEvents.find((event) => event.type === 'turn/end')?.data).toMatchObject({
      reason: { kind: 'aborted' },
    })
    const cancelledRow = cancelled.rowFor('State unconfirmed')
    await expectExactlyOneToolRow(cancelledRow)
    await capturePassEvidence(page, 'parent-cancelled-unconfirmed')
    await expectNoChildControlForRow(page, cancelledRow)
    expect((await externalChildren()).map((item) => item.header.id)).toEqual([successfulChild.header.id])
    await expectPersistedSuccessRecord()
    await expectPersistedSuccessRecord(true)
    await page.getByRole('button', { name: /Open read-only record/ }).click()
    const sidebar = page.locator('[data-sidebar-chat]')
    const notice = sidebar.locator('[data-acp-external-record-notice]')
    const expectReadOnlyRecord = async (name: string) => {
      // The native overlay chain keeps its draft DOM mounted under display:none.
      // Assert the actual user capability and retained fallback, not DOM absence.
      const fallback = sidebar.locator('[data-chain-overlay-fallback="conversation.composer"]')
      const state = await sidebar.evaluate((element) => ({
        composerFallbacks: Array.from(
          element.querySelectorAll<HTMLElement>('[data-chain-overlay-fallback="conversation.composer"]'),
        ).map((node) => ({ display: getComputedStyle(node).display })),
        inputs: Array.from(element.querySelectorAll<HTMLElement>('[data-composer-input]')).map((node) => ({
          editable: node.contentEditable,
          visible: node.getClientRects().length > 0,
          role: node.getAttribute('role'),
        })),
      }))
      if (evidenceDirectory !== undefined) {
        writeFileSync(join(evidenceDirectory, `external-subagent-${name}.dom.json`), JSON.stringify(state, null, 2))
      }
      expect(await fallback.count()).toBe(1)
      expect(await fallback.isVisible()).toBe(false)
      expect(await sidebar.locator('[data-composer-input][contenteditable="true"]:visible').count()).toBe(0)
      expect(await sidebar.getByRole('textbox').count()).toBe(0)
      expect(await sidebar.getByRole('button', { name: /^(Send message|发送消息)$/ }).count()).toBe(0)
    }
    await notice.waitFor()
    await page.setViewportSize({ width: 390, height: 900 })
    for (const locale of ['en', 'zh']) {
      for (const theme of ['light', 'dark']) {
        await host.ctx.settings.replace('locale', { preference: locale })
        await host.ctx.settings.replace('ui-theme', { preference: theme })
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
        await notice
          .getByText(locale === 'en' ? 'External Agent record' : '外部 Agent 只读记录', { exact: true })
          .waitFor()
        expect(await notice.innerText()).toContain(
          locale === 'en' ? 'not its full internal history' : '不包含完整的内部执行过程',
        )
        expect(await sidebar.getByText(/review the full execution record here|查看完整执行记录/).count()).toBe(0)
        await expectReadOnlyRecord(`read-only-summary.${locale}.${theme}.390`)
        expect(
          await notice.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight),
        ).toBe(true)
        const box = required(await notice.boundingBox())
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(391)
        await capturePassEvidence(page, `read-only-summary.${locale}.${theme}.390`)
      }
    }
    await page.reload()
    await notice.waitFor()
    expect(await notice.innerText()).toContain('不包含完整的内部执行过程')
    await expectReadOnlyRecord('read-only-summary.reloaded.zh.dark.390')
    await capturePassEvidence(page, 'read-only-summary.reloaded.zh.dark.390')
  } finally {
    for (const name of releaseGates) writeFileSync(gate(name), 'release')
    await browser?.close()
    await host.close()
  }
})
