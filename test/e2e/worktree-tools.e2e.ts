import type {} from '@deepseek-ai/dsh-working-directory'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import type { Page } from 'playwright'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { OPTIONAL_TOOL_PLAN } from '../mock-agent/optional-tools-turn.ts'
import type { WorktreePlan } from './fixtures/worktree/agent.ts'
import { callResult, launchOptionalToolWorld } from './optional-tool-world.ts'
import { required } from './required.ts'
import { root } from './scaffold.ts'

interface LifecycleRecord {
  kind: string
  pid: number
  sessionId?: string
  parentId?: string
  cwd?: string
  file?: string
  history?: string[]
  text?: string
  error?: string
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function initializeRepository(cwd: string) {
  git(cwd, 'init', '--initial-branch=fixture-main')
  writeFileSync(join(cwd, 'tracked.txt'), 'original checkout\n')
  git(cwd, 'add', '--', 'tracked.txt')
  git(
    cwd,
    '-c',
    'user.name=DSH offline fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture base',
  )
  return git(cwd, 'rev-parse', 'HEAD')
}
function lifecycle(cwd: string): LifecycleRecord[] {
  const file = join(cwd, 'worktree-agent-events.jsonl')
  return (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []).map(
    (line) => JSON.parse(line) as LifecycleRecord,
  )
}
function launch(fork: boolean) {
  return launchOptionalToolWorld(['tool-worktree'], {
    profile: 'worktree-fixture',
    script: join(root, 'test/e2e/fixtures/worktree/agent.ts'),
    env: { WORKTREE_FIXTURE_FORK: fork ? '1' : '0' },
  })
}

async function seedConversation(world: Awaited<ReturnType<typeof launch>>, browser: TestBrowser, plan: WorktreePlan) {
  const page = await newEnglishPage(browser)
  await page.goto(world.authenticatedUrl)
  await connectFreshWorkspace(page, world.workspaceCwd, '.')
  const settled = world.whenTurnSettled()
  void settled.catch(() => undefined)
  await writeComposerDraft(
    page,
    page.locator('[data-composer-input]').first(),
    `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}`,
  )
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const owner = required(world.ctx.agents.get(await settled))
  return { page, owner }
}

async function allowOnce(page: Page, tool: string) {
  const request = page.locator('[data-approval-key]').filter({ hasText: tool })
  await request.getByRole('button', { name: 'Allow once', exact: true }).click()
}

it('forks ACP private history across processes and resumes the native cwd notice in the real Git checkout', async () => {
  const world = await launch(true)
  let browser: TestBrowser | undefined
  try {
    const originalCwd = realpathSync(world.workspaceCwd)
    const baseCommit = initializeRepository(originalCwd)
    const marker = 'PRIVATE_ACP_HISTORY_MUST_SURVIVE_FORK'
    browser = await launchBrowser({ headless: true })
    const { page, owner } = await seedConversation(world, browser, {
      label: 'worktree-seed',
      calls: [],
      remember: marker,
    })
    const originalSessionId = required(
      world.records('worktree-seed').find((record) => record.kind === 'complete'),
    ).acpSessionId
    const oldProcess = required(
      lifecycle(originalCwd).find((record) => record.kind === 'session/new' && record.sessionId === originalSessionId),
    ).pid
    const branch = 'acp-fork-checkout'
    const checkout = join(originalCwd, '.agents/worktrees', branch)
    const file = 'only-in-forked-checkout.txt'
    const content = 'written after inherited private history and native directory notice\n'
    const before = owner.session.snapshotEvents().filter((event) => event.type === 'turn/end').length
    const plan: WorktreePlan = {
      label: 'worktree-create',
      calls: [{ name: 'create_worktree', arguments: { name: branch, from: 'HEAD' } }],
      afterDirectoryChange: { marker, file, content },
    }
    await world.ctx.sessionController.prompt(
      {
        requestId: randomUUID() as SessionRequestId,
        sessionId: owner.id,
        mode: 'queue',
        content: [{ type: 'text', text: `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}` }],
      },
      new AbortController().signal,
    )
    await allowOnce(page, 'create_worktree')
    // The original ACP prompt is cancelled by the cwd change. Success is the
    // automatic next step's write, after a fresh process forks private history.
    await vi.waitFor(() => expect(existsSync(join(checkout, file))).toBe(true), { timeout: 45_000 })
    await vi.waitFor(
      () =>
        expect(owner.session.snapshotEvents().filter((event) => event.type === 'turn/end').length).toBeGreaterThan(
          before,
        ),
      { timeout: 15_000 },
    )
    expect(
      required(owner.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).data.reason,
    ).toMatchObject({ kind: 'completed' })
    const canonicalCheckout = realpathSync(checkout)
    expect(await world.ctx.workingDirectory.ensure(owner)).toBe(canonicalCheckout)
    expect(owner.session.header.cwd).toBe(originalCwd)
    expect(readFileSync(join(checkout, file), 'utf8')).toBe(content)
    expect(existsSync(join(originalCwd, file))).toBe(false)
    expect(git(checkout, 'branch', '--show-current')).toBe(branch)
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(baseCommit)
    expect(git(originalCwd, 'branch', '--show-current')).toBe('fixture-main')
    expect(readFileSync(join(originalCwd, 'tracked.txt'), 'utf8')).toBe('original checkout\n')
    const events = lifecycle(originalCwd)
    expect(events.filter((event) => event.kind === 'error')).toEqual([])
    const fork = required(events.find((event) => event.kind === 'session/fork' && event.parentId === originalSessionId))
    expect(fork.cwd).toBe(canonicalCheckout)
    expect(fork.history).toContain(marker)
    expect(fork.pid).not.toBe(oldProcess)
    expect(fork.sessionId).not.toBe(originalSessionId)
    expect(
      events.filter((event) => event.kind === 'session/fork' && event.parentId === originalSessionId),
    ).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'cancel', sessionId: originalSessionId }))
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'continued-write',
        sessionId: fork.sessionId,
        parentId: originalSessionId,
        cwd: canonicalCheckout,
        file: join(canonicalCheckout, file),
        history: [marker],
      }),
    )
    expect(events.filter((event) => event.kind === 'session/load' && event.cwd === canonicalCheckout)).toEqual([])
    expect(events.filter((event) => event.kind === 'session/new' && event.cwd === canonicalCheckout)).toEqual([])
    expect(
      events.some(
        (event) =>
          event.kind === 'prompt' &&
          event.sessionId === fork.sessionId &&
          event.text?.includes('The working directory changed from '),
      ),
    ).toBe(true)
    expect(world.nativeCalls.some((call) => call.owner === owner.id && call.name === 'create_worktree')).toBe(true)
  } finally {
    try {
      await browser?.close()
    } finally {
      await world.close()
    }
  }
}, 90_000)

it('rejects native worktree and cd before side effects when the ACP Agent cannot fork its conversation', async () => {
  const world = await launch(false)
  let browser: TestBrowser | undefined
  try {
    const originalCwd = realpathSync(world.workspaceCwd)
    initializeRepository(originalCwd)
    const alternate = join(originalCwd, 'existing-directory')
    mkdirSync(alternate)
    browser = await launchBrowser({ headless: true })
    const { page, owner } = await seedConversation(world, browser, { label: 'unsupported-worktree-seed', calls: [] })
    const [result] = await Promise.all([
      world.run(owner, {
        label: 'unsupported-worktree-guard',
        calls: [
          { name: 'create_worktree', arguments: { name: 'must-not-create', from: 'HEAD' } },
          { name: 'working_directory', arguments: { cd: alternate } },
        ],
      }),
      (async () => {
        await allowOnce(page, 'create_worktree')
        await allowOnce(page, 'working_directory')
      })(),
    ])
    expect(required(result.find((record) => record.kind === 'directory')).names).toEqual(
      expect.arrayContaining(['create_worktree', 'working_directory']),
    )
    for (const name of ['create_worktree', 'working_directory']) {
      expect(callResult(result, name).isError).toBe(true)
      expect(callResult(result, name).text).toContain('ACP_WORKING_DIRECTORY_UNSUPPORTED')
    }
    expect(await world.ctx.workingDirectory.ensure(owner)).toBe(originalCwd)
    expect(git(originalCwd, 'branch', '--list', 'must-not-create')).toBe('')
    expect(existsSync(join(originalCwd, '.agents/worktrees'))).toBe(false)
    expect(lifecycle(originalCwd).filter((event) => event.kind === 'session/fork')).toEqual([])
    const [read] = await Promise.all([
      world.run(owner, {
        label: 'unsupported-readonly-directory',
        calls: [{ name: 'working_directory', arguments: {} }],
      }),
      allowOnce(page, 'working_directory'),
    ])
    expect(callResult(read, 'working_directory')).toMatchObject({ isError: false })
    expect(callResult(read, 'working_directory').text).toContain(originalCwd)
    expect(lifecycle(originalCwd).filter((event) => event.kind === 'error')).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await world.close()
    }
  }
}, 90_000)
