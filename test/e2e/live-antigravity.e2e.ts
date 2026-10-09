import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Locator, Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTraceSink } from '../../src/contract/live-diagnostic-trace.ts'
import { redactSecretText } from '../../src/contract/redaction.ts'
import { createAcpSidecar } from '../../src/persistence/sidecar.ts'

type NativeDiagnosticModule = {
  installLiveDiagnosticTrace(sink: LiveDiagnosticTraceSink): () => void
  liveDiagnosticTraceEnabled(): boolean
  liveDiagnosticTraceFailureCount(): number
}
type NativeRuntimeModule = { AcpSessionRuntime: unknown }
type RuntimePrompt = (this: unknown, ...args: unknown[]) => unknown
type RuntimePermissionRequest = (this: unknown, ...args: unknown[]) => Promise<unknown>

type SessionEventEvidence = { sessionId: string; event: SessionEvent }
type HostToolEvidence = { sessionId: string; callId: string; name: string; isError: boolean; result: string }
type MainRequestEvidence = { sessionId: string; provider: string; model: string }
type RequestRouteEvidence = { sessionId: string; provider: string; model: string }

const optedIn = process.env.DSH_E2E_LIVE_ANTIGRAVITY === '1'
const MODEL = process.env.DSH_E2E_LIVE_ANTIGRAVITY_MODEL ?? 'gemini-3.8-flash-low'
const PROVIDER_TOOL_LIMIT = 16
const INTERACTION_LIMIT = 12
const PHASE_TIMEOUT_MS = 120_000
const TOTAL_TIMEOUT_MS = 8 * 60_000
const PROVIDER = 'acp-antigravity'

function configuredPath(name: string, optional = false): string | undefined {
  const value = process.env[name]
  if (value === undefined && optional) return undefined
  if (value === undefined || !isAbsolute(value) || !existsSync(value))
    throw new Error(`${name} must name an existing absolute path`)
  return value
}

function privateWrite(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function compactResult(value: unknown): string {
  const encoded = JSON.stringify(value)
  return redactSecretText(encoded ?? String(value)).slice(0, 4096)
}

function redactEvidence(value: unknown, key = ''): unknown {
  if (/(?:header|authorization|cookie|credential|password|secret|token|api[_-]?key)/i.test(key)) return '<redacted>'
  if (typeof value === 'string') return redactSecretText(value)
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item))
  const object = record(value)
  if (object !== undefined)
    return Object.fromEntries(
      Object.entries(object).map(([childKey, child]) => [childKey, redactEvidence(child, childKey)]),
    )
  return value
}

function answerText(session: AdapterWorld, sessionId: string): string {
  const events = session.ctx.sessions.get(sessionId as never)?.snapshotEvents() ?? []
  const assistant = events.filter((event) => event.type === 'assistant/message').at(-1)
  if (assistant?.type !== 'assistant/message') return ''
  return assistant.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function safeEvent(event: LiveDiagnosticEvent, hash: (value: string) => string): LiveDiagnosticEvent {
  return {
    ...event,
    sessionId: hash(event.sessionId),
    ...('acpSessionId' in event && event.acpSessionId !== undefined ? { acpSessionId: hash(event.acpSessionId) } : {}),
    ...('leaseId' in event && event.leaseId !== undefined ? { leaseId: hash(event.leaseId) } : {}),
    ...('mcpRequestId' in event && event.mcpRequestId !== undefined ? { mcpRequestId: hash(event.mcpRequestId) } : {}),
    ...('hostCallId' in event && event.hostCallId !== undefined ? { hostCallId: hash(event.hostCallId) } : {}),
    ...('providerModelCallId' in event && event.providerModelCallId !== undefined
      ? { providerModelCallId: hash(event.providerModelCallId) }
      : {}),
    ...('providerToolCallId' in event && event.providerToolCallId !== undefined
      ? { providerToolCallId: hash(event.providerToolCallId) }
      : {}),
    ...('messageId' in event && event.messageId !== undefined ? { messageId: hash(event.messageId) } : {}),
  } as LiveDiagnosticEvent
}

it.skipIf(!optedIn)(
  'verifies native Antigravity questions, approvals, rejection and continuation in an isolated Host',
  async () => {
    const startedAt = Date.now()
    const totalDeadline = startedAt + TOTAL_TIMEOUT_MS
    const runId = randomUUID()
    const evidence = join(root, '.local', 'e2e-live-antigravity', runId)
    mkdirSync(evidence, { recursive: true, mode: 0o700 })

    let host: AdapterWorld | undefined
    let browser: TestBrowser | undefined
    let page: Page | undefined
    let diagnosticModule: NativeDiagnosticModule | undefined
    let sidecar: ReturnType<typeof createAcpSidecar> | undefined
    let removeDiagnostic: (() => void) | undefined
    let sessionId: string | undefined
    let firstSessionId: string | undefined
    let hostToolCalls = 0
    let interactionCards = 0
    let interactionRequests = 0
    let stickyViolation: string | undefined
    let expectedNativeCommand: string | undefined
    let hostClosePromise: Promise<void> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    let runStatus: 'running' | 'passed' | 'failed' | 'stopped' = 'running'
    let primaryFailure: unknown
    const providerToolCalls = new Map<string, string | undefined>()
    const nativeCommandToolCallIds = new Map<string, string>()
    const nativeCommandRows: {
      phase: string
      commandFingerprint: string
      nativeCallIdHash: string
      uiCallIdHash: string
      state: string
    }[] = []
    const providerAgents = new Set<string>()
    const permissionRequests: { sessionId: string; callId: string; toolName?: string }[] = []
    const verifiedNativeCommands: { sessionId: string; callId: string; fingerprint: string }[] = []
    const wrappedPermissionOptions = new WeakSet<object>()
    const restorePermissionHandlers: (() => void)[] = []
    const runtimeConfigModels: string[] = []
    let restoreRuntimePrompt: (() => void) | undefined
    const mainRequests: MainRequestEvidence[] = []
    const requestRoutes: RequestRouteEvidence[] = []
    const sessionEvents: SessionEventEvidence[] = []
    const observedSessionEvents = new Map<string, readonly SessionEvent[]>()
    const hostToolResults: HostToolEvidence[] = []
    const diagnosticEvents: LiveDiagnosticEvent[] = []
    const secret = randomBytes(32)
    const hash = (value: string) => createHmac('sha256', secret).update(value).digest('hex').slice(0, 24)
    const tracePath = join(evidence, 'diagnostics.jsonl')
    privateWrite(tracePath, '')
    chmodSync(tracePath, 0o600)

    const closeHost = (): Promise<void> => {
      if (hostClosePromise === undefined && host !== undefined) {
        hostClosePromise = host.close()
        void hostClosePromise.catch(() => undefined)
      }
      return hostClosePromise ?? Promise.resolve()
    }

    const snapshotEvents = (id: string): readonly SessionEvent[] => {
      try {
        const snapshot = host?.ctx.sessions.get(id as never)?.snapshotEvents()
        if (snapshot !== undefined) return snapshot
      } catch {
        // A timed-out phase may already have disposed Host services.
      }
      return observedSessionEvents.get(id) ?? []
    }

    const failureDetails = (error: unknown): { kind: string; message: string } => ({
      kind: error instanceof Error ? error.name : typeof error,
      message: redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 2000),
    })

    const writePrimaryFailure = (error: unknown, evidenceFailure?: unknown): void => {
      try {
        privateWrite(
          join(evidence, 'primary-failure.json'),
          JSON.stringify(
            redactEvidence({
              originalFailure: failureDetails(error),
              ...(evidenceFailure === undefined ? {} : { evidenceFailure: failureDetails(evidenceFailure) }),
            }),
            null,
            2,
          ),
        )
      } catch {
        // Failure evidence is best-effort and must not replace the test failure.
      }
    }

    const cancelRun = (reason: string): void => {
      if (stickyViolation !== undefined) return
      stickyViolation = reason
      for (const id of providerAgents) {
        try {
          const agent = host?.ctx.agents.get(id as never) as
            | { cancel?: (reason: { kind: 'hook'; reason: string }, options?: { keepInbox: boolean }) => unknown }
            | undefined
          void agent?.cancel?.({ kind: 'hook', reason }, { keepInbox: false })
        } catch {
          // Continue cancellation for the remaining active Agents.
        }
      }
      void closeHost()
    }

    const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      if (stickyViolation !== undefined) throw new Error(`ANTIGRAVITY_LIVE_STOPPED:${stickyViolation}`)
      const remaining = Math.min(PHASE_TIMEOUT_MS, totalDeadline - Date.now())
      if (remaining <= 0) {
        cancelRun('TOTAL_DEADLINE')
        throw new Error('ANTIGRAVITY_LIVE_TOTAL_DEADLINE')
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          cancelRun(`PHASE_TIMEOUT_${name}`)
          reject(new Error(`ANTIGRAVITY_LIVE_PHASE_TIMEOUT:${name}`))
        }, remaining)
      })
      try {
        return await Promise.race([action(), deadline])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }

    const saveEvidence = (stage: string): void => {
      const snapshot = sessionId === undefined ? [] : snapshotEvents(sessionId)
      try {
        privateWrite(
          join(evidence, 'session-events.json'),
          JSON.stringify(
            redactEvidence({
              sessionIdHash: sessionId === undefined ? undefined : hash(sessionId),
              events: snapshot,
              observedEvents: sessionEvents,
              hostToolResults,
              providerToolCalls: [...providerToolCalls].map(([id, status]) => ({ id, status })),
              permissionRequests,
              verifiedNativeCommands,
              nativeCommandRows,
              runtimeConfigModels,
              mainRequests,
              requestRoutes,
            }),
            null,
            2,
          ),
        )
        privateWrite(
          join(evidence, 'run.json'),
          JSON.stringify(
            redactEvidence({
              status: stickyViolation === undefined ? runStatus : 'stopped',
              stage,
              model: MODEL,
              harnessProvided: process.env.DSH_E2E_LIVE_ANTIGRAVITY_HARNESS !== undefined,
              inheritedEnvKeyCount: inheritedEnvKeys.length,
              hostToolCalls,
              providerToolCallCount: providerToolCalls.size,
              interactionCards,
              sessionIdHash: sessionId === undefined ? undefined : hash(sessionId),
              elapsedMs: Date.now() - startedAt,
              ...(stickyViolation === undefined ? {} : { stickyViolation }),
            }),
            null,
            2,
          ),
        )
      } catch (error) {
        cancelRun('TRACE_WRITE_FAILED')
        throw error
      }
    }

    let inheritedEnvKeys: string[] = []
    const capture = async (phaseName: string, stage: 'start' | 'pending' | 'end' | 'reload'): Promise<void> => {
      if (page === undefined) throw new Error('ANTIGRAVITY_LIVE_PAGE_UNAVAILABLE')
      await page.screenshot({
        path: join(evidence, `${phaseName}-${stage}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      chmodSync(join(evidence, `${phaseName}-${stage}.png`), 0o600)
      saveEvidence(`${phaseName}-${stage}`)
    }

    const send = async (prompt: string): Promise<{ settled: Promise<string>; mainRequestCountBefore: number }> => {
      if (page === undefined || host === undefined) throw new Error('ANTIGRAVITY_LIVE_SETUP_INCOMPLETE')
      const mainRequestCountBefore = mainRequests.length
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
      const settled = host.whenTurnSettled(PHASE_TIMEOUT_MS)
      void settled.catch(() => undefined)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      return { settled, mainRequestCountBefore }
    }

    const acceptSettled = async (settled: Promise<string>, mainRequestCountBefore: number): Promise<string> => {
      const settledSessionId = await settled
      expect(mainRequests.length).toBeGreaterThan(mainRequestCountBefore)
      expect(
        mainRequests
          .slice(mainRequestCountBefore)
          .every((request) => request.provider === PROVIDER && request.model === MODEL),
      ).toBe(true)
      if (firstSessionId === undefined) firstSessionId = settledSessionId
      else expect(settledSessionId).toBe(firstSessionId)
      sessionId = settledSessionId
      return settledSessionId
    }

    const expectTurnReason = (id: string, kind: 'completed' | 'aborted'): void => {
      const ended = snapshotEvents(id).findLast((event) => event.type === 'turn/end')
      expect(ended?.type === 'turn/end' ? ended.data.reason.kind : undefined).toBe(kind)
    }

    const pendingQuestion = async (title: string): Promise<Locator> => {
      if (page === undefined) throw new Error('ANTIGRAVITY_LIVE_PAGE_UNAVAILABLE')
      const question = page.locator('[data-question-key]')
      await question.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
      interactionCards += 1
      if (interactionCards > INTERACTION_LIMIT) {
        cancelRun('INTERACTION_LIMIT')
        throw new Error('ANTIGRAVITY_LIVE_INTERACTION_LIMIT')
      }
      expect(await page.locator('[data-approval-key]').count()).toBe(0)
      expect(await question.innerText()).toContain(title)
      return question
    }

    const waitForAssistant = async (text: string): Promise<void> => {
      if (page === undefined) throw new Error('ANTIGRAVITY_LIVE_PAGE_UNAVAILABLE')
      await page
        .locator('[data-chat-flow-kind="assistant-step"]')
        .getByText(text, { exact: false })
        .last()
        .waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
    }

    const waitForNativeCall = async (command: string, phaseName: string): Promise<Locator> => {
      if (page === undefined) throw new Error('ANTIGRAVITY_LIVE_PAGE_UNAVAILABLE')
      const toolCallId = nativeCommandToolCallIds.get(command)
      if (toolCallId === undefined) throw new Error('ANTIGRAVITY_LIVE_VERIFIED_CALL_ID_UNAVAILABLE')
      const suffix = `:tool:${toolCallId}`
      console.info(`[antigravity-live] ${phaseName}: waiting for native call row`)
      let matchedCallId: string | undefined
      await expect
        .poll(
          async () => {
            const callIds = await page!
              .locator('[data-chat-call-id^="acp:"]')
              .evaluateAll((elements) =>
                elements
                  .map((element) => (element as HTMLElement).dataset.chatCallId)
                  .filter((id): id is string => typeof id === 'string'),
              )
            matchedCallId = callIds.find((id) => id.endsWith(suffix))
            return matchedCallId
          },
          { timeout: PHASE_TIMEOUT_MS },
        )
        .toBeDefined()
      if (matchedCallId === undefined) throw new Error('ANTIGRAVITY_LIVE_VERIFIED_CALL_ROW_UNAVAILABLE')
      const call = page.locator(`[data-chat-call-id=${JSON.stringify(matchedCallId)}]`)
      await call.waitFor({ state: 'attached', timeout: PHASE_TIMEOUT_MS })
      console.info(`[antigravity-live] ${phaseName}: native call row attached`)
      await expandProcess(phaseName)
      await call.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
      console.info(`[antigravity-live] ${phaseName}: native call row visible`)
      nativeCommandRows.push({
        phase: phaseName,
        commandFingerprint: hash(command),
        nativeCallIdHash: hash(toolCallId),
        uiCallIdHash: hash(matchedCallId),
        state: (await call.locator('[data-variant="bash"]').getAttribute('data-state')) ?? 'unavailable',
      })
      return call
    }

    const assertNativeCommandInput = async (call: Locator, command: string, phaseName: string): Promise<void> => {
      try {
        const bash = call.locator('[data-variant="bash"]')
        await bash.waitFor({ state: 'visible', timeout: 30_000 })
        const inputLabel = call.getByText('IN', { exact: true })
        if (!(await inputLabel.isVisible())) await bash.click()
        await inputLabel.waitFor({ state: 'visible', timeout: 30_000 })
        const inputText = inputLabel.locator('xpath=following-sibling::*[1]')
        await inputText.waitFor({ state: 'visible', timeout: 30_000 })
        const parsedInput: unknown = JSON.parse(await inputText.innerText())
        expect(record(parsedInput)?.CommandLine).toBe(command)
      } catch (error) {
        if (page !== undefined) {
          const failureScreenshot = join(evidence, `failure-${phaseName}-before-cleanup.png`)
          try {
            await page.screenshot({
              path: failureScreenshot,
              fullPage: true,
              animations: 'disabled',
              timeout: 5_000,
            })
            chmodSync(failureScreenshot, 0o600)
          } catch {
            // Preserve the assertion failure if the page has already closed.
          }
        }
        throw error
      }
    }

    const assertSidecarCommand = async (dshSessionId: string, command: string, phaseName: string): Promise<void> => {
      const toolCallId = nativeCommandToolCallIds.get(command)
      if (toolCallId === undefined) throw new Error('ANTIGRAVITY_LIVE_VERIFIED_CALL_ID_UNAVAILABLE')
      await expect
        .poll(
          async () => {
            const activities = await sidecar!.activitySnapshot(dshSessionId as never, 100, {
              ownerDshSessionId: dshSessionId,
            })
            const activity = activities.find((row) => row.activityId.endsWith(`:tool:${toolCallId}`))
            let detail: Record<string, unknown> | undefined
            try {
              detail = record(JSON.parse(activity?.rawDetail ?? '{}'))
            } catch {
              return undefined
            }
            const input = record(detail?.rawInput)
            return [input?.CommandLine, input?.command, input?.command_line, detail?.CommandLine, detail?.command].find(
              (value): value is string => typeof value === 'string',
            )
          },
          { timeout: PHASE_TIMEOUT_MS },
        )
        .toBe(command)
      console.info(`[antigravity-live] ${phaseName}: sidecar command matches permission request`)
    }

    const expandProcess = async (phaseName: string): Promise<void> => {
      if (page === undefined) throw new Error('ANTIGRAVITY_LIVE_PAGE_UNAVAILABLE')
      for (const control of await page.locator('[data-turn-process-tool-calls]').all()) {
        if (!(await control.isVisible())) continue
        if ((await control.getAttribute('aria-expanded')) === 'false') {
          await control.click()
          await expect.poll(() => control.getAttribute('aria-expanded')).toBe('true')
        }
      }
      console.info(`[antigravity-live] ${phaseName}: visible process disclosures expanded`)
      for (const button of await page.locator('[data-step-process] > div > button').all()) {
        if (!(await button.isVisible())) continue
        if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
        await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true')
      }
      console.info(`[antigravity-live] ${phaseName}: visible process steps expanded`)
    }

    try {
      if (!optedIn) return
      totalTimer = setTimeout(() => cancelRun('TOTAL_DEADLINE'), TOTAL_TIMEOUT_MS)
      const command = configuredPath('DSH_E2E_LIVE_ANTIGRAVITY_COMMAND')!
      const harness = configuredPath('DSH_E2E_LIVE_ANTIGRAVITY_HARNESS', true)
      const envKeys = (process.env.DSH_E2E_LIVE_ANTIGRAVITY_ENV_KEYS ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      if (new Set(envKeys).size !== envKeys.length) throw new Error('ENV_KEYS must not contain duplicates')
      inheritedEnvKeys = [...envKeys]
      const env = Object.fromEntries(
        envKeys.map((key) => {
          if (process.env[key] === undefined)
            throw new Error(`Explicit live-test environment variable is absent: ${key}`)
          return [key, process.env[key]]
        }),
      )
      if (harness !== undefined) env['ANTIGRAVITY_HARNESS_PATH'] = harness

      host = await launchAdapterWorld()
      const dshHomePath = host.ctx.dshHomePath
      if (typeof dshHomePath !== 'function') throw new Error('Isolated Host has no dshHomePath slot')
      sidecar = createAcpSidecar({ root: dshHomePath('dsh-acp') })
      if (stickyViolation !== undefined) {
        void closeHost()
        throw new Error(`ANTIGRAVITY_LIVE_STOPPED:${stickyViolation}`)
      }
      const provider = PROVIDER
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'ask',
        agents: {
          antigravity: {
            name: 'Antigravity live verification',
            command,
            args: [],
            env,
            runtime: 'antigravity',
          },
        },
      })
      await expect
        .poll(() => host!.ctx.llm.listProviders().some((entry) => entry.id === provider), { timeout: 30_000 })
        .toBe(true)
      expect(
        (await host.ctx.llm.listModels(provider)).some((entry) => entry.id === MODEL),
        `Exact model ${MODEL} is absent`,
      ).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider, model: MODEL })

      const workspace = resolve(host.workspaceCwd, 'workspace')
      const rejectedFile = join(workspace, `antigravity-rejected-${runId}.txt`)
      expect(existsSync(rejectedFile)).toBe(false)
      host.ctx.tools.guard((execution) => {
        hostToolCalls += 1
        if (stickyViolation !== undefined) return `LIVE_ANTIGRAVITY_GUARD:${stickyViolation}`
        if (execution.agent !== undefined) providerAgents.add(String(execution.agent.id))
        cancelRun(`UNEXPECTED_HOST_TOOL_${execution.name}`)
        return `LIVE_ANTIGRAVITY_GUARD:${stickyViolation}`
      })
      host.ctx.on('session/event', (session, event) => {
        const id = String(session.id)
        const cached = observedSessionEvents.get(id) ?? []
        observedSessionEvents.set(id, [...cached, event])
        sessionEvents.push({ sessionId: hash(id), event })
        if (event.type === 'request/header') {
          const data = event.data as unknown as { header?: { config?: { provider?: unknown; model?: unknown } } }
          requestRoutes.push({
            sessionId: hash(String(session.id)),
            provider: String(data.header?.config?.provider),
            model: String(data.header?.config?.model),
          })
        }
      })
      host.ctx.on('tools/result', (execution, result) => {
        hostToolResults.push({
          sessionId: hash(String(execution.agent?.id ?? 'unowned')),
          callId: hash(String(execution.callId)),
          name: execution.name,
          isError: result.isError,
          result: compactResult(result.value),
        })
      })
      host.ctx.on('llm/stream', (request, next) => {
        if (request.purpose !== undefined) return next()
        providerAgents.add(String(request.sessionId))
        const requestedProvider = String(request.provider)
        const requestedModel = String(request.model)
        mainRequests.push({
          sessionId: hash(String(request.sessionId)),
          provider: requestedProvider,
          model: requestedModel,
        })
        if (stickyViolation !== undefined) throw new Error(`ANTIGRAVITY_LIVE_STOPPED:${stickyViolation}`)
        if (requestedProvider !== provider || requestedModel !== MODEL) {
          cancelRun(requestedProvider !== provider ? 'PROVIDER_MISMATCH' : 'MODEL_MISMATCH')
          throw new Error(`ANTIGRAVITY_LIVE_ROUTE_MISMATCH:${requestedProvider}:${requestedModel}`)
        }
        return next()
      })

      const loader = host.ctx.loader as unknown as { internal?: unknown; import(specifier: string): Promise<unknown> }
      if (loader.internal === undefined) throw new Error('ANTIGRAVITY_LIVE_NATIVE_LOADER_UNAVAILABLE')
      const runtimeModule = (await loader.import(
        pathToFileURL(resolve(root, 'lib/runtime/session/session-runtime.js')).href,
      )) as NativeRuntimeModule
      const runtimePrototype = (runtimeModule.AcpSessionRuntime as { prototype: { prompt: RuntimePrompt } }).prototype
      const originalRuntimePrompt = runtimePrototype.prompt
      runtimePrototype.prompt = function (this: unknown, ...args: unknown[]): unknown {
        const runtimeState = this as {
          readonly acpSessionId?: unknown
          readonly configOptions?: readonly {
            readonly type?: unknown
            readonly category?: unknown
            readonly id?: unknown
            readonly currentValue?: unknown
          }[]
          readonly options?: {
            readonly diagnosticDshSessionId?: unknown
            onPermissionRequest?: RuntimePermissionRequest
          }
        }
        const modelOption = runtimeState.configOptions?.find(
          (option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'),
        )
        const configuredModel = modelOption?.currentValue
        runtimeConfigModels.push(typeof configuredModel === 'string' ? configuredModel : 'unavailable')
        if (configuredModel !== MODEL) {
          cancelRun('RUNTIME_MODEL_MISMATCH')
          throw new Error(`ANTIGRAVITY_LIVE_RUNTIME_MODEL_MISMATCH:${String(configuredModel)}`)
        }
        const options = runtimeState.options
        const originalPermissionRequest = options?.onPermissionRequest
        if (
          options !== undefined &&
          typeof originalPermissionRequest === 'function' &&
          !wrappedPermissionOptions.has(options)
        ) {
          const wrappedPermissionRequest: RuntimePermissionRequest = async function (
            this: unknown,
            ...callbackArgs: unknown[]
          ): Promise<unknown> {
            const params = record(callbackArgs[0])
            const toolCall = record(params?.toolCall)
            interactionRequests += 1
            permissionRequests.push({
              sessionId: hash(
                String(params?.sessionId ?? runtimeState.options?.diagnosticDshSessionId ?? 'unavailable'),
              ),
              callId: hash(String(toolCall?.toolCallId ?? `permission-${interactionRequests}`)),
              ...(typeof toolCall?.name === 'string' ? { toolName: toolCall.name } : {}),
            })
            if (stickyViolation !== undefined) return { outcome: { outcome: 'cancelled' } }
            if (interactionRequests > INTERACTION_LIMIT) {
              cancelRun('INTERACTION_LIMIT')
              return { outcome: { outcome: 'cancelled' } }
            }
            if (expectedNativeCommand !== undefined) {
              const rawInput = record(toolCall?.rawInput)
              const toolCallId = toolCall?.toolCallId
              if (
                toolCall?.kind !== 'execute' ||
                rawInput?.CommandLine !== expectedNativeCommand ||
                typeof toolCallId !== 'string' ||
                toolCallId.length === 0
              ) {
                cancelRun('NATIVE_COMMAND_MISMATCH')
                return { outcome: { outcome: 'cancelled' } }
              }
              nativeCommandToolCallIds.set(expectedNativeCommand, toolCallId)
              verifiedNativeCommands.push({
                sessionId: hash(
                  String(params?.sessionId ?? runtimeState.options?.diagnosticDshSessionId ?? 'unavailable'),
                ),
                callId: hash(String(toolCall.toolCallId ?? `permission-${interactionRequests}`)),
                fingerprint: hash(expectedNativeCommand),
              })
              expectedNativeCommand = undefined
            } else {
              const rawInput = record(toolCall?.rawInput)
              const options = Array.isArray(params?.options) ? params.options.map(record) : undefined
              const isFixedQuestion =
                typeof toolCall?.toolCallId === 'string' &&
                /^interaction_[0-9a-f]{8}$/.test(toolCall.toolCallId) &&
                toolCall.status === 'pending' &&
                toolCall.title === 'Which test label should we use?' &&
                toolCall.name === undefined &&
                toolCall.kind === undefined &&
                rawInput !== undefined &&
                Object.keys(rawInput).length === 0 &&
                options?.length === 2 &&
                options[0]?.optionId === '1' &&
                options[0]?.name === 'ALPHA' &&
                options[0]?.kind === 'allow_once' &&
                Object.keys(options[0] ?? {}).length === 3 &&
                options[1]?.optionId === '2' &&
                options[1]?.name === 'BETA' &&
                options[1]?.kind === 'allow_once' &&
                Object.keys(options[1] ?? {}).length === 3
              if (!isFixedQuestion) {
                cancelRun('UNEXPECTED_NATIVE_PERMISSION')
                return { outcome: { outcome: 'cancelled' } }
              }
            }
            return originalPermissionRequest.apply(this, callbackArgs)
          }
          options.onPermissionRequest = wrappedPermissionRequest
          wrappedPermissionOptions.add(options)
          restorePermissionHandlers.push(() => {
            if (options.onPermissionRequest === wrappedPermissionRequest)
              options.onPermissionRequest = originalPermissionRequest
          })
        }
        return originalRuntimePrompt.apply(this, args)
      }
      restoreRuntimePrompt = () => {
        runtimePrototype.prompt = originalRuntimePrompt
      }
      diagnosticModule = (await loader.import(
        pathToFileURL(resolve(root, 'lib/contract/live-diagnostic-trace.js')).href,
      )) as NativeDiagnosticModule
      const remove = diagnosticModule.installLiveDiagnosticTrace(
        Object.assign(
          (event: LiveDiagnosticEvent) => {
            const sanitized = safeEvent(event, hash)
            diagnosticEvents.push(sanitized)
            if (event.type === 'acp-tool/update') {
              const key = `${event.acpSessionId ?? event.sessionId}:${event.providerToolCallId}`
              providerToolCalls.set(hash(key), event.providerToolStatus)
              if (providerToolCalls.size > PROVIDER_TOOL_LIMIT) cancelRun('PROVIDER_TOOL_LIMIT')
            }
            try {
              appendFileSync(tracePath, `${JSON.stringify(redactEvidence(sanitized))}\n`)
            } catch (error) {
              cancelRun('TRACE_WRITE_FAILED')
              throw error
            }
          },
          {
            id: (kind: string, value: unknown) => `h:${hash(`${kind}\0${JSON.stringify(value)}`)}`,
            fingerprint: (kind: string, value: unknown) => {
              const encoded = JSON.stringify(value)
              return {
                hmac: `h:${hash(`${kind}\0${encoded}`)}`,
                bytes: Buffer.byteLength(encoded ?? ''),
                complete: true,
              }
            },
          },
        ) as LiveDiagnosticTraceSink,
      )
      removeDiagnostic = remove
      expect(diagnosticModule.liveDiagnosticTraceEnabled()).toBe(true)

      browser = await launchBrowser({ headless: true })
      page = await newEnglishPage(browser)
      page.setDefaultTimeout(10_000)
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)

      await phase('question-beta', async () => {
        await capture('question-beta', 'start')
        const { settled, mainRequestCountBefore } = await send(
          'Use your native ask_question tool to ask exactly: “Which test label should we use?” with the two options ALPHA and BETA. Wait for my selection, then reply with only the selected label. Do not use any other tools.',
        )
        const question = await pendingQuestion('Which test label should we use?')
        await capture('question-beta', 'pending')
        const submit = question.getByRole('button', { name: /Submit|Send/ })
        expect(await submit.isDisabled()).toBe(true)
        expect(await question.locator('textarea, input[type="text"]').count()).toBe(0)
        expect(await question.getByText(/\bOther\b/i).count()).toBe(0)
        await question.getByRole('radio', { name: 'BETA', exact: true }).click()
        await question.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        expect(await submit.isEnabled()).toBe(true)
        await submit.click()
        const questionSessionId = await acceptSettled(settled, mainRequestCountBefore)
        expectTurnReason(questionSessionId, 'completed')
        expect(answerText(host!, questionSessionId)).toContain('BETA')
        const audit = await sidecar!.list(questionSessionId as never)
        const nativeQuestionDecision = audit
          .filter((entry) => entry.kind === 'permission' && entry.data.phase === 'decided')
          .at(-1)
        expect(nativeQuestionDecision?.kind === 'permission' ? nativeQuestionDecision.data : undefined).toMatchObject({
          optionId: '2',
          selectedOptionKind: 'allow_once',
          decisionVia: 'native-question',
        })
        await capture('question-beta', 'end')
        await page!.reload()
        await waitForAssistant('BETA')
        await capture('question-beta', 'reload')
      })

      await phase('allow-once', async () => {
        await capture('allow-once', 'start')
        const providerCallsBefore = new Set(providerToolCalls.keys())
        const allowCommand = 'printf ANTIGRAVITY_ALLOW_ONCE_MARKER'
        expectedNativeCommand = allowCommand
        const { settled, mainRequestCountBefore } = await send(
          `Use your native run_command tool exactly once to execute this exact command: \`${allowCommand}\`. Then report its output. Do not use DSH bash or any other tool.`,
        )
        const approval = page!.locator('[data-approval-key]')
        await approval.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        interactionCards += 1
        if (interactionCards > INTERACTION_LIMIT) {
          cancelRun('INTERACTION_LIMIT')
          throw new Error('ANTIGRAVITY_LIVE_INTERACTION_LIMIT')
        }
        expect(await page!.locator('[data-question-key]').count()).toBe(0)
        expect(await approval.innerText()).toContain('ANTIGRAVITY_ALLOW_ONCE_MARKER')
        await capture('allow-once', 'pending')
        await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
        const allowSessionId = await acceptSettled(settled, mainRequestCountBefore)
        expectedNativeCommand = undefined
        expectTurnReason(allowSessionId, 'completed')
        expect(
          [...providerToolCalls].filter(([id]) => !providerCallsBefore.has(id)).map(([, status]) => status),
        ).toContain('completed')
        expect(answerText(host!, allowSessionId)).toContain('ANTIGRAVITY_ALLOW_ONCE_MARKER')
        const call = await waitForNativeCall(allowCommand, 'allow-once end')
        const bash = call.locator('[data-variant="bash"]')
        await bash.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        await bash.click()
        await call
          .locator('[data-terminal]')
          .getByText('ANTIGRAVITY_ALLOW_ONCE_MARKER', { exact: true })
          .first()
          .waitFor()
        await capture('allow-once', 'end')
        await page!.reload()
        const reloadedCall = await waitForNativeCall(allowCommand, 'allow-once reload')
        const reloadedBash = reloadedCall.locator('[data-variant="bash"]')
        await expect.poll(() => reloadedBash.getAttribute('data-state')).toBe('ok')
        await assertSidecarCommand(allowSessionId, allowCommand, 'allow-once reload')
        await reloadedBash.click()
        await reloadedCall
          .locator('[data-terminal]')
          .getByText('ANTIGRAVITY_ALLOW_ONCE_MARKER', { exact: true })
          .first()
          .waitFor()
        await capture('allow-once', 'reload')
      })

      await phase('reject-write', async () => {
        await capture('reject-write', 'start')
        const providerCallsBefore = new Set(providerToolCalls.keys())
        const shellCommand = `printf ANTIGRAVITY_REJECTED_WRITE_MARKER > ${JSON.stringify(rejectedFile)}`
        expectedNativeCommand = shellCommand
        const { settled, mainRequestCountBefore } = await send(
          `Use your native run_command tool exactly once to execute this exact command: \`${shellCommand}\`. Do not use DSH bash or any other tool.`,
        )
        const approval = page!.locator('[data-approval-key]')
        await approval.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        interactionCards += 1
        if (interactionCards > INTERACTION_LIMIT) {
          cancelRun('INTERACTION_LIMIT')
          throw new Error('ANTIGRAVITY_LIVE_INTERACTION_LIMIT')
        }
        expect(await approval.innerText()).toContain('ANTIGRAVITY_REJECTED_WRITE_MARKER')
        await capture('reject-write', 'pending')
        await approval.getByRole('button', { name: 'Reject', exact: true }).click()
        const rejectedSessionId = await acceptSettled(settled, mainRequestCountBefore)
        expectedNativeCommand = undefined
        expectTurnReason(rejectedSessionId, 'completed')
        expect(existsSync(rejectedFile)).toBe(false)
        const ended = snapshotEvents(rejectedSessionId)
        expectTurnReason(rejectedSessionId, 'completed')
        const rejectAsked = (await sidecar!.list(rejectedSessionId as never))
          .filter((entry) => entry.kind === 'permission' && entry.data.phase === 'asked')
          .at(-1)
        const rejectDecision = (await sidecar!.list(rejectedSessionId as never))
          .filter((entry) => entry.kind === 'permission' && entry.data.phase === 'decided')
          .at(-1)
        expect(rejectAsked?.kind === 'permission' ? rejectAsked.data : undefined).toBeDefined()
        if (
          rejectAsked?.kind === 'permission' &&
          rejectAsked.data.phase === 'asked' &&
          rejectDecision?.kind === 'permission' &&
          rejectDecision.data.phase === 'decided'
        )
          expect(rejectDecision.data.requestId).toBe(rejectAsked.data.requestId)
        expect(rejectDecision?.kind === 'permission' ? rejectDecision.data : undefined).toMatchObject({
          outcome: 'selected',
          selectedOptionKind: 'reject_once',
          decisionVia: 'native-approval',
        })
        const providerFailure = [...providerToolCalls]
          .filter(([id]) => !providerCallsBefore.has(id))
          .some(([, status]) => status === 'failed')
        expect(providerFailure).toBe(true)
        expect(ended.some((event) => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(false)
        await capture('reject-write', 'end')
        await page!.reload()
        const rejectedCall = await waitForNativeCall(shellCommand, 'reject-write reload')
        expect(
          await page!
            .locator('[data-chat-flow-kind="assistant-step"]')
            .getByText(/ACP_ABORTED|ACP prompt was cancelled|This turn failed/)
            .count(),
        ).toBe(0)
        await assertNativeCommandInput(rejectedCall, shellCommand, 'reject-write-reload')
        await expect.poll(() => rejectedCall.locator('[data-variant="bash"]').getAttribute('data-state')).toBe('error')
        await capture('reject-write', 'reload')
      })

      await phase('stop-command', async () => {
        await capture('stop-command', 'start')
        const providerCallsBefore = new Set(providerToolCalls.keys())
        const stopSentinel = join(workspace, `antigravity-stop-${runId}.txt`)
        expect(existsSync(stopSentinel)).toBe(false)
        const command = `printf ANTIGRAVITY_STOP_STARTED > ${JSON.stringify(stopSentinel)}; sleep 20; printf ANTIGRAVITY_STOP_FINISHED`
        expectedNativeCommand = command
        const { settled, mainRequestCountBefore } = await send(
          `Use your native run_command tool exactly once to execute this exact command: \`${command}\`. Do not use DSH bash or any other tool.`,
        )
        const approval = page!.locator('[data-approval-key]')
        await approval.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        interactionCards += 1
        if (interactionCards > INTERACTION_LIMIT) {
          cancelRun('INTERACTION_LIMIT')
          throw new Error('ANTIGRAVITY_LIVE_INTERACTION_LIMIT')
        }
        expect(await approval.innerText()).toContain('ANTIGRAVITY_STOP_FINISHED')
        await capture('stop-command', 'pending')
        await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
        await expect
          .poll(
            () => {
              if (!existsSync(stopSentinel)) return undefined
              return readFileSync(stopSentinel, 'utf8')
            },
            { timeout: PHASE_TIMEOUT_MS },
          )
          .toBe('ANTIGRAVITY_STOP_STARTED')
        const stop = page!.getByRole('button', { name: 'Stop generating', exact: true })
        await stop.waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        await stop.click()
        const stoppedSessionId = await acceptSettled(settled, mainRequestCountBefore)
        expectedNativeCommand = undefined
        expectTurnReason(stoppedSessionId, 'aborted')
        const stoppedCall = [...providerToolCalls].filter(([id]) => !providerCallsBefore.has(id)).at(-1)
        expect(stoppedCall).toBeDefined()
        expect(stoppedCall?.[1]).not.toBe('in_progress')
        await assertSidecarCommand(stoppedSessionId, command, 'stop-command end')
        await capture('stop-command', 'end')
        await page!.reload()
        await page!.locator('[data-composer-input]').first().waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
        const reloadedStoppedCall = await waitForNativeCall(command, 'stop-command reload')
        await expect
          .poll(() => reloadedStoppedCall.locator('[data-variant="bash"]').getAttribute('data-state'))
          .toBe('stopped')
        await capture('stop-command', 'reload')
      })

      await phase('continue-smoke', async () => {
        await capture('continue-smoke', 'start')
        const stoppedCommand = `printf ANTIGRAVITY_STOP_STARTED > ${JSON.stringify(join(workspace, `antigravity-stop-${runId}.txt`))}; sleep 20; printf ANTIGRAVITY_STOP_FINISHED`
        const persistedStoppedCall = await waitForNativeCall(stoppedCommand, 'continue-smoke start')
        await expect
          .poll(() => persistedStoppedCall.locator('[data-variant="bash"]').getAttribute('data-state'))
          .toBe('stopped')
        await assertSidecarCommand(sessionId!, stoppedCommand, 'continue-smoke start')
        const marker = `ANTIGRAVITY_CONTINUE_${runId.slice(0, 8)}`
        const { settled, mainRequestCountBefore } = await send(`Do not use tools. Reply with exactly ${marker}.`)
        const smokeSessionId = await acceptSettled(settled, mainRequestCountBefore)
        expectTurnReason(smokeSessionId, 'completed')
        expect(answerText(host!, smokeSessionId)).toContain(marker)
        await capture('continue-smoke', 'end')
        await page!.reload()
        await waitForAssistant(marker)
        const reloadedStoppedCall = await waitForNativeCall(stoppedCommand, 'continue-smoke reload')
        await expect
          .poll(() => reloadedStoppedCall.locator('[data-variant="bash"]').getAttribute('data-state'))
          .toBe('stopped')
        await assertSidecarCommand(sessionId!, stoppedCommand, 'continue-smoke reload')
        await capture('continue-smoke', 'reload')
      })

      expect(stickyViolation).toBeUndefined()
      expect(hostToolCalls).toBe(0)
      expect(providerToolCalls.size).toBeLessThanOrEqual(PROVIDER_TOOL_LIMIT)
      expect(interactionCards).toBeLessThanOrEqual(INTERACTION_LIMIT)
      expect(interactionRequests).toBeLessThanOrEqual(INTERACTION_LIMIT)
      expect(interactionRequests).toBeGreaterThanOrEqual(4)
      expect(mainRequests.length).toBeGreaterThan(0)
      expect(mainRequests.every((request) => request.provider === PROVIDER && request.model === MODEL)).toBe(true)
      expect(runtimeConfigModels.length).toBeGreaterThan(0)
      expect(runtimeConfigModels.every((model) => model === MODEL)).toBe(true)
      expect(requestRoutes.length).toBeGreaterThan(0)
      expect(requestRoutes.every((route) => route.provider === PROVIDER && route.model === MODEL)).toBe(true)
      expect(diagnosticModule.liveDiagnosticTraceFailureCount()).toBe(0)
      expect(pageErrors).toEqual([])
      runStatus = 'passed'
      privateWrite(
        join(evidence, 'run.json'),
        JSON.stringify(
          redactEvidence({
            status: runStatus,
            model: MODEL,
            elapsedMs: Date.now() - startedAt,
            inheritedEnvKeyCount: inheritedEnvKeys.length,
            harnessProvided: harness !== undefined,
            runtimeConfigModels,
            mainRequests,
            requestRoutes,
            verifiedNativeCommands,
            nativeCommandRows,
            hostToolCalls,
            providerToolCallCount: providerToolCalls.size,
            interactionCards,
            diagnosticEvents: diagnosticEvents.length,
            hostToolResults,
          }),
          null,
          2,
        ),
      )
    } catch (error) {
      primaryFailure = error
      runStatus = 'failed'
      writePrimaryFailure(error)
      if (page !== undefined) {
        try {
          await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' })
          chmodSync(join(evidence, 'failure.png'), 0o600)
        } catch {
          // Keep the original failure if the renderer has already closed.
        }
      }
      try {
        saveEvidence('failure')
      } catch (evidenceError) {
        cancelRun('TRACE_WRITE_FAILED')
        writePrimaryFailure(error, evidenceError)
      }
      throw error
    } finally {
      const cleanupFailures: unknown[] = []
      try {
        await browser?.close()
      } catch (error) {
        cleanupFailures.push(error)
      }
      for (const id of providerAgents) {
        try {
          const agent = host?.ctx.agents.get(id as never) as
            | { cancel?: (reason: { kind: 'hook'; reason: string }, options?: { keepInbox: boolean }) => unknown }
            | undefined
          void agent?.cancel?.({ kind: 'hook', reason: stickyViolation ?? 'LIVE_TEST_FINISHED' }, { keepInbox: false })
        } catch {
          // Continue shutdown for the remaining Agents.
        }
      }
      try {
        await closeHost()
      } catch (error) {
        cleanupFailures.push(error)
      }
      try {
        await sidecar?.dispose()
      } catch (error) {
        cleanupFailures.push(error)
      }
      try {
        for (const restore of restorePermissionHandlers) restore()
        restoreRuntimePrompt?.()
        removeDiagnostic?.()
      } catch (error) {
        cleanupFailures.push(error)
      }
      if (totalTimer !== undefined) clearTimeout(totalTimer)
      try {
        privateWrite(
          join(evidence, 'run.json'),
          JSON.stringify(
            redactEvidence({
              status: stickyViolation === undefined ? runStatus : 'stopped',
              elapsedMs: Date.now() - startedAt,
              model: MODEL,
              inheritedEnvKeyCount: inheritedEnvKeys.length,
              providerToolCallCount: providerToolCalls.size,
              hostToolCalls,
              interactionCards,
              interactionRequests,
              mainRequests,
              requestRoutes,
              verifiedNativeCommands,
              nativeCommandRows,
              ...(stickyViolation === undefined ? {} : { stickyViolation }),
            }),
            null,
            2,
          ),
        )
      } catch (error) {
        cleanupFailures.push(error)
        cancelRun('TRACE_WRITE_FAILED')
      }
      if (cleanupFailures.length > 0) {
        const hadPrimaryFailure = primaryFailure !== undefined
        if (!hadPrimaryFailure) {
          primaryFailure = cleanupFailures[0]
          runStatus = 'failed'
        }
        writePrimaryFailure(primaryFailure, cleanupFailures[0])
        if (!hadPrimaryFailure)
          throw new AggregateError(cleanupFailures, 'Antigravity live E2E cleanup or final evidence failed')
      }
    }
  },
  TOTAL_TIMEOUT_MS,
)
