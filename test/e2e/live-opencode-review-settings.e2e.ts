/** Real OpenCode catalog and DSH settings. The local fixture serves no inference requests. */
import { connectFreshWorkspace } from '#host-support'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../../src/client/ui/locales.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { openAcpPluginDetail } from './plugin-panel.helpers.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

async function approvalSettings(page: Page, language: 'en' | 'zh') {
  const copy = language === 'en' ? en : zh
  const detail = await openAcpPluginDetail(page, language)
  const region = detail.getByRole('region', { name: copy.aiApproval, exact: true })
  const toggle = region.getByRole('switch', { name: copy.aiApproval, exact: true })
  await toggle.waitFor()
  expect(await detail.locator('[data-dsh-acp-panel]').getByRole('switch').count()).toBe(1)
  await region.getByText(copy.aiApprovalHelp, { exact: true }).waitFor()
  const model = region.getByRole('button', {
    name: copy.reviewModelFor.replace('{name}', 'OpenCode Local'),
    exact: true,
  })
  return { region, toggle, model }
}

it.skipIf(process.env.DSH_E2E_LIVE_OPENCODE_REVIEW_SETTINGS !== '1')(
  'persists a per-profile OpenCode review model in the English desktop and Chinese compact settings',
  async () => {
    const command = required(
      process.env.DSH_E2E_LIVE_OPENCODE_COMMAND,
      'Set the path to the official OpenCode 2.3.2 CLI',
    )
    const candidate = required(process.env.DSH_E2E_ADAPTER_DIRECTORY, 'Set the frozen candidate directory')
    const output = join(process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/opencode-review-settings'), randomUUID())
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-opencode-settings-'))
    const paths = {
      HOME: join(profileRoot, 'home'),
      XDG_CONFIG_HOME: join(profileRoot, 'config'),
      XDG_DATA_HOME: join(profileRoot, 'data'),
      XDG_STATE_HOME: join(profileRoot, 'state'),
      XDG_CACHE_HOME: join(profileRoot, 'cache'),
      TMPDIR: join(profileRoot, 'tmp'),
    }
    const requests: string[] = []
    const catalog = createServer((req, res) => {
      requests.push(req.method + ' ' + req.url)
      res.writeHead(404).end()
    })
    let host: Awaited<ReturnType<typeof launchAdapterWorld>> | undefined
    let browser: TestBrowser | undefined
    try {
      await new Promise<void>((resolve, reject) => catalog.once('error', reject).listen(0, '127.0.0.1', resolve))
      const port = catalog.address()
      if (!port || typeof port === 'string') throw Error('No local fixture port')
      for (const path of [...Object.values(paths), join(paths.XDG_CONFIG_HOME, 'opencode')])
        mkdirSync(path, { recursive: true, mode: 0o700 })
      const modelId = 'local-approval/qa'
      writeFileSync(
        join(paths.XDG_CONFIG_HOME, 'opencode/opencode.json'),
        JSON.stringify({
          model: modelId,
          providers: {
            'local-approval': {
              name: 'Local fixture',
              env: ['DSH_TEST_OPENCODE_TOKEN'],
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: 'http://127.0.0.1:' + port.port + '/v1', apiKey: 'test' },
              models: { qa: { name: 'QA' }, alternate: { name: 'Alternate' } },
            },
          },
          policies: [
            { action: 'provider.use', resource: '*', effect: 'deny' },
            { action: 'provider.use', resource: 'local-approval', effect: 'allow' },
          ],
          update: 'disable',
        }),
        { mode: 0o600 },
      )
      const profile = {
        name: 'OpenCode Local',
        command,
        args: ['acp'],
        env: {
          ...paths,
          DSH_TEST_OPENCODE_TOKEN: 'test',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          NO_PROXY: 'localhost,127.0.0.1',
        },
      }
      const otherProfile = { ...profile, name: 'OpenCode Other', openCodeReviewModel: 'local-approval/alternate' }
      const preserved = {
        agents: { other: otherProfile },
        devinReviewModel: 'swe-2-high',
      }
      host = await launchAdapterWorld({ adapterDirectory: candidate })
      const ctx = host.ctx
      await ctx.settings.replace('dsh-acp-adapter', {
        ...preserved,
        agents: { local: profile, other: otherProfile },
      })
      await vi.waitFor(() => expect(ctx.llm.listProviders().some((p) => p.id === 'acp-local')).toBe(true))
      const service = required(ctx.get('dshAcp')) as AcpRemoteService
      const facts = (await service.health({ recheck: true, agentId: 'local' })).providers.find((p) => p.id === 'local')
      expect(facts?.probe.status).toBe('ok')
      expect(facts?.version).toContain('2.3.2')
      const peer = (await service.health({ recheck: true, agentId: 'other' })).providers.find((p) => p.id === 'other')
      expect(peer?.openCodeReviewModels?.length).toBeGreaterThan(0)
      const choice = required(
        facts?.openCodeReviewModels?.find((m) => m.id === modelId),
        'Missing local OpenCode review model',
      )
      const saved = () => ctx.settings.describe().find((d) => d.ns === 'dsh-acp-adapter')?.value

      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const english = await approvalSettings(page, 'en')
      expect(await english.toggle.getAttribute('aria-checked')).toBe('false')
      expect(await english.model.count()).toBe(0)
      await english.toggle.click()
      await expect.poll(() => english.model.innerText()).toContain(en.reviewSessionModel)
      await expect.poll(saved).toMatchObject({
        ...preserved,
        aiApproval: true,
        agents: { ...preserved.agents, local: profile },
      })
      await english.model.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, 'en-settings-1280.png'), animations: 'disabled' })
      await english.model.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: choice.name, exact: true }).waitFor()
      const sectionWidth = required(await english.region.boundingBox()).width
      const triggerWidth = required(await english.model.boundingBox()).width
      expect(Math.abs(triggerWidth - sectionWidth)).toBeLessThanOrEqual(1)
      expect(Math.abs(required(await menu.boundingBox()).width - triggerWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: join(output, 'en-models-1280.png'), animations: 'disabled' })
      await menu.getByRole('menuitem', { name: choice.name, exact: true }).click()
      await expect.poll(() => english.model.innerText()).toContain(choice.name)
      await expect.poll(saved).toMatchObject({
        ...preserved,
        agents: { ...preserved.agents, local: { ...profile, openCodeReviewModel: modelId } },
      })
      await page.locator('[data-dsh-acp-agent="local"]').getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('button', { name: /^Environment variables/ }).click()
      const environment = page.getByLabel('Environment', { exact: true })
      await environment.fill((await environment.inputValue()) + '\nLANG=zh_CN.UTF-8')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(saved).toMatchObject({
        agents: { local: { env: { LANG: 'zh_CN.UTF-8' }, openCodeReviewModel: modelId } },
      })
      await page.locator('[data-dsh-acp-agent="local"]').getByText(en.stateReady, { exact: true }).waitFor()
      await expect.poll(() => english.model.innerText()).toContain(choice.name)

      await ctx.settings.replace('locale', { preference: 'zh' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      const chinese = await approvalSettings(page, 'zh')
      expect(await chinese.toggle.getAttribute('aria-checked')).toBe('true')
      await expect.poll(() => chinese.model.innerText()).toContain(choice.name)
      await chinese.model.scrollIntoViewIfNeeded()
      expect(await chinese.region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: join(output, 'zh-pinned-390.png'), animations: 'disabled' })
      await chinese.model.click()
      await menu.getByRole('menuitem', { name: zh.reviewSessionModel, exact: true }).waitFor()
      const bounds = required(await menu.boundingBox())
      expect(Math.abs(bounds.width - required(await chinese.model.boundingBox()).width)).toBeLessThanOrEqual(1)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(391)
      await menu.getByRole('menuitem', { name: zh.reviewSessionModel, exact: true }).click()
      await expect.poll(() => chinese.model.innerText()).toContain(zh.reviewSessionModel)
      await expect.poll(saved).toMatchObject({
        ...preserved,
        aiApproval: true,
        agents: { ...preserved.agents, local: profile },
      })
      await chinese.toggle.click()
      await expect.poll(() => chinese.model.count()).toBe(0)
      await expect.poll(saved).toMatchObject({ ...preserved, aiApproval: false })
      await expect
        .poll(() => (saved() as { agents?: Record<string, unknown> })?.agents?.local)
        .not.toHaveProperty('openCodeReviewModel')
      await page.reload()
      const reopened = await approvalSettings(page, 'zh')
      expect(await reopened.toggle.getAttribute('aria-checked')).toBe('false')
      expect(await reopened.model.count()).toBe(0)
      expect(requests.filter((request) => request.startsWith('POST '))).toEqual([])
      writeFileSync(
        join(output, 'result.json'),
        JSON.stringify(
          {
            candidate,
            cliVersion: facts?.version,
            modelId,
            renderer: process.env.DSH_E2E_ELECTRON ? 'electron' : 'chromium',
            viewports: [
              { language: 'en', width: 1280 },
              { language: 'zh', width: 390 },
            ],
            followAndPinPersisted: true,
            disabledAfterReload: true,
            preservedOtherProfileAndDevin: true,
            globalHelpCount: 1,
            globalSwitchCount: 1,
            inferenceRequests: 0,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } finally {
      try {
        await browser?.close()
      } finally {
        try {
          await host?.close()
        } finally {
          catalog.closeAllConnections()
          await new Promise<void>((resolve) => catalog.close(() => resolve()))
          rmSync(profileRoot, { recursive: true, force: true })
        }
      }
    }
  },
  120_000,
)
