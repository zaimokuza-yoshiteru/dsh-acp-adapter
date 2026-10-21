import type {} from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { required } from './required.ts'
import type { ObservedEvent } from './types.ts'
import type { Page } from 'playwright'

it('retains a committed report through a native settlement follow-up, folding, file preview and reload', async () => {
  const host = await launchAdapterWorld({
    ...(process.env.DSH_E2E_ADAPTER_DIRECTORY === undefined
      ? {}
      : { adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY }),
  })
  let browser: TestBrowser | undefined
  let failedPage: Page | undefined
  const events: ObservedEvent[] = []
  const errors: string[] = []
  const id = 'committed-replies'
  const baseline = process.env.DSH_E2E_REPLY_BASELINE === '1'
  const evidence = join(root, '.local/native-progressive-fix-20261021/committed-replies', baseline ? 'before' : 'after')
  mkdirSync(evidence, { recursive: true })
  const gate = join(host.workspaceCwd, `${id}-commit`)
  const pathEvidence = join(host.workspaceCwd, `${id}-path.json`)
  // connectFreshWorkspace creates and selects <root>/<name>, not the parent.
  const selectedWorkspace = join(host.workspaceCwd, 'committed-replies')
  const writtenPath = join(selectedWorkspace, 'report.md')
  const paths = () => ({
    scaffoldRoot: host.workspaceCwd,
    selectedWorkspace,
    writtenPath,
    writtenFileExists: existsSync(writtenPath),
    ...(existsSync(pathEvidence) ? (JSON.parse(readFileSync(pathEvidence, 'utf8')) as Record<string, unknown>) : {}),
  })
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('ui-chat', { transcriptView: 'standard', collapseTiming: 'completion' })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Committed response fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_COMMITTED_REPLY_GATE_DIR: host.workspaceCwd,
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-codex')).toBe(true),
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    failedPage = page
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd, 'committed-replies')
    writeFileSync(writtenPath, 'FILE_PREVIEW_OK\n')
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), `E2E_COMMITTED_REPORT ${id}`)
    const settled = host.whenTurnSettled(45_000)
    void settled.catch(() => {})
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const report = page.getByText(`MAIN_REPORT_${id}`, { exact: true })
    await report.waitFor()
    const input = required(
      events.find(
        (event) =>
          event.type === 'user/message' && JSON.stringify(event.data.content).includes(`E2E_COMMITTED_REPORT ${id}`),
      ),
    )
    const agent = required(host.ctx.agents.get(input.sessionId))
    writeFileSync(join(evidence, 'file-paths.json'), JSON.stringify(paths(), null, 2))
    expect(paths()).toMatchObject({ acpCwd: selectedWorkspace, linkedPath: writtenPath, writtenFileExists: true })
    const notice = createUserMessage({
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: 'test-child' as never,
        summary: 'Member finished',
      },
      content: [{ type: 'text', text: `E2E_COMMITTED_RECEIPT ${id}` }],
    })
    // The real parent inbox admits this notice after the held ACP response ends.
    // Nothing is deduplicated, skipped or forcibly finalized by the adapter.
    agent.send(notice, 'next-step', false)
    writeFileSync(gate, 'queued')
    const sessionId = await settled
    const receipt = page.getByText(`LATE_RECEIPT_${id}`, { exact: true })
    await receipt.waitFor()
    const control = page.locator('[data-turn-process="1"]')
    await expect.poll(() => control.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => report.isVisible()).toBe(!baseline)
    expect(await report.count()).toBe(1)
    expect(await receipt.count()).toBe(1)
    const log = events.filter((event) => event.sessionId === sessionId)
    expect(log.filter((event) => event.type === 'step/start')).toHaveLength(2)
    expect(log.filter((event) => event.type === 'assistant/message')).toHaveLength(2)
    expect(log.filter((event) => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
    await page.screenshot({ path: join(evidence, 'standard-completion.png'), fullPage: true })
    writeFileSync(
      join(evidence, 'default-collapse.json'),
      JSON.stringify(
        {
          baseline,
          reportVisible: await report.isVisible(),
          receiptVisible: await receipt.isVisible(),
          processCollapsed: (await control.getAttribute('aria-expanded')) === 'false',
          events: log.map((event) => ({ type: event.type, seq: event.seq })),
        },
        null,
        2,
      ),
    )
    if (baseline) {
      await control.click()
      await report.waitFor()
      await page.screenshot({ path: join(evidence, 'expanded-report.png'), fullPage: true })
      return
    }
    const reportSeat = report.locator('xpath=ancestor::*[@data-chat-node-key][1]')
    const originalKey = await reportSeat.getAttribute('data-chat-node-key')
    expect(await reportSeat.getAttribute('data-turn-process-member')).toBeNull()
    expect(await page.locator('[data-turn-tail="1"]').count()).toBe(1)
    const footer = page.locator('[data-turn-tail="1"]')
    expect(await footer.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(1)
    // The latest native answer still owns one footer; earlier replies do not
    // gain synthetic copy/branch actions or impersonate the closing message.
    const clipboard: string[] = []
    await page.exposeFunction('captureReplyCopy', (value: string) => clipboard.push(value))
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            (window as unknown as { captureReplyCopy: (value: string) => Promise<void> }).captureReplyCopy(value),
        },
      })
    })
    await footer.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => clipboard.at(-1)).toBe(`LATE_RECEIPT_${id}`)

    await page.getByText('Review file', { exact: true }).click()
    const preview = page.locator('[data-rightbar-col] [data-textpreview-state="text"]')
    await preview.waitFor()
    await expect.poll(() => preview.innerText()).toContain('FILE_PREVIEW_OK')
    await page.screenshot({ path: join(evidence, 'native-file-preview.png'), fullPage: true })
    // On narrow windows the native preview intentionally covers the chat.
    // Return through its actual UI before certifying transcript visibility.
    await page.locator('[data-rightbar-col] [data-sidebar-right-toggle]').click()
    await expect.poll(() => page.locator('[data-sidebar-right-open]').count()).toBe(0)
    await page.reload()
    await report.waitFor()
    await receipt.waitFor()
    expect(await reportSeat.getAttribute('data-chat-node-key')).toBe(originalKey)

    // These are the existing Host settings, exercised without new UI options.
    for (const transcriptView of ['compact', 'standard', 'detailed', 'verbose']) {
      for (const collapseTiming of ['completion', 'next-input']) {
        await host.ctx.settings.replace('ui-chat', { transcriptView, collapseTiming })
        await expect.poll(() => report.isVisible()).toBe(true)
        expect(await receipt.isVisible()).toBe(true)
        expect(await report.count()).toBe(1)
        expect(await reportSeat.getAttribute('data-chat-node-key')).toBe(originalKey)
        await page.screenshot({ path: join(evidence, `${transcriptView}-${collapseTiming}.png`), fullPage: true })
      }
    }
    await host.ctx.settings.replace('ui-chat', { transcriptView: 'standard', collapseTiming: 'next-input' })
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), `E2E_COMMITTED_NEXT ${id}`)
    const nextSettled = host.whenTurnSettled(30_000)
    void nextSettled.catch(() => {})
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await nextSettled
    await page.getByText(`NEXT_TURN_${id}`, { exact: true }).waitFor()
    await expect.poll(() => control.getAttribute('aria-expanded')).toBe('false')
    expect(await report.isVisible()).toBe(true)
    expect(await receipt.isVisible()).toBe(true)

    const geometry: unknown[] = []
    for (const width of [1680, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      for (const preference of ['light', 'dark']) {
        await host.ctx.settings.replace('ui-theme', { preference })
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(preference)
        await report.scrollIntoViewIfNeeded()
        await expect
          .poll(() =>
            report.evaluate((element) => {
              const box = element.getBoundingClientRect()
              const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              return target !== null && element.contains(target)
            }),
          )
          .toBe(true)
        const boxes = await Promise.all(
          [report, receipt, page.getByText('Review file', { exact: true })].map((locator) => locator.boundingBox()),
        )
        for (const box of boxes) {
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(-2)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 2)
          expect(box!.height).toBeGreaterThan(0)
        }
        expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height)
        geometry.push({ width, preference, boxes })
        await page.screenshot({ path: join(evidence, `${width}-${preference}.png`), animations: 'disabled' })
      }
    }
    writeFileSync(join(evidence, 'geometry.json'), JSON.stringify(geometry, null, 2))
    expect(errors).toEqual([])
  } catch (error) {
    writeFileSync(
      join(evidence, 'failure-paths.json'),
      JSON.stringify(
        {
          ...paths(),
          error: String(error),
          assistantMessages: events.filter((event) => event.type === 'assistant/message').map((event) => event.data),
        },
        null,
        2,
      ),
    )
    if (failedPage !== undefined && !failedPage.isClosed()) {
      await failedPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
      writeFileSync(join(evidence, 'failure.txt'), await failedPage.locator('body').innerText())
    }
    throw error
  } finally {
    writeFileSync(gate, 'cleanup')
    await browser?.close()
    await host.close()
  }
})
