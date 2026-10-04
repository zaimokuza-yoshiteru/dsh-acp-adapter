import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it('shows a tool without a terminal update as unfinished and accepts the next prompt', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  let page: Awaited<ReturnType<typeof newEnglishPage>> | undefined
  const evidenceDirectory =
    process.env.DSH_ACP_UI_EVIDENCE === undefined ? undefined : resolve(process.env.DSH_ACP_UI_EVIDENCE)
  const failureDirectory = evidenceDirectory ?? resolve(root, '.local/e2e-failures/unfinished-tool')
  const agentLog = join(host.workspaceCwd, 'unfinished-tool-agent.log')
  const captureFailure = async (stage: string): Promise<void> => {
    mkdirSync(failureDirectory, { recursive: true })
    writeFileSync(join(failureDirectory, `${stage}.dom.html`), await page!.content())
    if (existsSync(agentLog)) writeFileSync(join(failureDirectory, `${stage}.agent.log`), readFileSync(agentLog))
    await page!.screenshot({ path: join(failureDirectory, `${stage}.png`), fullPage: true })
  }
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Unfinished activity fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((item) => item.id === 'acp-codex')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    page = await newEnglishPage(browser)

    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd, 'unfinished-tool')
    const composer = page.locator('[data-composer-input]').first()
    const send = page.getByRole('button', { name: 'Send message', exact: true })

    await writeComposerDraft(page, composer, 'E2E_UNFINISHED_TOOL_FIRST')
    const firstSettled = host.whenTurnSettled(30_000)
    await send.click()
    await page.getByText('E2E_UNFINISHED_FIRST_DONE', { exact: true }).waitFor()
    await firstSettled
    const firstProcess = page.locator('[data-turn-process-tool-calls]').last()
    await firstProcess.waitFor()
    if ((await firstProcess.getAttribute('aria-expanded')) === 'false') await firstProcess.click()
    for (const stepButton of await page.locator('[data-step-process] > div > button').all()) {
      await stepButton.waitFor({ state: 'visible' })
      if ((await stepButton.getAttribute('aria-expanded')) === 'false') await stepButton.click()
      await expect.poll(() => stepButton.getAttribute('aria-expanded')).toBe('true')
    }
    await page.getByText('Tool did not report a result', { exact: true }).waitFor()
    const nativeToolResultCount = await page.locator('[data-chat-call-id$=":tool:unfinished-fixture"]').count()
    expect(nativeToolResultCount).toBe(0)
    if (evidenceDirectory !== undefined) {
      mkdirSync(evidenceDirectory, { recursive: true })
      await page.screenshot({ path: join(evidenceDirectory, 'unfinished-tool-first-turn.png'), fullPage: true })
      writeFileSync(
        join(evidenceDirectory, 'unfinished-tool-first-turn.json'),
        JSON.stringify(
          {
            stage: 'first-turn',
            status: 'unfinished',
            nativeToolResultCount,
            nextPromptEnabled: await send.isEnabled(),
          },
          null,
          2,
        ),
      )
    }

    await writeComposerDraft(page, composer, 'E2E_UNFINISHED_TOOL_NEXT')
    const nextSettled = host.whenTurnSettled(30_000)
    await send.click()
    try {
      await page.getByText('E2E_UNFINISHED_NEXT_DONE', { exact: true }).waitFor()
    } catch (error) {
      await captureFailure('next-turn')
      throw error
    }
    await nextSettled
    expect(await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
    const nextProcess = page.locator('[data-turn-process-tool-calls]').last()
    await nextProcess.waitFor()
    if ((await nextProcess.getAttribute('aria-expanded')) === 'false') await nextProcess.click()
    for (const stepButton of await page.locator('[data-step-process] > div > button').all()) {
      await stepButton.waitFor({ state: 'visible' })
      if ((await stepButton.getAttribute('aria-expanded')) === 'false') await stepButton.click()
      await expect.poll(() => stepButton.getAttribute('aria-expanded')).toBe('true')
    }
    try {
      const terminalTool = page.locator('[data-tool="Next turn terminal tool"][data-state="ok"]')
      await terminalTool.waitFor({ state: 'visible' })
      expect(await terminalTool.count()).toBe(1)
      const disclosure = terminalTool.locator('[data-disclosure-row="true"]')
      await disclosure.click()
      await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('true')
      await page.getByText('fixture complete', { exact: true }).waitFor({ state: 'visible' })
    } catch (error) {
      await captureFailure('next-turn-title')
      throw error
    }
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').length - 1).toBe(2)
    if (evidenceDirectory !== undefined) {
      await page.screenshot({ path: join(evidenceDirectory, 'unfinished-tool-next-turn.png'), fullPage: true })
      writeFileSync(
        join(evidenceDirectory, 'unfinished-tool-next-turn.json'),
        JSON.stringify({ stage: 'next-turn', promptCount: 2, response: 'E2E_UNFINISHED_NEXT_DONE' }, null, 2),
      )
    }
  } finally {
    await browser?.close()
    await host.close()
  }
})
