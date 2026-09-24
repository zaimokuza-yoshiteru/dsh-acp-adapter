import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import { it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it.each(['claude', 'codex', 'devin', 'kimi'])('preserves %s reasoning, message and tool boundaries live and after reload', async profile => {
  const host = await launchAdapterWorld()
  let browser!: TestBrowser
  const events: ObservedEvent[] = [], errors: string[] = []
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { [profile]: { name: profile, command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.ts')], env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile } } } })
    const provider = `acp-${profile}`
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === provider)).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
    const page = await newEnglishPage(browser)
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    // An older interrupted answer must not break a later history rebuild.
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_STOP')
    const stopped = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_RUNNING', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await stopped
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), '模拟计数器项目 E2E_STREAM_SEGMENTS')
    const settled = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('页面骨架已完成。', { exact: true }).waitFor()
    const sessionId = await settled
    const expected = [
      ['reasoning', '\n\n先规划计数器页面。'], ['text', '页面骨架已完成。'],
      ['reasoning', '再检查按钮事件。'], ['text', '按钮交互已完成。'],
      ['text', '检查结果正常。'], ['text', '演示结束。'],
    ].map(([type, text]) => ({ type, text }))
    expect(required(events.filter(event => event.type === 'assistant/message').findLast(event => event.sessionId === sessionId)).data.message.content).toEqual(expected)
    const verifyOrder = async (live = false) => {
      const process = page.locator('[data-turn-process-tool-calls="4"]')
      if (!live) {
        await process.waitFor()
        if (await process.getAttribute('aria-expanded') === 'false') await process.click()
      }
      // RC verbose mode expands group content without displaying its header.
      // In grouped modes, wait for outer hiding to clear before opening each group.
      for (const button of await page.locator('[data-step-process]:not([data-group-expanded-mode]) > div > button').all()) {
        await button.waitFor({ state: 'visible' })
        if (await button.getAttribute('aria-expanded') === 'false') await button.click()
        await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true')
      }
      for (const row of await page.locator('[data-variant="think"]').all()) {
        await row.waitFor({ state: 'visible' })
        if (await row.getAttribute('data-expanded') === null) await row.getByRole('button').first().click()
        await expect.poll(() => row.getAttribute('data-expanded')).toBe('true')
      }
      expect(errors).toEqual([])
      const tool = (id: string) => page.locator(`[data-chat-call-id$=":tool:${id}"]`)
      const text = (value: string) => page.getByText(value, { exact: true }).filter({ visible: true }).last()
      const ordered = [
        tool('segment-setup'), text('先规划计数器页面。'), text('页面骨架已完成。'),
        tool('segment-plan'), text('再检查按钮事件。'), text('按钮交互已完成。'),
        tool('segment-check'), text('检查结果正常。'), text('演示结束。'), tool('segment-tail'),
      ]
      for (const item of ordered) await item.waitFor()
      // Reasoning rows have their own native disclosure too.
      for (const item of [text('先规划计数器页面。'), text('再检查按钮事件。')]) expect(await item.innerText()).not.toBe('')
      await expect.poll(async () => {
        const elements = await Promise.all(ordered.map(item => item.elementHandle()))
        return page.evaluate(nodes => {
          if (nodes.some(node => !node?.isConnected)) return false
          const positions = nodes.map(node => node!.getBoundingClientRect().y)
          return positions.every((y, index) => index === 0 || y > positions[index - 1])
        }, elements)
      }).toBe(true)
      for (const id of ['segment-setup', 'segment-plan', 'segment-check', 'segment-tail']) expect(await tool(id).count()).toBe(1)
      expect(await tool('segment-setup').locator('[data-sample=bash]').count()).toBe(1)
      expect(await tool('segment-check').locator('[data-tool=send_message]').count()).toBe(1)
      expect(await tool('segment-check').innerText()).toContain('Send message')
      expect(await tool('segment-check').getByText('repo-codex', { exact: true }).isVisible()).toBe(true)
    }

    for (const reload of [false, true]) {
      if (reload) await page.reload()
      const control = page.locator('[data-turn-process-tool-calls="4"]')
      await control.waitFor()
      expect(await control.getAttribute('aria-expanded')).toBe('false')
      expect(await page.getByText('演示结束。', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByText('页面骨架已完成。', { exact: true }).isVisible()).toBe(false)
      await verifyOrder()
    }
    const inspectedCall = page.locator('[data-chat-call-id$=":tool:segment-plan"]')
    await inspectedCall.getByRole('button').first().click()
    await inspectedCall.getByRole('button', { name: 'Inspect', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    expect(await page.getByRole('dialog').innerText()).toContain('list_agents')
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    const control = page.locator('[data-turn-process-tool-calls="4"]')
    await control.focus()
    await control.press('Enter')
    expect(await control.getAttribute('aria-expanded')).toBe('false')
    // Native collapse resets each inner disclosure in an effect. Let that reset
    // settle before simulating browser Find, otherwise it can close a group
    // after the next reveal has already clicked its still-open header.
    const hiddenGroups = page.locator('[data-step-process][hidden="until-found"]')
    await hiddenGroups.first().waitFor({ state: 'attached' })
    await expect.poll(() => hiddenGroups.locator(':scope > div > button[aria-expanded="true"]').count()).toBe(0)
    await hiddenGroups.last().evaluate(element => element.dispatchEvent(new Event('beforematch')))
    await expect.poll(() => control.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('[data-step-process-content]').count()).toBeGreaterThan(0)
    expect(await page.getByRole('tab', { name: 'Chat', exact: true }).count()).toBe(1)
    await verifyOrder()
    if (profile === 'codex') {
      await host.ctx.settings.replace('locale', { preference: 'zh' })
      await page.locator('[data-tool=send_message]').getByText('发送消息', { exact: true }).waitFor()
      expect(await page.locator('[data-tool=send_message]').innerText()).toContain('发送消息')
      await host.ctx.settings.replace('locale', { preference: 'en' })
      await page.locator('[data-tool=send_message]').getByText('Send message', { exact: true }).waitFor()
    }
    for (const mode of ['compact', 'standard', 'detailed', 'verbose', 'normal', 'expanded']) {
      await host.ctx.settings.replace('ui-chat', { transcriptView: mode })
      // The host write completes before the browser receives its settings push.
      // Wait for the rendered policy before enumerating headers: entering
      // verbose removes the old grouped locators while leaving their content.
      const ungrouped = mode === 'verbose'
      await expect.poll(() => control.isDisabled(), { timeout: 5_000 }).toBe(ungrouped)
      await expect.poll(() => page.locator('[data-step-process]').evaluateAll((groups, expected) =>
        groups.length > 0 && groups.every(group => group.hasAttribute('data-group-expanded-mode') === expected), ungrouped), { timeout: 5_000 }).toBe(true)
      await verifyOrder()
      if (mode === 'verbose') {
        expect(await control.isDisabled()).toBe(true)
        expect(await control.getAttribute('aria-expanded')).toBe('true')
      } else {
        expect(await control.isDisabled()).toBe(false)
      }
    }
    await host.ctx.settings.replace('ui-chat', { transcriptView: 'compact' })
    if (profile === 'devin') {
      const dir = join(root, '.local/message-order-review')
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: join(dir, 'stream.en.png'), fullPage: true })
    }
    // Hold the same interleaving live, then cancel it. Interrupted history has
    // no final replay payload and must retain exactly the same durable anchors.
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.getByText('演示结束。', { exact: true }).waitFor({ state: 'detached' })
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_STREAM_SEGMENTS CANCEL')
    const cancelledTurn = host.whenTurnSettled(30_000)
    void cancelledTurn.catch(() => {}) // Keep assertion failures from leaving an unhandled listener timeout.
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.locator('[data-chat-call-id$=":tool:segment-tail"]').waitFor({ state: 'attached' })
    await verifyOrder(true)
    if (profile === 'devin') await page.screenshot({ path: join(root, '.local/message-order-review/stream.live.png'), fullPage: true })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await cancelledTurn
    await verifyOrder()
    await page.reload()
    await verifyOrder()
    expect(await page.locator('[data-chat-flow-kind=assistant-step]').getByText('Stopped', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Stopped', exact: true }).count()).toBe(1)
    expect(errors).toEqual([])
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0]
    if (page) {
      mkdirSync(join(root, '.local/message-order-review'), { recursive: true })
      await page.screenshot({ path: join(root, '.local/message-order-review/failure.png'), fullPage: true })
      console.error(await page.locator('body').innerText(), errors)
    }
    throw error
  } finally { await browser?.close(); await host.close() }
})
