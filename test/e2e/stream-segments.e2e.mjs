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
      ['reasoning', '先规划计数器页面。'], ['text', '页面骨架已完成。'],
      ['reasoning', '再检查按钮事件。'], ['text', '按钮交互已完成。'],
      ['text', '检查结果正常。'], ['text', '演示结束。'],
    ].map(([type, text]) => ({ type, text }))
    expect(events.findLast(event => event.sessionId === sessionId && event.type === 'assistant/message').data.message.content).toEqual(expected)
    const verifyOrder = async (thoughts = false) => {
      const ordered = [
        '准备计数器工作区', ...(thoughts ? ['先规划计数器页面。'] : []), '页面骨架已完成。',
        '读取按钮计划', ...(thoughts ? ['再检查按钮事件。'] : []), '按钮交互已完成。',
        '模拟检查计数器', '检查结果正常。', '演示结束。', '保存检查结果',
      ]
      for (const text of ordered) await page.getByText(text, { exact: true }).waitFor()
      // Read every position in one browser frame. Sequential boundingBox calls
      // can straddle native auto-scroll and falsely report a reversed row.
      await expect.poll(async () => {
        const elements = await Promise.all(ordered.map(text => page.getByText(text, { exact: true }).elementHandle()))
        return page.evaluate(nodes => {
          if (nodes.some(node => !node?.isConnected)) return false
          const positions = nodes.map(node => node.getBoundingClientRect().y)
          return positions.every((y, index) => index === 0 || y > positions[index - 1])
        }, elements)
      }).toBe(true)
      for (const text of ['准备计数器工作区', '读取按钮计划', '模拟检查计数器', '保存检查结果']) {
        expect(await page.getByText(text, { exact: true }).count()).toBe(1)
      }
    }
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      await verifyOrder()
    }
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
    await page.getByText('保存检查结果', { exact: true }).waitFor()
    await verifyOrder(true)
    if (profile === 'devin') await page.screenshot({ path: join(root, '.local/message-order-review/stream.live.png'), fullPage: true })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await cancelledTurn
    await verifyOrder()
    await page.reload()
    await verifyOrder()
    expect(await page.getByText('Stopped', { exact: true }).count()).toBe(1)
    expect(errors).toEqual([])
  } finally { await browser?.close(); await host.close() }
})
