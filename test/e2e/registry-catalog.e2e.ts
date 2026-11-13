import type { AcpAgentConfig } from '../../src/contract/agent-config.ts'
import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { it, expect } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { expectCatalogMenuFits } from './catalog-menu.helpers.ts'
import { backToPluginList, openAcpPluginDetail, openNativeSettings } from './plugin-panel.helpers.ts'

it('adds catalog presets, preserves edited defaults, and runs a generic Agent through native UI', async () => {
  const host = await launchAdapterWorld()
  let browser!: TestBrowser
  try {
    for (const [language, path, heading] of [
      ['en-US', 'README.en.md', 'Install'],
      ['zh-CN', 'README.md', '安装'],
    ] as const) {
      const document = await host.ctx.pluginManager.readBundleDetail('@zaimokuza/dsh-acp-adapter', language)
      expect(document).toMatchObject({ status: 'found', origin: 'locale', path })
      if (document.status === 'found') expect(document.markdown).toContain(`\n## ${heading}\n`)
    }
    browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    let detail = await openAcpPluginDetail(page)
    await detail.getByRole('heading', { name: 'Install', exact: true }).waitFor()
    expect(await detail.getByRole('heading', { name: '安装', exact: true }).count()).toBe(0)
    const addButton = detail.getByRole('button', { name: 'Add Agent', exact: true })
    await addButton.click()
    const menu = page.getByRole('menu')
    await menu.getByText('Verified adapters · 6', { exact: true }).waitFor()
    await menu.getByText(/^Catalog entries · Unverified ·/).waitFor()
    expect(await detail.getByRole('textbox').count()).toBe(0)
    expect(await menu.getByRole('textbox').count()).toBe(0)
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.slice(0, 6).map((text) => text.split(' · ')[0])).toEqual([
      'Devin',
      'Codebuddy Code',
      'Codex',
      'Claude Agent',
      'Google Antigravity',
      'Qwen Code',
    ])
    const menuText = await menu.innerText()
    expect(menuText.indexOf('Qwen Code')).toBeGreaterThan(menuText.indexOf('Verified adapters · 6'))
    expect(menuText.indexOf('Qwen Code')).toBeLessThan(menuText.indexOf('Catalog entries · Unverified ·'))
    await menu.getByText('Adapter coverage does not certify every version or platform.', { exact: true }).waitFor()
    await menu.getByRole('menuitem', { name: /^Google Antigravity · 1\.1\.1$/ }).waitFor()
    const evidence = join(root, '.local/rc1-catalog-menu')
    mkdirSync(evidence, { recursive: true })
    mkdirSync(join(root, '.local/registry-ui'), { recursive: true })
    for (const viewport of [
      { width: 1680, height: 1000 },
      { width: 900, height: 600 },
      { width: 390, height: 500 },
    ]) {
      await page.setViewportSize(viewport)
      await expectCatalogMenuFits(menu)
      const rowsViewport = menu.locator(':scope > [role="presentation"]').first()
      expect(
        await rowsViewport.evaluate((element) => element.scrollHeight > element.clientHeight),
        `catalog rows should scroll within ${viewport.width}x${viewport.height}`,
      ).toBe(true)
      // Every entry stays in the native scrollport; its pinned footer remains
      // reachable even when the viewport clamp places the card over its anchor.
      await menu.getByRole('menuitem').first().focus()
      await page.keyboard.press('End')
      expect(
        await menu
          .getByRole('menuitem')
          .last()
          .evaluate((node) => node === document.activeElement),
      ).toBe(true)
      await expectCatalogMenuFits(menu)
      await page.screenshot({
        path: join(evidence, `menu-${viewport.width}x${viewport.height}.png`),
        animations: 'disabled',
      })
    }
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect(await addButton.evaluate((node) => node === document.activeElement)).toBe(true)
    await addButton.click()
    await menu.waitFor({ state: 'visible' })
    await addButton.evaluate((element) => element.scrollIntoView({ block: 'end' }))
    await expectCatalogMenuFits(menu)
    await page.screenshot({ path: join(evidence, 'menu-after-scroll.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    // Escape closes the foreground catalog menu; return to the Plugins inventory.
    await menu.waitFor({ state: 'hidden' })
    await detail.waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await backToPluginList(detail)
    detail = await openAcpPluginDetail(page)
    const select = async (name: string | RegExp) => {
      await detail.getByRole('button', { name: 'Add Agent', exact: true }).click()
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
    // Save stays usable and names the missing command instead of being silently disabled.
    await detail.getByRole('button', { name: 'Save', exact: true }).click()
    await detail.getByText('Executable must not be empty.', { exact: true }).waitFor()
    expect(await detail.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await detail.getByText('2 environment variables configured.', { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await detail.getByText('DSH plugin tools', { exact: true }).count()).toBe(0)
    expect(await detail.getByLabel('Environment', { exact: true }).inputValue()).toBe(
      'VT_ACP_ENABLED=1\nVT_ACP_ZED_ENABLED=1',
    )
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
    await page.getByRole('alert').filter({ hasText: 'Saved' }).waitFor()
    const saved = (
      host.ctx.settings.describe().find((row) => row.ns === 'dsh-acp-adapter')?.value as {
        agents: Record<string, AcpAgentConfig>
      }
    ).agents['my-fast']
    expect(saved.runtime).toBeUndefined()
    expect(saved.catalogId).toBe('fast-agent')
    expect(saved.env.FAST_AGENT_MODEL).toBe('my-choice')
    await detail.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await detail.getByLabel('Environment', { exact: true }).count()).toBe(0)
    await detail.getByRole('button', { name: 'Advanced options', exact: true }).click()
    expect(await detail.getByLabel('Environment', { exact: true }).inputValue()).toContain('FAST_AGENT_MODEL=my-choice')
    expect(await detail.getByLabel('Arguments', { exact: true }).inputValue()).toBe(
      join(root, 'test/mock-agent/mock-agent.ts'),
    )
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await backToPluginList(detail)
    const settings = await openNativeSettings(page)
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    detail = await openAcpPluginDetail(page, 'zh')
    await detail.getByRole('heading', { name: '安装', exact: true }).waitFor()
    expect(await detail.getByRole('heading', { name: 'Install', exact: true }).count()).toBe(0)
    await detail.getByRole('button', { name: '添加 Agent', exact: true }).click()
    await page.getByRole('menu').getByText('已验证适配 · 6', { exact: true }).waitFor()
    const chineseMenuText = await page.getByRole('menu').innerText()
    expect(chineseMenuText.indexOf('Qwen Code')).toBeGreaterThan(chineseMenuText.indexOf('已验证适配 · 6'))
    expect(chineseMenuText.indexOf('Qwen Code')).toBeLessThan(chineseMenuText.indexOf('目录收录 · 未验证 ·'))
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: /^Google Antigravity · 1\.1\.1$/ })
      .waitFor()
    await page
      .getByRole('menu')
      .getByText(/^目录收录 · 未验证 ·/)
      .waitFor()
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
    const currentSettings = await openNativeSettings(page, 'zh')
    await currentSettings.getByRole('button', { name: '通用设置', exact: true }).click()
    await currentSettings.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    // Reload in English with the generic profile as the native default model.
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-my-fast', model: 'mock-model-a' })
    const chat = page
    await chat.reload()
    const settled = host.whenTurnSettled(30_000)
    await writeComposerDraft(chat, chat.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await settled
    expect(
      required(
        required(host.ctx.sessions.get(id))
          .snapshotEvents()
          .findLast((event) => event.type === 'turn/end'),
      ).data.reason.kind,
    ).toBe('completed')
    detail = await openAcpPluginDetail(page)
    await detail.getByRole('heading', { name: 'Install', exact: true }).waitFor()
    expect(await detail.getByRole('heading', { name: '安装', exact: true }).count()).toBe(0)
    const profile = page.locator('[data-dsh-acp-agent="my-fast"]')
    await profile.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await profile.getByText(/^Delete Agent ".+"\? Its model route is removed with it\.$/).waitFor()
    await profile.getByRole('button', { name: 'Delete', exact: true }).last().click()
    await page.getByRole('alert').filter({ hasText: 'Deleted' }).waitFor()
    await backToPluginList(detail)
    await page.getByRole('alert').filter({ hasText: 'Deleted' }).waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
})
