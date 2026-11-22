import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

class HandoffSource extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Handoff source' }
  }
  override async listModels(provider: string) {
    return ['source-model', 'other-default'].map((id) => ({ provider, id, name: id }))
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = options.messages.some(
      (m) => m.role === 'user' && m.source?.kind === 'acp-handoff' && m.source.part === 'summary',
    )
    yield {
      type: 'text-delta',
      index: 0,
      text: summary ? 'Generated brief containing SOURCE_ONLY' : 'Source session ready.',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('hands off the edited document once, preserves the source draft and never selects the target as the default', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  try {
    const provider = 'handoff-fixture'
    const log = join(host.workspaceCwd, 'handoff-target.log')
    host.ctx.effect(() => host.ctx.llm.registerAdapter([provider], new HandoffSource()))
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Handoff target',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_PROFILE: 'codex', MOCK_SCENARIO: 'regression', MOCK_LOG: log },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((route) => route.id === 'acp-codex')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'source-model' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    const trace: string[] = []
    const evidence = process.env.DSH_E2E_EVIDENCE_DIR
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      page.on('pageerror', (err) => trace.push(err.message))
      page.on('response', (response) => {
        if (!response.url().includes('/api/dshAcp/handoff')) return
        void response
          .json()
          .then((frame) => {
            const result = frame.result
            trace.push(
              JSON.stringify({
                command: response.request().postDataJSON().payload.args.command.kind,
                phase: result?.value?.phase,
                target: result?.value?.destinationSessionId,
                error: result?.error?.code,
                message: result?.error?.message,
              }),
            )
            writeFileSync(join(evidence, 'handoff-rpcs.jsonl'), trace.join('\n'))
          })
          .catch(() => {})
      })
    }
    async function checkLayout(surface: 'switch' | 'editor') {
      const panel =
        surface === 'switch'
          ? page.getByRole('dialog', {
              name: /Changing Agents requires an independent session|切换 Agent 需要独立会话/,
            })
          : page.locator('[data-acp-handoff-editor]')
      const pointer = await page.context().newCDPSession(page)
      try {
        for (const width of [1360, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 920 })
          await pointer.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 })
          for (const lang of ['zh', 'en']) {
            const zh = lang === 'zh'
            await host.ctx.settings.replace('locale', { preference: lang })
            const theme = zh && width === 390 ? 'dark' : 'light'
            await host.ctx.settings.replace('ui-theme', { preference: theme })
            await expect
              .poll(() => page.evaluate(() => globalThis.document.documentElement.style.colorScheme))
              .toBe(theme)
            const action = panel.getByRole('button', {
              name: surface === 'switch' ? (zh ? '新建空白会话' : 'Start a blank session') : zh ? '发送' : 'Send',
              exact: true,
            })
            await action.waitFor()
            if (surface === 'editor') {
              await panel.getByText(zh ? /交接给 .*Mock Model B/ : /Handoff to .*Mock Model B/).waitFor()
              const field = panel.getByRole('textbox', { name: zh ? '交接文档' : 'Handoff document', exact: true })
              if (width === 390) {
                expect(
                  await field.evaluate(
                    (el) => matchMedia('(pointer: coarse)').matches && parseFloat(getComputedStyle(el).fontSize) >= 16,
                  ),
                ).toBe(true)
              }
            }
            const bounds = await action.boundingBox()
            expect(
              bounds &&
                bounds.x >= 0 &&
                bounds.x + bounds.width <= width &&
                bounds.y >= 0 &&
                bounds.y + bounds.height <= (page.viewportSize()?.height ?? 0),
            ).toBe(true)
            expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
            if (evidence)
              await page.screenshot({
                path: join(evidence, `handoff-${surface}-${lang}-${width}-${theme}.png`),
                animations: 'disabled',
              })
          }
        }
      } finally {
        await pointer.send('Emulation.setTouchEmulationEnabled', { enabled: false })
        await pointer.detach()
        await page.setViewportSize({ width: 1360, height: 920 })
      }
    }
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const settled = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Please discuss SOURCE_ONLY.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sourceId = await settled
    await page.getByText('Source session ready.', { exact: true }).waitFor()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'My unsent source draft')
    const originalDefault = { provider, model: 'other-default' }
    await host.ctx.agentDefaultModel.saveSelection(originalDefault)
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Changing Agents requires an independent session' })
    const handoff = dialog.getByRole('button', { name: 'Hand off session', exact: true })
    await handoff.hover()
    await page.getByRole('tooltip').filter({ hasText: 'review and edit' }).waitFor()
    await dialog.getByRole('button', { name: 'Start a blank session', exact: true }).waitFor()
    await checkLayout('switch')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().focus()
    await page.keyboard.press('Tab')
    expect(await handoff.evaluate((el) => globalThis.document.activeElement === el)).toBe(true)
    await page.keyboard.press('Enter')
    const editor = page.locator('[data-acp-handoff-editor]')
    const document = editor.getByRole('textbox', { name: 'Handoff document' })
    try {
      await expect.poll(() => document.inputValue({ timeout: 10000 })).toBe('Generated brief containing SOURCE_ONLY')
    } catch (error) {
      if (evidence) {
        await page.screenshot({ path: join(evidence, 'handoff-editor-failure.png') })
        writeFileSync(join(evidence, 'handoff-editor-failure.txt'), await page.locator('body').innerText())
      }
      throw error
    }
    await checkLayout('editor')
    let failedSaves = 0
    await page.route('**/api/dshAcp/handoff', async (route) => {
      if (route.request().postDataJSON()?.payload?.args?.command?.kind !== 'save') return route.continue()
      failedSaves++
      await route.abort('connectionreset')
    })
    await document.fill('SHARED_BRIEF')
    const retrySave = editor.getByRole('button', { name: 'Retry save', exact: true })
    await retrySave.waitFor()
    // Navigation must not discard the most recent edit while persistence is unavailable.
    await editor.getByRole('button', { name: 'View original session', exact: true }).click()
    await expect.poll(() => failedSaves).toBeGreaterThan(1)
    expect(await document.inputValue()).toBe('SHARED_BRIEF')
    await page.unroute('**/api/dshAcp/handoff')
    await retrySave.click()
    await editor.getByRole('checkbox').uncheck()
    const save = page.waitForResponse(
      (response) =>
        response.url().includes('/api/dshAcp/handoff') &&
        response.request().postDataJSON()?.payload?.args?.command?.kind === 'save' &&
        response.request().postDataJSON()?.payload?.args?.command?.instruction === 'Only review the tests.',
    )
    await editor.getByRole('textbox', { name: /what should happen next/i }).fill('Only review the tests.')
    expect((await (await save).json()).result.value.document).toBe('SHARED_BRIEF')
    await page.reload()
    await expect.poll(() => document.inputValue()).toBe('SHARED_BRIEF')
    expect(await editor.getByRole('checkbox').isChecked()).toBe(false)
    expect(await editor.getByRole('textbox', { name: /what should happen next/i }).inputValue()).toBe(
      'Only review the tests.',
    )

    let dropped = false
    await page.route('**/api/dshAcp/handoff', async (route) => {
      if (dropped || route.request().postDataJSON()?.payload?.args?.command?.kind !== 'send') return route.continue()
      const response = await route.fetch()
      expect((await response.json()).result.value.phase).toBe('queued')
      dropped = true
      await route.abort('connectionreset')
    })
    await editor.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    expect(dropped).toBe(true)
    const input = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('regression prompt='))
    expect(input).toHaveLength(1)
    expect(input[0]).toContain('SHARED_BRIEF')
    expect(input[0]).toContain('Only review the tests.')
    expect(input[0]).not.toContain('SOURCE_ONLY')
    expect(input[0]).not.toContain('My unsent source draft')
    await page.getByRole('button', { name: 'View original session', exact: true }).click()
    const source = page.locator('[data-conversation-session="' + sourceId + '"]')
    expect(await source.locator('[data-composer-input]').innerText()).toBe('My unsent source draft')
    expect(host.ctx.agentDefaultModel.currentSelection()).toEqual(originalDefault)
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120000)
