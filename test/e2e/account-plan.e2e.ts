import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import type { AcpAccountUsageView } from '../../src/contract/account-usage.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it('keeps plan panels scoped to each composer across edits, Agent switches and hot stop/start', async () => {
  const host = await launchAdapterWorld({ renderProbe: true })
  let browser: TestBrowser | undefined
  let restore: (() => void) | undefined
  const late = Promise.withResolvers<void>()
  try {
    // Direct local ACP launch makes these profiles eligible. The account RPC returns
    // synthetic plans, so this permanent regression uses no login or billing endpoint.
    const agent = join(root, 'test/mock-agent/mock-agent.ts')
    const command = join(host.workspaceCwd, process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp')
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`
        : `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(agent).href)})\n`,
      { mode: 0o755 },
    )
    const buddy = join(host.workspaceCwd, process.platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy')
    copyFileSync(command, buddy)
    const profile = { command, args: [], env: { HOME: host.workspaceCwd } }
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        alpha: { ...profile, name: 'Alpha' },
        beta: { ...profile, name: 'Beta' },
        buddy: { ...profile, name: 'CodeBuddy', command: buddy, args: ['--acp'] },
      },
    })
    const service = host.ctx.get('dshAcp') as AcpRemoteService
    for (const id of ['alpha', 'beta']) {
      await service.health({ agentId: id, recheck: true })
      expect((await host.ctx.llm.listModels(`acp-${id}`)).some((model) => model.id === 'mock-model-a')).toBe(true)
    }
    await service.health({ agentId: 'buddy', recheck: true })
    const buddyModel = required((await host.ctx.llm.listModels('acp-buddy'))[0]).id
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-alpha', model: 'mock-model-a' })
    const prototype: AcpRemoteService = Object.getPrototypeOf(service)
    const calls: string[] = []
    const read = vi.spyOn(prototype, 'accountUsage').mockImplementation(async (id): Promise<AcpAccountUsageView> => {
      calls.push(id)
      if (id === 'alpha' && calls.length === 1) await late.promise
      return {
        status: 'ready',
        provider: 'codex',
        checkedAt: 1,
        plan: id === 'alpha' ? 'Alpha trial' : 'Beta team',
        credits: null,
        windows: [{ key: 'primary', minutes: 300, remainingPercent: 72, resetsAt: null }],
      }
    })
    restore = () => read.mockRestore()
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const main = page.locator('[data-conversation-session]').first()
    const id = required(await main.getAttribute('data-conversation-session'))
    const trigger = main.getByRole('button', { name: 'View plan and quota' })
    const draft = main.locator('[data-composer-input]')
    const mainPanel = page.locator(`[role="region"][id^="dsh-acp-plan-${id}-"]`)
    await trigger.waitFor()
    expect(calls).toEqual([])
    await trigger.click()
    await vi.waitFor(() => expect(calls).toEqual(['alpha']))
    await host.ctx.sessionController.selectModel({
      sessionId: SessionId(id),
      provider: 'acp-beta',
      model: 'mock-model-a',
    })
    await mainPanel.getByText('Plan · Beta team').waitFor()
    late.resolve()
    expect(await mainPanel.innerText()).not.toContain('Alpha')
    await writeComposerDraft(page, draft, 'Keep this draft')
    await main.locator('[data-slot="conversation.input.model"] button').first().click()
    await page.keyboard.press('Escape')
    expect(await mainPanel.isVisible()).toBe(true)
    await page.evaluate(
      (cwd) => globalThis.__DSH_ACP_COMPOSER_PROBE__!.showCompanion(cwd, 'standard'),
      host.workspaceCwd,
    )
    const companion = page.locator('[data-test-companion]')
    const companionId = required(
      await companion.locator('[data-dsh-acp-plan-control]').getAttribute('data-dsh-acp-plan-control'),
    )
    await host.ctx.sessionController.selectModel({
      sessionId: SessionId(companionId),
      provider: 'acp-alpha',
      model: 'mock-model-a',
    })
    const secondTrigger = companion.getByRole('button', { name: 'View plan and quota' })
    await secondTrigger.click()
    const secondPanel = page.getByRole('region', { name: 'Plan and quota' }).filter({ hasText: 'Alpha trial' })
    await secondPanel.waitFor()
    await page.evaluate(() => globalThis.__DSH_ACP_COMPOSER_PROBE__!.shadowPermission(true))
    expect(await main.getByRole('button', { name: 'External permission control' }).count()).toBe(1)
    expect(await mainPanel.isVisible()).toBe(true)
    await secondPanel.getByRole('button', { name: 'Close plan details' }).click()
    expect(await secondTrigger.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await mainPanel.isVisible()).toBe(true)
    await page.evaluate(() => globalThis.__DSH_ACP_COMPOSER_PROBE__!.closeCompanion())
    const evidence = join(root, '.local/e2e-account-plan')
    mkdirSync(evidence, { recursive: true })
    await page.evaluate(() => globalThis.__DSH_ACP_COMPOSER_PROBE__!.shadowPermission(false))
    expect(await mainPanel.innerText()).not.toContain('Alpha trial')
    await page.screenshot({ path: join(evidence, 'composer-plan.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => {
        const box = await mainPanel.boundingBox()
        return box && box.x >= 0 && box.x + box.width <= 390
      })
      .toBe(true)
    await mainPanel.getByRole('button', { name: 'Close plan details' }).click()
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.press('Space')
    await expect
      .poll(() =>
        mainPanel.getByRole('button', { name: 'Close plan details' }).evaluate((el) => el === document.activeElement),
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const manager = host.ctx.pluginManager
    expect(await manager.setBundleEnabled('@zaimokuza/dsh-acp-adapter', false)).toMatchObject({
      application: 'applied',
    })
    await trigger.waitFor({ state: 'hidden' })
    expect(await page.getByRole('region', { name: 'Plan and quota' }).count()).toBe(0)
    expect(await draft.textContent()).toContain('Keep this draft')
    expect(await manager.setBundleEnabled('@zaimokuza/dsh-acp-adapter', true)).toMatchObject({ application: 'applied' })
    await trigger.waitFor()
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    await mainPanel.getByText('Plan · Beta team').waitFor()
    await host.ctx.sessionController.selectModel({ sessionId: SessionId(id), provider: 'acp-buddy', model: buddyModel })
    await mainPanel.getByRole('link', { name: 'Usage guide (China)', exact: true }).waitFor()
    await mainPanel.getByRole('link', { name: 'Usage guide (International)', exact: true }).waitFor()
    expect(await mainPanel.innerText()).not.toContain('Beta team')
    expect(calls).not.toContain('buddy')
    expect(errors).toEqual([])
  } finally {
    late.resolve()
    restore?.()
    await browser?.close()
    await host.close()
  }
}, 120_000)
