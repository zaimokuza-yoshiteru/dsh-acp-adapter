import type { AcpAgentConfig } from '../../src/contract/agent-config.ts'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { it, expect } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it('adds catalog presets, preserves edited defaults, and runs a generic Agent through native UI', async () => {
  const host = await launchAdapterWorld()
  let browser!: TestBrowser
  try {
    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'ACP adapter', exact: true }).click()
    await dialog.getByRole('button', { name: 'Add agent', exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.getByText('Verified adapters · 4', { exact: true }).waitFor()
    await menu.getByText(/^Catalog entries · Unverified ·/).waitFor()
    expect(await dialog.getByRole('textbox').count()).toBe(0)
    expect(await menu.getByRole('textbox').count()).toBe(0)
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.slice(0, 4).map(text => text.split(' · ')[0])).toEqual(['Devin', 'Codex', 'Kimi CLI', 'Claude Agent'])
    for (const viewport of [{ width: 1680, height: 1000 }, { width: 900, height: 600 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await menu.boundingBox()
        return bounds !== null && bounds.height <= Math.min(420, viewport.height * 0.65) + 1 && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height
      }).toBe(true)
      // Native keyboard navigation reaches the pinned custom entry
      // without treating group headings as menu items.
      await menu.getByRole('menuitem').first().focus()
      await page.keyboard.press('End')
      expect(await menu.getByRole('menuitem').last().evaluate(node => node === document.activeElement)).toBe(true)
      expect(await menu.getByRole('menuitem').last().isVisible()).toBe(true)
    }
    mkdirSync(join(root, '.local/registry-ui'), { recursive: true })
    await page.screenshot({ path: join(root, '.local/registry-ui/grouped-menu-small.png'), fullPage: true })
    await page.keyboard.press('Escape')
    // The pinned host Settings dialog also handles document-level Escape.
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await dialog.getByRole('button', { name: 'ACP adapter', exact: true }).click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    const select = async (name: string | RegExp) => {
      await dialog.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('menuitem', { name }).click()
    }
    await select(/^Codex ·/)
    expect(await dialog.getByLabel('Environment', { exact: true }).count()).toBe(0)
    expect(await dialog.getByLabel('Login hint', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await dialog.getByText(/If sign-in is needed.*codex login/).waitFor()
    await page.screenshot({ path: join(root, '.local/registry-ui/login-guidance-en.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^Minion Code ·/)
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe('acp')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^VT Code ·/)
    expect(await dialog.getByLabel('Executable', { exact: true }).inputValue()).toBe('')
    expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(await dialog.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await dialog.getByText('2 environment variables configured.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await dialog.getByText('DSH plugin tools', { exact: true }).count()).toBe(0)
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toBe('VT_ACP_ENABLED=1\nVT_ACP_ZED_ENABLED=1')
    await dialog.getByText(/Install the binary for the Agent host/).waitFor()
    mkdirSync(join(root, '.local/registry-ui'), { recursive: true })
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-en.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^fast-agent ·/i)
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe('-x')
    await dialog.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toBe('FAST_AGENT_MODEL=codexplan')
    await dialog.getByLabel('ID', { exact: true }).fill('my-fast')
    await dialog.getByLabel('Executable', { exact: true }).fill(process.execPath)
    await dialog.getByLabel('Arguments', { exact: true }).fill(join(root, 'test/mock-agent/mock-agent.ts'))
    await dialog.getByLabel('Environment', { exact: true }).fill('FAST_AGENT_MODEL=my-choice\nMOCK_SCENARIO=regression')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.getByText('Saved.', { exact: true }).waitFor()
    const saved = (host.ctx.settings.describe().find(row => row.ns === 'dsh-acp-adapter')?.value as { agents: Record<string, AcpAgentConfig> }).agents['my-fast']
    expect(saved.runtime).toBeUndefined()
    expect(saved.catalogId).toBe('fast-agent')
    expect(saved.env.FAST_AGENT_MODEL).toBe('my-choice')
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await dialog.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await dialog.getByLabel('Environment', { exact: true }).inputValue()).toContain('FAST_AGENT_MODEL=my-choice')
    expect(await dialog.getByLabel('Arguments', { exact: true }).inputValue()).toBe(join(root, 'test/mock-agent/mock-agent.ts'))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    const zh = page.getByRole('dialog', { name: '设置', exact: true })
    await zh.getByRole('button', { name: 'ACP adapter', exact: true }).click()
    await zh.getByRole('button', { name: '添加 agent', exact: true }).click()
    await page.getByRole('menu').getByText('已验证适配 · 4', { exact: true }).waitFor()
    await page.getByRole('menu').getByText(/^目录收录 · 未验证 ·/).waitFor()
    await page.getByRole('menuitem', { name: /^VT Code ·/ }).click()
    await zh.getByText(/请按 Agent 所在主机的平台安装二进制/).waitFor()
    expect(await zh.getByLabel('登录指引', { exact: true }).count()).toBe(0)
    expect(await zh.getByLabel('环境变量', { exact: true }).count()).toBe(0)
    await zh.getByRole('button', { name: '高级选项', exact: true }).click()
    expect(await zh.getByText('DSH 插件工具', { exact: true }).count()).toBe(0)
    expect(await zh.getByLabel('环境变量', { exact: true }).inputValue()).toContain('VT_ACP_ENABLED=1')
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-zh.png'), fullPage: true })
    await zh.getByRole('button', { name: '取消', exact: true }).click()
    await zh.getByRole('button', { name: '通用设置', exact: true }).click()
    await zh.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    // Reload in English with the generic profile as the native default model.
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-my-fast', model: 'mock-model-a' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const chat = page
    await chat.reload()
    const settled = host.whenTurnSettled(30_000)
    await writeComposerDraft(chat, chat.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await settled
    expect(required(required(host.ctx.sessions.get(id)).snapshotEvents().findLast(event => event.type === 'turn/end')).data.reason.kind).toBe('completed')
    expect(errors).toEqual([])
  } finally { await browser?.close(); await host.close() }
})
