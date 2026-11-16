import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionCreateError } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { independentHistoryNavigation } from '../../../src/client/coordinator/native-session-navigation.ts'

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
  const start = independentHistoryNavigation(
    { create },
    () => ({ workspaceId: 'workspace' }),
    open,
    async () => 'missing',
  )
  expect(await start(source, current, false)).toBe('ungrouped')
  expect(open).not.toHaveBeenCalled()
  expect(await start(source, current, true)).toBe('ungrouped-open-failed')
  expect(await start(source, current, true)).toBe('idle')
  expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', sessionId: expect.any(String) })
  expect(open.mock.calls).toEqual([[child], [child]])
})

it('retries opening the exact published destination without creating it again', async () => {
  const create = vi.fn().mockResolvedValue(child)
  const open = vi.fn().mockImplementationOnce(() => {
    throw new Error('offline')
  })
  const start = independentHistoryNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    async () => 'missing',
  )
  expect(await start(source, current, false)).toBe('open-failed')
  expect(await start(source, current, false)).toBe('idle')
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: '/work', sessionId: expect.any(String) })
  expect(open.mock.calls).toEqual([[child], [child]])
})

it('does not open a stale child and reuses it if the user returns and asks again', async () => {
  const created = Promise.withResolvers<typeof child>()
  const create = vi.fn().mockReturnValue(created.promise)
  const open = vi.fn()
  const start = independentHistoryNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    async () => 'missing',
  )
  let selected = true
  const first = start(source, () => selected, false)
  await start(source, current, false)
  selected = false
  created.resolve(child)
  await first
  await start(source, () => false, false)
  expect(open).not.toHaveBeenCalled()
  await start(source, current, false)
  expect(open).toHaveBeenCalledExactlyOnceWith(child)
  expect(create).toHaveBeenCalledOnce()
})

it('reconciles the preallocated identity after a lost create response', async () => {
  const create = vi.fn().mockRejectedValue(new Error('transport closed'))
  const reconcile = vi.fn().mockResolvedValue('created')
  const open = vi.fn()
  const start = independentHistoryNavigation({ create }, () => ({ workspaceId: 'workspace' }), open, reconcile)
  expect(await start(source, current, false)).toBe('create-failed')
  const requested = create.mock.calls[0]![0].sessionId
  expect(await start(source, current, false)).toBe('idle')
  expect(open).toHaveBeenCalledExactlyOnceWith(requested)
  expect(create).toHaveBeenCalledOnce()
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(requested, { workspaceId: 'workspace' })
})

it('reuses the reserved identity when a fresh baseline confirms creation did not complete', async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error('transport closed')).mockResolvedValueOnce(child)
  const open = vi.fn()
  const start = independentHistoryNavigation(
    { create },
    () => ({ cwd: '/work' }),
    open,
    async () => 'missing',
  )
  expect(await start(source, current, false)).toBe('create-failed')
  expect(await start(source, current, false)).toBe('idle')
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
  expect(open).toHaveBeenCalledExactlyOnceWith(child)
})
