/** Public package + published Host + real ACP subprocess; no model credentials. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '../../src/host/composition/external-permission-policy.ts'
import type { AcpExternalPolicyRequest } from '../../src/contract/permission-policy.ts'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { PARENT_PERMISSION_OPTIONS, parentPermissionMarker } from '../mock-agent/parent-permission-options-turn.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

class NativeParent extends LlmAdapter {
  providerInfo(id: string) {
    return { id, name: 'Permission policy native control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(request: GenerateOptions): ReturnType<LlmAdapter['stream']> {
    if (JSON.stringify(request.messages).includes('HOLD_POLICY_NATIVE_PARENT')) {
      const signal = required(request.signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const text = 'POLICY_NATIVE_PARENT_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const host = await launchAdapterWorld({ toolsMode: 'native' })
  const browser = await launchBrowser({ headless: true })
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(15_000)
  const activations: SubagentActivation[] = []
  const children: Agent[] = []
  const errors: string[] = []
  const policyErrors: { sessionId: string; message: string }[] = []
  const log = join(host.workspaceCwd, 'permission-policy-wire.log')
  const directory = join(root, '.local/issue69-policy-e2e', randomUUID())
  mkdirSync(directory, { recursive: true })
  page.on('pageerror', (error) => errors.push(error.message))
  host.ctx.on('api-session/error', (sessionId, message) => policyErrors.push({ sessionId, message }))
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      for (const child of [...children].reverse()) child.cancel({ kind: 'user' })
      const outcomes = await Promise.allSettled([...activations].reverse().map((entry) => entry.dispose()))
      try {
        await browser.close()
      } finally {
        await host.close()
      }
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })())
  try {
    await host.ctx.settings.replace('locale', { preference: 'en' })
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        'policy-fixture': {
          name: 'External policy fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          // The remote fixture speaks seven-choice ACP. No trusted Devin runtime
          // is configured: that separately tested enterprise boundary must stay manual.
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_LOG: log },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-policy-fixture')).toBe(true)
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['policy-native'], new NativeParent()))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'policy-native', model: 'fixture' })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Prepare the policy workspace.')
    const ready = host.whenTurnSettled(30_000)
    void ready.catch(() => undefined)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const parent = required(host.ctx.agents.get(await ready))
    const url = page.url()
    const requireAdapter = createRequire(join(root, 'package.json'))
    const policyEntry = requireAdapter.resolve('@zaimokuza/dsh-acp-adapter/permission-policy')
    const { default: Policy } = await host.ctx.loader.import(pathToFileURL(policyEntry).href)
    expect(host.ctx.get('acpPermissionPolicy')).toBeUndefined()
    await host.ctx.plugin(Policy)
    expect(host.ctx.get('acpPermissionPolicy')).toBeDefined()
    const spawn = async (key: string, owner = parent, native = false) => {
      const activation = await host.ctx.subagents.startActivation({
        provider: 'spawn',
        label: `Policy worker ${key}`,
        delivery: 'caller',
        request: {
          parent: owner,
          prompt: [
            { type: 'text', text: native ? 'HOLD_POLICY_NATIVE_PARENT' : `E2E_PARENT_PERMISSION_OPTIONS:${key}` },
          ],
          agentOptions: {
            provider: native ? 'policy-native' : 'acp-policy-fixture',
            model: native ? 'fixture' : 'mock-model-a',
          },
        },
        signal: new AbortController().signal,
      })
      activations.push(activation)
      const child = required(host.ctx.agents.get(activation.childId))
      children.push(child)
      return { activation, child }
    }
    const effects = (key: string): unknown[] => {
      const path = join(required(parent.session.header.cwd), parentPermissionMarker(key))
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
    }
    const card = (key: string) =>
      page.locator('section[data-question-key]').filter({ hasText: parentPermissionMarker(key) })
    const save = async (name: string, facts: unknown) => {
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true })
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify(
          {
            policyEntry,
            viewport: page.viewportSize(),
            parentId: parent.id,
            facts,
            children: children.map((child) => ({
              id: child.id,
              parentId: child.session.header.parentSession,
              nativePolicy: host.ctx.approval.overrideOf(child.session),
            })),
            asked: acpPermissionAudit(host, 'asked'),
            decided: acpPermissionAudit(host, 'decided'),
            wire: existsSync(log) ? readFileSync(log, 'utf8') : '',
            errors,
            policyErrors,
          },
          null,
          2,
        ),
      )
    }
    return { ...host, page, parent, url, spawn, effects, card, save, close, errors, policyErrors }
  } catch (error) {
    await close()
    throw error
  }
}

type World = Awaited<ReturnType<typeof fixture>>

function assertAudit(world: World, child: Agent, key: string, decision: Record<string, unknown>) {
  const asked = acpPermissionAudit(world, 'asked').filter((entry) => entry.sessionId === child.id)
  const decided = acpPermissionAudit(world, 'decided').filter((entry) => entry.sessionId === child.id)
  expect(asked).toHaveLength(1)
  expect(decided).toHaveLength(1)
  expect(asked[0]?.data.toolCall.toolCallId).toBe(`parent-scope-${key}`)
  expect(decided[0]?.data).toMatchObject({
    requestId: asked[0]?.data.requestId,
    toolCallId: `parent-scope-${key}`,
    ...decision,
  })
}

it('isolates concurrent machine decisions while preserving the original full parent choice across refresh', async (context) => {
  const world = await fixture()
  const calls: { agentId: string; requestId: string; callId: string | undefined }[] = []
  let legacyCalls = 0
  const releaseConcurrent = Promise.withResolvers<void>()
  context.onTestFinished(async () => {
    releaseConcurrent.resolve()
    await world.close()
  })
  world.ctx.on(
    'approval/request',
    async () => {
      legacyCalls++
      return 'allowed-once'
    },
    { prepend: true },
  )
  world.ctx.on('dsh-acp/permission-policy', async (request, next) => {
    const callId = request.params.toolCall.toolCallId
    calls.push({ agentId: request.agent.id, requestId: request.requestId, callId })
    if (callId?.startsWith('parent-scope-machine-')) await releaseConcurrent.promise
    if (callId === 'parent-scope-machine-allow') return 'allow-once'
    if (callId === 'parent-scope-machine-deny') return 'deny-once'
    if (callId === 'parent-scope-machine-failed') throw new Error('Controlled policy backend failure')
    return next()
  })
  try {
    const allow = await world.spawn('machine-allow')
    const deny = await world.spawn('machine-deny')
    const failed = await world.spawn('machine-failed')
    const manual = await world.spawn('manual')
    await expect.poll(() => calls.length).toBe(4)
    expect(world.effects('machine-allow')).toEqual([])
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(0)
    releaseConcurrent.resolve()
    await Promise.all([allow.activation.result, deny.activation.result, failed.activation.result])
    expect(world.effects('machine-allow')).toEqual([
      {
        key: 'machine-allow',
        sessionId: required(acpPermissionAudit(world, 'asked').find((row) => row.sessionId === allow.child.id)).data
          .agentSessionId,
        optionId: 'allow_once',
      },
    ])
    expect(world.effects('machine-deny')).toEqual([])
    expect(world.effects('machine-failed')).toEqual([])
    assertAudit(world, allow.child, 'machine-allow', {
      outcome: 'selected',
      optionId: 'allow_once',
      decisionVia: 'external-policy',
    })
    assertAudit(world, deny.child, 'machine-deny', {
      outcome: 'selected',
      optionId: 'reject_once',
      decisionVia: 'external-policy',
    })
    assertAudit(world, failed.child, 'machine-failed', { outcome: 'cancelled', decisionVia: 'external-policy' })
    expect(
      world.policyErrors.filter((entry) => entry.sessionId === failed.child.id).map((entry) => entry.message),
    ).toEqual([expect.stringContaining('(ACP_PERMISSION_POLICY_UNAVAILABLE)')])
    const card = world.card('manual')
    await card.getByRole('radio', { name: 'Allow', exact: true }).waitFor()
    expect(await card.getByRole('radio').count()).toBe(PARENT_PERMISSION_OPTIONS.length)
    expect(await card.locator('[data-question-source]').innerText()).toContain(manual.child.id.slice(0, 8))
    expect(world.effects('manual')).toEqual([])
    await world.save('manual-pending-wide', { calls, legacyCalls })
    await world.page.reload()
    await card.getByRole('radio', { name: 'Reject', exact: true }).waitFor()
    for (const option of PARENT_PERMISSION_OPTIONS)
      expect(await card.getByRole('radio', { name: option.name, exact: true }).count()).toBe(1)
    expect(acpPermissionAudit(world, 'asked')).toHaveLength(4)
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(3)
    await world.save('manual-refreshed-wide', { calls, legacyCalls })
    const manualOption = required(PARENT_PERMISSION_OPTIONS.find((option) => option.optionId === 'allow_session'))
    await card.getByRole('radio', { name: manualOption.name, exact: true }).click()
    await card.getByRole('button', { name: 'Submit', exact: true }).click()
    await manual.activation.result
    assertAudit(world, manual.child, 'manual', {
      outcome: 'selected',
      optionId: 'allow_session',
      decisionVia: 'native-question',
    })
    expect(world.effects('manual')).toHaveLength(1)
    expect(calls).toHaveLength(4)
    expect(new Set(calls.map((entry) => entry.requestId)).size).toBe(4)
    expect(new Set(calls.map((entry) => entry.agentId))).toEqual(
      new Set([allow.child.id, deny.child.id, failed.child.id, manual.child.id]),
    )
    expect(legacyCalls).toBe(0)
    for (const child of [allow.child, deny.child, failed.child, manual.child])
      expect(world.ctx.approval.overrideOf(child.session)).toBe('never')
    expect(world.page.url()).toBe(world.url)
    expect(world.errors).toEqual([])
    await world.save('concurrent-completed-wide', { calls, legacyCalls })
  } finally {
    releaseConcurrent.resolve()
    await world.close()
  }
})

it('cancels a nested child policy and ignores its late allow without changing execution identity', async (context) => {
  const world = await fixture()
  const entered = Promise.withResolvers<AcpExternalPolicyRequest>()
  const release = Promise.withResolvers<void>()
  const callbackReturned = Promise.withResolvers<void>()
  context.onTestFinished(async () => {
    release.resolve()
    await world.close()
  })
  world.ctx.on('dsh-acp/permission-policy', async (request, next) => {
    if (request.params.toolCall.toolCallId !== 'parent-scope-nested-cancel') return next()
    entered.resolve(request)
    await release.promise
    callbackReturned.resolve()
    return 'allow-once'
  })
  try {
    const middle = await world.spawn('middle', world.parent, true)
    const leaf = await world.spawn('nested-cancel', middle.child)
    const request = await entered.promise
    expect(request.agent).toBe(leaf.child)
    expect(request.agent).not.toBe(middle.child)
    expect(world.ctx.agents.isOwnedBy(leaf.child.id, middle.child)).toBe(true)
    expect(world.ctx.agents.isOwnedBy(middle.child.id, world.parent)).toBe(true)
    expect(world.effects('nested-cancel')).toEqual([])
    await world.save('nested-policy-pending-wide', { requestId: request.requestId, policyAgentId: request.agent.id })
    leaf.child.cancel({ kind: 'user' })
    await expect.poll(() => request.signal?.aborted).toBe(true)
    await leaf.activation.result
    assertAudit(world, leaf.child, 'nested-cancel', { outcome: 'cancelled', decisionVia: 'external-policy' })
    release.resolve()
    await callbackReturned.promise
    expect(world.effects('nested-cancel')).toEqual([])
    expect(acpPermissionAudit(world, 'asked')).toHaveLength(1)
    expect(acpPermissionAudit(world, 'decided')).toHaveLength(1)
    expect(world.ctx.approval.overrideOf(leaf.child.session)).toBe('never')
    expect(world.ctx.approval.overrideOf(middle.child.session)).toBe('never')
    expect(world.errors).toEqual([])
    await world.save('nested-cancelled-wide', { requestId: request.requestId, policyAgentId: request.agent.id })
  } finally {
    release.resolve()
    await world.close()
  }
})
