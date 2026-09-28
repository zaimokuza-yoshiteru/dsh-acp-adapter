import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import type { Locator, Page } from 'playwright'
import { launchAdapterWorld, root } from './scaffold.ts'
import { backToPluginList, openAcpPluginDetail, returnToConversation } from './plugin-panel.helpers.ts'

const pickerSelector = '[data-acp-searchable-model-picker]'
const nativeProvider = 'native-picker'

async function pickerStyles(trigger: Locator, row: Locator, label: Locator) {
  const [triggerStyle, rowStyle, labelStyle] = await Promise.all([
    trigger.evaluate(element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight,
        width: rect.width, height: rect.height, maxWidth: style.maxWidth,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, gap: style.gap,
      }
    }),
    row.evaluate(element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return { height: rect.height, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, gap: style.gap }
    }),
    label.evaluate(element => {
      const style = getComputedStyle(element)
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
    }),
  ])
  return { trigger: triggerStyle, row: rowStyle, label: labelStyle }
}

function expectPickerStylesMatch(native: Awaited<ReturnType<typeof pickerStyles>>, custom: Awaited<ReturnType<typeof pickerStyles>>) {
  expect(custom.trigger).toEqual(native.trigger)
  expect(custom.row).toEqual(native.row)
  expect(custom.label).toEqual(native.label)
}

/** Minimal regular DSH provider with a real reasoning-effort model contract. */
class SearchEffortProvider extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Native picker fixture' } }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'native-model', name: 'Native Model' },
      { provider, id: 'native-model-b', name: 'Native Model B' },
    ])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model === 'native-model-b' ? 'Native Model B' : 'Native Model',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'E2E_NATIVE_DONE' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'E2E_NATIVE_DONE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('opts into searchable model selection and restores the native picker when disabled', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  let page!: Page
  let pageReady = false
  let phase = 'setup'
  const evidence = join(root, '.local/searchable-model-picker')
  mkdirSync(evidence, { recursive: true })
  try {
    const provider = 'acp-devin'
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { devin: {
      name: 'Fixture devin',
      command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: {
        HOME: host.workspaceCwd,
        MOCK_SCENARIO: 'regression',
        MOCK_PROFILE: 'devin',
        MOCK_MODEL_THOUGHT_LEVELS: JSON.stringify({
          'mock-model-a': ['low', 'high'],
          'mock-model-b': ['low', 'medium', 'high'],
        }),
      },
    } } })
    await expect.poll(() => host.ctx.llm.listProviders().some(route => route.id === provider)).toBe(true)
    host.ctx.effect(() => host.ctx.llm.registerAdapter([nativeProvider], new SearchEffortProvider()))
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })

    browser = await launchBrowser({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
    page = await newEnglishPage(browser)
    pageReady = true
    const originalViewport = page.viewportSize()
    page.setDefaultTimeout(10_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    const send = async (text: string): Promise<string> => {
      const settled = host.whenTurnSettled(30_000)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      return await settled
    }
    const sessionId = await send('E2E_MESSAGE')
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^Select model/ }).waitFor()

    // The persisted default is off: the real stock trigger and menu remain mounted.
    expect(await page.locator(pickerSelector).count()).toBe(0)
    const stockTrigger = page.getByRole('button', { name: /^Select model/ })
    await stockTrigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const nativeModelRow = page.getByLabel('Fixture devin · ACP', { exact: true }).getByRole('menuitemradio', { name: 'Mock Model A', exact: true })
    await nativeModelRow.waitFor()
    const nativeModelLabel = nativeModelRow.getByText('Mock Model A', { exact: true })
    const nativeStyles = await pickerStyles(stockTrigger, nativeModelRow, nativeModelLabel)
    await page.screenshot({ path: join(evidence, 'native-model-picker-en.png') })
    writeFileSync(join(evidence, 'native-model-picker-styles.json'), `${JSON.stringify(nativeStyles, null, 2)}\n`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    phase = 'plugin detail default off'
    const settings = await openAcpPluginDetail(page)
    const toggle = settings.getByRole('checkbox', { name: 'Searchable model picker', exact: true })
    expect(await toggle.isChecked()).toBe(false)
    await page.screenshot({ path: join(evidence, 'off-plugin-detail.png'), fullPage: true })
    await toggle.click()
    await expect.poll(() => toggle.isChecked()).toBe(true)
    await expect.poll(() => {
      const section = host.ctx.settings.describe().find(row => row.ns === 'dsh-acp-adapter')?.value as { searchableModelPicker?: boolean } | undefined
      return section?.searchableModelPicker
    }).toBe(true)
    await backToPluginList(settings)
    await returnToConversation(page, sessionId)
    await expect.poll(() => page.locator(pickerSelector).count()).toBe(1)

    phase = 'search and selection'
    const picker = page.locator(pickerSelector)
    const trigger = picker.getByRole('button')
    expect(await trigger.getAttribute('aria-label')).toBe('Mock Model A')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Model', exact: true })
    const search = dialog.getByRole('searchbox', { name: 'Search model name, ID, or provider', exact: true })
    await search.waitFor()
    const customModelRow = dialog.getByRole('menuitemradio', { name: 'Mock Model A', exact: true })
    await customModelRow.waitFor()
    const customModelLabel = customModelRow.getByText('Mock Model A', { exact: true })
    const customStyles = await pickerStyles(trigger, customModelRow, customModelLabel)
    expectPickerStylesMatch(nativeStyles, customStyles)
    writeFileSync(join(evidence, 'searchable-model-picker-styles.json'), `${JSON.stringify(customStyles, null, 2)}\n`)
    await page.screenshot({ path: join(evidence, 'searchable-model-picker-en.png') })
    await page.screenshot({ path: join(evidence, 'on-search.png'), fullPage: true })

    await search.fill('Mock Model B')
    await dialog.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => dialog.getByRole('menuitemradio').count()).toBe(1)
    await page.screenshot({ path: join(evidence, 'search-results.png'), fullPage: true })

    await search.fill('mock-model-b')
    await dialog.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).waitFor({ state: 'visible' })
    await search.fill(provider)
    await expect.poll(() => dialog.getByRole('menuitemradio').count()).toBe(3)
    await search.fill('no-such-model-or-provider')
    await dialog.getByText('No matching models.', { exact: true }).waitFor({ state: 'visible' })

    // Enter, Escape and ArrowDown during IME composition must not select, close,
    // or steal focus from the search field.
    await search.fill(provider)
    await expect.poll(() => dialog.getByRole('menuitemradio').count()).toBe(3)
    await search.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      for (const key of ['Enter', 'Escape', 'ArrowDown']) input.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key, keyCode: 229, which: 229, isComposing: true, bubbles: true,
      }))
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await dialog.waitFor({ state: 'visible' })
    expect(await search.evaluate(input => input === document.activeElement)).toBe(true)
    expect(await trigger.getAttribute('aria-label')).toBe('Mock Model A')

    // ArrowDown moves across actual rows; Enter selects the second result.
    await search.press('ArrowDown')
    const results = dialog.getByRole('menuitemradio')
    const firstResult = results.nth(0)
    const secondResult = results.nth(1)
    await expect.poll(() => firstResult.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await trigger.getAttribute('aria-label')).toBe('Mock Model A')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => secondResult.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await trigger.getAttribute('aria-label')).toBe('Mock Model A')
    await page.keyboard.press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.getAttribute('aria-label')).toBe('Mock Model B')
    // Devin's specialized runtime intentionally exposes no reasoning switch.
    await trigger.click()
    expect(await dialog.getByRole('button', { name: 'Reasoning effort', exact: true }).isEnabled()).toBe(false)
    await page.keyboard.press('Escape')

    // A fresh, ordinary DSH-provider session verifies effort controls separately.
    await host.ctx.agentDefaultModel.saveSelection({ provider: nativeProvider, model: 'native-model', reasoningEffort: ReasoningEffortId('low') })
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const nativeSession = await send('E2E_NATIVE_PICKER')
    expect(nativeSession).toBeTruthy()
    await page.getByText('E2E_NATIVE_DONE', { exact: true }).waitFor()
    await expect.poll(() => picker.getByRole('button').getAttribute('aria-label')).toBe('Native Model')
    await picker.getByRole('button').click()
    const nativeDialog = page.getByRole('dialog', { name: 'Model', exact: true })
    const nativeSearch = nativeDialog.getByRole('searchbox', { name: 'Search model name, ID, or provider', exact: true })
    await nativeSearch.fill(nativeProvider)
    await expect.poll(() => nativeDialog.getByRole('menuitemradio').count()).toBe(2)
    await expect.poll(() => nativeDialog.getByRole('button', { name: 'Reasoning effort', exact: true }).isEnabled()).toBe(true)
    await nativeDialog.getByRole('button', { name: 'Reasoning effort', exact: true }).click()
    await nativeDialog.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    await nativeDialog.waitFor({ state: 'hidden' })
    await expect.poll(() => picker.getByRole('button').getAttribute('title')).toMatch(/High/)

    // Both the opt-in and selected model survive a page reload.
    phase = 'reload persistence'
    await page.reload()
    await expect.poll(() => page.locator(pickerSelector).count()).toBe(1)
    const reloadedTrigger = page.locator(pickerSelector).getByRole('button')
    await expect.poll(() => reloadedTrigger.getAttribute('aria-label')).toBe('Native Model')
    await expect.poll(() => reloadedTrigger.getAttribute('title')).toMatch(/High/)

    phase = 'Chinese model picker copy'
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    await page.reload()
    await page.locator(pickerSelector).getByRole('button').click()
    const chineseDialog = page.getByRole('dialog', { name: '模型', exact: true })
    const chineseSearch = chineseDialog.getByRole('searchbox', { name: '搜索模型名称、ID 或提供商', exact: true })
    await chineseSearch.fill('no-such-model-or-provider')
    await chineseDialog.getByText('没有匹配的模型。', { exact: true }).waitFor()
    await chineseDialog.getByRole('button', { name: '推理等级', exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, 'search-zh.png'), fullPage: true })
    await chineseSearch.fill(nativeProvider)
    const narrowModel = chineseDialog.getByRole('menuitemradio', { name: 'Native Model', exact: true })
    await narrowModel.waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 740, height: 800 })
    await expect.poll(async () => {
      const bounds = await chineseDialog.boundingBox()
      return bounds !== null && bounds.x >= 0 && bounds.y >= 0
        && bounds.x + bounds.width <= 740 && bounds.y + bounds.height <= 800
    }).toBe(true)
    expect(await narrowModel.isVisible()).toBe(true)
    await page.screenshot({ path: join(evidence, 'searchable-model-picker-zh-narrow.png') })
    if (originalViewport !== null) await page.setViewportSize(originalViewport)
    await page.keyboard.press('Escape')
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await page.reload()

    phase = 'plugin detail disable'
    const updatedSettings = await openAcpPluginDetail(page)
    const updatedToggle = updatedSettings.getByRole('checkbox', { name: 'Searchable model picker', exact: true })
    expect(await updatedToggle.isChecked()).toBe(true)
    await updatedToggle.click()
    await expect.poll(() => updatedToggle.isChecked()).toBe(false)
    await expect.poll(() => {
      const section = host.ctx.settings.describe().find(row => row.ns === 'dsh-acp-adapter')?.value as { searchableModelPicker?: boolean } | undefined
      return section?.searchableModelPicker
    }).toBe(false)
    await backToPluginList(updatedSettings)
    await returnToConversation(page, nativeSession)

    // Confirm this is the stock DSH UI again and that its model rows still select.
    const restoredTrigger = page.getByRole('button', { name: /^Select model, current Native Model, reasoning effort High$/ })
    await restoredTrigger.waitFor({ state: 'visible' })
    expect(await restoredTrigger.getAttribute('aria-label')).toBe('Select model, current Native Model, reasoning effort High')
    await page.screenshot({ path: join(evidence, 'off-native.png'), fullPage: true })
    await restoredTrigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Native Model B', exact: true }).click()
    await page.getByRole('button', { name: /^Select model, current Native Model B/ }).waitFor({ state: 'visible' })
    expect(await page.locator(pickerSelector).count()).toBe(0)
    expect(errors).toEqual([])
  } catch (error) {
    if (pageReady) {
      const prefix = join(evidence, 'failure')
      const captures = await Promise.allSettled([
        page.locator('body').innerText().then(body => writeFileSync(`${prefix}.txt`, `${phase}\n${body}\n\n${String(error)}\n`)),
        page.screenshot({ path: `${prefix}.png`, fullPage: true, timeout: 5000 }),
      ])
      for (const capture of captures) if (capture.status === 'rejected') console.warn('Could not save searchable picker failure evidence:', capture.reason)
    }
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
})
