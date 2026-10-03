import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld } from './scaffold.ts'

it('keeps the activity area quiet while the initial ACP binding is committed', async () => {
  const host = await launchAdapterWorld()
  const browser = await launchBrowser({ headless: true })
  const page = await newEnglishPage(browser)
  const gateDirectory = join(host.workspaceCwd, 'activity-journal-render-gate')
  const agentLog = join(host.workspaceCwd, 'activity-journal-agent.log')
  await mkdir(gateDirectory, { recursive: true })
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
        },
      },
    },
  })
  await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })

  try {
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd, 'activity-startup')
    const composer = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, composer, 'E2E_RENDER_STREAM')
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => send.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(30_000)
    await send.click()

    await page.getByText('E2E_RENDER_READY', { exact: true }).waitFor()
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
    await page.close()
    await browser.close()
    await host.close()
  }
})
