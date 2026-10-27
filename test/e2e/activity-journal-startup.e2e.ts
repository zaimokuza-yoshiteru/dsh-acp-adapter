import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld } from './scaffold.ts'
import type { AcpRemoteService } from '../../src/remote/service.js'

it('keeps the activity area quiet while the initial ACP binding is committed', async () => {
  const host = await launchAdapterWorld()
  const browser = await launchBrowser({ headless: true })
  const page = await newEnglishPage(browser)
  const gateDirectory = join(host.workspaceCwd, 'activity-journal-render-gate')
  const bindingGate = join(host.workspaceCwd, 'activity-binding-gate')
  const workspace = join(host.workspaceCwd, 'activity-startup')
  const agentLog = join(host.workspaceCwd, 'activity-journal-agent.log')
  await mkdir(gateDirectory, { recursive: true })
  await mkdir(bindingGate, { recursive: true })
  await host.ctx.settings.replace('dsh-acp-adapter', {
    toolApprovalDefault: 'ask',
    agents: {
      codex: {
        name: 'Activity startup fixture',
        command: process.execPath,
        args: [join(process.cwd(), 'test/mock-agent/mock-agent.ts')],
        env: {
          HOME: host.workspaceCwd,
          MOCK_SCENARIO: 'regression',
          MOCK_PROFILE: 'codex',
          MOCK_LOG: agentLog,
          MOCK_RENDER_GATE_DIR: gateDirectory,
          MOCK_SESSION_NEW_GATE_DIR: bindingGate,
          MOCK_SESSION_NEW_GATE_CWD: workspace,
        },
      },
    },
  })
  await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })

  // Count real remote failures, without injecting an artificial failure. The
  // workspace-only session/new gate keeps the durable binding pending while
  // catalog probing and the rest of the Host continue normally.
  const service = host.ctx.get('dshAcp') as AcpRemoteService
  const follow = service.activityFollow.bind(service)
  let pendingReads = 0
  const observedFollow = vi.spyOn(service, 'activityFollow').mockImplementation(async function* (...args) {
    try {
      yield* follow(...args)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'dsh-acp/activity-binding-pending'
      )
        pendingReads++
      throw error
    }
  })

  try {
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd, 'activity-startup')
    await page.evaluate(() => {
      const target = window as typeof window & { startupActivityHints?: string[] }
      target.startupActivityHints = []
      const capture = () => {
        for (const element of document.querySelectorAll('[data-acp-activity]')) {
          const text = element.textContent ?? ''
          if (/reconnecting|unavailable|retrying/i.test(text)) target.startupActivityHints!.push(text)
        }
      }
      new MutationObserver(capture).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    const composer = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, composer, 'E2E_RENDER_STREAM')
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => send.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(30_000)
    void settled.catch(() => {})
    await send.click()

    await expect
      .poll(() =>
        access(join(bindingGate, 'waiting')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await expect.poll(() => pendingReads).toBeGreaterThanOrEqual(2)
    expect(
      await page.evaluate(() => (window as typeof window & { startupActivityHints?: string[] }).startupActivityHints),
    ).toEqual([])
    expect(await page.locator('[data-acp-activity]').count()).toBe(0)
    await writeFile(join(bindingGate, 'continue'), 'continue')
    await page.getByText('E2E_RENDER_READY', { exact: true }).waitFor()
    expect(
      await page.evaluate(() => (window as typeof window & { startupActivityHints?: string[] }).startupActivityHints),
    ).toEqual([])
    expect(await page.getByText('Agent activity is temporarily unavailable.', { exact: true }).count()).toBe(0)
    const responseBlock = page.locator('[data-chat-flow-kind="assistant-step"]:not([hidden]) [data-streaming]')
    const renderedResponse = () => responseBlock.evaluateAll((elements) => elements.at(-1)?.textContent?.trim() ?? null)
    let expectedResponse = 'E2E_RENDER_READY'
    await expect.poll(renderedResponse).toBe(expectedResponse)
    await writeFile(join(gateDirectory, 'continue--1'), 'continue')
    for (let index = 0; index < 5; index += 1) {
      expectedResponse += `E2E_RENDER_CHUNK_${index}`
      await expect.poll(renderedResponse).toBe(expectedResponse)
      expect(await page.getByText('Agent activity is temporarily unavailable.', { exact: true }).count()).toBe(0)
      await writeFile(join(gateDirectory, `continue-${index}`), 'continue')
    }
    await settled
  } finally {
    observedFollow.mockRestore()
    await writeFile(join(bindingGate, 'continue'), 'cleanup')
    await page.close()
    await browser.close()
    await host.close()
  }
})
