import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { en, zh } from '../../src/client/ui/locales.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

type WireEvent = {
  method: string
  session: string
  model?: string
  target?: string
  markers?: string[]
  history?: string[]
}

async function fitsViewport(locator: Locator, width: number) {
  await locator.waitFor()
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(0)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1)
}

it.each(['en', 'zh'] as const)(
  'selects named models in one picker and recovers an undelivered message in %s',
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
      const composer = page.locator('[data-composer-input]').first()
      const send = page.getByRole('button', { name: locale === 'zh' ? '发送消息' : 'Send message', exact: true })
      const capture = async (name: string) => {
        const screenshots = process.env.DSH_E2E_EVIDENCE_DIR
        if (!screenshots) return
        mkdirSync(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `${name}-${locale}.png`) })
      }
      const trace = (): WireEvent[] =>
        readFileSync(join(directory, 'trace'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      const select = async (label: 'A' | 'B', width: number) => {
        await picker.click()
        await page
          .getByRole('menuitem', { name: locale === 'zh' ? /^模型/ : /^Model\b/ })
          .first()
          .click()
        const target = page.getByRole('menuitemradio', { name: label, exact: true })
        await fitsViewport(target, width)
        expect(await page.getByRole('menuitemradio', { name: copy.agentManagedModel, exact: true }).count()).toBe(0)
        await capture(`named-model-picker-${width}`)
        await target.press('Enter')
        await page.keyboard.press('Escape')
      }
      const submit = async (marker: string) => {
        await writeComposerDraft(page, composer, marker)
        const settled = host.whenTurnSettled()
        await send.click()
        return await settled
      }

      await page.setViewportSize({ width: 1280, height: 900 })
      await select('B', 1280)
      const sessionId = await submit('SWITCH_TEST_FIRST')
      const firstTrace = trace()
      const firstPrompt = firstTrace.findIndex((event) => event.method === 'session/prompt')
      expect(firstPrompt).toBeGreaterThan(0)
      const first = firstTrace[firstPrompt]!
      expect(first).toMatchObject({ model: 'b', markers: ['SWITCH_TEST_FIRST'], history: [] })
      expect(
        firstTrace
          .slice(0, firstPrompt)
          .some(
            (event) =>
              event.session === first.session && event.method === 'session/set_config_option' && event.target === 'b',
          ),
      ).toBe(true)
      // The left-side Agent options must not become a second model trigger.
      expect(await page.getByRole('button', { name: 'B', exact: true }).count()).toBe(0)
      const session = host.ctx.sessions.get(sessionId)!
      await page.setViewportSize({ width: 390, height: 844 })
      writeFileSync(join(directory, 'fault'), 'refuse')
      await select('A', 390)
      expect(await submit('SWITCH_TEST_SECOND')).toBe(sessionId)
      const retry = page.getByRole('button', { name: copy.resendUnsentMessage, exact: true })
      await fitsViewport(retry, 390)
      expect(trace().filter((event) => event.method === 'session/prompt')).toHaveLength(1)
      expect(session.requestHeader()?.config.model).toBe('b')
      await capture('unsent-model-recovery-390')
      await page.setViewportSize({ width: 1280, height: 900 })
      await fitsViewport(retry, 1280)
      await capture('unsent-model-recovery-desktop')

      writeFileSync(join(directory, 'fault'), 'none')
      const retried = host.whenTurnSettled()
      await retry.click()
      expect(await retried).toBe(sessionId)
      await expect.poll(() => retry.count()).toBe(0)
      const prompts = trace().filter((event) => event.method === 'session/prompt')
      expect(prompts).toHaveLength(2)
      expect(session.requestHeader()?.config.model).toBe('a')
      expect(prompts[1]).toMatchObject({
        session: first.session,
        model: 'a',
        markers: ['SWITCH_TEST_SECOND'],
        history: ['SWITCH_TEST_FIRST'],
      })
      await capture('resumed-conversation-desktop')

      writeFileSync(join(directory, 'fault'), 'prompt-error')
      expect(await submit('SWITCH_TEST_THIRD')).toBe(sessionId)
      await page.getByText('The selected model rejected the submitted prompt', { exact: true }).waitFor()
      expect(
        trace()
          .filter((event) => event.method === 'session/prompt')
          .at(-1),
      ).toMatchObject({
        session: first.session,
        markers: ['SWITCH_TEST_THIRD'],
      })
      expect(await retry.count()).toBe(0)
    } finally {
      await browser?.close()
      await host.close()
    }
  },
)
