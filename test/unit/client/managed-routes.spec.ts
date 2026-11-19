import { expect, it, vi } from 'vitest'
import type { AcpOwnedRoutesView } from '../../../src/contract/remote.ts'
import { ManagedAcpRouteCatalog } from '../../../src/client/data/managed-routes.ts'

it('withdraws live controls when a registered route survives only in history', async () => {
  const read = vi
    .fn<() => Promise<AcpOwnedRoutesView>>()
    .mockResolvedValueOnce({ providers: ['acp-agent'], historicalProviders: [] })
    .mockResolvedValueOnce({ providers: [], historicalProviders: ['acp-agent'] })
  const catalog = new ManagedAcpRouteCatalog(read)
  const observed: boolean[] = []
  const unsubscribe = catalog.store.subscribe(() => observed.push(catalog.owns('acp-agent')))

  await catalog.refresh()
  expect(catalog.owns('acp-third-party')).toBe(false)
  await catalog.refresh()
  expect(observed).toEqual([true, false])
  expect(catalog.store.getSnapshot().historicalProviders).toEqual(['acp-agent'])
  unsubscribe()
})

it('ignores a late authority reply from before reconnect or disposal', async () => {
  const old = Promise.withResolvers<AcpOwnedRoutesView>()
  const latest = Promise.withResolvers<AcpOwnedRoutesView>()
  const read = vi
    .fn<() => Promise<AcpOwnedRoutesView>>()
    .mockResolvedValueOnce({ providers: ['acp-old'], historicalProviders: [] })
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ providers: ['acp-new'], historicalProviders: [] })
    .mockReturnValueOnce(latest.promise)
  const catalog = new ManagedAcpRouteCatalog(read)
  await catalog.refresh()
  const pending = catalog.refresh()
  catalog.reset()
  expect(catalog.owns('acp-old')).toBe(false)
  old.resolve({ providers: ['acp-old'], historicalProviders: [] })
  await pending
  expect(catalog.owns('acp-old')).toBe(false)
  expect(catalog.owns('acp-new')).toBe(true)

  const stopped = catalog.refresh()
  catalog.dispose()
  latest.resolve({ providers: ['acp-new'], historicalProviders: [] })
  await stopped
  expect(catalog.owns('acp-new')).toBe(false)
})

it('fails closed while routes are unavailable and restores authority without another adapter event', async () => {
  vi.useFakeTimers()
  const routes = { providers: ['acp-old'], historicalProviders: [] }
  const read = vi
    .fn<() => Promise<AcpOwnedRoutesView>>()
    .mockResolvedValueOnce(routes)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(routes)
    .mockRejectedValue(new Error('offline'))
  const catalog = new ManagedAcpRouteCatalog(read)
  try {
    await catalog.refresh()
    await catalog.refresh()
    expect(catalog.owns('acp-old')).toBe(false)
    await vi.runAllTimersAsync()
    expect(catalog.owns('acp-old')).toBe(true)
    await catalog.refresh()
    await vi.runAllTimersAsync()
    expect(read).toHaveBeenCalledTimes(7)
    expect(catalog.owns('acp-old')).toBe(false)
    catalog.reset()
    await Promise.resolve()
    catalog.dispose()
    await vi.runAllTimersAsync()
    expect(read).toHaveBeenCalledTimes(8)
  } finally {
    catalog.dispose()
    vi.useRealTimers()
  }
})
