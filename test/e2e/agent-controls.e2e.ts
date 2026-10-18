import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import type { AcpRemoteService } from '../../src/remote/service.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

// These use the real host and plugin UI. Only the ACP peer is deterministic/keyless.
const profiles = ['kimi', 'devin', 'codex', 'claude', 'codebuddy'] as const

describe.each(profiles)('Agent controls: %s', (profile) => {
  it.each(['response', 'deferred'])(
    'shows %s options during the first turn, follows changes and unlocks on stop',
    async (delivery) => {
      const host = await launchAdapterWorld()
      let browser!: TestBrowser
      let page!: Page
      const errors: string[] = []
      const consoleMessages: { type: string; text: string }[] = []
      let phase = 'setup'
      const readyFile = join(host.workspaceCwd, 'controls-ready')
      const provider = `acp-${profile}`
      try {
        const agentSettings = {
          agents: {
            [profile]: {
              name: `Fixture ${profile}`,
              command: process.execPath,
              args: [join(root, 'test/mock-agent/mock-agent.ts')],
              runtime: profile,
              env: {
                HOME: host.workspaceCwd,
                MOCK_SCENARIO: 'regression',
                MOCK_PROFILE: profile,
                MOCK_CONTROLS_DELIVERY: delivery,
                MOCK_CONTROLS_READY_FILE: readyFile,
              },
            },
          },
        }
        await host.ctx.settings.replace('dsh-acp-adapter', { ...agentSettings, toolApprovalDefault: 'auto' })
        await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true))
        await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
        let failInitialPolicyRead = profile === 'codex' && delivery === 'response'
        let failNextPolicyWrite = false
        let failNextOptionWrite = false
        if (profile === 'codex' && delivery === 'response') {
          const service = host.ctx.get('dshAcp') as AcpRemoteService
          const follow = service.toolApprovalPolicyFollow.bind(service)
          vi.spyOn(service, 'toolApprovalPolicyFollow').mockImplementation(async function* (sessionId, signal) {
            if (failInitialPolicyRead) {
              failInitialPolicyRead = false
              throw new Error('test policy read failure')
            }
            yield* follow(sessionId, signal)
          })
          const write = service.setToolApprovalPolicy.bind(service)
          vi.spyOn(service, 'setToolApprovalPolicy').mockImplementation(async (sessionId, request) => {
            if (failNextPolicyWrite) {
              failNextPolicyWrite = false
              throw new Error('test policy write failure')
            }
            return await write(sessionId, request)
          })
          const writeOption = service.setAgentSessionOption.bind(service)
          vi.spyOn(service, 'setAgentSessionOption').mockImplementation(async (sessionId, request) => {
            if (failNextOptionWrite) {
              failNextOptionWrite = false
              throw new Error('test session option write failure')
            }
            return await writeOption(sessionId, request)
          })
        }
        browser = await launchBrowser({
          headless: true,
          ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
        })
        page = await newEnglishPage(browser)
        await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => {
          if (['warning', 'error'].includes(message.type()))
            consoleMessages.push({ type: message.type(), text: message.text() })
        })
        page.setDefaultTimeout(10000)
        await page.goto(host.authenticatedUrl)
        await connectFreshWorkspace(page, host.workspaceCwd)
        // DSH policy exists in the host-owned menu before an ACP prompt creates
        // Agent configOptions or a live ACP controls snapshot.
        if (profile === 'codex' && delivery === 'response') {
          const retryPolicyRead = page.getByRole('button', {
            name: 'Could not read DSH tool approval settings. Please retry.',
            exact: true,
          })
          await retryPolicyRead.waitFor()
          expect(await page.getByRole('alert').count()).toBe(0)
          const directory = join(root, '.local/ui-review')
          mkdirSync(directory, { recursive: true })
          await page.screenshot({ path: join(directory, 'tool-approval-read-error.png') })
          await page.setViewportSize({ width: 420, height: 900 })
          await page.screenshot({ path: join(directory, 'tool-approval-read-error-narrow.png') })
          await page.setViewportSize({ width: 1280, height: 900 })
          await retryPolicyRead.click()
        }
        const policyMenu = page.getByRole('button', { name: 'DSH tool approval', exact: true })
        await policyMenu.waitFor()
        await policyMenu.click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        const autoPolicy = page.getByRole('menuitem', { name: /^Auto approve/ })
        await autoPolicy.waitFor()
        expect(await autoPolicy.locator('svg').count()).toBe(1)
        // A policy read initializes this session's value. Changing the plugin
        // default afterward must leave the open session on its saved Auto value.
        await host.ctx.settings.replace('dsh-acp-adapter', { ...agentSettings, toolApprovalDefault: 'ask' })
        await policyMenu.waitFor()
        await policyMenu.click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        await expect
          .poll(() =>
            page
              .getByRole('menuitem', { name: /^Auto approve/ })
              .locator('svg')
              .count(),
          )
          .toBe(1)
        if (profile === 'codex' && delivery === 'response') {
          const directory = join(root, '.local/ui-review')
          mkdirSync(directory, { recursive: true })
          await page.screenshot({ path: join(directory, 'tool-approval-before-prompt.png') })
        }
        await autoPolicy.click()
        await expect.poll(() => policyMenu.getAttribute('aria-expanded')).toBe('false')
        await policyMenu.click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        await expect.poll(() => page.getByRole('menuitem', { name: /^Ask each time/ }).count()).toBe(1)
        if (profile === 'codex' && delivery === 'response') {
          const directory = join(root, '.local/ui-review')
          await page.screenshot({ path: join(directory, 'tool-approval-session-override.png') })
        }
        await page.getByRole('menuitem', { name: /^Ask each time/ }).click()
        if (profile === 'codex' && delivery === 'response') {
          await policyMenu.click()
          await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
          failNextPolicyWrite = true
          await page.getByRole('menuitem', { name: /^Auto approve/ }).click()
          // The failed selection must announce while the menu remains closed.
          await expect.poll(() => policyMenu.getAttribute('aria-expanded')).toBe('false')
          const policyFailureToast = page
            .getByRole('alert')
            .getByText('Could not save the DSH tool approval setting. Please retry.', { exact: true })
          await policyFailureToast.waitFor()
          expect(await page.getByRole('menuitem').count()).toBe(0)
          const directory = join(root, '.local/ui-review')
          await page.screenshot({ path: join(directory, 'tool-approval-write-error-closed-menu.png') })
          await page.getByRole('button', { name: 'DSH tool approval', exact: true }).waitFor()
          await page.getByRole('button', { name: 'DSH tool approval', exact: true }).click()
          await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
          await page
            .getByRole('menu')
            .getByText('Could not save the DSH tool approval setting. Please retry.', { exact: true })
            .waitFor()
          await page.screenshot({ path: join(directory, 'tool-approval-write-error.png') })
          await page.setViewportSize({ width: 420, height: 900 })
          await page.screenshot({ path: join(directory, 'tool-approval-write-error-narrow.png') })
          await page.setViewportSize({ width: 1280, height: 900 })
          expect(
            await page
              .getByRole('menuitem', { name: /^Ask each time/ })
              .locator('svg')
              .count(),
          ).toBe(1)
          await page.getByRole('menuitem', { name: /^Auto approve/ }).click()
          await policyMenu.click()
          await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
          await expect
            .poll(() =>
              page
                .getByRole('menuitem', { name: /^Auto approve/ })
                .locator('svg')
                .count(),
            )
            .toBe(1)
          await page.getByRole('menuitem', { name: /^Ask each time/ }).click()
        }
        await policyMenu.click()
        const policyGroup = page.getByRole('menuitem', { name: /^DSH tool approval/ })
        await expect.poll(() => policyGroup.innerText()).toContain('Ask each time')
        await policyGroup.click()
        await expect
          .poll(() =>
            page
              .getByRole('menuitem', { name: /^Ask each time/ })
              .locator('svg')
              .count(),
          )
          .toBe(1)
        await page.keyboard.press('Escape')
        const controls = () => page.getByRole('button', { name: /^Session ·/ })
        expect(await controls().count()).toBe(0)
        await policyMenu.waitFor()
        const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
        const ask = page.getByRole('menuitem', { name: /^Ask(?:\s|$)/ })
        const openControls = async () => {
          await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('false')
          await expect.poll(() => controls().isEnabled()).toBe(true)
          await controls().click()
          await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('true')
          if (profile === 'codex' && delivery === 'response') {
            const directory = join(root, '.local/ui-review')
            mkdirSync(directory, { recursive: true })
            await page.screenshot({ path: join(directory, 'session-settings.png') })
          }
          await page.getByRole('menuitem', { name: /^Session Mode/ }).click()
          await ask.waitFor()
          if (profile === 'codex' && delivery === 'response')
            await page.screenshot({ path: join(root, '.local/ui-review/session-options.png') })
        }
        const send = async (text: string) => {
          await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
          await page.getByRole('button', { name: 'Send message', exact: true }).click()
        }
        const stopped = host.whenTurnSettled(30000)
        await send('E2E_CONTROLS_WAIT')
        await page.getByText('E2E_CONTROLS_RUNNING', { exact: true }).waitFor()
        if (delivery === 'response') {
          // No session/update has carried any controls: only session/new provided them.
          await controls().waitFor()
          expect(await controls().innerText()).toContain('Code')
        } else {
          // A deferred Agent may provide a read-only Default snapshot first;
          // the host policy must still be present before its option snapshot.
          await controls().waitFor()
          await controls().click()
          await page.getByRole('menuitem', { name: /^DSH tool approval/ }).waitFor()
          expect(await page.getByRole('menuitem', { name: /^Session Mode/ }).count()).toBe(0)
          await page.keyboard.press('Escape')
        }
        writeFileSync(readyFile, 'ready')
        await page.getByText('E2E_CONTROLS_UPDATED', { exact: false }).waitFor()
        await expect.poll(() => controls().innerText()).toMatch(/plan/i)
        // Leaving an active conversation must detach its subscription without stopping the Agent.
        await page.getByRole('button', { name: 'New session', exact: true }).last().click()
        await expect.poll(() => controls().count()).toBe(0)
        await page.getByText('E2E_CONTROLS_WAIT', { exact: true }).click()
        await expect.poll(() => controls().innerText()).toMatch(/plan/i)
        phase = 'running options'
        await openControls()
        expect(await ask.isDisabled()).toBe(true)
        await page.keyboard.press('Escape')
        await ask.waitFor({ state: 'hidden' })
        // Reconnect while the same first turn is still running; no new prompt or reload.
        phase = 'reconnect'
        try {
          await page.context().setOffline(true)
          await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
        } finally {
          await page.context().setOffline(false)
        }
        await page
          .getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ })
          .waitFor({ state: 'hidden' })
        await expect.poll(() => controls().innerText()).toMatch(/plan/i)
        phase = 'stop'
        await stop.click()
        await stopped
        // Host turn/end precedes the browser's running projection and composer
        // layout update. Wait for native idle UI before clicking the menu anchor.
        await stop.waitFor({ state: 'hidden' })
        await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
        if (profile === 'codebuddy') {
          // CodeBuddy retires its process after a confirmed cancellation. A
          // renderer reload must still show the same-session controls, and an
          // explicit mode change must reconnect that binding without a prompt.
          await page.reload()
          await controls().waitFor()
          await expect.poll(() => controls().innerText()).toMatch(/plan/i)
        }
        phase = 'stopped options'
        await openControls()
        await expect.poll(() => ask.isDisabled()).toBe(false)
        if (profile === 'codex' && delivery === 'response') {
          failNextOptionWrite = true
          await ask.click()
          await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('false')
          const optionFailureToast = page.getByRole('alert').getByText('Saving failed. Try again.', { exact: true })
          await optionFailureToast.waitFor()
          expect(await page.getByRole('menuitem').count()).toBe(0)
          expect(await controls().innerText()).toMatch(/plan/i)
          await page.screenshot({ path: join(root, '.local/ui-review/session-option-write-error-closed-menu.png') })
          await openControls()
          await page.getByRole('menu').getByText('test session option write failure', { exact: true }).waitFor()
          expect(
            await page
              .getByRole('menuitem', { name: /^Plan(?:\s|$)/ })
              .locator('svg')
              .count(),
          ).toBe(1)
          expect(await ask.isEnabled()).toBe(true)
          expect(await optionFailureToast.innerText()).not.toContain('test session option write failure')
          await optionFailureToast.waitFor({ state: 'hidden' })
        }
        await page.getByRole('menuitem', { name: 'Back to session settings', exact: true }).click()
        await expect.poll(() => ask.count()).toBe(0)
        await page.getByRole('menuitem', { name: /^Session Mode/ }).click()
        await ask.click()
        await ask.waitFor({ state: 'hidden' })
        await expect.poll(() => controls().getAttribute('aria-expanded')).toBe('false')
        await expect.poll(() => controls().innerText()).toMatch(/ask/i)
        if (profile === 'codex' && delivery === 'response') expect(await page.getByRole('alert').count()).toBe(0)
        await controls().click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        await page.getByRole('menuitem', { name: /^Auto approve/ }).click()
        // Agent mode remains Ask while the independent DSH tool policy becomes Auto.
        await expect.poll(() => controls().innerText()).toMatch(/ask/i)
        await controls().click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        await expect
          .poll(() =>
            page
              .getByRole('menuitem', { name: /^Auto approve/ })
              .locator('svg')
              .count(),
          )
          .toBe(1)
        await page.keyboard.press('Escape')
        // A blank conversation cannot inherit the previous session's options.
        phase = 'new session'
        await page.getByRole('button', { name: 'New session', exact: true }).last().click()
        await expect.poll(() => controls().count()).toBe(0)
        await policyMenu.waitFor()
        await policyMenu.click()
        await page.getByRole('menuitem', { name: /^DSH tool approval/ }).click()
        const newSessionAsk = page.getByRole('menuitem', { name: /^Ask each time/ })
        await newSessionAsk.waitFor()
        await expect.poll(() => newSessionAsk.locator('svg').count()).toBe(1)
        await page.keyboard.press('Escape')
        const next = host.whenTurnSettled(30000)
        await send('E2E_MESSAGE')
        await next
        if (delivery === 'response') await expect.poll(() => controls().innerText()).toContain('Code')
        expect(errors).toEqual([])
        await page.context().tracing.stop()
      } catch (error) {
        if (page) {
          const directory = join(root, '.local/e2e-failures')
          mkdirSync(directory, { recursive: true })
          const prefix = join(directory, `controls-${profile}-${delivery}`)
          // Collect independently so a closed page cannot hide the original
          // failure or prevent the trace from being saved.
          const evidence = await Promise.allSettled([
            page
              .locator('body')
              .innerText()
              .then((body) =>
                writeFileSync(
                  `${prefix}.json`,
                  JSON.stringify({ phase, body, errors, consoleMessages, failure: String(error) }, null, 2),
                ),
              ),
            page.screenshot({ path: `${prefix}.png`, timeout: 5000 }),
            page.context().tracing.stop({ path: `${prefix}.trace.zip` }),
          ])
          for (const result of evidence)
            if (result.status === 'rejected') console.warn('Could not save controls failure evidence:', result.reason)
        }
        throw error
      } finally {
        try {
          await browser?.close()
        } finally {
          await host.close()
        }
      }
    },
  )
})

it.each([
  { titleKind: 'ordinary', sourceTitle: 'Late outcome source', evidencePrefix: 'late' },
  { titleKind: 'unbroken', sourceTitle: 'W'.repeat(80), evidencePrefix: 'late-long' },
])(
  'keeps failed option and policy outcomes after navigation or locale changes ($titleKind title)',
  async ({ sourceTitle, evidencePrefix }) => {
    const host = await launchAdapterWorld()
    let browser!: TestBrowser
    let releaseWrite: (() => void) | undefined
    const restorers: (() => void)[] = []
    try {
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'auto',
        agents: {
          codex: {
            name: 'Late outcome fixture',
            command: process.execPath,
            args: [join(root, 'test/mock-agent/mock-agent.ts')],
            runtime: 'codex',
            env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'codex' },
          },
        },
      })
      await vi.waitFor(() =>
        expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-codex')).toBe(true),
      )
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
      browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
      const page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const settled = host.whenTurnSettled(30000)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await settled
      const conversation = page.locator('[data-conversation-session]').last()
      const sourceId = await conversation.getAttribute('data-conversation-session')
      if (sourceId === null) throw new Error('The source conversation did not publish its Session ID')
      await host.ctx.sessionController.rename({ sessionId: SessionId(sourceId), title: sourceTitle })
      await page.getByText(sourceTitle, { exact: true }).first().waitFor()
      const controls = () => page.getByRole('button', { name: /^(?:Session|会话) ·/ })
      await controls().waitFor()
      const service = host.ctx.get('dshAcp') as AcpRemoteService
      let held: { operation: 'option' | 'policy'; entered(): void; wait: Promise<void> } | undefined
      const option = service.setAgentSessionOption.bind(service)
      const policy = service.setToolApprovalPolicy.bind(service)
      const waitForFailure = async (operation: 'option' | 'policy'): Promise<void> => {
        const pending = held
        if (pending?.operation !== operation) return
        held = undefined
        pending.entered()
        await pending.wait
        throw new Error(`PRIVATE_LATE_${operation.toUpperCase()}_FAILURE`)
      }
      const optionSpy = vi.spyOn(service, 'setAgentSessionOption').mockImplementation(async (sessionId, request) => {
        await waitForFailure('option')
        return await option(sessionId, request)
      })
      const policySpy = vi.spyOn(service, 'setToolApprovalPolicy').mockImplementation(async (sessionId, request) => {
        await waitForFailure('policy')
        return await policy(sessionId, request)
      })
      restorers.push(
        () => optionSpy.mockRestore(),
        () => policySpy.mockRestore(),
      )

      for (const operation of ['option', 'policy'] as const) {
        for (const change of ['session', 'locale'] as const) {
          const before = await service.agentSessionSnapshot(sourceId)
          let entered!: () => void
          const started = new Promise<void>((resolve) => {
            entered = resolve
          })
          const wait = new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
          held = { operation, entered, wait }
          await expect.poll(() => controls().isEnabled()).toBe(true)
          await controls().click()
          await page
            .getByRole('menuitem', { name: operation === 'option' ? /^Session Mode/ : /^DSH tool approval/ })
            .click()
          await page
            .getByRole('menuitem', { name: operation === 'option' ? /^Plan(?:\s|$)/ : /^Ask each time/ })
            .click()
          await started
          expect(await page.getByRole('alert').count()).toBe(0)

          if (change === 'session') {
            await page.getByRole('button', { name: 'New session', exact: true }).last().click()
            await expect.poll(() => conversation.getAttribute('data-conversation-session')).not.toBe(sourceId)
            await expect.poll(() => controls().count()).toBe(0)
          } else {
            await host.ctx.settings.replace('locale', { preference: 'zh' })
            await host.ctx.settings.replace('ui-theme', { preference: 'dark' })
            await page.getByRole('button', { name: /^会话 ·/ }).waitFor()
          }
          releaseWrite!()
          releaseWrite = undefined
          const toast = page.getByRole('alert').filter({ hasText: sourceTitle })
          await toast.waitFor()
          expect(await toast.count()).toBe(1)
          const text = await toast.innerText()
          expect(text).toContain(change === 'locale' ? '请重试' : operation === 'option' ? 'Try again' : 'Please retry')
          expect(text).not.toContain('PRIVATE_LATE_')
          await page.setViewportSize({ width: 390, height: 900 })
          // Capture the native Toast's full-opacity hold, not its entrance/fade frame.
          await expect.poll(() => toast.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
          const geometry = await toast.evaluate((element) => {
            const box = element.getBoundingClientRect()
            const text = element.lastElementChild as HTMLElement
            const range = document.createRange()
            range.selectNodeContents(text)
            return {
              left: box.left,
              right: box.right,
              viewport: innerWidth,
              textWidth: text.clientWidth,
              textScrollWidth: text.scrollWidth,
              textRight: range.getBoundingClientRect().right,
              overflowWrap: getComputedStyle(text).overflowWrap,
            }
          })
          mkdirSync(join(root, '.local/ui-review'), { recursive: true })
          const evidence = join(root, `.local/ui-review/${evidencePrefix}-${operation}-${change}-390`)
          writeFileSync(`${evidence}.json`, JSON.stringify(geometry, null, 2))
          await page.screenshot({ path: `${evidence}.png` })
          expect(geometry.left).toBeGreaterThanOrEqual(0)
          expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
          expect(geometry.textScrollWidth).toBeLessThanOrEqual(geometry.textWidth + 1)
          expect(geometry.textRight).toBeLessThanOrEqual(geometry.viewport)
          expect((await service.agentSessionSnapshot(sourceId)).configOptions).toEqual(before.configOptions)
          expect((await service.agentSessionSnapshot(sourceId)).currentModeId).toBe(before.currentModeId)
          expect((await service.toolApprovalPolicy(sourceId)).policy).toBe('auto')
          await page.setViewportSize({ width: 1280, height: 900 })
          await toast.waitFor({ state: 'hidden' })
          if (change === 'session') {
            await page.getByText(sourceTitle, { exact: true }).first().click()
            await expect.poll(() => conversation.getAttribute('data-conversation-session')).toBe(sourceId)
          } else {
            await host.ctx.settings.replace('locale', { preference: 'en' })
            await host.ctx.settings.replace('ui-theme', { preference: 'light' })
          }
          await page.getByRole('button', { name: /^Session ·/ }).waitFor()
          await expect.poll(() => controls().isEnabled()).toBe(true)
          await controls().click()
          expect(await page.getByRole('menu').innerText()).not.toContain('PRIVATE_LATE_')
          await page.keyboard.press('Escape')
        }
      }
    } finally {
      releaseWrite?.()
      for (const restore of restorers) restore()
      try {
        await browser?.close()
      } finally {
        await host.close()
      }
    }
  },
)
