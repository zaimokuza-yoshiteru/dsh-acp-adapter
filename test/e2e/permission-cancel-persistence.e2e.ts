import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it.each([false, true])('retains the answer after Reject and reload (remote cancels: %s)', async (remoteCancels) => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        rejection: {
          name: 'Rejection regression',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          ...(remoteCancels ? { runtime: 'codebuddy' } : {}),
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'permission-flow',
            MOCK_CANCEL_AFTER_REJECT: remoteCancels ? '1' : '0',
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-rejection')).toBe(true),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-rejection', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(
      page,
      page.locator('[data-composer-input]').first(),
      'Request the approval test operation.',
    )
    const settled = host.whenTurnSettled(30_000)
    void settled.catch(() => undefined)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const approval = page.locator('[data-approval-key]').filter({ hasText: 'echo hello' }).first()
    await approval.waitFor({ state: 'visible' })
    const evidence = join(root, '.local/reject-persistence-2026-10-06', remoteCancels ? 'cancelled' : 'continued')
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'before-reject.png'), fullPage: true })
    await approval.getByRole('button', { name: 'Reject', exact: true }).click()
    const sessionId = await settled
    const session = host.ctx.sessions.get(sessionId)!
    const events = session.snapshotEvents()
    const messages = events.filter((event) => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages[0]!.data.message.content)).toContain('I need to run a shell command.')
    if (remoteCancels) {
      expect(messages[0]!.data.interrupted).toBe(true)
      expect(events.findLast((event) => event.type === 'turn/end')!.data.reason.kind).toBe('aborted')
    } else {
      expect(JSON.stringify(messages[0]!.data.message.content)).toContain('Permission denied.')
      expect(events.findLast((event) => event.type === 'turn/end')!.data.reason.kind).toBe('completed')
    }
    expect(events.filter((event) => event.type === 'request/header')).toHaveLength(1)
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      // A completed native turn folds intermediate text into its process group.
      // Open the ordinary controls before checking that retained text is readable.
      const process = page.locator('[data-turn-process-tool-calls]').first()
      await process.waitFor({ state: 'visible' })
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click()
      for (const step of await page.locator('[data-step-process] > div > button').all()) {
        if ((await step.isVisible()) && (await step.getAttribute('aria-expanded')) === 'false') await step.click()
      }
      await page.getByText('I need to run a shell command.', { exact: false }).first().waitFor({ state: 'visible' })
      expect(await page.getByText('ACP prompt was cancelled', { exact: false }).count()).toBe(0)
      expect(await page.getByText('This turn failed', { exact: false }).count()).toBe(0)
      expect(await page.locator('[data-approval-key]').count()).toBe(0)
      await page.screenshot({ path: join(evidence, reload ? 'after-reload.png' : 'after-reject.png'), fullPage: true })
    }
  } finally {
    await browser?.close()
    await host.close()
  }
})
