/** Opt-in real Devin checks. Only isolated marker files and swe-2-high are authorized. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

const enabled = process.env.DSH_E2E_LIVE_PARENT_PERMISSION === '1'
const before = process.env.DSH_E2E_PARENT_PERMISSION_BASELINE === '1'
const adapterDirectory = process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root
const reportRoot =
  process.env.DSH_E2E_LIVE_PARENT_PERMISSION_DIRECTORY ??
  join(root, '.local/parent-approval-20261021', before ? 'live-before' : 'live-after')

class NativeOwner extends LlmAdapter {
  constructor(private readonly hold?: Promise<void>) {
    super()
  }
  providerInfo(id: string) {
    return { id, name: 'Native ownership control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(): ReturnType<LlmAdapter['stream']> {
    const text = 'NATIVE_OWNER_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (this.hold !== undefined) await this.hold
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function permissionEvents(host: AdapterWorld, child: Agent) {
  return {
    asked: acpPermissionAudit(host, 'asked').filter((entry) => entry.sessionId === child.id),
    decided: acpPermissionAudit(host, 'decided').filter((entry) => entry.sessionId === child.id),
  }
}

async function configure(host: AdapterWorld, policy: 'ask' | 'auto') {
  const keys = (process.env.DSH_E2E_LIVE_DEVIN_ENV_KEYS ?? '').split(',').filter(Boolean)
  const env = Object.fromEntries(
    keys.map((key) => {
      const value = process.env[key]
      if (value === undefined) throw new Error(`Missing selected environment key: ${key}`)
      return [key, value]
    }),
  )
  host.ctx.effect(() => host.ctx.llm.registerAdapter(['parent-permission-native'], new NativeOwner()))
  await host.ctx.settings.replace('dsh-acp-adapter', {
    toolApprovalDefault: policy,
    agents: { devin: { name: 'Devin approval regression', command: 'devin', args: ['acp'], env } },
  })
  await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-devin')).toBe(true))
  expect((await host.ctx.llm.listModels('acp-devin')).some((m) => m.id === 'swe-2-high')).toBe(true)
  await host.ctx.agentDefaultModel.saveSelection({ provider: 'parent-permission-native', model: 'fixture' })
}

async function startChild(
  host: AdapterWorld,
  parent: Agent,
  label: string,
  marker: string,
  path: string,
  instruction?: string,
) {
  const writeSchema = required(host.ctx.tools.schemas(parent).find((tool) => tool.name === 'write'))
  const activation = await host.ctx.subagents.startActivation({
    provider: 'spawn',
    label,
    delivery: 'caller',
    request: {
      parent,
      maxDepth: 4,
      agentOptions: { provider: 'acp-devin', model: 'swe-2-high' },
      prompt: [
        {
          type: 'text',
          text:
            instruction ??
            `Call write on the dsh MCP server (mcp__dsh__write) exactly once with arguments ${JSON.stringify({ file_path: path, content: marker })}. Its exact current host schema is ${JSON.stringify(writeSchema)}. If tools are deferred, discover only mcp__dsh__write by its exact name; do not enumerate the entire server or read overflow files. Do not use another tool, shell, file reader, subagent or bypass. Wait for human approval. After a successful write, reply with ${marker} and finish. If approval is denied, cancelled or unavailable, report it and stop without retrying or substituting a tool. This test authorizes only this isolated marker file.`,
        },
      ],
    },
    signal: new AbortController().signal,
  })
  const child = required(host.ctx.agents.get(activation.childId))
  const result = { value: undefined as Awaited<SubagentActivation['result']> | undefined, error: undefined as unknown }
  void activation.result.then(
    (value) => {
      result.value = value
    },
    (error: unknown) => {
      result.error = error
    },
  )
  return { activation, child, result, path, marker }
}

async function settled(run: Awaited<ReturnType<typeof startChild>>) {
  await vi.waitFor(() => expect(run.result.value ?? run.result.error).toBeDefined(), { timeout: 150_000 })
  if (run.result.error !== undefined) throw run.result.error
  return required(run.result.value)
}

it.skipIf(!enabled).each(['ask', 'auto'] as const)(
  'real Devin %s keeps child identity and full parent choices across refresh',
  async (policy) => {
    const host = await launchAdapterWorld({ adapterDirectory, toolsMode: 'native' })
    let browser: TestBrowser | undefined
    let run: Awaited<ReturnType<typeof startChild>> | undefined
    const directory = join(reportRoot, `${policy}-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    const evidence: Record<string, unknown> = {
      platform: process.platform,
      baseline: before,
      policy,
      model: 'swe-2-high',
      parent: 'scripted native LlmAdapter',
      child: 'real Devin',
      enterprisePolicyVerified: false,
    }
    try {
      evidence.cliVersion = execFileSync('devin', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      await configure(host, policy)
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 1680, height: 1000 })
      page.setDefaultTimeout(15_000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const ready = host.whenTurnSettled(30_000)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'Prepare isolated permission comparison.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const parent = required(host.ctx.agents.get(await ready))
      host.ctx.permissionPresets.set(parent.session, 'workspace-write')
      const marker = `PARENT_PERMISSION_${randomUUID()}`
      const path = join(host.workspaceCwd, 'workspace', 'parent-permission.txt')
      run = await startChild(host, parent, `Devin ${policy} approval`, marker, path)
      evidence.parentSessionId = parent.id
      evidence.childSessionId = run.child.id
      if (before) {
        evidence.result = await settled(run)
        const audit = permissionEvents(host, run.child)
        evidence.audit = audit
        evidence.markerWritten = existsSync(path)
        if (policy === 'ask') {
          expect(audit.asked[0]?.data.optionCount).toBeGreaterThan(2)
          expect(audit.decided).toContainEqual(
            expect.objectContaining({
              data: expect.objectContaining({ note: 'delegated-question-unavailable', outcome: 'cancelled' }),
            }),
          )
          expect(existsSync(path)).toBe(false)
        } else {
          expect(readFileSync(path, 'utf8')).toBe(marker)
          evidence.observation = 'Devin ACP confirmation was answered without a human choice'
        }
        await page.screenshot({ path: join(directory, 'before.png') })
        evidence.status = 'reproduced'
        return
      }
      const card = page.locator('section[data-question-key]')
      await card.getByRole('radio', { name: 'Allow', exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
      const audit = permissionEvents(host, run.child)
      expect(audit.asked).toHaveLength(1)
      expect(audit.asked[0]?.data.optionCount).toBeGreaterThan(2)
      expect(await card.getByRole('radio').count()).toBe(audit.asked[0]?.data.optionCount)
      expect(run.result.value).toBeUndefined()
      expect(existsSync(path)).toBe(false)
      expect(host.ctx.approval.overrideOf(run.child.session)).toBe('never')
      expect(await card.locator('[data-question-source]').innerText()).toContain(run.child.id.slice(0, 8))
      const operation = await card.locator('[data-question-operation]').innerText()
      expect(operation).toContain(path)
      expect(operation).toContain(marker)
      expect(
        await card.getByRole('button', { name: 'Request details', exact: true }).getAttribute('aria-expanded'),
      ).toBe('false')
      expect(
        await card.evaluate((element) => {
          const header = element.querySelector('header')!
          const body = element.querySelector('[data-question-scroll]')!
          const box = body.getBoundingClientRect()
          return (
            header.scrollHeight <= header.clientHeight + 1 &&
            body.scrollTop === 0 &&
            [...body.querySelectorAll('[role="radio"]')].every((radio) => {
              const row = radio.getBoundingClientRect()
              return row.top >= box.top - 1 && row.bottom <= box.bottom + 1
            })
          )
        }),
      ).toBe(true)
      await page.screenshot({ path: join(directory, 'pending.png') })
      const originalRequest = audit.asked[0]?.data.requestId
      await page.reload()
      await card.getByRole('radio', { name: 'Allow', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      expect(permissionEvents(host, run.child).asked.map((entry) => entry.data.requestId)).toEqual([originalRequest])
      expect(existsSync(path)).toBe(false)
      await page.screenshot({ path: join(directory, 'refreshed.png') })
      await card.getByRole('radio', { name: 'Allow', exact: true }).click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      evidence.result = await settled(run)
      expect(readFileSync(path, 'utf8')).toBe(marker)
      const decided = permissionEvents(host, run.child).decided
      expect(decided).toHaveLength(1)
      expect(decided[0]?.data).toMatchObject({
        outcome: 'selected',
        optionId: 'allow_once',
        selectedOptionKind: 'allow_once',
      })
      expect(host.ctx.approval.overrideOf(run.child.session)).toBe('never')
      evidence.nativeChildPolicy = 'never'
      evidence.markerWritten = true
      evidence.status = 'passed'
      await page.screenshot({ path: join(directory, 'completed.png') })
    } catch (error) {
      evidence.status = 'failed'
      evidence.error = String(error)
      throw error
    } finally {
      if (run !== undefined) {
        evidence.audit = permissionEvents(host, run.child)
        evidence.markerWritten = existsSync(run.path)
        run.child.cancel({ kind: 'user' })
        await run.activation.dispose()
      }
      await browser?.close()
      try {
        await host.close()
        evidence.cleaned = true
      } finally {
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
      }
    }
  },
  300_000,
)

it.skipIf(!enabled || before)(
  'real concurrent nested Devin approvals cancel only their original child',
  async () => {
    const host = await launchAdapterWorld({ adapterDirectory, toolsMode: 'native' })
    let browser: TestBrowser | undefined
    let middle: SubagentActivation | undefined
    const hold = Promise.withResolvers<void>()
    const runs: Awaited<ReturnType<typeof startChild>>[] = []
    const directory = join(reportRoot, `nested-concurrent-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    const evidence: Record<string, unknown> = {
      platform: process.platform,
      model: 'swe-2-high',
      parent: 'scripted native controls',
      children: 'two real Devin instances',
      enterprisePolicyVerified: false,
    }
    try {
      evidence.cliVersion = execFileSync('devin', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      await configure(host, 'auto')
      host.ctx.effect(() => host.ctx.llm.registerAdapter(['parent-permission-holding'], new NativeOwner(hold.promise)))
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(15_000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const ready = host.whenTurnSettled(30_000)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'Prepare nested permission comparison.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const parent = required(host.ctx.agents.get(await ready))
      host.ctx.permissionPresets.set(parent.session, 'workspace-write')
      middle = await host.ctx.subagents.startActivation({
        provider: 'spawn',
        label: 'Nested coordinator',
        delivery: 'caller',
        request: {
          parent,
          maxDepth: 4,
          prompt: [{ type: 'text', text: 'Hold while owned descendants are checked.' }],
          agentOptions: { provider: 'parent-permission-holding', model: 'fixture' },
        },
        signal: new AbortController().signal,
      })
      const coordinator = required(host.ctx.agents.get(middle.childId))
      for (const label of ['First', 'Second'])
        runs.push(
          await startChild(
            host,
            coordinator,
            `${label} nested Devin`,
            `${label}_${randomUUID()}`,
            join(host.workspaceCwd, 'workspace', `${label.toLowerCase()}.txt`),
          ),
        )
      await vi.waitFor(
        () => {
          for (const run of runs) expect(permissionEvents(host, run.child).asked).toHaveLength(1)
        },
        { timeout: 120_000 },
      )
      for (const run of runs) {
        expect(run.result.value).toBeUndefined()
        expect(existsSync(run.path)).toBe(false)
        expect(host.ctx.agents.isOwnedBy(run.child.id, coordinator)).toBe(true)
        expect(host.ctx.approval.overrideOf(run.child.session)).toBe('never')
      }
      await page.screenshot({ path: join(directory, 'two-pending.png') })
      const cancelled = required(runs[1]),
        allowed = required(runs[0])
      cancelled.child.cancel({ kind: 'user' })
      await settled(cancelled)
      expect(existsSync(cancelled.path)).toBe(false)
      const card = page.locator('section[data-question-key]')
      await card.getByRole('radio', { name: 'Allow', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      expect(await card.innerText()).toContain('first.txt')
      await page.screenshot({ path: join(directory, 'cancelled-sibling.png') })
      await card.getByRole('radio', { name: 'Allow', exact: true }).click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      await settled(allowed)
      expect(readFileSync(allowed.path, 'utf8')).toBe(allowed.marker)
      expect(existsSync(cancelled.path)).toBe(false)
      expect(permissionEvents(host, cancelled.child).decided.every((entry) => entry.data.outcome !== 'selected')).toBe(
        true,
      )
      evidence.status = 'passed'
      await page.screenshot({ path: join(directory, 'completed.png') })
    } catch (error) {
      evidence.status = 'failed'
      evidence.error = String(error)
      throw error
    } finally {
      evidence.runs = runs.map((run) => ({
        childSessionId: run.child.id,
        parentSessionId: run.child.session.header.parentSession,
        result: run.result.value,
        markerWritten: existsSync(run.path),
        audit: permissionEvents(host, run.child),
      }))
      for (const run of runs) {
        run.child.cancel({ kind: 'user' })
        await run.activation.dispose()
      }
      hold.resolve()
      await middle?.dispose()
      await browser?.close()
      try {
        await host.close()
        evidence.cleaned = true
      } finally {
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
      }
    }
  },
  360_000,
)

it.skipIf(!enabled || before)(
  'real Devin project Deny preserves the native boundary and reports a missing summary truthfully',
  async () => {
    const host = await launchAdapterWorld({ adapterDirectory, toolsMode: 'native' })
    let browser: TestBrowser | undefined
    let run: Awaited<ReturnType<typeof startChild>> | undefined
    let captureFailure: (() => Promise<void>) | undefined
    let captureDenyEvidence: (() => unknown[]) | undefined
    const directory = join(reportRoot, `project-deny-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    const evidence: Record<string, unknown> = {
      platform: process.platform,
      model: 'swe-2-high',
      policy: 'auto',
      policySource: 'isolated project permission rule; not enterprise administration',
      enterprisePolicyVerified: false,
      scope: 'denied side effects and truthful adapter outcome; provider summary availability is recorded separately',
      parent: 'scripted native LlmAdapter',
      child: 'real Devin',
    }
    try {
      evidence.cliVersion = execFileSync('devin', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      await configure(host, 'auto')
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 1680, height: 1000 })
      page.setDefaultTimeout(15_000)
      captureFailure = async () => {
        await page.screenshot({ path: join(directory, 'failed.png') })
      }
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const ready = host.whenTurnSettled(30_000)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'Prepare isolated Devin deny regression.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const parent = required(host.ctx.agents.get(await ready))
      host.ctx.permissionPresets.set(parent.session, 'workspace-write')
      const configDirectory = join(required(parent.session.header.cwd), '.devin')
      mkdirSync(configDirectory, { recursive: true })
      const config = { permissions: { deny: ['mcp__dsh__write'], ask: [], allow: [] } }
      writeFileSync(join(configDirectory, 'config.local.json'), JSON.stringify(config))
      evidence.isolatedProjectRule = config
      const path = join(required(parent.session.header.cwd), 'denied.txt')
      const tools: { name: string; isError: boolean | undefined }[] = []
      host.ctx.on('tools/result', (execution, result) => {
        if (execution.agent === run?.child) tools.push({ name: execution.name, isError: result.isError })
      })
      const marker = `DENIED_${randomUUID()}`
      const schema = required(host.ctx.tools.schemas(parent).find((tool) => tool.name === 'write'))
      evidence.targetToolSchema = schema
      run = await startChild(
        host,
        parent,
        'Devin explicit project deny',
        marker,
        path,
        `Attempt exactly one call to write on the dsh MCP server (mcp__dsh__write) with arguments ${JSON.stringify({ file_path: path, content: marker })}. Its exact host schema is ${JSON.stringify(schema)}. If tools are deferred, discover only mcp__dsh__write by its exact name; do not enumerate the entire server or read overflow files. Do not use any other tool, shell, file reader, subagent or bypass. If the tool is denied or unavailable, state the reason and stop without retrying or substituting another tool. This test authorizes only this isolated marker file and does not authorize changing permission rules.`,
      )
      const child = run.child
      evidence.parentSessionId = parent.id
      evidence.childSessionId = child.id
      captureDenyEvidence = () => {
        evidence.audit = permissionEvents(host, child)
        evidence.childEvents = child.session.snapshotEvents()
        evidence.childTurnEnds = child.session.snapshotEvents().filter((event) => event.type === 'turn/end')
        evidence.toolResults = tools
        evidence.markerWritten = existsSync(path)
        evidence.nativeChildPolicy = host.ctx.approval.overrideOf(child.session)
        const database = new DatabaseSync(join(required(host.ctx.dshHomePath)('dsh-acp'), 'sidecar.sqlite'), {
          readOnly: true,
        })
        try {
          const activities = database
            .prepare(
              'SELECT activity_id, prompt_anchor_message_id, content_index, revision_seq, kind, presentation, status, raw_detail FROM activity_journal WHERE dsh_session_id = ? ORDER BY revision_seq',
            )
            .all(child.id)
          evidence.activities = activities
          evidence.dispatchStates = database
            .prepare('SELECT state, provider, model FROM dispatch_ledger WHERE dsh_session_id = ? ORDER BY created_at')
            .all(child.id)
          return activities
        } finally {
          database.close()
        }
      }
      const result = await settled(run)
      evidence.result = result
      // Collect the denied operation and typed turn outcome before assertions;
      // an empty provider answer must not hide whether any tool actually ran.
      const activities = captureDenyEvidence()
      const failedWrite = required(
        activities.find((entry) => {
          const row = entry as Record<string, unknown>
          return (
            row.kind === 'tool' &&
            row.status === 'failed' &&
            /write/i.test(String(row.raw_detail)) &&
            /denied|not allowed|not permitted|blocked/i.test(String(row.raw_detail))
          )
        }),
      ) as Record<string, unknown>
      expect(typeof failedWrite.content_index).toBe('number')
      const anchor = required(
        child.session
          .snapshotEvents()
          .find((event) => event.type === 'user/message' && event.data.id === failedWrite.prompt_anchor_message_id),
      )
      const reply = required(
        child.session
          .snapshotEvents()
          .filter((event) => event.type === 'assistant/message' || event.type === 'assistant/attempt')
          .findLast((event) => event.seq > anchor.seq),
      )
      // Read native persisted stream positions, including unsuccessful attempts.
      // A pre-tool plan is visible content, but cannot satisfy this fixture's
      // explicit request for an explanation of the denied operation.
      const textSegments = reply.data.stream.flatMap((record) => {
        if (record.type === 'text-chunks') return [{ index: record.index, text: record.texts.join('') }]
        if (record.type === 'chunk' && record.chunk.type === 'text-delta')
          return [{ index: record.chunk.index, text: record.chunk.text }]
        return []
      })
      const visibleText = textSegments
        .map((segment) => segment.text)
        .join('')
        .trim()
      const visibleSummary = textSegments
        .filter((segment) => segment.index >= Number(failedWrite.content_index))
        .map((segment) => segment.text)
        .join('')
        .trim()
      evidence.providerVisibleText = visibleText
      evidence.providerPostToolText = visibleSummary
      evidence.providerResponseStatus =
        visibleSummary.length > 0 ? 'visible-summary' : visibleText.length > 0 ? 'preamble-only' : 'missing-summary'
      evidence.toolResults = tools
      expect(permissionEvents(host, run.child).asked).toHaveLength(0)
      expect(permissionEvents(host, run.child).decided).toHaveLength(0)
      expect(tools).toEqual([])
      expect(existsSync(path)).toBe(false)
      expect(host.ctx.approval.overrideOf(run.child.session)).toBe('never')
      evidence.deniedSideEffectsVerified = true
      const turnEnd = required(child.session.snapshotEvents().findLast((event) => event.type === 'turn/end'))
      const expectedMissingSummary =
        'A tool call failed, and the ACP agent ended this turn without a visible response. See the failed step for details.'
      const expectedIncompleteSummary =
        'A tool call failed, and Devin ended this turn without a follow-up response. See the failed step for details.'
      if (visibleSummary.length > 0) {
        expect(result.stopReason).toBe('completed')
        expect(turnEnd.data.reason).toEqual({ kind: 'completed' })
        expect(visibleSummary).toMatch(/denied|not allowed|not permitted|blocked/i)
      } else {
        // This is an expected negative response contract, not provider success.
        // Arbitrary errors, silent completion, and synthetic answers still fail.
        expect(result.stopReason).toBe('error')
        expect(turnEnd.data.reason).toEqual({
          kind: 'error',
          error:
            visibleText.length > 0
              ? { code: 'ACP_INCOMPLETE_TOOL_RESPONSE', message: expectedIncompleteSummary }
              : { code: 'ACP_NO_VISIBLE_RESPONSE', message: expectedMissingSummary },
        })
        evidence.providerLimitation = 'Devin did not provide a visible final explanation after its tool was denied.'
      }
      await page.screenshot({ path: join(directory, 'denied-parent.png') })
      await page.getByRole('button', { name: '1 subagent', exact: true }).click()
      await page.getByRole('treeitem', { name: /^Devin explicit project deny / }).click()
      if (visibleSummary.length === 0) {
        await page
          .getByText(visibleText.length > 0 ? expectedIncompleteSummary : expectedMissingSummary, { exact: false })
          .first()
          .waitFor({ state: 'visible' })
      } else {
        await page.getByText(visibleSummary, { exact: false }).first().waitFor({ state: 'visible' })
      }
      evidence.viewport = page.viewportSize()
      evidence.outcomePresentationVerified = true
      evidence.status = 'passed'
      await page.screenshot({ path: join(directory, 'denied.png') })
    } catch (error) {
      evidence.status = 'failed'
      evidence.error = String(error)
      await captureFailure?.().catch(() => {})
      throw error
    } finally {
      try {
        captureDenyEvidence?.()
      } catch (error) {
        evidence.diagnosticError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
      }
      if (run !== undefined) {
        evidence.audit = permissionEvents(host, run.child)
        evidence.childEvents = run.child.session.snapshotEvents()
        evidence.markerWritten = existsSync(run.path)
        run.child.cancel({ kind: 'user' })
        await run.activation.dispose()
      }
      await browser?.close()
      try {
        await host.close()
        evidence.cleaned = true
      } finally {
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
      }
    }
  },
  240_000,
)
