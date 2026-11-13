import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { ACP_PACKAGE, returnToConversation } from './plugin-panel.helpers.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { required } from './required.ts'

/** Assert the native discovery action opens the existing bundle entry, not a second ACP settings surface. */
async function openAcpFromNativeMore(page: Page): Promise<void> {
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
  await menu.waitFor({ state: 'detached' })
  const card = page.locator(`[data-plugin-package="${ACP_PACKAGE}"]`)
  await card.waitFor({ state: 'visible' })
  expect(await card.count()).toBe(1)
  await card.getByRole('button').first().click()
  const detail = page.locator(`[data-plugin-detail="${ACP_PACKAGE}"]`)
  await detail.waitFor({ state: 'visible' })
  await detail.getByRole('heading', { name: 'Agent configuration', exact: true }).waitFor()
  expect(await detail.count()).toBe(1)
  expect(await detail.locator('[data-dsh-acp-panel]').count()).toBe(1)
}

it('keeps ACP drafts and diagnostics scoped through alpha.2 native navigation without extra ACP work', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const createdSessions: string[] = []
  host.ctx.on('session/created', (session) => {
    createdSessions.push(session.id)
  })
  const agentLog = join(host.workspaceCwd, 'navigation-agent.log')
  const promptCount = (): number =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('--> session/prompt ').length - 1 : 0
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        codex: {
          name: 'Navigation fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((route) => route.id === 'acp-codex')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1680, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const capture = async (name: string): Promise<void> => {
      const directory = process.env.DSH_E2E_EVIDENCE_DIR
      if (directory === undefined) return
      mkdirSync(directory, { recursive: true })
      await page.screenshot({ path: join(directory, name), animations: 'disabled' })
    }
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const conversation = page.locator('[data-conversation-session]:visible').first()
    const sessionId = required(await conversation.getAttribute('data-conversation-session'))
    const createdBeforeNavigation = [...createdSessions]
    const draft = 'E2E_MESSAGE\nKeep this unsent ACP draft.'
    const input = page.locator('[data-composer-input][contenteditable="true"]:visible').first()
    // The upstream typing helper treats a newline as Enter (send). Enter the
    // multiline draft through the native line-break shortcut instead.
    await writeComposerDraft(page, input, 'E2E_MESSAGE')
    await input.press('Shift+Enter')
    await page.keyboard.type('Keep this unsent ACP draft.')
    await expect.poll(() => input.innerText()).toBe(draft)
    expect(promptCount()).toBe(0)
    // The sidecar is created lazily at binding. Check UI now and the complete
    // durable approval history after the first turn below.
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)

    // Native New Session returns to the existing blank. ACP must not replace
    // that native draft owner, create a duplicate session, or send the draft.
    await page
      .getByRole('navigation', { name: 'Global panels', exact: true })
      .getByRole('button', { name: 'More', exact: true })
      .click()
    await openAcpFromNativeMore(page)
    await capture('native-more-acp-detail-wide.png')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await input.waitFor({ state: 'visible' })
    await expect.poll(() => conversation.getAttribute('data-conversation-session')).toBe(sessionId)
    await expect.poll(() => input.innerText()).toBe(draft)
    await page.getByRole('button', { name: /^Select model, current Mock Model A/ }).waitFor()
    await expect.poll(() => [...createdSessions]).toEqual(createdBeforeNavigation)
    expect(promptCount()).toBe(0)
    // The sidecar is created lazily at binding. Check UI now and the complete
    // durable approval history after the first turn below.
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)
    await capture('native-new-session-preserved-draft-wide.png')

    // Establish the binding through the real ACP process; the stable diagnostic
    // registration becomes visible to this Session only after verification.
    const settled = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(sessionId)
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'ACP Diagnostics', exact: true }).waitFor()
    expect(promptCount()).toBe(1)

    await page.getByRole('button', { name: 'More conversation views', exact: true }).click()
    await openAcpFromNativeMore(page)
    await returnToConversation(page, sessionId)
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const guide = page.locator('[data-rightbar-col] [data-sidebar-right-guide]')
    await guide.waitFor({ state: 'visible' })
    await guide.getByRole('button', { name: 'More tools', exact: true }).click()
    await openAcpFromNativeMore(page)
    await returnToConversation(page, sessionId)
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()

    // The native width budget folds later Views. The adapter's Session-visible
    // View must remain selectable through More, without its own menu.
    await page.setViewportSize({ width: 390, height: 844 })
    const moreViews = page.getByRole('button', { name: 'More conversation views', exact: true })
    await moreViews.click()
    await page.getByRole('menuitem', { name: 'ACP Diagnostics', exact: true }).click()
    const diagnostics = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await diagnostics.waitFor({ state: 'visible' })
    // RC.4 keeps the launcher label fixed even while its active View is folded.
    await expect.poll(() => moreViews.getAttribute('aria-label')).toBe('More conversation views')
    await page.setViewportSize({ width: 1680, height: 1000 })
    const diagnosticsTab = page.getByRole('tab', { name: 'ACP Diagnostics', exact: true })
    await diagnosticsTab.waitFor({ state: 'visible' })
    await expect.poll(() => diagnosticsTab.getAttribute('aria-selected')).toBe('true')
    await capture('native-acp-diagnostics-wide.png')
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await expect.poll(() => [...createdSessions]).toEqual(createdBeforeNavigation)
    expect(promptCount()).toBe(1)
    expect(acpPermissionAudit(host, 'asked')).toHaveLength(0)
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)

    // Keep Diagnostics selected while switching to genuine native history.
    // This independent local adapter performs one deterministic native turn.
    const nativeRoute = 'native-navigation-fixture'
    const nativeModel = 'native-navigation-model'
    const nativeReply = 'E2E_NATIVE_NAVIGATION_DONE'
    const nativeCalls: Array<{ provider: string; model: string }> = []
    class NativeFixture extends LlmAdapter {
      override providerInfo(id: string) {
        return { id, name: 'Native navigation fixture' }
      }
      override async listModels(provider: string) {
        return [{ provider, id: nativeModel, name: 'Native Navigation Model' }]
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        nativeCalls.push({ provider: options.provider, model: options.model })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: nativeReply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: nativeReply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    host.ctx.effect(() => host.ctx.llm.registerAdapter([nativeRoute], new NativeFixture()))
    await diagnosticsTab.click()
    await diagnostics.waitFor({ state: 'visible' })
    await host.ctx.agentDefaultModel.saveSelection({ provider: nativeRoute, model: nativeModel })
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.getByText('Into the Unknown', { exact: true }).waitFor()
    await expect.poll(() => conversation.getAttribute('data-conversation-session')).not.toBe(sessionId)
    const nativeSessionId = required(await conversation.getAttribute('data-conversation-session'))
    await page.getByRole('button', { name: /^Select model, current Native Navigation Model/ }).waitFor()
    expect(nativeCalls).toHaveLength(0)
    expect(promptCount()).toBe(1)

    const nativeSettled = host.whenTurnSettled(30_000)
    await writeComposerDraft(page, input, 'Check native navigation visibility')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await nativeSettled).toBe(nativeSessionId)
    const nativeSession = required(host.ctx.sessions.get(SessionId(nativeSessionId)))
    expect(nativeSession.header.isSeeded).not.toBe(true)
    expect(nativeSession.requestHeader()?.config).toMatchObject({ provider: nativeRoute, model: nativeModel })
    await conversation.getByText(nativeReply, { exact: true }).waitFor()
    await expect.poll(() => diagnosticsTab.count()).toBe(0)
    await diagnostics.waitFor({ state: 'hidden' })
    await capture('native-session-hides-acp-diagnostics.png')
    expect(nativeCalls).toEqual([{ provider: nativeRoute, model: nativeModel }])
    expect(promptCount()).toBe(1)

    await returnToConversation(page, sessionId)
    await diagnosticsTab.waitFor({ state: 'visible' })
    await expect.poll(() => diagnosticsTab.getAttribute('aria-selected')).toBe('true')
    await diagnostics.waitFor({ state: 'visible' })
    await capture('native-return-restores-acp-diagnostics.png')
    expect(nativeCalls).toEqual([{ provider: nativeRoute, model: nativeModel }])
    expect(promptCount()).toBe(1)
    expect(errors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await host.close()
    }
  }
}, 120_000)
