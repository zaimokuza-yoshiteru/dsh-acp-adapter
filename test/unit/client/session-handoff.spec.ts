import { expect, it, vi } from 'vitest'
import { SessionHandoffClient, type HandoffRequest } from '../../../src/client/coordinator/session-handoff.ts'
import type { AcpHandoffView } from '../../../src/contract/handoff.ts'

const target = { provider: 'acp-agent', model: 'named-model' }
const starting: AcpHandoffView = {
  revision: 1,
  id: 'operation',
  sourceSessionId: 'source',
  destinationSessionId: null,
  phase: 'summarizing',
  document: '',
  instruction: '',
  allowHistory: true,
  target,
}
const draft: AcpHandoffView = {
  ...starting,
  phase: 'draft',
  destinationSessionId: 'target',
  document: 'Original brief',
}
const success = (value: AcpHandoffView) => ({ ok: true as const, value })
const begin = { kind: 'begin', id: starting.id, target, locale: 'en' } as const

it('opens only a user-started draft once; restoring a draft after reload never steals focus', async () => {
  const request = vi.fn<HandoffRequest>().mockResolvedValueOnce(success(starting)).mockResolvedValue(success(draft))
  const open = vi.fn()
  const client = new SessionHandoffClient(request, open)
  await client.begin('source', begin)
  expect(open).not.toHaveBeenCalled()
  await client.refresh('source')
  await client.refresh('target')
  expect(open).toHaveBeenCalledExactlyOnceWith('source', 'target')
  expect(client.draftDestinations()).toEqual(['target'])
  const restored = new SessionHandoffClient(request, open)
  await restored.refresh('target')
  expect(restored.get('target')?.document).toBe('Original brief')
  expect(request).toHaveBeenLastCalledWith('target', { kind: 'status' })
  expect(open).toHaveBeenCalledTimes(1)
})

it.each([true, false])(
  'finishes an automatic switch through reconnect when the user stays in the source: %s',
  async (stays) => {
    vi.useFakeTimers()
    const open = vi.fn()
    const navigation = new AbortController()
    const request = vi
      .fn<HandoffRequest>()
      .mockResolvedValueOnce(success(starting))
      .mockResolvedValue(success({ ...draft, phase: 'queued' }))
    const client = new SessionHandoffClient(request, open, () => navigation.signal)
    try {
      await client.begin('source', { ...begin, automatic: true })
      if (!stays) navigation.abort()
      client.reconnect()
      await vi.advanceTimersByTimeAsync(1200)
      expect(client.get('target')?.phase).toBe('queued')
      expect(request).toHaveBeenCalledTimes(2)
      expect(open).toHaveBeenCalledTimes(stays ? 1 : 0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  },
)

it('a late source poll cannot restore the editor after a cancellation in the target', async () => {
  const late = Promise.withResolvers<Awaited<ReturnType<HandoffRequest>>>()
  const request = vi
    .fn<HandoffRequest>()
    .mockResolvedValueOnce(success(draft))
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce(success({ ...draft, phase: 'cancelled' }))
  const client = new SessionHandoffClient(request, vi.fn())
  await client.refresh('target')
  const read = client.refresh('source')
  await client.change('target', { kind: 'cancel', id: draft.id })
  late.resolve(success(draft))
  await read
  expect(client.get('source')?.phase).toBe('cancelled')
  expect(client.draftDestinations()).toEqual([])
})

it('serializes a final document, instruction and history choice after a slow autosave', async () => {
  const save = Promise.withResolvers<Awaited<ReturnType<HandoffRequest>>>()
  const request = vi
    .fn<HandoffRequest>()
    .mockReturnValueOnce(save.promise)
    .mockResolvedValueOnce(success({ ...draft, phase: 'queued', revision: 3 }))
  const client = new SessionHandoffClient(request, vi.fn())
  const revision = { current: 1 }
  const earlier = client.change(
    'target',
    {
      kind: 'save',
      id: draft.id,
      revision: 1,
      document: 'early',
      instruction: '',
      allowHistory: true,
    },
    revision,
  )
  const final = {
    kind: 'send',
    id: draft.id,
    revision: 1,
    document: 'edited',
    instruction: 'continue here',
    allowHistory: false,
  } as const
  const sent = client.change('target', final, revision)
  expect(request).toHaveBeenCalledTimes(1)
  save.resolve(success({ ...draft, revision: 2 }))
  await Promise.all([earlier, sent])
  expect(request).toHaveBeenLastCalledWith('target', { ...final, revision: 2 })
  expect(client.get('target')?.phase).toBe('queued')
})

it.each(['navigated', 'disconnected'] as const)(
  'keeps the ready draft accessible without changing the active pane after the user %s',
  async (reason) => {
    const request = vi.fn<HandoffRequest>().mockResolvedValueOnce(success(starting)).mockResolvedValue(success(draft))
    const open = vi.fn()
    const navigation = new AbortController()
    const client = new SessionHandoffClient(request, open, () => navigation.signal)
    await client.begin('source', begin)
    if (reason === 'navigated') navigation.abort()
    else client.reconnect()
    await client.refresh('source')
    expect(open).not.toHaveBeenCalled()
    expect(client.get('source')?.destinationSessionId).toBe('target')
    expect(client.draftDestinations()).toEqual(['target'])
  },
)

it('keeps the first conversation quiet and exposes a completed source document if its destination disappears', async () => {
  const request = vi.fn<HandoffRequest>().mockResolvedValueOnce(
    success({
      ...starting,
      document: 'Finished summary',
      phase: 'interrupted',
    }),
  )
  const client = new SessionHandoffClient(request, vi.fn())
  const { HandoffDock } = await import('../../../src/client/ui/SessionHandoff.ts')
  const dock = () =>
    HandoffDock({
      client,
      sessionId: 'source',
      useAccess: () => true,
      useSessions: () => false,
      access: () => ({ getSnapshot: () => true, subscribe: () => () => {} }),
      useSessionRetainInfo: () => true,
      t: (key: string) => key,
    } as never)
  expect(dock()).toBeNull()
  await client.refresh('source')
  const tree = dock() as {
    props: { children: { type: string; props: { children: { props: { value?: string; readOnly?: boolean } }[] } }[] }
  }
  const retained = tree.props.children.find((item) => item && item.type === 'details')!
  expect(retained.props.children[1]?.props).toMatchObject({ value: 'Finished summary', readOnly: true })
})

it('keeps an editor on a network failure but withdraws cached documents after authoritative absence or denial', async () => {
  for (const result of [
    { ok: true, value: null },
    { ok: false, error: { code: 'dsh-acp/user-rejected', message: 'denied' } },
  ] as const) {
    const request = vi
      .fn<HandoffRequest>()
      .mockResolvedValueOnce(success(draft))
      .mockRejectedValueOnce(new Error('Network interrupted'))
      .mockResolvedValueOnce(result)
    const client = new SessionHandoffClient(request, vi.fn())
    await client.refresh('source')
    await expect(client.refresh('target')).rejects.toThrow('Network interrupted')
    expect(client.draftDestinations()).toEqual(['target'])
    await client.refresh('target').catch(() => {})
    expect(client.get('source')).toBeUndefined()
    expect(client.get('target')).toBeUndefined()
    expect(client.draftDestinations()).toEqual([])
  }
})

it('reconnect reads current endpoints and ignores an earlier connection response', async () => {
  const late = Promise.withResolvers<Awaited<ReturnType<HandoffRequest>>>()
  const next = { ...draft, id: 'second', destinationSessionId: 'secondTarget' }
  const request = vi
    .fn<HandoffRequest>()
    .mockResolvedValueOnce(success({ ...draft, phase: 'completed' }))
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce(success(next))
  const client = new SessionHandoffClient(request, vi.fn())
  await client.refresh('source')
  const old = client.refresh('source')
  client.reconnect()
  await client.refresh('source')
  expect(request).toHaveBeenLastCalledWith('source', { kind: 'status' })
  late.resolve(success(draft))
  await old
  expect(client.get('source')?.id).toBe(next.id)
  expect(client.draftDestinations()).toEqual(['secondTarget'])
})

it('withdraws the old target editor when the source reports that the target was removed', async () => {
  const request = vi
    .fn<HandoffRequest>()
    .mockResolvedValueOnce(success(draft))
    .mockResolvedValueOnce(success({ ...draft, destinationSessionId: null, phase: 'interrupted', revision: 2 }))
  const client = new SessionHandoffClient(request, vi.fn())
  await client.refresh('target')
  await client.refresh('source')
  expect(client.get('source')?.document).toBe(draft.document)
  expect(client.get('target')).toBeUndefined()
  expect(client.draftDestinations()).toEqual([])
})

it('does not restore a revoked draft from a late write or dispatch a queued edit', async () => {
  const late = Promise.withResolvers<Awaited<ReturnType<HandoffRequest>>>()
  const request = vi
    .fn<HandoffRequest>()
    .mockResolvedValueOnce(success(draft))
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({ ok: false, error: { code: 'remote-access/denied', message: 'Access withdrawn' } })
  const client = new SessionHandoffClient(request, vi.fn())
  await client.refresh('target')
  const edit = {
    kind: 'save',
    id: draft.id,
    revision: 1,
    document: 'private',
    instruction: '',
    allowHistory: true,
  } as const
  const first = client.change('target', edit)
  const queued = client.change('target', edit)
  await expect(client.refresh('source')).rejects.toThrow('Access withdrawn')
  late.resolve(success({ ...draft, revision: 2 }))
  for (const result of await Promise.allSettled([first, queued])) expect(result.status).toBe('rejected')
  expect(request).toHaveBeenCalledTimes(3)
  expect(client.get('source')).toBeUndefined()
  expect(client.draftDestinations()).toEqual([])
})

it('uses the editor’s last accepted revision when discarding behind a pending save', async () => {
  const save = Promise.withResolvers<Awaited<ReturnType<HandoffRequest>>>()
  const request = vi
    .fn<HandoffRequest>()
    .mockReturnValueOnce(save.promise)
    .mockResolvedValueOnce(success({ ...draft, phase: 'cancelled', revision: 3 }))
  const client = new SessionHandoffClient(request, vi.fn()),
    revision = { current: 1 }
  const earlier = client.change(
    'target',
    { kind: 'save', id: draft.id, revision: 1, document: 'edited', instruction: '', allowHistory: false },
    revision,
  )
  const cancel = client.change('target', { kind: 'cancel', id: draft.id, revision: 1 }, revision)
  save.resolve(success({ ...draft, revision: 2 }))
  await Promise.all([earlier, cancel])
  expect(request).toHaveBeenLastCalledWith('target', { kind: 'cancel', id: draft.id, revision: 2 })
  expect(client.get('target')?.phase).toBe('cancelled')
})
