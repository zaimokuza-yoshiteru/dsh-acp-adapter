import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'

const MODES = { compact: 'Compact', standard: 'Standard', detailed: 'Detailed', verbose: 'Verbose' } as const
const TIMINGS = { completion: 'On completion', 'next-input': 'On next message' } as const
type Mode = keyof typeof MODES
type Timing = keyof typeof TIMINGS
const CASES = (Object.keys(MODES) as Mode[]).flatMap((mode) =>
  (Object.keys(TIMINGS) as Timing[]).map((timing) => ({ mode, timing })),
)

describe('native work-details preferences with the ACP protocol fixture', () => {
  let host: AdapterWorld
  let browser: TestBrowser
  let page: Page
  let directory: string
  let ordinal = 0
  let errors: string[]
  let activeIds: Set<string>
  let settlements: Promise<unknown>[]
  const evidence = join(root, '.local/native-work-details')

  beforeAll(async () => {
    host = await launchAdapterWorld()
    directory = join(host.workspaceCwd, 'work-details-gates')
    mkdirSync(directory, { recursive: true })
    mkdirSync(evidence, { recursive: true })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Work-details protocol fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_WORK_DETAILS_GATE_DIR: directory,
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-codex')).toBe(true),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
  })

  beforeEach(async () => {
    page = await newEnglishPage(browser)
    errors = []
    activeIds = new Set()
    settlements = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    if (ordinal++ === 0) await connectFreshWorkspace(page, host.workspaceCwd, 'work-details')
    else {
      await page.locator('[data-composer-input]').first().waitFor()
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    }
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state !== 'pass' || errors.length > 0) {
        await page.screenshot({ path: join(evidence, `failure-${ordinal}.png`), fullPage: true })
        writeFileSync(join(evidence, `failure-${ordinal}.txt`), await page.locator('body').innerText())
      }
      expect(errors).toEqual([])
    } finally {
      for (const id of activeIds) {
        writeFileSync(join(directory, `${id}-output`), 'cleanup')
        writeFileSync(join(directory, `${id}-finish`), 'cleanup')
      }
      await Promise.allSettled(settlements)
      await page.close()
    }
  })

  afterAll(async () => {
    const results = await Promise.allSettled([browser?.close(), host?.close()])
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Work-details fixture cleanup failed')
  })

  async function preferences(mode: Mode, timing?: Timing) {
    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    for (const [title, label] of [
      ['Work details', MODES[mode]],
      ...(timing === undefined ? [] : [['When to Collapse Work Details', TIMINGS[timing]]]),
    ]) {
      const row = dialog.getByText(title!, { exact: true }).locator('xpath=../..')
      await row.getByRole('button').click()
      await page.getByRole('menuitem', { name: label!, exact: true }).click()
      await expect.poll(() => row.getByRole('button').innerText()).toBe(label)
    }
    await expect
      .poll(() => host.ctx.settings.describe().find((entry) => entry.ns === 'ui-chat')?.value)
      .toMatchObject({ transcriptView: mode, ...(timing === undefined ? {} : { collapseTiming: timing }) })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }

  async function send(text: string) {
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
    const button = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => button.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(45_000)
    settlements.push(settled)
    void settled.catch(() => {})
    await button.click()
    return { settled }
  }

  const gate = (id: string, phase: string) => join(directory, `${id}-${phase}`)

  async function verifyFlowGeometry(id: string, phase: string) {
    const measure = () =>
      page.evaluate(() => {
        const violations: unknown[] = []
        const gaps: unknown[] = []
        const visible = (element: HTMLElement) =>
          !element.closest('[hidden]') &&
          element.getBoundingClientRect().height > 0 &&
          getComputedStyle(element).visibility !== 'hidden'
        const number = (value: string) => Number.parseFloat(value) || 0
        const boxes = (element: HTMLElement): HTMLElement[] =>
          getComputedStyle(element).display === 'contents'
            ? [...element.children].flatMap((child) => boxes(child as HTMLElement))
            : [element]
        const column = document.querySelector<HTMLElement>('[data-chat-flow]:not([data-step-process-content])')
        const flowAnchor = column?.querySelector<HTMLElement>(':scope > [data-slot]')
        if (flowAnchor?.dataset.slot !== 'conversation.chat.flow')
          violations.push({ kind: 'native-flow-style-address', slot: flowAnchor?.dataset.slot })
        for (const seat of document.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')) {
          const anchor = seat.querySelector<HTMLElement>(':scope > [data-slot]')
          if (anchor !== null && anchor.dataset.slot !== 'conversation.chat.node')
            violations.push({ kind: 'native-node-style-address', slot: anchor.dataset.slot })
        }
        for (const group of document.querySelectorAll<HTMLElement>('[data-step-process]')) {
          const content = group.querySelector<HTMLElement>('[data-step-process-content]')
          if (visible(group) && content?.textContent?.trim() === '' && !content.querySelector('img, svg, canvas'))
            violations.push({ kind: 'empty-process-group', key: group.dataset.chatGroupKey })
        }
        for (const flow of document.querySelectorAll<HTMLElement>('[data-chat-flow]')) {
          const children = [...flow.children].flatMap((child) => boxes(child as HTMLElement))
          for (const child of children) {
            if (child.dataset.chatFlowKind !== 'acp-activity' || child.textContent?.trim() !== '') continue
            const style = getComputedStyle(child)
            if (!child.closest('[hidden]') && (child.getBoundingClientRect().height > 0 || number(style.marginTop) > 0))
              violations.push({ kind: 'empty-acp-marker', key: child.dataset.chatNodeKey })
          }
          const rows = children.filter(visible)
          for (let index = 1; index < rows.length; index++) {
            const before = rows[index - 1]!
            const after = rows[index]!
            const actual = after.getBoundingClientRect().top - before.getBoundingClientRect().bottom
            const native =
              number(getComputedStyle(after).marginTop) +
              number(getComputedStyle(before).marginBottom) +
              number(getComputedStyle(flow).rowGap)
            const gap = { before: before.dataset.chatFlowKey, after: after.dataset.chatFlowKey, actual, native }
            gaps.push(gap)
            // Allow rounding, while deriving all intended spacing from the native rows themselves.
            if (actual > native + 2) violations.push({ kind: 'unowned-flow-gap', ...gap })
            if (before.dataset.chatFlowKey && after.dataset.chatFlowKey && actual <= 0)
              violations.push({ kind: 'missing-native-flow-gap', ...gap })
          }
        }
        for (const hidden of document.querySelectorAll<HTMLElement>(
          '[data-step-process][hidden], [data-chat-flow-kind][hidden]',
        )) {
          if (hidden.getBoundingClientRect().height > 0)
            violations.push({ kind: 'collapsed-placeholder', key: hidden.dataset.chatFlowKey })
        }
        return { violations, gaps }
      })
    await expect.poll(async () => (await measure()).violations).toEqual([])
    writeFileSync(join(evidence, `${id}-${phase}-geometry.json`), JSON.stringify(await measure(), null, 2))
  }

  async function running(id: string) {
    activeIds.add(id)
    const turn = await send(`E2E_WORK_DETAILS ${id}`)
    await expect.poll(() => existsSync(gate(id, 'ready'))).toBe(true)
    expect(await page.locator('[data-chat-call-id]').count()).toBe(0)
    expect(
      await page
        .locator('[data-chat-flow-kind="acp-inline-activity"] li')
        .filter({ hasText: `E2E_PREF_PLAN ${id}` })
        .count(),
    ).toBe(0)
    expect(await page.getByText(`E2E_PREF_DONE ${id}`, { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor()
    await verifyFlowGeometry(id, 'initial')
    writeFileSync(gate(id, 'output'), 'output')
    await expect.poll(() => existsSync(gate(id, 'streaming'))).toBe(true)
    const plan = page.locator('[data-chat-flow-kind="acp-inline-activity"]').filter({
      has: page.getByRole('button', { name: 'Updated plan', exact: true, includeHidden: true }),
    })
    await expect.poll(() => plan.count()).toBe(1)
    const group = page.locator('[data-step-process]').filter({ has: plan })
    await expect.poll(() => group.count()).toBe(1)
    const turnNumber = await group.getAttribute('data-chat-turn')
    expect(turnNumber).toMatch(/^\d+$/)
    return {
      ...turn,
      plan,
      planButton: plan.getByRole('button', { name: 'Updated plan', exact: true, includeHidden: true }),
      group,
      header: group.locator('[data-process-activity]'),
      body: group.locator('[data-step-process-body]'),
      control: page.locator(`[data-turn-process="${turnNumber}"]`),
    }
  }

  async function openGroup(header: Locator) {
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
    await expect.poll(() => header.getAttribute('aria-expanded')).toBe('true')
  }

  async function verifyOrder(id: string, final = false) {
    const reasoning = page.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="reasoning"]')
    await expect.poll(() => reasoning.count()).toBe(2)
    const ordered = [
      reasoning.first(),
      page.locator('[data-chat-call-id$=":tool:work-details-setup"]'),
      page.getByText(`E2E_PREF_PROGRESS ${id}`, { exact: true }),
      page.locator('[data-chat-flow-kind="acp-inline-activity"]').getByRole('button', {
        name: 'Updated plan',
        exact: true,
        includeHidden: true,
      }),
      reasoning.last(),
      page.locator('[data-chat-call-id$=":tool:work-details-tool"]'),
      ...(final ? [page.getByText(`E2E_PREF_DONE ${id}`, { exact: true })] : []),
    ]
    await expect
      .poll(async () => {
        const handles = await Promise.all(ordered.map((item) => item.elementHandle()))
        return page.evaluate(
          (elements) =>
            elements.every((element, index) => {
              if (element === null) return false
              if (index === 0) return true
              const before = elements[index - 1]!
              if (!(before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) return false
              if (before.closest('[hidden]') || element.closest('[hidden]')) return true
              const previousBox = before.getBoundingClientRect()
              const box = element.getBoundingClientRect()
              return previousBox.height === 0 || box.height === 0 || box.top >= previousBox.bottom - 2
            }),
          handles,
        )
      })
      .toBe(true)
  }

  async function verifyPlanGeometry(plan: Locator, id: string, theme: string) {
    const measure = () =>
      plan
        .locator('li')
        .first()
        .evaluate((item) => {
          const glyph = item.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')
          const content = glyph?.nextElementSibling as HTMLElement | null | undefined
          const text = content?.firstElementChild
          const status = content?.lastElementChild
          if (glyph === null || content == null || text == null || status == null)
            return { violations: ['missing-plan-layout'], rows: null }
          const glyphBox = glyph.getBoundingClientRect()
          const contentBox = content.getBoundingClientRect()
          const statusBox = status.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(text)
          const fragments = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0)
          const lines: Array<{ left: number; right: number; top: number; height: number }> = []
          // Preserved whitespace can add a second Range fragment at the end of one visual line.
          for (const fragment of fragments) {
            const line = lines.find(
              (line) => Math.abs(line.top - fragment.top) <= 1 && Math.abs(line.height - fragment.height) <= 1,
            )
            if (line === undefined)
              lines.push({ left: fragment.left, right: fragment.right, top: fragment.top, height: fragment.height })
            else {
              line.left = Math.min(line.left, fragment.left)
              line.right = Math.max(line.right, fragment.right)
            }
          }
          const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          const words: Array<{ text: string; boxes: ReturnType<typeof box>[] }> = []
          const textNode = text.firstChild
          if (textNode?.nodeType === Node.TEXT_NODE) {
            for (const match of textNode.textContent!.matchAll(/\S+/gu)) {
              range.setStart(textNode, match.index)
              range.setEnd(textNode, match.index + match[0].length)
              words.push({ text: match[0], boxes: [...range.getClientRects()].map(box) })
            }
          }
          const nativeGap = Number.parseFloat(getComputedStyle(item).columnGap)
          const actualGap = contentBox.left - glyphBox.right
          const violations: string[] = []
          if (getComputedStyle(item).listStyleType !== 'none' || glyph.querySelectorAll('[data-state]').length !== 1)
            violations.push('duplicate-plan-marker')
          if (!(actualGap > 0) || Math.abs(actualGap - nativeGap) > 2) violations.push('missing-plan-glyph-gap')
          if (lines.length < 2) violations.push('plan-did-not-wrap')
          if (lines.some((line) => Math.abs(line.left - contentBox.left) > 2)) violations.push('misaligned-plan-wrap')
          if (
            fragments.some((fragment) => fragment.left < contentBox.left - 2 || fragment.right > contentBox.right + 2)
          )
            violations.push('plan-fragment-overflow')
          if (getComputedStyle(status).whiteSpace !== 'nowrap' || statusBox.right > contentBox.right + 2)
            violations.push('plan-status-overflow')
          return {
            violations,
            rows: {
              glyph: box(glyphBox),
              content: box(contentBox),
              status: box(statusBox),
              lines: lines.map((line) => ({
                x: line.left,
                y: line.top,
                width: line.right - line.left,
                height: line.height,
              })),
              fragments: fragments.map(box),
              words,
              text: text.textContent,
              whiteSpace: getComputedStyle(content).whiteSpace,
              fragmentOffsets: fragments.map((fragment) => ({
                left: fragment.left - contentBox.left,
                rightOverflow: fragment.right - contentBox.right,
              })),
              actualGap,
              nativeGap,
            },
          }
        })
    let latest: Awaited<ReturnType<typeof measure>> | undefined
    try {
      await expect
        .poll(async () => {
          latest = await measure()
          return latest.violations
        })
        .toEqual([])
    } finally {
      writeFileSync(
        join(evidence, `${id}-390-${theme}-plan-geometry.json`),
        JSON.stringify(latest ?? { error: 'Plan measurement unavailable' }, null, 2),
      )
      await page.screenshot({ path: join(evidence, `${id}-390-${theme}-plan.png`), animations: 'disabled' })
    }
  }

  it.each(CASES)(
    'honors $mode / $timing initially, while streaming, at completion and on the next input',
    async ({ mode, timing }) => {
      const id = `${mode}-${timing}`
      await preferences(mode, timing)
      const current = await running(id)
      const flat = mode === 'detailed' || mode === 'verbose'
      await expect.poll(() => current.group.getAttribute('data-group-expanded-mode')).toBe(flat ? 'true' : null)
      await expect.poll(() => current.body.getAttribute('hidden')).toBe(flat ? null : 'until-found')
      await expect.poll(() => current.header.isVisible()).toBe(!flat)
      if (!flat) {
        await expect
          .poll(async () => (await current.header.innerText()).includes(`E2E_PREF_TOOL_${id}`))
          .toBe(mode === 'standard')
        await openGroup(current.header)
      }
      await current.planButton.click()
      await expect.poll(() => current.planButton.getAttribute('aria-expanded')).toBe('true')
      const planEntry = current.plan.locator('li').filter({ hasText: `E2E_PREF_PLAN ${id}` })
      await planEntry.waitFor()
      await page.getByText(`E2E_PREF_PROGRESS ${id}`, { exact: true }).waitFor()
      await verifyOrder(id)
      await verifyFlowGeometry(id, 'streaming')
      await page.screenshot({ path: join(evidence, `${id}-streaming.png`) })
      // Move focus out of the process so native focus protection need not keep it open.
      await page.locator('[data-composer-input]').first().focus()
      writeFileSync(gate(id, 'finish'), 'finish')
      await current.settled
      await page.getByText(`E2E_PREF_DONE ${id}`, { exact: true }).waitFor()
      await verifyOrder(id, true)
      const remainsOpen = mode === 'verbose' || timing === 'next-input'
      await expect.poll(() => current.control.getAttribute('data-open')).toBe(remainsOpen ? 'true' : null)
      await expect.poll(() => current.planButton.getAttribute('aria-expanded')).toBe(remainsOpen ? 'true' : 'false')
      if (mode === 'detailed') {
        await expect
          .poll(() => current.group.getAttribute('data-group-expanded-mode'))
          .toBe(timing === 'next-input' ? 'true' : null)
      }
      // Native fold state and disclosure resets precede the shared frame-clock hidden commit.
      await expect.poll(() => page.getByText(`E2E_PREF_PROGRESS ${id}`, { exact: true }).isVisible()).toBe(remainsOpen)
      await verifyFlowGeometry(id, 'completed')
      await page.screenshot({ path: join(evidence, `${id}-completed.png`) })
      const next = await send(`E2E_WORK_DETAILS_NEXT ${id}`)
      await next.settled
      await page.getByText(`E2E_PREF_NEXT ${id}`, { exact: true }).waitFor()
      await expect.poll(() => current.control.getAttribute('data-open')).toBe(mode === 'verbose' ? 'true' : null)
      await expect.poll(() => page.getByText(`E2E_PREF_DONE ${id}`, { exact: true }).isVisible()).toBe(true)
      await expect
        .poll(() => current.planButton.getAttribute('aria-expanded'))
        .toBe(mode === 'verbose' ? 'true' : 'false')
      await expect
        .poll(() => page.getByText(`E2E_PREF_PROGRESS ${id}`, { exact: true }).isVisible())
        .toBe(mode === 'verbose')
      await verifyFlowGeometry(id, 'folded-after-next-input')
      if (mode === 'verbose') expect(await current.control.isDisabled()).toBe(true)
      else {
        await current.control.click()
        await openGroup(current.header)
        expect(await current.planButton.getAttribute('aria-expanded')).toBe('false')
        expect(await planEntry.count()).toBe(0)
      }
      await page.screenshot({ path: join(evidence, `${id}-next-input.png`) })
    },
  )

  it('preserves manual ACP disclosure across all modes and resets it only when the outer process hides', async () => {
    const id = 'switch-modes'
    await preferences('standard', 'next-input')
    const current = await running(id)
    await openGroup(current.header)
    await current.planButton.click()
    const originalButton = await current.planButton.elementHandle()
    expect(originalButton).not.toBeNull()
    for (const mode of ['detailed', 'verbose', 'compact', 'standard'] as const) {
      await preferences(mode)
      expect(await originalButton!.evaluate((button) => button.isConnected)).toBe(true)
      expect(await current.planButton.getAttribute('aria-expanded')).toBe('true')
      expect(await current.header.getAttribute('aria-expanded')).toBe('true')
    }
    await page.locator('[data-composer-input]').first().focus()
    writeFileSync(gate(id, 'finish'), 'finish')
    await current.settled
    await expect.poll(() => current.control.getAttribute('data-open')).toBe('true')
    expect(await current.planButton.getAttribute('aria-expanded')).toBe('true')
    // Reload restores the latest-exchange exemption and Host preferences, with fresh local disclosures.
    await page.reload()
    await page.getByText(`E2E_PREF_DONE ${id}`, { exact: true }).waitFor()
    await expect.poll(() => current.control.getAttribute('data-open')).toBe('true')
    await openGroup(current.header)
    expect(await current.planButton.getAttribute('aria-expanded')).toBe('false')
    await current.planButton.click()
    await preferences('standard', 'completion')
    await expect.poll(() => current.control.getAttribute('data-open')).toBe(null)
    await expect.poll(() => current.group.getAttribute('hidden')).toBe('until-found')
    await current.control.click()
    await openGroup(current.header)
    expect(await current.planButton.getAttribute('aria-expanded')).toBe('false')
    await current.planButton.click()
    await current.control.click()
    await expect.poll(() => current.group.getAttribute('hidden')).toBe('until-found')
    await current.control.click()
    await openGroup(current.header)
    expect(await current.planButton.getAttribute('aria-expanded')).toBe('false')
    await current.planButton.click()
    const originalViewport = page.viewportSize()
    const originalTheme = host.ctx.settings.describe().find((entry) => entry.ns === 'ui-theme')?.value
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      for (const theme of ['light', 'dark'] as const) {
        await host.ctx.settings.replace('ui-theme', { preference: theme })
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
        await current.planButton.scrollIntoViewIfNeeded()
        const controls = {
          turn: await current.control.boundingBox(),
          group: await current.header.boundingBox(),
          plan: await current.planButton.boundingBox(),
          answer: await page.getByText(`E2E_PREF_DONE ${id}`, { exact: true }).boundingBox(),
        }
        const viewport = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          colorScheme: document.documentElement.style.colorScheme,
        }))
        for (const box of Object.values(controls)) {
          expect(box).not.toBeNull()
          expect(box!.width).toBeGreaterThan(0)
          expect(box!.height).toBeGreaterThan(0)
          expect(box!.x).toBeGreaterThanOrEqual(-2)
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 2)
        }
        await verifyPlanGeometry(current.plan, id, theme)
        await verifyFlowGeometry(id, `390-${theme}`)
        writeFileSync(join(evidence, `${id}-390-${theme}-bounds.json`), JSON.stringify({ viewport, controls }, null, 2))
        await page.screenshot({ path: join(evidence, `${id}-390-${theme}.png`), animations: 'disabled' })
      }
    } finally {
      if (originalViewport !== null) await page.setViewportSize(originalViewport)
      await host.ctx.settings.replace('ui-theme', originalTheme ?? {})
    }
  })
})
