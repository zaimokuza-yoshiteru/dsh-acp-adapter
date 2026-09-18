import { it, expect, vi } from 'vitest'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

it.each(['claude', 'codex', 'devin', 'kimi'])('preserves %s reasoning, message and tool boundaries live and after reload', async profile => {
  const host = await launchAdapterWorld()
  let browser
  const events = [], errors = []
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: { name: profile, command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.mjs')], env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile } } } })
    const provider = `acp-${profile}`
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(p => p.id === provider)).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
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
    expect(events.findLast(event => event.sessionId === sessionId && event.type === 'assistant/message').data.message.content).toEqual(expected)
    const verifyOrder = async (live = false) => {
      const process = page.locator('[data-turn-process-tool-calls="4"]')
      if (!live) {
        await process.waitFor()
        if (await process.getAttribute('aria-expanded') === 'false') await process.click()
      }
      expect(errors).toEqual([])
      const tool = id => page.locator(`[data-chat-call-id$=":tool:${id}"]`)
      const text = value => page.getByText(value, { exact: true }).last()
      const ordered = [
        tool('segment-setup'), text('先规划计数器页面。'), text('页面骨架已完成。'),
        tool('segment-plan'), text('再检查按钮事件。'), text('按钮交互已完成。'),
        tool('segment-check'), text('检查结果正常。'), text('演示结束。'), tool('segment-tail'),
      ]
      for (const item of ordered) await item.waitFor()
      await expect.poll(async () => {
        const elements = await Promise.all(ordered.map(item => item.elementHandle()))
        return page.evaluate(nodes => {
          if (nodes.some(node => !node?.isConnected)) return false
          const positions = nodes.map(node => node.getBoundingClientRect().y)
          return positions.every((y, index) => index === 0 || y > positions[index - 1])
        }, elements)
      }).toBe(true)
      for (const id of ['segment-setup', 'segment-plan', 'segment-check', 'segment-tail']) expect(await tool(id).count()).toBe(1)
      expect(await tool('segment-setup').locator('[data-sample=bash]').count()).toBe(1)
      expect(await tool('segment-check').locator('[data-variant=others]').count()).toBe(1)
      expect(await tool('segment-check').innerText()).toContain('Tool call')
      expect(await tool('segment-check').innerText()).toContain('send_message · repo-codex')
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
    await page.locator('[data-acp-activity][hidden="until-found"]').first().evaluate(element => element.dispatchEvent(new Event('beforematch')))
    await expect.poll(() => control.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('[data-acp-activity]').first().evaluate(element => getComputedStyle(element).gap)).toBe('16px')
    if (profile === 'codex') {
      await host.ctx.settings.replace('locale', { preference: 'zh' })
      await page.getByRole('button', { name: '4 次工具调用', exact: true }).waitFor()
      expect(await page.locator('[data-tool=send_message]').innerText()).toContain('工具调用')
      await host.ctx.settings.replace('locale', { preference: 'en' })
      await page.getByRole('button', { name: '4 tool calls', exact: true }).waitFor()
    }
    await host.ctx.settings.replace('ui-chat', { transcriptView: 'normal' })
    await page.locator('[data-turn-process-tool-calls="4"]').waitFor({ state: 'hidden' })
    await verifyOrder(true)
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
    await page.getByText('保存检查结果', { exact: false }).last().waitFor()
    await verifyOrder(true)
    if (profile === 'devin') await page.screenshot({ path: join(root, '.local/message-order-review/stream.live.png'), fullPage: true })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await cancelledTurn
    await verifyOrder()
    await page.reload()
    await verifyOrder()
    expect(await page.getByText('Stopped', { exact: true }).count()).toBe(1)
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
