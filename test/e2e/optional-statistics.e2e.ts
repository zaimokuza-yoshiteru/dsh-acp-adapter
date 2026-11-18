/** Official Statistics view + real ACP transport; the external agent is a keyless fixture. */
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { required } from './required.ts'
import type { ObservedEvent } from './types.ts'

async function openView(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    await page.getByRole('button', { name: 'More conversation views', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
}

/** These native column headers bind assertions to meaning instead of CSS classes. */
async function expectUnreportedUsage(table: Locator, row: Locator): Promise<void> {
  const headings = await table.locator('thead th').allTextContents()
  for (const name of ['Context', 'Output', 'Cache hit', 'Output speed']) {
    const column = headings.findIndex((heading) => heading.trim() === name)
    expect(column).toBeGreaterThanOrEqual(0)
    const cell = row.locator('td').nth(column)
    await expect.poll(() => cell.innerText()).toBe('—')
    if (name !== 'Context') expect(await cell.getAttribute('title')).toBe('not recorded')
  }
}

it('mounts official Statistics across reload, hot toggles and narrow view navigation without inventing usage', async () => {
  const host = await launchAdapterWorld({ optionalBundles: ['inspector-profile'] })
  let browser: TestBrowser | undefined
  let page: Page | undefined
  const events: ObservedEvent[] = []
  const errors: string[] = []
  const evidence = join(root, '.local/optional-statistics', process.env.DSH_E2E_ELECTRON ? 'electron' : 'web')
  mkdirSync(evidence, { recursive: true })
  host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Offline statistics fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'codex' },
        },
      },
    })
    const routed = () => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-codex')
    await expect.poll(routed).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    const manager = host.ctx.pluginManager
    const entry = required(
      (await manager.listPlugins()).find(
        (plugin) => plugin.moduleName === '@deepseek-ai/dsh-experimental-client-ui-stats',
      ),
    )
    expect(entry.readOnlyReason).toBeUndefined()
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    page = await newEnglishPage(browser)
    const activePage = page
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const sessionId = required(
      await page.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session'),
    )
    const log = () => events.filter((event) => event.sessionId === sessionId)
    const stats = page.getByRole('region', { name: 'Statistics', exact: true })
    const table = stats.getByRole('table', { name: 'Statistics', exact: true })
    // Alpha.2 keeps the blank composer as a draft, before conversation views
    // mount. Do not manufacture a Statistics tab for that native draft state.
    expect(await stats.count()).toBe(0)
    expect(log().filter((event) => event.type === 'step/start')).toHaveLength(0)

    const send = async (text: string): Promise<void> => {
      if (await activePage.getByRole('tab', { name: 'Chat', exact: true }).isVisible())
        await openView(activePage, 'Chat')
      await writeComposerDraft(activePage, activePage.locator('[data-composer-input]').first(), text)
      const settled = host.whenTurnSettled(30_000)
      void settled.catch(() => {})
      await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
      expect(await settled).toBe(sessionId)
      await activePage.getByText('E2E_DONE mock-model-a', { exact: true }).last().waitFor()
    }
    const assertTurns = async (count: number): Promise<void> => {
      await stats.waitFor()
      await expect.poll(() => table.locator('tbody tr[data-turn]').count()).toBe(count)
      await activePage.getByText(`${count} turns · ${count} steps`, { exact: true }).waitFor()
      for (let turn = 1; turn <= count; turn++) {
        const row = table.locator(`tr[data-turn="${turn}"]`)
        await expectUnreportedUsage(table, row)
        // E2E_MESSAGE emits an ACP-internal tool update, not a native MCP call.
        // Statistics must not turn that journal row into a measured Host call.
        expect(await row.locator('td').nth(2).innerText()).toContain('E2E_DONE mock-model-a')
        expect(await row.locator('td').nth(2).innerText()).not.toContain('echo E2E_TOOL_OUTPUT')
      }
    }
    await send('E2E_MESSAGE_STATS_FIRST')
    expect(log().filter((event) => event.type === 'step/start')).toHaveLength(1)
    expect(log().filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    expect(log().filter((event) => event.type === 'tool/call')).toHaveLength(0)
    await openView(page, 'Statistics')
    await assertTurns(1)
    const step = table.getByRole('button', { name: 'Expand or collapse the tool details of step 1', exact: true })
    await step.waitFor()
    await expectUnreportedUsage(table, step.locator('xpath=ancestor::tr[1]'))
    await page.reload()
    await page.locator('[data-conversation-session]:visible').first().waitFor()
    await openView(page, 'Statistics')
    await assertTurns(1)

    // ConfigEditor owns this real plugin entry, including browser disposal and
    // re-registration. The ACP route and stored history survive either state.
    expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
    await stats.waitFor({ state: 'hidden' })
    await expect.poll(() => page!.getByRole('tab', { name: 'Statistics', exact: true }).count()).toBe(0)
    expect(routed()).toBe(true)
    await send('E2E_MESSAGE_STATS_WHILE_DISABLED')
    expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
    await page.getByRole('tab', { name: 'Statistics', exact: true }).waitFor()
    await openView(page, 'Statistics')
    await assertTurns(2)
    expect(await table.count()).toBe(1)

    for (const width of [1680, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      for (const preference of ['light', 'dark']) {
        await host.ctx.settings.replace('ui-theme', { preference })
        await expect.poll(() => activePage.evaluate(() => document.documentElement.style.colorScheme)).toBe(preference)
        await openView(page, 'Statistics')
        await assertTurns(2)
        // These checks cover the native container and navigation, not table
        // legibility. Alpha.2's official columns remain cramped at 390px;
        // screenshots record that upstream limitation without ACP CSS overrides.
        const box = required(await stats.boundingBox())
        expect(box.x).toBeGreaterThanOrEqual(-1)
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
        expect(box.height).toBeGreaterThan(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
        await page.screenshot({ path: join(evidence, `stats-${width}-${preference}.png`), animations: 'disabled' })
      }
      await openView(page, 'ACP Diagnostics')
      await page.getByRole('region', { name: 'ACP Diagnostics', exact: true }).waitFor()
      await openView(page, 'Statistics')
      await assertTurns(2)
    }
    await page.reload()
    await page.locator('[data-conversation-session]:visible').first().waitFor()
    await openView(page, 'Statistics')
    await assertTurns(2)
    // Host context messages also use user/message. Only these two human
    // submissions may be dispatched; view changes must not send another one.
    const submitted = log()
      .filter((event) => event.type === 'user/message')
      .filter((event) => event.data.source.kind === 'user')
    expect(submitted).toHaveLength(2)
    expect(submitted.map((event) => JSON.stringify(event.data.content))).toEqual([
      expect.stringContaining('E2E_MESSAGE_STATS_FIRST'),
      expect.stringContaining('E2E_MESSAGE_STATS_WHILE_DISABLED'),
    ])
    expect(log().filter((event) => event.type === 'step/start')).toHaveLength(2)
    expect(log().filter((event) => event.type === 'tool/call')).toHaveLength(0)
    expect(errors).toEqual([])
  } catch (error) {
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
      writeFileSync(join(evidence, 'failure.txt'), await page.locator('body').innerText())
    }
    throw error
  } finally {
    writeFileSync(
      join(evidence, 'summary.json'),
      JSON.stringify(
        {
          eventTypes: events.map((event) => event.type),
          errors,
          keyless: true,
          narrowViewport: {
            width: 390,
            verified: ['native view mounting and switching', 'unreported usage', 'container boundary'],
            limitation:
              'The upstream alpha.2 table is cramped with overlapping columns at 390px. Container checks do not certify table readability.',
          },
        },
        null,
        2,
      ),
    )
    await browser?.close()
    await host.close()
  }
}, 120_000)
