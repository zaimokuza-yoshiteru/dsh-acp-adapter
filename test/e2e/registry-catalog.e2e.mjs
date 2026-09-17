import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { it, expect } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

it('adds catalog presets, preserves edited defaults, and runs a generic Agent through native UI', async () => {
  const host = await launchAdapterWorld()
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    const page = await newEnglishPage(browser)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'ACP adapter', exact: true }).click()
    const select = async name => {
      await dialog.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('menuitem', { name }).click()
    }
    await select(/^Minion Code ·/)
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe('acp')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^VT Code ·/)
    expect(await dialog.getByLabel('Executable', { exact: true }).inputValue()).toBe('')
    expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toBe('VT_ACP_ENABLED=1\nVT_ACP_ZED_ENABLED=1')
    await dialog.getByText(/Install the binary for the Agent host/).waitFor()
    mkdirSync(join(root, '.local/registry-ui'), { recursive: true })
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-en.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^fast-agent ·/i)
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe('-x')
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toBe('FAST_AGENT_MODEL=codexplan')
    await dialog.getByLabel('Executable', { exact: true }).fill(process.execPath)
    await dialog.getByLabel('Arguments', { exact: true }).fill(join(root, 'test/mock-agent/mock-agent.mjs'))
    await dialog.getByLabel('Environment', { exact: true }).fill('FAST_AGENT_MODEL=my-choice\nMOCK_SCENARIO=regression')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.getByText('Saved.', { exact: true }).waitFor()
    const saved = host.ctx.settings.get('dsh-acp').agents['fast-agent']
    expect(saved.runtime).toBeUndefined()
    expect(saved.env.FAST_AGENT_MODEL).toBe('my-choice')
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toContain('FAST_AGENT_MODEL=my-choice')
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe(join(root, 'test/mock-agent/mock-agent.mjs'))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    const zh = page.getByRole('dialog', { name: '设置', exact: true })
    await zh.getByRole('button', { name: 'ACP adapter', exact: true }).click()
    await zh.getByRole('button', { name: '添加 agent', exact: true }).click()
    await page.getByRole('menuitem', { name: /^VT Code ·/ }).click()
    await zh.getByText(/请按 Agent 所在主机的平台安装二进制/).waitFor()
    expect(await zh.getByLabel('环境变量', { exact: true }).inputValue()).toContain('VT_ACP_ENABLED=1')
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-zh.png'), fullPage: true })
    await zh.getByRole('button', { name: '取消', exact: true }).click()
    await zh.getByRole('button', { name: '通用设置', exact: true }).click()
    await zh.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    // Reload in English with the generic profile as the native default model.
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-fast-agent', model: 'mock-model-a' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const chat = page
    await chat.reload()
    const settled = host.whenTurnSettled(30_000)
    await writeComposerDraft(chat, chat.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await settled
    expect(host.ctx.sessions.get(id).snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind).toBe('completed')
    expect(errors).toEqual([])
  } finally { await browser?.close(); await host.close() }
})
