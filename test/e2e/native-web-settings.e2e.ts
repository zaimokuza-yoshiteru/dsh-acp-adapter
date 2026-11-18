import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { Locator, Page } from 'playwright'
import { connectFreshWorkspace } from '#host-support'
import { webSnapshotMode } from '#host-scaffold'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { backToPluginList, openAcpPluginDetail, returnToConversation } from './plugin-panel.helpers.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

const FLASH = 'DeepSeek-V4.1-Flash'
const MODEL_ID = 'deepseek-flash'
const ACP_PROVIDER = 'acp-codex'
const MESSAGES_ENDPOINT = 'https://messages.test/anthropic/v1'

/** Follow the same real Plugins navigation as the native settings owner. */
async function openPlugins(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.waitFor()
  const back = panel.getByRole('button', { name: 'Back to plugins', exact: true })
  while ((await back.count()) > 0) await back.first().click()
  await panel.locator('[data-plugin-item="web-search"]').waitFor()
  return panel
}

async function openWebSearch(page: Page): Promise<Locator> {
  const panel = await openPlugins(page)
  await panel.locator('[data-plugin-item="web-search"]').getByRole('button').first().click()
  const detail = panel.locator('[data-plugin-item-detail="web-search"]')
  await detail.locator('[data-plugin-config]').waitFor()
  return detail
}

async function openModels(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Select model/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  const menu = page.getByRole('menu', { name: 'Model', exact: true })
  await menu.waitFor()
  return menu
}

it('keeps native Search/Fetch settings and Flash labels independent of the loaded ACP adapter', async () => {
  if (webSnapshotMode() === 'record') throw new Error('This catalog-only UI scenario must never use record mode')
  const upstream = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
  // Reuse the owner's header-only, call-free catalog fixture. The real replay
  // service rejects any unexpected generation instead of invoking a model.
  const host = await launchAdapterWorld({
    replayFixture: join(upstream, 'apps/web/tests/fixtures/model-badge/session.v4.jsonl'),
    replayProvidersOnly: true,
    replayProviders: [
      // DSH 0.2.2 renders model badges from the catalog instead of a built-in Flash label.
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: MODEL_ID, name: FLASH, badge: { text: '1017', tone: 'info' } }],
      },
      { id: ACP_PROVIDER, name: 'ACP same-name fixture', models: [{ id: MODEL_ID, name: FLASH }] },
    ],
    extraPatches: [
      '- id: llm-deepseek-account\n  disabled: true\n',
      '- id: web-search-deepseek\n  config:\n    apiKeyEnv: DSH_E2E_WEB_SETTINGS_UNUSED_KEY\n',
      '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n',
    ],
  })
  let browser: TestBrowser | undefined
  let page: Page | undefined
  const evidence = process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/rc2-native-web-settings')
  mkdirSync(evidence, { recursive: true })
  const errors: string[] = []
  const unexpectedWork: string[] = []
  const disposeSessions = host.ctx.on('session/event', (_session, event) => {
    if (event.type === 'request/header') unexpectedWork.push('model-request')
  })
  const disposeTools = host.ctx.on('tools/result', (execution) => {
    unexpectedWork.push(`tool:${execution.name}`)
  })
  try {
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    const settingsDocument = () => readFileSync(join(host.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')
    const providerSelection = () => {
      const value = host.ctx.settings.describe().find((entry) => entry.ns === 'web')?.value as
        { searchProvider?: string; fetchProvider?: string } | undefined
      return value === undefined
        ? undefined
        : { searchProvider: value.searchProvider, fetchProvider: value.fetchProvider }
    }

    const inventory = await openPlugins(page)
    expect(await inventory.locator('[data-plugin-item="web-search"]').count()).toBe(1)
    expect(await inventory.locator('[data-plugin-package="@zaimokuza/dsh-acp-adapter"]').count()).toBe(1)
    let detail = await openWebSearch(page)
    const search = () => required(page).locator('#plugin-config-web-search-provider')
    const fetch = () => required(page).locator('#plugin-config-web-fetch-provider')
    const endpoint = () => required(page).locator('#plugin-config-web-search-endpoint')
    const count = () => required(page).getByLabel('Results per search', { exact: true })
    const save = () =>
      required(page)
        .locator('[data-plugin-item-detail="web-search"]')
        .getByRole('button', { name: 'Save', exact: true })
    const choose = async (menu: Locator, label: string) => {
      await menu.click()
      await required(page).getByRole('menuitem', { name: label, exact: true }).click()
    }
    // RC.2 owns independent capability menus. Its shipped defaults are Search
    // API + direct fetch; the API endpoint is YAML-only, not an editable field.
    expect(await search().textContent()).toBe('DeepSeek Search API')
    expect(await fetch().textContent()).toBe('Direct fetch')
    expect(providerSelection()).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
    expect(await endpoint().count()).toBe(0)
    expect(await count().inputValue()).toBe('10')
    expect(await save().isDisabled()).toBe(true)
    expect(settingsDocument()).not.toContain('searchProvider:')
    expect(await detail.getByRole('link', { name: 'Search & Fetch guide', exact: true }).getAttribute('href')).toBe(
      'https://api-docs.deepseek.com/guides/search',
    )

    await count().fill('51')
    await detail
      .getByText('Enter an integer from 1 to 50, or leave blank to use the default.', { exact: true })
      .waitFor()
    expect(await save().isDisabled()).toBe(true)
    expect(await search().isDisabled()).toBe(true)
    expect(await fetch().isDisabled()).toBe(true)
    await count().fill('10')
    await choose(search(), 'DeepSeek (legacy)')
    expect(providerSelection()).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
    expect(await detail.getByLabel('Base URL', { exact: true }).count()).toBe(1)
    expect(await detail.getByLabel('Maximum searches per request', { exact: true }).inputValue()).toBe('5')
    expect(await endpoint().inputValue()).toBe('')
    await endpoint().fill(MESSAGES_ENDPOINT)
    await save().click()
    await expect.poll(providerSelection).toEqual({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    await expect.poll(() => save().isDisabled()).toBe(true)
    expect(settingsDocument()).toContain(`baseURL: ${MESSAGES_ENDPOINT}`)

    await choose(search(), 'DeepSeek Search API')
    await count().fill('20')
    await choose(fetch(), 'DeepSeek Fetch API')
    expect(providerSelection()).toEqual({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    // Navigating away discards staged provider/field changes without writing.
    await detail.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    detail = await openWebSearch(page)
    expect(await search().textContent()).toBe('DeepSeek (legacy)')
    expect(await fetch().textContent()).toBe('Direct fetch')
    expect(await endpoint().inputValue()).toBe(MESSAGES_ENDPOINT)
    await choose(search(), 'DeepSeek Search API')
    expect(await count().inputValue()).toBe('10')
    await count().fill('20')
    await choose(fetch(), 'DeepSeek Fetch API')
    await choose(detail.locator('#plugin-config-web-fetch-billing'), 'DeepSeek API key')
    await save().click()
    await expect
      .poll(providerSelection)
      .toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    await expect.poll(() => save().isDisabled()).toBe(true)
    expect(settingsDocument()).toContain('searchProvider: deepseek-search-api')
    expect(settingsDocument()).toContain('fetchProvider: deepseek-fetch-api')
    expect(settingsDocument()).toContain('fetchBilling: api-key')
    expect(settingsDocument()).toContain('count: 20')
    await page.reload()
    detail = await openWebSearch(page)
    expect(await search().textContent()).toBe('DeepSeek Search API')
    expect(await fetch().textContent()).toBe('DeepSeek Fetch API')
    expect(await detail.locator('#plugin-config-web-fetch-billing').textContent()).toBe('DeepSeek API key')
    expect(await endpoint().count()).toBe(0)
    expect(await count().inputValue()).toBe('20')
    await page.screenshot({ path: join(evidence, 'native-search-fetch-settings.png'), animations: 'disabled' })

    await choose(fetch(), 'Direct fetch')
    await save().click()
    await expect.poll(providerSelection).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
    await expect.poll(() => save().isDisabled()).toBe(true)
    expect(await count().inputValue()).toBe('20')
    await choose(search(), 'DeepSeek (legacy)')
    expect(await endpoint().inputValue()).toBe(MESSAGES_ENDPOINT)
    expect(await detail.getByLabel('Maximum searches per request', { exact: true }).inputValue()).toBe('5')
    await save().click()
    await expect.poll(providerSelection).toEqual({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    await expect.poll(() => save().isDisabled()).toBe(true)
    await detail.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    const acp = await openAcpPluginDetail(page)
    await acp.locator('[data-dsh-acp-panel]').waitFor()
    expect(await acp.locator('[data-dsh-acp-panel]').count()).toBe(1)
    expect(await acp.getByRole('button', { name: 'Add Agent', exact: true }).count()).toBe(1)
    expect(await acp.locator('#plugin-config-web-search-provider, #plugin-config-web-fetch-provider').count()).toBe(0)
    expect(await acp.locator('#plugin-config-web-search-endpoint').count()).toBe(0)
    await backToPluginList(acp)
    await returnToConversation(page)

    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.getByText('1017', { exact: true }).waitFor()
    expect(await trigger.getAttribute('aria-label')).toBe(`Select model, current ${FLASH}`)
    let menu = await openModels(page)
    const officialLabel = () =>
      required(page)
        .getByRole('menu', { name: 'Model', exact: true })
        .locator('[data-provider-id="deepseek-official"][data-model-id="deepseek-flash"]')
    const acpLabel = menu.locator(`[data-provider-id="${ACP_PROVIDER}"][data-model-id="${MODEL_ID}"]`)
    expect(await officialLabel().getByText('1017', { exact: true }).count()).toBe(1)
    expect(await acpLabel.textContent()).toBe(FLASH)
    expect(await acpLabel.getByText('1017', { exact: true }).count()).toBe(0)
    await acpLabel.click()
    await expect
      .poll(() => host.ctx.agentDefaultModel.currentSelection())
      .toEqual({ provider: ACP_PROVIDER, model: MODEL_ID })
    await expect.poll(() => trigger.getByText('1017', { exact: true }).count()).toBe(0)
    expect(await trigger.textContent()).toContain(FLASH)
    for (const provider of ['deepseek-official', ACP_PROVIDER]) {
      expect((await host.ctx.llm.listModels(provider)).map(({ id, name }) => ({ id, name }))).toEqual([
        { id: MODEL_ID, name: FLASH },
      ])
    }
    menu = await openModels(page)
    await officialLabel().click()
    await expect
      .poll(() => host.ctx.agentDefaultModel.currentSelection())
      .toEqual({ provider: 'deepseek-official', model: MODEL_ID })

    await page.setViewportSize({ width: 390, height: 844 })
    const colors: Array<{ color: string; background: string }> = []
    for (const theme of ['light', 'dark'] as const) {
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => required(page).evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      menu = await openModels(page)
      const badge = officialLabel().getByText('1017', { exact: true })
      const box = required(await badge.boundingBox())
      expect(box.x).toBeGreaterThanOrEqual(12)
      expect(box.x + box.width).toBeLessThanOrEqual(378)
      const palette = await badge.evaluate((node) => {
        const style = getComputedStyle(node)
        return { color: style.color, background: style.backgroundColor }
      })
      expect(palette.color).not.toBe(palette.background)
      colors.push(palette)
      await page.screenshot({ path: join(evidence, `native-flash-1017-390-${theme}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect.poll(() => menu.isVisible()).toBe(false)
      await expect.poll(() => trigger.evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true)
    }
    expect(colors[0]).not.toEqual(colors[1])
    expect(host.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: MODEL_ID })
    expect(unexpectedWork).toEqual([])
    expect(errors).toEqual([])
  } catch (error) {
    await page
      ?.screenshot({ path: join(evidence, 'native-web-settings-failure.png'), animations: 'disabled' })
      .catch(() => undefined)
    throw error
  } finally {
    disposeTools()
    disposeSessions()
    await browser?.close()
    await host.close()
  }
}, 120_000)
