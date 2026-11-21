import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { prepareLiveDevinEnvironment } from './live-devin-environment.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { required } from './required.ts'
import { launchAdapterWorld } from './scaffold.ts'

const cases = [
  { agent: 'antigravity', id: 'antigravity-acp', label: 'Google Antigravity', model: 'gemini-3.8-flash' },
  { agent: 'codebuddy', id: 'codebuddy-code', label: 'Codebuddy Code', model: 'hy4flash-free' },
  { agent: 'devin', id: 'devin', label: 'Devin', model: 'swe-2-high' },
] as const
const selected = process.env.DSH_E2E_LIVE_CATALOG
if (selected !== undefined && !cases.some(({ agent }) => agent === selected))
  throw new Error('DSH_E2E_LIVE_CATALOG must select antigravity, codebuddy or devin')

for (const { agent, id, label, model } of cases) {
  it.skipIf(selected !== agent)(
    `adds ${label} from the catalog and completes a real first turn`,
    async () => {
      const host = await launchAdapterWorld()
      let browser: TestBrowser | undefined
      let environment: Awaited<ReturnType<typeof prepareLiveDevinEnvironment>> | undefined
      try {
        if (agent === 'devin') {
          environment = await prepareLiveDevinEnvironment('existing', {})
          for (const [key, value] of Object.entries(environment.env)) vi.stubEnv(key, value)
        } else if (agent === 'codebuddy') {
          vi.stubEnv('CODEBUDDY_CONFIG_DIR', join(host.workspaceCwd, 'codebuddy-config'))
          vi.stubEnv('WORKBUDDY_CONFIG_DIR', join(host.workspaceCwd, 'workbuddy-config'))
        }
        browser = await launchBrowser({ headless: true })
        const page = await newEnglishPage(browser)
        const capture = async (state: string) => {
          const directory = process.env.DSH_E2E_EVIDENCE_DIR
          if (directory) {
            mkdirSync(directory, { recursive: true })
            await page.screenshot({ path: join(directory, `${agent}-${state}.png`) })
          }
        }
        await page.goto(host.authenticatedUrl)
        const detail = await openAcpPluginDetail(page)
        await detail.getByRole('button', { name: 'Add Agent', exact: true }).click()
        await page.getByRole('menuitem', { name: new RegExp(`^${label}(?: ·|$)`) }).click()
        await capture('add')
        await detail.getByRole('button', { name: 'Save', exact: true }).click()
        const row = detail.locator(`[data-dsh-acp-agent="${id}"]`)
        await row.getByText('Check passed', { exact: true }).waitFor({ timeout: 90_000 })
        await capture('ready')

        const provider = `acp-${id}`
        expect((await host.ctx.llm.listModels(provider)).some((entry) => entry.id === model)).toBe(true)
        await host.ctx.agentDefaultModel.saveSelection({
          provider,
          model,
          ...(agent === 'antigravity' ? { reasoningEffort: ReasoningEffortId('low') } : {}),
        })
        const requestSessions: string[] = []
        host.ctx.on('llm/stream', (request, next) => {
          if (request.purpose === undefined) {
            requestSessions.push(required(request.sessionId))
            expect(requestSessions).toHaveLength(1)
            expect(request.provider).toBe(provider)
            expect(request.model).toBe(model)
            if (agent === 'antigravity') expect(request.reasoningEffort).toBe('low')
          }
          return next()
        })
        await page.reload()
        await connectFreshWorkspace(page, host.workspaceCwd)
        const number = 10 + Math.floor(Math.random() * 89)
        const answer = String(number + 17)
        await writeComposerDraft(
          page,
          page.locator('[data-composer-input]').first(),
          `What is ${number} plus 17? Reply with the number only. Do not use tools.`,
        )
        const settled = host.whenTurnSettled(90_000)
        void settled.catch(() => {})
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        const sessionId = await settled
        const session = required(host.ctx.sessions.get(sessionId))
        expect(requestSessions).toEqual([sessionId])
        const remote = host.ctx.get('dshAcp') as AcpRemoteService
        const snapshot = await remote.agentSessionSnapshot(sessionId)
        expect(snapshot).toMatchObject({ sessionId, profileId: id, freshness: 'live' })
        expect(snapshot.configOptions).toContainEqual(
          expect.objectContaining({ category: 'model', currentValue: model }),
        )
        if (agent === 'antigravity')
          expect(snapshot.configOptions).toContainEqual(
            expect.objectContaining({ category: 'thought_level', currentValue: 'low' }),
          )
        const events = session.snapshotEvents()
        expect(events.findLast((event) => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
        const message = required(events.findLast((event) => event.type === 'assistant/message'))
        expect(
          message.data.message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
            .trim(),
        ).toBe(answer)
        await page.reload()
        const reply = page.locator(
          `[data-conversation-session="${sessionId}"] [data-chat-flow-kind="assistant-step"]:visible`,
        )
        await reply.getByText(answer, { exact: true }).waitFor()
        await capture('reply')
      } finally {
        try {
          await browser?.close()
        } finally {
          try {
            await host.close()
          } finally {
            vi.unstubAllEnvs()
            await environment?.dispose()
          }
        }
      }
    },
    240_000,
  )
}
