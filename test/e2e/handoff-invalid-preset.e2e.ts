import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it('reuses the exact blank left by an inherited preset failing during model handoff', async () => {
  const host = await launchAdapterWorld()
  const { ctx } = host
  const preset = 'temporary-handoff-mode'
  let disposePreset: (() => Promise<void>) | undefined
  let browser: TestBrowser | undefined
  try {
    disposePreset = await ctx.agentPresets.register({ id: preset, name: 'Temporary mode', plugins: [] })
    await ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Handoff fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'codex' },
        },
      },
    })
    const provider = 'acp-codex'
    await expect.poll(() => ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true)
    await ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Temporary mode/ }).click()
    await page.getByRole('button', { name: 'Temporary mode', exact: true }).waitFor()
    const settled = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sourceId = await settled
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    const signal = new AbortController().signal
    const sessions = async () => (await ctx.sessionController.list({}, signal)).items.map((row) => row.sessionId)
    const before = await sessions()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('searchbox', { name: 'Search models…' }).fill('Mock Model B')
    await page.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Use this model in a new session' })
    await dialog.waitFor()
    // Change the real registry after the user's confirmation and any client-side roster check.
    let requested: SessionId | undefined
    const create = ctx.sessionController.create.bind(ctx.sessionController)
    vi.spyOn(ctx.sessionController, 'create').mockImplementationOnce(async (request) => {
      requested = required(request.sessionId)
      expect(request.agentPreset).toBe(preset)
      expect(request.workspaceId).toBeDefined()
      await disposePreset?.()
      disposePreset = await ctx.agentPresets.register({ id: preset, plugins: [{ name: '' }] })
      return create(request)
    })
    await dialog.getByRole('button', { name: 'Create an independent session with this model' }).click()
    const fallback = dialog.getByRole('button', { name: 'Create with the default mode', exact: true })
    await fallback.waitFor()
    const child = required(requested)
    expect((await ctx.sessionController.projections({ sessionId: child }, signal))?.values.agentPreset).toBe(preset)
    expect(ctx.agents.get(child)).toBeUndefined()
    await fallback.click()
    await dialog.getByRole('button', { name: 'Open the created session', exact: true }).click()
    await page.locator(`[data-conversation-session="${child}"]`).waitFor()
    await page.getByRole('button', { name: /^Select model, current Mock Model B/ }).waitFor()
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    expect((await sessions()).filter((id) => !before.includes(id))).toEqual([child])
    expect(ctx.agentPresets.presetForSession(required(ctx.sessions.get(sourceId)))).toBe(preset)
    expect(ctx.agentPresets.presetForSession(required(ctx.sessions.get(child)))).toBe('standard')
  } finally {
    vi.restoreAllMocks()
    await browser?.close()
    await disposePreset?.()
    await host.close()
  }
})
