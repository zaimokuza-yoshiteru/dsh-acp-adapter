import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.mjs'

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
    try { await browser?.close() } finally { await host?.close() }
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

  it('uses the native composer, attachment history, assistant stream and tool presentation across reload', async () => {
    await page.locator('input[type="file"]').setInputFiles({ name: 'parity.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E_UPLOAD_BYTES') })
    const { settled } = await send('E2E_MESSAGE')
    const id = await settled
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    expect(observed).toContain(provider)
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    let log
    try { log = await handle.read() } finally { await handle.close() }
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
        const log = await handle.read()
        expect(JSON.stringify(log.filter(event => event.type === 'request/header'))).toContain('E2E_SYSTEM_B')
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
    const { settled } = await send('E2E_RICH')
    const id = await settled
    await page.getByText('E2E_RICH_DONE', { exact: true }).waitFor()
    await page.reload()
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    try {
      const log = await handle.read()
      expect(log.find(event => event.type === 'assistant/message').data.message.content.some(block => block.type === 'image')).toBe(true)
      expect(log.some(event => event.type === 'tool/call')).toBe(false)
    } finally { await handle.close() }
    const picture = page.locator('[data-variant] img')
    await picture.first().waitFor()
    await expect.poll(() => picture.first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
    const activity = page.locator('[data-acp-activity]')
    await activity.getByRole('button', { name: /^Read.*fixture\.txt/ }).click()
    await activity.locator('[data-read]').getByText('E2E_READ_LINE', { exact: true }).first().waitFor()
    await activity.getByRole('button', { name: /^Edited.*fixture\.txt/ }).click()
    await activity.locator('[data-diff]').getByText('E2E_NEW_LINE', { exact: true }).first().waitFor()
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
