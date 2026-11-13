import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionToken, ToolGuard } from '@deepseek-ai/dsh-tools'
import { installWorkingDirectoryGuard } from '../../../src/host/composition/working-directory-guard.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

// Only the guard registration seam is substituted. Cordis owns dependency
// availability, scoped effects, unloading, and remounting in these tests.
class GuardToolsSeam extends Service {
  constructor(
    ctx: Context,
    private readonly guards: Set<ToolGuard>,
  ) {
    super(ctx, 'tools')
  }

  guard(guard: ToolGuard): () => void {
    return this.ctx.effect(() => {
      this.guards.add(guard)
      return () => {
        this.guards.delete(guard)
      }
    })
  }
}

function harness(denial: string | undefined = 'ACP_WORKING_DIRECTORY_UNSUPPORTED: fork is unavailable') {
  const ctx = new Context()
  contexts.push(ctx)
  const guards = new Set<ToolGuard>()
  const workingDirectoryChangeDenial = vi.fn((): string | undefined => denial)
  const adapterFor = vi.fn((): { workingDirectoryChangeDenial: typeof workingDirectoryChangeDenial } | undefined => ({
    workingDirectoryChangeDenial,
  }))
  installWorkingDirectoryGuard(ctx, adapterFor)
  return {
    ctx,
    guards,
    adapterFor,
    workingDirectoryChangeDenial,
    mount: () => ctx.plugin(GuardToolsSeam, guards),
    check: (execution: ToolExecution) => {
      expect(guards.size).toBe(1)
      return [...guards][0]!(execution)
    },
  }
}

function execution(name: string, args: unknown, provider = 'acp-demo', withHeader = true): ToolExecution {
  const session = Session.create(SessionId('guard-session'))
  if (withHeader)
    session.append('request/header', {
      header: { config: { provider, model: 'fixture-model' } },
      reason: 'initial',
    })
  // The guard only reads the initiator identity and its real Session projection.
  const agent = { id: session.id, session, options: { provider } } as unknown as Agent
  const callId = ToolCallId('guard-call')
  return {
    callId,
    rootCallId: callId,
    token: Symbol('guard-execution') as ToolExecutionToken,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

describe('installWorkingDirectoryGuard()', () => {
  it('waits for Tools, removes its scoped guard on unload, and installs it once on remount', async () => {
    const h = harness()
    expect(h.guards.size).toBe(0)

    const first = await h.mount()
    await expect.poll(() => h.guards.size).toBe(1)
    expect(h.check(execution('create_worktree', {}))).toMatchObject({
      info: { name: 'HarnessError', code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED' },
    })
    await first.dispose()
    await expect.poll(() => h.guards.size).toBe(0)

    await h.mount()
    await expect.poll(() => h.guards.size).toBe(1)
    expect(h.check(execution('create_worktree', {}))).toMatchObject({
      info: { name: 'HarnessError', code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED' },
    })
  })

  it('does not consult an ACP adapter for native routes or calls without an initiator', async () => {
    const h = harness()
    await h.mount()

    expect(h.check(execution('create_worktree', {}, 'deepseek'))).toBeUndefined()
    expect(h.check(execution('working_directory', { cd: '/target' }, 'deepseek'))).toBeUndefined()
    const { agent, ...withoutInitiator } = execution('create_worktree', {})
    expect(agent).toBeDefined()
    expect(h.check(withoutInitiator)).toBeUndefined()
    expect(h.adapterFor).not.toHaveBeenCalled()
  })

  it('vetoes checkout creation before Git effects with the owning adapter denial', async () => {
    const h = harness()
    await h.mount()

    for (const call of [execution('create_worktree', {})]) {
      expect(h.check(call)).toEqual({
        reason: 'ACP_WORKING_DIRECTORY_UNSUPPORTED: fork is unavailable',
        info: { name: 'HarnessError', code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED' },
      })
      expect(h.workingDirectoryChangeDenial).toHaveBeenLastCalledWith(call.agent!.id, call.agent!.session)
    }
    expect(h.adapterFor).toHaveBeenCalledTimes(1)
    expect(h.adapterFor).toHaveBeenLastCalledWith('demo')
  })

  it('uses the configured provider before the first request header without affecting native routes', async () => {
    const h = harness()
    await h.mount()

    const acp = execution('create_worktree', {}, 'acp-demo', false)
    expect(acp.agent!.session.requestHeader()).toBeUndefined()
    expect(h.check(acp)).toMatchObject({
      info: { name: 'HarnessError', code: 'ACP_WORKING_DIRECTORY_UNSUPPORTED' },
    })
    expect(h.workingDirectoryChangeDenial).toHaveBeenCalledWith(acp.agent!.id, acp.agent!.session)
    h.adapterFor.mockClear()
    expect(h.check(execution('create_worktree', {}, 'deepseek', false))).toBeUndefined()
    expect(h.check(execution('working_directory', { cd: '/target' }, 'deepseek', false))).toBeUndefined()
    expect(h.adapterFor).not.toHaveBeenCalled()
  })

  it('allows directory changes only when the ACP adapter accepts them, and vetoes a missing adapter', async () => {
    const h = harness()
    h.workingDirectoryChangeDenial.mockReturnValue(undefined)
    await h.mount()

    expect(h.check(execution('create_worktree', {}))).toBeUndefined()
    expect(h.check(execution('working_directory', { cd: '/target' }))).toBeUndefined()
    h.adapterFor.mockReturnValue(undefined)
    expect(h.check(execution('create_worktree', {}))).toMatchObject({
      info: { name: 'HarnessError', code: 'ACP_WORKING_DIRECTORY_UNAVAILABLE' },
    })
  })

  it('leaves directory-tool admission and argument validation to the native directory service', async () => {
    const h = harness()
    await h.mount()

    for (const args of [null, [], ['/target'], 42, 'target', {}, { cd: undefined }, { cd: '/target' }]) {
      expect(h.check(execution('working_directory', args))).toBeUndefined()
    }
    expect(h.check(execution('read_file', { path: '/file' }))).toBeUndefined()
    expect(h.adapterFor).not.toHaveBeenCalled()
  })
})
