import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'
import { createAcpSidecar } from '../../src/persistence/sidecar.ts'

const profiles = ['claude', 'codex', 'devin', 'kimi']

class NativeControl extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Native control' } }
  async listModels(provider) { return [{ provider, id: 'native-model', name: 'Native Model' }] }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
  async *stream(options) {
    const results = options.messages.filter(message => message.source.kind === 'tool')
    if (results.length === 0) {
      expect(options.tools.some(tool => tool.name === 'e2e_fixture')).toBe(true)
      const block = { type: 'tool-call', id: 'e2e-native-call', name: 'e2e_fixture', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    expect(JSON.stringify(results)).toContain('E2E_NATIVE_POST')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'E2E_NATIVE_DONE' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'E2E_NATIVE_DONE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.each(profiles)('native product parity: %s protocol fixture', profile => {
  let host, browser, page, agentLog, workspace
  let ordinal = 0
  let errors = []
  const observed = []
  const events = []
  const provider = `acp-${profile}`

  beforeAll(async () => {
    host = await launchAdapterWorld()
    agentLog = join(host.workspaceCwd, 'fixture-agent.log')
    await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
      name: `Fixture ${profile}`, command: process.execPath,
      args: [join(root, 'test/mock-agent/mock-agent.mjs')],
      env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile, MOCK_LOG: agentLog },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === provider)).toBe(true))
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['native-control'], new NativeControl()))
    host.ctx.effect(() => host.ctx.tools.register({
      name: 'e2e_fixture', description: 'Return fixture text', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'E2E_NATIVE_BODY',
    }))
    host.ctx.on('llm/stream', (request, next) => { observed.push(request.provider); return next() })
    host.ctx.on('session/event', (session, event) => events.push({ id: session.id, ...event }))
    browser = await chromium.launch({ headless: true, ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
  })

  beforeEach(async () => {
    await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'mock-model-a' })
    errors = []
    page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
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
        writeFileSync(join(directory, `${profile}-${ordinal}.json`), JSON.stringify({ body: await page.locator('body').innerText(), errors, observed, events, agent: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '' }, null, 2))
        await page.screenshot({ path: join(directory, `${profile}-${ordinal}.png`), fullPage: true })
      }
      expect(errors).toEqual([])
    } finally { await page?.close() }
  })
  afterAll(async () => {
    const pending = new Set(['browser', 'host'])
    const diagnostic = setTimeout(() => console.error(`E2E teardown pending: ${profile} ${[...pending].join(', ')}`), 10_000)
    try {
      // A slow browser shutdown must not postpone releasing Agent processes.
      // Both independent cleanup failures remain test failures.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => browser?.close()).finally(() => pending.delete('browser')),
        Promise.resolve().then(() => host?.close()).finally(() => pending.delete('host')),
      ])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'ACP browser regression cleanup failed')
    } finally { clearTimeout(diagnostic) }
  })

  async function send(prompt, { expectError = false } = {}) {
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, prompt)
    const button = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => button.isEnabled()).toBe(true)
    const settled = host.whenTurnSettled(30_000).then(id => {
      const end = events.findLast(event => event.id === id && event.type === 'turn/end')
      if (expectError) expect(end?.data.reason, 'native turn settlement').toMatchObject({ kind: 'error' })
      else expect(end?.data.reason, 'native turn settlement').not.toMatchObject({ kind: 'error' })
      return id
    })
    await button.click()
    return { settled }
  }

  async function decide(allow) {
    const panel = page.locator('[data-question-key], [data-approval-key]')
    await panel.waitFor({ timeout: 15_000 })
    expect(await panel.innerText()).toContain('echo E2E_APPROVED')
    if (await panel.getAttribute('data-question-key') !== null) {
      await panel.getByRole('radio', { name: allow ? 'Allow this operation' : 'Reject this operation', exact: true }).click()
      await panel.getByRole('button', { name: /Submit|Send/, exact: false }).click()
    } else {
      await panel.getByRole('button', { name: allow ? 'Allow once' : 'Reject', exact: true }).click()
    }
  }

  it('edits settings through native inputs and buttons with validation, cancel and persisted save', async () => {
    const openSettings = async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'ACP adapter', exact: true }).click()
      return dialog
    }
    let dialog = await openSettings()
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    const name = dialog.getByLabel('Display name', { exact: true })
    expect(await name.inputValue()).toBe(`Fixture ${profile}`)
    await name.fill('Unsaved name')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await name.inputValue()).toBe(`Fixture ${profile}`)
    await name.fill('')
    expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await name.fill(`Updated ${profile}`)
    const evidence = join(root, '.local/e2e-settings')
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `${profile}.png`), fullPage: true })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.getByText('Saved.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    dialog = await openSettings()
    await dialog.getByText(`Updated ${profile}`, { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    await dialog.getByLabel('Display name', { exact: true }).fill(`Fixture ${profile}`)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.getByText('Saved.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  })

  it('keeps the audit ledger and wrapped details in the native trajectory viewport', async () => {
    page.setDefaultTimeout(10_000)
    const { settled } = await send('E2E_JOB_OTHER')
    const id = await settled
    // Seed a long, real audit journal without spending dozens of model turns.
    const sidecar = createAcpSidecar({ root: host.ctx.dshHomePath('dsh-acp') })
    try {
      for (let index = 0; index < 80; index += 1) {
        await sidecar.append(id, { kind: 'degradation', data: {
          code: 'unsupported-tool-content', toolCallId: `audit-layout-${index}`,
          items: Array.from({ length: 18 }, (_, item) => ({ type: `item-${item}`, reason: 'long-unbroken-value-'.repeat(5) })),
          keptPreviewChars: 0, truncated: false,
        } })
      }
      await sidecar.flush()
    } finally { await sidecar.dispose() }

    await page.getByText('Trajectory', { exact: true }).click()
    const nativeBounds = await page.locator('[data-conversation-composer-overlay]').boundingBox()
    await page.getByText('ACP Diagnostics', { exact: true }).click()
    const audit = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await audit.waitFor()
    const toolbar = audit.getByRole('toolbar')
    const toolbarTop = (await toolbar.boundingBox()).y
    const scroll = audit.locator('[data-audit-scroll]')
    await audit.getByRole('button', { name: 'Load more', exact: true }).click()
    await audit.getByText('All records in this view are shown', { exact: true }).waitFor()
    const bounds = await audit.boundingBox()
    expect(Math.abs(bounds.y - nativeBounds.y)).toBeLessThan(2)
    expect(Math.abs(bounds.height - nativeBounds.height)).toBeLessThan(2)
    expect(await page.locator('[data-width-handle]:visible').count()).toBe(0)

    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
    await scroll.hover()
    await page.mouse.wheel(0, 1000)
    expect(Math.abs((await toolbar.boundingBox()).y - toolbarTop)).toBeLessThan(2)
    await audit.locator('tbody tr').last().click()
    const details = audit.getByRole('complementary')
    await details.waitFor()
    const close = details.getByRole('button', { name: 'Close', exact: true })
    expect((await close.boundingBox()).y).toBeGreaterThanOrEqual(toolbarTop)
    expect((await close.boundingBox()).y).toBeLessThan(toolbarTop + 80)
    const tree = details.getByRole('tree', { name: 'Diagnostic record JSON', exact: true })
    // Long collapsed previews and expanded nested strings both stay in bounds.
    const checkWidth = async () => {
      for (const locator of [audit, details, tree, tree.locator('xpath=..'), tree.locator('xpath=../..')]) {
        expect(await locator.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      }
    }
    await checkWidth()
    await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    await tree.getByRole('button', { name: 'Expand node', exact: true }).first().click()
    await checkWidth()
    const detailScroll = details.locator('[data-audit-detail-scroll]')
    await detailScroll.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await detailScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await audit.locator('tbody tr').nth(78).click()
    await expect.poll(() => detailScroll.evaluate(element => element.scrollTop)).toBe(0)
    await close.click()
    await page.setViewportSize({ width: 680, height: 720 })
    await audit.locator('tbody tr').last().click()
    await details.waitFor()
    await checkWidth()
    expect((await close.boundingBox()).y).toBeLessThan(200)
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
    const sidecar = createAcpSidecar({ root: host.ctx.dshHomePath('dsh-acp') })
    try {
      for (let index = 0; index < 150; index += 1) {
        await sidecar.append(id, { kind: 'replay-assessment', data: { status: 'not-compared', detail: '0 staged updates' } })
      }
      await sidecar.append(id, { kind: 'filesystem', data: { operation: 'read', path: '/missing-diagnostic-fixture', bytes: 0, beforeHash: null, afterHash: null, outcome: 'error', reason: 'not-found', acpSessionId: 'fixture', profileId: profile } })
      for (const option of ['allow_once', 'reject_once']) {
        await sidecar.append(id, { kind: 'permission', data: { phase: 'decided', requestId: option, agentSessionId: 'fixture', toolCallId: option, outcome: 'selected', optionId: option, selectedOptionKind: option } })
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
      await sidecar.writeRecoveryState({ dshSessionId: id, kind: 'reconnect-required', cause: 'auth-required', detail: 'E2E_RECORDED_RECOVERY_CAUSE', provider, updatedAt: Date.now() })
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
      const chineseSettings = page.getByRole('dialog', { name: '设置', exact: true })
      await chineseSettings.getByRole('button', { name: 'ACP adapter', exact: true }).click()
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      await chineseSettings.getByText(`v${version}`, { exact: true }).waitFor()
      await chineseSettings.getByRole('button', { name: '关闭', exact: true }).click()
      const chinesePanel = page.getByRole('region', { name: 'ACP 诊断', exact: true })
      await chinesePanel.getByRole('button', { name: '异常', exact: true }).waitFor()
      await chinesePanel.getByText('已显示当前分类全部记录', { exact: true }).waitFor()
      expect(await chinesePanel.locator('tbody').innerText()).toContain('读取文件')
      await chinesePanel.getByRole('button', { name: '操作记录', exact: true }).click()
      await chinesePanel.getByText('权限决定已记录 · allow_once · 已允许本次操作', { exact: true }).waitFor()
      expect(await chinesePanel.innerText()).toContain('已拒绝本次操作')
      await sidecar.append(id, { kind: 'terminal', data: { operation: 'exit', terminalId: 'legacy-term', dshSessionId: id, profileId: profile, acpSessionId: 'fixture', command: 'legacy command', argCount: 0, cwd: '/', outputBytes: 0, truncated: false, outcome: 'exited', exitCode: null, signal: 'SIGTERM' } })
      await sidecar.flush()
      await chinesePanel.getByRole('button', { name: '异常', exact: true }).click()
      await expect.poll(() => chinesePanel.locator('tbody tr').count()).toBe(2)
      await chinesePanel.locator('tbody tr').filter({ hasText: '退出原因待确认' }).click()
      await chinesePanel.getByText('此旧记录包含非零退出码或退出信号，但未记录是否主动终止；不能据此确定是操作取消还是进程故障。', { exact: true }).waitFor()
    } finally {
      await sidecar.dispose()
      await host.ctx.settings.replace('locale', { preference: 'en' })
    }
  })

  it('uses the native composer, attachment history, assistant stream and tool presentation across reload', async () => {
    await page.locator('input[type="file"]').setInputFiles({ name: 'parity.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E_UPLOAD_BYTES') })
    const { settled } = await send('E2E_MESSAGE')
    const id = await settled
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(observed).toContain(provider)
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    let log
    try { log = (await handle.read()).events } finally { await handle.close() }
    const assistant = log.find(event => event.type === 'assistant/message')
    expect(assistant.data.stream.length).toBeGreaterThan(0)
    expect(log.filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(JSON.stringify(log.find(event => event.type === 'user/message'))).toContain('parity.txt')
    expect(readFileSync(agentLog, 'utf8')).toContain('parity.txt')
    expect(readFileSync(agentLog, 'utf8')).toContain('regression file-bytes=E2E_UPLOAD_BYTES')
    await page.reload()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByText('parity.txt', { exact: true }).first().waitFor()
    const activity = page.locator('[data-acp-activity]')
    await activity.waitFor()
    await activity.getByText('echo E2E_TOOL_OUTPUT', { exact: true }).first().click()
    await activity.locator('[data-terminal]').getByText('E2E_TOOL_OUTPUT', { exact: true }).first().waitFor()
    expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(1)
  })

  it('keeps the streamed answer tail visible through native viewport resizing', async () => {
    const { settled } = await send('E2E_SCROLL')
    await settled
    const tail = page.getByText('E2E_SCROLL_END', { exact: true })
    await tail.waitFor()
    const tailVisible = () => tail.evaluate(element => {
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
        ctx.effect(() => ctx.systemPrompt.section({ name: 'e2e-instructions', order: 0, text: () => `E2E_SYSTEM_${version}` }))
        ctx.effect(() => ctx.systemPrompt.context({ name: 'e2e-runtime', order: 0, text: () => `E2E_RUNTIME_${version}` }))
        ctx.on('agent/pre-step', async ({ messages }, next) => {
          const decision = await next()
          if (decision.kind !== 'enter' || !JSON.stringify(messages).includes('E2E_CONTEXT_')) return decision
          return { ...decision, messages: [...decision.messages, createUserMessage({
            source: { kind: 'plugin', plugin: 'e2e-host-contributions' },
            content: [{ type: 'text', text: 'E2E_PLUGIN_INPUT' }],
          })] }
        })
        ctx.on('agent/turn-stopping', ({ agent }) => {
          if (followupSent || !JSON.stringify(agent.session.snapshotEvents()).includes('E2E_CONTEXT_A')) return
          followupSent = true
          agent.send(createUserMessage({ source: { kind: 'plugin', plugin: 'e2e-host-contributions' }, content: [{ type: 'text', text: 'E2E_PLUGIN_FOLLOWUP' }] }), 'next-step', false)
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
      expect(events.filter(event => event.id === id && event.type === 'step/start')).toHaveLength(2)
      version = 'B'
      const second = await send('E2E_CONTEXT_B')
      await second.settled
      await page.getByText('E2E_CONTEXT_B_DONE', { exact: true }).waitFor()
      const handle = await host.ctx.sessionPersistence.open(id, 'read')
      try {
        const log = (await handle.read()).events
        expect(JSON.stringify(log.filter(event => event.type === 'system/message'))).toContain('E2E_SYSTEM_B')
        expect(JSON.stringify(log.filter(event => event.type === 'user/message'))).toContain('E2E_RUNTIME_B')
      } finally { await handle.close() }
      await page.reload()
      await page.getByText('E2E_FOLLOWUP_DONE', { exact: true }).waitFor()
    } finally { await contribution.dispose() }
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
      expect(log.find(event => event.type === 'assistant/message').data.message.content.some(block => block.type === 'image')).toBe(true)
      expect(log.some(event => event.type === 'tool/call')).toBe(false)
    } finally { await handle.close() }
    const picture = page.locator('[data-variant] img')
    await picture.first().waitFor()
    await expect.poll(() => picture.first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
    const activity = page.locator('[data-acp-activity]')
    await expect.poll(() => activity.count()).toBe(1)
    await activity.getByRole('button', { name: /^Read.*fixture\.txt/ }).click()
    await activity.locator('[data-read]').getByText('E2E_READ_LINE', { exact: true }).first().waitFor()
    await activity.getByRole('button', { name: /^Edited.*fixture\.txt/ }).click()
    await activity.locator('[data-diff]').getByText('E2E_NEW_LINE', { exact: true }).first().waitFor()
    await activity.locator('[data-acp-file]').first().press('Enter')
    const preview = page.locator('[data-rightbar-col] [data-textpreview-state="text"]')
    await preview.waitFor()
    await expect.poll(() => preview.locator('[data-textpreview-line="1"]').textContent()).toBe('E2E_SIDEBAR_FILE\n')
  })

  it('preserves visible history after a crash and requires explicit recovery before continuing', async () => {
    const first = await send('E2E_MESSAGE')
    await first.settled
    const failed = await send('E2E_CRASH', { expectError: true })
    await failed.settled
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).waitFor()
    await page.reload()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Resolve recovery issue', exact: true }).click()
    await page.getByRole('button', { name: 'Abandon context and continue', exact: true }).click()
    const next = await send('E2E_RECOVERED')
    await next.settled
    await page.getByText('E2E_RECOVERED_DONE', { exact: true }).waitFor()
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(readFileSync(agentLog, 'utf8').split('regression prompt=').at(-1)).not.toContain('E2E_CRASH')
  })

  it.each([false, true])('maps native permission decisions without changing their scope: allow=%s', async allow => {
    const { settled } = await send('E2E_PERMISSION')
    expect(existsSync(join(workspace, 'approval-marker.txt'))).toBe(false)
    await decide(allow)
    await settled
    await page.getByText(allow ? 'E2E_APPROVED' : 'E2E_DENIED', { exact: true }).waitFor()
    expect(existsSync(join(workspace, 'approval-marker.txt'))).toBe(allow)
    expect(readFileSync(agentLog, 'utf8')).toContain(`"optionId":"${allow ? 'permit-single' : 'deny-single'}"`)
    expect(await page.locator('[data-question-key], [data-approval-key]').count()).toBe(0)
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

  it('recovers the native connection without reloading or duplicating ACP history', async () => {
    const first = await send('E2E_MESSAGE')
    await first.settled
    const priorPrompts = readFileSync(agentLog, 'utf8').split('regression prompt=').length
    try {
      await page.context().setOffline(true)
      await page.getByRole('button', { name: 'Disconnected, reconnect now', exact: true }).waitFor()
    } finally { await page.context().setOffline(false) }
    await page.getByRole('button', { name: /Disconnected, reconnect now|Reconnecting automatically, reconnect now/ }).waitFor({ state: 'hidden' })
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
    const received = Promise.withResolvers()
    const release = Promise.withResolvers()
    await page.route('**/api/session/prompt', async route => {
      received.resolve()
      await release.promise
      await route.continue()
    }, { times: 1 })
    try {
      const input = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, input, 'E2E_QUEUED')
      await input.press('Enter')
      await received.promise
      const pending = page.locator('[data-queue-dock] [data-submission-echo]')
      await pending.getByRole('status').waitFor()
      expect(await pending.getByRole('status').textContent()).toBe('Sending…')
      expect(await pending.getByRole('button').count()).toBe(3)
      expect(await pending.getByRole('button').evaluateAll(buttons => buttons.every(button => button.disabled))).toBe(true)
    } finally { release.resolve() }
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
    await expect.poll(async () => (await host.ctx.sessionPersistence.list()).filter(item => item.header.origin === 'subagent').length).toBe(supported ? 1 : 0)
    if (!supported) return
    const child = (await host.ctx.sessionPersistence.list()).find(item => item.header.origin === 'subagent')
    const handle = await host.ctx.sessionPersistence.open(child.header.id, 'read')
    try {
      const log = await handle.read()
      expect(handle.header.version).toBe(3)
      expect(log.events.map(event => event.type)).toEqual([
        'subagent/descriptor', 'turn/start', 'step/start', 'user/message',
        'assistant/message', 'step/end', 'turn/end',
      ])
    } finally { await handle.close() }
    await page.getByRole('button', { name: '1 subagent', exact: true }).press('ArrowDown')
    await page.getByRole('treeitem', { name: /^Inspect fixture/ }).click()
    await page.getByText('E2E_CHILD_RESULT', { exact: profile === 'claude' }).waitFor()
    await page.getByText('One-shot subagent record', { exact: true }).waitFor()
    expect(await page.locator('[data-composer-input][contenteditable="true"]:visible').count()).toBe(0)
    await page.reload()
    await page.getByText('E2E_CHILD_RESULT', { exact: profile === 'claude' }).waitFor()
    await page.getByText('One-shot subagent record', { exact: true }).waitFor()
  })

  it('keeps a native provider usable beside ACP without dispatching another ACP prompt', async () => {
    const promptCount = () => existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('regression prompt=').length - 1 : 0
    const before = promptCount()
    const calls = []
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
      expect(observed).toContain('native-control')
      expect(calls).toEqual(['pre', 'post'])
      expect(promptCount()).toBe(before)
    } finally { disposePost(); disposePre() }
  })
})
