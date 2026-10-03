import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CDPSession, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import {
  longTurnSpec,
  LONG_CONVERSATION_TURNS,
  LONG_FLOW_DELIVERY,
  LONG_FLOW_FILE,
} from '../mock-agent/long-conversation-script.ts'
import type { LongTurnKind } from '../mock-agent/long-conversation-script.ts'

declare global {
  interface Window {
    __DSH_ACP_RENDER_COUNTS__?: Record<string, number>
    __DSH_ACP_RENDER_PROBE__?: (key: string) => void
    __LONG_FLOW_METRICS__?: { batches: number; records: number; observer?: MutationObserver }
  }
}

const DEBUG_TURNS = 12
const LONG_MODE = process.env.DSH_E2E_LONG_FLOW === '1'
const TURN_COUNT = LONG_MODE ? LONG_CONVERSATION_TURNS : DEBUG_TURNS
const EVIDENCE = join(root, '.local/long-flow-comparison-2026-10-03')
const MOCK_LOG = join(EVIDENCE, 'acp-agent.log')
const NATIVE_RELEASE = join(EVIDENCE, 'native-control-release-last')
const ACP_RELEASE = join(EVIDENCE, 'acp-devin-release-last')
const NATIVE_FINISH_RELEASE = join(EVIDENCE, 'native-control-release-finish')
const ACP_FINISH_RELEASE = join(EVIDENCE, 'acp-devin-release-finish')
const NATIVE_HISTORY_RELEASE = join(EVIDENCE, 'native-control-release-history')
const ACP_HISTORY_RELEASE = join(EVIDENCE, 'acp-devin-release-history')

interface Metrics {
  readonly turns: number
  readonly browserNodes: number
  readonly browserNodeGrowth: number
  readonly heapBytes: number
  readonly heapGrowthBytes: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly styleMs: number
  readonly mutationBatches: number
  readonly mutationRecords: number
}

interface RunEvidence {
  readonly provider: string
  readonly sessionId: string
  readonly turns: number
  readonly snapshots: Record<string, string>
  readonly checkpoints: Metrics[]
  readonly earlyRenderCounts: Record<string, number>
  readonly renderDuringTail: Record<
    string,
    {
      mountedAtFirstDelta: boolean
      mountedBeforeFinish: boolean
      mountedAfterSettled: boolean
      firstDeltaCount: number
      beforeFinishCount: number
      afterSettledCount: number
    }
  >
  readonly toolKinds: Record<string, { visible: boolean; output?: string; isError?: boolean }>
  readonly limitations: string[]
  readonly events: SessionEvent[]
  readonly performanceBaseline: {
    browserNodes: number
    heapBytes: number
    scriptMs: number
    layoutMs: number
    styleMs: number
  }
  readonly historyScroll?: {
    afterSendAnchorTop: number
    whileReadingAnchorTop: number
    afterStreamAnchorTop: number
    renderBefore: number
    renderAfter: number
  }
}

function latestUserText(
  messages: readonly { source?: { kind?: string }; content: readonly { type: string; text?: string }[] }[],
): string {
  const message = messages.findLast((entry) => entry.source?.kind === 'user')
  return (
    message?.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n') ?? ''
  )
}

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Long-flow release gate timed out: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startupPhase<T>(
  label: string,
  run: () => Promise<T>,
  cleanupLate?: (value: T) => Promise<void>,
): Promise<T> {
  console.info(`[long-flow startup] ${label}: start`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = run()
  try {
    const value = await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Startup phase ${label} exceeded its 20s deadline`)), 20_000)
      }),
    ])
    console.info(`[long-flow startup] ${label}: complete`)
    return value
  } catch (error) {
    console.error(`[long-flow startup] ${label}: failed`, error)
    if (timer !== undefined) clearTimeout(timer)
    if (cleanupLate !== undefined)
      void work.then(cleanupLate).catch((cleanupError: unknown) => {
        console.error(`[long-flow startup] ${label}: late cleanup failed`, cleanupError)
      })
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function toolArgs(kind: LongTurnKind, workspaceFile = LONG_FLOW_FILE) {
  if (kind === 'read') return { file_path: workspaceFile }
  if (kind === 'failed-read') return { file_path: 'long-flow-missing.txt' }
  if (kind === 'edit')
    return { file_path: workspaceFile, old_string: 'LONG_FLOW_SEED', new_string: 'LONG_FLOW_007_EDITED' }
  if (kind === 'present') return { files: [{ path: LONG_FLOW_DELIVERY, description: 'Long conversation artifact' }] }
  if (kind === 'run-code')
    return {
      code: `await tools.read({"file_path": "${workspaceFile}"})\nreturn await tools.edit({"file_path": "${workspaceFile}", "old_string": "LONG_FLOW_007_EDITED", "new_string": "LONG_FLOW_008_PTC_EDITED"})`,
      description: 'Read the fixture and make the requested single edit',
    }
  return { marker: 'LONG_FLOW_005' }
}

class NativeControl extends LlmAdapter {
  providerInfo(provider: string) {
    return { id: provider, name: 'Long flow native control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'long-flow-model', name: 'Long Flow Model' }]
  }
  providerRetryPolicy(): ReturnType<LlmAdapter['providerRetryPolicy']> {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  async *stream(options: Parameters<LlmAdapter['stream']>[0]): ReturnType<LlmAdapter['stream']> {
    const prompt = latestUserText(options.messages)
    const match = /E2E_LONG_CONVERSATION\s+turn=(\d+)/.exec(prompt)
    if (match === null) throw new Error(`Unexpected native long-flow prompt: ${prompt.slice(0, 120)}`)
    const index = Number(match[1])
    const turnCount = Number(/\btotal=(\d+)/.exec(prompt)?.[1] ?? TURN_COUNT)
    const historyResume = prompt.includes('resume=history-read')
    const spec = longTurnSpec(index, turnCount)
    const latestUserIndex = options.messages.findLastIndex((message) => message.source?.kind === 'user')
    const currentStepResults = options.messages
      .slice(latestUserIndex + 1)
      .filter((message) => message.source?.kind === 'tool')
    if (currentStepResults.length === 0 && !['markdown', 'reasoning'].includes(spec.kind)) {
      const name =
        spec.kind === 'fixture-tool'
          ? 'long_fixture'
          : spec.kind === 'run-code'
            ? 'run_code'
            : spec.kind === 'failed-read'
              ? 'read'
              : spec.kind
      const tool = options.tools?.find((item) => item.name === name)
      if (tool === undefined) throw new Error(`Native control does not have required DSH tool ${name}`)
      const args = JSON.stringify(toolArgs(spec.kind))
      const block: ToolCallBlock = {
        type: 'tool-call',
        id: ToolCallId(`long-flow-native-${index}`),
        name,
        arguments: args,
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const blocks: { type: 'reasoning' | 'text'; text: string }[] = []
    if (spec.kind === 'reasoning')
      blocks.push({
        type: 'reasoning',
        text: `${spec.marker}_THOUGHT Keep the earlier requirement and check the next condition.`,
      })
    blocks.push({ type: 'text', text: spec.deltas.join('') })
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex]!
      yield { type: 'block-start', index: blockIndex, blockType: block.type }
      if (block.type === 'text' && (index === turnCount || historyResume)) {
        for (const [deltaIndex, delta] of spec.deltas.entries()) {
          yield { type: 'text-delta', index: blockIndex, text: delta }
          if (deltaIndex === 0) await waitForRelease(index === turnCount ? NATIVE_RELEASE : NATIVE_HISTORY_RELEASE)
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
        if (index === turnCount && !historyResume) await waitForRelease(NATIVE_FINISH_RELEASE)
      } else {
        yield {
          type: block.type === 'text' ? 'text-delta' : 'reasoning-delta',
          index: blockIndex,
          text: block.text,
        } as never
      }
      yield { type: 'block-end', index: blockIndex, block: block as never }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('long conversation native renderer comparison', () => {
  let host!: AdapterWorld
  let browser!: TestBrowser
  const allEvents: SessionEvent[] = []
  const nativeProvider = 'native-control'
  const acpProvider = 'acp-devin'

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true })
    host = await startupPhase(
      'host launch',
      () => launchAdapterWorld({ renderProbe: true, toolsMode: 'both' }),
      (lateHost) => lateHost.close(),
    )
    await startupPhase('ACP settings', () =>
      host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'auto',
        agents: {
          devin: {
            name: 'Long flow Devin protocol fixture',
            command: process.execPath,
            args: [join(root, 'test/mock-agent/mock-agent.ts')],
            env: {
              HOME: host.workspaceCwd,
              MOCK_SCENARIO: 'regression',
              MOCK_PROFILE: 'devin',
              MOCK_LOG,
              MOCK_LONG_FLOW_GATE_DIR: EVIDENCE,
            },
          },
        },
      }),
    )
    await startupPhase('provider registration', () =>
      vi.waitFor(
        () => expect(host.ctx.llm.listProviders().some((provider) => provider.id === acpProvider)).toBe(true),
        { timeout: 20_000, interval: 100 },
      ),
    )
    console.info('[long-flow startup] native tool registration: start')
    host.ctx.effect(() => host.ctx.llm.registerAdapter([nativeProvider], new NativeControl()))
    host.ctx.effect(() =>
      host.ctx.tools.register({
        name: 'long_fixture',
        description: 'Return the provided long-flow marker.',
        parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async ({ marker }: { marker: string }) => `LONG_FIXTURE_RESULT ${marker}`,
      }),
    )
    console.info('[long-flow startup] native tool registration: complete')
    host.ctx.on('session/event', (_session, event) => allEvents.push(event))
    browser = await startupPhase(
      'browser launch',
      () =>
        launchBrowser({
          headless: true,
          ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
        }),
      (lateBrowser) => lateBrowser.close(),
    )
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it.skipIf(LONG_MODE)(
    'checks 12 scripted native/ACP composer turns, tool outcomes and live render stability',
    async () => {
      await runComparison(DEBUG_TURNS)
    },
    120_000,
  )

  it.skipIf(!LONG_MODE)(
    'soaks 100 paired composer turns, paginates history and resumes after reload',
    async () => {
      await runComparison(LONG_CONVERSATION_TURNS)
    },
    600_000,
  )

  async function runComparison(turnCount: number): Promise<void> {
    mkdirSync(EVIDENCE, { recursive: true })
    const page = await startupPhase('browser page', () => newEnglishPage(browser, 900))
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      window.__DSH_ACP_RENDER_COUNTS__ = {}
      window.__DSH_ACP_RENDER_PROBE__ = (key) => {
        const counts = window.__DSH_ACP_RENDER_COUNTS__!
        counts[key] = (counts[key] ?? 0) + 1
      }
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const runs: RunEvidence[] = []
    try {
      await startupPhase('authenticated browser navigation', () =>
        page.goto(host.authenticatedUrl, { waitUntil: 'load' }).then(() => undefined),
      )
      await startupPhase('workspace connection', () => connectFreshWorkspace(page, host.workspaceCwd, 'workspace'))
      const workspace = join(host.workspaceCwd, 'workspace')

      for (const provider of [nativeProvider, acpProvider]) {
        await host.ctx.agentDefaultModel.saveSelection({
          provider,
          model: provider === nativeProvider ? 'long-flow-model' : 'mock-model-a',
        })
        if (runs.length > 0) {
          await page.getByRole('button', { name: 'New session', exact: true }).last().click()
          await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor()
        }
        writeFileSync(join(workspace, LONG_FLOW_FILE), 'LONG_FLOW_SEED\n')
        writeFileSync(join(workspace, LONG_FLOW_DELIVERY), 'LONG_FLOW_DELIVERY_CONTENT\n')
        writeFileSync(MOCK_LOG, '')
        rmSync(provider === nativeProvider ? NATIVE_RELEASE : ACP_RELEASE, { force: true })
        rmSync(provider === nativeProvider ? NATIVE_FINISH_RELEASE : ACP_FINISH_RELEASE, { force: true })
        rmSync(provider === nativeProvider ? NATIVE_HISTORY_RELEASE : ACP_HISTORY_RELEASE, { force: true })
        const record = await runProvider(page, cdp, provider, turnCount, workspace, runs.at(-1)?.sessionId)
        runs.push(record)
      }

      writeFileSync(join(EVIDENCE, `comparison-${turnCount}.json`), JSON.stringify({ runs, errors }, null, 2))
      expect(errors).toEqual([])
      expect(runs.map((run) => run.turns)).toEqual([turnCount, turnCount])
      expect(runs[0]!.sessionId).not.toBe(runs[1]!.sessionId)
    } catch (error) {
      const failurePath = join(EVIDENCE, `failure-${turnCount}.json`)
      const dom = await page
        .evaluate(() => ({
          callIds: [...document.querySelectorAll<HTMLElement>('[data-chat-call-id]')].map((element) => ({
            id: element.dataset.chatCallId,
            text: element.innerText.slice(0, 300),
          })),
          bodyHtml: document.body.outerHTML,
        }))
        .catch((domError: unknown) => ({ error: String(domError) }))
      await page
        .screenshot({ path: join(EVIDENCE, `failure-${turnCount}.png`), fullPage: true, animations: 'disabled' })
        .catch(() => undefined)
      writeFileSync(
        failurePath,
        JSON.stringify(
          {
            error: error instanceof Error ? error.stack : String(error),
            consoleErrors: errors,
            hostEvents: allEvents,
            dom,
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await cdp.detach()
      await page.close()
    }
  }

  async function runProvider(
    page: Page,
    cdp: CDPSession,
    provider: string,
    turnCount: number,
    workspace: string,
    previousSessionId?: string,
  ): Promise<RunEvidence> {
    const eventOffset = allEvents.length
    const sessionIdPromise = host.whenTurnSettled(600_000)
    const checkpoints: Metrics[] = []
    const snapshots: Record<string, string> = {}
    const earlyRenderCounts: Record<string, number> = {}
    const renderDuringTail: RunEvidence['renderDuringTail'] = {}
    const tailStreamingBaseline: Record<string, { mounted: boolean; count: number }> = {}
    let recentHistoryKey: string | undefined
    const toolKinds: RunEvidence['toolKinds'] = {}
    const limitations: string[] = []
    const performanceBaseline: RunEvidence['performanceBaseline'] = await (async () => {
      await page.evaluate(() => window.__LONG_FLOW_METRICS__?.observer?.disconnect())
      const [performance, browserState] = await Promise.all([
        cdp.send('Performance.getMetrics'),
        page.evaluate(() => ({ nodes: document.querySelectorAll('*').length })),
      ])
      const value = (name: string) =>
        Number(performance.metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000
      return {
        browserNodes: browserState.nodes,
        heapBytes: Number(performance.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0),
        scriptMs: value('ScriptDuration'),
        layoutMs: value('LayoutDuration'),
        styleMs: value('RecalcStyleDuration'),
      }
    })()
    const metricValue = (metrics: { metrics: { name: string; value: number }[] }, name: string) =>
      Number(metrics.metrics.find((metric) => metric.name === name)?.value ?? 0)
    await page.evaluate(() => {
      window.__DSH_ACP_RENDER_COUNTS__ = {}
    })
    await page.evaluate(() => {
      const target = document.querySelector('[data-conversation-scroll]') ?? document.querySelector('[data-chat-flow]')
      if (!(target instanceof HTMLElement)) throw new Error('conversation DOM probe target is missing')
      const state = { batches: 0, records: 0, observer: undefined as MutationObserver | undefined }
      state.observer = new MutationObserver((records) => {
        state.batches++
        state.records += records.length
      })
      state.observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true })
      window.__LONG_FLOW_METRICS__ = state
    })
    const capture = async (tag: string) => {
      const path = join(EVIDENCE, `${provider}-${tag}.png`)
      await page.screenshot({ path, fullPage: true, animations: 'disabled' })
      snapshots[tag] = path
    }

    for (let index = 1; index <= turnCount; index++) {
      const spec = longTurnSpec(index, turnCount)
      const prompt = `E2E_LONG_CONVERSATION turn=${index} total=${turnCount} kind=${spec.kind} ${spec.marker}; preserve earlier requirements and summarize this step.`
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await writeComposerDraft(page, composer, prompt)
      const settled = host.whenTurnSettled(30_000)
      await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
      await page.getByText(`${spec.marker}_FIRST`, { exact: false }).last().waitFor({ timeout: 20_000 })
      if (index === turnCount) {
        const releasePath = provider === nativeProvider ? NATIVE_RELEASE : ACP_RELEASE
        try {
          await capture('tail-streaming')
          for (const key of Object.keys(earlyRenderCounts)) {
            const during = await page.evaluate((renderKey) => {
              const node = [...document.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(
                (element) => element.dataset.chatNodeKey === renderKey,
              )
              return { mounted: node?.isConnected === true, count: window.__DSH_ACP_RENDER_COUNTS__?.[renderKey] ?? 0 }
            }, key)
            tailStreamingBaseline[key] = during
            renderDuringTail[key] = {
              mountedAtFirstDelta: during.mounted,
              mountedBeforeFinish: false,
              mountedAfterSettled: false,
              firstDeltaCount: during.count,
              beforeFinishCount: 0,
              afterSettledCount: 0,
            }
            if (key === recentHistoryKey) {
              expect(during.mounted, 'the recent historical assistant step must stay mounted at the stream gate').toBe(
                true,
              )
              expect(
                during.count,
                'the recent historical renderer probe must be active at the stream gate',
              ).toBeGreaterThan(0)
            }
          }
          if (recentHistoryKey === undefined || tailStreamingBaseline[recentHistoryKey]?.mounted !== true)
            throw new Error('The most recent historical assistant-step was not mounted at the stream gate')
        } finally {
          writeFileSync(releasePath, 'release')
        }
      }
      await page.getByText(`${spec.marker}_DONE`, { exact: false }).last().waitFor({ timeout: 20_000 })
      if (index === turnCount) {
        await capture('tail-before-finish')
        for (const [key, baseline] of Object.entries(tailStreamingBaseline)) {
          const beforeFinish = await page.evaluate((renderKey) => {
            const node = [...document.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(
              (element) => element.dataset.chatNodeKey === renderKey,
            )
            return { mounted: node?.isConnected === true, count: window.__DSH_ACP_RENDER_COUNTS__?.[renderKey] ?? 0 }
          }, key)
          const record = renderDuringTail[key]
          if (record !== undefined) {
            record.mountedBeforeFinish = beforeFinish.mounted
            record.beforeFinishCount = beforeFinish.count
          }
          if (baseline.mounted && beforeFinish.mounted)
            expect(
              beforeFinish.count,
              `mounted historical assistant-step ${key} rerendered between the first and last deltas`,
            ).toBe(baseline.count)
        }
        writeFileSync(provider === nativeProvider ? NATIVE_FINISH_RELEASE : ACP_FINISH_RELEASE, 'release')
      }
      const settledId = await settled
      if (index === turnCount) {
        for (const key of Object.keys(tailStreamingBaseline)) {
          const afterSettled = await page.evaluate((renderKey) => {
            const node = [...document.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(
              (element) => element.dataset.chatNodeKey === renderKey,
            )
            return { mounted: node?.isConnected === true, count: window.__DSH_ACP_RENDER_COUNTS__?.[renderKey] ?? 0 }
          }, key)
          const record = renderDuringTail[key]
          if (record !== undefined) {
            record.mountedAfterSettled = afterSettled.mounted
            record.afterSettledCount = afterSettled.count
          }
        }
      }
      expect(settledId).toBe(await sessionIdPromise)
      if (index === 1 && previousSessionId !== undefined) expect(String(settledId)).not.toBe(previousSessionId)
      const transcript = allEvents.slice(eventOffset)
      const matchingEvents = transcript.filter((event) => {
        if (event.type === 'user/message')
          return event.data.content.some((block) => block.type === 'text' && block.text.includes(spec.marker))
        if (event.type === 'assistant/message')
          return event.data.message.content.some(
            (block) => block.type === 'text' && block.text.includes(`${spec.marker}_DONE`),
          )
        return false
      })
      if (matchingEvents.filter((event) => event.type === 'user/message').length !== 1)
        throw new Error(`Turn ${index} user event was missing or duplicated`)
      if (matchingEvents.filter((event) => event.type === 'assistant/message').length !== 1)
        throw new Error(`Turn ${index} assistant event was missing or duplicated`)
      expect(await page.locator(`[data-chat-turn="${index}"]`).count()).toBeGreaterThan(0)
      if (index === 1 || index === Math.ceil(turnCount / 2) || index === turnCount) {
        const tag = index === 1 ? 'start' : index === turnCount ? 'end' : 'middle'
        await capture(tag)
      }

      if (index === 1 || index === Math.ceil(turnCount / 2) || index === turnCount - 1) {
        const answer = page
          .locator(`[data-chat-flow-kind="assistant-step"]`)
          .filter({ hasText: `${spec.marker}_DONE` })
          .last()
        const key = await answer.getAttribute('data-chat-node-key')
        if (key !== null) {
          earlyRenderCounts[key] = await page.evaluate(
            (renderKey) => window.__DSH_ACP_RENDER_COUNTS__?.[renderKey] ?? 0,
            key,
          )
          if (index === turnCount - 1) recentHistoryKey = key
        }
        if (index === 1 || index === turnCount - 1) {
          expect(key, `render-probe sample was not mounted for turn ${index}`).not.toBeNull()
          expect(earlyRenderCounts[key!], `render-probe count was not active for turn ${index}`).toBeGreaterThan(0)
        }
      }

      const callEvents = transcript.filter(
        (event) => event.type === 'tool/call' && 'name' in event.data && event.data.turn === index,
      )
      const resultEvents = transcript.filter(
        (event) => event.type === 'tool/result' && 'message' in event.data && event.data.turn === index,
      )
      if (['fixture-tool', 'read', 'edit', 'run-code', 'present', 'failed-read'].includes(spec.kind)) {
        const expectedName =
          spec.kind === 'fixture-tool'
            ? 'long_fixture'
            : spec.kind === 'run-code'
              ? 'run_code'
              : spec.kind === 'failed-read'
                ? 'read'
                : spec.kind
        let resultOutput = ''
        let resultIsError: boolean | undefined
        let callId: string | undefined
        if (provider === nativeProvider) {
          const call = callEvents.at(-1)
          const result = resultEvents.at(-1)
          if (call === undefined || !('name' in call.data) || call.data.name !== expectedName)
            throw new Error(`Turn ${index} did not execute ${expectedName}`)
          if (result === undefined || !('message' in result.data))
            throw new Error(`Turn ${index} did not record a result for ${expectedName}`)
          callId = 'callId' in call.data ? call.data.callId : undefined
          resultOutput = JSON.stringify(result.data.message.content)
          resultIsError = 'isError' in result.data.message ? result.data.message.isError : undefined
        } else {
          // ACP tool executions are confirmed by the actual MCP call result logged by the fixture;
          // ACP activity rows do not become native Session tool/call or tool/result events.
          const logLine = readFileSync(MOCK_LOG, 'utf8')
            .split('\n')
            .find((line) => line.includes(`long-flow tool=${expectedName} turn=${index} `))
          if (logLine === undefined) {
            throw new Error(`ACP fixture did not log a real ${expectedName} MCP result for turn ${index}`)
          }
          const fields = /error=(true|false) output=(.*)$/.exec(logLine)
          if (fields === null) throw new Error(`ACP tool result log did not match the expected schema: ${logLine}`)
          resultIsError = fields[1] === 'true'
          resultOutput = fields[2]!
          callId = `long-flow-tool-${index}`
        }
        const turnToggle = page.locator(`[data-turn-process="${index}"]`)
        if ((await turnToggle.count()) > 0 && (await turnToggle.getAttribute('aria-expanded')) === 'false') {
          await turnToggle.click()
          await expect.poll(() => turnToggle.getAttribute('aria-expanded')).toBe('true')
        }
        const row = page.locator(`[data-chat-call-id$="${callId}"]`)
        if ((await row.count()) === 0) {
          const ids = await page
            .locator('[data-chat-call-id]')
            .evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.chatCallId))
          throw new Error(
            `${provider} did not render a row keyed to tool id ${callId} at turn ${index}; rendered ids: ${JSON.stringify(ids)}`,
          )
        }
        const process = row.locator('xpath=ancestor::*[@data-step-process][1]')
        const processToggle = process.locator(':scope > div > button').first()
        if ((await processToggle.count()) > 0 && (await processToggle.getAttribute('aria-expanded')) === 'false') {
          await processToggle.click()
          await expect.poll(() => processToggle.getAttribute('aria-expanded')).toBe('true')
        }
        const visible = await row.isVisible()
        toolKinds[spec.kind] = {
          visible,
          output: resultOutput,
          ...(resultIsError === undefined ? {} : { isError: resultIsError }),
        }
        expect(visible, `${provider} tool activity row for ${expectedName} was missing at turn ${index}`).toBe(true)
        if (spec.kind === 'failed-read') expect(resultIsError).toBe(true)
        else expect(resultIsError).toBe(false)
        if (spec.kind === 'read')
          expect(readFileSync(join(workspace, LONG_FLOW_FILE), 'utf8')).toContain('LONG_FLOW_SEED')
        if (spec.kind === 'edit')
          expect(readFileSync(join(workspace, LONG_FLOW_FILE), 'utf8')).toContain('LONG_FLOW_007_EDITED')
        if (spec.kind === 'run-code') {
          const bytes = readFileSync(join(workspace, LONG_FLOW_FILE), 'utf8')
          expect(bytes).toContain('LONG_FLOW_008_PTC_EDITED')
        }
      }

      if (index % 10 === 0 || index === turnCount) {
        const [performance, browserState, renderCounts, mutations] = await Promise.all([
          cdp.send('Performance.getMetrics'),
          page.evaluate(() => ({ nodes: document.querySelectorAll('*').length })),
          page.evaluate(() => ({ ...(window.__DSH_ACP_RENDER_COUNTS__ ?? {}) })),
          page.evaluate(() => {
            const state = window.__LONG_FLOW_METRICS__
            return { batches: state?.batches ?? 0, records: state?.records ?? 0 }
          }),
        ])
        const value = (name: string) => metricValue(performance, name)
        checkpoints.push({
          turns: index,
          browserNodes: browserState.nodes,
          browserNodeGrowth: browserState.nodes - performanceBaseline.browserNodes,
          heapBytes: value('JSHeapUsedSize'),
          heapGrowthBytes: value('JSHeapUsedSize') - performanceBaseline.heapBytes,
          scriptMs: value('ScriptDuration') * 1000 - performanceBaseline.scriptMs,
          layoutMs: value('LayoutDuration') * 1000 - performanceBaseline.layoutMs,
          styleMs: value('RecalcStyleDuration') * 1000 - performanceBaseline.styleMs,
          mutationBatches: mutations.batches,
          mutationRecords: mutations.records,
        })
        if (index === turnCount) {
          writeFileSync(
            join(EVIDENCE, `${provider}-render-counts.json`),
            JSON.stringify({ earlyRenderCounts, renderCounts, renderDuringTail }, null, 2),
          )
        }
      }
    }

    const sessionId = await sessionIdPromise
    const sessionEvents = allEvents.slice(eventOffset)
    const toolCalls = sessionEvents.filter((event) => event.type === 'tool/call')
    const ptcDispatchEvents = sessionEvents.filter(
      (event) => event.type === 'tool/ptc-dispatch' || event.type === 'tool/ptc-dispatch-start',
    )
    if (
      provider === nativeProvider &&
      toolCalls.some((event) => event.data.name === 'run_code') &&
      ptcDispatchEvents.length === 0
    )
      limitations.push(
        'Native run_code executed without a tool/ptc-dispatch or tool/ptc-dispatch-start Session event; PTC subcall visibility remains a Host-side gap.',
      )
    if (provider === acpProvider && toolKinds['run-code']?.visible === true)
      limitations.push(
        'ACP run_code returned through the real MCP bridge, but nested tool/ptc-dispatch Session events are unavailable on this ACP activity path.',
      )
    if (
      provider === acpProvider &&
      !sessionEvents.some((event) => event.type === 'tool/call' || event.type === 'tool/result')
    )
      limitations.push(
        'ACP file/tool executions are confirmed by real MCP results and activity rows, but this bridge path does not expose native Session tool/call or tool/result events.',
      )
    if (
      (toolKinds.read?.visible === true || toolKinds.edit?.visible === true) &&
      !sessionEvents.some((event) => String(event.type).startsWith('workspace-changes/'))
    )
      limitations.push(
        'Real read/edit executions are checked against workspace bytes; workspace-change history is unavailable through the current official Host recorder interface.',
      )
    const artifacts: RunEvidence = {
      provider,
      sessionId: String(sessionId),
      turns: turnCount,
      snapshots,
      checkpoints,
      earlyRenderCounts,
      renderDuringTail,
      toolKinds,
      limitations,
      events: sessionEvents,
      performanceBaseline,
    }
    if (turnCount < LONG_CONVERSATION_TURNS) {
      await page.evaluate(() => window.__LONG_FLOW_METRICS__?.observer?.disconnect())
      return artifacts
    }

    await page.getByRole('button', { name: 'Load earlier', exact: true }).waitFor()
    let previous = await page.locator('[data-chat-flow-kind="user"]').count()
    let pages = 0
    while (previous < turnCount && pages++ < 12) {
      await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
      await expect
        .poll(() => page.locator('[data-chat-flow-kind="user"]').count(), { timeout: 20_000 })
        .toBeGreaterThan(previous)
      previous = await page.locator('[data-chat-flow-kind="user"]').count()
    }
    expect(previous).toBe(turnCount)
    const navigation = page.getByRole('navigation', { name: 'Turn navigation', exact: true })
    await navigation.getByRole('button', { name: 'Jump to turn 1', exact: true }).click()
    const firstTurn = page.locator('[data-chat-turn="1"]').first()
    await firstTurn.waitFor()
    const reasoning = page.locator('[data-variant="think"]').filter({ hasText: 'LONG_FLOW_002_THOUGHT' }).first()
    await reasoning.waitFor()
    const reasoningToggle = reasoning.getByRole('button').first()
    const expanded = await reasoningToggle.getAttribute('aria-expanded')
    if (expanded !== 'true') {
      await reasoningToggle.click()
      await expect.poll(() => reasoningToggle.getAttribute('aria-expanded')).toBe('true')
    }
    await reasoningToggle.click()
    await expect.poll(() => reasoningToggle.getAttribute('aria-expanded')).toBe('false')
    await reasoningToggle.click()
    await expect.poll(() => reasoningToggle.getAttribute('aria-expanded')).toBe('true')
    await capture('history-read')

    const scroll = page.locator('[data-conversation-scroll]').first()
    await scroll.evaluate((element) => {
      element.scrollTop = 0
    })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    const anchorHandle = await firstTurn.elementHandle()
    expect(anchorHandle).not.toBeNull()
    const historicalAnswer = page
      .locator('[data-chat-flow-kind="assistant-step"]')
      .filter({ hasText: 'LONG_FLOW_001_DONE' })
      .last()
    const historicalKey = await historicalAnswer.getAttribute('data-chat-node-key')
    expect(historicalKey).not.toBeNull()
    const historyRenderBefore = await page.evaluate(
      (key) => window.__DSH_ACP_RENDER_COUNTS__?.[key] ?? 0,
      historicalKey!,
    )
    expect(
      historyRenderBefore,
      'the historical renderer probe must be mounted before measuring the live stream',
    ).toBeGreaterThan(0)
    earlyRenderCounts[historicalKey!] = historyRenderBefore
    const extra = longTurnSpec(turnCount + 1, turnCount)
    rmSync(provider === nativeProvider ? NATIVE_HISTORY_RELEASE : ACP_HISTORY_RELEASE, { force: true })
    await writeComposerDraft(
      page,
      page.locator('[data-composer-input][contenteditable="true"]').last(),
      `E2E_LONG_CONVERSATION turn=${turnCount + 1} total=${turnCount} kind=${extra.kind} ${extra.marker} resume=history-read; continue after reviewing turn one.`,
    )
    const continued = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    await page.getByText(`${extra.marker}_FIRST`, { exact: false }).last().waitFor({ timeout: 20_000 })
    const afterSendAnchorTop = await anchorHandle!.evaluate((element) => element.getBoundingClientRect().top)
    // A deliberate composer send may invoke the native request-follow policy. Record that separately;
    // once the user moves back to an older turn, appending deltas must preserve the chosen anchor.
    await scroll.evaluate((element) => {
      element.scrollTop = 0
    })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    const whileReadingAnchorTop = await anchorHandle!.evaluate((element) => {
      if (!element.isConnected) throw new Error('The historical scroll anchor was replaced while returning to history')
      return element.getBoundingClientRect().top
    })
    const historyRenderDuring = await page.evaluate(
      (key) => window.__DSH_ACP_RENDER_COUNTS__?.[key] ?? 0,
      historicalKey!,
    )
    expect(historyRenderDuring).toBe(historyRenderBefore)
    await capture('history-during-stream')
    writeFileSync(provider === nativeProvider ? NATIVE_HISTORY_RELEASE : ACP_HISTORY_RELEASE, 'release')
    await page.getByText(`${extra.marker}_DONE`, { exact: false }).last().waitFor()
    await continued
    const afterStreamAnchorTop = await anchorHandle!.evaluate((element) => {
      if (!element.isConnected)
        throw new Error('The historical scroll anchor was replaced after releasing stream deltas')
      return element.getBoundingClientRect().top
    })
    const historyRenderAfter = await page.evaluate(
      (key) => window.__DSH_ACP_RENDER_COUNTS__?.[key] ?? 0,
      historicalKey!,
    )
    expect(historyRenderAfter).toBe(historyRenderBefore)
    expect(Math.abs(afterStreamAnchorTop - whileReadingAnchorTop)).toBeLessThanOrEqual(2)
    const historyScroll = {
      afterSendAnchorTop,
      whileReadingAnchorTop,
      afterStreamAnchorTop,
      renderBefore: historyRenderBefore,
      renderAfter: historyRenderAfter,
    }
    const historyRecord = { ...artifacts, events: allEvents.slice(eventOffset), earlyRenderCounts, historyScroll }
    await capture('continued')
    await page.reload()
    await page
      .getByText(`LONG_FLOW_${String(turnCount + 1).padStart(3, '0')}_DONE`, { exact: false })
      .last()
      .waitFor()
    await capture('reloaded')
    await page.evaluate(() => window.__LONG_FLOW_METRICS__?.observer?.disconnect())
    return { ...historyRecord, limitations, snapshots }
  }
})
