import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { installExternalChildCatalog } from '../../../src/host/subagent/catalog-publication.ts'

function fixture() {
  const rows: { id: string }[] = []
  const events: unknown[] = []
  let loaded = false, available = false
  let created!: (session: Session) => void, injected!: () => void, dispose!: () => void
  const parent = { id: 'parent', append(type: string, data: { childId: string }) {
    events.push({ type, data }); rows.push({ id: data.childId })
  } } as Session
  const flush = vi.fn(async () => true)
  const ctx = {
    effect: (setup: () => () => void) => { dispose = setup() },
    on: (_event: string, fn: typeof created) => { created = fn },
    inject: (_keys: string[], fn: typeof injected) => { injected = fn },
    logger: { warn: vi.fn() },
    sessionProjections: { snapshot: () => ({ values: { subagentCatalog: available ? rows : undefined } }) },
  } as unknown as Context
  const publish = installExternalChildCatalog(ctx, { get: () => loaded ? parent : undefined, flush })
  const header = (id: string) => ({ id, parentSession: 'parent', createdAt: 123 }) as SessionHeader
  return { events, rows, flush, publish, header, dispose: () => dispose(),
    load() { loaded = true; created(parent) }, enable() { available = true; injected() } }
}

it('publishes queued children when the parent and native catalog become available, without activating an Agent', async () => {
  const f = fixture()
  await f.publish(f.header('child'), 'Worker')
  expect(f.events).toEqual([])
  f.load()
  await Promise.resolve()
  expect(f.events).toEqual([])
  f.enable()
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
  expect(f.events).toEqual([{ type: 'subagent/catalog', data: { version: 0, childId: 'child', childCreatedAt: 123, mode: 'one-shot', label: 'Worker' } }])
  await f.publish(f.header('child'), 'Worker')
  expect(f.events).toHaveLength(1)
  f.dispose()
  await f.publish(f.header('ignored'), 'Disposed')
  expect(f.events).toHaveLength(1)
})

it('serializes concurrent publications and retries a failed flush without duplicating discovery facts', async () => {
  const f = fixture()
  f.load(); f.enable()
  await new Promise(resolve => setTimeout(resolve, 0))
  f.flush.mockResolvedValueOnce(false)
  await expect(f.publish(f.header('one'), 'One')).rejects.toThrow('NOT_DURABLE')
  await Promise.all([f.publish(f.header('one'), 'One'), f.publish(f.header('two'), 'Two')])
  expect(f.rows).toEqual([{ id: 'one' }, { id: 'two' }])
  f.dispose()
})
