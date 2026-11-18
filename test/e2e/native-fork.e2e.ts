/** Native UI + native Session fork + persisted ACP fixture history; no model account. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { OPTIONAL_TOOL_PLAN } from '../mock-agent/optional-tools-turn.ts'
import type { WorktreePlan } from './fixtures/worktree/agent.ts'
import { launchOptionalToolWorld } from './optional-tool-world.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { root } from './scaffold.ts'
import { required } from './required.ts'

interface LifecycleRecord {
  kind: string
  pid: number
  sessionId?: string
  parentId?: string
  history?: string[]
  text?: string
}

it('forks from the native ACP footer without parentSession and restores its independent private history after hot reload', async () => {
  const host = await launchOptionalToolWorld([], {
    profile: 'ordinary-fork-fixture',
    script: join(root, 'test/e2e/fixtures/worktree/agent.ts'),
    env: { WORKTREE_FIXTURE_FORK: '1' },
  })
  let browser: TestBrowser | undefined
  const releaseNativeTitle = Promise.withResolvers<void>()
  let restoreNativeSpies: (() => void) | undefined
  const errors: string[] = []
  const evidence = join(root, '.local/native-fork-alpha2', process.env.DSH_E2E_ELECTRON ? 'electron' : 'web')
  mkdirSync(evidence, { recursive: true })
  const lifecycle = (): LifecycleRecord[] => {
    const file = join(host.workspaceCwd, 'worktree-agent-events.jsonl')
    return (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []).map(
      (line) => JSON.parse(line) as LifecycleRecord,
    )
  }
  try {
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const send = async (plan: WorktreePlan) => {
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}`,
      )
      const settled = host.whenTurnSettled(30_000)
      void settled.catch(() => {})
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const id = await settled
      await page.getByText(`E2E_OPTIONAL_DONE ${plan.label}`, { exact: true }).waitFor()
      return id
    }
    const marker = 'ORDINARY_FORK_PRIVATE_PARENT_HISTORY'
    const parentId = await send({ label: 'ordinary-parent', calls: [], remember: marker })
    const parent = required(host.ctx.agents.get(parentId))
    const sourceCut = required(parent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).seq
    const parentComplete = required(host.records('ordinary-parent').find((record) => record.kind === 'complete'))
    const originalAcpId = required(parentComplete.acpSessionId)
    const before = lifecycle().length
    const manager = host.ctx.pluginManager
    const entry = required(
      (await manager.listPlugins()).find((plugin) => plugin.moduleName === '@zaimokuza/dsh-acp-adapter'),
    )
    // Pause after native creation/catalog publication and the onCreated callback,
    // while the ordinary native title operation still owns an outstanding RPC.
    await host.ctx.sessionController.rename({ sessionId: parent.id, title: 'FORK_PENDING_SOURCE' })
    await page.getByText('FORK_PENDING_SOURCE', { exact: true }).first().waitFor()
    const nativeTitleEntered = Promise.withResolvers<string>()
    const rename = host.ctx.sessionController.rename.bind(host.ctx.sessionController)
    const renameSpy = vi.spyOn(host.ctx.sessionController, 'rename').mockImplementation(async (request) => {
      if (request.sessionId !== parent.id) {
        nativeTitleEntered.resolve(request.sessionId)
        await releaseNativeTitle.promise
      }
      return rename(request)
    })
    const forkSpy = vi.spyOn(host.ctx.sessionController, 'fork')
    restoreNativeSpies = () => {
      renameSpy.mockRestore()
      forkSpy.mockRestore()
    }
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    const committedChildId = await nativeTitleEntered.promise
    await expect
      .poll(() =>
        page.evaluate((id) => Object.values(sessionStorage).some((value) => value.includes(id)), committedChildId),
      )
      .toBe(true)
    const disabling = manager.setPluginEnabled(entry.entryId, false)
    await expect
      .poll(() => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-ordinary-fork-fixture'))
      .toBe(false)
    releaseNativeTitle.resolve()
    expect(await disabling).toMatchObject({ application: 'applied' })
    expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
    await expect
      .poll(() => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-ordinary-fork-fixture'))
      .toBe(true)
    await page.reload()
    await page.getByText('E2E_OPTIONAL_DONE ordinary-parent', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    await expect
      .poll(async () => {
        const id = await page
          .locator('[data-conversation-session]:visible')
          .first()
          .getAttribute('data-conversation-session')
        return id !== null && id !== parentId ? id : undefined
      })
      .toBeDefined()
    const childId = required(
      await page.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session'),
    )
    expect(childId).toBe(committedChildId)
    expect(forkSpy).toHaveBeenCalledOnce()
    restoreNativeSpies()
    restoreNativeSpies = undefined
    const child = required(host.ctx.agents.get(childId as never))
    expect(child.session.header.parentSession).toBeUndefined()
    expect(child.session.header.origin).toBeUndefined()
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(sourceCut + 1)
    expect(child.session.snapshotEvents().slice(0, sourceCut + 1)).toEqual(
      parent.session.snapshotEvents().slice(0, sourceCut + 1),
    )
    expect(
      lifecycle()
        .slice(before)
        .filter((event) => event.kind === 'session/fork'),
    ).toHaveLength(0)

    expect(await send({ label: 'ordinary-child', calls: [] })).toBe(childId)
    const fork = required(
      lifecycle()
        .slice(before)
        .find((event) => event.kind === 'session/fork'),
    )
    expect(fork.parentId).toBe(originalAcpId)
    expect(fork.history).toContain(marker)
    const childAcpId = required(fork.sessionId)
    expect(childAcpId).not.toBe(originalAcpId)
    const continued = required(
      lifecycle()
        .slice(before)
        .find((event) => event.kind === 'prompt' && event.sessionId === childAcpId),
    )
    expect(continued.history).toContain(marker)
    // Model-directory probes may create their own sessions; none can own this
    // child continuation or replace the confirmed ACP session/fork result.
    expect(
      lifecycle()
        .slice(before)
        .some((event) => event.kind === 'session/new' && event.sessionId === childAcpId),
    ).toBe(false)
    await page.screenshot({ path: join(evidence, 'native-child.png'), fullPage: true })

    expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
    await expect
      .poll(() => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-ordinary-fork-fixture'))
      .toBe(false)
    expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
    await expect
      .poll(() => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-ordinary-fork-fixture'))
      .toBe(true)
    await page.reload()
    await page.locator(`[data-conversation-session="${childId}"] [data-composer-input]`).waitFor()
    expect(await send({ label: 'ordinary-child-restored', calls: [] })).toBe(childId)
    const restored = lifecycle().filter((event) => event.kind === 'session/load' && event.sessionId === childAcpId)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.pid).not.toBe(fork.pid)
    const last = required(lifecycle().findLast((event) => event.kind === 'prompt' && event.sessionId === childAcpId))
    expect(last.history).toContain(marker)
    expect(lifecycle().filter((event) => event.kind === 'session/fork' && event.sessionId === childAcpId)).toHaveLength(
      1,
    )
    expect(child.session.header.parentSession).toBeUndefined()
    // Fault injection is scoped to this isolated tab's ACP journal. A child
    // already opened must remain successful when only local cleanup fails.
    await page.locator(`[data-row-key="session:${parentId}"]`).click()
    await page.locator(`[data-conversation-session="${parentId}"] [data-composer-input]`).waitFor()
    await page.evaluate(() => {
      const remove = Storage.prototype.removeItem
      Storage.prototype.removeItem = function (key: string) {
        if (this === sessionStorage && key.startsWith('dsh.acp.native-fork.v1:')) {
          Storage.prototype.removeItem = remove
          sessionStorage.setItem('e2e-failed-fork-journal-key', key)
          throw new Error('E2E_JOURNAL_CLEANUP_FAILED')
        }
        return remove.call(this, key)
      }
    })
    const recoveryFork = vi.spyOn(host.ctx.sessionController, 'fork')
    restoreNativeSpies = () => recoveryFork.mockRestore()
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    const cleanup = page.getByRole('dialog', { name: 'Fork created and opened', exact: true })
    await cleanup.waitFor()
    expect(recoveryFork).toHaveBeenCalledOnce()
    const cleanupChild = await page
      .locator('[data-conversation-session]')
      .first()
      .getAttribute('data-conversation-session')
    expect(cleanupChild).not.toBe(parentId)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, 'cleanup-warning-390.png'), animations: 'disabled' })
    await cleanup.getByRole('button', { name: 'Retry clearing recovery record', exact: true }).click()
    await cleanup.waitFor({ state: 'hidden' })
    expect(recoveryFork).toHaveBeenCalledOnce()
    expect(await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')).toBe(
      cleanupChild,
    )
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.locator(`[data-row-key="session:${parentId}"]`).click()
    await page.evaluate(() => {
      const key = sessionStorage.getItem('e2e-failed-fork-journal-key')
      if (key === null) throw new Error('Missing fault-injection journal key')
      sessionStorage.setItem(key, JSON.stringify({ phase: 'creating' }))
    })
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    const unknown = page.getByRole('dialog', { name: 'Fork creation outcome is unconfirmed', exact: true })
    await unknown.waitFor()
    await unknown.getByRole('button', { name: 'Confirm abandoning recovery', exact: true }).click()
    const abandoned = page.getByRole('dialog', { name: 'Recovery for this fork was abandoned', exact: true })
    await abandoned.waitFor()
    expect(recoveryFork).toHaveBeenCalledOnce()
    expect(await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.includes(':abandoned:')))).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(evidence, 'abandoned-confirmation-390.png'), animations: 'disabled' })
    await abandoned.getByRole('button', { name: 'Confirm creating another fork', exact: true }).click()
    await abandoned.waitFor({ state: 'hidden' })
    await expect.poll(() => recoveryFork.mock.calls.length).toBe(2)
    await expect
      .poll(() => page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session'))
      .not.toBe(parentId)
    expect(errors).toEqual([])
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify({ keyless: true, parentId, childId, sourceCut, lifecycle: lifecycle() }, null, 2),
    )
  } finally {
    releaseNativeTitle.resolve()
    restoreNativeSpies?.()
    await browser?.close()
    await host.close()
  }
}, 120_000)
