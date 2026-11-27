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

it('hands off the generated summary automatically once, preserves the source draft and never selects the target as the default', async () => {
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
    // Lose the first dispatched delivery acknowledgement. The next poll must
    // open the same destination without submitting another first message.
    let dropped = false
    await page.route('**/api/dshAcp/handoff', async (route) => {
      if (dropped || route.request().postDataJSON()?.payload?.args?.command?.kind !== 'status') return route.continue()
      const response = await route.fetch()
      if ((await response.json()).result?.value?.phase !== 'queued') return route.fulfill({ response })
      dropped = true
      return route.abort('connectionreset')
    })
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    expect(dropped).toBe(true)
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.locator('[data-acp-handoff-editor]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'View original session', exact: true }).count()).toBe(0)
    const destination = page.locator('[data-conversation-session]:visible').first()
    expect(await destination.locator('[data-turn-trigger]').count()).toBe(0)
    const visible = await destination.innerText()
    expect(visible).not.toContain('read_handoff_history')
    expect(visible).not.toContain('{"document"')
    expect(visible).not.toContain(sourceId)
    const input = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('regression prompt='))
    expect(input).toHaveLength(1)
    expect(input[0]).toContain('Generated brief containing SOURCE_ONLY')
    expect(input[0]).toContain('read_handoff_history')
    expect(input[0]).not.toContain('My unsent source draft')
    await page.locator('[data-row-key="session:' + sourceId + '"]').click()
    const source = page.locator('[data-conversation-session="' + sourceId + '"]')
    await source.getByText('Generated brief containing SOURCE_ONLY', { exact: true }).waitFor()
    expect(await source.locator('[data-turn-trigger]').count()).toBe(0)
    expect(await source.locator('[data-composer-input]').innerText()).toBe('My unsent source draft')
    expect(host.ctx.agentDefaultModel.currentSelection()).toEqual(originalDefault)
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120000)
