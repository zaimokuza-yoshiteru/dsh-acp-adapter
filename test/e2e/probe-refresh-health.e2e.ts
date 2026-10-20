import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import type { AcpHealthRegistryLike, AcpRemoteService } from '../../src/remote/service.ts'
import { ACP_PROBE_CACHE_OK_TTL_MS } from '../../src/domain/session/agent-config.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { openAcpPluginDetail, returnToConversation } from './plugin-panel.helpers.ts'
import { required } from './required.ts'

it('keeps a verified catalog and live session usable while reporting failed refresh and login recovery', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const profile = 'probe-refresh'
  const provider = `acp-${profile}`
  const authFile = join(host.workspaceCwd, 'probe-auth-state')
  const logFile = join(host.workspaceCwd, 'probe-protocol.jsonl')
  const evidence = join(root, '.local/probe-refresh-health', process.env.DSH_E2E_EVIDENCE_LABEL ?? 'current')
  mkdirSync(evidence, { recursive: true })
  const remote = host.ctx.get('dshAcp') as AcpRemoteService
  const errors: string[] = []
  try {
    writeFileSync(authFile, 'authenticated')
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        [profile]: {
          name: 'Probe refresh fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/probe-refresh-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_PROBE_AUTH_FILE: authFile, MOCK_PROBE_LOG_FILE: logFile },
          loginHint: 'fixture-agent login',
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((entry) => entry.id === provider)).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'probe-model' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.context().tracing.start({ screenshots: true, snapshots: true })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd, 'probe-refresh')
    const send = async (marker: string) => {
      const settled = host.whenTurnSettled(30_000)
      void settled.catch(() => {})
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), marker)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const sessionId = await settled
      await page.getByText(`${marker}_DONE`, { exact: true }).waitFor()
      return sessionId
    }
    const sessionId = await send('E2E_PROBE_INITIAL')
    const initial = required((await remote.health()).providers.find((entry) => entry.id === profile))
    expect(initial.probe.status).toBe('ok')

    // Only the cache clock is controlled: do not wait ten real minutes. The
    // registered, built adapter still launches the actual protocol process and
    // health/UI read its actual result; no probe return or runtime is replaced.
    const registry = (remote as unknown as { resolved: { registry: AcpHealthRegistryLike } }).resolved.registry
    const cache = required(registry.probeCacheFor(profile))
    const snapshot = required(cache.probeSnapshot(provider))
    const originalAt = snapshot.at
    const expiredAt = Date.now() - ACP_PROBE_CACHE_OK_TTL_MS - 1
    Object.defineProperty(snapshot, 'at', { value: expiredAt, writable: true, configurable: true })
    writeFileSync(authFile, 'signed-out')
    const attemptStarted = Date.now()
    const retainedModels = await host.ctx.llm.listModels(provider)
    const attemptFinished = Date.now()
    const failed = required((await remote.health()).providers.find((entry) => entry.id === profile))
    const detail = await openAcpPluginDetail(page)
    const row = detail.locator(`[data-dsh-acp-agent="${profile}"]`)
    await expect.poll(async () => /protocol available|not signed in/.test(await row.innerText())).toBe(true)
    const failedText = await row.innerText()
    await page.screenshot({ path: join(evidence, 'refresh-failed.png'), fullPage: true })
    writeFileSync(join(evidence, 'refresh-failed.txt'), failedText)
    // Collect the entire before/after scenario before the regression assertion,
    // so a failing baseline still contains real UI and subprocess evidence.
    await returnToConversation(page, sessionId)
    const continuedSessionId = await send('E2E_PROBE_CONTINUED')
    const recoveryStarted = Date.now()
    writeFileSync(authFile, 'authenticated')
    const recoveryDetail = await openAcpPluginDetail(page)
    const recoveryRow = recoveryDetail.locator(`[data-dsh-acp-agent="${profile}"]`)
    await recoveryRow.getByRole('button', { name: 'Re-check', exact: true }).click()
    await expect
      .poll(async () => {
        const check = (await remote.health()).providers.find((entry) => entry.id === profile)?.probe
        return check?.status === 'ok' && check.at >= recoveryStarted
      })
      .toBe(true)
    await recoveryRow.getByText('protocol available', { exact: true }).waitFor()
    const recovered = required((await remote.health()).providers.find((entry) => entry.id === profile))
    await page.screenshot({ path: join(evidence, 'recovered.png'), fullPage: true })
    const recoveredText = await recoveryRow.innerText()
    await returnToConversation(page, sessionId)
    const recoveredSessionId = await send('E2E_PROBE_RECOVERED')
    const protocolText = readFileSync(logFile, 'utf8')
    const protocol = protocolText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      pid: number
      event: string
      authenticated: boolean
      marker?: string
      sessionId?: string
    }[]
    writeFileSync(join(evidence, 'protocol.jsonl'), protocolText)
    writeFileSync(
      join(evidence, 'observations.json'),
      JSON.stringify(
        {
          cacheClockControl: { originalAt, expiredAt },
          attemptStarted,
          attemptFinished,
          initial,
          failed,
          recovered,
          retainedModels,
          sessionId,
          continuedSessionId,
          recoveredSessionId,
          failedText,
          recoveredText,
          errors,
        },
        null,
        2,
      ),
    )
    await page.context().tracing.stop({ path: join(evidence, 'trace.zip') })
    const prompts = protocol.filter((entry) => entry.event === 'prompt-marker')
    expect(prompts.map((entry) => entry.marker)).toEqual([
      'E2E_PROBE_INITIAL',
      'E2E_PROBE_CONTINUED',
      'E2E_PROBE_RECOVERED',
    ])
    expect(new Set(prompts.map((entry) => entry.pid)).size).toBe(1)
    expect(new Set(prompts.map((entry) => entry.sessionId)).size).toBe(1)
    expect(protocol.some((entry) => entry.event === 'auth-required' && !entry.authenticated)).toBe(true)
    expect(retainedModels.map((entry) => entry.id)).toEqual(['probe-model'])
    expect(continuedSessionId).toBe(sessionId)
    expect(recoveredSessionId).toBe(sessionId)
    expect(recovered.state).toBe('ready')
    expect(recoveredText).not.toContain('not signed in')
    expect(errors).toEqual([])
    expect(failed.state).toBe('auth-required')
    expect(failed.probe).toMatchObject({ status: 'error', failureKind: 'auth_required', phase: 'session' })
    expect(failed.probe.at).toBeGreaterThanOrEqual(attemptStarted)
    expect(failed.probe.at).toBeLessThanOrEqual(attemptFinished)
    expect(failedText).toContain('The Agent is not signed in.')
    expect(failedText).toContain('fixture-agent login')
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), host.close()])
    const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Probe refresh fixture cleanup failed')
  }
})
