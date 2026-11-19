import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { en, zh } from '../../src/client/ui/locales.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

async function fitsViewport(locator: Locator) {
  await locator.waitFor()
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(0)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(391)
}

it.each(['en', 'zh'] as const)(
  'keeps model choices usable at 390px and explains a failed desktop reply in %s',
  async (locale) => {
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    try {
      const directory = join(host.workspaceCwd, 'managed-choices')
      mkdirSync(directory)
      writeFileSync(join(directory, 'fault'), 'none')
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: {
          fixture: {
            name: 'Menu fixture',
            command: process.execPath,
            args: [join(root, 'test/mock-agent/model-switch-agent.ts')],
            env: { HOME: host.workspaceCwd, MOCK_SWITCH_DIRECTORY: directory, MOCK_SWITCH_AGENT_NAME: 'OpenCode' },
          },
        },
      })
      await expect.poll(() => host.ctx.llm.listProviders().some((p) => p.id === 'acp-fixture')).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-fixture', model: 'a' })
      browser = await launchBrowser({
        headless: true,
        ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
      })
      const page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await host.ctx.settings.replace('locale', { preference: locale })
      await host.ctx.settings.replace('ui-theme', { preference: locale === 'zh' ? 'dark' : 'light' })
      const copy = locale === 'zh' ? zh : en
      const picker = page.getByRole('button', { name: locale === 'zh' ? /^选择模型/ : /^Select model/ }).first()
      await picker.click()
      await page
        .getByRole('menuitem', { name: locale === 'zh' ? /^模型/ : /^Model\b/ })
        .first()
        .click()
      await page.getByRole('menuitemradio', { name: copy.agentManagedModel, exact: true }).click()
      const composer = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, composer, 'SWITCH_TEST_FIRST')
      const settled = host.whenTurnSettled()
      await page.getByRole('button', { name: locale === 'zh' ? '发送消息' : 'Send message', exact: true }).click()
      await settled
      await page.setViewportSize({ width: 390, height: 844 })
      const model = page.getByRole('button', { name: 'A', exact: true })
      await model.focus()
      await model.press('Enter')
      const choices = page.getByRole('menuitem', { name: locale === 'zh' ? /^模型/ : /^Model\b/ }).first()
      await choices.press('Enter')
      const target = page.getByRole('menuitem', { name: 'B', exact: true })
      await fitsViewport(target)
      writeFileSync(join(directory, 'fault'), 'refuse')
      await target.press('Enter')
      const recovery = page.locator('[data-acp-managed-model-recovery]')
      await fitsViewport(recovery)
      expect(await recovery.innerText()).toContain(copy.managedModelChooseAgain)
      const restore = recovery.getByRole('button', { name: copy.managedModelRestore.replace('{model}', 'A') })
      await fitsViewport(restore)
      await fitsViewport(recovery.getByRole('button', { name: copy.managedModelNew, exact: true }))
      writeFileSync(join(directory, 'fault'), 'none')
      await restore.press('Enter')
      await expect.poll(() => recovery.count()).toBe(0)
      const trace = readFileSync(join(directory, 'trace'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string })
      expect(trace.filter((e) => e.method === 'session/prompt')).toHaveLength(1)

      await page.setViewportSize({ width: 1280, height: 900 })
      writeFileSync(join(directory, 'fault'), 'prompt-error')
      await writeComposerDraft(page, composer, 'SWITCH_TEST_SECOND')
      const failedTurn = host.whenTurnSettled()
      await page.getByRole('button', { name: locale === 'zh' ? '发送消息' : 'Send message', exact: true }).click()
      await failedTurn
      await page.getByText('The selected model rejected the submitted prompt', { exact: true }).waitFor()
      await recovery.getByText(copy.managedModelIncomplete, { exact: true }).waitFor()
      expect(await page.getByText(copy.actionSaveFailed.replace('{reference}', ''), { exact: true }).count()).toBe(0)
      const screenshots = process.env.DSH_E2E_EVIDENCE_DIR
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `recovery-desktop-${locale}.png`) })
      }
    } finally {
      await browser?.close()
      await host.close()
    }
  },
)
