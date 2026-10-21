/** Opt-in: one real Codex parent, one zero-inference native child and one wait. */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, expandOwningTurnProcess, writeComposerDraft } from '#host-support'
import type { AcpRemoteService } from '../../src/remote/service.js'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import type { ObservedEvent } from './types.ts'

class NativeCourier extends LlmAdapter {
  constructor(private readonly released: Promise<void>) {
    super()
  }
  providerInfo(id: string) {
    return { id, name: 'Scripted native wait courier' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'No inference' }]
  }
  async *stream(): ReturnType<LlmAdapter['stream']> {
    await this.released
    const text = 'NATIVE_WAIT_COURIER_FINISHED'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(process.env.DSH_E2E_LIVE_CODEX_WAIT !== '1')(
  'real Codex retains the Host wait receipt and naturally receives the queued peer reply',
  async (context) => {
    const directory = process.env.DSH_E2E_LIVE_CODEX_WAIT_DIRECTORY ?? join(root, '.local/live-codex-wait')
    mkdirSync(directory, { recursive: true })
    const model = required(
      process.env.DSH_E2E_LIVE_CODEX_MODEL,
      'Choose the authorized low-cost Codex model explicitly',
    )
    const command = process.env.DSH_E2E_LIVE_CODEX_COMMAND ?? 'codex-acp'
    const args: unknown = JSON.parse(process.env.DSH_E2E_LIVE_CODEX_ARGS ?? '[]')
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
      throw new Error('Codex args must be a string array')
    const wirePath = join(directory, 'wait-wire.jsonl')
    if (existsSync(wirePath)) throw new Error('Use a fresh evidence directory for each live Codex run')
    const evidence: Record<string, unknown> = {
      parent: 'real codex-acp',
      child: 'scripted native DSH subagent (no inference)',
      model,
      reasoningEffort: 'low',
      command,
      args,
      wirePath,
    }
    const events: ObservedEvent[] = []
    const routes: unknown[] = []
    const executions: { name: string; isError: boolean }[] = []
    let host: AdapterWorld | undefined
    let browser: TestBrowser | undefined
    let page: Page | undefined
    let releasePeer = () => {}
    const released = new Promise<void>((resolve) => {
      releasePeer = resolve
    })
    let cleanupPromise: Promise<void> | undefined
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        releasePeer()
        try {
          writeFileSync(
            join(directory, 'evidence.json'),
            JSON.stringify({ ...evidence, routes, events, executions }, null, 2),
          )
        } finally {
          try {
            await browser?.close()
          } finally {
            await host?.close()
          }
        }
      })())
    context.onTestFinished(cleanup)
    try {
      host = await launchAdapterWorld({ teams: true, adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
      const activeHost = host
      host.ctx.effect(() => host!.ctx.llm.registerAdapter(['wait-courier'], new NativeCourier(released)))
      const selectedEnvKeys = (process.env.DSH_E2E_LIVE_CODEX_ENV_KEYS ?? '').split(',').filter(Boolean)
      const env = Object.fromEntries(
        selectedEnvKeys.map((key) => [key, required(process.env[key], `Missing selected env key ${key}`)]),
      )
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'auto',
        agents: {
          codex: {
            name: 'Real Codex wait check',
            command: process.execPath,
            args: [join(root, 'test/e2e/fixtures/codex-wait-wire-wrapper.mjs'), command, ...args],
            env: { ...env, DSH_WAIT_WIRE_PATH: wirePath },
          },
        },
      })
      await vi.waitFor(() => expect(activeHost.ctx.llm.listProviders().some((p) => p.id === 'acp-codex')).toBe(true))
      expect((await host.ctx.llm.listModels('acp-codex')).some((entry) => entry.id === model)).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({
        provider: 'acp-codex',
        model,
        reasoningEffort: ReasoningEffortId('low'),
      })
      await host.ctx.settings.replace('ui-chat', { transcriptView: 'standard', collapseTiming: 'next-input' })
      host.ctx.on('session/event', (session, event) => {
        events.push({ sessionId: session.id, ...event })
      })
      host.ctx.on('tools/result', (execution, result) => {
        executions.push({ name: execution.name, isError: result.isError })
      })
      let queued = false
      host.ctx.on('llm/stream', async function* (request, next) {
        routes.push({
          provider: request.provider,
          model: request.model,
          sessionId: request.sessionId,
          reasoningEffort: request.reasoningEffort,
        })
        if (!queued && request.provider === 'acp-codex' && request.purpose === undefined) {
          queued = true
          const parent = required(activeHost.ctx.agents.get(request.sessionId as never))
          evidence.parentId = parent.id
          const activation = await activeHost.ctx.subagents.startActivation({
            provider: 'spawn',
            label: 'Native wait courier',
            delivery: 'caller',
            request: {
              parent,
              agentOptions: { provider: 'wait-courier', model: 'fixture' },
              prompt: [{ type: 'text', text: 'Hold for native relay acceptance, then finish.' }],
            },
            signal: context.signal,
          })
          const child = required(activeHost.ctx.agents.get(activation.childId))
          evidence.childId = child.id
          evidence.relayId = await activeHost.ctx.subagents.sendMessage(
            child,
            parent.id,
            [{ type: 'text', text: 'CODEX_WAIT_PEER_REPLY: Reply with CODEX_WAIT_RECEIVED and do not call tools.' }],
            { signal: context.signal },
          )
          evidence.queuedBeforeAcpPrompt = parent.inbox.nextStep.map((message) => ({
            id: message.id,
            source: message.source,
            content: message.content,
          }))
          expect(JSON.stringify(evidence.queuedBeforeAcpPrompt)).toContain('CODEX_WAIT_PEER_REPLY')
          releasePeer()
          evidence.childResult = await activation.result
        }
        yield* next()
      })
      browser = await launchBrowser({ headless: true, channel: process.env.DSH_E2E_BROWSER_CHANNEL })
      page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'This is a bounded UI check. On the current DSH MCP connection in the latest host instructions, discover only the exact wait_agent tool if needed and call it exactly once with {"timeout_ms":10000}. Do not enumerate the full tool catalog, read/write files, run a shell, spawn agents or repeat the wait. Whether it returns a deferred reply or an error, finish this response immediately with CODEX_WAIT_RETURNED. On a subsequent peer reply, acknowledge its marker without using any tool.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page
        .getByText(/CODEX_WAIT_RECEIVED/)
        .last()
        .waitFor({ timeout: 120_000 })
      const parent = required(host.ctx.agents.get(String(evidence.parentId) as never))
      await parent.whenIdle()
      const relayIndex = events.findIndex(
        (event) => event.sessionId === parent.id && event.type === 'user/message' && event.data.id === evidence.relayId,
      )
      expect(relayIndex).toBeGreaterThanOrEqual(0)
      const responseTexts = events.flatMap((event, index) =>
        event.sessionId === parent.id && event.type === 'assistant/message'
          ? [
              {
                index,
                text: event.data.message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join(''),
              },
            ]
          : [],
      )
      evidence.responses = responseTexts
      expect(
        responseTexts.some((response) => response.index > relayIndex && response.text.includes('CODEX_WAIT_RECEIVED')),
      ).toBe(true)
      const service = host.ctx.get('dshAcp') as AcpRemoteService
      const snapshot = await service.activitySnapshot(parent.id, { limit: 100 })
      const rows = await Promise.all(
        snapshot.activities.filter((row) => row.kind === 'tool').map((row) => service.activityDetail(parent.id, row)),
      )
      evidence.activities = rows
      evidence.wire = existsSync(wirePath)
        ? readFileSync(wirePath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
      const waits = rows.filter((row) => JSON.parse(row.rawDetail ?? '{}').toolName === 'wait_agent')
      expect(waits).toHaveLength(1)
      const wait = required(waits[0])
      expect(executions).toEqual([])
      expect(wait.status).toBe('failed')
      expect(JSON.parse(required(wait.rawDetail))).toMatchObject({
        hostControlOutcome: { source: 'dsh-tool-bridge', kind: 'deferred-team-message', executed: false },
      })
      const control = page.locator('[data-disclosure-row][role="button"]').filter({ hasText: 'Wait for team reply' })
      await control.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, control)
      if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click()
      const body = page.locator('[data-acp-host-control="deferred-team-message"]')
      expect(await body.innerText()).toContain('A team reply is queued.')
      expect(await body.innerText()).not.toMatch(/DSH_WAIT_|End this ACP|structuredContent|zaimokuza.dsh\/acp-control/)
      expect(wait.rawDetail).toContain('DSH_WAIT_DEFERRED_TEAM_MESSAGE:')
      await page.screenshot({ path: join(directory, 'real-codex-wide.png'), fullPage: true, animations: 'disabled' })
      await page.reload()
      await control.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, control)
      if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click()
      await page.screenshot({
        path: join(directory, 'real-codex-restored-wide.png'),
        fullPage: true,
        animations: 'disabled',
      })
      const ends = events.filter((event) => event.sessionId === parent.id && event.type === 'turn/end')
      expect(ends.length).toBeGreaterThan(0)
      expect(ends.every((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
      evidence.result = 'passed'
    } catch (error) {
      evidence.result = 'failed'
      evidence.error = error instanceof Error ? error.stack : String(error)
      if (existsSync(wirePath))
        evidence.wire = readFileSync(wirePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      if (page)
        await page.screenshot({ path: join(directory, 'failure-wide.png'), fullPage: true }).catch(() => undefined)
      throw error
    } finally {
      await cleanup()
    }
  },
  180_000,
)
