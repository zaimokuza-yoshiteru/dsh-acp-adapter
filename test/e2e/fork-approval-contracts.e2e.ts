/** Built adapter + published Loader/browser; scripted ACP inference with observable effects. */
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

const before = process.env.DSH_E2E_FORK_APPROVAL_BASELINE === '1'
const directory = join(root, '.local/fork-approval-fix-20261021', before ? 'before' : 'after')
const adapterDirectory = process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root
mkdirSync(directory, { recursive: true })

class NativeParent extends LlmAdapter {
  providerInfo(id: string) {
    return { id, name: 'Native parent control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(): ReturnType<LlmAdapter['stream']> {
    const text = 'NATIVE_PARENT_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(supportsFork = false) {
  const host = await launchAdapterWorld({ adapterDirectory, toolsMode: 'native' })
  const log = join(host.workspaceCwd, 'fork-approval-wire.log')
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        contract: {
          name: 'Fork and approval contract',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_ADVERTISE_FORK: supportsFork ? '1' : '0',
            MOCK_LOG: log,
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-contract')).toBe(true))
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['contract-native'], new NativeParent()))
    const wire = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    const save = (name: string, details: unknown) =>
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify({ baseline: before, details, wire: wire() }, null, 2),
      )
    return { ...host, wire, save }
  } catch (error) {
    await host.close()
    throw error
  }
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
async function complete(agent: Agent, turns = 0) {
  await vi.waitFor(
    () => expect(agent.session.snapshotEvents().filter((e) => e.type === 'turn/end').length).toBeGreaterThan(turns),
    { timeout: 30_000 },
  )
  await agent.whenIdle()
  return required(agent.session.snapshotEvents().findLast((e) => e.type === 'turn/end')).data.reason.kind
}
async function create(host: AdapterWorld, provider: string) {
  await host.ctx.agentDefaultModel.saveSelection({
    provider,
    model: provider === 'contract-native' ? 'fixture' : 'mock-model-a',
  })
  const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
  const value = await host.ctx.sessionController.resolveAgent(sessionId)
  if ('error' in value) throw value.error
  return value.agent
}

it.each([false, true])(
  'ordinary native fork preserves truthful ACP dispatch (advertised fork: %s)',
  async (supportsFork) => {
    const host = await fixture(supportsFork)
    try {
      const parent = await create(host, 'acp-contract')
      send(parent, 'E2E_MESSAGE')
      await complete(parent)
      const wireBefore = host
        .wire()
        .split('\n')
        .filter((line) => /--> session\/(?:new|fork|prompt) /.test(line))
      const forked = await host.ctx.sessionController.fork({ sessionId: parent.id })
      const child = required(host.ctx.agents.get(forked.sessionId))
      expect(child.session.inheritedEventCount).toBeGreaterThan(0)
      const inheritedTurns = child.session.snapshotEvents().filter((e) => e.type === 'turn/end').length
      send(child, 'FORK_CHILD_CONTINUATION')
      const reason = await complete(child, inheritedTurns)
      const delta = host
        .wire()
        .split('\n')
        .filter((line) => /--> session\/(?:new|fork|prompt) /.test(line))
        .slice(wireBefore.length)
      host.save(`fork-${supportsFork}`, {
        reason,
        delta,
        inheritedEvents: child.session.inheritedEventCount,
        childRecordCreated: true,
        events: child.session.snapshotEvents(),
      })
      if (supportsFork) {
        // This fixture has process-local history: a newly launched fork connection
        // advertises support but rejects the source id. Never turn that into new.
        expect(reason).toBe('error')
        expect(delta.filter((line) => line.includes('session/fork'))).toHaveLength(1)
        expect(delta.filter((line) => line.includes('session/new'))).toHaveLength(0)
        expect(JSON.stringify(child.session.snapshotEvents())).toContain('ACP_FORK_FAILED')
      } else if (before) {
        expect(reason).toBe('completed')
        expect(delta.filter((line) => line.includes('session/new'))).toHaveLength(1)
        expect(delta.filter((line) => line.includes('session/prompt'))).toHaveLength(1)
      } else {
        expect(reason).toBe('error')
        expect(delta).toEqual([])
        expect(JSON.stringify(child.session.snapshotEvents())).toContain('ACP_FORK_UNAVAILABLE')
      }
    } finally {
      await host.close()
    }
  },
)

it.each(['native', 'acp'])(
  'aggregates ordinary ACP child approvals with Teams off under a %s parent',
  async (parentKind) => {
    const host = await fixture()
    let browser: TestBrowser | undefined
    let activation: SubagentActivation | undefined
    let child: Agent | undefined
    try {
      await host.ctx.agentDefaultModel.saveSelection({
        provider: parentKind === 'native' ? 'contract-native' : 'acp-contract',
        model: parentKind === 'native' ? 'fixture' : 'mock-model-a',
      })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(10_000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
      const settled = host.whenTurnSettled(30_000)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const parent = required(host.ctx.agents.get(await settled))
      expect(host.ctx.get('agentTeams', false)).toBeUndefined()
      host.ctx.on('subagent/start', (entry) => {
        child = host.ctx.agents.get(entry.id)
      })
      activation = await host.ctx.subagents.startActivation({
        provider: 'spawn',
        label: 'Approval review worker',
        delivery: 'caller',
        request: {
          parent,
          prompt: [{ type: 'text', text: 'E2E_PERMISSION' }],
          agentOptions: { provider: 'acp-contract', model: 'mock-model-a' },
        },
        signal: new AbortController().signal,
      })
      await vi.waitFor(() => expect(acpPermissionAudit(host, 'asked')).toHaveLength(1), { timeout: 30_000 })
      const owner = required(child)
      expect(host.ctx.approval.overrideOf(owner.session)).toBe('never')
      const markerPath = join(required(owner.session.header.cwd), 'approval-marker.txt')
      expect(existsSync(markerPath)).toBe(false)
      const card = page.locator('[data-acp-team-approvals]')
      if (before) {
        // Native status has the live child request, but the old Team-only parent entry is absent.
        expect(await card.count()).toBe(0)
        await page.screenshot({ path: join(directory, `managed-${parentKind}.png`) })
        host.save(`managed-${parentKind}`, {
          visibleParentCards: 0,
          asked: acpPermissionAudit(host, 'asked'),
          childPolicy: host.ctx.approval.overrideOf(owner.session),
        })
        owner.cancel({ kind: 'user' })
        await activation.result
      } else {
        await card
          .getByRole('button', { name: 'Allow once', exact: true })
          .waitFor({ state: 'visible', timeout: 30_000 })
        await page.reload()
        await card.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'visible' })
        expect(await card.getByRole('button', { name: 'Allow all', exact: true }).count()).toBe(0)
        expect(await card.getByRole('button', { name: 'Reject all', exact: true }).count()).toBe(0)
        for (const theme of ['light', 'dark']) {
          await host.ctx.settings.replace('ui-theme', { preference: theme })
          await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
          await page.setViewportSize({ width: 390, height: 844 })
          // Native responsive layout reacts after the viewport event; assert its settled geometry.
          await expect.poll(() => card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
          await page.screenshot({ path: join(directory, `managed-${parentKind}-${theme}-390.png`) })
          const geometry = await card.evaluate((el) => ({
            width: el.clientWidth,
            scroll: el.scrollWidth,
            overflows: [...el.querySelectorAll('*')]
              .filter((node) => node.scrollWidth > node.clientWidth)
              .map((node) => ({
                tag: node.tagName,
                text: node.textContent,
                width: node.clientWidth,
                scroll: node.scrollWidth,
              })),
          }))
          host.save(`managed-${parentKind}-${theme}-geometry`, geometry)
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.width)
        }
        await card.getByRole('button', { name: 'Allow once', exact: true }).click()
        expect((await activation.result).stopReason).toBe('completed')
        expect(readFileSync(markerPath, 'utf8')).toBe('E2E_APPROVED')
        expect(host.ctx.approval.overrideOf(owner.session)).toBe('never')
        expect(acpPermissionAudit(host, 'decided')).toHaveLength(1)
        expect(acpPermissionAudit(host, 'decided')[0]?.sessionId).toBe(owner.id)
        await expect.poll(() => card.count()).toBe(0)
        host.save(`managed-${parentKind}`, {
          asked: acpPermissionAudit(host, 'asked'),
          decided: acpPermissionAudit(host, 'decided'),
          childPolicy: host.ctx.approval.overrideOf(owner.session),
          effect: readFileSync(markerPath, 'utf8'),
        })
      }
    } finally {
      child?.cancel({ kind: 'user' })
      await activation?.dispose()
      await browser?.close()
      await host.close()
    }
  },
)

it('preserves exact ACP authorization choices through the native question surface', async () => {
  const host = await fixture()
  let browser: TestBrowser | undefined
  try {
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-contract', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_EXACT_PERMISSION_OPTIONS')
    const settled = host.whenTurnSettled(30_000)
    void settled.catch(() => undefined)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    if (before) {
      const approval = page.locator('[data-approval-key]')
      await approval.getByRole('button', { name: 'Allow once', exact: true }).waitFor()
      expect(await page.getByRole('radio', { name: 'Allow for this Agent session', exact: true }).count()).toBe(0)
      await page.screenshot({ path: join(directory, 'permission-options.png') })
      await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
    } else {
      const card = page.locator('section[data-question-key]')
      const option = card.getByRole('radio', { name: 'Allow for this Agent session', exact: true })
      await option.waitFor()
      expect(await card.getByRole('radio').count()).toBe(4)
      expect(existsSync(join(host.workspaceCwd, 'workspace', 'exact-option.txt'))).toBe(false)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: join(directory, 'permission-options.png') })
      await option.click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
    }
    await settled
    const effect = readFileSync(join(host.workspaceCwd, 'workspace', 'exact-option.txt'), 'utf8')
    expect(effect).toBe(before ? 'allow-turn' : 'allow-session')
    const decisions = acpPermissionAudit(host, 'decided')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data.selectedOptionKind).toBe(before ? 'allow_once' : 'allow_always')
    host.save('permission-options', { effect, decisions })
  } finally {
    host.save('permission-options-final', {
      decisions: acpPermissionAudit(host, 'decided'),
      events: host.ctx.agents.list().flatMap((a) => a.session.snapshotEvents().filter((e) => e.type === 'turn/end')),
    })
    await browser?.close()
    await host.close()
  }
})

it('presents full child authorization choices at the root without using binary approval', async () => {
  const host = await fixture()
  let activation: SubagentActivation | undefined
  let browser: TestBrowser | undefined
  const errors: { sessionId: string; message: string }[] = []
  let simpleApprovalCount = 0
  try {
    host.ctx.on('api-session/error', (sessionId, message) => {
      errors.push({ sessionId, message })
    })
    host.ctx.on(
      'approval/request',
      async () => {
        simpleApprovalCount++
        return 'allowed-once'
      },
      { prepend: true },
    )
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'contract-native', model: 'fixture' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Prepare managed child')
    const settled = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const parent = required(host.ctx.agents.get(await settled))
    const marker = join(required(parent.session.header.cwd), 'exact-option.txt')
    activation = await host.ctx.subagents.startActivation({
      provider: 'spawn',
      label: 'Full scope child',
      delivery: 'caller',
      request: {
        parent,
        prompt: [{ type: 'text', text: 'E2E_EXACT_PERMISSION_OPTIONS' }],
        agentOptions: { provider: 'acp-contract', model: 'mock-model-a' },
      },
      signal: new AbortController().signal,
    })
    if (!before) {
      const card = page.locator('section[data-question-key]')
      const option = card.getByRole('radio', { name: 'Allow for this Agent session', exact: true })
      await option.waitFor({ state: 'visible' })
      expect(await card.getByRole('radio').count()).toBe(4)
      expect(existsSync(marker)).toBe(false)
      await page.screenshot({ path: join(directory, 'child-options-presented.png') })
      await option.click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
    }
    await activation.result
    const decisions = acpPermissionAudit(host, 'decided')
    host.save('child-options-boundary', {
      simpleApprovalCount,
      errors,
      decisions,
      markerWritten: existsSync(marker),
    })
    expect(decisions).toHaveLength(1)
    if (before) {
      expect(simpleApprovalCount).toBe(1)
      expect(readFileSync(marker, 'utf8')).toBe('allow-turn')
      expect(errors).toEqual([])
    } else {
      expect(simpleApprovalCount).toBe(0)
      expect(readFileSync(marker, 'utf8')).toBe('allow-session')
      expect(decisions[0]?.data).toMatchObject({
        outcome: 'selected',
        optionId: 'allow-session',
        selectedOptionKind: 'allow_always',
      })
      expect(errors).toEqual([])
    }
  } finally {
    await activation?.dispose()
    await browser?.close()
    await host.close()
  }
})
