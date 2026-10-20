import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import type { Page } from 'playwright'
import { required } from './required.ts'

it.each(['reject', 'accepted-running'])(
  'keeps a Qwen task live after %s cancellation until the real process completes',
  async (mode) => {
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    let page: Page | undefined
    const control = join(host.workspaceCwd, 'qwen-job-control')
    const log = `${control}.jsonl`
    const directory = join(root, '.local/e2e-qwen-job-lifecycle', mode)
    mkdirSync(directory, { recursive: true })
    const facts: Record<string, unknown> = { mode }
    const events: SessionEvent[] = []
    const heartbeat = () => Number(readFileSync(`${control}.heartbeat`, 'utf8'))
    try {
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: {
          qwen: {
            name: 'Qwen job control fixture',
            command: process.execPath,
            args: [join(root, 'test/fixtures/qwen-job-control-agent.mjs')],
            env: {
              HOME: host.workspaceCwd,
              QWEN_JOB_CONTROL: control,
              QWEN_JOB_LOG: log,
              QWEN_JOB_CANCEL_MODE: mode,
            },
          },
        },
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-qwen')).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-qwen', model: 'qwen-job-fixture' })
      browser = await launchBrowser({ headless: true })
      page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Start the controlled task')
      const settled = host.whenTurnSettled(30_000)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const owner = await settled
      host.ctx.on('session/event', (session, event) => {
        if (session.id === owner) events.push(event)
      })
      await expect.poll(() => host.ctx.jobs.list(owner).filter((job) => job.kind === 'acp-qwen-task').length).toBe(1)
      const job = required(host.ctx.jobs.list(owner).find((job) => job.kind === 'acp-qwen-task'))
      await expect.poll(() => existsSync(`${control}.heartbeat`)).toBe(true)
      await page.getByRole('button', { name: '1 background job running', exact: true }).click()
      await page.getByRole('button', { name: 'Stop task Controlled Qwen task', exact: true }).click()
      await page.getByRole('button', { name: 'Click again to confirm', exact: true }).click()
      await expect.poll(() => host.ctx.jobs.get(job.id, owner).status).toBe('stopping')
      await expect.poll(() => readFileSync(log, 'utf8')).toContain('cancel-requested')
      const before = heartbeat()
      // This wall-clock boundary specifically reproduces the removed 10s
      // fallback; fake timers would not prove the real process remains alive.
      await delay(10_250)
      facts.afterOldDeadline = host.ctx.jobs.get(job.id, owner)
      facts.heartbeatBefore = before
      facts.heartbeatAfter = heartbeat()
      expect(facts.heartbeatAfter).toBeGreaterThan(before)
      await page.screenshot({ path: join(directory, 'after-deadline.png'), fullPage: true })
      expect(host.ctx.jobs.get(job.id, owner).status).toBe('stopping')
      await expect(host.ctx.workspaceController.archiveSession({ sessionId: owner })).rejects.toMatchObject({
        cause: {
          name: 'WorkspaceActiveSessionError',
          activity: expect.arrayContaining([expect.objectContaining({ kind: 'job' })]),
        },
      })
      facts.archiveBlockedByLiveJob = true
      expect(events.filter((event) => event.type === 'job/settled')).toEqual([])
      expect(await page.getByRole('button', { name: 'Clear', exact: true }).count()).toBe(0)
      // The actual task now exits naturally. Its delayed notification must
      // win with its real result, rather than a fabricated cancellation.
      writeFileSync(`${control}.finish`, 'finish')
      await expect.poll(() => host.ctx.jobs.get(job.id, owner).status).toBe('completed')
      const terminal = events.filter((event) => event.type === 'job/settled')
      expect(terminal).toHaveLength(1)
      expect(terminal[0]?.data).toMatchObject({ status: 'completed', producerReported: true })
      const agentEvents = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              event: string
              code?: number
              signal?: string | null
            },
        )
      expect(agentEvents.filter((event) => event.event === 'prompt')).toHaveLength(1)
      expect(agentEvents.filter((event) => event.event === 'cancel-requested')).toHaveLength(1)
      expect(agentEvents.find((event) => event.event === 'task-exited')).toMatchObject({ code: 0, signal: null })
      facts.completed = host.ctx.jobs.get(job.id, owner)
      facts.events = terminal
      await page.getByRole('button', { name: '1 background job', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Clear', exact: true }).waitFor()
      const list = page.getByRole('list', { name: 'Background jobs', exact: true })
      await expect.poll(() => list.innerText()).toContain('completed')
      facts.completedPanel = await list.innerText()
      await page.screenshot({ path: join(directory, 'completed.png'), fullPage: true })
      const archived = await host.ctx.workspaceController.archiveSession({ sessionId: owner })
      expect(archived.archivedSessionIds).toContain(owner)
      facts.status = 'passed'
    } catch (error) {
      facts.error = String(error)
      if (page) {
        facts.body = await page.locator('body').innerText()
        await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
      }
      throw error
    } finally {
      writeFileSync(`${control}.finish`, 'finish')
      try {
        await browser?.close()
      } finally {
        if (existsSync(log)) facts.agent = readFileSync(log, 'utf8')
        writeFileSync(join(directory, 'facts.json'), JSON.stringify(facts, null, 2))
        await host.close()
      }
    }
  },
)
