import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpActivityView } from '../../../src/contract/remote.ts'
import { AcpActivityJournalHub } from '../../../src/client/data/activity-journal.ts'

const large: AcpActivityView = {
  dshSessionId: 'session', ownerDshSessionId: 'session', promptAnchorMessageId: 'prompt',
  activityId: 'edit', activitySeq: 1, revisionSeq: 1, time: 1, kind: 'diff', status: 'completed', presentation: 'Edit large file',
  rawDetail: '{"toolKind":"edit"}', display: { diffs: [{ path: '/file', oldText: 'before\n'.repeat(4000), newText: 'after\n'.repeat(4000) }] },
}

function service() {
  const rows = [large, { ...large, revisionSeq: 2, display: { diffs: [{ path: '/file', oldText: '', newText: 'new revision' }] } }]
  let listener: (row: AcpActivityView) => void = () => undefined
  const page = vi.fn(async (_id: string, after: number, limit: number) => rows.filter(row => row.revisionSeq > after).slice(0, limit))
  const remote = new AcpRemoteService(new Context(), {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined }, resolveLiveAgent: () => undefined,
    activityAccess: id => id === 'session',
    activityTimeline: { snapshot: async () => [large], page, head: async () => 1, subscribe: (_id, _filter, notify) => { listener = notify; return () => undefined } },
  })
  return { remote, page, emit: (row: AcpActivityView) => listener(row) }
}

it('defers large content in snapshots, repair pages, opening and live frames; preserves exact detail revisions', async () => {
  const { remote, emit } = service()
  const assertLean = (row: AcpActivityView) => {
    expect(row).toMatchObject({ detailDeferred: true, rawDetail: large.rawDetail, revisionSeq: 1 })
    expect(row.display).toBeUndefined()
    expect(JSON.stringify(row).length).toBeLessThan(1000)
  }
  assertLean((await remote.activitySnapshot('session')).activities[0]!)
  assertLean((await remote.activityPage('session', { limit: 1 })).activities[0]!)
  const abort = new AbortController()
  const stream = remote.activityFollow('session', undefined, abort.signal)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.value?.type !== 'opened') throw new Error('opening missing')
  assertLean(first.value.activities[0]!)
  emit({ ...large, revisionSeq: 3 })
  const live = await stream.next()
  expect(live.value).toMatchObject({ type: 'entry', activity: { detailDeferred: true, revisionSeq: 3 } })
  abort.abort()
  await stream.next()
  expect(await remote.activityDetail('session', { activityId: 'edit', ownerDshSessionId: 'session', revisionSeq: 1 })).toEqual(large)
  expect((await remote.activityDetail('session', { activityId: 'edit', ownerDshSessionId: 'session', revisionSeq: 2 })).display?.diffs?.[0]?.newText).toBe('new revision')
})

it('authorizes before reading and rejects wrong owner, activity, missing or invalid revision', async () => {
  const { remote, page } = service()
  const request = { activityId: 'edit', ownerDshSessionId: 'session', revisionSeq: 1 }
  await expect(remote.activityDetail('other', request)).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
  expect(page).not.toHaveBeenCalled()
  for (const patch of [{ ownerDshSessionId: 'other' }, { activityId: 'other' }, { revisionSeq: 3 }, { revisionSeq: 0 }]) {
    await expect(remote.activityDetail('session', { ...request, ...patch })).rejects.toBeDefined()
  }
})

describe('detail request lifecycle', () => {
  it('deduplicates concurrent reads but permits retry after a failure', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ok: false, error: new Error('offline') }).mockResolvedValue({ ok: true, value: large })
    const hub = new AcpActivityJournalHub({ activityDetail: read } as never, {} as never)
    const first = hub.detail(large)
    expect(hub.detail(large)).toBe(first)
    await expect(first).rejects.toThrow('offline')
    await expect(hub.detail(large)).resolves.toEqual(large)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('refuses stale or foreign detail responses', async () => {
    for (const patch of [{ revisionSeq: 2 }, { activityId: 'other' }, { ownerDshSessionId: 'other' }, { dshSessionId: 'other' }]) {
      const hub = new AcpActivityJournalHub({ activityDetail: async () => ({ ok: true, value: { ...large, ...patch } }) } as never, {} as never)
      await expect(hub.detail(large)).rejects.toThrow('identity mismatch')
    }
  })
})
