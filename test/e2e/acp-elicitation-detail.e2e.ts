import type * as acp from '@agentclientprotocol/sdk'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectFreshWorkspaceZh, writeComposerDraft } from '#host-support'
import {
  createAcpNativeElicitationHandler,
  type AcpNativeElicitationDeps,
} from '../../src/domain/policy/elicitation.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'

const provider = 'elicitation-ui-control'
const model = 'elicitation-ui-model'
const requestMessage =
  '请先检查当前工作区中的本地改动，再选择处理方式。请保留未提交文件、当前分支和现有目录结构；说明应结合本次操作的范围，避免覆盖工作区中与本次请求无关的内容。'
const secondFieldDetail =
  '请补充说明你检查到的具体文件、需要保留的内容，以及选择该方案的原因。若有多项内容，请按影响顺序逐项写明，确保后续执行能够准确理解这份说明。'
const preserveOption = '保留工作区中已经编辑的本地改动和未提交文件，并继续使用当前分支与既有目录结构'
const discardOption = '放弃当前工作区中的本地改动并重新生成文件，同时保留其他目录和会话中的内容'
const userAnswer = '已检查目标文件，只保留本次请求涉及的本地改动。'
const directQuestions = [
  {
    id: 'local_action',
    question: '本地改动',
    detail: requestMessage,
    options: [{ label: preserveOption }, { label: discardOption }],
  },
  { id: 'follow_up', question: '补充说明', detail: secondFieldDetail },
] as const

class ElicitationUiControl extends LlmAdapter {
  constructor(private readonly ask: (request: GenerateOptions) => Promise<void>) {
    super()
  }

  providerInfo(providerId: string) {
    return { id: providerId, name: 'ACP elicitation UI control' }
  }

  async listModels(providerId: string) {
    return [{ provider: providerId, id: model, name: 'ACP elicitation UI model' }]
  }

  providerRetryPolicy(): ReturnType<LlmAdapter['providerRetryPolicy']> {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  async *stream(request: GenerateOptions): ReturnType<LlmAdapter['stream']> {
    if (request.purpose === undefined) await this.ask(request)
    const text = request.purpose === undefined ? 'ELICITATION_UI_DONE' : 'ACP elicitation UI control'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

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
      card: { x, y, width, height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth },
      header: rect('header'),
      heading: rect('h2'),
      detail: rect('[data-question-scroll] > div:first-child p'),
      body: rect('[data-question-scroll]'),
      footer: rect('footer'),
      footerActions: rect('footer > div:last-child'),
    }
  })
}

type GeometrySnapshot = Awaited<ReturnType<typeof geometry>>

function cardRelativeGeometry(box: GeometrySnapshot) {
  const relative = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x - box.card.x,
    y: rect.y - box.card.y,
    width: rect.width,
    height: rect.height,
  })
  return {
    card: {
      width: box.card.width,
      height: box.card.height,
      clientWidth: box.card.clientWidth,
      scrollWidth: box.card.scrollWidth,
    },
    header: relative(box.header),
    heading: relative(box.heading),
    detail: relative(box.detail),
    body: relative(box.body),
    footer: relative(box.footer),
    footerActions: relative(box.footerActions),
  }
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
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function assertCardWithinViewport(page: Page, card: Locator) {
  const box = await geometry(card)
  const viewport = required(page.viewportSize())
  expect(box.card.x).toBeGreaterThanOrEqual(0)
  expect(box.card.x + box.card.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.card.y).toBeGreaterThanOrEqual(0)
  expect(box.card.y + box.card.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(box.footer.y + box.footer.height).toBeLessThanOrEqual(box.card.y + box.card.height + 1)
}

async function captureOverflowEvidence(page: Page, card: Locator, name: string, directory: string) {
  const viewport = required(page.viewportSize())
  const layout = await card.evaluate((element) => {
    const describe = (node: Element) => {
      const rect = node.getBoundingClientRect()
      const html = node as HTMLElement
      return {
        tag: node.tagName.toLowerCase(),
        className: typeof html.className === 'string' ? html.className.slice(0, 120) : '',
        text: (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
        x: rect.x,
        right: rect.right,
        width: rect.width,
        clientWidth: html.clientWidth,
        scrollWidth: html.scrollWidth,
      }
    }
    const nodes = [element, ...Array.from(element.querySelectorAll('*'))].slice(0, 80).map(describe)
    return {
      card: describe(element),
      nodes,
      horizontalOverflow: nodes.filter(
        (node) => node.right > window.innerWidth + 1 || node.scrollWidth > node.clientWidth + 1,
      ),
    }
  })
  if (layout.horizontalOverflow.length === 0) return
  writeFileSync(
    join(directory, `${name}-overflow.json`),
    JSON.stringify(
      {
        viewport,
        note: 'The upstream DSH QuestionComposer has a 2px detail inset and a fixed-width footer that may clip at 375/320px. This fixture records that layout and compares ACP mapping with the direct native question path; it does not assert that upstream behavior is fixed.',
        ...layout,
      },
      null,
      2,
    ),
  )
  await page.screenshot({ path: join(directory, `${name}-overflow.png`), animations: 'disabled' })
}

async function waitForCardWidth(page: Page, card: Locator, name: string, directory: string) {
  try {
    await expect.poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  } catch (error) {
    await captureOverflowEvidence(page, card, name, directory).catch(() => undefined)
    throw error
  }
}

it('renders ACP elicitation detail once in the native question composer', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  let page: Page | undefined
  let outcome: acp.CreateElicitationResponse | undefined
  let nativeAnswers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[] = []
  let questionMode: 'acp' | 'native' = 'acp'
  let stage = 'launch'
  const callbackLedger: {
    mode: 'acp' | 'native'
    sessionId: string
    result: 'pending' | 'resolved' | 'rejected'
    errorName?: string
  }[] = []
  const fixtureSessions = new Set<string>()
  const hostSessionEventTypes: Record<string, number> = {}
  const mainRequestStarts: ('acp' | 'native')[] = []
  const errors: string[] = []
  const evidence = join(root, '.local/e2e-acp-elicitation-detail', process.env.DSH_E2E_ELECTRON ? 'electron' : 'web')
  mkdirSync(evidence, { recursive: true })

  try {
    host.ctx.on('session/event', (session, event) => {
      if (!fixtureSessions.has(session.id)) return
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      if (hostSessionEventTypes[type] === undefined && Object.keys(hostSessionEventTypes).length >= 40) return
      hostSessionEventTypes[type] = (hostSessionEventTypes[type] ?? 0) + 1
    })
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    host.ctx.effect(() =>
      host.ctx.llm.registerAdapter(
        [provider],
        new ElicitationUiControl(async (request) => {
          const sessionId = required(request.sessionId)
          fixtureSessions.add(sessionId)
          mainRequestStarts.push(questionMode)
          const ledgerEntry: (typeof callbackLedger)[number] = { mode: questionMode, sessionId, result: 'pending' }
          callbackLedger.push(ledgerEntry)
          try {
            const agent = required(host.ctx.agents.get(sessionId))
            const userQuestions = host.ctx.get('userQuestions') as AcpNativeElicitationDeps['userQuestions']
            if (questionMode === 'native') {
              nativeAnswers = (
                await required(userQuestions).ask({
                  questions: directQuestions,
                  agent,
                  signal: request.signal,
                })
              ).answers
              ledgerEntry.result = 'resolved'
              return
            }
            const handle = createAcpNativeElicitationHandler({
              userQuestions,
              getAgent: () => agent,
              locale: 'zh-CN',
            })
            outcome = await handle(
              {
                requestId: 'acp-elicitation-ui-fixture',
                mode: 'form',
                message: requestMessage,
                requestedSchema: {
                  type: 'object',
                  properties: {
                    local_action: {
                      type: 'string',
                      title: '本地改动',
                      description: `  ${requestMessage}\n`,
                      oneOf: [
                        { const: 'preserve', title: preserveOption },
                        { const: 'discard', title: discardOption },
                      ],
                    },
                    follow_up: {
                      type: 'string',
                      title: '补充说明',
                      description: secondFieldDetail,
                    },
                  },
                  required: ['local_action', 'follow_up'],
                },
              },
              request.signal,
            )
            if (outcome.action !== 'accept') throw new Error(`ACP elicitation was not accepted: ${outcome.action}`)
            ledgerEntry.result = 'resolved'
          } catch (error) {
            ledgerEntry.result = 'rejected'
            ledgerEntry.errorName = error instanceof Error ? error.name : typeof error
            throw error
          }
        }),
      ),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider, model })

    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    page = await newEnglishPage(browser, 640)
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspaceZh(page, host.workspaceCwd)

    const card = page.locator('div[data-question-key] > section')
    stage = 'ACP form: send prompt and wait for first question'
    const settled = host.whenTurnSettled(60_000)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Open the ACP elicitation fixture')
    await page.getByRole('button', { name: /^(?:Send message|发送消息)$/ }).click()
    await card.waitFor()
    await expect.poll(() => card.locator('h2').innerText()).toBe('本地改动')

    const firstBody = card.locator('[data-question-scroll]')
    const firstText = await firstBody.innerText()
    expect(firstText.split(requestMessage).length - 1).toBe(1)
    expect(firstText).not.toContain(secondFieldDetail)
    expect(await card.getByRole('radio', { name: preserveOption, exact: true }).count()).toBe(1)
    expect(await card.locator('textarea').count()).toBe(1)

    const capture = (name: string) => page!.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })
    const firstScreens: unknown[] = []
    const firstLayouts = new Map<number, GeometrySnapshot>()
    for (const theme of ['light', 'dark']) {
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => page!.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const width of [1680, 640, 375, 320]) {
        await page.setViewportSize({ width, height: width === 1680 ? 1000 : 640 })
        if (width <= 420) await page.locator('[data-sidebar-collapsed="true"]').waitFor()
        if (width >= 640) {
          await waitForCardWidth(page, card, `${theme}-${width}-local-action`, evidence)
          await assertFits(page, card)
        } else {
          // The DSH-owned footer can overflow at these sizes. Keep a bounded
          // card-in-viewport check and record the native layout as evidence.
          await captureOverflowEvidence(page, card, `${theme}-${width}-local-action`, evidence)
          await assertCardWithinViewport(page, card)
        }
        const layout = await geometry(card)
        if (theme === 'light') firstLayouts.set(width, layout)
        firstScreens.push(layout)
        await capture(`${theme}-${width}-local-action`)
      }
    }

    await card.getByRole('radio', { name: preserveOption, exact: true }).click()
    await expect.poll(() => card.locator('h2').innerText()).toBe('补充说明')
    const secondBody = card.locator('[data-question-scroll]')
    const secondText = await secondBody.innerText()
    expect(secondText.split(secondFieldDetail).length - 1).toBe(1)
    expect(secondText).not.toContain(requestMessage)
    const answerInput = card.getByPlaceholder('输入你的答案')
    await answerInput.fill(userAnswer)

    const secondScreens: unknown[] = []
    const secondLayouts = new Map<number, GeometrySnapshot>()
    for (const theme of ['light', 'dark']) {
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => page!.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const width of [1680, 640, 375, 320]) {
        await page.setViewportSize({ width, height: width === 1680 ? 1000 : 640 })
        if (width >= 640) {
          await waitForCardWidth(page, card, `${theme}-${width}-follow-up`, evidence)
          await assertFits(page, card)
        } else {
          await captureOverflowEvidence(page, card, `${theme}-${width}-follow-up`, evidence)
          await assertCardWithinViewport(page, card)
        }
        const layout = await geometry(card)
        if (theme === 'light') secondLayouts.set(width, layout)
        secondScreens.push(layout)
        await capture(`${theme}-${width}-follow-up`)
      }
    }

    await page.setViewportSize({ width: 1680, height: 1000 })
    await waitForCardWidth(page, card, 'light-1680-follow-up-submit', evidence)
    await assertFits(page, card)
    await card.locator('footer button').last().click()
    await settled
    stage = 'ACP form settled: wait for card removal and rendered completion'
    await card.waitFor({ state: 'hidden' })
    await page
      .locator('[data-chat-flow-kind="assistant-step"]')
      .filter({ hasText: 'ELICITATION_UI_DONE' })
      .last()
      .waitFor()
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    expect(outcome).toEqual({
      action: 'accept',
      content: { local_action: 'preserve', follow_up: userAnswer },
    })
    expect(errors).toEqual([])
    expect(firstScreens).toHaveLength(8)
    expect(secondScreens).toHaveLength(8)

    // Compare the ACP mapping with DSH's direct public question service. At
    // 375/320px this records the native card's existing footer clipping and
    // 2px detail inset; it does not claim either upstream behavior is fixed.
    questionMode = 'native'
    stage = 'native baseline: set up prompt'
    await host.ctx.settings.replace('ui-theme', { preference: 'light' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    const nativeSettled = host.whenTurnSettled(60_000)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Open the native question baseline')
    const send = page.getByRole('button', { name: /^(?:Send message|发送消息)$/ })
    await expect.poll(() => send.isEnabled()).toBe(true)
    const nativeStartCount = mainRequestStarts.filter((mode) => mode === 'native').length
    stage = 'native baseline: wait for model stream and question handler entry'
    await send.click()
    await expect.poll(() => mainRequestStarts.filter((mode) => mode === 'native').length).toBe(nativeStartCount + 1)
    stage = 'native baseline: wait for first question card'
    await expect.poll(() => card.locator('h2').innerText()).toBe('本地改动')
    stage = 'native baseline: inspect first question layout'
    const baselineFirstText = await card.locator('[data-question-scroll]').innerText()
    expect(baselineFirstText.split(requestMessage).length - 1).toBe(1)
    expect(await card.getByRole('radio', { name: preserveOption, exact: true }).count()).toBe(1)
    const baselineFirstLayouts = new Map<number, GeometrySnapshot>()
    for (const width of [1680, 640, 375, 320]) {
      await page.setViewportSize({ width, height: width === 1680 ? 1000 : 640 })
      if (width <= 420) await page.locator('[data-sidebar-collapsed="true"]').waitFor()
      if (width >= 640) {
        await waitForCardWidth(page, card, `native-${width}-local-action`, evidence)
        await assertFits(page, card)
      } else {
        await captureOverflowEvidence(page, card, `native-${width}-local-action`, evidence)
        await assertCardWithinViewport(page, card)
      }
      const layout = await geometry(card)
      baselineFirstLayouts.set(width, layout)
      if (width === 375 || width === 320) {
        expect(cardRelativeGeometry(layout)).toEqual(cardRelativeGeometry(required(firstLayouts.get(width))))
        await capture(`native-${width}-local-action`)
      }
    }

    await card.getByRole('radio', { name: preserveOption, exact: true }).click()
    stage = 'native baseline: wait for second question'
    await expect.poll(() => card.locator('h2').innerText()).toBe('补充说明')
    stage = 'native baseline: inspect second question layout'
    const baselineSecondText = await card.locator('[data-question-scroll]').innerText()
    expect(baselineSecondText.split(secondFieldDetail).length - 1).toBe(1)
    expect(baselineSecondText).not.toContain(requestMessage)
    const nativeInput = card.getByPlaceholder('输入你的答案')
    await nativeInput.fill(userAnswer)
    const baselineSecondLayouts = new Map<number, GeometrySnapshot>()
    for (const width of [1680, 640, 375, 320]) {
      await page.setViewportSize({ width, height: width === 1680 ? 1000 : 640 })
      if (width <= 420) await page.locator('[data-sidebar-collapsed="true"]').waitFor()
      if (width >= 640) {
        await waitForCardWidth(page, card, `native-${width}-follow-up`, evidence)
        await assertFits(page, card)
      } else {
        await captureOverflowEvidence(page, card, `native-${width}-follow-up`, evidence)
        await assertCardWithinViewport(page, card)
      }
      const layout = await geometry(card)
      baselineSecondLayouts.set(width, layout)
      if (width === 375 || width === 320) {
        expect(cardRelativeGeometry(layout)).toEqual(cardRelativeGeometry(required(secondLayouts.get(width))))
        await capture(`native-${width}-follow-up`)
      }
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await waitForCardWidth(page, card, 'native-1680-follow-up-submit', evidence)
    await assertFits(page, card)
    stage = 'native baseline: submit and wait for completion'
    await card.locator('footer button').last().click()
    await nativeSettled
    expect(nativeAnswers).toEqual([
      { id: 'local_action', selected: [preserveOption] },
      { id: 'follow_up', selected: [], custom: userAnswer },
    ])
    expect(baselineFirstLayouts.size).toBe(4)
    expect(baselineSecondLayouts.size).toBe(4)
    expect(errors).toEqual([])
    stage = 'complete'
  } catch (error) {
    try {
      writeFileSync(
        join(evidence, 'failure.json'),
        JSON.stringify(
          {
            stage,
            mainRequestStarts,
            callbacks: callbackLedger,
            hostSessionEventTypes,
            pageErrorCount: errors.length,
          },
          null,
          2,
        ),
      )
    } catch {
      // Preserve the original fixture failure if diagnostic evidence cannot be written.
    }
    if (page !== undefined) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
})
