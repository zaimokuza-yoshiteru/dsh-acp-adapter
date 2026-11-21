/** Inspect the installed Devin catalog and change review preferences through DSH's native plugin page. */
import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace } from '#host-support'
import { en, zh } from '../../src/client/ui/locales.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { prepareLiveDevinEnvironment } from './live-devin-environment.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { DEFAULT_DEVIN_REVIEW_MODEL } from '../../src/contract/devin-review.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

async function controls(page: Page, language: 'en' | 'zh') {
  const copy = language === 'en' ? en : zh
  const detail = await openAcpPluginDetail(page, language)
  const section = detail.getByRole('region', { name: copy.aiApproval, exact: true })
  const toggle = section.getByRole('switch', { name: copy.aiApproval, exact: true })
  await toggle.waitFor()
  await section.getByText(copy.aiApprovalHelp, { exact: true }).waitFor()
  return {
    section,
    toggle,
    model: section.getByRole('button', { name: copy.reviewModelFor.replace('{name}', 'Devin'), exact: true }),
  }
}

it.skipIf(process.env.DSH_E2E_LIVE_DEVIN_REVIEW_SETTINGS !== '1')(
  'changes the review model and persists the opt-in across the English and Chinese desktop settings pages',
  async () => {
    const candidate = required(process.env.DSH_E2E_ADAPTER_DIRECTORY, 'Set the frozen candidate directory')
    const output = join(process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/devin-review-settings'), randomUUID())
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const host = await launchAdapterWorld({ adapterDirectory: candidate })
    let browser: TestBrowser | undefined
    let profile: Awaited<ReturnType<typeof prepareLiveDevinEnvironment>> | undefined
    try {
      profile = await prepareLiveDevinEnvironment('existing', {})
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: {
          devin: {
            name: 'Devin',
            command: process.env.DSH_E2E_LIVE_DEVIN_COMMAND ?? 'devin',
            args: ['acp', '--process-model', 'in-process'],
            env: profile.env,
          },
        },
      })
      await vi.waitFor(() =>
        expect(host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-devin')).toBe(true),
      )
      const service = required(host.ctx.get('dshAcp')) as AcpRemoteService
      const facts = (await service.health({ recheck: true, agentId: 'devin' })).providers[0]
      expect(facts?.probe.status).toBe('ok')
      const models = required(facts?.devinReviewModels, 'No verified local review models')
      const savedDefault = models.find((model) => model.id === DEFAULT_DEVIN_REVIEW_MODEL)
      const initial = required(savedDefault ?? models[0], 'Devin did not return a review model')
      const alternative = required(
        models.find((m) => m.id !== initial.id && m.name !== initial.name),
        'Need two distinct offered models to test switching',
      )
      const saved = () => host.ctx.settings.describe().find((item) => item.ns === 'dsh-acp-adapter')?.value

      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const english = await controls(page, 'en')
      expect(await english.toggle.getAttribute('aria-checked')).toBe('false')
      expect(await english.model.count()).toBe(0)
      await english.toggle.click()
      await expect.poll(() => english.model.innerText()).toContain(savedDefault?.name ?? DEFAULT_DEVIN_REVIEW_MODEL)
      if (!savedDefault) await english.section.getByText(en.reviewModelMissing, { exact: true }).waitFor()
      await english.model.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, 'en-settings.png'), animations: 'disabled' })
      await english.model.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: alternative.name, exact: true }).waitFor()
      await page.screenshot({ path: join(output, 'en-models.png'), animations: 'disabled' })
      await menu.getByRole('menuitem', { name: alternative.name, exact: true }).click()
      await expect.poll(saved).toMatchObject({ aiApproval: true, devinReviewModel: alternative.id })
      await expect.poll(() => english.model.innerText()).toContain(alternative.name)

      await host.ctx.settings.replace('locale', { preference: 'zh' })
      await page.reload()
      const chinese = await controls(page, 'zh')
      expect(await chinese.toggle.getAttribute('aria-checked')).toBe('true')
      await expect.poll(() => chinese.model.innerText()).toContain(alternative.name)
      await page.setViewportSize({ width: 390, height: 844 })
      await chinese.model.scrollIntoViewIfNeeded()
      expect(await chinese.section.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await chinese.model.click()
      await page.getByRole('menuitem', { name: initial.name, exact: true }).click()
      await expect.poll(saved).toMatchObject({ aiApproval: true, devinReviewModel: initial.id })
      await expect.poll(() => chinese.model.innerText()).toContain(initial.name)
      await page.screenshot({ path: join(output, 'zh-settings-390.png'), animations: 'disabled' })
      await chinese.toggle.click()
      await expect.poll(saved).toMatchObject({ aiApproval: false, devinReviewModel: initial.id })
      await expect.poll(() => chinese.model.count()).toBe(0)
    } finally {
      await browser?.close()
      try {
        await host.close()
      } finally {
        await profile?.dispose()
      }
    }
  },
  120_000,
)
