import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'

interface WireEvent {
  readonly method: string
  readonly marker?: string
  readonly sessionId?: string
  readonly model?: string
  readonly effort?: string | null
  readonly response?: unknown
  readonly configId?: string
  readonly value?: string
}

async function launchQwenWorld() {
  const host = await launchAdapterWorld()
  const log = join(host.workspaceCwd, 'qwen-ui-wire.jsonl')
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        qwen: {
          name: 'Qwen Code fixture',
          command: process.execPath,
          args: [join(root, 'test/fixtures/qwen-ui-agent.mjs')],
          env: { HOME: host.workspaceCwd, QWEN_UI_LOG: log },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-qwen')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-qwen', model: 'qwen-toggle' })
    return { host, log }
  } catch (error) {
    await host.close()
    throw error
  }
}

function events(log: string): WireEvent[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WireEvent)
    : []
}

async function send(host: AdapterWorld, page: Page, marker: string) {
  const settled = host.whenTurnSettled(30_000)
  // If an earlier UI assertion fails, teardown still owns this pending turn.
  // Attach a rejection handler while retaining the original result for awaits.
  void settled.catch(() => undefined)
  await writeComposerDraft(page, page.locator('[data-composer-input]').first(), marker)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  return { settled }
}

async function capture(page: Page, name: string) {
  const directory = process.env.DSH_E2E_EVIDENCE_DIR
  if (directory === undefined) return
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `qwen-${name}.png`), animations: 'disabled' })
}

async function evidence(page: Page | undefined, log: string, phase: string, error: unknown) {
  const directory = join(root, '.local/e2e-failures', `qwen-code-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'facts.json'),
    JSON.stringify({ phase, error: String(error), wire: events(log) }, null, 2),
  )
  if (page !== undefined)
    await page.screenshot({ path: join(directory, 'page.png'), animations: 'disabled' }).catch(() => undefined)
}

// The real Loader, ACP profile adapter, native question service, gateway and
// browser composer run unchanged. Only the external ACP process is keyless.
it('routes Qwen single, multiple and custom answers through the native composer and cancels cleanly', async () => {
  const { host, log } = await launchQwenWorld()
  let browser: TestBrowser | undefined
  let page: Page | undefined
  let phase = 'launch'
  const errors: string[] = []
  try {
    browser = await launchBrowser({ headless: true })
    page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const card = page.locator('[data-question-key]')
    const sessions: string[] = []
    const answer = (marker: string) =>
      events(log).filter((entry) => entry.method === 'question/response' && entry.marker === marker)
    const start = async (marker: string) => {
      phase = marker
      const turn = await send(host, page!, marker)
      await card.waitFor()
      // A vendor question must not become a tool-approval decision, even with
      // the Host's approval default explicitly set to Ask.
      expect(await page!.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0)
      await card.getByRole('button', { name: 'Dismiss all questions', exact: true }).waitFor()
      return turn
    }
    const submit = () => card.getByRole('button', { name: 'Submit', exact: true })

    const single = await start('QWEN_UI_SINGLE')
    expect(await submit().isDisabled()).toBe(true)
    await card.getByRole('radio', { name: 'Qwen B', exact: true }).click()
    expect(answer('QWEN_UI_SINGLE')).toEqual([])
    await capture(page, 'single-choice')
    await submit().click()
    sessions.push(await single.settled)
    await expect
      .poll(() => answer('QWEN_UI_SINGLE').map((entry) => entry.response))
      .toEqual([{ outcome: { outcome: 'selected', optionId: 'proceed_once' }, answers: { '0': 'Qwen B' } }])
    await card.waitFor({ state: 'hidden' })

    const multiple = await start('QWEN_UI_MULTI')
    await card.getByRole('radio', { name: 'Qwen B', exact: true }).click()
    await card.getByRole('heading', { name: 'Which Qwen features?', exact: true }).waitFor()
    await card.getByRole('checkbox', { name: 'Qwen X', exact: true }).click()
    await card.getByRole('checkbox', { name: 'Qwen Y', exact: true }).click()
    await card.getByPlaceholder('Type your answer', { exact: true }).fill('Qwen custom feature')
    expect(await card.getByRole('checkbox', { name: 'Qwen X', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect(await card.getByRole('checkbox', { name: 'Qwen Y', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect(answer('QWEN_UI_MULTI')).toEqual([])
    await capture(page, 'multiple-and-custom')
    await submit().click()
    sessions.push(await multiple.settled)
    await expect
      .poll(() => answer('QWEN_UI_MULTI').map((entry) => entry.response))
      .toEqual([
        {
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
          answers: { '0': 'Qwen B', '1': 'Qwen X, Qwen Y, Qwen custom feature' },
        },
      ])
    await card.waitFor({ state: 'hidden' })

    const custom = await start('QWEN_UI_CUSTOM')
    await card.getByRole('radio', { name: 'Qwen A', exact: true }).click()
    await card.getByPlaceholder('Type your answer', { exact: true }).fill('Qwen custom library')
    expect(await card.locator('[role="radio"][aria-checked="true"]').count()).toBe(0)
    await submit().click()
    sessions.push(await custom.settled)
    await expect
      .poll(() => answer('QWEN_UI_CUSTOM').map((entry) => entry.response))
      .toEqual([
        { outcome: { outcome: 'selected', optionId: 'proceed_once' }, answers: { '0': 'Qwen custom library' } },
      ])
    await card.waitFor({ state: 'hidden' })

    const dismissed = await start('QWEN_UI_DISMISS')
    await card.getByRole('button', { name: 'Dismiss all questions', exact: true }).click()
    sessions.push(await dismissed.settled)
    await expect
      .poll(() => answer('QWEN_UI_DISMISS').map((entry) => entry.response))
      .toEqual([{ outcome: { outcome: 'cancelled' } }])
    await card.waitFor({ state: 'hidden' })

    const stopped = await start('QWEN_UI_STOP')
    // The native question replaces InputBar, including its Stop button. Use
    // the same Agent cancellation as SessionController.cancel; the browser
    // still verifies that this outstanding native question is dismissed.
    const agent = host.ctx.agents.list().find((entry) => entry.id === sessions[0])
    if (agent === undefined) throw new Error('the native question has no owning Agent')
    await agent.cancel({ kind: 'user' }, { keepInbox: true })
    sessions.push(await stopped.settled)
    await card.waitFor({ state: 'hidden' })
    await expect.poll(() => events(log).filter((entry) => entry.method === 'session/cancel').length).toBe(1)
    await expect
      .poll(() => answer('QWEN_UI_STOP').map((entry) => entry.response))
      .toEqual([{ outcome: { outcome: 'cancelled' } }])

    phase = 'same-session continuation'
    const continuation = await send(host, page, 'QWEN_UI_CONTINUE')
    sessions.push(await continuation.settled)
    await page.getByText('QWEN_UI_CONTINUE model=qwen-toggle effort=none', { exact: true }).waitFor()
    expect(new Set(sessions).size).toBe(1)
    expect(
      events(log)
        .filter((entry) => entry.method === 'session/prompt')
        .map((entry) => entry.marker),
    ).toEqual([
      'QWEN_UI_SINGLE',
      'QWEN_UI_MULTI',
      'QWEN_UI_CUSTOM',
      'QWEN_UI_DISMISS',
      'QWEN_UI_STOP',
      'QWEN_UI_CONTINUE',
    ])
    expect(errors).toEqual([])
  } catch (error) {
    await evidence(page, log, phase, error)
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)

it('uses Qwen model-specific reasoning menus and sends the selected effort to the ACP session', async () => {
  const { host, log } = await launchQwenWorld()
  let browser: TestBrowser | undefined
  let page: Page | undefined
  let phase = 'launch'
  const errors: string[] = []
  try {
    browser = await launchBrowser({ headless: true })
    page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const picker = () => page!.getByRole('button', { name: /^Select model/ })
    const openEffort = async () => {
      await picker().click()
      await page!.getByRole('menuitem', { name: /^Effort/ }).click()
    }
    const selectModel = async (name: string) => {
      await picker().click()
      await page!.getByRole('menuitem', { name: /^Model/ }).click()
      await page!.getByRole('menuitemradio', { name, exact: true }).click()
      await expect.poll(() => picker().getAttribute('aria-expanded')).toBe('false')
      await page!.getByRole('button', { name: new RegExp(`^Select model, current ${name}`) }).waitFor()
    }
    const run = async (marker: string, model: string, effort: string | null) => {
      const turn = await send(host, page!, marker)
      const session = await turn.settled
      await expect
        .poll(() =>
          events(log)
            .filter((entry) => entry.method === 'session/prompt' && entry.marker === marker)
            .map((entry) => ({ model: entry.model, effort: entry.effort })),
        )
        .toEqual([{ model, effort }])
      return session
    }

    phase = 'toggle-only reasoning'
    await openEffort()
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['Off', 'On'])
    await capture(page, 'toggle-reasoning')
    await page.getByRole('menuitemradio', { name: 'On', exact: true }).click()
    await expect.poll(() => picker().getAttribute('aria-expanded')).toBe('false')
    const session = await run('QWEN_UI_TOGGLE_MODEL', 'qwen-toggle', 'high')

    phase = 'graded reasoning'
    await selectModel('Qwen Levels')
    await openEffort()
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['None', 'Low', 'Medium', 'Extra high'])
    await capture(page, 'graded-reasoning')
    await page.getByRole('menuitemradio', { name: 'Extra high', exact: true }).click()
    await expect.poll(() => picker().getAttribute('aria-expanded')).toBe('false')
    expect(await run('QWEN_UI_LEVELS_MODEL', 'qwen-levels', 'xhigh')).toBe(session)

    phase = 'model without reasoning'
    await selectModel('Qwen Basic')
    await picker().click()
    expect(await page.getByRole('menuitem', { name: /^Effort/ }).count()).toBe(0)
    await page.keyboard.press('Escape')
    expect(await run('QWEN_UI_BASIC_MODEL', 'qwen-basic', null)).toBe(session)

    phase = 'return to toggle-only reasoning'
    await selectModel('Qwen Toggle')
    await openEffort()
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['Off', 'On'])
    await page.getByRole('menuitemradio', { name: 'Off', exact: true }).click()
    await expect.poll(() => picker().getAttribute('aria-expanded')).toBe('false')
    expect(await run('QWEN_UI_TOGGLE_AGAIN', 'qwen-toggle', 'none')).toBe(session)
    expect(
      events(log)
        .filter((entry) => entry.method === 'session/set_config_option' && entry.configId === 'reasoning_effort')
        .map((entry) => entry.value),
    ).toEqual(expect.arrayContaining(['high', 'xhigh']))
    expect(errors).toEqual([])
  } catch (error) {
    await evidence(page, log, phase, error)
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
