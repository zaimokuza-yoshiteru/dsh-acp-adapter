import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Page } from 'playwright'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import {
  OPTIONAL_TOOL_PLAN,
  type OptionalToolPlan,
  type OptionalToolRecord,
} from '../mock-agent/optional-tools-turn.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { callResult, launchOptionalToolWorld } from './optional-tool-world.ts'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'

const SEARCH_TOOLS = [
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
]
const TERMINAL_TOOLS = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
]

function shellQuote(text: string): string {
  return process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`
}

function nodeCommand(script: string): string {
  return `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} -e ${shellQuote(script)}`
}

/** The ready file and the existing MCP execution jointly own this start barrier. */
function waitForTerminalReady(file: string, execution: Promise<OptionalToolRecord[]>, workspaceRoot: string) {
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const watcher = watch(dirname(file), (_event, filename) => {
      if (filename === null || filename.toString() === basename(file)) inspect()
    })
    const timeout = setTimeout(() => finish(new Error('Terminal foreground did not become ready within 15s')), 15_000)
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      watcher.close()
      if (error === undefined) resolve()
      else reject(error)
    }
    const inspect = () => {
      if (finished) return
      // A create event can precede writeFileSync's bytes reaching the file.
      // Require the complete PID, rather than treating an empty file as ready.
      try {
        if (existsSync(file) && /^[1-9]\d*$/.test(readFileSync(file, 'utf8'))) finish()
      } catch (error) {
        finish(error)
      }
    }
    watcher.on('error', finish)
    void execution.then(
      (records) => {
        if (finished) return
        // Keep the actual result visible if the command fails or settles before
        // readiness. Full events and audits remain in the local-only capture.
        try {
          const result = records.some((record) => record.kind === 'call' && record.name === 'terminal_send')
            ? callResult(records, 'terminal_send')
            : { kinds: records.map((record) => record.kind) }
          const detail = JSON.stringify(result)
            .replaceAll(workspaceRoot, '[fixture-workspace]')
            .replaceAll(process.execPath, '[node]')
            .replaceAll(/https?:\/\/[^\s"'<>]+/g, '[redacted-url]')
            .slice(0, 1_500)
          finish(new Error(`Terminal MCP execution settled before foreground readiness: ${detail}`))
        } catch (error) {
          finish(error)
        }
      },
      (error: unknown) => finish(error),
    )
    inspect()
  })
}

type OptionalWorld = Awaited<ReturnType<typeof launchOptionalToolWorld>>

async function bootstrap(world: OptionalWorld, page: Page, label: string): Promise<Agent> {
  await writeComposerDraft(
    page,
    page.locator('[data-composer-input]').first(),
    `${OPTIONAL_TOOL_PLAN}${JSON.stringify({ label, calls: [] })}`,
  )
  const settled = world.whenTurnSettled()
  void settled.catch(() => undefined)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const resolved = await world.ctx.sessionController.resolveAgent(await settled)
  if ('error' in resolved) throw new Error(resolved.error.message)
  await expect
    .poll(() => page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session'))
    .toBe(resolved.agent.id)
  return resolved.agent
}

/** Each target operation is approved through its real native UI, including Auto.
 * This is an explicit user decision for an exact request, never a setup answerer. */
async function runApproved(
  world: OptionalWorld,
  page: Page,
  owner: Agent,
  plan: OptionalToolPlan,
  afterApprovals?: (execution: Promise<OptionalToolRecord[]>) => Promise<void>,
) {
  expect(await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')).toBe(
    owner.id,
  )
  const pending = world.run(owner, plan)
  const execution: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' }
  // Observe the execution while the UI handles approvals. A rejected turn must
  // remain the primary failure, rather than disappearing behind a missing audit.
  void pending.then(
    () => {
      execution.status = 'fulfilled'
    },
    (error: unknown) => {
      execution.status = 'rejected'
      execution.error = error
    },
  )
  let stage = 'await-asked-audit'
  let callId: string | undefined
  try {
    for (const [index, step] of plan.calls.entries()) {
      callId = `optional-${plan.label}-${index}`
      // Native terminal_close waits for process-tree teardown. Its approval is
      // not completion, so the next request cannot be expected until its actual
      // MCP result arrives. This shares the existing execution's turn budget.
      if (index > 0) {
        stage = 'await-previous-call-result'
        await world.waitForRecordedCalls(plan.label, index, pending)
      }
      stage = 'await-asked-audit'
      await expect
        .poll(() =>
          acpPermissionAudit(world, 'asked').find(
            (entry) => entry.sessionId === owner.id && entry.data.toolCall.toolCallId === callId,
          ),
        )
        .toBeDefined()
      stage = 'assert-asked-audit'
      const asked = required(
        acpPermissionAudit(world, 'asked').find(
          (entry) => entry.sessionId === owner.id && entry.data.toolCall.toolCallId === callId,
        ),
      )
      expect(asked.data.toolCall.title).toBe(step.name)
      // The readable audit summary is redacted and bounded; its original-input
      // hash still binds the complete command and every argument without truncation.
      expect(asked.data.toolCall.rawInputHash).toBe(summarizeRawInputForAudit(step.arguments ?? {}).hash)
      expect(asked.data.options).toEqual([
        { optionId: 'allow', kind: 'allow_once', name: 'Allow this operation' },
        { optionId: 'deny', kind: 'reject_once', name: 'Reject this operation' },
      ])
      stage = 'await-approval-ui'
      const approval = page.locator('[data-approval-key]').filter({ hasText: step.name })
      await approval.waitFor({ state: 'visible' })
      expect(world.records(plan.label).filter((record) => record.kind === 'call')).toHaveLength(index)
      expect(
        acpPermissionAudit(world, 'decided').filter((entry) => entry.data.requestId === asked.data.requestId),
      ).toEqual([])
      stage = 'approve-once'
      await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      stage = 'await-decided-audit'
      await expect
        .poll(() => acpPermissionAudit(world, 'decided').find((entry) => entry.data.requestId === asked.data.requestId))
        .toMatchObject({
          sessionId: owner.id,
          data: {
            toolCallId: callId,
            outcome: 'selected',
            optionId: 'allow',
            selectedOptionKind: 'allow_once',
            decisionVia: 'native-approval',
          },
        })
    }
    stage = 'after-approvals'
    await afterApprovals?.(pending)
    stage = 'await-execution'
    return await pending
  } catch (error) {
    let diagnostic = ''
    try {
      diagnostic = world.captureFailure(owner, plan, 'approval', {
        stage,
        callId,
        execution,
        error,
        asked: acpPermissionAudit(world, 'asked').filter((entry) => entry.sessionId === owner.id),
        decided: acpPermissionAudit(world, 'decided').filter((entry) => entry.sessionId === owner.id),
      })
    } catch {
      diagnostic = 'evidence capture failed'
    }
    throw new Error(
      `Optional tools approval failed: label=${plan.label}, callId=${callId ?? 'none'}, stage=${stage}; ${diagnostic}`,
      {
        cause: execution.status === 'rejected' ? execution.error : error,
      },
    )
  }
}

it('mounts official session search and reads only prior history authorized by the caller workspace', async () => {
  const world = await launchOptionalToolWorld(['session-search'])
  let browser: TestBrowser | undefined
  try {
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(world.authenticatedUrl)
    await connectFreshWorkspace(page, world.workspaceCwd)
    const owner = await bootstrap(world, page, 'search-bootstrap')
    const ownerCwd = required(owner.session.header.cwd)
    const needle = 'OPTIONALSEARCHNEEDLE'
    const foreignSecret = 'FOREIGNHISTORYPRIVATE'
    const prior = await world.create(ownerCwd)
    await world.run(prior, { label: needle, calls: [] })
    const priorEvent = required(
      prior.session
        .snapshotEvents()
        .find((event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(needle)),
    )
    const foreignCwd = join(ownerCwd, 'foreign-workspace')
    mkdirSync(foreignCwd)
    const foreign = await world.create(foreignCwd)
    await world.run(foreign, { label: `${needle} ${foreignSecret}`, calls: [] })
    const foreignEvent = required(
      foreign.session
        .snapshotEvents()
        .find((event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(foreignSecret)),
    )
    const result = await runApproved(world, page, owner, {
      label: 'search-authorized-history',
      calls: [
        { name: 'session_search', arguments: { query: needle } },
        { name: 'session_event_search', arguments: { session_id: prior.id, query: needle } },
        { name: 'session_trace', arguments: { session_id: prior.id } },
        { name: 'session_event_trace', arguments: { session_id: prior.id, seq: priorEvent.seq } },
        { name: 'session_event_read', arguments: { session_id: prior.id, seq: priorEvent.seq, before: 1, after: 1 } },
      ],
    })
    expect(required(result.find((record) => record.kind === 'directory')).names).toEqual(
      expect.arrayContaining(SEARCH_TOOLS),
    )
    for (const name of SEARCH_TOOLS) expect(callResult(result, name).isError).toBe(false)
    const searched = callResult(result, 'session_search').text
    expect(searched).toContain(prior.id)
    expect(searched).toContain(needle)
    expect(searched).not.toContain(foreign.id)
    expect(searched).not.toContain(foreignSecret)
    expect(callResult(result, 'session_event_read').text).toContain(needle)
    expect(callResult(result, 'session_event_search').text).toContain(`seq ${priorEvent.seq}`)
    expect(callResult(result, 'session_trace').text).toContain(prior.id)
    expect(callResult(result, 'session_event_trace').text).toContain(String(priorEvent.seq))
    expect(world.nativeCalls.filter((call) => call.owner === owner.id).map((call) => call.name)).toEqual(SEARCH_TOOLS)

    // An explicit id cannot cross the same authorization boundary enforced by search.
    const denied = await runApproved(world, page, owner, {
      label: 'search-foreign-denied',
      calls: [{ name: 'session_event_read', arguments: { session_id: foreign.id, seq: foreignEvent.seq } }],
    })
    expect(callResult(denied, 'session_event_read')).toMatchObject({ isError: true })
    expect(callResult(denied, 'session_event_read').text).toContain('outside the caller workspace')
    expect(callResult(denied, 'session_event_read').text).not.toContain(foreignSecret)

    // The current prompt is persisted, but the native current-step boundary excludes it.
    const current = await runApproved(world, page, owner, {
      label: 'CURRENTSTEPSEARCHPRIVATE',
      calls: [{ name: 'session_event_search', arguments: { query: 'CURRENTSTEPSEARCHPRIVATE' } }],
    })
    expect(callResult(current, 'session_event_search')).toMatchObject({ isError: false })
    expect(callResult(current, 'session_event_search').text).toContain('No prior event matches found.')
    expect(prior.session.header.cwd).toBe(owner.session.header.cwd)
    expect(foreign.session.header.cwd).not.toBe(owner.session.header.cwd)
  } finally {
    await browser?.close()
    await world.close()
  }
}, 90_000)

it('executes official persistent terminal tools with native approval, exact owners and cancellation', async () => {
  const world = await launchOptionalToolWorld(['terminal-bundle'])
  let browser: TestBrowser | undefined
  try {
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(world.authenticatedUrl)
    await connectFreshWorkspace(page, world.workspaceCwd)
    const owner = await bootstrap(world, page, 'terminal-bootstrap')
    const ownerCwd = required(owner.session.header.cwd)
    await world.controls.setToolApprovalPolicy(owner.id, { policy: 'ask' })
    const rejecting = world.run(owner, {
      label: 'terminal-native-rejection',
      calls: [{ name: 'terminal_open', arguments: { type: 'shell', name: 'must-not-exist' } }],
    })
    void rejecting.catch(() => undefined)
    const approval = page.locator('[data-approval-key]').filter({ hasText: 'terminal_open' }).first()
    await approval.waitFor({ state: 'visible' })
    expect(world.nativeCalls.filter((call) => call.owner === owner.id)).toEqual([])
    await approval.getByRole('button', { name: 'Reject', exact: true }).click()
    const denied = await rejecting
    expect(denied.filter((record) => record.kind === 'call')).toEqual([])
    expect(required(denied.find((record) => record.kind === 'permission')).result).toMatchObject({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
    expect(world.nativeCalls.filter((call) => call.owner === owner.id)).toEqual([])
    expect(
      owner.session
        .snapshotEvents()
        .some((event) => event.type === 'approval/decided' && event.data.outcome === 'rejected'),
    ).toBe(true)

    await world.controls.setToolApprovalPolicy(owner.id, { policy: 'auto' })
    const opened = await runApproved(world, page, owner, {
      label: 'terminal-open',
      calls: [{ name: 'terminal_open', arguments: { type: 'shell', name: 'official-state' } }],
    })
    expect(required(opened.find((record) => record.kind === 'directory')).names).toEqual(
      expect.arrayContaining(TERMINAL_TOOLS),
    )
    expect(callResult(opened, 'terminal_open').isError).toBe(false)
    const spawn = required(world.nativeCalls.find((call) => call.owner === owner.id && call.name === 'terminal_open'))
    const terminalId = (spawn.value as { sessionId: string }).sessionId
    expect(terminalId).toMatch(/^pty-/)
    expect(callResult(opened, 'terminal_open').text).toContain(terminalId)

    const setState =
      process.platform === 'win32'
        ? "$env:DSH_OPTIONAL_STATE='PERSISTENT_NATIVE_SECRET'"
        : "export DSH_OPTIONAL_STATE='PERSISTENT_NATIVE_SECRET'"
    await runApproved(world, page, owner, {
      label: 'terminal-set-state',
      calls: [{ name: 'terminal_send', arguments: { sessionId: terminalId, text: setState } }],
    })
    const state = await runApproved(world, page, owner, {
      label: 'terminal-read-state',
      calls: [
        {
          name: 'terminal_send',
          arguments: { sessionId: terminalId, text: nodeCommand('console.log(process.env.DSH_OPTIONAL_STATE)') },
        },
        { name: 'terminal_read', arguments: { sessionId: terminalId } },
        { name: 'terminal_list' },
      ],
    })
    expect(callResult(state, 'terminal_send').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(state, 'terminal_read').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(state, 'terminal_list').text).toContain(terminalId)

    const otherPage = await newEnglishPage(browser)
    await otherPage.goto(world.authenticatedUrl)
    await otherPage.locator('[data-conversation-session]').last().waitFor()
    await otherPage.getByRole('button', { name: 'New session', exact: true }).last().click()
    await otherPage.getByText('Into the Unknown', { exact: true }).waitFor()
    const other = await bootstrap(world, otherPage, 'terminal-foreign-bootstrap')
    expect(other.id).not.toBe(owner.id)
    expect(other.session.header.cwd).toBe(owner.session.header.cwd)
    const forbiddenWrite = join(ownerCwd, 'foreign-terminal-write')
    const foreign = await runApproved(world, otherPage, other, {
      label: 'terminal-foreign-denied',
      calls: [
        { name: 'terminal_list' },
        { name: 'terminal_read', arguments: { sessionId: terminalId } },
        {
          name: 'terminal_send',
          arguments: {
            sessionId: terminalId,
            text: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(forbiddenWrite)},'wrong-owner')`),
          },
        },
        { name: 'terminal_signal', arguments: { sessionId: terminalId, signal: 'SIGINT' } },
        { name: 'terminal_close', arguments: { sessionId: terminalId } },
      ],
    })
    expect(callResult(foreign, 'terminal_list')).toEqual({ isError: false, text: '(no terminal sessions)' })
    for (const name of ['terminal_read', 'terminal_send', 'terminal_signal', 'terminal_close']) {
      expect(callResult(foreign, name).isError).toBe(true)
      expect(callResult(foreign, name).text).toContain('belongs to another agent')
      expect(callResult(foreign, name).text).not.toContain('PERSISTENT_NATIVE_SECRET')
    }
    expect(existsSync(forbiddenWrite)).toBe(false)

    // connectFreshWorkspace selects <scaffold root>/workspace. Linux bwrap
    // replaces /tmp and only rebinds that actual session workspace: a gate in
    // its parent is private to the PTY and cannot be observed by the Host.
    const ready = join(ownerCwd, 'terminal-foreground.ready')
    const stopped = join(ownerCwd, 'terminal-foreground.stopped')
    const cancel = join(ownerCwd, 'terminal-mcp.cancel')
    // Keep this foreground operation active until the explicit cancellation;
    // otherwise the native output-silence heuristic can settle it first.
    const script = `const fs=require('node:fs');process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'interrupted');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>console.log('TERMINAL_CANCEL_PENDING'),1000)`
    const cancelled = await runApproved(
      world,
      page,
      owner,
      {
        label: 'terminal-cancel-call',
        calls: [
          {
            name: 'terminal_send',
            arguments: { sessionId: terminalId, text: nodeCommand(script) },
            cancelFile: cancel,
          },
        ],
      },
      async (execution) => {
        await waitForTerminalReady(ready, execution, world.workspaceCwd)
        const childPid = Number(readFileSync(ready, 'utf8'))
        expect(childPid).toBeGreaterThan(0)
        expect(
          world
            .records('terminal-cancel-call')
            .filter((record) => record.kind === 'call' || record.kind === 'cancelled'),
        ).toEqual([])
        writeFileSync(cancel, 'cancel this one MCP request')
      },
    )
    expect(cancelled.filter((record) => record.kind === 'cancelled')).toMatchObject([{ name: 'terminal_send' }])
    await vi.waitFor(() => expect(existsSync(stopped)).toBe(true), { timeout: 10_000 })
    const after = await runApproved(world, page, owner, {
      label: 'terminal-after-cancel',
      calls: [
        {
          name: 'terminal_send',
          arguments: { sessionId: terminalId, text: nodeCommand('console.log(process.env.DSH_OPTIONAL_STATE)') },
        },
        { name: 'terminal_close', arguments: { sessionId: terminalId } },
        { name: 'terminal_list' },
      ],
    })
    expect(callResult(after, 'terminal_send')).toMatchObject({ isError: false })
    expect(callResult(after, 'terminal_send').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(after, 'terminal_close').isError).toBe(false)
    expect(callResult(after, 'terminal_list')).toEqual({ isError: false, text: '(no terminal sessions)' })
    // This lane exercised Host PTY tools, never ACP terminal/create or acp-terminal jobs.
    expect(world.ctx.jobs.list(owner.id).filter((job) => job.kind === 'acp-terminal')).toEqual([])
  } finally {
    await browser?.close()
    await world.close()
  }
}, 120_000)
