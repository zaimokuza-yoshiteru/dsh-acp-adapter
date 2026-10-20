import type {} from '@deepseek-ai/dsh-app-boot'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from 'playwright'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { ObservedEvent } from './types.ts'
import { required } from './required.ts'

type ProtocolRow = {
  readonly type: string
  readonly operation?: string
  readonly caseId?: string
  readonly phase?: string
  readonly supplied?: string
  readonly effective?: string
  readonly content?: unknown
}

describe('host instruction delivery through the native loop and ACP subprocess', () => {
  let host: AdapterWorld
  let browser: TestBrowser
  let page: Page
  let directory: string
  let version = 'A'
  let ordinal = 0
  let caseId: string
  let errors: string[]
  let pending: Promise<unknown>[]
  const events: ObservedEvent[] = []
  const evidence = join(root, '.local/host-instruction-delivery', process.env.DSH_E2E_EVIDENCE_LABEL ?? 'current')
  const rows = (): ProtocolRow[] =>
    existsSync(join(directory, 'protocol.jsonl'))
      ? readFileSync(join(directory, 'protocol.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ProtocolRow)
      : []
  const records = (type: string) => rows().filter((row) => row.caseId === caseId && row.type === type)
  const gate = (phase: string) => join(directory, `${caseId}-${phase}`)

  beforeAll(async () => {
    host = await launchAdapterWorld()
    directory = join(host.workspaceCwd, 'host-instruction-gates')
    mkdirSync(directory, { recursive: true })
    mkdirSync(evidence, { recursive: true })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Host instruction protocol fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/host-instructions-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_HOST_INSTRUCTIONS_DIRECTORY: directory },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === 'acp-codex')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'fixture-model' })
    const contribution = host.ctx.plugin({
      name: 'e2e-host-instruction-delivery',
      inject: ['systemPrompt'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.systemPrompt.section({
            name: 'e2e-host-instruction-version',
            order: 0,
            text: () => `E2E_HOST_INSTRUCTION_${version}`,
          }),
        )
      },
    })
    await contribution.await()
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    browser = await launchBrowser({ headless: true })
  })

  beforeEach(async () => {
    version = 'A'
    errors = []
    pending = []
    caseId = `case-${++ordinal}`
    page = await newEnglishPage(browser)
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    if (ordinal === 1) await connectFreshWorkspace(page, host.workspaceCwd, 'host-instructions')
    else {
      await page.locator('[data-composer-input]').first().waitFor()
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    }
    // The native composer keeps the same DOM element while its Session-owned
    // editor changes. Editability alone can still describe the previous editor
    // immediately after New session; wait for the blank selection and view.
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').innerText()).toBe('New Session')
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ state: 'hidden' })
    const input = page.locator(
      '[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]',
    )
    await input.waitFor()
    await expect.poll(() => input.textContent()).toBe('')
  })

  afterEach(async () => {
    try {
      await page.screenshot({ path: join(evidence, `${caseId}.png`), fullPage: true })
      writeFileSync(join(evidence, `${caseId}-browser.txt`), await page.locator('body').innerText())
      writeFileSync(
        join(evidence, `${caseId}-protocol.json`),
        JSON.stringify(
          rows().filter((row) => row.caseId === caseId),
          null,
          2,
        ),
      )
      writeFileSync(join(evidence, `${caseId}-native-events.json`), JSON.stringify(events, null, 2))
      expect(errors).toEqual([])
    } finally {
      writeFileSync(gate('release-idle-ack'), 'cleanup')
      writeFileSync(gate('release-active'), 'cleanup')
      await Promise.allSettled(pending)
      await page.context().tracing.stop({ path: join(evidence, `${caseId}.trace.zip`) })
      await page.close()
    }
  })

  afterAll(async () => {
    const results = await Promise.allSettled([browser?.close(), host?.close()])
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Host instruction fixture cleanup failed')
  })

  async function send(phase: string) {
    const text = `E2E_HOST_CASE ${caseId} ${phase}`
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, text)
    await expect.poll(() => input.textContent()).toBe(text)
    const button = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => button.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(45_000)
    pending.push(settled)
    void settled.catch(() => {})
    await button.click()
    return { settled }
  }

  async function steer(phase: string) {
    const text = `E2E_HOST_CASE ${caseId} ${phase}`
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, text)
    await expect.poll(() => input.textContent()).toBe(text)
    await input.press('Enter')
    const queued = page.getByRole('listitem').filter({ hasText: text })
    await queued.getByRole('button', { name: 'Steer queued message' }).click()
  }

  async function settledState(phase: string, expected: string) {
    const { settled } = await send(phase)
    const id = await settled
    await page.getByText(`HOST_STATE ${caseId} ${phase} ${expected}`, { exact: true }).waitFor()
    return id
  }

  function settledDispatches(id: SessionId) {
    const database = new DatabaseSync(join(required(host.ctx.dshHomePath)('dsh-acp'), 'sidecar.sqlite'), {
      readOnly: true,
    })
    try {
      return Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM dispatch_ledger WHERE dsh_session_id = ? AND state = 'settled'")
            .get(id) as { count: number }
        ).count,
      )
    } finally {
      database.close()
    }
  }

  it('sends A once, omits an unchanged A, and delivers the native replacement B', async () => {
    const id = await settledState('initial', 'A')
    await settledState('repeat', 'A')
    version = 'B'
    await settledState('changed', 'B')
    expect(records('received').map((row) => row.supplied)).toEqual(['A', undefined, 'B'])
    expect(records('accepted').map((row) => row.effective)).toEqual(['A', 'A', 'B'])
    expect(
      events
        .filter((event) => event.sessionId === id && event.type === 'system/message')
        .map((event) => JSON.stringify(event)),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('E2E_HOST_INSTRUCTION_A'),
        expect.stringContaining('E2E_HOST_INSTRUCTION_B'),
      ]),
    )
  })

  it('restores A when the native loop steers back from an in-flight B request', async () => {
    await settledState('initial', 'A')
    version = 'B'
    const active = await send('hold-injected')
    await expect.poll(() => existsSync(gate('active-ready'))).toBe(true)
    await page.getByText(`HOST_RUNNING ${caseId} B`, { exact: true }).waitFor()
    version = 'A'
    await steer('steered')
    await active.settled
    const followup = await send('followup')
    await followup.settled
    // Inspect the actual wire payload first so a missing instruction fails
    // immediately; evidence includes its effect on the next complete turn too.
    expect(records('received').find((row) => row.operation === '_session/steering')?.supplied).toBe('A')
    expect(records('accepted').at(-1)?.effective).toBe('A')
    await page.getByText(`HOST_STATE ${caseId} followup A`, { exact: true }).waitFor()
    expect(records('received').at(-1)?.supplied).toBeUndefined()
  })

  it('delivers C in a new prompt after an idle refusal races with the old prompt terminal', async () => {
    const id = await settledState('initial', 'A')
    version = 'B'
    const active = await send('hold-refused')
    await expect.poll(() => existsSync(gate('active-ready'))).toBe(true)
    await page.getByText(`HOST_RUNNING ${caseId} B`, { exact: true }).waitFor()
    const before = settledDispatches(id)
    version = 'C'
    await steer('steered')
    await expect.poll(() => existsSync(gate('terminal-sent'))).toBe(true)
    // A durable settlement proves the Host consumed the old end_turn before
    // the peer returns promptRequired. No arbitrary delay controls this race.
    await expect.poll(() => settledDispatches(id)).toBe(before + 1)
    writeFileSync(gate('release-idle-ack'), 'release')
    await active.settled
    const followup = await send('followup')
    await followup.settled
    const fallback = records('received').find((row) => row.operation === 'session/prompt' && row.phase === 'steered')
    expect(fallback?.supplied).toBe('C')
    expect(records('accepted').at(-1)?.effective).toBe('C')
    await page.getByText(`HOST_STATE ${caseId} followup C`, { exact: true }).waitFor()
    expect(records('received').at(-1)?.supplied).toBeUndefined()
  })
})
