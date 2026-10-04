import type { SessionId } from '@deepseek-ai/dsh-session'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'

it('keeps native queued input operable across ACP crash recovery and closes pending approval on teardown', async () => {
  const host = await launchAdapterWorld()
  const gateDirectory = join(host.workspaceCwd, 'recovery-queue-gates')
  const agentLog = join(host.workspaceCwd, 'recovery-queue-agent.log')
  mkdirSync(gateDirectory, { recursive: true })
  let browser!: TestBrowser
  let page!: Page
  const events: { sessionId: SessionId; type: string; data: unknown }[] = []
  const evidenceDirectory = process.env.DSH_ACP_UI_EVIDENCE
  if (evidenceDirectory !== undefined) mkdirSync(evidenceDirectory, { recursive: true })
  const factSnapshot: Record<string, unknown> = { events: [] as unknown[], screenshots: [] as string[] }
  const promptCount = () =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('regression prompt=').length - 1 : 0
  const ready = (file: string) => join(gateDirectory, file)
  const waitForReady = async (file: string) =>
    await vi.waitFor(() => expect(existsSync(ready(file))).toBe(true), { timeout: 30_000 })
  const release = (name: string) => writeFileSync(ready(name), 'release')
  const waitForEndCount = async (sessionId: SessionId, count: number) =>
    await vi.waitFor(
      () =>
        expect(events.filter((event) => event.sessionId === sessionId && event.type === 'turn/end').length).toBe(count),
      { timeout: 30_000 },
    )
  const recoveryErrorCode = (data: unknown): string | undefined => {
    if (typeof data !== 'object' || data === null || !('reason' in data)) return undefined
    const reason = data.reason
    if (typeof reason !== 'object' || reason === null || !('error' in reason)) return undefined
    const error = reason.error
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  }
  const capture = async (name: string) => {
    if (evidenceDirectory === undefined) return
    await page.screenshot({ path: join(evidenceDirectory, `recovery-queue-${name}.png`), fullPage: true })
    ;(factSnapshot.screenshots as string[]).push(name)
    ;(factSnapshot.events as unknown[]).push({
      name,
      visibleText: await page.locator('body').innerText(),
      queueText: await page
        .locator('[data-queue-dock]')
        .innerText()
        .catch(() => ''),
      sessionEvents: events,
      agentLog: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '',
    })
  }
  const send = async (text: string) => {
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, text)
    const settled = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    return settled
  }
  const queue = async (text: string) => {
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, text)
    await input.press('Enter')
    const item = page.getByRole('listitem').filter({ hasText: text })
    await item.waitFor({ state: 'visible' })
    await expect
      .poll(() => item.getByRole('button', { name: 'Remove queued message', exact: true }).isEnabled())
      .toBe(true)
    return item
  }
  const recoverByRebind = async () => {
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor({ state: 'hidden' })
  }

  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        devin: {
          name: 'Gated Devin recovery fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_RECOVERY_GATE_DIR: gateDirectory,
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
    page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    const firstSettled = send('E2E_RECOVERY_QUEUE_CRASH')
    await waitForReady('queue-started.ready')
    const queued = await queue('E2E_RECOVERY_QUEUED_INPUT')
    expect(await queued.getByRole('button', { name: 'Remove queued message', exact: true }).isEnabled()).toBe(true)
    await capture('queue-running')
    release('release-queue-crash')
    const sessionId = await firstSettled
    await waitForEndCount(sessionId, 1)
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    await capture('queue-recovery')
    await expect.poll(() => queued.count()).toBe(1)
    await expect
      .poll(() => queued.getByRole('button', { name: 'Remove queued message', exact: true }).isEnabled())
      .toBe(true)
    expect(promptCount()).toBe(1)
    const queueAdmission = events.filter(
      (event) =>
        event.sessionId === sessionId &&
        event.type === 'agent/inbox/spliced' &&
        JSON.stringify(event.data).includes('E2E_RECOVERY_QUEUED_INPUT'),
    )
    expect(queueAdmission).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.sessionId === sessionId &&
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes('E2E_RECOVERY_QUEUED_INPUT'),
      ),
    ).toHaveLength(0)
    const firstEndFacts = events.filter((event) => event.sessionId === sessionId && event.type === 'turn/end')
    expect(firstEndFacts).toHaveLength(1)
    expect(recoveryErrorCode(firstEndFacts[0]?.data)).toBe('ACP_CRASH')

    const remote = host.ctx.get('dshAcp') as AcpRemoteService
    const recoveryFollow = remote.recoveryFollow.bind(remote)
    let recoveryFollowReads = 0
    vi.spyOn(remote, 'recoveryFollow').mockImplementation(async function* (id, signal) {
      recoveryFollowReads++
      if (recoveryFollowReads === 1) throw new Error('E2E_TEMPORARY_RECOVERY_READ_FAILURE')
      yield* recoveryFollow(id, signal)
    })
    await page.reload()
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    expect(recoveryFollowReads).toBeGreaterThanOrEqual(2)
    await page.getByRole('listitem').filter({ hasText: 'E2E_RECOVERY_QUEUED_INPUT' }).waitFor({ state: 'visible' })
    expect(promptCount()).toBe(1)
    await recoverByRebind()
    const queuedAfterRebind = page.getByRole('listitem').filter({ hasText: 'E2E_RECOVERY_QUEUED_INPUT' })
    await queuedAfterRebind.waitFor({ state: 'visible' })
    await capture('queue-after-rebind')
    await queuedAfterRebind.getByRole('button', { name: 'Remove queued message', exact: true }).click()
    await queuedAfterRebind.waitFor({ state: 'detached' })
    expect(promptCount()).toBe(1)
    const afterQueueRecovery = send('E2E_RECOVERY_FOLLOWUP')
    await afterQueueRecovery
    await page.getByText('E2E_RECOVERY_FOLLOWUP_DONE', { exact: true }).waitFor()
    expect(promptCount()).toBe(2)
    expect(readFileSync(agentLog, 'utf8')).not.toContain('E2E_RECOVERY_QUEUED_INPUT')
    expect(
      events.filter(
        (event) =>
          event.sessionId === sessionId &&
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes('E2E_RECOVERY_QUEUED_INPUT'),
      ),
    ).toHaveLength(0)

    const permissionStarted = send('E2E_RECOVERY_PERMISSION_CRASH')
    await waitForReady('permission-started.ready')
    const queuedPermission = await queue('E2E_RECOVERY_PERMISSION_QUEUED_INPUT')
    expect(await queuedPermission.getByRole('button', { name: 'Remove queued message', exact: true }).isEnabled()).toBe(
      true,
    )
    await capture('permission-queue-running')
    release('release-permission-request')
    await waitForReady('permission-permission-requested.ready')
    const approval = page.locator('[data-question-key], [data-approval-key]')
    await approval.waitFor({ state: 'visible' })
    await capture('permission-pending')
    release('release-permission-crash')
    await permissionStarted
    await waitForEndCount(sessionId, 3)
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    await approval.waitFor({ state: 'hidden' })
    await capture('permission-recovery')
    await expect.poll(() => queuedPermission.count()).toBe(1)
    await expect
      .poll(() => queuedPermission.getByRole('button', { name: 'Remove queued message', exact: true }).isEnabled())
      .toBe(true)
    expect(existsSync(join(host.workspaceCwd, 'workspace', 'recovery-approval-marker.txt'))).toBe(false)
    expect(readFileSync(agentLog, 'utf8')).not.toMatch(/recovery permission answer=.*allow-recovery-once/)
    expect(promptCount()).toBe(3)
    const finalEnds = events.filter((event) => event.sessionId === sessionId && event.type === 'turn/end')
    expect(finalEnds).toHaveLength(3)
    expect(recoveryErrorCode(finalEnds[2]?.data)).toBe('ACP_CRASH')

    await recoverByRebind()
    const queuedPermissionAfterRebind = page
      .getByRole('listitem')
      .filter({ hasText: 'E2E_RECOVERY_PERMISSION_QUEUED_INPUT' })
    await queuedPermissionAfterRebind.waitFor({ state: 'visible' })
    await queuedPermissionAfterRebind.getByRole('button', { name: 'Remove queued message', exact: true }).click()
    await queuedPermissionAfterRebind.waitFor({ state: 'detached' })
    await expect.poll(() => approval.count()).toBe(0)
    expect(existsSync(join(host.workspaceCwd, 'workspace', 'recovery-approval-marker.txt'))).toBe(false)
    expect(promptCount()).toBe(3)
    const finalExplicitSend = send('E2E_RECOVERY_FOLLOWUP')
    await finalExplicitSend
    await expect.poll(() => page.getByText('E2E_RECOVERY_FOLLOWUP_DONE', { exact: true }).count()).toBe(2)
    expect(promptCount()).toBe(4)
    expect(readFileSync(agentLog, 'utf8')).not.toContain('E2E_RECOVERY_PERMISSION_QUEUED_INPUT')
    await capture('permission-after-rebind-explicit-send')
    expect(
      events.filter(
        (event) =>
          event.sessionId === sessionId &&
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes('E2E_RECOVERY_PERMISSION_QUEUED_INPUT'),
      ),
    ).toHaveLength(0)
    if (evidenceDirectory !== undefined) {
      factSnapshot.final = { sessionId, sessionEvents: events, agentLog: readFileSync(agentLog, 'utf8') }
      writeFileSync(join(evidenceDirectory, 'recovery-queue-host-facts.json'), JSON.stringify(factSnapshot, null, 2))
    }
  } catch (error) {
    if (evidenceDirectory !== undefined && page !== undefined) {
      await page
        .screenshot({ path: join(evidenceDirectory, 'recovery-queue-failure.png'), fullPage: true })
        .catch(() => {})
      writeFileSync(
        join(evidenceDirectory, 'recovery-queue-failure.json'),
        JSON.stringify(
          {
            error: String(error),
            sessionEvents: events,
            agentLog: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '',
          },
          null,
          2,
        ),
      )
    }
    throw error
  } finally {
    release('release-queue-crash')
    release('release-permission-crash')
    await browser?.close()
    await host.close()
  }
})
