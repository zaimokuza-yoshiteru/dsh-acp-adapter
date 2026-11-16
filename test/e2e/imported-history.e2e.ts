import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

const title = 'Bus route from the imported chat'
const firstMessage = 'Which bus goes to the museum?'
const reply = 'Take the number 12 bus.'
const nativeProvider = 'native-import-fixture'

function archive(): Uint8Array<ArrayBuffer> {
  const time = '2026-11-12T10:00:00Z'
  const index = { id: 'bus', inserted_at: time, updated_at: time }
  const json = (value: unknown) => strToU8(JSON.stringify(value))
  return new Uint8Array(
    zipSync({
      'manifest.json': json({ export_format_version: 3 }),
      'chat_session_index.json': json([index]),
      'chat_sessions/bus.json': json({
        ...index,
        title,
        messages: [
          {
            id: 1,
            parent_id: null,
            role: 'USER',
            status: 'FINISHED',
            inserted_at: time,
            fragments: [{ type: 'REQUEST', content: firstMessage }],
          },
          {
            id: 2,
            parent_id: 1,
            role: 'ASSISTANT',
            status: 'FINISHED',
            inserted_at: time,
            fragments: [{ type: 'RESPONSE', content: reply }],
          },
        ],
      }),
    }),
  )
}

class NativeImportFixture extends LlmAdapter {
  receivedHistory = false
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'local', name: 'Native import model' }])
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const history = options.messages.flatMap((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text))
    this.receivedHistory = history.includes(firstMessage) && history.includes(reply)
    yield { type: 'text-delta', index: 0, text: 'Native continuation arrived.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('keeps an imported history and its draft when the Host default is ACP', async () => {
  const host = await launchAdapterWorld({ optionalBundles: ['deepseek-chat-import'] })
  let browser: TestBrowser | undefined
  try {
    const { workspace } = await host.ctx.workspaceController.create({ path: host.workspaceCwd })
    const response = await host.hostFetch(
      `/api/deepseek-chat-import/archive?workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: archive(),
      },
    )
    expect(response.status).toBe(200)
    const outcome = JSON.parse((await response.text()).trim().split('\n').at(-1)!)
    expect(outcome).toMatchObject({ type: 'outcome', outcome: { ok: true, value: { skipped: [] } } })
    const [sourceId] = outcome.outcome.value.sessionIds as string[]
    const native = new NativeImportFixture()
    host.ctx.effect(() => host.ctx.llm.registerAdapter([nativeProvider], native))
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Fixture Codex',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'codex' },
        },
      },
    })
    const acp = { provider: 'acp-codex', model: 'mock-model-a' }
    await expect.poll(() => host.ctx.llm.listProviders().some((p) => p.id === acp.provider)).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection(acp)
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(host.authenticatedUrl)
    const sourceRow = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    await sourceRow.click()
    const dock = page.locator('[data-acp-unrouted-history]')
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await page.getByText(reply, { exact: true }).first().waitFor()
    await dock.getByRole('button', { name: 'Create an independent session' }).waitFor()
    const draft = 'Is there a faster route?'
    await writeComposerDraft(page, input, draft)
    expect(host.ctx.agentDefaultModel.currentSelection()).toMatchObject(acp)
    const evidence = process.env.DSH_E2E_EVIDENCE_DIR
    for (const lang of ['en', 'zh'] as const) {
      await host.ctx.settings.replace('locale', { preference: lang })
      await page.setViewportSize({ width: 390, height: 844 })
      const action = dock.getByRole('button', {
        name: lang === 'en' ? 'Create an independent session' : '新建独立会话',
        exact: true,
      })
      await action.waitFor()
      // Playwright's default visibility check also accepts offscreen, clipped and
      // covered elements. Verify both actions and guidance where the screenshot is taken.
      const hittable = () =>
        dock.evaluate(async (element) => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          return (
            [...element.querySelectorAll('button, span')]
              .filter((part) => part.textContent?.trim())
              .every((part) => {
                const box = part.getBoundingClientRect()
                const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  box.left >= 0 &&
                  box.right <= innerWidth &&
                  box.top >= 0 &&
                  box.bottom <= innerHeight &&
                  hit !== null &&
                  part.contains(hit)
                )
              }) && document.documentElement.scrollWidth <= innerWidth
          )
        })
      await expect.poll(hittable).toBe(true)
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await page.screenshot({ path: join(evidence, `imported-history-${lang}-390.png`), animations: 'disabled' })
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await dock.getByRole('button', { name: 'Create an independent session' }).click()
    await expect.poll(() => dock.count()).toBe(0)
    await expect.poll(() => input.innerText()).not.toContain(draft)
    expect(host.ctx.agentDefaultModel.currentSelection()).toMatchObject(acp)
    await sourceRow.click()
    await dock.waitFor()
    await expect.poll(() => input.innerText()).toContain(draft)
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('searchbox', { name: 'Search models…' }).fill('Native import model')
    await page.getByRole('menuitemradio', { name: 'Native import model', exact: true }).click()
    await expect.poll(() => dock.count()).toBe(0)
    expect(await input.innerText()).toContain(draft)
    const settled = host.whenTurnSettled()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(sourceId)
    await page.getByText('Native continuation arrived.', { exact: true }).waitFor()
    expect(native.receivedHistory).toBe(true)
    expect(errors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await host.close()
    }
  }
}, 120_000)
