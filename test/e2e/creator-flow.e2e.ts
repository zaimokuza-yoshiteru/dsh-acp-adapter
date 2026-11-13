import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import {
  CREATOR_BUNDLE,
  CREATOR_PLAN,
  CREATOR_TOOL,
  type CreatorPlan,
  type CreatorRecord,
} from '../mock-agent/creator-turn.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

/** A dependency-free disposable bundle uses the same public Host registration as an authored plugin. */
function writeFixture(directory: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: CREATOR_BUNDLE,
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'Disposable creator-flow regression tool',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  writeFileSync(
    join(directory, 'cordis.patch.yml'),
    JSON.stringify([{ insert: [{ id: 'acp-creator-fixture', name: CREATOR_BUNDLE }] }]),
  )
  // No dependencies or install scripts; this test-only inventory row intentionally has no display assets.
  writeFileSync(
    join(directory, 'index.js'),
    `
export const inject = ['tools'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: '${CREATOR_TOOL}', description: 'Return creator fixture evidence',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'E2E_CREATOR_CAPABILITY_OK',
  }));
}
`,
  )
}

it('keeps native Creator mode usable through ACP while installing, toggling and restoring a real local tool bundle', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const errors: string[] = []
  const evidence = join(root, '.local/e2e-creator-flow')
  mkdirSync(evidence, { recursive: true })
  const results = join(host.workspaceCwd, 'creator-results.jsonl')
  const agentLog = join(host.workspaceCwd, 'creator-agent.log')
  const fixture = join(host.workspaceCwd, 'creator-fixture')
  writeFixture(fixture)
  const records = (label: string): CreatorRecord[] =>
    (existsSync(results) ? readFileSync(results, 'utf8').trim().split('\n').filter(Boolean) : [])
      .map((line) => JSON.parse(line) as CreatorRecord)
      .filter((record) => record.label === label)
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        codex: {
          name: 'Creator fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          runtime: 'codex',
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_CREATOR_RESULTS: results,
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    const routed = () => host.ctx.llm.listProviders().some((item) => item.id === 'acp-codex')
    await vi.waitFor(() => expect(routed()).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const standardId = await page
      .locator('[data-conversation-session]')
      .last()
      .getAttribute('data-conversation-session')
    if (standardId === null) throw new Error('Standard blank session is missing')
    const draft = 'Keep this unsent plugin idea.'
    await writeComposerDraft(
      page,
      page.locator(`[data-conversation-session="${standardId}"] [data-composer-input]`),
      draft,
    )
    await page
      .getByRole('navigation', { name: 'Global panels' })
      .getByRole('button', { name: 'Plugins', exact: true })
      .click()
    await page.getByRole('button', { name: 'Choose how to add a plugin', exact: true }).click()
    const [creation] = await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('menuitem', { name: /^Let the agent create a plugin/ }).click(),
    ])
    expect(creation.request().postDataJSON()).toHaveProperty('payload.args.request.agentPreset', 'cordis')
    expect(creation.request().postDataJSON()).not.toHaveProperty('payload.args.request.sessionId')
    const created = (await creation.json()) as {
      result: { ok: boolean; value: { sessionId: string; agentPreset: string } }
    }
    expect(created).toMatchObject({ result: { ok: true, value: { agentPreset: 'cordis' } } })
    const owner = created.result.value.sessionId
    expect(owner).not.toBe(standardId)
    const conversation = page.locator(`[data-conversation-session="${owner}"]`)
    const composer = conversation.locator('[data-composer-input][contenteditable="true"]')
    await composer.waitFor()
    expect((await composer.innerText()).trim()).toBe('')
    await page.getByRole('button', { name: 'Creator mode', exact: true }).waitFor()
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    const run = async (plan: CreatorPlan) => {
      const settled = host.whenTurnSettled()
      void settled.catch(() => undefined)
      await writeComposerDraft(page, composer, `${CREATOR_PLAN}${JSON.stringify(plan)}`)
      await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
      if (plan.calls.some((call) => call.name === 'plugin_manager')) {
        // Approve this exact native escalation in the isolated UI; never mutate the session's permission mode.
        const approval = page.getByRole('button', { name: 'Allow once', exact: true }).last()
        const ready = await Promise.race([
          settled.then(() => 'settled' as const),
          approval.waitFor({ state: 'visible' }).then(() => 'approval' as const),
        ])
        if (ready === 'approval') await approval.click()
      }
      const id = await settled
      expect(id).toBe(owner)
      expect(records(plan.label).filter((row) => row.kind === 'failure')).toEqual([])
      expect(records(plan.label).filter((row) => row.kind === 'complete')).toHaveLength(1)
      await page.getByText(`E2E_CREATOR_DONE ${plan.label}`, { exact: true }).waitFor()
      return records(plan.label)
    }
    const initial = await run({
      label: 'official-skill',
      fixtureAvailable: false,
      calls: [{ name: 'skill', arguments: { name: 'dsh-doc' } }, { name: 'cordis_inspect_list' }],
    })
    const initialRemote = initial[0]!.sessionId
    const skill = initial.find((row) => row.kind === 'call' && row.name === 'skill')?.text
    const skillDirectory = skill?.match(/Base directory for this skill: ([^\n]+)/)?.[1]
    if (skillDirectory === undefined) throw new Error('Official skill did not identify its resource directory')
    await run({
      label: 'plugin-reference',
      fixtureAvailable: false,
      calls: [{ name: 'read', arguments: { file_path: join(skillDirectory, 'references/plugin-development.md') } }],
    })
    await run({
      label: 'install',
      fixtureAvailable: false,
      calls: [{ name: 'plugin_manager', arguments: { action: 'install_bundle', target: fixture } }],
    })
    expect((await host.ctx.pluginManager.listBundles()).find((row) => row.name === CREATOR_BUNDLE)).toMatchObject({
      enabled: true,
    })
    await run({ label: 'installed-call', fixtureAvailable: true, calls: [{ name: CREATOR_TOOL }] })
    await run({
      label: 'disable',
      fixtureAvailable: true,
      calls: [{ name: 'plugin_manager', arguments: { action: 'set_bundle', target: CREATOR_BUNDLE, enabled: false } }],
    })
    await run({ label: 'disabled-directory', fixtureAvailable: false, calls: [] })
    await run({
      label: 'enable',
      fixtureAvailable: false,
      calls: [{ name: 'plugin_manager', arguments: { action: 'set_bundle', target: CREATOR_BUNDLE, enabled: true } }],
    })
    await run({ label: 'enabled-call', fixtureAvailable: true, calls: [{ name: CREATOR_TOOL }] })
    const entry = (await host.ctx.pluginManager.listPlugins()).find(
      (row) => row.moduleName === '@zaimokuza/dsh-acp-adapter',
    )
    if (entry === undefined) throw new Error('ACP plugin entry missing')
    expect(await host.ctx.pluginManager.setPluginEnabled(entry.entryId, false)).toMatchObject({
      application: 'applied',
    })
    await vi.waitFor(() => expect(routed()).toBe(false))
    expect(await host.ctx.pluginManager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(routed()).toBe(true))
    const resumed = await run({ label: 'restored-call', fixtureAvailable: true, calls: [{ name: CREATOR_TOOL }] })
    expect(resumed[0]!.sessionId).toBe(initialRemote)
    expect(readFileSync(agentLog, 'utf8')).toContain(`session/load ${initialRemote}`)
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    expect(errors).toEqual([])
    await page.screenshot({ path: join(evidence, 'creator-restored.png') })
    const [reopening] = await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click(),
    ])
    expect(await reopening.json()).toMatchObject({
      result: { ok: true, value: { sessionId: standardId, agentPreset: 'standard' } },
    })
    const previousComposer = page.locator(`[data-conversation-session="${standardId}"] [data-composer-input]`)
    await previousComposer.filter({ hasText: draft }).waitFor()
    expect(await previousComposer.innerText()).toBe(draft)
  } finally {
    if (existsSync(results)) writeFileSync(join(evidence, 'results.jsonl'), readFileSync(results))
    await browser?.close()
    await host.close()
  }
}, 120_000)
