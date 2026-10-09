import type { AcpNativeUserQuestionService } from '../../src/domain/policy/elicitation.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import type { QuestionProbe } from './fixtures/render-probe/client.ts'

declare global {
  interface Window {
    __DSH_ACP_QUESTION_PROBE__?: QuestionProbe
  }
}

/** Deterministic question producer, not a simulated provider compatibility test.
 * The official Host/gateway and registered ACP composer execute unchanged. */
class QuestionControl extends LlmAdapter {
  constructor(private readonly ask: (request: GenerateOptions) => Promise<void>) {
    super()
  }
  providerInfo(provider: string) {
    return { id: provider, name: 'Question UI control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'question-model', name: 'Question UI model' }]
  }
  providerRetryPolicy(): ReturnType<LlmAdapter['providerRetryPolicy']> {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
  async *stream(request: GenerateOptions): ReturnType<LlmAdapter['stream']> {
    if (request.purpose === undefined) await this.ask(request)
    const text = request.purpose === undefined ? 'QUESTION_UI_DONE' : 'Question UI control'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type AskUserQuestionItem = Parameters<AcpNativeUserQuestionService['ask']>[0]['questions'][number]
const question = (
  title = 'Which test label should we use?',
  labels = ['ALPHA', 'BETA', 'GAMMA'],
): AskUserQuestionItem => ({
  id: 'acp-permission:ui-control',
  question: title,
  detail: '请结合当前工作区说明需要保留的文件和操作范围，确保这段补充信息在窄屏中仍可阅读，并与问题标题左侧对齐。',
  options: labels.map((label) => ({ label })),
})

async function geometry(card: Locator) {
  return await card.evaluate((element) => {
    const rect = (selector: string) => {
      const target = element.querySelector(selector)
      if (target === null) throw new Error(`Missing question surface ${selector}`)
      const { x, y, width, height } = target.getBoundingClientRect()
      return { x, y, width, height }
    }
    const { x, y, width, height } = element.getBoundingClientRect()
    return {
      card: { x, y, width, height },
      header: rect('header'),
      heading: rect('h2'),
      detail: rect('[data-question-detail] p'),
      body: rect('[data-question-scroll]'),
      footer: rect('footer'),
      actions: rect('footer > div'),
    }
  })
}

async function assertFits(page: Page, card: Locator) {
  const box = await geometry(card)
  const viewport = required(page.viewportSize())
  expect(box.card.x).toBeGreaterThanOrEqual(0)
  expect(box.card.x + box.card.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.card.y).toBeGreaterThanOrEqual(0)
  expect(box.card.y + box.card.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(box.footer.y + box.footer.height).toBeLessThanOrEqual(box.card.y + box.card.height + 1)
  expect(box.body.height).toBeGreaterThan(0)
  expect(Math.abs(box.heading.x - box.detail.x)).toBeLessThanOrEqual(1)
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

it('keeps ACP fixed choices usable across keyboard, themes, narrow windows, failure and Session switches', async () => {
  const host = await launchAdapterWorld({ renderProbe: true })
  let browser: TestBrowser | undefined
  let page: Page | undefined
  let spec = question()
  const answers: { session: string; selected: string[]; custom?: string }[] = []
  const cancelled: string[] = []
  const requested: string[] = []
  const errors: string[] = []
  const directory = join(
    root,
    '.local/antigravity-integration-2026-10-09/question-ui',
    process.env.DSH_E2E_ELECTRON ? 'electron' : 'web',
  )
  mkdirSync(directory, { recursive: true })
  let stage = 'launch'
  try {
    host.ctx.effect(() =>
      host.ctx.llm.registerAdapter(
        ['question-ui-control'],
        new QuestionControl(async (request) => {
          const agent = required(host.ctx.agents.get(required(request.sessionId)))
          requested.push(agent.id)
          try {
            const service = host.ctx.get('userQuestions') as AcpNativeUserQuestionService
            const answer = await service.ask({ agent, questions: [{ ...spec }], signal: request.signal })
            const item = required(answer.answers[0])
            answers.push({
              session: agent.id,
              selected: [...item.selected],
              ...(item.custom === undefined ? {} : { custom: item.custom }),
            })
          } catch (error) {
            if ((error as { code?: string }).code !== 'ASK_CANCELLED') throw error
            cancelled.push(agent.id)
          }
        }),
      ),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'question-ui-control', model: 'question-model' })
    browser = await launchBrowser({ headless: true })
    page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const activePage = page
    const card = page.locator('section[data-question-key]')
    const start = async (name: string) => {
      stage = `request ${name}`
      const count = requested.length
      await writeComposerDraft(activePage, activePage.locator('[data-composer-input]').first(), name)
      await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
      await card.waitFor()
      await expect.poll(() => requested.length).toBe(count + 1)
      return requested[count]!
    }
    const submit = () => card.getByRole('button', { name: /^(Submit|提交选择)$/ })
    const cancel = () => card.getByRole('button', { name: /^(Cancel|取消请求)$/ })
    const radio = (label: string) => card.getByRole('radio', { name: label, exact: true })
    const capture = (name: string) =>
      activePage.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })

    const first = await start('Question keyboard control')
    stage = 'keyboard'
    expect(await card.locator('[role="radio"][aria-checked="true"]').count()).toBe(0)
    expect(await submit().isDisabled()).toBe(true)
    expect(await card.locator('textarea, input[type="text"], [contenteditable="true"]').count()).toBe(0)
    expect(await card.locator('[role="radio"][tabindex="0"]').count()).toBe(1)
    await radio('ALPHA').focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => radio('GAMMA').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => radio('ALPHA').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('End')
    await expect.poll(() => radio('GAMMA').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Home')
    await expect.poll(() => radio('ALPHA').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await page.keyboard.press('Enter')
    expect(await card.locator('[role="radio"][aria-checked="true"]').count()).toBe(1)
    expect(await page.evaluate(() => window.__DSH_ACP_QUESTION_PROBE__!.stats())).toEqual({ attempts: 0, forwarded: 0 })
    await page.keyboard.press('Tab')
    expect(await cancel().evaluate((el) => el === document.activeElement)).toBe(true)
    expect(answers).toHaveLength(0)

    stage = 'theme and narrow layout'
    const materials: unknown[] = []
    for (const theme of ['light', 'dark']) {
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => activePage.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const width of [1680, 375, 320]) {
        await page.setViewportSize({ width, height: width === 1680 ? 1000 : 640 })
        if (width !== 1680) await page.locator('[data-sidebar-collapsed="true"]').waitFor()
        await assertFits(page, card)
        for (const action of await card.locator('footer button').all()) {
          // Shared buttons keep their native single-line geometry, rather than
          // squeezing wrapped labels into a fixed-height control on narrow screens.
          expect(
            await action.evaluate((el) => {
              const range = document.createRange()
              range.selectNodeContents(el)
              const text = range.getBoundingClientRect()
              const box = el.getBoundingClientRect()
              return (
                text.height <= parseFloat(getComputedStyle(el).lineHeight) + 1 &&
                text.top >= box.top &&
                text.bottom <= box.bottom
              )
            }),
          ).toBe(true)
        }
        materials.push(
          await card.evaluate((el) => ({
            background: getComputedStyle(el).backgroundColor,
            color: getComputedStyle(el.querySelector('h2')!).color,
          })),
        )
        await capture(`${theme}-${width}-selected`)
      }
    }
    writeFileSync(join(directory, 'materials.json'), JSON.stringify(materials, null, 2))
    expect(materials[0]).not.toEqual(materials[3])

    stage = 'failed submission retains state and positions'
    const before = await geometry(card)
    await page.evaluate(() => window.__DSH_ACP_QUESTION_PROBE__!.failNext())
    await submit().click()
    await card.getByRole('status').getByText('Could not submit; try again', { exact: true }).waitFor()
    expect(await radio('BETA').getAttribute('aria-checked')).toBe('true')
    expect(await submit().isEnabled()).toBe(true)
    expect(await card.innerText()).not.toContain('UI_PROBE_INTERNAL_FAILURE')
    expect(answers).toHaveLength(0)
    const failed = await geometry(card)
    expect(failed.actions).toEqual(before.actions)
    expect(failed.footer).toEqual(before.footer)
    await capture('dark-320-submit-failed')
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    await card.getByRole('status').getByText('提交失败，请重试', { exact: true }).waitFor()
    expect((await geometry(card)).footer).toEqual(before.footer)
    await capture('dark-320-submit-failed-zh')
    const settled = host.whenTurnSettled(30_000)
    await submit().click()
    await settled
    expect(answers).toEqual([{ session: first, selected: ['BETA'] }])
    expect(await page.evaluate(() => window.__DSH_ACP_QUESTION_PROBE__!.stats())).toEqual({ attempts: 2, forwarded: 1 })

    stage = 'long question and long options'
    await host.ctx.settings.replace('locale', { preference: 'en' })
    spec = question(
      Array.from({ length: 20 }, (_, i) => `Long title line ${i + 1}`).join('\n'),
      Array.from({ length: 20 }, (_, i) => `Choice ${i + 1}: ${'unbrokenlabel'.repeat(8)}`),
    )
    await start('Question long content control')
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 640 })
      await assertFits(page, card)
      const body = card.locator('[data-question-scroll]')
      expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      const fixed = await geometry(card)
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      const scrolled = await geometry(card)
      expect(scrolled.header).toEqual(fixed.header)
      expect(scrolled.footer).toEqual(fixed.footer)
      expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      expect(await card.locator('header').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      await card.locator('header').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await radio(spec.options![19]!.label).click()
      await capture(`dark-${width}-long-content`)
    }
    const longSettled = host.whenTurnSettled(30_000)
    await cancel().click()
    await longSettled
    expect(cancelled).toEqual([first])

    stage = 'Session draft retention and request reset'
    await page.setViewportSize({ width: 1680, height: 1000 })
    spec = question('Session A choices')
    const sessionA = await start('Question session A')
    expect(await submit().isDisabled()).toBe(true)
    await radio('BETA').click()
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await card.waitFor({ state: 'hidden' })
    spec = question('Session B choices')
    const sessionB = await start('Question session B')
    expect(sessionB).not.toBe(sessionA)
    expect(await submit().isDisabled()).toBe(true)
    await radio('GAMMA').click()
    await page.evaluate((id) => window.__DSH_ACP_QUESTION_PROBE__!.openSession(id), sessionA)
    await card.getByRole('heading', { name: 'Session A choices' }).waitFor()
    expect(await radio('BETA').getAttribute('aria-checked')).toBe('true')
    const aSettled = host.whenTurnSettled(30_000)
    await cancel().click()
    await aSettled
    await page.evaluate((id) => window.__DSH_ACP_QUESTION_PROBE__!.openSession(id), sessionB)
    await card.getByRole('heading', { name: 'Session B choices' }).waitFor()
    expect(await radio('GAMMA').getAttribute('aria-checked')).toBe('true')
    const bSettled = host.whenTurnSettled(30_000)
    await submit().click()
    await bSettled
    expect(answers.at(-1)).toEqual({ session: sessionB, selected: ['GAMMA'] })

    stage = 'ordinary native question keeps free input'
    spec = { ...question('Native question control'), id: 'ordinary-native-question' }
    const nativeSettled = host.whenTurnSettled(30_000)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Question native control')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const native = page.locator('[data-question-key]').filter({ hasText: 'Native question control' })
    await native.getByPlaceholder(/Type your answer/i).waitFor()
    expect(await card.count()).toBe(0)
    await native.getByPlaceholder(/Type your answer/i).fill('Native custom answer remains supported')
    await native.getByRole('button', { name: /Submit|Send/ }).click()
    await nativeSettled
    expect(answers.at(-1)).toEqual({
      session: sessionB,
      selected: [],
      custom: 'Native custom answer remains supported',
    })
    expect(errors).toEqual([])
  } catch (error) {
    writeFileSync(join(directory, 'failure-stage.txt'), stage)
    if (page !== undefined) {
      await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => undefined)
      writeFileSync(join(directory, 'failure.html'), await page.content().catch(() => ''))
    }
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
