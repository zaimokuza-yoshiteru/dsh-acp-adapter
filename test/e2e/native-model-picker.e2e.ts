import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

class SearchFixture extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Search fixture' }
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'one', name: 'Model One' },
      { provider, id: 'two', name: 'Model Two' },
      { provider, id: 'three', name: 'Model Three' },
      { provider, id: 'four', name: 'Model Four' },
      { provider, id: 'five', name: '中文实验模型' },
    ])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model === 'five' ? '中文实验模型' : model })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'NATIVE_SEARCH_DONE' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('uses DSH native model search, IME-safe keyboard selection and ACP reasoning levels', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  try {
    const evidenceDir = process.env.DSH_E2E_EVIDENCE_DIR
    const logDir = evidenceDir ?? join(root, '.local/rc2-adaptation/evidence')
    mkdirSync(logDir, { recursive: true })
    const agentLog = resolve(logDir, 'native-model-picker-agent.log')
    const capture = async (page: import('playwright').Page, name: string): Promise<void> => {
      if (evidenceDir !== undefined) await page.screenshot({ path: join(evidenceDir, name), animations: 'disabled' })
    }
    const provider = 'acp-codex'
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Fixture codex',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_LOG: agentLog,
            MOCK_MODEL_THOUGHT_LEVELS: JSON.stringify({
              'mock-model-a': ['low', 'high'],
              'mock-model-b': ['low', 'high'],
            }),
          },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((route) => route.id === provider)).toBe(true)
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['native-search-fixture'], new SearchFixture()))
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (text: string) => {
      const settled = host.whenTurnSettled(30_000)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      return settled
    }
    const sessionId = await send('E2E_MESSAGE')
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const search = page.getByRole('searchbox', { name: 'Search models…', exact: true })
    await search.waitFor()
    await capture(page, 'native-search-pane.png')
    await search.fill('中文')
    const chineseModel = page.getByRole('menuitemradio', { name: '中文实验模型', exact: true })
    await chineseModel.waitFor()
    await capture(page, 'native-search-results.png')
    await search.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
    })
    await search.waitFor()
    await page.getByRole('button', { name: /^Select model, current Mock Model A/ }).waitFor()
    await search.fill('Mock Model B')
    await page.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).waitFor()
    await search.press('ArrowDown')
    await search.press('Enter')
    const selected = page.getByRole('button', { name: /^Select model, current Mock Model B/ })
    await selected.waitFor()
    await expect.poll(() => selected.getAttribute('aria-expanded')).toBe('false')
    await selected.click()
    await page.getByRole('menuitem', { name: /^Effort/ }).click()
    await capture(page, 'native-reasoning-levels.png')
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    expect(await send('E2E_MESSAGE_AFTER_NATIVE_SELECTION')).toBe(sessionId)
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    const selectedTurn = readFileSync(agentLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('E2E_MESSAGE_AFTER_NATIVE_SELECTION'))
    expect(selectedTurn).toContain('model=mock-model-b thought_level=high')
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
