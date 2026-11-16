import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionCreateError } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  DefaultPresetRepair,
  independentSessionNavigation,
  reconcileIndependentChild,
} from '../../../src/client/coordinator/native-session-navigation.ts'

const source = SessionId('history')
const child = SessionId('created')
const current = () => true

it('opens the known ungrouped child only on request after a workspace attachment failure', async () => {
  const create = vi.fn().mockRejectedValue(
    new SessionCreateError(
      new RemoteError('session/workspace-attach-failed', 'offline', {
        sessionId: child,
        workspaceId: 'workspace' as never,
      }),
      undefined,
    ),
  )
  const open = vi.fn().mockImplementationOnce(() => {
    throw new Error('offline')
  })
  const start = independentSessionNavigation(
    { create },
    () => ({ workspaceId: 'workspace' }),
    open,
    async () => 'missing',
  )
  expect(await start(source, current, 'create')).toBe('ungrouped')
  expect(open).not.toHaveBeenCalled()
  expect(await start(source, current, 'open-existing')).toBe('ungrouped-open-failed')
  expect(await start(source, current, 'open-existing')).toBe('idle')
  expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', sessionId: expect.any(String) })
  expect(open.mock.calls).toEqual([[child], [child]])
})

it('retries opening the exact published destination without creating it again', async () => {
  const create = vi.fn().mockResolvedValue(child)
  const open = vi.fn().mockImplementationOnce(() => {
    throw new Error('offline')
  })
  const start = independentSessionNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    async () => 'missing',
  )
  expect(await start(source, current, 'create')).toBe('open-failed')
  expect(await start(source, current, 'create')).toBe('idle')
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: '/work', sessionId: expect.any(String) })
  expect(open.mock.calls).toEqual([[child], [child]])
})

it('does not open a stale child and reuses it if the user returns and asks again', async () => {
  const created = Promise.withResolvers<typeof child>()
  const create = vi.fn().mockReturnValue(created.promise)
  const open = vi.fn()
  const start = independentSessionNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    async () => 'missing',
  )
  let selected = true
  const first = start(source, () => selected, 'create')
  await start(source, current, 'create')
  selected = false
  created.resolve(child)
  await first
  await start(source, () => false, 'create')
  expect(open).not.toHaveBeenCalled()
  await start(source, current, 'create')
  expect(open).toHaveBeenCalledExactlyOnceWith(child)
  expect(create).toHaveBeenCalledOnce()
})

it('reconciles the preallocated identity after a lost create response', async () => {
  const create = vi.fn().mockRejectedValue(new Error('transport closed'))
  const reconcile = vi.fn().mockResolvedValue('created')
  const open = vi.fn()
  const start = independentSessionNavigation({ create }, () => ({ workspaceId: 'workspace' }), open, reconcile)
  expect(await start(source, current, 'create')).toBe('create-unknown')
  const requested = create.mock.calls[0]![0].sessionId
  expect(await start(source, current, 'create')).toBe('idle')
  expect(open).toHaveBeenCalledExactlyOnceWith(requested)
  expect(create).toHaveBeenCalledOnce()
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(requested, { workspaceId: 'workspace' })
})

it('only checks a lost create until the Host publishes the child, including when a ready cache survives a failed pull', async () => {
  const create = vi.fn().mockRejectedValue(new Error('transport closed'))
  const list = vi.fn().mockResolvedValue({ ok: true, value: { items: [] } })
  const projections = vi.fn().mockResolvedValue({ ok: true, value: null })
  const ctx = {
    remote: { session: { list, projections } },
    get: () => ({
      source: () => ({ getSnapshot: () => true }),
      list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) },
    }),
  }
  const open = vi.fn()
  const start = independentSessionNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    (id, setup) => reconcileIndependentChild(ctx as never, id, setup),
  )
  expect(await start(source, current, 'create')).toBe('create-unknown')
  list.mockResolvedValueOnce({ ok: false, error: new Error('offline') })
  await expect(start(source, current, 'create')).rejects.toThrow('offline')
  expect(await start(source, current, 'create')).toBe('create-unknown')
  expect(create).toHaveBeenCalledOnce()
  const requested = create.mock.calls[0]![0].sessionId
  list.mockResolvedValueOnce({
    ok: true,
    value: { items: [{ sessionId: requested, blank: true, agentAvailable: true, cwd: '/work' }] },
  })
  expect(await start(source, current, 'create')).toBe('idle')
  expect(open).toHaveBeenCalledExactlyOnceWith(requested)
  expect(create).toHaveBeenCalledOnce()
})

it('keeps the same child for an explicitly recovered preset that failed after publishing a blank', async () => {
  const create = vi
    .fn()
    .mockRejectedValue(
      new SessionCreateError(
        new RemoteError('agent-preset/invalid', 'broken', { agentPreset: 'cordis', reason: 'unloaded' }),
        undefined,
      ),
    )
  const open = vi.fn()
  const repair = vi.fn(async (_repair, id) => id)
  const start = independentSessionNavigation(
    { create },
    () => ({ workspaceId: 'w', agentPreset: 'cordis' }),
    open,
    async () => 'ungrouped',
    async () => false,
    repair,
  )
  expect(await start(source, current, 'create')).toBe('preset-unavailable')
  const requested = create.mock.calls[0]![0].sessionId
  expect(await start(source, current, 'use-default')).toBe('ungrouped')
  expect(repair).toHaveBeenCalledExactlyOnceWith(expect.anything(), requested, current)
  expect(open).not.toHaveBeenCalled()
  expect(await start(source, current, 'open-existing')).toBe('idle')
  expect(create).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledExactlyOnceWith(requested)
})

it.each(['agent-preset/not-found', 'agent-preset/invalid'] as const)(
  'offers an explicit default only after the Host refuses the recorded mode (%s)',
  async (code) => {
    const refused =
      code === 'agent-preset/not-found'
        ? new RemoteError(code, 'gone', { agentPreset: 'cordis', available: ['standard'] })
        : new RemoteError(code, 'broken', { agentPreset: 'cordis', reason: 'unloaded' })
    const create = vi.fn().mockRejectedValueOnce(new SessionCreateError(refused, undefined)).mockResolvedValue(child)
    const open = vi.fn()
    const start = independentSessionNavigation(
      { create },
      () => ({ workspaceId: 'w', agentPreset: 'cordis' }),
      open,
      async () => 'missing',
    )
    expect(await start(source, current, 'create')).toBe('preset-unavailable')
    expect(await start(source, current, 'create')).toBe('preset-unavailable')
    expect(create).toHaveBeenCalledExactlyOnceWith({
      sessionId: expect.any(String),
      workspaceId: 'w',
      agentPreset: 'cordis',
    })
    expect(open).not.toHaveBeenCalled()
    expect(await start(source, current, 'use-default')).toBe('idle')
    expect(create).toHaveBeenLastCalledWith({ sessionId: create.mock.calls[0]![0].sessionId, workspaceId: 'w' })
    expect(open).toHaveBeenCalledExactlyOnceWith(child)
  },
)

it.each([
  { blank: false, agentAvailable: true },
  { blank: true, running: true },
  { blank: true, origin: 'subagent' },
  { blank: true, parentSessionId: 'parent' },
])('refuses an existing child no longer available as an idle blank main session (%o)', async (row) => {
  const list = vi.fn().mockResolvedValue({ ok: true, value: { items: [{ sessionId: child, ...row }] } })
  const ctx = { remote: { session: { list } } }
  await expect(reconcileIndependentChild(ctx as never, child, { cwd: '/work' })).rejects.toThrow()
})

it('does not use a filtered list omission as proof of a blank or absent child', async () => {
  const list = async () => ({ ok: true, value: { items: [] } })
  const projections = vi.fn(async () => ({
    ok: true,
    value: { kind: 'sequenced', values: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
  }))
  const ctx = {
    remote: { session: { list, projections } },
    get: () => ({ source: () => ({ getSnapshot: () => true }) }),
  }
  await expect(reconcileIndependentChild(ctx as never, child, { cwd: '/work' })).rejects.toThrow(
    'missing from the current list',
  )
})

it('uses exact cold blankness for mode repair and rejects a different published identity', async () => {
  const list = async () => ({
    ok: true,
    value: { items: [{ sessionId: child, blank: false, agentAvailable: false, running: false, cwd: '/work' }] },
  })
  const projections = async () => ({
    ok: true,
    value: { kind: 'sequenced', values: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
  })
  const create = vi.fn().mockResolvedValue('other')
  const ctx = {
    remote: { session: { list, projections } },
    get: (name: string) => (name === 'sessions' ? { create } : undefined),
  }
  const repair = new DefaultPresetRepair()
  await expect(repair.run(ctx as never, child, current)).rejects.toThrow('could not reuse the original')
  await expect(repair.run(ctx as never, child, current)).rejects.toThrow('has not been confirmed')
  expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: child, cwd: '/work' })
})
