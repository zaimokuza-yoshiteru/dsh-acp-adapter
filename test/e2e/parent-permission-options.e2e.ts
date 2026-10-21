/** Published Loader + real ACP subprocess + native browser UI; no model credentials. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { AcpNativeUserQuestionService } from '../../src/domain/policy/elicitation.ts'
import type { Locator } from 'playwright'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { PARENT_PERMISSION_OPTIONS, parentPermissionMarker } from '../mock-agent/parent-permission-options-turn.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

const before = process.env.DSH_E2E_PARENT_APPROVAL_BASELINE === '1'
const directory =
  process.env.DSH_E2E_PARENT_APPROVAL_EVIDENCE_DIRECTORY ??
  join(root, '.local/parent-approval-20261021', before ? 'before' : 'after')
mkdirSync(directory, { recursive: true })

class NativeParent extends LlmAdapter {
  constructor(
    private readonly beforeStream: (request: GenerateOptions) => Promise<void>,
    private readonly locale: 'en' | 'zh',
  ) {
    super()
  }
  providerInfo(id: string) {
    return { id, name: 'Parent permission control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(request: GenerateOptions): ReturnType<LlmAdapter['stream']> {
    if (request.purpose === undefined) await this.beforeStream(request)
    const text =
      this.locale === 'zh'
        ? '评审工作区已准备好。子 Agent 会在这里请求批准受限操作。'
        : 'The review workspace is ready. Child Agents will request approval here before restricted operations.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(parentKind: 'native' | 'acp' = 'native', locale: 'en' | 'zh' = 'en') {
  const host = await launchAdapterWorld({
    adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root,
    toolsMode: 'native',
  })
  const browser = await launchBrowser({ headless: true })
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1600, height: 1000 })
  page.setDefaultTimeout(15_000)
  const activations: SubagentActivation[] = []
  const children: Agent[] = []
  const holdMiddle = Promise.withResolvers<void>()
  const ownQuestionStarted = Promise.withResolvers<void>()
  const ownAnswers: unknown[] = []
  const questions: { agentId: string | undefined; questions: unknown }[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const log = join(host.workspaceCwd, 'parent-permission-wire.log')
  let askOwnQuestion = false
  let delayAnswer: ((questionText: string) => Promise<void>) | undefined
  const service = host.ctx.get('userQuestions') as AcpNativeUserQuestionService
  const originalAsk = service.ask.bind(service)
  vi.spyOn(service, 'ask').mockImplementation(async (request) => {
    questions.push({
      agentId: host.ctx.agents.list().find((agent) => agent === request.agent)?.id,
      questions: request.questions,
    })
    const answer = await originalAsk(request)
    await delayAnswer?.(JSON.stringify(request.questions))
    return answer
  })
  try {
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        'parent-options': {
          name: 'Parent permission fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_LOG: log,
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-parent-options')).toBe(true),
    )
    host.ctx.effect(() =>
      host.ctx.llm.registerAdapter(
        ['parent-native'],
        new NativeParent(async (request) => {
          if (JSON.stringify(request.messages).includes('E2E_HOLD_NATIVE_MIDDLE')) {
            const signal = required(request.signal)
            await Promise.race([
              holdMiddle.promise,
              new Promise<void>((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener('abort', () => resolve(), { once: true })
              }),
            ])
          } else if (askOwnQuestion) {
            askOwnQuestion = false
            const owner = required(host.ctx.agents.get(required(request.sessionId)))
            const answer = service.ask({
              agent: owner,
              questions: [
                {
                  id: 'parent-own-question',
                  question: 'PARENT_OWN_QUESTION',
                  options: [{ label: 'PARENT_ONLY_ALPHA' }, { label: 'PARENT_ONLY_BETA' }],
                },
              ],
              signal: request.signal,
            })
            ownQuestionStarted.resolve()
            ownAnswers.push(await answer)
          }
        }, locale),
      ),
    )
    await host.ctx.agentDefaultModel.saveSelection({
      provider: parentKind === 'native' ? 'parent-native' : 'acp-parent-options',
      model: parentKind === 'native' ? 'fixture' : 'mock-model-a',
    })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await host.ctx.settings.replace('locale', { preference: locale })
    await writeComposerDraft(
      page,
      page.locator('[data-composer-input]').first(),
      parentKind === 'acp'
        ? 'E2E_MESSAGE'
        : locale === 'zh'
          ? '请让子 Agent 检查工作区，涉及受限操作时在当前页面请求审批。'
          : 'Have the child Agents review this workspace and request approval here for restricted operations.',
    )
    const ready = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: locale === 'zh' ? '发送消息' : 'Send message', exact: true }).click()
    const parent = required(host.ctx.agents.get(await ready))
    expect(host.ctx.get('agentTeams', false)).toBeUndefined()
    const url = page.url()
    const marker = (key: string) => join(required(parent.session.header.cwd), parentPermissionMarker(key))
    const effects = (key: string): { key: string; sessionId: string; optionId: string }[] =>
      existsSync(marker(key))
        ? readFileSync(marker(key), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    const spawn = async (key: string, owner = parent, native = false) => {
      const activation = await host.ctx.subagents.startActivation({
        provider: 'spawn',
        label: native ? 'Nested direct parent' : `Permission worker ${key}`,
        delivery: 'caller',
        request: {
          parent: owner,
          prompt: [{ type: 'text', text: native ? 'E2E_HOLD_NATIVE_MIDDLE' : `E2E_PARENT_PERMISSION_OPTIONS:${key}` }],
          agentOptions: {
            provider: native ? 'parent-native' : 'acp-parent-options',
            model: native ? 'fixture' : 'mock-model-a',
          },
        },
        signal: new AbortController().signal,
      })
      activations.push(activation)
      const child = required(host.ctx.agents.get(activation.childId))
      children.push(child)
      return { activation, child }
    }
    const card = (key: string): Locator =>
      page.locator('section[data-question-key]').filter({ hasText: parentPermissionMarker(key) })
    const save = async (name: string, details: unknown = {}) => {
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true })
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify(
          {
            baseline: before,
            viewport: page.viewportSize(),
            parentKind,
            locale,
            parentId: parent.id,
            details,
            questions,
            asked: acpPermissionAudit(host, 'asked'),
            decided: acpPermissionAudit(host, 'decided'),
            children: children.map((child) => ({
              id: child.id,
              parentId: child.session.header.parentSession,
              nativePolicy: host.ctx.approval.overrideOf(child.session),
            })),
            wire: existsSync(log) ? readFileSync(log, 'utf8') : '',
            errors,
          },
          null,
          2,
        ),
      )
    }
    const close = async () => {
      holdMiddle.resolve()
      for (const child of children) child.cancel({ kind: 'user' })
      parent.cancel({ kind: 'user' })
      const outcomes = await Promise.allSettled([...activations].reverse().map((activation) => activation.dispose()))
      try {
        await browser.close()
      } finally {
        await host.close()
      }
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    return {
      ...host,
      parent,
      page,
      url,
      card,
      spawn,
      marker,
      effects,
      save,
      close,
      questions,
      ownAnswers,
      errors,
      locale,
      detailsLabel: locale === 'zh' ? '请求详情' : 'Request details',
      submitLabel: locale === 'zh' ? '提交选择' : 'Submit',
      delayAnswer: (callback: typeof delayAnswer) => {
        delayAnswer = callback
      },
      async startOwnQuestion() {
        askOwnQuestion = true
        parent.followup(
          createUserMessage({ content: [{ type: 'text', text: 'E2E_PARENT_OWN_QUESTION' }], source: { kind: 'user' } }),
        )
        await ownQuestionStarted.promise
      },
    }
  } catch (error) {
    holdMiddle.resolve()
    await browser.close()
    await host.close()
    throw error
  }
}

type World = Awaited<ReturnType<typeof fixture>>

async function finish(world: World, label: string) {
  try {
    await world.save(`${label}-final`)
  } finally {
    await world.close()
  }
}

async function assertChoices(
  world: World,
  key: string,
  child: Agent,
  expectedOperation = `write ${parentPermissionMarker(key)}`,
) {
  const card = world.card(key)
  await card.getByRole('radio', { name: 'Allow', exact: true }).waitFor()
  expect(await card.getByRole('radio').count()).toBe(PARENT_PERMISSION_OPTIONS.length)
  for (const option of PARENT_PERMISSION_OPTIONS)
    expect(await card.getByRole('radio', { name: option.name, exact: true }).count()).toBe(1)
  const source = await card.locator('[data-question-source]').innerText()
  expect(source).toContain(child.id.slice(0, 8))
  expect(source).toContain(`Permission worker ${key}`)
  expect(await card.locator('[data-question-operation]').innerText()).toContain(expectedOperation)
  expect(world.effects(key)).toEqual([])
  expect(world.ctx.approval.overrideOf(child.session)).toBe('never')
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.x >= 0 &&
          box.y >= 0 &&
          box.right <= window.innerWidth + 1 &&
          box.bottom <= window.innerHeight + 1 &&
          element.scrollWidth <= element.clientWidth
        )
      }),
    )
    .toBe(true)
  return card
}

async function choose(world: World, key: string, optionId: string) {
  const option = required(PARENT_PERMISSION_OPTIONS.find((entry) => entry.optionId === optionId))
  const card = world.card(key)
  await card.getByRole('radio', { name: option.name, exact: true }).click()
  await card.getByRole('button', { name: world.submitLabel, exact: true }).click()
}

/** The initial approval view must show the operation and every choice together, without a screenshot-only scroll. */
async function saveOptions(world: World, key: string, name: string) {
  const card = world.card(key)
  expect(await card.getByRole('button', { name: world.detailsLabel, exact: true }).getAttribute('aria-expanded')).toBe(
    'false',
  )
  expect(await card.locator('[data-question-detail]').count()).toBe(0)
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const body = element.querySelector('[data-question-scroll]')!
        const scroll = body.getBoundingClientRect()
        const header = element.querySelector('header')!
        const headerBox = header.getBoundingClientRect()
        const operation = element.querySelector('[data-question-operation]')!.getBoundingClientRect()
        const options = [...element.querySelectorAll('[role="radio"]')]
        return (
          body.scrollTop === 0 &&
          header.scrollHeight <= header.clientHeight + 1 &&
          operation.top >= headerBox.top - 1 &&
          operation.bottom <= headerBox.bottom + 1 &&
          options.length === 7 &&
          options.every((option) => {
            const box = option.getBoundingClientRect()
            return (
              box.top >= scroll.top - 1 &&
              box.bottom <= scroll.bottom + 1 &&
              box.left >= scroll.left - 1 &&
              box.right <= scroll.right + 1
            )
          })
        )
      }),
    )
    .toBe(true)
  await world.save(name, {
    defaultView: true,
    operation: await card.locator('[data-question-operation]').innerText(),
    optionIds: PARENT_PERMISSION_OPTIONS.map((option) => option.optionId),
  })
}

async function inspectDetails(world: World, key: string, children: Agent[], name: string) {
  const card = world.card(key)
  const details = card.getByRole('button', { name: world.detailsLabel, exact: true })
  const chosen = card.getByRole('radio', { name: 'Allow', exact: true })
  await chosen.click()
  await details.click()
  expect(await details.getAttribute('aria-expanded')).toBe('true')
  const raw = card.locator('[data-question-detail]')
  const text = await raw.innerText()
  for (const child of children) expect(text).toContain(child.id)
  expect(text).toContain(required(world.parent.session.header.cwd))
  expect(text).toContain('"cwd"')
  expect(text).toContain('"locations"')
  expect(text).toContain(parentPermissionMarker(key))
  expect(await chosen.getAttribute('aria-checked')).toBe('true')
  const readability = await raw
    .locator('pre')
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element)
      const rgb = (value: string) =>
        value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
      const luminance = (value: string) =>
        rgb(value)
          .map((channel) => {
            const normalized = channel / 255
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
          })
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
      const foreground = luminance(style.color)
      const background = luminance(style.backgroundColor)
      return {
        color: style.color,
        background: style.backgroundColor,
        fontSize: style.fontSize,
        contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      }
    })
  expect(readability.contrast).toBeGreaterThanOrEqual(4.5)
  expect(parseFloat(readability.fontSize)).toBeGreaterThanOrEqual(13)
  await world.save(`${name}-expanded-wide`, { readability })
  await card.getByRole('radio', { name: 'Reject', exact: true }).scrollIntoViewIfNeeded()
  expect(
    await raw.evaluate((element) => {
      const banners = [...element.querySelectorAll('[data-code-block-banner]')]
      return (
        banners.length > 0 && banners.every((banner) => getComputedStyle(banner.parentElement!).position !== 'sticky')
      )
    }),
  ).toBe(true)
  await world.save(`${name}-expanded-scrolled-wide`)
  await details.click()
  expect(await details.getAttribute('aria-expanded')).toBe('false')
  expect(await raw.count()).toBe(0)
  expect(await chosen.getAttribute('aria-checked')).toBe('true')
  expect(world.effects(key)).toEqual([])
  expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
}

async function inspectNarrowAccess(world: World, key: string) {
  const card = world.card(key)
  const chosen = card.getByRole('radio', { name: 'Allow', exact: true })
  await chosen.focus()
  await world.page.setViewportSize({ width: 390, height: 844 })
  expect(await chosen.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await chosen.getAttribute('aria-checked')).toBe('true')
  expect(await card.locator('[data-question-operation]').innerText()).toContain(`write ${parentPermissionMarker(key)}`)
  for (const option of PARENT_PERMISSION_OPTIONS) {
    const radio = card.getByRole('radio', { name: option.name, exact: true })
    await radio.scrollIntoViewIfNeeded()
    expect(
      await radio.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const viewport = element.closest('[data-question-scroll]')!.getBoundingClientRect()
        return (
          box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1 && box.left >= 0 && box.right <= innerWidth
        )
      }),
    ).toBe(true)
  }
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await world.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const submit = card.getByRole('button', { name: world.submitLabel, exact: true })
  expect(await submit.isEnabled()).toBe(true)
  expect(
    await submit.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
    }),
  ).toBe(true)
  await chosen.focus()
  await world.page.setViewportSize({ width: 1600, height: 1000 })
  expect(await chosen.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await chosen.getAttribute('aria-checked')).toBe('true')
  expect(world.effects(key)).toEqual([])
}

async function assertOldBoundary(world: World, activation: SubagentActivation, key: string) {
  await activation.result
  const decision = acpPermissionAudit(world, 'decided').find((entry) => entry.data.toolCallId === `parent-scope-${key}`)
  expect(decision?.data).toMatchObject({ outcome: 'cancelled', note: 'delegated-question-unavailable' })
  expect(world.effects(key)).toEqual([])
  expect(await world.card(key).count()).toBe(0)
}

it.each([
  { parentKind: 'native', locale: 'en' },
  { parentKind: 'acp', locale: 'en' },
  { parentKind: 'native', locale: 'zh' },
] as const)(
  'preserves seven child permission options on the $parentKind parent page in $locale across refresh',
  async ({ parentKind, locale }) => {
    const world = await fixture(parentKind, locale)
    const key = `seven-${parentKind}${locale === 'zh' ? '-zh' : ''}`
    try {
      const { activation, child } = await world.spawn(key)
      if (before) {
        await assertOldBoundary(world, activation, key)
        await world.save(key)
        return
      }
      await assertChoices(world, key, child)
      expect(await world.ctx.approval.request({ agent: child, toolName: 'E2E_NATIVE_POLICY_CHECK' })).toBe('rejected')
      expect(acpPermissionAudit(world, 'asked')).toHaveLength(1)
      expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
      for (const theme of ['light', 'dark']) {
        await world.ctx.settings.replace('ui-theme', { preference: theme })
        await expect.poll(() => world.page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
        await world.save(`${key}-${theme}-wide`)
        await saveOptions(world, key, `${key}-${theme}-options-wide`)
      }
      for (const theme of ['dark', 'light']) {
        await world.ctx.settings.replace('ui-theme', { preference: theme })
        await expect.poll(() => world.page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
        await inspectDetails(world, key, [child], `${key}-${theme}`)
      }
      await inspectNarrowAccess(world, key)
      await world.page.reload()
      const refreshed = await assertChoices(world, key, child)
      expect(await refreshed.getByRole('radio', { name: 'Allow', exact: true }).getAttribute('aria-checked')).toBe(
        'true',
      )
      expect(acpPermissionAudit(world, 'asked')).toHaveLength(1)
      expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
      await saveOptions(world, key, `${key}-selected-refreshed-wide`)
      const optionId = parentKind === 'native' ? 'allow_once' : 'allow_session'
      await choose(world, key, optionId)
      expect((await activation.result).stopReason).toBe('completed')
      expect(world.effects(key)).toEqual([
        { key, sessionId: required(acpPermissionAudit(world, 'asked')[0]).data.agentSessionId, optionId },
      ])
      expect(acpPermissionAudit(world, 'decided')).toHaveLength(1)
      expect(acpPermissionAudit(world, 'decided')[0]).toMatchObject({
        sessionId: child.id,
        data: { outcome: 'selected', optionId },
      })
      expect(world.ctx.approval.overrideOf(child.session)).toBe('never')
      expect(world.page.url()).toBe(world.url)
      expect(world.errors).toEqual([])
      await world.save(`${key}-completed`, { effects: world.effects(key) })
    } finally {
      await finish(world, key)
    }
  },
  90_000,
)

it.each(['file-write', 'long-scope'] as const)(
  'keeps the complete %s operation available before choosing an authorization scope',
  async (shape) => {
    const world = await fixture()
    const key = `${shape}-review`
    try {
      const { activation, child } = await world.spawn(key)
      if (before) {
        await assertOldBoundary(world, activation, key)
        await world.save(`${key}-baseline`)
        return
      }
      const card = await assertChoices(world, key, child, parentPermissionMarker(key))
      const operation = card.locator('[data-question-operation]')
      const text = await operation.innerText()
      const details = card.getByRole('button', { name: world.detailsLabel, exact: true })
      expect(await details.getAttribute('aria-expanded')).toBe('false')
      expect(await card.locator('[data-question-detail]').count()).toBe(0)
      expect(text).toContain(world.marker(key))
      if (shape === 'file-write') {
        expect(text).toContain('write')
        expect(text).toContain('Content: A short review marker.')
        expect(text).toContain(`File path: ${world.marker(key)}`)
        expect(text).not.toContain('Input: {')
        await saveOptions(world, key, `${key}-default-wide`)
      } else {
        expect(text).toContain('review-permission-context '.repeat(120))
        expect(text).toContain('ACP_LONG_COMMAND_END')
        expect(text).toContain('"additionalPermissions"')
        expect(text).toContain('"filesystem"')
        expect(text).toContain('ASK_BEFORE_SCOPE_EXPANSION')
        expect(text).toContain('review.example.invalid')
        expect(text).toContain('REQUIRES_OPERATOR_REVIEW_AT_END')
        expect(text).not.toContain('…')
        expect(await card.locator('header').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
          true,
        )
        await world.save(`${key}-default-wide`)
        for (const [name, needle] of [
          ['command-end', 'ACP_LONG_COMMAND_END'],
          ['scope-end', 'REQUIRES_OPERATOR_REVIEW_AT_END'],
        ]) {
          const target = required(needle)
          await operation.evaluate((element, needle) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
            let node: Node | null
            while ((node = walker.nextNode()) !== null) {
              const offset = node.textContent!.indexOf(needle)
              if (offset < 0) continue
              const range = document.createRange()
              range.setStart(node, offset)
              range.setEnd(node, offset + needle.length)
              const header = element.closest('header')!
              const target = range.getBoundingClientRect()
              header.scrollTop += target.top - header.getBoundingClientRect().top - header.clientHeight / 2
              return
            }
            throw new Error(`Operation text is missing: ${needle}`)
          }, target)
          expect(
            await operation.evaluate((element, needle) => {
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
              let node: Node | null
              while ((node = walker.nextNode()) !== null) {
                const offset = node.textContent!.indexOf(needle)
                if (offset < 0) continue
                const range = document.createRange()
                range.setStart(node, offset)
                range.setEnd(node, offset + needle.length)
                const target = range.getBoundingClientRect()
                const header = element.closest('header')!.getBoundingClientRect()
                return (
                  target.top >= header.top &&
                  target.bottom <= header.bottom &&
                  target.left >= 0 &&
                  target.right <= innerWidth
                )
              }
              return false
            }, target),
          ).toBe(true)
          await world.save(`${key}-${name}-wide`)
        }
      }
      expect(world.effects(key)).toEqual([])
      expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
      await choose(world, key, 'reject_once')
      await activation.result
      expect(world.effects(key)).toEqual([])
      expect(acpPermissionAudit(world, 'decided')).toMatchObject([
        { sessionId: child.id, data: { outcome: 'selected', optionId: 'reject_once' } },
      ])
      expect(world.ctx.approval.overrideOf(child.session)).toBe('never')
      expect(world.errors).toEqual([])
    } finally {
      await finish(world, key)
    }
  },
  90_000,
)

it('keeps concurrent child decisions separate from a running parent’s own native question', async () => {
  const world = await fixture()
  try {
    await world.startOwnQuestion()
    const own = world.page.locator('[data-question-key]').filter({ hasText: 'PARENT_OWN_QUESTION' })
    await own.getByRole('radio', { name: 'PARENT_ONLY_ALPHA', exact: true }).waitFor()
    expect(world.parent.status).toBe('running')
    const first = await world.spawn('concurrent-a')
    if (!before) await assertChoices(world, 'concurrent-a', first.child)
    const second = await world.spawn('concurrent-b')
    if (before) {
      await assertOldBoundary(world, first.activation, 'concurrent-a')
      await assertOldBoundary(world, second.activation, 'concurrent-b')
    } else {
      await assertChoices(world, 'concurrent-b', second.child)
      expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
      await world.save('concurrent-three-pending-wide')
      await saveOptions(world, 'concurrent-b', 'concurrent-three-pending-options-wide')
      await choose(world, 'concurrent-b', 'reject_once')
      await second.activation.result
      expect(world.effects('concurrent-a')).toEqual([])
      expect(world.effects('concurrent-b')).toEqual([])
      expect(world.ownAnswers).toEqual([])
      await assertChoices(world, 'concurrent-a', first.child)
      await choose(world, 'concurrent-a', 'allow_once')
      await first.activation.result
      expect(world.effects('concurrent-a')).toHaveLength(1)
      expect(world.ownAnswers).toEqual([])
    }
    await own.getByRole('radio', { name: 'PARENT_ONLY_BETA', exact: true }).click()
    await own.getByRole('radio', { name: 'PARENT_ONLY_BETA', exact: true }).press('Enter')
    await world.parent.whenIdle()
    expect(world.ownAnswers).toMatchObject([
      { answers: [{ id: 'parent-own-question', selected: ['PARENT_ONLY_BETA'] }] },
    ])
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(2)
    expect(world.page.url()).toBe(world.url)
    if (!before) {
      expect(
        acpPermissionAudit(world, 'decided')
          .map((entry) => [entry.sessionId, entry.data.optionId])
          .sort(),
      ).toEqual(
        [
          [first.child.id, 'allow_once'],
          [second.child.id, 'reject_once'],
        ].sort(),
      )
      expect(world.questions.every((entry) => entry.agentId === world.parent.id)).toBe(true)
    }
    await world.save('concurrent-completed', {
      ownAnswers: world.ownAnswers,
      firstEffects: world.effects('concurrent-a'),
      secondEffects: world.effects('concurrent-b'),
    })
  } finally {
    await finish(world, 'concurrent')
  }
}, 90_000)

it('cancels the exact child request before a late native answer returns, without replaying it', async () => {
  const world = await fixture()
  const selected = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  world.delayAnswer(async (text) => {
    if (!text.includes('External ACP marker cancelled')) return
    selected.resolve()
    await release.promise
  })
  try {
    const first = await world.spawn('cancelled')
    if (before) {
      await assertOldBoundary(world, first.activation, 'cancelled')
      await world.save('cancelled-baseline')
      return
    }
    await assertChoices(world, 'cancelled', first.child)
    await choose(world, 'cancelled', 'allow_once')
    await selected.promise
    first.child.cancel({ kind: 'user' })
    expect(world.effects('cancelled')).toEqual([])
    release.resolve()
    await first.activation.result
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(1)
    expect(acpPermissionAudit(world, 'decided')[0]).toMatchObject({
      sessionId: first.child.id,
      data: { outcome: 'cancelled' },
    })
    expect(world.effects('cancelled')).toEqual([])
    const dismissed = await world.spawn('ui-cancel')
    const dismissCard = await assertChoices(world, 'ui-cancel', dismissed.child)
    await dismissCard.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dismissed.activation.result
    expect(world.effects('ui-cancel')).toEqual([])
    expect(
      acpPermissionAudit(world, 'decided').find((entry) => entry.sessionId === dismissed.child.id)?.data.outcome,
    ).toBe('cancelled')
    const next = await world.spawn('after-cancel')
    const nextCard = await assertChoices(world, 'after-cancel', next.child)
    expect(await nextCard.locator('[role="radio"][aria-checked="true"]').count()).toBe(0)
    await world.page.reload()
    await assertChoices(world, 'after-cancel', next.child)
    await choose(world, 'after-cancel', 'allow_once')
    await next.activation.result
    expect(world.effects('cancelled')).toEqual([])
    expect(world.effects('after-cancel')).toHaveLength(1)
    expect(acpPermissionAudit(world, 'asked')).toHaveLength(3)
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(3)
    await world.save('cancelled-late-answer', {
      cancelledEffects: world.effects('cancelled'),
      nextEffects: world.effects('after-cancel'),
    })
  } finally {
    release.resolve()
    await finish(world, 'cancelled')
  }
}, 90_000)

it('presents a nested child at the true root while retaining its direct parent and execution identity', async () => {
  const world = await fixture()
  try {
    const middle = await world.spawn('middle', world.parent, true)
    expect(world.ctx.agents.isOwnedBy(middle.child.id, world.parent)).toBe(true)
    const leaf = await world.spawn('nested', middle.child)
    expect(world.ctx.agents.isOwnedBy(leaf.child.id, middle.child)).toBe(true)
    expect(world.ctx.agents.roots()).not.toContain(middle.child)
    if (before) {
      await assertOldBoundary(world, leaf.activation, 'nested')
      await world.save('nested-baseline')
      return
    }
    const card = await assertChoices(world, 'nested', leaf.child)
    const source = await card.locator('[data-question-source]').innerText()
    expect(source).toContain(middle.child.id.slice(0, 8))
    expect(source).toContain('Nested direct parent')
    expect(
      world.questions
        .filter((entry) => JSON.stringify(entry.questions).includes('External ACP marker nested'))
        .map((entry) => entry.agentId),
    ).toEqual([world.parent.id])
    await world.save('nested-source-wide')
    await saveOptions(world, 'nested', 'nested-options-wide')
    await inspectDetails(world, 'nested', [middle.child, leaf.child], 'nested')
    await saveOptions(world, 'nested', 'nested-selected-wide')
    await choose(world, 'nested', 'allow_once')
    await leaf.activation.result
    expect(world.effects('nested')).toHaveLength(1)
    expect(acpPermissionAudit(world, 'decided')[0]).toMatchObject({
      sessionId: leaf.child.id,
      data: { optionId: 'allow_once' },
    })
    expect(world.ctx.approval.overrideOf(leaf.child.session)).toBe('never')
    expect(world.ctx.approval.overrideOf(middle.child.session)).toBe('never')
    expect(world.page.url()).toBe(world.url)
    await world.save('nested-completed')
  } finally {
    await finish(world, 'nested')
  }
}, 90_000)
