import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { connectFreshWorkspace } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'

it('hosts ACP configuration on the native bundle detail page', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const evidence = join(root, '.local/plugin-panel')
  const errors: string[] = []
  mkdirSync(evidence, { recursive: true })
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { devin: {
      name: 'Panel-fixture-with-a-very-long-unbroken-agent-display-name-to-check-natural-wrapping-and-horizontal-overflow',
      command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin' },
    } } })
    browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
    const page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const nativeSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    expect(await nativeSettings.getByRole('button', { name: 'ACP adapter', exact: true }).count()).toBe(0)
    await nativeSettings.getByRole('button', { name: 'Close', exact: true }).click()

    const detail = await openAcpPluginDetail(page)
    const iconSource = `data:image/svg+xml;base64,${readFileSync(join(root, 'icon.svg')).toString('base64')}`
    const artwork = detail.locator('img').filter({ visible: true }).first()
    await expect.poll(() => artwork.getAttribute('src')).toBe(iconSource)
    await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    await detail.locator('p').getByText('Add and manage agents available from the DSH session UI through ACP.', { exact: true }).waitFor()
    await detail.getByRole('heading', { name: 'Agent configuration', exact: true }).waitFor()
    const panel = detail.locator('[data-dsh-acp-panel]')
    await panel.getByText(/Panel-fixture-with-a-very-long-unbroken-agent-display-name/, { exact: false }).waitFor()
    expect(await panel.count()).toBe(1)
    expect(await detail.getByRole('heading', { name: 'ACP adapter', exact: true }).count()).toBe(1)
    expect(await panel.getByRole('heading', { name: 'ACP adapter', exact: true }).count()).toBe(0)
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
    expect(await detail.getByText(`v${version}`, { exact: true }).count()).toBe(1)
    expect(await panel.getByText(`v${version}`, { exact: true }).count()).toBe(0)
    await panel.getByRole('heading', { name: 'Interface preferences', exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, 'light.png'), fullPage: true, animations: 'disabled' })

    const card = panel.locator('[data-dsh-acp-agent="devin"]')
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    await detail.getByLabel('Display name', { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, 'edit.png'), fullPage: true, animations: 'disabled' })
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await card.waitFor()

    await panel.getByRole('button', { name: 'Add agent', exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    await page.screenshot({ path: join(evidence, 'menu.png'), fullPage: true, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    await host.ctx.settings.replace('ui-theme', { preference: 'dark' })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
    await page.screenshot({ path: join(evidence, 'dark.png'), fullPage: true, animations: 'disabled' })

    await page.setViewportSize({ width: 420, height: 900 })
    await page.locator('[data-sidebar-collapsed="true"]').waitFor()
    await expect.poll(() => detail.evaluate(element => element.clientWidth)).toBeGreaterThan(300)
    const geometry = await detail.evaluate(element => {
      const rows = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]
        .map(node => {
          const rect = node.getBoundingClientRect()
          return { tag: node.tagName, className: typeof node.className === 'string' ? node.className : '', text: (node.textContent ?? '').slice(0, 120), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, left: Math.round(rect.left), right: Math.round(rect.right) }
        })
        .filter(row => row.scrollWidth > row.clientWidth + 1 || row.left < 0 || row.right > document.documentElement.clientWidth)
      return { detail: { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }, document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }, offenders: rows }
    })
    writeFileSync(join(evidence, 'narrow-geometry.json'), JSON.stringify(geometry, null, 2))
    await page.screenshot({ path: join(evidence, 'narrow-before-assert.png'), fullPage: true, animations: 'disabled' })
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, 'narrow.png'), fullPage: true, animations: 'disabled' })
    expect(await panel.getByRole('checkbox', { name: 'Searchable model picker', exact: true }).isVisible()).toBe(true)

    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { devin: {
      name: '面板预览 Agent', command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin' },
    } } })
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.reload()
    const chineseDetail = await openAcpPluginDetail(page, 'zh')
    const chinesePanel = chineseDetail.locator('[data-dsh-acp-panel]')
    await chinesePanel.getByRole('heading', { name: 'Agent 配置', exact: true }).waitFor()
    await chinesePanel.getByRole('heading', { name: '界面偏好', exact: true }).waitFor()
    await chinesePanel.getByRole('checkbox', { name: '可搜索模型选择器', exact: true }).waitFor()
    await chineseDetail.locator('p').getByText('添加并管理通过 ACP 接入 DSH 会话页面的智能体。', { exact: true }).waitFor()
    expect(await chineseDetail.locator('img').first().getAttribute('src')).toBe(iconSource)
    await page.screenshot({ path: join(evidence, 'normal-zh.png'), fullPage: true, animations: 'disabled' })
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
