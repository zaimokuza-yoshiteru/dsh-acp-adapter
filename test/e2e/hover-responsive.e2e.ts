import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { openAcpPluginDetail, returnToConversation } from './plugin-panel.helpers.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

type StyleProperty = 'backgroundColor' | 'color'
type HoverEvidence = {
  input: string
  theme: string
  control: string
  property: StyleProperty
  before: string
  after: string
}

async function style(target: Locator, property: StyleProperty): Promise<string> {
  return target.evaluate((element, property) => getComputedStyle(element)[property], property)
}

/** Exercise the browser's real :hover matching in both input-capability contexts. */
async function checkHover(
  page: Page,
  target: Locator,
  hoverCapable: boolean,
  property: StyleProperty,
  evidence: HoverEvidence[],
  theme: string,
  control: string,
): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  const before = await style(target, property)
  await target.hover()
  if (hoverCapable) await expect.poll(() => style(target, property)).not.toBe(before)
  else await expect.poll(() => style(target, property)).toBe(before)
  evidence.push({
    input: hoverCapable ? 'mouse' : 'touch',
    theme,
    control,
    property,
    before,
    after: await style(target, property),
  })
  await page.mouse.move(0, 0)
  await expect.poll(() => style(target, property)).toBe(before)
}

async function checkKeyboardFocus(page: Page, target: Locator): Promise<void> {
  await target.focus()
  // Return through actual keyboard navigation so :focus-visible is evaluated
  // independently of the preceding mouse/touch interaction.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  expect(
    await target.evaluate((element) => element === document.activeElement && element.matches(':focus-visible')),
  ).toBe(true)
  expect(await target.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none')
}

/** Every visible toolbar control must fit and own its hit target before tapping. */
async function checkToolbarBounds(toolbar: Locator): Promise<void> {
  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const parent = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll<HTMLElement>('button, input')].map((control) => ({
          control,
          name: control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName,
          rect: control.getBoundingClientRect(),
        }))
        const failures: string[] = []
        if (controls.length !== 6) failures.push(`Expected all six controls, found ${controls.length}`)
        for (const [index, { control, name, rect }] of controls.entries()) {
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.left < Math.max(0, parent.left) - 0.5 ||
            rect.right > Math.min(innerWidth, parent.right) + 0.5 ||
            rect.top < Math.max(0, parent.top) - 0.5 ||
            rect.bottom > Math.min(innerHeight, parent.bottom) + 0.5
          )
            failures.push(`${name} extends outside the visible toolbar`)
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          if (hit === null || !control.contains(hit)) failures.push(`${name} has an intercepted hit target`)
          for (const other of controls.slice(index + 1)) {
            if (
              Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 0.5 &&
              Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 0.5
            )
              failures.push(`${name} overlaps ${other.name}`)
          }
        }
        return failures
      }),
    )
    .toEqual([])
}

// The Electron helper does not emulate touch hardware. Chromium's hasTouch
// context is required; a narrow desktop window is not touch-input coverage.
it.skipIf(Boolean(process.env.DSH_E2E_ELECTRON))(
  'preserves selected and keyboard states while limiting ACP hover feedback to hover-capable devices',
  async () => {
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    const directory = join(process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/e2e-evidence'), 'hover')
    mkdirSync(directory, { recursive: true })
    const agentLog = join(host.workspaceCwd, 'hover-agent.log')
    const promptCount = (): number =>
      existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('--> session/prompt ').length - 1 : 0
    const errors: string[] = []
    const evidence: HoverEvidence[] = []
    let completed = false
    let activePage: Page | undefined
    let stage = 'setup'
    try {
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'ask',
        agents: {
          codex: {
            name: 'Hover fixture',
            command: process.execPath,
            args: [join(root, 'test/mock-agent/mock-agent.ts')],
            env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'codex', MOCK_LOG: agentLog },
          },
        },
      })
      await expect.poll(() => host.ctx.llm.listProviders().some((route) => route.id === 'acp-codex')).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
      browser = await launchBrowser({
        headless: true,
        ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
      })
      const desktop = await newEnglishPage(browser)
      activePage = desktop
      desktop.on('pageerror', (error) => errors.push(error.message))
      await desktop.goto(host.authenticatedUrl)
      await connectFreshWorkspace(desktop, host.workspaceCwd)
      const sessionId = required(
        await desktop.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session'),
      )
      const input = desktop.locator('[data-composer-input][contenteditable="true"]:visible').first()
      await writeComposerDraft(desktop, input, 'E2E_MESSAGE')
      const settled = host.whenTurnSettled(30_000)
      await desktop.getByRole('button', { name: 'Send message', exact: true }).click()
      expect(await settled).toBe(sessionId)
      await desktop.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
      expect(promptCount()).toBe(1)

      const touch = await browser.newPage({
        viewport: { width: 1680, height: 1000 },
        locale: 'en-US',
        timezoneId: 'Asia/Shanghai',
        hasTouch: true,
        isMobile: true,
      })
      activePage = touch
      touch.on('pageerror', (error) => errors.push(error.message))
      await touch.goto(host.authenticatedUrl)
      await returnToConversation(touch, sessionId)
      await touch.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()

      for (const [page, hoverCapable] of [
        [desktop, true],
        [touch, false],
      ] as const) {
        activePage = page
        await page.setViewportSize({ width: hoverCapable ? 1680 : 390, height: hoverCapable ? 1000 : 844 })
        expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(hoverCapable)
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(!hoverCapable)
        const activate = async (target: Locator): Promise<void> => {
          if (hoverCapable) await target.click()
          else await target.tap()
        }
        const selectView = async (name: string): Promise<void> => {
          const tab = page.getByRole('tab', { name, exact: true })
          if (await tab.isVisible()) await activate(tab)
          else {
            await activate(page.getByRole('button', { name: 'More conversation views', exact: true }))
            await activate(page.getByRole('menuitem', { name, exact: true }))
          }
        }
        for (const theme of ['light', 'dark'] as const) {
          stage = `${hoverCapable ? 'mouse' : 'touch'} ${theme}: session control`
          await host.ctx.settings.replace('ui-theme', { preference: theme })
          await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
          await returnToConversation(page, sessionId)
          await selectView('Chat')
          const control = page.getByRole('button', { name: /^Session · / })
          await checkHover(page, control, hoverCapable, 'backgroundColor', evidence, theme, 'session trigger')
          await checkKeyboardFocus(page, control)
          const triggerBackground = await style(control, 'backgroundColor')
          await activate(control)
          await page.getByRole('menu').waitFor({ state: 'visible' })
          expect(await control.getAttribute('aria-expanded')).toBe('true')
          if (!hoverCapable) expect(await style(control, 'backgroundColor')).toBe(triggerBackground)
          await page.keyboard.press('Escape')

          stage = `${hoverCapable ? 'mouse' : 'touch'} ${theme}: diagnostics`
          await selectView('ACP Diagnostics')
          const diagnostics = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
          const operations = diagnostics.getByRole('button', { name: 'Operations', exact: true })
          const issues = diagnostics.getByRole('button', { name: 'Issues', exact: true })
          if (!hoverCapable)
            await checkToolbarBounds(diagnostics.getByRole('toolbar', { name: 'ACP Diagnostics', exact: true }))
          await activate(issues)
          await checkHover(page, operations, hoverCapable, 'backgroundColor', evidence, theme, 'diagnostic filter')
          const inactive = await style(operations, 'backgroundColor')
          await activate(operations)
          expect(await operations.getAttribute('aria-pressed')).toBe('true')
          await page.mouse.move(0, 0)
          expect(await style(operations, 'backgroundColor')).not.toBe(inactive)
          await checkKeyboardFocus(page, operations)
          // A plain prompt records binding/restore facts, not file or permission
          // operations. Exercise the same row styles with those real facts.
          await activate(diagnostics.getByRole('button', { name: 'Technical records', exact: true }))
          const row = diagnostics
            .getByRole('table', { name: 'ACP diagnostic records', exact: true })
            .locator('tbody tr')
            .first()
          await row.waitFor({ state: 'visible' })
          if (!hoverCapable)
            await page.screenshot({
              path: join(directory, `touch-390-diagnostics-list-${theme}.png`),
              animations: 'disabled',
            })
          await checkHover(page, row, hoverCapable, 'backgroundColor', evidence, theme, 'diagnostic row')
          const unselected = await style(row, 'backgroundColor')
          await activate(row)
          expect(await row.getAttribute('aria-selected')).toBe('true')
          await page.mouse.move(0, 0)
          expect(await style(row, 'backgroundColor')).not.toBe(unselected)
          const close = diagnostics.getByRole('button', { name: 'Close', exact: true })
          await checkHover(page, close, hoverCapable, 'backgroundColor', evidence, theme, 'diagnostic close background')
          await checkHover(page, close, hoverCapable, 'color', evidence, theme, 'diagnostic close color')
          await checkKeyboardFocus(page, close)
          if (!hoverCapable)
            await page.screenshot({
              path: join(directory, `touch-390-diagnostics-${theme}.png`),
              animations: 'disabled',
            })
          await activate(close)
          expect(await row.getAttribute('aria-selected')).toBe('false')
          if (!hoverCapable) expect(await style(row, 'backgroundColor')).toBe(unselected)

          stage = `${hoverCapable ? 'mouse' : 'touch'} ${theme}: plugin settings`
          const detail = await openAcpPluginDetail(page)
          const panel = detail.locator('[data-dsh-acp-panel]')
          const add = panel.getByRole('button', { name: 'Add Agent', exact: true })
          const approval = panel.getByRole('button', { name: 'Default DSH tool approval', exact: true })
          if (!hoverCapable)
            await page.screenshot({
              path: join(directory, `touch-390-settings-top-${theme}.png`),
              animations: 'disabled',
            })
          for (const [target, label] of [
            [add, 'add agent'],
            [approval, 'default approval'],
          ] as const) {
            await checkHover(page, target, hoverCapable, 'backgroundColor', evidence, theme, label)
            await checkKeyboardFocus(page, target)
            const background = await style(target, 'backgroundColor')
            await activate(target)
            await page.getByRole('menu').waitFor({ state: 'visible' })
            if (!hoverCapable) expect(await style(target, 'backgroundColor')).toBe(background)
            await page.keyboard.press('Escape')
          }
          const card = panel.locator('[data-dsh-acp-agent="codex"]')
          const remove = card.getByRole('button', { name: 'Delete', exact: true }).first()
          await checkHover(page, remove, hoverCapable, 'backgroundColor', evidence, theme, 'delete agent')
          const removeBackground = await style(remove, 'backgroundColor')
          await activate(remove)
          await card.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
          if (!hoverCapable) {
            // Native ghost buttons retain pressed feedback briefly after touchend.
            // Check the resting state after :active ends, independently of hover.
            await expect.poll(() => remove.evaluate((element) => element.matches(':active'))).toBe(false)
            await expect.poll(() => style(remove, 'backgroundColor')).toBe(removeBackground)
          }
          await activate(card.getByRole('button', { name: 'Cancel', exact: true }))
          expect(await card.count()).toBe(1)
          await activate(card.getByRole('button', { name: 'Edit', exact: true }))
          const advanced = card.getByRole('button', { name: 'Connection settings', exact: true })
          await checkHover(page, advanced, hoverCapable, 'color', evidence, theme, 'connection settings')
          await checkKeyboardFocus(page, advanced)
          const expanded = await advanced.getAttribute('aria-expanded')
          const color = await style(advanced, 'color')
          await activate(advanced)
          expect(await advanced.getAttribute('aria-expanded')).toBe(expanded === 'true' ? 'false' : 'true')
          if (!hoverCapable) expect(await style(advanced, 'color')).toBe(color)
          if (!hoverCapable)
            await page.screenshot({ path: join(directory, `touch-390-settings-${theme}.png`), animations: 'disabled' })
          await activate(card.getByRole('button', { name: 'Cancel', exact: true }))
        }
      }
      expect(promptCount()).toBe(1)
      expect(errors).toEqual([])
      completed = true
    } catch (error) {
      if (activePage !== undefined) {
        await activePage.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {})
        writeFileSync(
          join(directory, 'failure.txt'),
          `${stage}\n${String(error)}\n${await activePage
            .locator('body')
            .innerText()
            .catch(() => '(page unavailable)')}`,
        )
      }
      throw error
    } finally {
      writeFileSync(
        join(directory, 'result.json'),
        JSON.stringify(
          {
            completed,
            stage,
            scope:
              'Keyless Chromium: one local mock ACP prompt; desktop hover and 390px touch in light/dark; no Agent deletion or settings save; Electron touch not claimed.',
            promptCount: promptCount(),
            errors,
            evidence,
          },
          null,
          2,
        ),
      )
      await browser?.close()
      await host.close()
    }
  },
  180_000,
)
