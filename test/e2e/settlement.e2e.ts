import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { Page } from 'playwright'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

const localStatus = 'Waiting for tools to finish…'
const savingResultsStatus = 'Saving this turn’s results…'
const storageErrorStatus =
  'This turn’s results have not been saved yet. Local saving will retry automatically when storage is available.'
const optionSnapshotInsertFailure = 'e2e_settlement_fail_option_snapshot_insert'
const optionSnapshotUpdateFailure = 'e2e_settlement_fail_option_snapshot_update'

async function runSettlementCase(mode: 'natural' | 'stop', storageFollowup?: 'continue' | 'stop'): Promise<void> {
  const scenario = `E2E_SETTLEMENT_${mode === 'natural' ? 'NATURAL_ENDTURN' : 'STOP_ENDTURN'}_v1`
  const queuedFollowup = 'E2E_SETTLEMENT_QUEUED_FOLLOWUP_v1'
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  let page: Page | undefined
  const agentLog = join(host.workspaceCwd, 'settlement-agent.log')
  const uiEvidence =
    process.env.DSH_ACP_UI_EVIDENCE === undefined ? undefined : resolve(process.env.DSH_ACP_UI_EVIDENCE)
  const startedFile = join(host.workspaceCwd, 'workspace', '.e2e-settlement-host-tool-started')
  const cancelledFile = join(host.workspaceCwd, 'workspace', '.e2e-settlement-host-tool-cancelled')
  const cleanupFile = join(host.workspaceCwd, 'workspace', '.e2e-settlement-host-tool-cleaned')
  let toolInvocations = 0
  let toolCancelled = false
  let toolReturned = false
  let signalBodyCancelled!: () => void
  const bodyCancelled = new Promise<void>((resolve) => {
    signalBodyCancelled = resolve
  })
  let turnSettled = false
  let releaseTool!: () => void
  const holdTool = new Promise<void>((resolve) => {
    releaseTool = resolve
  })
  let modelStreams = 0
  const turnEndReasons: unknown[] = []
  let sidecarFaultDb: DatabaseSync | undefined
  let disposeTool: (() => void) | undefined
  const evidenceStage = (stage: string): string =>
    storageFollowup === undefined ? stage : `${storageFollowup}-${stage}`
  const protocolPromptCount = (): number => {
    const log = existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : ''
    // The first prompt takes the special settlementTurn branch; later prompts
    // are recorded by regressionTurn. Count both protocol-side markers.
    return (log.match(/settlement scenario started|regression prompt=/gu) ?? []).length
  }
  const installSnapshotWriteFailure = (): void => {
    const get = (host.ctx as unknown as { get(name: string): unknown }).get.bind(host.ctx)
    const dshHomePath = get('dshHomePath')
    if (typeof dshHomePath !== 'function') throw new Error('Isolated Host has no dshHomePath slot')
    const sidecarRoot = (dshHomePath as (...segments: string[]) => string)('dsh-acp')
    sidecarFaultDb = new DatabaseSync(join(sidecarRoot, 'sidecar.sqlite'))
    sidecarFaultDb.exec(`
      CREATE TRIGGER ${optionSnapshotInsertFailure}
      BEFORE INSERT ON option_snapshots
      BEGIN SELECT RAISE(ABORT, 'E2E_TEMPORARY_SIDECAR_WRITE_FAILURE'); END;
      CREATE TRIGGER ${optionSnapshotUpdateFailure}
      BEFORE UPDATE ON option_snapshots
      BEGIN SELECT RAISE(ABORT, 'E2E_TEMPORARY_SIDECAR_WRITE_FAILURE'); END;
    `)
  }
  const releaseSnapshotWriteFailure = (): void => {
    if (sidecarFaultDb === undefined) return
    sidecarFaultDb.exec(`
      DROP TRIGGER IF EXISTS ${optionSnapshotInsertFailure};
      DROP TRIGGER IF EXISTS ${optionSnapshotUpdateFailure};
    `)
    sidecarFaultDb.close()
    sidecarFaultDb = undefined
  }
  const captureEvidence = async (stage: string, facts: Record<string, unknown>): Promise<void> => {
    if (uiEvidence === undefined || page === undefined) return
    mkdirSync(uiEvidence, { recursive: true })
    await page.screenshot({ path: join(uiEvidence, `settlement-${stage}.png`), fullPage: true })
    writeFileSync(join(uiEvidence, `settlement-${stage}.json`), JSON.stringify(facts, null, 2))
  }
  try {
    host.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') turnEndReasons.push(event.data.reason)
    })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        devin: {
          name: 'Settlement fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((item) => item.id === 'acp-devin')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    disposeTool = host.ctx.tools.register({
      name: 'e2e_settlement_fixture',
      description: 'Hold a real Host tool body until the settlement test releases it.',
      parameters: {
        type: 'object',
        properties: {
          startedFile: { type: 'string' },
          cancelledFile: { type: 'string' },
          cleanupFile: { type: 'string' },
        },
        required: ['startedFile', 'cancelledFile', 'cleanupFile'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (
        {
          startedFile: requestedStart,
          cancelledFile: requestedCancelled,
          cleanupFile: requestedCleanup,
        }: { startedFile: string; cancelledFile: string; cleanupFile: string },
        execution,
      ) => {
        const actualStart = resolve(requestedStart)
        const actualCancelled = resolve(requestedCancelled)
        const actualCleanup = resolve(requestedCleanup)
        const workspaceRoot = `${resolve(host.workspaceCwd)}${sep}`
        const workspace = resolve(host.workspaceCwd, 'workspace')
        if (
          [actualStart, actualCancelled, actualCleanup].some(
            (actual) => !actual.startsWith(workspaceRoot) || dirname(actual) !== workspace,
          )
        )
          throw new Error('Settlement signal must stay inside the isolated E2E workspace')
        toolInvocations += 1
        writeFileSync(actualStart, 'Host tool body entered')
        const onAbort = (): void => {
          if (toolCancelled) return
          toolCancelled = true
          writeFileSync(actualCancelled, 'Host tool body received AbortSignal')
          signalBodyCancelled()
        }
        execution.signal.addEventListener('abort', onAbort, { once: true })
        if (execution.signal.aborted) onAbort()
        await holdTool
        execution.signal.removeEventListener('abort', onAbort)
        writeFileSync(actualCleanup, 'Host tool cleanup released')
        toolReturned = true
        return `${scenario}_HOST_RESULT`
      },
    })
    host.ctx.on('llm/stream', (request, next) => {
      if (request.provider === 'acp-devin') modelStreams += 1
      return next()
    })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    for (const signalFile of [startedFile, cancelledFile, cleanupFile]) if (existsSync(signalFile)) rmSync(signalFile)

    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, scenario)
    const settled = host.whenTurnSettled(60_000).then((id) => {
      turnSettled = true
      return id
    })
    void settled.catch(() => undefined)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()

    const approval = page.locator('[data-question-key], [data-approval-key]')
    await approval.waitFor()
    expect(await approval.innerText()).toContain('e2e_settlement_fixture')
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click()

    // The file is written only when the registered Host execute body begins.
    await expect.poll(() => existsSync(startedFile), { timeout: 15_000 }).toBe(true)
    await page.getByText(`${scenario}_MODEL_DONE`, { exact: true }).waitFor()
    const finishing = page.getByText(localStatus, { exact: true })
    await finishing.waitFor({ timeout: 10_000 })
    if (storageFollowup !== undefined) installSnapshotWriteFailure()
    expect(toolInvocations).toBe(1)
    expect(toolReturned).toBe(false)
    expect(turnSettled).toBe(false)
    expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
    expect(await page.getByRole('heading', { name: 'ACP session recovery required', exact: true }).count()).toBe(0)
    await captureEvidence(evidenceStage(`${mode}-finishing-before-5s`), {
      localStatusVisible: await finishing.isVisible(),
      turnSettled,
      recoveryButtonCount: await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count(),
      toolInvocations,
      toolReturned,
      modelStreams,
      hostMarkerExists: existsSync(startedFile),
    })

    if (mode === 'stop') {
      const input = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, input, queuedFollowup)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
      const queued = page.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: queuedFollowup })
      await queued.waitFor({ state: 'visible' })
      const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
      await stop.waitFor({ timeout: 10_000 })
      expect(await stop.isEnabled()).toBe(true)
      await stop.click()
      // This marker is written only from the Host tool's actual AbortSignal.
      await bodyCancelled
      await expect.poll(() => existsSync(cancelledFile), { timeout: 10_000 }).toBe(true)
      const agentAfterStop = existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : ''
      expect(agentAfterStop).not.toContain('session/cancel sessionId=')
      expect(toolCancelled).toBe(true)
      expect(toolReturned).toBe(false)
      expect(turnSettled).toBe(false)
      expect(await finishing.isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
    }

    // The five-second threshold is the regression boundary; the held Host
    // promise is the synchronization mechanism, not this elapsed-time check.
    const visibleAt = Date.now()
    await expect.poll(() => Date.now() - visibleAt, { timeout: 7_000, interval: 100 }).toBeGreaterThan(5_000)
    expect(await finishing.isVisible()).toBe(true)
    expect(toolReturned).toBe(false)
    expect(turnSettled).toBe(false)
    expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
    await captureEvidence(evidenceStage(`${mode}-finishing-after-5s`), {
      elapsedMs: Date.now() - visibleAt,
      localStatusVisible: await finishing.isVisible(),
      turnSettled,
      recoveryButtonCount: await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count(),
      toolInvocations,
      toolReturned,
      modelStreams,
      hostMarkerExists: existsSync(startedFile),
      cancelMarkerExists: existsSync(cancelledFile),
    })

    if (storageFollowup !== undefined) {
      releaseTool()
      await expect.poll(() => toolReturned).toBe(true)
      await expect.poll(() => existsSync(cleanupFile)).toBe(true)
      await page.getByText(storageErrorStatus, { exact: true }).waitFor({ timeout: 30_000 })
      expect(turnSettled).toBe(false)
      expect(toolInvocations).toBe(1)
      expect(protocolPromptCount()).toBe(1)
      expect(await page.getByText(`${scenario}_MODEL_DONE`, { exact: true }).isVisible()).toBe(true)
      const activeStop = page.getByRole('button', { name: 'Stop generating', exact: true })
      await activeStop.waitFor({ timeout: 10_000 })
      expect(await activeStop.isEnabled()).toBe(true)
      const faultedTurnText = await page.locator('body').innerText()
      expect(faultedTurnText).not.toContain('ACP_LOCAL_SETTLEMENT_FAILED')
      expect(await page.getByText('Failed', { exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
      expect(await page.getByRole('heading', { name: 'ACP session recovery required', exact: true }).count()).toBe(0)
      await captureEvidence(evidenceStage('storage-error'), {
        protocolPromptCount: protocolPromptCount(),
        toolInvocations,
        toolReturned,
        modelStreams,
        turnSettled,
        answerVisible: await page.getByText(`${scenario}_MODEL_DONE`, { exact: true }).isVisible(),
        stopEnabled: await activeStop.isEnabled(),
        storageErrorVisible: await page.getByText(storageErrorStatus, { exact: true }).isVisible(),
        localSavingVisible: await page.getByText(savingResultsStatus, { exact: true }).count(),
        recoveryButtonCount: await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count(),
      })

      if (storageFollowup === 'continue') {
        const input = page.locator('[data-composer-input]').first()
        await writeComposerDraft(page, input, queuedFollowup)
        await page.getByRole('button', { name: 'Queue message', exact: true }).click()
        const pendingQueueItem = page
          .locator('[data-queue-dock]')
          .getByRole('listitem')
          .filter({ hasText: queuedFollowup })
        await pendingQueueItem.waitFor({ state: 'visible' })
        expect(protocolPromptCount()).toBe(1)
        releaseSnapshotWriteFailure()
        await settled
        await expect.poll(() => protocolPromptCount(), { timeout: 30_000 }).toBe(2)
        await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor({ timeout: 30_000 })
        await expect.poll(() => turnEndReasons.length, { timeout: 30_000 }).toBe(2)
        expect(turnEndReasons).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
        expect(protocolPromptCount()).toBe(2)
        expect(toolInvocations).toBe(1)
        expect(toolCancelled).toBe(false)
        await captureEvidence(evidenceStage('storage-settled'), {
          protocolPromptCount: protocolPromptCount(),
          toolInvocations,
          toolReturned,
          modelStreams,
          turnEndReasons,
          storageErrorVisible: await page.getByText(storageErrorStatus, { exact: true }).count(),
        })
      } else {
        await activeStop.click()
        await expect.poll(() => activeStop.count()).toBe(0)
        await settled
        expect(turnEndReasons).toHaveLength(1)
        expect(turnEndReasons[0]).toMatchObject({ kind: 'aborted' })
        expect(protocolPromptCount()).toBe(1)
        expect(toolReturned).toBe(true)
        expect(toolCancelled).toBe(false)
        await page.getByText(storageErrorStatus, { exact: true }).waitFor({ state: 'visible' })
        releaseSnapshotWriteFailure()
        await expect
          .poll(() => page!.getByText(storageErrorStatus, { exact: true }).count(), { timeout: 30_000 })
          .toBe(0)
        expect(protocolPromptCount()).toBe(1)
        expect(toolInvocations).toBe(1)
        expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
        await captureEvidence(evidenceStage('storage-settled-after-stop'), {
          protocolPromptCount: protocolPromptCount(),
          toolInvocations,
          toolReturned,
          modelStreams,
          turnSettled,
          storageErrorVisible: await page.getByText(storageErrorStatus, { exact: true }).count(),
        })

        const input = page.locator('[data-composer-input]').first()
        const manualFollowup = 'E2E_SETTLEMENT_STOP_RECOVERY_FOLLOWUP_v1'
        await writeComposerDraft(page, input, manualFollowup)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(() => protocolPromptCount(), { timeout: 30_000 }).toBe(2)
        await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor({ timeout: 30_000 })
        await expect.poll(() => turnEndReasons.length, { timeout: 30_000 }).toBe(2)
        expect(turnEndReasons.at(-1)).toMatchObject({ kind: 'completed' })
        expect(protocolPromptCount()).toBe(2)
        expect(toolInvocations).toBe(1)
        expect(toolCancelled).toBe(false)
        expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
      }
    } else {
      releaseTool()
      await settled
    }
    await expect.poll(() => toolReturned).toBe(true)
    await expect.poll(() => existsSync(cleanupFile)).toBe(true)
    await expect.poll(() => finishing.count()).toBe(0)
    expect(toolInvocations).toBe(1)
    expect(modelStreams).toBe(storageFollowup === undefined ? 1 : 2)
    await expect
      .poll(() => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : ''))
      .toContain('settlement MCP client closed after tool result and Host cleanup')
    const agent = readFileSync(agentLog, 'utf8')
    const toolResults = agent.match(/settlement tool result=/g) ?? []
    const toolFailures = agent.match(/settlement tool failed=/g) ?? []
    if (mode === 'natural') {
      expect(agent).toContain(`${scenario}_HOST_RESULT`)
      expect(toolResults).toHaveLength(1)
    } else expect(toolResults.length + toolFailures.length).toBe(1)
    expect(agent.match(/settlement scenario started/g)).toHaveLength(1)
    if (mode === 'stop') {
      expect(agent).not.toContain('session/cancel sessionId=')
      expect(toolCancelled).toBe(true)
      expect(turnSettled).toBe(true)
      expect(modelStreams).toBe(1)
      const pendingQueueItem = page
        .locator('[data-queue-dock]')
        .getByRole('listitem')
        .filter({ hasText: queuedFollowup })
      await pendingQueueItem.waitFor({ state: 'visible' })
      expect(await pendingQueueItem.getByRole('button', { name: 'Remove queued message', exact: true }).count()).toBe(1)
    }

    expect(errors).toEqual([])
    await captureEvidence(evidenceStage(`${mode}-finished`), {
      localStatusVisible: await finishing.isVisible(),
      recoveryButtonCount: await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count(),
      toolInvocations,
      toolReturned,
      modelStreams,
      hostMarkerExists: existsSync(startedFile),
      cancelMarkerExists: existsSync(cancelledFile),
      cleanupMarkerExists: existsSync(cleanupFile),
      agentResultCount: toolResults.length,
      agentFailureCount: toolFailures.length,
      turnSettled,
    })
  } catch (error) {
    if (page) {
      const evidence = join(root, '.local/e2e-failures')
      mkdirSync(evidence, { recursive: true })
      writeFileSync(
        join(evidence, 'settlement.json'),
        JSON.stringify(
          {
            body: await page.locator('body').innerText(),
            agent: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '',
            toolInvocations,
            toolCancelled,
            toolReturned,
            turnSettled,
            modelStreams,
          },
          null,
          2,
        ),
      )
      await page.screenshot({ path: join(evidence, 'settlement.png'), fullPage: true })
    }
    throw error
  } finally {
    releaseTool()
    releaseSnapshotWriteFailure()
    disposeTool?.()
    try {
      await page?.close()
    } finally {
      try {
        await browser?.close()
      } finally {
        await host.close()
      }
    }
  }
}

it('keeps natural end_turn in finishing-tools while one real Host tool drains', async () => {
  await runSettlementCase('natural')
}, 90_000)

it('keeps native Stop available through Host tool cleanup without resending queued input', async () => {
  await runSettlementCase('stop')
}, 90_000)

it('keeps the current turn active while local saving retries, then runs one queued ACP prompt', async () => {
  await runSettlementCase('natural', 'continue')
}, 90_000)

it('lets Stop end the active turn during local saving retries, then continue without rerunning the completed tool', async () => {
  await runSettlementCase('natural', 'stop')
}, 90_000)
