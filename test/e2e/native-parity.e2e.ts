import type {} from '../support/message-source.ts'
import type { AcpAgentConfig } from '../../src/contract/agent-config.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { AcpRemoteService } from '../../src/remote/service.js'
import { required } from './required.ts'
import type { DownloadTestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { ObservedEvent } from './types.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { backToPluginList, openAcpPluginDetail, returnToConversation } from './plugin-panel.helpers.ts'
import { createAcpSidecar } from '../../src/persistence/sidecar.ts'

const profiles = ['claude', 'codex', 'devin', 'kimi']

class NativeControl extends LlmAdapter {
  constructor(private readonly nativeQuestionMode: () => boolean = () => false) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: 'Native control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'native-model', name: 'Native Model' }]
  }
  providerRetryPolicy(): ReturnType<LlmAdapter['providerRetryPolicy']> {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
  async *stream(options: Parameters<LlmAdapter['stream']>[0]): ReturnType<LlmAdapter['stream']> {
    const results = options.messages.filter((message) => message.source?.kind === 'tool')
    if (results.length === 0) {
      const toolName = this.nativeQuestionMode() ? 'ask_user_question' : 'e2e_fixture'
      expect((options.tools ?? []).some((tool) => tool.name === toolName)).toBe(true)
      const toolArguments = this.nativeQuestionMode()
        ? JSON.stringify({
            questions: [
              {
                id: 'scope',
                question: 'Allow the Agent to use the DSH tool "present"? Is this scope appropriate? '.repeat(8),
                header: 'Approval scope',
                options: [{ label: 'Allow once' }, { label: 'Always allow' }],
              },
            ],
          })
        : '{}'
      const block: ToolCallBlock = {
        type: 'tool-call',
        id: 'e2e-native-call' as ToolCallBlock['id'],
        name: toolName,
        arguments: toolArguments,
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (!this.nativeQuestionMode()) expect(JSON.stringify(results)).toMatch(/E2E_NATIVE_(?:POST|BODY)/)
    const text = this.nativeQuestionMode() ? 'E2E_NATIVE_QUESTION_DONE' : 'E2E_NATIVE_DONE'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.each(profiles)('native product parity: %s protocol fixture', (profile) => {
  let host!: AdapterWorld
  let browser!: DownloadTestBrowser
  let page!: Page
  let agentLog!: string
  let workspace!: string
  let ordinal = 0
  let errors: string[] = []
  let nativeQuestionMode = false
  const observed: string[] = []
  const events: ObservedEvent[] = []
  const provider = `acp-${profile}`

  beforeAll(async () => {
    host = await launchAdapterWorld()
    agentLog = join(host.workspaceCwd, 'fixture-agent.log')
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        [profile]: {
          name: `Fixture ${profile}`,
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_LOG: agentLog },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === provider)).toBe(true))
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['native-control'], new NativeControl(() => nativeQuestionMode)))
    host.ctx.effect(() =>
      host.ctx.tools.register({
        name: 'e2e_fixture',
        description: 'Return fixture text',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async () => 'E2E_NATIVE_BODY',
      }),
    )
    host.ctx.on('llm/stream', (request, next) => {
      observed.push(request.provider)
      return next()
    })
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
  })

  beforeEach(async () => {
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    errors = []
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    ordinal += 1
    workspace = join(host.workspaceCwd, 'workspace')
    if (ordinal === 1) await connectFreshWorkspace(page, host.workspaceCwd)
    else await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    rmSync(join(workspace, 'approval-marker.txt'), { force: true })
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state !== 'pass' || errors.length > 0) {
        const directory = join(root, '.local/e2e-failures')
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          join(directory, `${profile}-${ordinal}.json`),
          JSON.stringify(
            {
              body: await page.locator('body').innerText(),
              errors,
              observed,
              events,
              agent: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '',
            },
            null,
            2,
          ),
        )
        await page.screenshot({ path: join(directory, `${profile}-${ordinal}.png`), fullPage: true })
      }
      expect(errors).toEqual([])
    } finally {
      await host.ctx.settings.replace('locale', { preference: 'en' })
      await page?.close()
    }
  })
  afterAll(async () => {
    const pending = new Set(['browser', 'host'])
    const diagnostic = setTimeout(
      () => console.error(`E2E teardown pending: ${profile} ${[...pending].join(', ')}`),
      10_000,
    )
    try {
      // A slow browser shutdown must not postpone releasing Agent processes.
      // Both independent cleanup failures remain test failures.
      const results = await Promise.allSettled([
        Promise.resolve()
          .then(() => browser?.close())
          .finally(() => pending.delete('browser')),
        Promise.resolve()
          .then(() => host?.close())
          .finally(() => pending.delete('host')),
      ])
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'ACP browser regression cleanup failed')
    } finally {
      clearTimeout(diagnostic)
    }
  })

  async function expandProcess() {
    const control = page.locator('[data-turn-process-tool-calls]').last()
    await control.waitFor()
    if ((await control.getAttribute('aria-expanded')) === 'false') await control.click()
    for (const button of await page.locator('[data-step-process] > div > button').all()) {
      await button.waitFor({ state: 'visible' })
      if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
      await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true')
    }
  }

  async function send(prompt: string, { expectError = false } = {}) {
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, prompt)
    const button = page.getByRole('button', { name: /^(Send message|发送消息)$/ })
    await expect.poll(() => button.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(30_000).then((id) => {
      const end = events.filter((event) => event.type === 'turn/end').findLast((event) => event.sessionId === id)
      if (expectError) expect(end?.data.reason, 'native turn settlement').toMatchObject({ kind: 'error' })
      else expect(end?.data.reason, 'native turn settlement').not.toMatchObject({ kind: 'error' })
      return id
    })
    await button.click()
    return { settled }
  }

  async function decide(allow: boolean) {
    const panel = page.locator('[data-question-key], [data-approval-key]')
    await panel.waitFor({ timeout: 15_000 })
    expect(await panel.innerText()).toContain('echo E2E_APPROVED')
    if ((await panel.getAttribute('data-question-key')) !== null) {
      await panel
        .getByRole('radio', { name: allow ? 'Allow this operation' : 'Reject this operation', exact: true })
        .click()
      await panel.getByRole('button', { name: /Submit|Send/, exact: false }).click()
    } else {
      await panel.getByRole('button', { name: allow ? /^(Allow once|允许一次)$/ : /^(Reject|拒绝)$/ }).click()
    }
  }

  it('edits ACP configuration through the native bundle detail with validation, cancel and persisted save', async () => {
    let detail = await openAcpPluginDetail(page)
    await detail.getByRole('button', { name: 'Edit', exact: true }).click()
    const name = detail.getByLabel('Display name', { exact: true })
    expect(await name.inputValue()).toBe(`Fixture ${profile}`)
    await name.fill('Unsaved name')
    await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await detail.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await name.inputValue()).toBe(`Fixture ${profile}`)
    await name.fill('')
    expect(await detail.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await name.fill(`Updated ${profile}`)
    const evidence = join(root, '.local/e2e-settings')
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `${profile}.png`), fullPage: true })
    await detail.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Saved' }).waitFor()
    await backToPluginList(detail)
    await page.getByRole('alert').filter({ hasText: 'Saved' }).waitFor()
    await returnToConversation(page)
    await page.reload()
    detail = await openAcpPluginDetail(page)
    await detail.getByText(`Updated ${profile}`, { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Edit', exact: true }).click()
    await detail.getByLabel('Display name', { exact: true }).fill(`Fixture ${profile}`)
    await detail.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Saved' }).waitFor()
    await backToPluginList(detail)
    await returnToConversation(page)
  })

  it('keeps the audit ledger and wrapped details in the native trajectory viewport', async () => {
    page.setDefaultTimeout(10_000)
    const { settled } = await send('E2E_JOB_OTHER')
    const id = await settled
    // Seed a long, real audit journal without spending dozens of model turns.
    const sidecar = createAcpSidecar({ root: required(host.ctx.dshHomePath)('dsh-acp') })
    try {
      for (let index = 0; index < 80; index += 1) {
        await sidecar.append(id, {
          kind: 'degradation',
          data: {
            code: 'unsupported-tool-content',
            toolCallId: `audit-layout-${index}`,
            items: Array.from({ length: 18 }, (_, item) => ({
              type: `item-${item}`,
              reason: 'long-unbroken-value-'.repeat(item === 0 ? 40 : 5),
            })),
            keptPreviewChars: 0,
            truncated: false,
          },
        })
      }
      await sidecar.flush()
    } finally {
      await sidecar.dispose()
    }

    await page.getByText('Trajectory', { exact: true }).click()
    const nativeBounds = required(await page.locator('[data-conversation-composer-overlay]').boundingBox())
    await page.getByText('ACP Diagnostics', { exact: true }).click()
    const audit = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await audit.waitFor()
    const toolbar = audit.getByRole('toolbar')
    const toolbarTop = required(await toolbar.boundingBox()).y
    const scroll = audit.locator('[data-audit-scroll]')
    await audit.getByRole('button', { name: 'Load more', exact: true }).click()
    await audit.getByText('All records in this view are shown', { exact: true }).waitFor()
    const bounds = required(await audit.boundingBox())
    expect(Math.abs(bounds.y - nativeBounds.y)).toBeLessThan(2)
    expect(Math.abs(bounds.height - nativeBounds.height)).toBeLessThan(2)
    expect(await page.locator('[data-width-handle]:visible').count()).toBe(0)

    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await scroll.hover()
    await page.mouse.wheel(0, 1000)
    expect(Math.abs(required(await toolbar.boundingBox()).y - toolbarTop)).toBeLessThan(2)
    await audit.locator('tbody tr').last().click()
    const details = audit.getByRole('complementary')
    await details.waitFor()
    // Capture the clipboard boundary without overwriting the developer's clipboard.
    const copiedRecord = await page.evaluate(async () => {
      let text = ''
      const original = navigator.clipboard.writeText
      navigator.clipboard.writeText = async (value) => {
        text = value
      }
      try {
        const button = [...document.querySelectorAll('button')].find(
          (item) => item.textContent === 'Copy selected record',
        )
        if (!button) throw new Error('Diagnostic copy action missing')
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
        return JSON.parse(text) as {
          adapterVersion: string
          sessionId: string
          record: { seq: number; detail: string }
        }
      } finally {
        navigator.clipboard.writeText = original
      }
    })
    expect(copiedRecord.adapterVersion).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
    expect(copiedRecord.sessionId).toBe(id)
    expect(copiedRecord.record.detail).toContain('audit-layout-79')
    const close = details.getByRole('button', { name: 'Close', exact: true })
    expect(required(await close.boundingBox()).y).toBeGreaterThanOrEqual(toolbarTop)
    expect(required(await close.boundingBox()).y).toBeLessThan(toolbarTop + 80)
    const tree = details.getByRole('tree', { name: 'Diagnostic record JSON', exact: true })
    // Long collapsed previews and expanded nested strings both stay in bounds.
    const checkWidth = async () => {
      for (const locator of [audit, details, tree, tree.locator('xpath=..'), tree.locator('xpath=../..')]) {
        expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      }
    }
    await checkWidth()
    await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    await checkWidth()
    // Compact native object previews no longer make this payload overflow.
    // Open more real entries to exercise scrolling without exceeding the
    // diagnostic payload limit (which intentionally falls back to text).
    for (let index = 0; index < 8; index += 1) {
      await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    }
    await checkWidth()
    const firstWrapLines = tree.getByRole('button', { name: 'Wrap lines', exact: true }).first()
    await expect.poll(() => firstWrapLines.getAttribute('aria-pressed')).toBe('true')
    await firstWrapLines.click()
    await expect.poll(() => firstWrapLines.getAttribute('aria-pressed')).toBe('false')

    // A newly opened inspector samples the registration-scoped preference.
    await audit.locator('tbody tr').nth(78).click()
    const secondTree = details.getByRole('tree', { name: 'Diagnostic record JSON', exact: true })
    for (let index = 0; index < 10; index += 1) {
      await secondTree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    }
    const secondWrapLines = secondTree.getByRole('button', { name: 'Wrap lines', exact: true }).first()
    await expect.poll(() => secondWrapLines.getAttribute('aria-pressed')).toBe('false')
    await secondWrapLines.click()
    await expect.poll(() => secondWrapLines.getAttribute('aria-pressed')).toBe('true')

    const detailScroll = details.locator('[data-audit-detail-scroll]')
    await detailScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(await detailScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await audit.locator('tbody tr').nth(79).click()
    await expect.poll(() => detailScroll.evaluate((element) => element.scrollTop)).toBe(0)
    for (
      let index = 0;
      index < 10 && (await tree.getByRole('button', { name: 'Wrap lines', exact: true }).count()) === 0;
      index += 1
    ) {
      await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    }
    await host.ctx.settings.replace('locale', { preference: 'zh' })
    const chineseWrap = page.getByRole('button', { name: '自动换行', exact: true }).first()
    await expect.poll(() => chineseWrap.getAttribute('aria-pressed')).toBe('true')
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await close.click()
    await page.setViewportSize({ width: 680, height: 720 })
    await audit.locator('tbody tr').last().click()
    await details.waitFor()
    await checkWidth()
    expect(required(await close.boundingBox()).y).toBeLessThan(200)
    await close.click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.getByText('Chat', { exact: true }).click()
    await expect.poll(() => page.locator('[data-width-handle]:visible').count()).toBe(2)
  })

  it('defaults diagnostics to recorded issues and keeps operations, technical facts and recovery state distinct', async () => {
    page.setDefaultTimeout(10_000)
    const { settled } = await send('E2E_JOB_OTHER')
    const id = await settled
    await page.getByText('ACP Diagnostics', { exact: true }).click()
    const panel = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await panel.getByText('No recorded ACP issues.', { exact: true }).waitFor()
    expect(await panel.locator('tbody tr').count()).toBe(0)
    const sidecar = createAcpSidecar({ root: required(host.ctx.dshHomePath)('dsh-acp') })
    try {
      for (let index = 0; index < 150; index += 1) {
        await sidecar.append(id, {
          kind: 'replay-assessment',
          data: { status: 'not-compared', detail: '0 staged updates' },
        })
      }
      await sidecar.append(id, {
        kind: 'filesystem',
        data: {
          operation: 'read',
          path: '/missing-diagnostic-fixture',
          bytes: 0,
          beforeHash: null,
          afterHash: null,
          outcome: 'error',
          reason: 'not-found',
          acpSessionId: 'fixture',
          profileId: profile,
        },
      })
      for (const option of ['allow_once', 'reject_once'] as const) {
        await sidecar.append(id, {
          kind: 'permission',
          data: {
            phase: 'decided',
            requestId: option,
            agentSessionId: 'fixture',
            toolCallId: option,
            outcome: 'selected',
            optionId: option,
            selectedOptionKind: option,
          },
        })
      }
      await sidecar.flush()
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect.poll(() => panel.locator('tbody tr').count()).toBe(1)
      await panel.locator('tbody tr').click()
      const details = panel.getByRole('complementary')
      await details.getByText('not-found', { exact: true }).waitFor()
      await panel.getByRole('searchbox', { name: 'Search loaded records', exact: true }).fill('not-found')
      expect(await panel.locator('tbody tr').count()).toBe(1)
      await panel.getByRole('button', { name: 'Operations', exact: true }).click()
      await expect.poll(() => panel.locator('tbody tr').count()).toBe(3)
      expect(await panel.innerText()).toContain('Allowed this operation')
      expect(await panel.innerText()).toContain('Rejected this operation')
      await panel.getByRole('button', { name: 'Technical records', exact: true }).click()
      await expect.poll(() => panel.locator('tbody tr').count()).toBe(50)
      expect(await panel.innerText()).toContain('Session continuity record')
      expect(await panel.innerText()).not.toContain('History replay was not compared')
      await panel.getByRole('button', { name: 'Load more', exact: true }).click()
      await expect.poll(() => panel.locator('tbody tr').count()).toBe(100)
      await panel.getByRole('button', { name: 'Issues', exact: true }).click()
      await expect.poll(() => panel.locator('tbody tr').count()).toBe(1)
      await sidecar.writeRecoveryState({
        dshSessionId: id,
        kind: 'reconnect-required',
        cause: 'auth-required',
        detail: 'E2E_RECORDED_RECOVERY_CAUSE',
        provider,
        updatedAt: Date.now(),
      })
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
      await panel.getByText('Recovery status at last refresh', { exact: true }).waitFor()
      await panel.getByRole('status').locator('summary').click()
      await panel.getByText('E2E_RECORDED_RECOVERY_CAUSE', { exact: true }).waitFor()
      expect(await panel.locator('tbody tr').count()).toBe(1)
      await sidecar.writeRecoveryState({ dshSessionId: id, kind: 'healthy', provider, updatedAt: Date.now() })
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
      await panel.getByText('Recovery status at last refresh', { exact: true }).waitFor({ state: 'hidden' })
      expect(await panel.locator('tbody tr').count()).toBe(1)
      // Change the real host language, including the plugin's settings label.
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'General', exact: true }).click()
      await settings.getByRole('button', { name: 'English', exact: true }).click()
      await page.getByRole('menuitem', { name: '中文', exact: true }).click()
      await page
        .getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      const detail = await openAcpPluginDetail(page, 'zh')
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      await detail.getByText(`v${version}`, { exact: true }).waitFor()
      await backToPluginList(detail, 'zh')
      await returnToConversation(page)
      const chinesePanel = page.getByRole('region', { name: 'ACP 诊断', exact: true })
      await chinesePanel.getByRole('button', { name: '异常', exact: true }).waitFor()
      await chinesePanel.getByText('已显示当前分类全部记录', { exact: true }).waitFor()
      expect(await chinesePanel.locator('tbody').innerText()).toContain('读取文件')
      await chinesePanel.getByRole('button', { name: '操作记录', exact: true }).click()
      await chinesePanel.getByText('权限决定已记录 · allow_once · 已允许本次操作', { exact: true }).waitFor()
      expect(await chinesePanel.innerText()).toContain('已拒绝本次操作')
      await sidecar.append(id, {
        kind: 'terminal',
        data: {
          operation: 'exit',
          terminalId: 'legacy-term',
          dshSessionId: id,
          profileId: profile,
          acpSessionId: 'fixture',
          command: 'legacy command',
          argCount: 0,
          cwd: '/',
          outputBytes: 0,
          truncated: false,
          outcome: 'exited',
          exitCode: null,
          signal: 'SIGTERM',
        },
      })
      await sidecar.flush()
      await chinesePanel.getByRole('button', { name: '异常', exact: true }).click()
      await expect.poll(() => chinesePanel.locator('tbody tr').count()).toBe(2)
      await chinesePanel.locator('tbody tr').filter({ hasText: '退出原因待确认' }).click()
      await chinesePanel
        .getByText('此旧记录包含非零退出码或退出信号，但未记录是否主动终止；不能据此确定是操作取消还是进程故障。', {
          exact: true,
        })
        .waitFor()
    } finally {
      await sidecar.dispose()
      await host.ctx.settings.replace('locale', { preference: 'en' })
    }
  })

  it('downloads a bounded content-free ACP support snapshot from one explicit export action', async () => {
    page.setDefaultTimeout(10_000)
    const { settled } = await send('E2E_JOB_OTHER')
    const id = await settled
    const sidecar = createAcpSidecar({ root: required(host.ctx.dshHomePath)('dsh-acp') })
    try {
      for (let index = 0; index < 120; index += 1) {
        await sidecar.append(id, {
          kind: 'filesystem',
          data: {
            operation: 'read',
            path: `/private/ACP_EXPORT_SENTINEL_${String(index)}`,
            bytes: 0,
            beforeHash: null,
            afterHash: null,
            outcome: 'error',
            reason: 'not-found',
            acpSessionId: 'private-acp-session',
            profileId: profile,
          },
        })
      }
      await sidecar.flush()
    } finally {
      await sidecar.dispose()
    }

    const remote = host.ctx.get('dshAcp') as AcpRemoteService
    const readAuditTimeline = remote.auditTimeline.bind(remote)
    const readActivityPage = remote.activityPage.bind(remote)
    let auditSnapshotAttempts = 0
    let activitySnapshotAttempts = 0
    vi.spyOn(remote, 'auditTimeline').mockImplementation(async (sessionId, request) => {
      if (request?.captureSnapshot === true) {
        auditSnapshotAttempts += 1
        if (auditSnapshotAttempts === 1) throw new Error('E2E_TEMPORARY_AUDIT_PAGE_FAILURE')
      }
      return readAuditTimeline(sessionId, request)
    })
    vi.spyOn(remote, 'activityPage').mockImplementation(async (sessionId, request, signal) => {
      if (request?.captureSnapshot === true) {
        activitySnapshotAttempts += 1
        if (activitySnapshotAttempts === 1) throw new Error('E2E_TEMPORARY_ACTIVITY_PAGE_FAILURE')
      }
      return readActivityPage(sessionId, request, signal)
    })

    await page.getByText('ACP Diagnostics', { exact: true }).click()
    const panel = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    const download = await browser.downloadFromClick(page, () =>
      panel.getByRole('button', { name: 'Export safe summary', exact: true }).click(),
    )
    expect(auditSnapshotAttempts).toBe(2)
    expect(activitySnapshotAttempts).toBe(2)
    const summary = panel.locator('[data-support-export-summary]')
    await summary.waitFor()
    expect(await summary.innerText()).toContain('The JSON download has started.')
    expect(await summary.innerText()).toContain('Audit records:')
    expect(await summary.innerText()).toContain('activity revisions:')
    expect(await summary.innerText()).toContain('Detailed scope and snapshot limits are included')
    if (process.env.DSH_E2E_SCREENSHOTS) {
      mkdirSync(process.env.DSH_E2E_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.DSH_E2E_SCREENSHOTS, `${profile}-acp-support-export.png`) })
    }
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    const bundle = JSON.parse(readFileSync(required(downloadPath), 'utf8')) as {
      schema: string
      schemaVersion: number
      sessionAlias: string
      audit: { rows: { summaryCode: string }[]; truncated: boolean }
      unavailable: { providerPromptTrace: boolean; providerUsage: boolean; nativeSessionLog: boolean }
    }
    expect(bundle).toMatchObject({ schema: 'dsh-acp-support', schemaVersion: 1, sessionAlias: 'session-1' })
    expect(bundle.audit.rows.filter((row) => row.summaryCode === 'filesystem.read').length).toBeGreaterThanOrEqual(120)
    expect(bundle.audit.truncated).toBe(false)
    expect(bundle.unavailable).toMatchObject({ providerPromptTrace: true, providerUsage: true, nativeSessionLog: true })
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(id)
    expect(serialized).not.toContain('ACP_EXPORT_SENTINEL')
    expect(serialized).not.toContain('private-acp-session')
  })

  it('uses the native composer, attachment history, assistant stream and tool presentation across reload', async () => {
    await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: 'File', exact: true }).click()
    await (
      await fileChooser
    ).setFiles({ name: 'parity.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E_UPLOAD_BYTES') })
    const { settled } = await send('E2E_MESSAGE')
    const id = await settled
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(observed).toContain(provider)
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    let log!: readonly SessionEvent[]
    try {
      log = (await handle.read()).events
    } finally {
      await handle.close()
    }
    const assistant = required(log.find((event) => event.type === 'assistant/message'))
    expect(assistant.data.stream.length).toBeGreaterThan(0)
    expect(log.filter((event) => event.type === 'tool/call')).toHaveLength(0)
    expect(JSON.stringify(log.find((event) => event.type === 'user/message'))).toContain('parity.txt')
    expect(readFileSync(agentLog, 'utf8')).toContain('parity.txt')
    expect(readFileSync(agentLog, 'utf8')).toContain('regression file-bytes=E2E_UPLOAD_BYTES')
    await page.reload()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByText('parity.txt', { exact: true }).first().waitFor()
    await expandProcess()
    const activity = page.locator('[data-chat-call-id^="acp:"]')
    await activity.first().waitFor()
    await activity.getByText('echo E2E_TOOL_OUTPUT', { exact: true }).first().click()
    await activity.locator('[data-terminal]').getByText('E2E_TOOL_OUTPUT', { exact: true }).first().waitFor()
    expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(1)
  })

  it('keeps the streamed answer tail visible through native viewport resizing', async () => {
    const { settled } = await send('E2E_SCROLL')
    await settled
    const tail = page.getByText('E2E_SCROLL_END', { exact: true })
    await tail.waitFor()
    const tailVisible = () =>
      tail.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
        if (!scroll) return false
        const bounds = element.getBoundingClientRect()
        const viewport = scroll.getBoundingClientRect()
        return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
      })
    await expect.poll(tailVisible).toBe(true)
    await page.setViewportSize({ width: 900, height: 500 })
    await expect.poll(tailVisible).toBe(true)
  })

  it('delivers host instructions, runtime context and plugin-only next steps through the native loop', async () => {
    let version = 'A'
    let followupSent = false
    const contribution = host.ctx.plugin({
      name: 'e2e-host-contributions',
      inject: ['systemPrompt'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.systemPrompt.section({ name: 'e2e-instructions', order: 0, text: () => `E2E_SYSTEM_${version}` }),
        )
        ctx.effect(() =>
          ctx.systemPrompt.context({ name: 'e2e-runtime', order: 0, text: () => `E2E_RUNTIME_${version}` }),
        )
        ctx.on('agent/pre-step', async ({ messages }, next) => {
          const decision = await next()
          if (decision.kind !== 'enter' || !JSON.stringify(messages).includes('E2E_CONTEXT_')) return decision
          return {
            ...decision,
            messages: [
              ...decision.messages,
              createUserMessage({
                source: { kind: 'test-plugin', plugin: 'e2e-host-contributions' },
                content: [{ type: 'text', text: 'E2E_PLUGIN_INPUT' }],
              }),
            ],
          }
        })
        ctx.on('agent/turn-stopping', ({ agent }) => {
          if (followupSent || !JSON.stringify(agent.session.snapshotEvents()).includes('E2E_CONTEXT_A')) return
          followupSent = true
          agent.send(
            createUserMessage({
              source: { kind: 'test-plugin', plugin: 'e2e-host-contributions' },
              content: [{ type: 'text', text: 'E2E_PLUGIN_FOLLOWUP' }],
            }),
            'next-step',
            false,
          )
        })
      },
    })
    await contribution.await()
    try {
      const first = await send('E2E_CONTEXT_A')
      const id = await first.settled
      // Native Chat collapses intermediate assistant messages in a multi-step
      // turn. Its durable first answer remains in the mounted transcript.
      await page.getByText('E2E_CONTEXT_A_DONE', { exact: true }).waitFor({ state: 'attached' })
      await page.getByText('E2E_FOLLOWUP_DONE', { exact: true }).waitFor()
      expect(
        events.filter((event) => event.type === 'step/start').filter((event) => event.sessionId === id),
      ).toHaveLength(2)
      version = 'B'
      const second = await send('E2E_CONTEXT_B')
      await second.settled
      await page.getByText('E2E_CONTEXT_B_DONE', { exact: true }).waitFor()
      const handle = await host.ctx.sessionPersistence.open(id, 'read')
      try {
        const log = (await handle.read()).events
        expect(JSON.stringify(log.filter((event) => event.type === 'system/message'))).toContain('E2E_SYSTEM_B')
        expect(JSON.stringify(log.filter((event) => event.type === 'user/message'))).toContain('E2E_RUNTIME_B')
      } finally {
        await handle.close()
      }
      await page.reload()
      await page.getByText('E2E_FOLLOWUP_DONE', { exact: true }).waitFor()
    } finally {
      await contribution.dispose()
    }
    const final = await send('E2E_MESSAGE')
    await final.settled
    const lastPrompt = readFileSync(agentLog, 'utf8').split('regression prompt=').at(-1)
    expect(lastPrompt).not.toContain('E2E_SYSTEM_B')
    expect(lastPrompt).not.toContain('E2E_CONTEXT_B')
  })

  it('renders assistant images, file reads and edits using native components after reload', async () => {
    writeFileSync(join(workspace, 'fixture.txt'), 'E2E_SIDEBAR_FILE\n')
    const { settled } = await send('E2E_RICH')
    const id = await settled
    await page.getByText('E2E_RICH_DONE', { exact: true }).waitFor()
    await page.reload()
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    try {
      const log = (await handle.read()).events
      expect(
        required(log.find((event) => event.type === 'assistant/message')).data.message.content.some(
          (block) => block.type === 'image',
        ),
      ).toBe(true)
      expect(log.some((event) => event.type === 'tool/call')).toBe(false)
    } finally {
      await handle.close()
    }
    await expandProcess()
    const picture = page.locator('[data-variant] img')
    await picture.first().waitFor()
    await expect
      .poll(() =>
        picture.first().evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    await expandProcess()
    const activity = page.locator('[data-chat-call-id^="acp:"]')
    await expect.poll(() => activity.count()).toBeGreaterThan(0)
    await activity.getByRole('button', { name: /^Read.*fixture\.txt/ }).click()
    await activity.locator('[data-read]').getByText('E2E_READ_LINE', { exact: true }).first().waitFor()
    await activity.getByRole('button', { name: /^Edit.*fixture\.txt/ }).click()
    await activity.locator('[data-diff]').getByText('E2E_NEW_LINE', { exact: true }).first().waitFor()
    for (const [locale, theme, label] of [
      ['en', 'light', 'Wrap lines'],
      ['zh', 'dark', '自动换行'],
    ]) {
      await host.ctx.settings.replace('locale', { preference: locale })
      await host.ctx.settings.replace('ui-theme', { preference: theme })
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
      for (const selector of ['[data-read]', '[data-diff]']) {
        const card = activity.locator(selector)
        const wrap = card.getByRole('button', { name: label, exact: true }).first()
        const previous = await wrap.getAttribute('aria-pressed')
        await wrap.click()
        await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe(previous === 'true' ? 'false' : 'true')
        await wrap.click()
        await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe(previous)
      }
    }
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await host.ctx.settings.replace('ui-theme', { preference: 'light' })
    await activity.locator('[data-tool=read]').getByRole('button', { name: 'fixture.txt', exact: true }).press('Enter')
    const preview = page.locator('[data-rightbar-col] [data-textpreview-state="text"]')
    await preview.waitFor()
    await expect.poll(() => preview.locator('[data-textpreview-line="1"]').textContent()).toBe('E2E_SIDEBAR_FILE\n')
  })

  it('automatically discovers a newly installed DSH tool in an existing session with native hooks and Agent approval', async () => {
    const first = await send('E2E_MESSAGE')
    await first.settled
    const disposeTool = host.ctx.tools.register({
      name: 'e2e_late_fixture',
      description: 'Newly installed tool',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => 'E2E_NATIVE_BODY',
    })
    const calls: string[] = []
    const disposePre = host.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'e2e_late_fixture') calls.push('pre')
      return await next()
    })
    const disposePost = host.ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'e2e_late_fixture') return decision
      calls.push('post')
      expect(JSON.stringify(result)).toContain('E2E_NATIVE_BODY')
      return { kind: 'accept', content: [{ type: 'text', text: 'E2E_HOST_POST' }] }
    })
    try {
      const { settled } = await send('E2E_HOST_TOOLS_LATE')
      const panel = page.locator('[data-question-key], [data-approval-key]')
      await panel.waitFor()
      expect(calls).toEqual([])
      if ((await panel.getAttribute('data-question-key')) !== null) {
        if (profile === 'codex') {
          const text = await panel.innerText()
          expect(text).toContain('DSH tool "e2e_late_fixture"')
          expect(text).not.toMatch(/dshteam_|persist/)
        }
        await panel
          .getByRole('radio', {
            name: profile === 'codex' ? 'Allow for this session' : 'Allow this operation',
            exact: true,
          })
          .click()
        await panel.getByRole('button', { name: /Submit|Send/ }).click()
      } else await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
      await settled
      await page.getByText('E2E_HOST_TOOLS_DONE', { exact: true }).waitFor()
      expect(calls).toEqual(['pre', 'post'])
    } finally {
      disposePre()
      disposePost()
      disposeTool()
    }
  })

  it('presents ACP outputs through the native delivery card and preview, including after reload', async () => {
    writeFileSync(join(workspace, 'delivery.txt'), 'NATIVE_ACP_DELIVERY_CONTENT\n')
    const { settled } = await send('E2E_PRESENT')
    const approval = page.locator('[data-question-key], [data-approval-key]')
    await approval.waitFor()
    if ((await approval.getAttribute('data-question-key')) !== null) {
      if (profile === 'codex') {
        const text = await approval.innerText()
        expect(text).toContain('DSH tool "present"')
        mkdirSync(join(root, '.local/ui-review'), { recursive: true })
        const originalViewport = page.viewportSize()
        for (const theme of ['light', 'dark']) {
          await host.ctx.settings.replace('ui-theme', { preference: theme })
          await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
          for (const width of [1680, 680]) {
            await page.setViewportSize({ width, height: 1000 })
            const card = approval.locator('section')
            expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
            expect(await approval.getByRole('radio').count()).toBeGreaterThan(0)
            expect(await approval.getByRole('button', { name: /Submit|Send/ }).isVisible()).toBe(true)
            await approval.screenshot({
              path: join(root, `.local/ui-review/codex-approval-${theme}-${width}.png`),
              animations: 'disabled',
            })
          }
        }
        await page.setViewportSize(required(originalViewport))
        await host.ctx.settings.replace('ui-theme', { preference: 'light' })
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
        await approval.screenshot({ path: join(root, '.local/ui-review/codex-approval.png') })
        expect(text).not.toMatch(/dshteam_|persist/)
      }
      await approval
        .getByRole('radio', {
          name: profile === 'codex' ? "Always allow, don't ask again" : 'Allow this operation',
          exact: true,
        })
        .click()
      await approval.getByRole('button', { name: /Submit|Send/ }).click()
    } else await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
    const id = await settled
    expect(
      events.filter((event) => event.type === 'deliverables/presented').filter((event) => event.sessionId === id),
    ).toHaveLength(1)
    for (let round = 0; round < 2; round++) {
      if (round) await page.reload()
      const card = page.locator('[data-presented-file]').filter({ hasText: 'delivery.txt' })
      await card.waitFor()
      await card.getByRole('button').first().click()
      await page.locator('[data-rightbar-col]').getByText('NATIVE_ACP_DELIVERY_CONTENT', { exact: false }).waitFor()
    }
  })

  it.skipIf(profile !== 'devin')(
    'keeps the native question layout unchanged when the ACP plugin is toggled',
    async () => {
      const manager = host.ctx.pluginManager
      const adapterEntry = required(
        (await manager.listPlugins()).find((entry) => entry.moduleName === '@zaimokuza/dsh-acp-adapter'),
      )
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'native-control', model: 'native-model' })
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.waitFor({ state: 'visible' })
      nativeQuestionMode = true
      try {
        const settled = host.whenTurnSettled(60_000)
        await writeComposerDraft(page, input, 'E2E_NATIVE_QUESTION_LAYOUT')
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        const question = page.locator('[data-question-key]')
        await question.waitFor({ state: 'visible', timeout: 15_000 })
        const readGeometry = async () =>
          await question.locator('section').evaluate((card) => {
            const heading = card.querySelector('h1, h2, h3, h4')
            const body = card.querySelector('[data-question-scroll]')
            if (!(card instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(body instanceof HTMLElement)) {
              throw new Error('Native question card is missing its heading or body')
            }
            const rect = (element: HTMLElement) => {
              const box = element.getBoundingClientRect()
              return { x: box.x, y: box.y, width: box.width, height: box.height }
            }
            return { card: rect(card), heading: rect(heading), body: rect(body) }
          })
        const enabledGeometry = await readGeometry()
        expect(await question.locator('section').evaluate((card) => card.scrollWidth <= card.clientWidth)).toBe(true)
        expect(await question.getByRole('radio').count()).toBe(2)
        expect(await question.getByRole('button', { name: /Submit|Send/ }).isVisible()).toBe(true)

        mkdirSync(join(root, '.local/ui-review'), { recursive: true })
        await question.screenshot({ path: join(root, '.local/ui-review/native-question-acp-enabled.png') })
        expect(await manager.setPluginEnabled(adapterEntry.entryId, false)).toMatchObject({ application: 'applied' })
        await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === provider)).toBe(false))
        await expect.poll(() => question.isVisible()).toBe(true)
        expect(await readGeometry()).toEqual(enabledGeometry)
        await question.screenshot({ path: join(root, '.local/ui-review/native-question-acp-disabled.png') })

        expect(await manager.setPluginEnabled(adapterEntry.entryId, true)).toMatchObject({ application: 'applied' })
        await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === provider)).toBe(true))
        await question.getByRole('radio', { name: 'Allow once', exact: true }).click()
        await question.getByRole('button', { name: /Submit|Send/ }).click()
        const sessionId = await settled
        const conversation = page.locator('[data-conversation-session]').last()
        expect(sessionId).toBe(await conversation.getAttribute('data-conversation-session'))
        expect(sessionId).not.toBeNull()
        expect(observed).toContain('native-control')
        const nativeHeader = events.findLast(
          (event) => event.sessionId === sessionId && event.type === 'request/header',
        )
        expect(nativeHeader?.type).toBe('request/header')
        if (nativeHeader?.type === 'request/header')
          expect(nativeHeader.data.header.config.provider).toBe('native-control')
        await conversation.getByText('E2E_NATIVE_QUESTION_DONE', { exact: true }).waitFor()
      } finally {
        nativeQuestionMode = false
        if (!host.ctx.llm.listProviders().some((item) => item.id === provider)) {
          await manager.setPluginEnabled(adapterEntry.entryId, true)
        }
      }
    },
  )

  it.skipIf(profile !== 'devin')(
    'shows the full Bash command for a Devin MCP label and still requires approval',
    async () => {
      const { settled } = await send('E2E_HOST_BASH')
      const approval = page.locator('[data-approval-key]')
      await approval.waitFor()
      const text = await approval.innerText()
      expect(text).toContain('printf E2E_DSH_BASH_OK')
      expect(text).toContain('bash')
      expect(text).not.toMatch(/Calling |[a-f0-9]{16}_bash|"description"/)
      expect(events.filter((event) => event.type === 'approval/asked').at(-1)?.data.toolName).toBe('bash')
      await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      await settled
      await page.getByText('E2E_HOST_TOOLS_DONE', { exact: true }).waitFor()
    },
  )

  it('preserves full native diffs and an unfinished native plan after reload', async () => {
    const details = vi.spyOn(host.ctx.get('dshAcp') as AcpRemoteService, 'activityDetail')
    details.mockRejectedValueOnce(new Error('test: detail temporarily unavailable'))
    try {
      const { settled } = await send('E2E_NATIVE_PLAN_DIFF')
      const id = await settled
      expect(details).not.toHaveBeenCalled()
      const summary = await (host.ctx.get('dshAcp') as AcpRemoteService).activitySnapshot(id)
      expect(summary.activities.some((row) => row.detailDeferred && row.display === undefined)).toBe(true)
      for (let round = 0; round < 2; round++) {
        if (round) await page.reload()
        await page.getByText('E2E_NATIVE_PLAN_DIFF_DONE', { exact: true }).waitFor()
        const dock = page.getByTestId('todo-panel')
        await dock.getByRole('button').click()
        await dock.getByText('E2E_PLAN_REMAINS', { exact: true }).waitFor()
        await expandProcess()
        const activity = page.locator('[data-chat-call-id^="acp:"]')
        await activity.getByRole('button', { name: /^Edit.*full\.txt/ }).click()
        if (round === 0) {
          await activity
            .getByText('Could not load details. Your conversation is unaffected.', { exact: true })
            .waitFor()
          // The sidecar loader owns retry alongside the native tool component.
          await activity.locator('..').getByRole('button', { name: 'Retry', exact: true }).click()
        }
        await activity.locator('[data-diff]').getByText('E2E_NEW_TAIL', { exact: true }).first().waitFor()
        if (process.env.DSH_E2E_SCREENSHOTS && round === 1) {
          mkdirSync(process.env.DSH_E2E_SCREENSHOTS, { recursive: true })
          await page.screenshot({ path: join(process.env.DSH_E2E_SCREENSHOTS, `${profile}-native-plan-diff.png`) })
        }
        const current = required(host.ctx.agents.get(id))
        expect(host.ctx.sessionProjections.stateOf(current.session, 'todos')).toEqual([
          { content: 'E2E_PLAN_REMAINS', status: 'in_progress' },
        ])
      }
      const handle = await host.ctx.sessionPersistence.open(id, 'read')
      try {
        const log = (await handle.read()).events
        expect(required(log.filter((event) => event.type === 'todo/write').at(-1)).data.todos[0].status).toBe(
          'in_progress',
        )
        expect(log.some((event) => event.type === 'tool/call')).toBe(false)
      } finally {
        await handle.close()
      }
      expect(details).toHaveBeenCalledTimes(3)
    } finally {
      details.mockRestore()
    }
  })

  it('preserves visible history after a crash and requires explicit recovery before continuing', async () => {
    const first = await send('E2E_MESSAGE')
    await first.settled
    const failed = await send('E2E_CRASH', { expectError: true })
    await failed.settled
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    await page.reload()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    const dock = page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).locator('..').locator('..')
    const dockBounds = required(await dock.boundingBox())
    const composerBounds = required(await page.locator('[data-composer-card]').boundingBox())
    const inputBounds = required(await page.locator('[data-composer-input]').first().boundingBox())
    const centerDelta = Math.abs(dockBounds.x + dockBounds.width / 2 - (composerBounds.x + composerBounds.width / 2))
    expect(centerDelta).toBeLessThan(1)
    expect(dockBounds.width).toBeLessThan(composerBounds.width)
    const recoveryLayoutEvidence: Record<string, unknown> = {
      viewport: page.viewportSize(),
      wideDock: dockBounds,
      wideComposerCard: composerBounds,
      wideComposerInput: inputBounds,
      centerDelta,
      referenceDom: await page.locator('[data-composer-card]').evaluate((card) => ({
        cardTag: card.tagName,
        cardClass: card.getAttribute('class'),
        cardMarker: card.getAttribute('data-composer-card'),
        inputTag: card.querySelector('[data-composer-input]')?.tagName ?? null,
        inputClass: card.querySelector('[data-composer-input]')?.getAttribute('class') ?? null,
      })),
      wideSurface: await dock.evaluate((element) => {
        const surface = element.firstElementChild
        if (surface === null) return null
        const style = getComputedStyle(surface)
        return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, boxShadow: style.boxShadow }
      }),
    }
    const evidenceDirectory = process.env.DSH_E2E_EVIDENCE_DIR
    if (evidenceDirectory !== undefined) {
      mkdirSync(evidenceDirectory, { recursive: true })
      await page.screenshot({ path: join(evidenceDirectory, `recovery-wide-${profile}.png`), fullPage: true })
    }
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const recoveryFollow = service.recoveryFollow.bind(service)
    let recoveryFollowReads = 0
    let releaseInitialFault!: () => void
    let releaseRecoveryReconnect!: () => void
    let markReconnectStarted!: () => void
    let faultInjected = false
    const initialFaultGate = new Promise<void>((resolve) => {
      releaseInitialFault = resolve
    })
    const recoveryReconnectGate = new Promise<void>((resolve) => {
      releaseRecoveryReconnect = resolve
    })
    const reconnectStarted = new Promise<void>((resolve) => {
      markReconnectStarted = resolve
    })
    const recoveryFollowFacts: {
      attempt: number
      signalAbortedAtStart: boolean
      signalAbortEvents: number
      baselineYielded?: boolean
      injectedFault?: boolean
      waitingForReconnectRelease?: boolean
      signalAbortedAtEnd?: boolean
    }[] = []
    const waitForGateOrAbort = async (gate: Promise<void>, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return
      let onAbort!: () => void
      const aborted = new Promise<void>((resolve) => {
        onAbort = resolve
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        await Promise.race([gate, aborted])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const recoveryFollowSpy = vi
      .spyOn(service, 'recoveryFollow')
      .mockImplementation(async function* (sessionId, signal) {
        recoveryFollowReads++
        const fact: (typeof recoveryFollowFacts)[number] = {
          attempt: recoveryFollowReads,
          signalAbortedAtStart: signal.aborted,
          signalAbortEvents: 0,
        }
        recoveryFollowFacts.push(fact)
        const recordAbort = (): void => {
          fact.signalAbortEvents++
        }
        signal.addEventListener('abort', recordAbort, { once: true })
        const source = recoveryFollow(sessionId, signal)
        const iterator = source[Symbol.asyncIterator]()
        try {
          if (faultInjected) {
            fact.waitingForReconnectRelease = true
            markReconnectStarted()
            await waitForGateOrAbort(recoveryReconnectGate, signal)
            if (signal.aborted) return
            yield* source
            return
          }

          const initial = await iterator.next()
          if (initial.done || signal.aborted) return
          fact.baselineYielded = true
          yield initial.value
          await waitForGateOrAbort(initialFaultGate, signal)
          if (signal.aborted) return
          if (!faultInjected) {
            faultInjected = true
            fact.injectedFault = true
            await iterator.return?.()
            throw new Error('E2E_TEMPORARY_RECOVERY_READ_FAILURE')
          }
          yield* source
        } finally {
          fact.signalAbortedAtEnd = signal.aborted
          signal.removeEventListener('abort', recordAbort)
          if (!signal.aborted) await iterator.return?.()
        }
      })
    try {
      await page.reload()
      await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
      releaseInitialFault()
      await page.getByText('Reconnecting to recovery status…', { exact: true }).waitFor()
      await reconnectStarted
      const reconnectingStatus = page.getByRole('status').filter({ hasText: 'Reconnecting to recovery status…' })
      expect(await reconnectingStatus.getByRole('button').count()).toBe(0)
      releaseRecoveryReconnect()
      await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    } catch (error) {
      const evidenceDirectory = process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/e2e-failures')
      try {
        mkdirSync(evidenceDirectory, { recursive: true })
        await page.screenshot({
          path: join(evidenceDirectory, `recovery-reconnect-failure-${profile}.png`),
          fullPage: true,
        })
        writeFileSync(
          join(evidenceDirectory, `recovery-reconnect-failure-${profile}.json`),
          JSON.stringify(
            {
              profile,
              error: error instanceof Error ? error.message : String(error),
              recoveryFollowReads,
              recoveryFollowFacts,
              reconnectingStatusCount: await page
                .getByRole('status')
                .filter({ hasText: 'Reconnecting to recovery status…' })
                .count(),
              resolveButtonCount: await page
                .getByRole('button', { name: 'Resolve recovery issue', exact: true })
                .count(),
              statusText: await page.getByRole('status').allInnerTexts(),
            },
            null,
            2,
          ),
        )
        writeFileSync(
          join(evidenceDirectory, `recovery-reconnect-failure-${profile}.dom.html`),
          await page.locator('body').evaluate((body) => body.innerHTML),
        )
      } catch {
        // Preserve the original assertion failure if evidence capture also fails.
      }
      throw error
    } finally {
      releaseInitialFault()
      releaseRecoveryReconnect()
      recoveryFollowSpy.mockRestore()
    }
    await page.setViewportSize({ width: 740, height: 500 })
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).click()
    let unblockReconnect!: () => void
    const reconnectGate = new Promise<void>((resolve) => {
      unblockReconnect = resolve
    })
    let heldRebindMessage = ''
    const heldRebind = vi.spyOn(service, 'rebindRecoveryBlank').mockImplementation(async (sessionId) => {
      await reconnectGate
      heldRebindMessage = `Held rebind for ${sessionId}\n${'recovery evidence '.repeat(160)}`
      throw new Error(heldRebindMessage)
    })
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    const normalMotion = await dialog.evaluate((element) => {
      const style = getComputedStyle(element)
      return { animationName: style.animationName, animationDuration: style.animationDuration }
    })
    expect(normalMotion.animationName).not.toBe('none')
    expect(normalMotion.animationDuration).not.toBe('0s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedMotion = await dialog.evaluate((element) => {
      const style = getComputedStyle(element)
      return { animationName: style.animationName, animationDuration: style.animationDuration }
    })
    expect(reducedMotion.animationName).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    recoveryLayoutEvidence.modalMotion = { normal: normalMotion, reduced: reducedMotion }
    let switchedToChinese = false
    try {
      const rebind = dialog.getByRole('button', { name: 'Abandon context and continue', exact: true })
      await rebind.click()
      await expect.poll(() => dialog.getByRole('button', { name: 'Working…', exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('button', { name: 'Reconnect original session', exact: true }).isDisabled()).toBe(
        true,
      )
      expect(await dialog.getByRole('button', { name: 'New session', exact: true }).isDisabled()).toBe(true)
      const closeButtons = dialog.getByRole('button', { name: 'Close', exact: true })
      expect(await closeButtons.last().isDisabled()).toBe(true)
      await closeButtons.first().click({ force: true })
      expect(await dialog.isVisible()).toBe(true)
      await dialog.getByRole('button', { name: 'Working…', exact: true }).click({ force: true })
      expect(heldRebind).toHaveBeenCalledTimes(1)
      await page.keyboard.press('Escape')
      expect(await dialog.isVisible()).toBe(true)
      await host.ctx.settings.replace('locale', { preference: 'zh' })
      switchedToChinese = true
      await dialog.getByRole('button', { name: '处理中…', exact: true }).waitFor()
    } finally {
      unblockReconnect()
      try {
        await expect
          .poll(() =>
            page
              .getByText(switchedToChinese ? '恢复操作失败，请重试' : 'The recovery action failed. Please retry.', {
                exact: true,
              })
              .count(),
          )
          .toBe(1)
        await dialog
          .getByRole('button', { name: switchedToChinese ? '查看恢复诊断' : 'View recovery diagnostics', exact: true })
          .click()
        const close = dialog.getByRole('button', { name: switchedToChinese ? '关闭' : 'Close', exact: true }).last()
        const footerBounds = required(await close.boundingBox())
        expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(500)
        if (evidenceDirectory !== undefined) {
          await page.screenshot({
            path: join(evidenceDirectory, `recovery-${switchedToChinese ? 'zh' : 'en'}-short-${profile}.png`),
            fullPage: true,
          })
          recoveryLayoutEvidence.shortViewport = page.viewportSize()
          recoveryLayoutEvidence.dialog = await dialog.boundingBox()
          recoveryLayoutEvidence.footer = footerBounds
          writeFileSync(
            join(evidenceDirectory, `recovery-layout-${profile}.json`),
            JSON.stringify(recoveryLayoutEvidence, null, 2),
          )
        }
      } finally {
        heldRebind.mockRestore()
      }
    }
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await dialog.getByText('The recovery action failed. Please retry.', { exact: true }).waitFor()
    const englishDiagnostics = dialog.getByRole('button', { name: 'View recovery diagnostics', exact: true })
    await expect.poll(() => englishDiagnostics.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => dialog.locator('pre').textContent()).toContain(heldRebindMessage)
    const lightFill = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)
    try {
      await host.ctx.settings.replace('ui-theme', { preference: 'dark' })
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
      await expect
        .poll(() => dialog.evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(lightFill)
      const modalContent = dialog
        .getByRole('heading', { name: 'ACP session recovery required', exact: true })
        .locator('..')
        .locator('..')
      const raw = dialog.locator('pre')
      await modalContent.evaluate((element) => {
        element.scrollTop = 0
      })
      await raw.evaluate((element) => {
        element.scrollTop = 0
      })
      const darkDialogBounds = required(await dialog.boundingBox())
      const darkFooter = dialog.getByRole('button', { name: 'Close', exact: true }).last()
      const darkFooterBounds = required(await darkFooter.boundingBox())
      const darkRawBounds = required(await raw.boundingBox())
      const horizontalExtent = await dialog.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(darkDialogBounds.x).toBeGreaterThanOrEqual(0)
      expect(darkDialogBounds.x + darkDialogBounds.width).toBeLessThanOrEqual(740)
      expect(darkFooterBounds.y + darkFooterBounds.height).toBeLessThanOrEqual(500)
      expect(darkRawBounds.x).toBeGreaterThanOrEqual(darkDialogBounds.x)
      expect(darkRawBounds.x + darkRawBounds.width).toBeLessThanOrEqual(darkDialogBounds.x + darkDialogBounds.width)
      expect(horizontalExtent.scrollWidth).toBeLessThanOrEqual(horizontalExtent.clientWidth)
      const englishDarkEvidence: Record<string, unknown> = {
        dialog: darkDialogBounds,
        footer: darkFooterBounds,
        rawDiagnostic: darkRawBounds,
        horizontalExtent,
        lightFill,
        darkFill: await dialog.evaluate((element) => getComputedStyle(element).backgroundColor),
        colorScheme: await page.evaluate(() => document.documentElement.style.colorScheme),
        fontSize: await dialog.evaluate((element) => getComputedStyle(element).fontSize),
        diagnosticsExpanded: await englishDiagnostics.getAttribute('aria-expanded'),
        viewport: page.viewportSize(),
      }
      if (evidenceDirectory !== undefined) {
        await page.screenshot({
          path: join(evidenceDirectory, `recovery-en-dark-short-${profile}.png`),
          fullPage: true,
        })
      }

      const bodyViewport = required(await modalContent.boundingBox())
      const newSession = dialog.getByRole('button', { name: 'New session', exact: true })
      await newSession.scrollIntoViewIfNeeded()
      const newSessionBounds = required(await newSession.boundingBox())
      expect(newSessionBounds.y).toBeGreaterThanOrEqual(bodyViewport.y)
      expect(newSessionBounds.y + newSessionBounds.height).toBeLessThanOrEqual(bodyViewport.y + bodyViewport.height)
      expect(newSessionBounds.y + newSessionBounds.height).toBeLessThanOrEqual(darkFooterBounds.y)

      await raw.scrollIntoViewIfNeeded()
      await modalContent.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      const scrolledBodyViewport = required(await modalContent.boundingBox())
      const scrolledRawBounds = required(await raw.boundingBox())
      const rawScroll = await raw.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        const style = getComputedStyle(element)
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          overflowY: style.overflowY,
        }
      })
      expect(scrolledRawBounds.y).toBeGreaterThanOrEqual(scrolledBodyViewport.y)
      expect(scrolledRawBounds.y + scrolledRawBounds.height).toBeLessThanOrEqual(
        scrolledBodyViewport.y + scrolledBodyViewport.height,
      )
      expect(rawScroll.scrollHeight).toBeGreaterThan(rawScroll.clientHeight)
      expect(rawScroll.scrollTop).toBeGreaterThan(0)
      expect(rawScroll.overflowY).toBe('auto')
      await expect.poll(() => raw.textContent()).toContain(heldRebindMessage)
      const scrolledFooterBounds = required(await darkFooter.boundingBox())
      expect(scrolledFooterBounds.y).toBe(darkFooterBounds.y)
      englishDarkEvidence.scrolled = {
        body: scrolledBodyViewport,
        newSession: newSessionBounds,
        raw: scrolledRawBounds,
        rawScroll,
        footer: scrolledFooterBounds,
      }
      recoveryLayoutEvidence.englishDark = englishDarkEvidence
      if (evidenceDirectory !== undefined) {
        await page.screenshot({
          path: join(evidenceDirectory, `recovery-en-dark-short-scrolled-${profile}.png`),
          fullPage: true,
        })
        writeFileSync(
          join(evidenceDirectory, `recovery-layout-${profile}.json`),
          JSON.stringify(recoveryLayoutEvidence, null, 2),
        )
      }
      await raw.evaluate((element) => {
        element.scrollTop = 0
      })
      await modalContent.evaluate((element) => {
        element.scrollTop = 0
      })
    } finally {
      await host.ctx.settings.replace('ui-theme', { preference: 'light' })
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    }
    await page.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
    const next = await send('E2E_RECOVERED')
    await next.settled
    await page.getByText('E2E_RECOVERED_DONE', { exact: true }).waitFor()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').at(-1)).not.toContain('E2E_CRASH')
  })

  it.skipIf(profile !== 'devin')('keeps recovery focus and scrolling usable at 200% layout zoom', async () => {
    const failed = await send('E2E_CRASH', { expectError: true })
    await failed.settled
    const trigger = page.getByRole('button', { name: 'Resolve recovery issue', exact: true })
    await trigger.waitFor()
    await page.setViewportSize({ width: 740, height: 500 })
    const beforeZoom = required(await trigger.boundingBox())
    const zoomEvidenceDirectory =
      process.env.DSH_E2E_EVIDENCE_DIR ??
      join(root, '.local/session-flow-comparison-2026-10-03/systematic-ui-audit/implementation/web')
    mkdirSync(zoomEvidenceDirectory, { recursive: true })
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2'
    })
    const afterZoom = required(await trigger.boundingBox())
    expect(afterZoom.width).toBeGreaterThan(beforeZoom.width)

    await trigger.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    const closeButtons = dialog.getByRole('button', { name: 'Close', exact: true })
    await closeButtons.first().click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)

    await trigger.click()
    await dialog.waitFor({ state: 'visible' })
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const longDiagnostic = `E2E_ZOOM_RECOVERY_DIAGNOSTIC ${'readable recovery detail '.repeat(80)}`
    const heldRebind = vi.spyOn(service, 'rebindRecoveryBlank').mockRejectedValue(new Error(longDiagnostic))
    try {
      await dialog.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
      await dialog.getByText('The recovery action failed. Please retry.', { exact: true }).waitFor()
      const diagnostics = dialog.getByRole('button', { name: 'View recovery diagnostics', exact: true })
      await diagnostics.click()
      await expect.poll(() => diagnostics.getAttribute('aria-expanded')).toBe('true')
      const raw = dialog.locator('pre')
      await expect.poll(() => raw.textContent()).toContain(longDiagnostic)

      const bounds = required(await dialog.boundingBox())
      const footer = dialog.getByRole('button', { name: 'Close', exact: true }).last()
      const footerBounds = required(await footer.boundingBox())
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(740)
      expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(500)

      const content = dialog
        .getByRole('heading', { name: 'ACP session recovery required', exact: true })
        .locator('..')
        .locator('..')
      const newSession = dialog.getByRole('button', { name: 'New session', exact: true })
      await newSession.scrollIntoViewIfNeeded()
      const contentBounds = required(await content.boundingBox())
      const newSessionBounds = required(await newSession.boundingBox())
      expect(newSessionBounds.y).toBeGreaterThanOrEqual(contentBounds.y)
      expect(newSessionBounds.y + newSessionBounds.height).toBeLessThanOrEqual(contentBounds.y + contentBounds.height)
      expect(newSessionBounds.y + newSessionBounds.height).toBeLessThanOrEqual(footerBounds.y)

      await raw.scrollIntoViewIfNeeded()
      const rawScroll = await raw.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
      })
      expect(rawScroll.scrollHeight).toBeGreaterThan(rawScroll.clientHeight)
      expect(rawScroll.scrollTop).toBeGreaterThan(0)
      expect(required(await footer.boundingBox()).y).toBe(footerBounds.y)
      const zoomEvidence = await page.evaluate(
        ({ trigger, dialog, footer, newSession, raw }) => {
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect()
            return { x: box.x, y: box.y, width: box.width, height: box.height }
          }
          const rawElement = raw as HTMLElement
          return {
            viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
            layoutZoom: getComputedStyle(document.documentElement).zoom,
            trigger: rect(trigger),
            dialog: rect(dialog),
            footer: rect(footer),
            newSession: rect(newSession),
            raw: {
              ...rect(rawElement),
              scrollTop: rawElement.scrollTop,
              scrollHeight: rawElement.scrollHeight,
              clientHeight: rawElement.clientHeight,
            },
            document: {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              scrollHeight: document.documentElement.scrollHeight,
              clientHeight: document.documentElement.clientHeight,
            },
          }
        },
        {
          trigger: required(await trigger.elementHandle()),
          dialog: required(await dialog.elementHandle()),
          footer: required(await footer.elementHandle()),
          newSession: required(await newSession.elementHandle()),
          raw: required(await raw.elementHandle()),
        },
      )
      await page.screenshot({
        path: join(zoomEvidenceDirectory, `recovery-zoom-200-short-${profile}.png`),
        fullPage: true,
      })
      writeFileSync(
        join(zoomEvidenceDirectory, `recovery-zoom-200-short-${profile}.json`),
        JSON.stringify({ beforeZoom, afterZoom, ...zoomEvidence }, null, 2),
      )
    } finally {
      heldRebind.mockRestore()
      await page.evaluate(() => {
        document.documentElement.style.zoom = ''
      })
    }
  })

  it.skipIf(profile !== 'devin')(
    'releases a matching recovery action after a same-session lifecycle refresh',
    async () => {
      const failed = await send('E2E_CRASH', { expectError: true })
      await failed.settled
      const sessionValue = await page
        .locator('[data-conversation-session]')
        .last()
        .getAttribute('data-conversation-session')
      if (sessionValue === null) throw new Error('Recovery fixture has no active session ID')
      const sessionId = sessionValue as SessionId
      const trigger = page.getByRole('button', { name: 'Resolve recovery issue', exact: true })
      await trigger.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor({ state: 'visible' })
      const service = host.ctx.get('dshAcp') as AcpRemoteService
      const actualRebind = service.rebindRecoveryBlank.bind(service)
      const actualSnapshot = service.recoverySnapshot.bind(service)
      const initialSnapshot = await actualSnapshot(sessionId)
      const runningStatuses: boolean[] = []
      let refreshesAfterRunning = 0
      let allowHealthySnapshot = false
      const snapshot = vi.spyOn(service, 'recoverySnapshot').mockImplementation(async () => {
        if (allowHealthySnapshot) return await actualSnapshot(sessionId)
        if (runningStatuses.includes(true)) refreshesAfterRunning++
        return initialSnapshot
      })
      let finishRebind!: () => void
      const rebindGate = new Promise<void>((resolve) => {
        finishRebind = resolve
      })
      const rebind = vi.spyOn(service, 'rebindRecoveryBlank').mockImplementation(async (id) => {
        await rebindGate
        return await actualRebind(id)
      })
      const stopObservingStatus = host.ctx.on('api-session/status', (id, running) => {
        if (id === sessionId) runningStatuses.push(running)
      })
      try {
        await dialog.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
        await expect.poll(() => dialog.getByRole('button', { name: 'Working…', exact: true }).count()).toBe(1)

        const transitionedTurn = host.whenTurnSettled(60_000)
        await host.ctx.sessionController.prompt(
          {
            requestId: randomUUID() as SessionRequestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: 'E2E_RECOVERY_LIFECYCLE_REFRESH' }],
          },
          new AbortController().signal,
        )
        await expect.poll(() => runningStatuses.includes(true), { timeout: 15_000 }).toBe(true)
        expect(rebind).toHaveBeenCalledTimes(1)
        await expect
          .poll(
            async () => ({
              recoveryReadAfterRunning: refreshesAfterRunning > 0,
              dialogVisible: await dialog.isVisible(),
              triggerVisible: await trigger.isVisible(),
              triggerDisabled: await trigger.isDisabled(),
            }),
            { timeout: 15_000 },
          )
          .toEqual({
            recoveryReadAfterRunning: true,
            dialogVisible: false,
            triggerVisible: true,
            triggerDisabled: true,
          })
        expect(rebind).toHaveBeenCalledTimes(1)

        allowHealthySnapshot = true
        finishRebind()
        await transitionedTurn
        await expect.poll(async () => (await actualSnapshot(sessionId)).kind, { timeout: 30_000 }).toBe('healthy')
        await trigger.waitFor({ state: 'hidden', timeout: 30_000 })
        await expect.poll(() => snapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
        expect(rebind).toHaveBeenCalledTimes(1)
      } finally {
        finishRebind()
        stopObservingStatus()
        rebind.mockRestore()
        snapshot.mockRestore()
      }
    },
  )

  it.skipIf(profile !== 'devin')('ignores an old recovery response after switching to a native session', async () => {
    const failed = await send('E2E_CRASH', { expectError: true })
    await failed.settled
    const oldSessionId = await page
      .locator('[data-conversation-session]')
      .last()
      .getAttribute('data-conversation-session')
    if (oldSessionId === null || oldSessionId.length === 0) throw new Error('Recovery fixture has no active session ID')
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })

    let rejectHeldRebind!: (error: Error) => void
    let rebindSettled = false
    const heldRebindResult = new Promise<never>((_resolve, reject) => {
      rejectHeldRebind = reject
    })
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    const heldRebind = vi.spyOn(service, 'rebindRecoveryBlank').mockImplementation(async (sessionId) => {
      expect(sessionId).toBe(oldSessionId)
      try {
        return await heldRebindResult
      } finally {
        rebindSettled = true
      }
    })
    try {
      await dialog.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
      await expect.poll(() => dialog.getByRole('button', { name: 'Working…', exact: true }).count()).toBe(1)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'native-control', model: 'native-model' })
      // Use the Host's normal archive transition to clear the current view;
      // the modal correctly blocks sidebar navigation while it is open.
      await host.ctx.workspaceController.archiveSession({ sessionId: oldSessionId as SessionId })
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
      const toolbarNewSession = page.getByRole('button', { name: 'New session', exact: true }).last()
      await toolbarNewSession.waitFor({ state: 'visible' })
      await toolbarNewSession.click()
      await expect
        .poll(async () => {
          const id = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
          return id !== null && id.length > 0 && id !== oldSessionId ? id : null
        })
        .not.toBeNull()
      const newConversation = page.locator('[data-conversation-session]').last()
      const newSessionId = await newConversation.getAttribute('data-conversation-session')
      expect(newSessionId).not.toBeNull()
      expect(newSessionId).not.toBe('')
      expect(await newConversation.getByRole('button', { name: 'Resolve recovery issue', exact: true }).count()).toBe(0)
      await host.ctx.workspaceController.unarchiveSession({ sessionId: oldSessionId as SessionId })

      const oldFailure = 'E2E_OLD_SESSION_RECOVERY_FAILURE'
      rejectHeldRebind(new Error(oldFailure))
      await expect.poll(() => rebindSettled).toBe(true)
      expect(heldRebind).toHaveBeenCalledTimes(1)
      expect(heldRebind).toHaveBeenCalledWith(oldSessionId)
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
      expect(
        await newConversation.getByText('The recovery action failed. Please retry.', { exact: true }).count(),
      ).toBe(0)
      expect(await newConversation.getByText(oldFailure, { exact: true }).count()).toBe(0)

      const input = newConversation.locator('[data-composer-input]').first()
      await input.waitFor({ state: 'visible' })
      await writeComposerDraft(page, input, 'E2E_NATIVE_AFTER_RECOVERY_SWITCH')
      const settled = host.whenTurnSettled(30_000)
      await newConversation.getByRole('button', { name: 'Send message', exact: true }).click()
      expect(await settled).toBe(newSessionId)
      await newConversation.getByText('E2E_NATIVE_DONE', { exact: true }).waitFor()
      expect(observed).toContain('native-control')
    } finally {
      if (!rebindSettled) rejectHeldRebind(new Error('E2E_RECOVERY_SWITCH_CLEANUP'))
      heldRebind.mockRestore()
    }
  })

  it.each([false, true])('maps native permission decisions without changing their scope: allow=%s', async (allow) => {
    await host.ctx.settings.replace('locale', { preference: allow ? 'zh' : 'en' })
    try {
      const { settled } = await send('E2E_PERMISSION')
      expect(existsSync(join(workspace, 'approval-marker.txt'))).toBe(false)
      const panel = page.locator('[data-approval-key]')
      await panel.waitFor()
      expect(await panel.innerText()).not.toContain('The ACP Agent requests permission')
      expect(await panel.innerText()).not.toContain('ACP Agent 请求')
      await decide(allow)
      await settled
      await page.getByText(allow ? 'E2E_APPROVED' : 'E2E_DENIED', { exact: true }).waitFor()
      expect(existsSync(join(workspace, 'approval-marker.txt'))).toBe(allow)
      expect(readFileSync(agentLog, 'utf8')).toContain(`"optionId":"${allow ? 'permit-single' : 'deny-single'}"`)
      expect(await page.locator('[data-question-key], [data-approval-key]').count()).toBe(0)
    } finally {
      await host.ctx.settings.replace('locale', { preference: 'en' })
    }
  })

  it('stops the external turn through the native stop control and accepts the next turn', async () => {
    const { settled } = await send('E2E_STOP')
    await page.getByText('E2E_RUNNING', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await settled
    expect(readFileSync(agentLog, 'utf8')).toContain('regression cancelled')
    const next = await send('E2E_MESSAGE')
    await next.settled
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
  })

  for (const atomic of [false, true])
    it(`steers through native admission with ${atomic ? 'atomic injection' : 'cancel and drain'}`, async () => {
      const previous = host.ctx.settings.describe().find((row) => row.ns === 'dsh-acp-adapter')?.value as {
        agents: Record<string, AcpAgentConfig>
      }
      const configs = previous.agents
      await host.ctx.settings.replace('dsh-acp-adapter', {
        ...previous,
        agents: {
          ...configs,
          [profile]: {
            ...configs[profile],
            env: { ...configs[profile].env, MOCK_STEERING: atomic ? 'atomic' : '' },
          },
        },
      })
      const off = host.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        return {
          ...decision,
          messages: decision.messages.map((message) => ({
            ...message,
            content: message.content.map((block) =>
              block.type === 'text'
                ? { ...block, text: block.text.replace('E2E_INPUT_RAW', 'E2E_INPUT_REWRITTEN') }
                : block,
            ),
          })),
        }
      })
      const offset = existsSync(agentLog) ? readFileSync(agentLog, 'utf8').length : 0
      try {
        const { settled } = await send('E2E_STEERING_HOLD')
        await page.getByText('E2E_STEERING_RUNNING', { exact: true }).waitFor()
        const input = page.locator('[data-composer-input]').first()
        await writeComposerDraft(page, input, 'E2E_INPUT_RAW')
        await input.press('Enter')
        const queued = page.getByRole('listitem').filter({ hasText: 'E2E_INPUT_RAW' })
        await queued.getByRole('button', { name: 'Steer queued message' }).click()
        const id = await settled
        await page.getByText(atomic ? 'E2E_STEER_DONE' : 'E2E_DONE mock-model-a', { exact: true }).waitFor()
        const log = readFileSync(agentLog, 'utf8').slice(offset)
        expect(log).toContain('E2E_INPUT_REWRITTEN')
        expect(log).not.toContain('E2E_INPUT_RAW')
        expect(log.split('regression prompt=').length - 1).toBe(atomic ? 1 : 2)
        expect(log.includes('session/cancel')).toBe(!atomic)
        const inputs = events.filter(
          (event) =>
            event.sessionId === id &&
            event.type === 'user/message' &&
            JSON.stringify(event.data).includes('E2E_INPUT_REWRITTEN'),
        )
        expect(inputs).toHaveLength(1)
        expect(
          events.filter((event) => event.type === 'step/start').filter((event) => event.sessionId === id),
        ).toHaveLength(2)
        await page.reload()
        await page.getByText(atomic ? 'E2E_STEER_DONE' : 'E2E_DONE mock-model-a', { exact: true }).waitFor()
        await expandProcess()
        await page.getByText(/E2E_STEERING_RUNNING/).waitFor()
      } finally {
        off()
        await host.ctx.settings.replace('dsh-acp-adapter', previous)
      }
    })

  it('keeps a third native input queued while the first atomic-steering acknowledgement is pending', async () => {
    const previous = host.ctx.settings.describe().find((row) => row.ns === 'dsh-acp-adapter')?.value as {
      agents: Record<string, AcpAgentConfig>
    }
    const gateDirectory = join(host.workspaceCwd, `steering-ack-gate-${profile}-${ordinal}`)
    mkdirSync(gateDirectory, { recursive: true })
    const releaseMarker = join(gateDirectory, 'release-steering-ack')
    rmSync(releaseMarker, { force: true })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      ...previous,
      agents: {
        ...previous.agents,
        [profile]: {
          ...previous.agents[profile],
          env: {
            ...previous.agents[profile].env,
            MOCK_STEERING: 'atomic',
            MOCK_STEERING_ACK_GATE_DIR: gateDirectory,
          },
        },
      },
    })
    const off = host.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: decision.messages.map((message) => ({
          ...message,
          content: message.content.map((block) =>
            block.type === 'text'
              ? { ...block, text: block.text.replace('E2E_INPUT_RAW', 'E2E_INPUT_REWRITTEN') }
              : block,
          ),
        })),
      }
    })
    const offset = existsSync(agentLog) ? readFileSync(agentLog, 'utf8').length : 0
    const steerQueued = async (value: string): Promise<void> => {
      const input = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, input, value)
      await input.press('Enter')
      const queued = page.getByRole('listitem').filter({ hasText: value })
      await queued.getByRole('button', { name: 'Steer queued message' }).click()
      await queued.waitFor({ state: 'detached' })
    }
    try {
      const { settled } = await send('E2E_STEERING_ACK_RACE')
      await page.getByText('E2E_STEERING_ACK_RACE_RUNNING', { exact: true }).waitFor()
      await steerQueued('E2E_INPUT_RAW_SECOND')
      await expect.poll(() => readFileSync(agentLog, 'utf8').slice(offset)).toContain('steering-ack-pending')
      await steerQueued('E2E_INPUT_RAW_THIRD')
      const pendingLog = readFileSync(agentLog, 'utf8').slice(offset)
      expect(pendingLog.split('--> _session/steering').length - 1).toBe(1)
      expect(pendingLog).not.toContain('E2E_INPUT_REWRITTEN_THIRD')
      expect(pendingLog).not.toContain('session/cancel')

      writeFileSync(releaseMarker, 'release')
      const id = await settled
      await page.getByText('E2E_STEERING_ACK_RACE_DONE', { exact: true }).waitFor()
      const log = readFileSync(agentLog, 'utf8').slice(offset)
      expect(log.split('regression prompt=').length - 1).toBe(1)
      expect(log.split('--> _session/steering').length - 1).toBe(2)
      expect(log).not.toContain('session/cancel')
      expect(log).not.toContain('steering-cancelled')
      expect(log).toContain('E2E_INPUT_REWRITTEN_SECOND')
      expect(log).toContain('E2E_INPUT_REWRITTEN_THIRD')
      expect(log.indexOf('E2E_INPUT_REWRITTEN_SECOND')).toBeLessThan(log.indexOf('E2E_INPUT_REWRITTEN_THIRD'))
      expect(log).not.toContain('E2E_INPUT_RAW')

      const sessionEvents = events.filter((event) => event.sessionId === id)
      for (const value of ['E2E_INPUT_REWRITTEN_SECOND', 'E2E_INPUT_REWRITTEN_THIRD']) {
        expect(
          sessionEvents.filter((event) => event.type === 'user/message' && JSON.stringify(event.data).includes(value)),
        ).toHaveLength(1)
      }
      expect(sessionEvents.filter((event) => event.type === 'step/start')).toHaveLength(3)
      expect(
        sessionEvents.filter(
          (event) =>
            event.type === 'assistant/message' && JSON.stringify(event.data).includes('E2E_STEERING_ACK_RACE_DONE'),
        ),
      ).toHaveLength(1)
    } finally {
      writeFileSync(releaseMarker, 'release')
      off()
      await host.ctx.settings.replace('dsh-acp-adapter', previous)
    }
  })

  it('clears the old Agent approval before delivering steering in the same session', async () => {
    const { settled } = await send('E2E_PERMISSION')
    await page.locator('[data-question-key], [data-approval-key]').waitFor()
    const first = required(
      events.findLast(
        (event) => event.type === 'user/message' && JSON.stringify(event.data).includes('E2E_PERMISSION'),
      ),
    )
    const agent = required(host.ctx.agents.get(first.sessionId))
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'E2E_RECOVERED' }] }))
    await settled
    await page.locator('[data-question-key], [data-approval-key]').waitFor({ state: 'hidden' })
    await page.getByText('E2E_RECOVERED_DONE', { exact: true }).waitFor()
    expect(existsSync(join(workspace, 'approval-marker.txt'))).toBe(false)
  })

  it('drains a suspended native injection when pre-step rejects the new input', async () => {
    const previous = host.ctx.settings.describe().find((row) => row.ns === 'dsh-acp-adapter')?.value as {
      agents: Record<string, AcpAgentConfig>
    }
    await host.ctx.settings.replace('dsh-acp-adapter', {
      ...previous,
      agents: {
        ...previous.agents,
        [profile]: {
          ...previous.agents[profile],
          env: { ...previous.agents[profile].env, MOCK_STEERING: 'atomic' },
        },
      },
    })
    const off = host.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.messages.some((message) => JSON.stringify(message.content).includes('E2E_REJECT_INPUT')))
        return { kind: 'reject' }
      return await next()
    })
    const offset = existsSync(agentLog) ? readFileSync(agentLog, 'utf8').length : 0
    try {
      const { settled } = await send('E2E_STEERING_HOLD')
      await page.getByText('E2E_STEERING_RUNNING', { exact: true }).waitFor()
      const first = required(
        events.findLast(
          (event) => event.type === 'user/message' && JSON.stringify(event.data).includes('E2E_STEERING_HOLD'),
        ),
      )
      required(host.ctx.agents.get(first.sessionId)).steer(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'E2E_REJECT_INPUT' }] }),
      )
      await settled
      await expect.poll(() => readFileSync(agentLog, 'utf8').slice(offset)).toContain('steering-cancelled')
      expect(readFileSync(agentLog, 'utf8').slice(offset)).not.toContain('regression steer=')
      // The abandoned execution must settle its ledger before a subsequent turn.
      const next = await send('E2E_RECOVERED')
      await next.settled
      await page.getByText('E2E_RECOVERED_DONE', { exact: true }).waitFor()
    } finally {
      off()
      await host.ctx.settings.replace('dsh-acp-adapter', previous)
    }
  })

  it('recovers the native connection without reloading or duplicating ACP history', async () => {
    const first = await send('E2E_MESSAGE')
    await first.settled
    const priorPrompts = readFileSync(agentLog, 'utf8').split('regression prompt=').length
    try {
      await page.context().setOffline(true)
      await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
    } finally {
      await page.context().setOffline(false)
    }
    await page
      .getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ })
      .waitFor({ state: 'hidden' })
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').length).toBe(priorPrompts)
    const next = await send('E2E_MESSAGE')
    await next.settled
    // Host settlement precedes delivery of the final stream update to the UI.
    await expect.poll(() => page.getByText('E2E_DONE mock-model-a', { exact: true }).count()).toBe(2)
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').length).toBe(priorPrompts + 1)
  })

  it('shows Sending and blocks queue actions until the host accepts the message', async () => {
    const active = await send('E2E_STOP')
    await page.getByText('E2E_RUNNING', { exact: true }).waitFor()
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.route(
      '**/api/session/prompt',
      async (route) => {
        received.resolve()
        await release.promise
        await route.continue()
      },
      { times: 1 },
    )
    try {
      const input = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, input, 'E2E_QUEUED')
      await input.press('Enter')
      await received.promise
      const pending = page.locator('[data-queue-dock] [data-submission-echo]')
      await pending.getByRole('status').waitFor()
      expect(await pending.getByRole('status').textContent()).toBe('Sending…')
      expect(await pending.getByRole('button').count()).toBe(3)
      expect(
        await pending
          .getByRole('button')
          .evaluateAll((buttons) => buttons.every((button) => button instanceof HTMLButtonElement && button.disabled)),
      ).toBe(true)
    } finally {
      release.resolve()
    }
    const remove = page.getByRole('button', { name: 'Remove queued message', exact: true })
    await expect.poll(() => remove.isEnabled()).toBe(true)
    await remove.click()
    await page.locator('[data-queue-dock]').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await active.settled
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').at(-1)).not.toContain('E2E_QUEUED')
  })

  it('changes models using the native picker and converges the external session selection', async () => {
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Mock Model B', exact: true }).click()
    // Selection is an asynchronous native RPC. Its completion closes the menu
    // and restores focus; typing before that boundary races focus restoration.
    const picker = page.getByRole('button', { name: /^Select model, current Mock Model B/ })
    await expect.poll(() => picker.getAttribute('aria-expanded')).toBe('false')
    const { settled } = await send('E2E_MESSAGE')
    await settled
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    expect(readFileSync(agentLog, 'utf8')).toContain('model=mock-model-b')
  })

  it('shows evidence-backed children in native read-only detail and does not invent missing evidence', async () => {
    const { settled } = await send('E2E_CHILD')
    await settled
    await page.getByText('E2E_PARENT_DONE', { exact: true }).waitFor()
    const supported = profile === 'claude' || profile === 'devin'
    await expect
      .poll(
        async () =>
          (await host.ctx.sessionPersistence.list()).filter((item) => item.header.origin === 'subagent').length,
      )
      .toBe(supported ? 1 : 0)
    if (!supported) return
    const child = required((await host.ctx.sessionPersistence.list()).find((item) => item.header.origin === 'subagent'))
    // Persistence publishes the header at create(), before the asynchronous
    // projection appends its body. Directory presence is not a completion barrier.
    await expect
      .poll(
        async () => {
          const handle = await host.ctx.sessionPersistence.open(child.header.id, 'read')
          try {
            const log = await handle.read()
            return { version: handle.header.version, events: log.events.map((event) => event.type) }
          } finally {
            await handle.close()
          }
        },
        { timeout: 10000 },
      )
      .toEqual({
        version: 4,
        events: [
          'subagent/descriptor',
          'turn/start',
          'step/start',
          'user/message',
          'assistant/message',
          'step/end',
          'turn/end',
        ],
      })
    const parent = required(host.ctx.sessions.get(child.header.parentSession!))
    await expect
      .poll(() => host.ctx.sessionProjections.snapshot(parent, ['subagentCatalog']).values.subagentCatalog)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: child.header.id })]))
    await expandProcess()
    await page.getByRole('button', { name: 'Open read-only record', exact: true }).first().click()
    const sidebar = page.locator('[data-sidebar-chat]')
    for (let round = 0; round < 2; round++) {
      if (round) await page.reload()
      await sidebar.getByText('E2E_CHILD_RESULT', { exact: profile === 'claude' }).waitFor()
      await sidebar.getByText('One-shot subagent record', { exact: true }).waitFor()
      expect(await sidebar.locator('[data-composer-input][contenteditable="true"]:visible').count()).toBe(0)
      expect(await page.locator('[data-composer-input][contenteditable="true"]:visible').count()).toBe(1)
      await page.getByRole('tab', { name: 'ACP Diagnostics', exact: true }).waitFor()
    }
  })

  it('keeps a native provider usable beside ACP without dispatching another ACP prompt', async () => {
    const promptCount = () =>
      existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('regression prompt=').length - 1 : 0
    const before = promptCount()
    const calls: string[] = []
    const disposePre = host.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId === 'e2e-native-call') calls.push('pre')
      return await next()
    })
    const disposePost = host.ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.callId !== 'e2e-native-call') return decision
      calls.push('post')
      expect(JSON.stringify(result)).toContain('E2E_NATIVE_BODY')
      return { kind: 'accept', content: [{ type: 'text', text: 'E2E_NATIVE_POST' }] }
    })
    try {
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'native-control', model: 'native-model' })
      await page.reload()
      const { settled } = await send('E2E_NATIVE')
      await settled
      await page.getByText('E2E_NATIVE_DONE', { exact: true }).waitFor()
      expect(await page.locator('[data-acp-team-management]').count()).toBe(0)
      expect(await page.getByRole('button', { name: /^Session ·/ }).count()).toBe(0)
      expect(observed).toContain('native-control')
      expect(calls).toEqual(['pre', 'post'])
      expect(promptCount()).toBe(before)
    } finally {
      disposePost()
      disposePre()
    }
  })
})
