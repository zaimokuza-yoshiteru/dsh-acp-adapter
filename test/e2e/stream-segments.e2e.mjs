import { it, expect, vi } from 'vitest'
import { chromium } from 'playwright'
import { join } from 'node:path'
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
    expect(events.find(event => event.sessionId === sessionId && event.type === 'assistant/message').data.message.content).toEqual(expected)
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      const answers = []
      for (const { text } of expected.filter(block => block.type === 'text')) {
        const paragraph = page.getByText(text, { exact: true })
        await paragraph.waitFor()
        answers.push(await paragraph.boundingBox())
      }
      for (let i = 1; i < answers.length; i++) expect(answers[i].y).toBeGreaterThan(answers[i - 1].y)
    }
    expect(errors).toEqual([])
  } finally { await browser?.close(); await host.close() }
})
