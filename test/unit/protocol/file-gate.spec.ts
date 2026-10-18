import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForFileGate } from '../../mock-agent/file-gate.ts'

// Model a watcher whose initial stat adopts the gate as its baseline: no later
// file changes or notifications occur. The durable file must still release it.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}))

let directory: string
let path: string
let cancellation: AbortController

beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'dsh-file-gate-'))
  path = join(directory, 'gate')
  cancellation = new AbortController()
})

afterEach(() => {
  cancellation.abort()
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

function expectReleasedResources() {
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(cancellation.signal, 'abort')).toEqual([])
}

it('observes a durable gate created after waiting begins without a change notification', async () => {
  const settled = vi.fn()
  const pending = waitForFileGate(path, cancellation.signal, 'Missing gate').then(settled)
  await vi.advanceTimersByTimeAsync(100)
  expect(settled).not.toHaveBeenCalled()
  writeFileSync(path, 'release')
  await vi.advanceTimersByTimeAsync(20)
  expect(settled).toHaveBeenCalledExactlyOnceWith(true)
  await pending
  expectReleasedResources()
})

it('accepts an existing gate without retaining resources', async () => {
  writeFileSync(path, 'release')
  await expect(waitForFileGate(path, cancellation.signal, 'Missing gate')).resolves.toBe(true)
  expectReleasedResources()
})

it('honors cancellation before an existing gate', async () => {
  writeFileSync(path, 'release')
  cancellation.abort()
  await expect(waitForFileGate(path, cancellation.signal, 'Missing gate')).resolves.toBe(false)
  expectReleasedResources()
})

it('cancels a pending wait and ignores late gate creation', async () => {
  const settled = vi.fn()
  const pending = waitForFileGate(path, cancellation.signal, 'Missing gate').then(settled)
  cancellation.abort()
  await pending
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  expectReleasedResources()
  writeFileSync(path, 'too late')
  await vi.advanceTimersByTimeAsync(45_000)
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  expectReleasedResources()
})

it('rejects a missing gate at the existing deadline and releases its resources', async () => {
  const settled = vi.fn()
  const pending = waitForFileGate(path, cancellation.signal, 'Missing output gate').catch(settled)
  await vi.advanceTimersByTimeAsync(44_999)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(settled).toHaveBeenCalledExactlyOnceWith(new Error('Missing output gate'))
  expectReleasedResources()
  writeFileSync(path, 'too late')
  cancellation.abort()
  await vi.advanceTimersByTimeAsync(45_000)
  expect(settled).toHaveBeenCalledTimes(1)
  expectReleasedResources()
})
