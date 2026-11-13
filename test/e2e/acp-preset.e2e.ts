import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-compaction'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'

it('adds an optional ACP preset without replacing defaults or native compositions', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const evidence = join(root, '.local/e2e-acp-preset')
  mkdirSync(evidence, { recursive: true })
  try {
    const roster = await host.ctx.agentPresets.remoteExportList()
    for (const id of ['standard', 'ptc', 'minimal', 'cordis', 'acp-adapter']) {
      expect(roster.presets.find((row) => row.id === id)).toEqual(expect.objectContaining({ id }))
      expect(roster.presets.find((row) => row.id === id)?.broken).toBeUndefined()
    }
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    const composition = (await host.ctx.agentPresets.readDocument('acp-adapter')).content
    expect(composition).not.toMatch(/compaction|command-compact|tool-subagent|plugin-manager/)
    expect((await host.ctx.agentPresets.readDocument('standard')).content).toContain(
      '@deepseek-ai/dsh-compaction-basic',
    )
    expect((await host.ctx.agentPresets.readDocument('cordis')).content).toContain('@deepseek-ai/dsh-tool-cordis')
    const skill = join(host.workspaceCwd, '.agents/skills/acp-preset-fixture')
    // Give the fixture its own project root rather than inheriting the scaffold checkout's skill root.
    execFileSync('git', ['init', '-q', host.workspaceCwd])
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: acp-preset-fixture\ndescription: Verify the optional ACP preset.\n---\nACP_PRESET_SKILL_CONTENT\n',
    )
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Preset fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          runtime: 'codex',
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_LOG: join(evidence, 'agent.log'),
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-codex')).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const standardId = await page
      .locator('[data-conversation-session]')
      .first()
      .getAttribute('data-conversation-session')
    expect(standardId).not.toBeNull()
    const standard = host.ctx.agents.get(SessionId(standardId!))!
    expect(host.ctx.agentPresets.serviceFor(standard, 'compaction')).toBeDefined()
    const chooser = page.getByRole('button', { name: 'Standard mode', exact: true })
    await chooser.click()
    await page.getByRole('menuitem', { name: /^ACP\b/ }).click()
    await page.getByRole('button', { name: 'ACP', exact: true }).waitFor()
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.getByRole('button', { name: 'ACP', exact: true }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const bounds = await menu.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
      await page.screenshot({ path: join(evidence, `preset-390-${theme}.png`) })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const firstTurn = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_ACP_PRESET')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_ACP_PRESET_OK', { exact: true }).waitFor()
    const sessionId = await firstTurn
    const agent = host.ctx.agents.get(sessionId)!
    expect(host.ctx.agentPresets.presetForSession(agent.session)).toBe('acp-adapter')
    expect(host.ctx.agentPresets.serviceFor(agent, 'compaction')).toBeUndefined()
    await page.reload()
    await page.getByText('E2E_ACP_PRESET_OK', { exact: true }).waitFor()
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    const manager = host.ctx.pluginManager
    const entry = (await manager.listPlugins()).find((row) => row.moduleName === '@zaimokuza/dsh-acp-adapter')!
    expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
    expect((await host.ctx.agentPresets.list()).some((row) => row.id === 'acp-adapter')).toBe(false)
    expect(host.ctx.agentPresets.presetForSession(agent.session)).toBe('acp-adapter')
    expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
    expect((await host.ctx.agentPresets.resolve('acp-adapter')).broken).toBeUndefined()
    expect(await manager.setBundleEnabled('@zaimokuza/dsh-acp-adapter', false)).toMatchObject({
      application: 'applied',
    })
    expect((await host.ctx.agentPresets.list()).some((row) => row.id === 'acp-adapter')).toBe(false)
    expect(host.ctx.agentPresets.presetForSession(agent.session)).toBe('acp-adapter')
    expect(await manager.setBundleEnabled('@zaimokuza/dsh-acp-adapter', true)).toMatchObject({ application: 'applied' })
    expect((await host.ctx.agentPresets.resolve('acp-adapter')).broken).toBeUndefined()
    expect(host.ctx.agentPresets.defaultId).toBe('standard')
    const nextTurn = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_RECOVERY_FOLLOWUP')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_RECOVERY_FOLLOWUP_DONE', { exact: true }).waitFor()
    expect(await nextTurn).toBe(sessionId)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
  }
})
