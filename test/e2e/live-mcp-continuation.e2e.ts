import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTraceSink } from '../../src/contract/live-diagnostic-trace.ts'
import { redactSecretText } from '../../src/contract/redaction.ts'

type NativeDiagnosticModule = {
  installLiveDiagnosticTrace(sink: LiveDiagnosticTraceSink): () => void
  liveDiagnosticTraceEnabled(): boolean
  liveDiagnosticTraceFailureCount(): number
}
type MainRequestEvidence = {
  sessionId: string
  provider: string
  model: string
  effectiveProvider: string
  effectiveModel: string
  toolSchemaCount: number
  requiredToolSchemas: { read: boolean; todo_write: boolean }
}
type RequestRouteEvidence = { sessionId: string; provider: string; model: string }

const optedIn = process.env.DSH_E2E_LIVE_MCP_CONTINUATION === '1'
const TOTAL_TIMEOUT_MS = 6 * 60_000
const PHASE_TIMEOUT_MS = 120_000
const HOST_TOOL_LIMIT = 8
const profiles = ['devin', 'codebuddy', 'antigravity'] as const
type Profile = (typeof profiles)[number]

type ObservedToolResult = {
  readonly name: string
  readonly callId: string
  readonly args: unknown
  readonly isError: boolean
  readonly result: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required for this live test`)
  return value
}

function configuredProfile(): Profile {
  const value = requiredString('DSH_E2E_LIVE_MCP_PROFILE')
  if (!profiles.includes(value as Profile)) throw new Error(`DSH_E2E_LIVE_MCP_PROFILE must be ${profiles.join(', ')}`)
  return value as Profile
}

function parseArgs(): string[] {
  let value: unknown
  try {
    value = JSON.parse(requiredString('DSH_E2E_LIVE_MCP_ARGS'))
  } catch {
    throw new Error('DSH_E2E_LIVE_MCP_ARGS must be a JSON string array')
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('DSH_E2E_LIVE_MCP_ARGS must be a JSON string array')
  return value
}

function redactEvidence(value: unknown, key = ''): unknown {
  if (/(?:header|authorization|cookie|credential|password|secret|token|api[_-]?key)/i.test(key)) return '<redacted>'
  if (typeof value === 'string') return redactSecretText(value)
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item))
  const object = asRecord(value)
  return object === undefined
    ? value
    : Object.fromEntries(Object.entries(object).map(([childKey, child]) => [childKey, redactEvidence(child, childKey)]))
}

function privateWrite(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(redactEvidence(value), null, 2), { mode: 0o600 })
}

function compact(value: unknown): string {
  return redactSecretText(JSON.stringify(value) ?? String(value)).slice(0, 6000)
}

function safeDiagnostic(event: LiveDiagnosticEvent, hash: (value: string) => string): LiveDiagnosticEvent {
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
  'continues a real DSH MCP todo and file read for the selected ACP profile',
  async () => {
    const startedAt = Date.now()
    const deadlineAt = startedAt + TOTAL_TIMEOUT_MS
    const runId = randomUUID()
    const evidence = join(root, '.local', 'e2e-live-mcp-continuation', runId)
    mkdirSync(evidence, { recursive: true, mode: 0o700 })
    const runSecret = randomBytes(32)
    const hash = (value: string) => createHmac('sha256', runSecret).update(value).digest('hex').slice(0, 24)

    let host: AdapterWorld | undefined
    let browser: TestBrowser | undefined
    let page: Page | undefined
    let diagnosticModule: NativeDiagnosticModule | undefined
    let removeDiagnostic: (() => void) | undefined
    let closePromise: Promise<void> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    let stickyViolation: string | undefined
    let status: 'running' | 'passed' | 'failed' = 'running'
    let primaryFailure: unknown
    let hostToolCount = 0
    let sessionId: string | undefined
    const mainRequests: MainRequestEvidence[] = []
    const requestRoutes: RequestRouteEvidence[] = []
    const providerSessions = new Set<string>()
    const providerToolStatuses = new Map<string, string>()
    const diagnosticEvents: LiveDiagnosticEvent[] = []
    const observedResults: ObservedToolResult[] = []
    const sessionEvents: { sessionId: string; event: SessionEvent }[] = []
    const observedSessionEvents = new Map<string, readonly SessionEvent[]>()
    const pageErrors: string[] = []

    const closeHost = (): Promise<void> => {
      if (closePromise === undefined && host !== undefined) {
        closePromise = host.close()
        void closePromise.catch(() => undefined)
      }
      return closePromise ?? Promise.resolve()
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
        privateWrite(join(evidence, 'primary-failure.json'), {
          originalFailure: failureDetails(error),
          ...(evidenceFailure === undefined ? {} : { evidenceFailure: failureDetails(evidenceFailure) }),
        })
      } catch {
        // Failure evidence is best-effort and must not replace the test failure.
      }
    }

    const stop = (reason: string): void => {
      if (stickyViolation !== undefined) return
      stickyViolation = reason
      for (const id of providerSessions) {
        try {
          const agent = host?.ctx.agents.get(id as never) as
            | { cancel?: (reason: { kind: 'hook'; reason: string }, options?: { keepInbox: boolean }) => unknown }
            | undefined
          void agent?.cancel?.({ kind: 'hook', reason }, { keepInbox: false })
        } catch {
          // Keep cancellation sticky even if one Agent cannot be reached.
        }
      }
      void closeHost()
    }

    const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      if (stickyViolation !== undefined) throw new Error(`LIVE_MCP_STOPPED:${stickyViolation}`)
      const remaining = Math.min(PHASE_TIMEOUT_MS, deadlineAt - Date.now())
      if (remaining <= 0) {
        stop('TOTAL_DEADLINE')
        throw new Error('LIVE_MCP_TOTAL_DEADLINE')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stop(`PHASE_TIMEOUT_${name}`)
          reject(new Error(`LIVE_MCP_PHASE_TIMEOUT:${name}`))
        }, remaining)
      })
      try {
        return await Promise.race([work(), timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    const saveEvidence = (stage: string): void => {
      const events = sessionId === undefined ? [] : snapshotEvents(sessionId)
      try {
        privateWrite(join(evidence, 'session-events.json'), {
          stage,
          sessionIdHash: sessionId === undefined ? undefined : hash(sessionId),
          snapshot: events,
          observedEvents: sessionEvents,
          hostToolResults: observedResults,
          mainRequests,
          requestRoutes,
          providerToolStatuses: [...providerToolStatuses].map(([id, status]) => ({ id, status })),
          diagnosticEvents,
        })
        privateWrite(join(evidence, 'run.json'), {
          status: stickyViolation === undefined ? status : 'stopped',
          stage,
          profile,
          model,
          hostToolCount,
          elapsedMs: Date.now() - startedAt,
          envKeyCount: envKeys.length,
          argsCount: args.length,
          ...(stickyViolation === undefined ? {} : { stickyViolation }),
        })
      } catch (error) {
        stop('TRACE_WRITE_FAILED')
        throw error
      }
    }

    let profile: Profile = 'devin'
    let model = ''
    let envKeys: string[] = []
    let args: string[] = []
    try {
      if (!optedIn) return
      totalTimer = setTimeout(() => stop('TOTAL_DEADLINE'), TOTAL_TIMEOUT_MS)
      profile = configuredProfile()
      model = requiredString('DSH_E2E_LIVE_MCP_MODEL')
      const command = requiredString('DSH_E2E_LIVE_MCP_COMMAND')
      if (!isAbsolute(command) || !existsSync(command))
        throw new Error('DSH_E2E_LIVE_MCP_COMMAND must be an existing absolute path')
      args = parseArgs()
      envKeys = (process.env.DSH_E2E_LIVE_MCP_ENV_KEYS ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      if (new Set(envKeys).size !== envKeys.length)
        throw new Error('DSH_E2E_LIVE_MCP_ENV_KEYS must not contain duplicates')
      const env = Object.fromEntries(
        envKeys.map((key) => {
          if (process.env[key] === undefined)
            throw new Error(`Explicit live-test environment variable is absent: ${key}`)
          return [key, process.env[key]]
        }),
      )
      const harness = process.env.DSH_E2E_LIVE_MCP_ANTIGRAVITY_HARNESS
      if (profile === 'antigravity' && harness !== undefined) {
        if (!isAbsolute(harness) || !existsSync(harness))
          throw new Error('DSH_E2E_LIVE_MCP_ANTIGRAVITY_HARNESS must be an existing absolute path')
        env['ANTIGRAVITY_HARNESS_PATH'] = harness
      }

      host = await launchAdapterWorld({ toolsMode: 'native' })
      if (stickyViolation !== undefined) {
        void closeHost()
        throw new Error(`LIVE_MCP_STOPPED:${stickyViolation}`)
      }
      const profileId = profile === 'codebuddy' ? 'codebuddy-code' : profile
      const provider = `acp-${profileId}`
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'auto',
        agents: {
          [profileId]: {
            name: `Live ${profile} MCP continuation`,
            command,
            args,
            env,
            runtime: profile,
          },
        },
      })
      await expect
        .poll(() => host!.ctx.llm.listProviders().some((item) => item.id === provider), { timeout: 30_000 })
        .toBe(true)
      expect(
        (await host.ctx.llm.listModels(provider)).some((item) => item.id === model),
        `Exact model ${model} is absent`,
      ).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider, model })

      const workspace = resolve(host.workspaceCwd, 'workspace')
      const marker = `MCP_READ_${runId.slice(0, 12)}`
      const markerPath = join(workspace, `live-mcp-${runId}.txt`)
      host.ctx.tools.guard((execution) => {
        hostToolCount += 1
        if (stickyViolation !== undefined) return `LIVE_MCP_GUARD:${stickyViolation}`
        if (execution.agent === undefined) {
          stop('TOOL_WITHOUT_AGENT')
          return `LIVE_MCP_GUARD:${stickyViolation}`
        }
        providerSessions.add(String(execution.agent.id))
        const args = asRecord(execution.arguments)
        const todos = args?.todos
        const todoArgs = asRecord(Array.isArray(todos) ? todos[0] : undefined)
        const allowedRead =
          execution.name === 'read' &&
          args !== undefined &&
          args.file_path === markerPath &&
          Object.keys(args).length === 1
        const allowedTodo =
          execution.name === 'todo_write' &&
          args !== undefined &&
          Object.keys(args).length === 1 &&
          Array.isArray(todos) &&
          todos.length === 1 &&
          todoArgs !== undefined &&
          Object.keys(todoArgs).length === 2 &&
          todoArgs.content === 'Read the temporary marker file' &&
          todoArgs.status === 'completed'
        const allowed = allowedRead || allowedTodo
        if (!allowed || hostToolCount > HOST_TOOL_LIMIT) {
          stop(!allowed ? `TOOL_SCOPE_${execution.name}` : 'HOST_TOOL_LIMIT')
          return `LIVE_MCP_GUARD:${stickyViolation}`
        }
        return undefined
      })
      host.ctx.on('tools/result', (execution, result) => {
        observedResults.push({
          name: execution.name,
          callId: hash(String(execution.callId)),
          args: execution.arguments,
          isError: result.isError,
          result: compact(result.value),
        })
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
      host.ctx.on('llm/stream', (request, next) => {
        if (request.purpose !== undefined) return next()
        providerSessions.add(String(request.sessionId))
        const requestedProvider = String(request.provider)
        const requestedModel = String(request.model)
        const toolSchemas = request.tools ?? []
        const toolNames = new Set(toolSchemas.map((schema) => schema.name))
        const requiredToolSchemas = {
          read: toolNames.has('read'),
          todo_write: toolNames.has('todo_write'),
        }
        const agent = host?.ctx.agents.get(request.sessionId as never)
        const effectiveConfig = agent?.session.requestHeader()?.config
        const effectiveProvider = String(effectiveConfig?.provider ?? '')
        const effectiveModel = String(effectiveConfig?.model ?? '')
        mainRequests.push({
          sessionId: hash(String(request.sessionId)),
          provider: requestedProvider,
          model: requestedModel,
          effectiveProvider,
          effectiveModel,
          toolSchemaCount: toolSchemas.length,
          requiredToolSchemas,
        })
        if (stickyViolation !== undefined) throw new Error(`LIVE_MCP_STOPPED:${stickyViolation}`)
        if (
          requestedProvider !== provider ||
          requestedModel !== model ||
          effectiveProvider !== provider ||
          effectiveModel !== model
        ) {
          stop(
            requestedProvider !== provider || effectiveProvider !== provider ? 'PROVIDER_MISMATCH' : 'MODEL_MISMATCH',
          )
          throw new Error(
            `LIVE_MCP_ROUTE_MISMATCH:${requestedProvider}:${requestedModel}:${effectiveProvider}:${effectiveModel}`,
          )
        }
        if (!requiredToolSchemas.read || !requiredToolSchemas.todo_write) {
          stop('REQUIRED_DSH_MCP_TOOL_SCHEMA_MISSING')
          throw new Error('LIVE_MCP_REQUIRED_DSH_MCP_TOOL_SCHEMA_MISSING')
        }
        return next()
      })

      const loader = host.ctx.loader as unknown as { internal?: unknown; import(specifier: string): Promise<unknown> }
      if (loader.internal === undefined) throw new Error('LIVE_MCP_NATIVE_LOADER_UNAVAILABLE')
      diagnosticModule = (await loader.import(
        pathToFileURL(resolve(root, 'lib/contract/live-diagnostic-trace.js')).href,
      )) as NativeDiagnosticModule
      const diagnosticPath = join(evidence, 'diagnostics.jsonl')
      writeFileSync(diagnosticPath, '', { mode: 0o600 })
      chmodSync(diagnosticPath, 0o600)
      removeDiagnostic = diagnosticModule.installLiveDiagnosticTrace(
        Object.assign(
          (event: LiveDiagnosticEvent) => {
            const safe = safeDiagnostic(event, hash)
            diagnosticEvents.push(safe)
            if (event.type === 'acp-tool/update') {
              const key = hash(`${event.acpSessionId ?? event.sessionId}:${event.providerToolCallId}`)
              providerToolStatuses.set(key, event.providerToolStatus)
              if (providerToolStatuses.size > 16) stop('PROVIDER_TOOL_LIMIT')
            }
            try {
              appendFileSync(diagnosticPath, `${JSON.stringify(redactEvidence(safe))}\n`)
            } catch (error) {
              stop('TRACE_WRITE_FAILED')
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
      expect(diagnosticModule.liveDiagnosticTraceEnabled()).toBe(true)

      browser = await launchBrowser({ headless: true })
      page = await newEnglishPage(browser)
      page.setDefaultTimeout(10_000)
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      writeFileSync(markerPath, `${marker}\n`, { mode: 0o600 })
      expect(existsSync(markerPath)).toBe(true)
      const waitForAssistantText = async (text: string): Promise<void> => {
        await page!
          .locator('[data-chat-flow-kind="assistant-step"]')
          .getByText(text, { exact: false })
          .last()
          .waitFor({ state: 'visible', timeout: PHASE_TIMEOUT_MS })
      }
      const assertPhaseRoutes = async (
        mainRequestCountBefore: number,
        expectedSessionId: string,
        requireEmittedRoute: boolean,
      ): Promise<void> => {
        const phaseRequests = mainRequests.slice(mainRequestCountBefore)
        expect(phaseRequests.length).toBeGreaterThan(0)
        expect(
          phaseRequests.every(
            (request) =>
              request.provider === provider &&
              request.model === model &&
              request.effectiveProvider === provider &&
              request.effectiveModel === model &&
              request.sessionId === hash(expectedSessionId),
          ),
        ).toBe(true)
        const sessionRoutes = requestRoutes.filter((route) => route.sessionId === hash(expectedSessionId))
        if (requireEmittedRoute) expect(sessionRoutes.length).toBeGreaterThan(0)
        expect(
          sessionRoutes.every(
            (route) =>
              route.provider === provider && route.model === model && route.sessionId === hash(expectedSessionId),
          ),
        ).toBe(true)
      }
      const evidenceShot = async (stage: string): Promise<void> => {
        await page!.screenshot({ path: join(evidence, `${stage}.png`), fullPage: true, animations: 'disabled' })
        chmodSync(join(evidence, `${stage}.png`), 0o600)
        saveEvidence(stage)
      }

      await evidenceShot('start')
      const firstMainRequestCount = mainRequests.length
      const initialHostToolCount = hostToolCount
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        `For this isolated verification, use only the current DSH MCP connection tools listed by tools/list: read and todo_write. Do not use native agent tools, shell, bash, Python, or any other tools. Call read exactly once with arguments {"file_path":${JSON.stringify(markerPath)}} and no other arguments. Then call todo_write exactly once with a complete one-item todo list: [{"content":"Read the temporary marker file","status":"completed"}]. Reply with the exact file contents only.`,
      )
      const settled = host.whenTurnSettled(PHASE_TIMEOUT_MS)
      void settled.catch(() => undefined)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      sessionId = await phase('mcp-turn', () => settled)
      await assertPhaseRoutes(firstMainRequestCount, sessionId, true)
      expect(hostToolCount - initialHostToolCount).toBe(2)
      const firstSessionId = sessionId
      const completed = snapshotEvents(sessionId)
      const turnEnd = completed.findLast((event) => event.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe('completed')
      const todoEvent = completed.filter((event) => event.type === 'todo/write').at(-1)
      expect(todoEvent?.type === 'todo/write' ? todoEvent.data.todos : undefined).toEqual([
        { content: 'Read the temporary marker file', status: 'completed' },
      ])
      const readResult = observedResults.find((result) => result.name === 'read')
      expect(readResult).toBeDefined()
      expect(readResult?.isError).toBe(false)
      expect(readResult?.result).toContain(marker)
      const todoResult = observedResults.find((result) => result.name === 'todo_write')
      expect(todoResult).toBeDefined()
      expect(todoResult?.isError).toBe(false)
      const todoArgs = asRecord(todoResult?.args)
      expect(todoArgs?.todos).toEqual([{ content: 'Read the temporary marker file', status: 'completed' }])
      expect(observedResults.map((result) => result.name)).toEqual(['read', 'todo_write'])
      const firstAssistant = completed.filter((event) => event.type === 'assistant/message').at(-1)
      const firstAssistantText =
        firstAssistant?.type === 'assistant/message'
          ? firstAssistant.data.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
          : ''
      const finalAssistantLine = firstAssistantText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)
      expect(finalAssistantLine).toBe(marker)
      expect(hostToolCount).toBeLessThanOrEqual(HOST_TOOL_LIMIT)
      expect(stickyViolation).toBeUndefined()
      expect(pageErrors).toEqual([])
      await waitForAssistantText(marker)
      await evidenceShot('end')
      await page.reload()
      await waitForAssistantText(marker)
      await evidenceShot('reload')

      const followupMarker = `MCP_CONTINUED_${runId.slice(0, 12)}`
      const followupMainRequestCount = mainRequests.length
      const followupHostToolCount = hostToolCount
      const followupResultCount = observedResults.length
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        `Do not use any tools. Reply with exactly ${followupMarker}.`,
      )
      const followupSettled = host.whenTurnSettled(PHASE_TIMEOUT_MS)
      void followupSettled.catch(() => undefined)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const followupSessionId = await phase('no-tools-followup', () => followupSettled)
      await assertPhaseRoutes(followupMainRequestCount, followupSessionId, false)
      expect(hostToolCount).toBe(followupHostToolCount)
      expect(observedResults).toHaveLength(followupResultCount)
      expect(followupSessionId).toBe(firstSessionId)
      sessionId = followupSessionId
      const continued = snapshotEvents(followupSessionId)
      const completedTurns = continued.filter((event) => event.type === 'turn/end')
      expect(
        completedTurns.slice(-2).every((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed'),
      ).toBe(true)
      const assistantText = continued
        .filter((event) => event.type === 'assistant/message')
        .map((event) =>
          event.type === 'assistant/message'
            ? event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n')
            : '',
        )
        .join('\n')
      expect(assistantText).toContain(marker)
      expect(assistantText).toContain(followupMarker)
      const lastAssistant = continued.filter((event) => event.type === 'assistant/message').at(-1)
      const lastAssistantText =
        lastAssistant?.type === 'assistant/message'
          ? lastAssistant.data.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
          : ''
      expect(lastAssistantText.trim()).toBe(followupMarker)
      expect(continued.filter((event) => event.type === 'todo/write').at(-1)).toMatchObject({
        type: 'todo/write',
        data: { todos: [{ content: 'Read the temporary marker file', status: 'completed' }] },
      })
      expect(observedResults).toHaveLength(2)
      expect(observedResults.map((result) => result.name)).toEqual(['read', 'todo_write'])
      expect(hostToolCount).toBe(2)
      expect(providerToolStatuses.size).toBeLessThanOrEqual(16)
      expect(mainRequests.length).toBeGreaterThanOrEqual(2)
      expect(
        mainRequests.every(
          (request) =>
            request.provider === provider &&
            request.model === model &&
            request.effectiveProvider === provider &&
            request.effectiveModel === model,
        ),
      ).toBe(true)
      expect(
        mainRequests.every(
          (request) =>
            request.toolSchemaCount > 0 && request.requiredToolSchemas.read && request.requiredToolSchemas.todo_write,
        ),
      ).toBe(true)
      expect(requestRoutes.length).toBeGreaterThan(0)
      expect(requestRoutes.every((route) => route.provider === provider && route.model === model)).toBe(true)
      expect(stickyViolation).toBeUndefined()
      expect(diagnosticModule.liveDiagnosticTraceFailureCount()).toBe(0)
      expect(pageErrors).toEqual([])
      await waitForAssistantText(followupMarker)
      await waitForAssistantText(marker)
      await evidenceShot('followup-end')
      await page.reload()
      await waitForAssistantText(followupMarker)
      await waitForAssistantText(marker)
      await evidenceShot('followup-reload')
      status = 'passed'
      saveEvidence('passed')
    } catch (error) {
      primaryFailure = error
      status = 'failed'
      writePrimaryFailure(error)
      if (page !== undefined) {
        try {
          await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' })
          chmodSync(join(evidence, 'failure.png'), 0o600)
        } catch {
          // Keep the original failure while retaining other captured evidence.
        }
      }
      try {
        saveEvidence('failure')
      } catch (evidenceError) {
        stop('TRACE_WRITE_FAILED')
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
      for (const id of providerSessions) {
        try {
          const agent = host?.ctx.agents.get(id as never) as
            | { cancel?: (reason: { kind: 'hook'; reason: string }, options?: { keepInbox: boolean }) => unknown }
            | undefined
          void agent?.cancel?.(
            { kind: 'hook', reason: stickyViolation ?? 'LIVE_MCP_TEST_FINISHED' },
            { keepInbox: false },
          )
        } catch {
          // Continue closing the isolated Host.
        }
      }
      try {
        await closeHost()
      } catch (error) {
        cleanupFailures.push(error)
      }
      try {
        removeDiagnostic?.()
      } catch (error) {
        cleanupFailures.push(error)
      }
      if (totalTimer !== undefined) clearTimeout(totalTimer)
      try {
        privateWrite(join(evidence, 'run.json'), {
          status: stickyViolation === undefined ? status : 'stopped',
          profile,
          model,
          hostToolCount,
          elapsedMs: Date.now() - startedAt,
          envKeyCount: envKeys.length,
          argsCount: args.length,
          ...(stickyViolation === undefined ? {} : { stickyViolation }),
        })
      } catch (error) {
        cleanupFailures.push(error)
        stop('TRACE_WRITE_FAILED')
      }
      if (cleanupFailures.length > 0) {
        const hadPrimaryFailure = primaryFailure !== undefined
        if (!hadPrimaryFailure) {
          primaryFailure = cleanupFailures[0]
          status = 'failed'
        }
        writePrimaryFailure(primaryFailure, cleanupFailures[0])
        if (!hadPrimaryFailure)
          throw new AggregateError(cleanupFailures, 'MCP continuation E2E cleanup or final evidence failed')
      }
    }
  },
  TOTAL_TIMEOUT_MS,
)
