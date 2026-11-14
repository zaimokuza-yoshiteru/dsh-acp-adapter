import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { AcpSessionFacts } from '../../../src/host/composition/session-facts.ts'
import { installWorkingDirectoryGuard } from '../../../src/host/composition/working-directory-guard.ts'

const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const NativeDirectoryTool = await import(
  pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-working-directory')).href
)
const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture({ requested = true, provider = 'acp-demo' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-directory-admission-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const origin = join(root, 'origin')
  const target = join(root, 'target')
  await mkdir(origin)
  await mkdir(target)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: origin })
  await ctx.plugin(ToolRuntime)
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  await ctx.plugin(NativeDirectoryTool)
  const session = ctx.sessions.create(SessionId('directory-access'), { meta: { cwd: origin } })
  if (requested)
    session.append('request/header', { header: { config: { provider, model: 'fixture' } }, reason: 'initial' })
  const notices: unknown[] = []
  let status = 'running'
  const agent = {
    id: session.id,
    session,
    ctx,
    options: { provider },
    get status() {
      return status
    },
    inject: (value: unknown) => notices.push(value),
  } as unknown as Agent
  const workingDirectoryChangeDenial = vi.fn(
    (): string | undefined => 'ACP_WORKING_DIRECTORY_UNSUPPORTED: fork is unavailable',
  )
  const adapterFor = vi.fn((): { workingDirectoryChangeDenial: typeof workingDirectoryChangeDenial } | undefined => ({
    workingDirectoryChangeDenial,
  }))
  const readBinding = vi.fn(async (): Promise<unknown | undefined> => (requested ? { status: 'ok' } : undefined))
  const guard = await ctx.plugin((scope) => installWorkingDirectoryGuard(scope, adapterFor, readBinding))
  return {
    root,
    origin,
    target,
    ctx,
    session,
    agent,
    notices,
    guard,
    adapterFor,
    workingDirectoryChangeDenial,
    readBinding,
    idle: () => {
      status = 'idle'
    },
    changes: () => session.snapshotEvents().filter((event) => event.type === 'working-directory/change'),
  }
}

describe('native working-directory/access admission', () => {
  it('keeps first ensure and an unbound first selection available before the first ACP prompt', async () => {
    const f = await fixture({ requested: false })
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.origin)
    await expect(f.ctx.workingDirectory.set(f.agent, '../target')).resolves.toBe(f.target)
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.target)
    expect(f.readBinding).toHaveBeenCalledTimes(1)
    expect(f.adapterFor).not.toHaveBeenCalled()
    expect(f.notices).toHaveLength(1)
  })

  it('allows a same-directory relative path and query but rejects direct changes before commit', async () => {
    const f = await fixture()
    await expect(f.ctx.workingDirectory.set(f.agent, '.')).resolves.toBe(f.origin)
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.origin)
    expect(f.adapterFor).not.toHaveBeenCalled()
    const error = await f.ctx.workingDirectory.set(f.agent, '../target').catch((error: unknown) => error)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED' })
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.origin)
    expect(f.changes()).toEqual([])
    expect(f.notices).toEqual([])
  })

  it('uses the same admission from the published working_directory tool without preempting harmless cd', async () => {
    const f = await fixture()
    const call = (cd: string) =>
      f.ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId(`cd-${cd}`),
            name: 'working_directory',
            arguments: JSON.stringify({ cd }),
          },
        ],
        agent: f.agent,
        signal: new AbortController().signal,
      })
    expect((await call('.')).results[0]?.result.isError).toBe(false)
    expect((await call('../target')).results[0]?.result.isError).toBe(true)
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.origin)
    expect(f.notices).toEqual([])
  })

  it.each(['unsupported', 'unavailable'] as const)(
    'retains structured %s checkout denial through the native tool runtime without running the body',
    async (kind) => {
      const f = await fixture()
      if (kind === 'unavailable') f.adapterFor.mockReturnValue(undefined)
      const execute = vi.fn(async () => 'created')
      f.ctx.tools.register(
        defineTool({
          name: 'create_worktree',
          description: 'Create a checkout.',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
          execute,
        }),
      )
      const result = await f.ctx.tools.execute({
        calls: [{ type: 'tool-call', id: ToolCallId('checkout'), name: 'create_worktree', arguments: '{}' }],
        agent: f.agent,
        signal: new AbortController().signal,
      })
      expect(result.results[0]?.result).toMatchObject({
        isError: true,
        error: {
          info: {
            name: 'HarnessError',
            code: kind === 'unsupported' ? 'ACP_WORKING_DIRECTORY_UNSUPPORTED' : 'ACP_WORKING_DIRECTORY_UNAVAILABLE',
          },
        },
      })
      expect(execute).not.toHaveBeenCalled()
      expect(f.changes()).toEqual([])
      expect(f.notices).toEqual([])
    },
  )

  it('rejects idle bound transitions even when a live runtime advertises fork', async () => {
    const f = await fixture()
    f.workingDirectoryChangeDenial.mockReturnValue(undefined)
    f.idle()
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).rejects.toMatchObject({
      code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED',
    })
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.origin)
    expect(f.notices).toEqual([])
  })

  it('allows the existing supported running handoff and guards ensure recovery before it changes the path', async () => {
    const f = await fixture()
    f.workingDirectoryChangeDenial.mockReturnValue(undefined)
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).resolves.toBe(f.target)
    expect(f.notices).toHaveLength(1)
    await rm(f.target, { recursive: true })
    f.idle()
    await expect(f.ctx.workingDirectory.ensure(f.agent)).rejects.toMatchObject({
      code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED',
    })
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.target)
    expect(f.notices).toHaveLength(1)
  })

  it('retains native missing-path errors and excludes native routes', async () => {
    const f = await fixture()
    await expect(f.ctx.workingDirectory.set(f.agent, '')).rejects.toMatchObject({ code: 'WORKING_DIRECTORY_INVALID' })
    await expect(f.ctx.workingDirectory.set(f.agent, 'missing')).rejects.toMatchObject({
      code: 'WORKING_DIRECTORY_NOT_FOUND',
    })
    expect(f.adapterFor).not.toHaveBeenCalled()
    const native = await fixture({ provider: 'deepseek' })
    await expect(native.ctx.workingDirectory.set(native.agent, native.target)).resolves.toBe(native.target)
    expect(native.adapterFor).not.toHaveBeenCalled()
    expect(native.readBinding).not.toHaveBeenCalled()
  })

  it('does not mistake a saved binding or unavailable binding storage for a fresh Session', async () => {
    const f = await fixture({ requested: false })
    f.readBinding.mockResolvedValue({ status: 'ok' })
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).rejects.toMatchObject({
      code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED',
    })
    const cause = new Error('test storage unavailable')
    f.readBinding.mockRejectedValue(cause)
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).rejects.toMatchObject({
      code: 'ACP_WORKING_DIRECTORY_UNAVAILABLE',
      cause,
    })
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.origin)
    expect(f.notices).toEqual([])
  })

  it('compares physical directory identity instead of rejecting an equivalent symlink spelling', async () => {
    const f = await fixture()
    const alias = join(f.root, 'alias')
    await symlink(f.origin, alias, process.platform === 'win32' ? 'junction' : 'dir')
    f.session.append('working-directory/change', { cwd: alias })
    await expect(f.ctx.workingDirectory.set(f.agent, '.')).resolves.toBe(f.origin)
    expect(f.adapterFor).not.toHaveBeenCalled()
  })

  it.each(['route', 'unregister', 'replace'] as const)(
    'refuses a %s change while checking an initially unbound Session',
    async (change) => {
      const f = await fixture({ requested: false })
      let registered: Agent | undefined = f.agent
      f.ctx.provide('agents', { get: () => registered } as never)
      const reading = Promise.withResolvers<void>()
      const binding = Promise.withResolvers<unknown | undefined>()
      f.readBinding.mockImplementation(() => {
        reading.resolve()
        return binding.promise
      })
      const pending = f.ctx.workingDirectory.set(f.agent, f.target)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'ACP_WORKING_DIRECTORY_UNAVAILABLE' })
      await reading.promise
      if (change === 'route')
        f.session.append('request/header', {
          header: { config: { provider: 'acp-other', model: 'fixture' } },
          reason: 'initial',
        })
      else if (change === 'unregister') registered = undefined
      else registered = { ...f.agent } as Agent
      binding.resolve(undefined)
      await rejected
      expect(f.ctx.workingDirectory.get(f.session)).toBe(f.origin)
      expect(f.notices).toEqual([])
    },
  )

  it('admits native unpublished child setup only with no request and no saved binding', async () => {
    const f = await fixture({ requested: false })
    f.ctx.provide('agents', { get: () => undefined } as never)
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).resolves.toBe(f.target)
    expect(f.readBinding).toHaveBeenCalledTimes(1)
    expect(f.adapterFor).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'uses child-owned request facts during a real seeded Agent setup (saved binding: %s)',
    async (savedBinding) => {
      const f = await fixture()
      await f.ctx.plugin(LlmRuntime)
      await f.ctx.plugin(AgentRegistry)
      await f.ctx.plugin(AcpSessionFacts)
      await mountAgentLoopTestHarness(f.ctx)
      f.readBinding.mockResolvedValue(savedBinding ? { status: 'ok' } : undefined)
      let child: Agent | undefined
      const created = f.ctx.agents.create({
        sessionId: SessionId('seeded-directory-child'),
        meta: { cwd: f.origin, isSeeded: true, parentSession: f.session.id },
        seed: f.session.snapshotEvents(),
        inheritedEventCount: f.session.seq,
        agentOptions: { provider: 'acp-demo', model: 'fixture' },
        setup: async (_scope, agent) => {
          child = agent
          expect(f.ctx.agents.get(agent.id)).toBeUndefined()
          expect(agent.session.requestHeader()?.config.provider).toBe('acp-demo')
          expect(f.ctx.acpSessionFacts.read(agent.session).soleRequestProvider).toBeNull()
          await f.ctx.workingDirectory.set(agent, f.target)
        },
      })
      if (savedBinding) {
        await expect(created).rejects.toMatchObject({ code: 'ACP_WORKING_DIRECTORY_UNAVAILABLE' })
        expect(f.ctx.workingDirectory.get(child!.session)).toBe(f.origin)
        expect(f.ctx.agents.get(child!.id)).toBeUndefined()
      } else {
        const handle = await created
        expect(f.ctx.agents.get(handle.agent.id)).toBe(handle.agent)
        expect(f.ctx.workingDirectory.get(handle.agent.session)).toBe(f.target)
        await handle.dispose()
      }
      expect(f.readBinding).toHaveBeenCalledExactlyOnceWith(SessionId('seeded-directory-child'))
      expect(f.adapterFor).not.toHaveBeenCalled()
    },
  )

  it('withdraws its access hook when the plugin unloads', async () => {
    const f = await fixture()
    await f.guard.dispose()
    await expect(f.ctx.workingDirectory.set(f.agent, f.target)).resolves.toBe(f.target)
  })
})
