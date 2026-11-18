/** Native optional Ralph bundle over real ACP child sessions and MCP structured output. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { required } from './required.ts'

interface RecordEntry {
  kind: string
  sessionId?: string
  text?: string
  report?: { status: string }
  result?: { isError?: boolean }
}

it('runs native Ralph with distinct fresh ACP children, bounded handoff, structured completion and cancellation', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-acp-ralph-'))
  const log = join(scratch, 'agent.jsonl')
  const records = (): RecordEntry[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RecordEntry)
      : []
  let host: AdapterWorld | undefined, browser: TestBrowser | undefined
  const children: Agent[] = []
  const abort = new AbortController()
  try {
    host = await launchAdapterWorld({ optionalBundles: ['ralph-bundle'], toolExecutor: 'native' })
    const owned = host
    await owned.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        'ralph-fixture': {
          name: 'Offline Ralph ACP',
          command: process.execPath,
          args: [join(root, 'test/e2e/fixtures/ralph/agent.ts')],
          env: { HOME: owned.workspaceCwd, RALPH_FIXTURE_LOG: log },
        },
      },
    })
    await vi.waitFor(() =>
      expect(owned.ctx.llm.listProviders().some((entry) => entry.id === 'acp-ralph-fixture')).toBe(true),
    )
    await owned.ctx.agentDefaultModel.saveSelection({ provider: 'acp-ralph-fixture', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    await page.goto(owned.authenticatedUrl)
    await connectFreshWorkspace(page, owned.workspaceCwd)
    const settled = owned.whenTurnSettled(30_000)
    void settled.catch(() => {})
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'RALPH_PARENT_PROMPT_MARKER')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sessionId = await settled
    await page.getByText('RALPH_PARENT_HISTORY_MARKER', { exact: true }).waitFor()
    const parent = required(owned.ctx.agents.get(sessionId))
    const provider = required(owned.ctx.subagents.getProvider('spawn'))
    expect(provider.capabilities.outputSchema).toBe(true)
    expect(provider.inheritsParentContext).toBe(false)
    owned.ctx.on('subagent/start', (child) => children.push(required(owned.ctx.agents.get(child.id))))
    const result = await owned.ctx.tools
      .execute({
        signal: new AbortController().signal,
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId('ralph-acp-complete'),
            name: 'ralph',
            arguments: JSON.stringify({ objective: 'RALPH_COMPLETE_OBJECTIVE', maxRounds: 2 }),
          },
        ],
        agent: parent,
      })
      .then((batch) => required(batch.results[0]).result)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Ralph worker reported completion after 2 rounds.')
    expect(children).toHaveLength(2)
    expect(new Set(children.map((child) => child.id)).size).toBe(2)
    for (const child of children) {
      expect(child.session.header.cwd).toBe(parent.session.header.cwd)
      expect(child.session.header.parentSession).toBe(parent.session.id)
      expect(child.session.header.isSeeded).toBe(false)
      expect(child.session.inheritedEventCount).toBe(0)
      expect(owned.ctx.agents.get(child.id)).toBeUndefined()
    }
    const childPrompts = records().filter(
      (entry) => entry.kind === 'prompt' && entry.text?.includes('You are one fresh worker'),
    )
    expect(childPrompts).toHaveLength(2)
    expect(new Set(childPrompts.map((entry) => entry.sessionId)).size).toBe(2)
    for (const prompt of childPrompts) {
      expect(prompt.text).not.toContain('RALPH_PARENT_PROMPT_MARKER')
      expect(prompt.text).not.toContain('RALPH_PARENT_HISTORY_MARKER')
      expect(prompt.text).toContain('RALPH_COMPLETE_OBJECTIVE')
    }
    expect(childPrompts[0]?.text).not.toContain('RALPH_ROUND_ONE_HANDOFF')
    expect(childPrompts[1]?.text).toContain('RALPH_ROUND_ONE_HANDOFF')
    const completions = records().filter((entry) => entry.kind === 'structured-output')
    expect(completions.map((entry) => entry.report?.status)).toEqual(['continue', 'complete'])
    expect(completions.every((entry) => !entry.result?.isError)).toBe(true)

    const pending = owned.ctx.tools
      .execute({
        signal: abort.signal,
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId('ralph-acp-cancel'),
            name: 'ralph',
            arguments: JSON.stringify({ objective: 'RALPH_CANCEL_OBJECTIVE', maxRounds: 2 }),
          },
        ],
        agent: parent,
      })
      .then((batch) => required(batch.results[0]).result)
    void pending.catch(() => {})
    try {
      await expect
        .poll(() => records().filter((entry) => entry.kind === 'held-child').length, { timeout: 30_000 })
        .toBe(1)
      abort.abort()
      const cancelled = await pending
      expect(cancelled.isError).toBe(true)
      expect(JSON.stringify(cancelled.content)).toContain('Ralph workflow was cancelled')
      expect(children).toHaveLength(3)
      const held = required(records().find((entry) => entry.kind === 'held-child'))
      expect(records().some((entry) => entry.kind === 'cancel' && entry.sessionId === held.sessionId)).toBe(true)
      for (const child of children) expect(owned.ctx.agents.get(child.id)).toBeUndefined()
      expect(records().filter((entry) => entry.kind === 'structured-output')).toHaveLength(2)
      expect(records().filter((entry) => entry.kind === 'error')).toEqual([])
    } finally {
      abort.abort()
      await pending
    }
  } finally {
    abort.abort()
    await browser?.close()
    await host?.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})
