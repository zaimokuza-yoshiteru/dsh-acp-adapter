import type { AcpAgentConfig } from '../../src/contract/agent-config.ts'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { it, expect } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { backToPluginList, openAcpPluginDetail } from './plugin-panel.helpers.ts'

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
    let detail = await openAcpPluginDetail(page)
    const addButton = detail.getByRole('button', { name: 'Add agent', exact: true })
    await addButton.click()
    const menu = page.getByRole('menu')
    await menu.getByText('Verified adapters · 4', { exact: true }).waitFor()
    await menu.getByText(/^Catalog entries · Unverified ·/).waitFor()
    expect(await detail.getByRole('textbox').count()).toBe(0)
    expect(await menu.getByRole('textbox').count()).toBe(0)
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.slice(0, 4).map(text => text.split(' · ')[0])).toEqual(['Devin', 'Codex', 'Kimi CLI', 'Claude Agent'])
    const evidence = join(root, '.local/plugin-panel-v2')
    mkdirSync(evidence, { recursive: true })
    const observedSides = new Set<'top' | 'bottom'>()
    for (const viewport of [{ width: 1680, height: 1000 }, { width: 900, height: 600 }, { width: 420, height: 500 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await menu.boundingBox()
        const trigger = await addButton.boundingBox()
        return bounds !== null && trigger !== null && Math.abs(bounds.width - trigger.width) < 1 && bounds.x >= 12 && bounds.x + bounds.width <= viewport.width - 12 && bounds.y >= 12 && bounds.y + bounds.height <= viewport.height - 12
      }).toBe(true)
      const box = required(await menu.boundingBox())
      const trigger = required(await addButton.boundingBox())
      const topClearance = await page.evaluate(() => Math.max(12, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')) || 12))
      const below = Math.max(0, viewport.height - trigger.y - trigger.height - 16)
      const above = Math.max(0, trigger.y - topClearance - 4)
      if (above > below) {
        observedSides.add('top')
        expect(box.y + box.height).toBeLessThanOrEqual(trigger.y - 2)
        expect(box.y).toBeGreaterThanOrEqual(topClearance)
      } else {
        observedSides.add('bottom')
        expect(box.y).toBeGreaterThanOrEqual(trigger.y + trigger.height + 2)
      }
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 12)
      const rowsViewport = menu.locator(':scope > [role="presentation"]').first()
      const rowScroll = await rowsViewport.evaluate(element => element.scrollHeight > element.clientHeight)
      expect(rowScroll, `catalog rows should scroll within ${viewport.width}x${viewport.height}`).toBe(true)
      const footerItem = menu.getByText('Add manually', { exact: true })
      await footerItem.waitFor()
      expect(await footerItem.isVisible()).toBe(true)
      // Native keyboard navigation reaches the pinned custom entry
      // without treating group headings as menu items.
      await menu.getByRole('menuitem').first().focus()
      await page.keyboard.press('End')
      expect(await menu.getByRole('menuitem').last().evaluate(node => node === document.activeElement)).toBe(true)
      expect(await menu.getByRole('menuitem').last().isVisible()).toBe(true)
      await page.screenshot({ path: join(evidence, `menu-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: 'disabled' })
    }
    await addButton.evaluate(element => element.scrollIntoView({ block: 'end' }))
    await expect.poll(async () => {
      const box = await menu.boundingBox()
      const trigger = await addButton.boundingBox()
      return box !== null && trigger !== null && box.y + box.height <= trigger.y - 2
    }).toBe(true)
    observedSides.add('top')
    expect(observedSides).toContain('bottom')
    expect(observedSides).toContain('top')
    await page.screenshot({ path: join(evidence, 'menu-near-bottom.png'), fullPage: true, animations: 'disabled' })
    await page.keyboard.press('Escape')
    // Escape closes the foreground catalog menu; return to the Plugins inventory.
    await menu.waitFor({ state: 'hidden' })
    await detail.waitFor({ state: 'visible' })
    await backToPluginList(detail)
    detail = await openAcpPluginDetail(page)
    await page.setViewportSize({ width: 1680, height: 1000 })
    const select = async (name: string | RegExp) => {
      await detail.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('menuitem', { name }).click()
    }
    await select(/^Codex ·/)
    expect(await detail.getByLabel('Environment', { exact: true }).count()).toBe(0)
    expect(await detail.getByLabel('Login hint', { exact: true }).count()).toBe(0)
    await detail.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await detail.getByText(/If sign-in is needed.*codex login/).waitFor()
    await page.screenshot({ path: join(root, '.local/registry-ui/login-guidance-en.png'), fullPage: true })
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^Minion Code ·/)
    expect(await detail.getByLabel('Arguments', { exact: true }).inputValue()).toBe('acp')
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^VT Code ·/)
    expect(await detail.getByLabel('Executable', { exact: true }).inputValue()).toBe('')
    expect(await detail.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(await detail.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await detail.getByText('2 environment variables configured.', { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await detail.getByText('DSH plugin tools', { exact: true }).count()).toBe(0)
    expect(await detail.getByLabel('Environment', { exact: true }).inputValue()).toBe('VT_ACP_ENABLED=1\nVT_ACP_ZED_ENABLED=1')
    await detail.getByText(/Install the binary for the Agent host/).waitFor()
    mkdirSync(join(root, '.local/registry-ui'), { recursive: true })
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-en.png'), fullPage: true })
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await select(/^fast-agent ·/i)
    expect(await detail.getByLabel('Arguments', { exact: true }).inputValue()).toBe('-x')
    await detail.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await detail.getByLabel('Environment', { exact: true }).inputValue()).toBe('FAST_AGENT_MODEL=codexplan')
    await detail.getByLabel('ID', { exact: true }).fill('my-fast')
    await detail.getByLabel('Executable', { exact: true }).fill(process.execPath)
    await detail.getByLabel('Arguments', { exact: true }).fill(join(root, 'test/mock-agent/mock-agent.ts'))
    await detail.getByLabel('Environment', { exact: true }).fill('FAST_AGENT_MODEL=my-choice\nMOCK_SCENARIO=regression')
    await detail.getByRole('button', { name: 'Save', exact: true }).click()
    await detail.getByText('Saved.', { exact: true }).waitFor()
    const saved = (host.ctx.settings.describe().find(row => row.ns === 'dsh-acp-adapter')?.value as { agents: Record<string, AcpAgentConfig> }).agents['my-fast']
    expect(saved.runtime).toBeUndefined()
    expect(saved.catalogId).toBe('fast-agent')
    expect(saved.env.FAST_AGENT_MODEL).toBe('my-choice')
    await detail.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await detail.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await detail.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await detail.getByLabel('Environment', { exact: true }).inputValue()).toContain('FAST_AGENT_MODEL=my-choice')
    expect(await detail.getByLabel('Arguments', { exact: true }).inputValue()).toBe(join(root, 'test/mock-agent/mock-agent.ts'))
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await backToPluginList(detail)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    detail = await openAcpPluginDetail(page, 'zh')
    await detail.getByRole('button', { name: '添加 agent', exact: true }).click()
    await page.getByRole('menu').getByText('已验证适配 · 4', { exact: true }).waitFor()
    await page.getByRole('menu').getByText(/^目录收录 · 未验证 ·/).waitFor()
    await page.getByRole('menuitem', { name: /^VT Code ·/ }).click()
    await detail.getByText(/请按 Agent 所在主机的平台安装二进制/).waitFor()
    expect(await detail.getByLabel('登录指引', { exact: true }).count()).toBe(0)
    expect(await detail.getByLabel('环境变量', { exact: true }).count()).toBe(0)
    await detail.getByRole('button', { name: '高级选项', exact: true }).click()
    expect(await detail.getByText('DSH 插件工具', { exact: true }).count()).toBe(0)
    expect(await detail.getByLabel('环境变量', { exact: true }).inputValue()).toContain('VT_ACP_ENABLED=1')
    await page.screenshot({ path: join(root, '.local/registry-ui/manual-zh.png'), fullPage: true })
    await detail.getByRole('button', { name: '取消', exact: true }).click()
    await backToPluginList(detail, 'zh')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const currentSettings = page.getByRole('dialog', { name: '设置', exact: true })
    await currentSettings.getByRole('button', { name: '通用设置', exact: true }).click()
    await currentSettings.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    // Reload in English with the generic profile as the native default model.
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-my-fast', model: 'mock-model-a' })
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
