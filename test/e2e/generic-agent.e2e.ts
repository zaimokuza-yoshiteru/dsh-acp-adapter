import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../src/contract/model-selection.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it.each([
  { name: 'no-options', env: { MOCK_NO_CONFIG_OPTIONS: '1' }, configurable: false },
  { name: 'uncategorized', env: { MOCK_MODEL_OPTION_CATEGORY: 'absent' }, configurable: true },
  { name: 'unknown-category', env: { MOCK_MODEL_OPTION_CATEGORY: 'vendor-choice' }, configurable: true },
])('selects a generic ACP Agent with $name and starts its first session', async ({ name, env, configurable }) => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const provider = 'acp-generic-fixture'
  const agentLog = join(host.workspaceCwd, 'generic-agent.log')
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        'generic-fixture': {
          name: 'Generic ACP fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_LOG: agentLog, ...env },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((entry) => entry.id === provider)).toBe(true)
    expect(await host.ctx.llm.listModels(provider)).toMatchObject([
      { id: ACP_CURRENT_CONFIG_MODEL_ID, name: 'Agent current configuration' },
    ])
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: ACP_CURRENT_CONFIG_MODEL_ID })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Agent current configuration', exact: true }).click()
    const send = async (message: string) => {
      const settled = host.whenTurnSettled(30_000)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), message)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      return settled
    }
    const sessionId = await send(`E2E_GENERIC_${name}`)
    await page.getByText(`E2E_DONE ${configurable ? 'mock-model-a' : 'undefined'}`, { exact: true }).waitFor()
    expect(readFileSync(agentLog, 'utf8')).not.toContain('set_config_option')
    if (configurable) {
      const controls = page.getByRole('button', { name: /^Session ·/ })
      await expect.poll(() => controls.isEnabled()).toBe(true)
      await controls.click()
      await page.getByRole('menuitem', { name: /^Agent choice/ }).click()
      await page.getByRole('menuitem', { name: 'Mock Model B', exact: true }).click()
      await expect
        .poll(() => readFileSync(agentLog, 'utf8'))
        .toContain('set_config_option configId=model value="mock-model-b"')
      expect(await send(`E2E_GENERIC_CHANGED_${name}`)).toBe(sessionId)
      await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
      expect(readFileSync(agentLog, 'utf8')).not.toContain(`value="${ACP_CURRENT_CONFIG_MODEL_ID}"`)
      expect(host.ctx.agents.get(sessionId)?.session.requestHeader()?.config.model).toBe(ACP_CURRENT_CONFIG_MODEL_ID)
    }
    const evidence = join(process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/e2e-evidence'), 'generic-agent')
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
})
