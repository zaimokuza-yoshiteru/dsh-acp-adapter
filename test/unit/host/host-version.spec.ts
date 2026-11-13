import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  currentHostVersionMismatch,
  hostVersionMismatch,
  warnOnHostVersionMismatch,
} from '../../../src/host/composition/host-version.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const manifest = { version: '0.2.2-rc.1.1', engines: { dsh: '0.2.2-rc.1' } }

describe('Host version check', () => {
  it('reports only a positively read version that differs from an exact pin', () => {
    expect(hostVersionMismatch(manifest, '0.2.2-rc.1')).toBeUndefined()
    expect(hostVersionMismatch(manifest, '0.2.2-rc.2')).toEqual({
      adapter: '0.2.2-rc.1.1',
      required: '0.2.2-rc.1',
      running: '0.2.2-rc.2',
    })
    expect(hostVersionMismatch(manifest, undefined)).toBeUndefined()
    expect(hostVersionMismatch({ engines: { dsh: '^0.2.2' } }, '0.3.0')).toBeUndefined()
    expect(hostVersionMismatch({}, '0.3.0')).toBeUndefined()
  })

  it('matches the installed Host packages of this checkout', () => {
    const error = vi.fn()
    warnOnHostVersionMismatch({ logger: { error } } as unknown as Context)
    expect(error).not.toHaveBeenCalled()
  })

  it('reads versions again after a temporary manifest failure', () => {
    const read = vi.mocked(readFileSync)
    read.mockImplementationOnce(() => {
      throw new Error('temporary read failure')
    })
    expect(currentHostVersionMismatch()).toBeUndefined()
    read.mockReturnValueOnce(JSON.stringify({ ...manifest, engines: { dsh: '0.0.0' } }))
    expect(currentHostVersionMismatch()).toEqual({
      adapter: manifest.version,
      required: '0.0.0',
      running: manifest.engines.dsh,
    })
    expect(currentHostVersionMismatch()).toBeUndefined()
  })

  it('logs one actionable line on a mismatch and stays quiet when versions cannot be read', () => {
    const error = vi.fn()
    const ctx = { logger: { error } } as unknown as Context
    warnOnHostVersionMismatch(ctx, () => {
      throw new Error('unreadable')
    })
    expect(error).not.toHaveBeenCalled()
    warnOnHostVersionMismatch(ctx, () => hostVersionMismatch(manifest, '0.2.1-rc.4'))
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]).toEqual([
      expect.stringContaining('Install the adapter version'),
      '0.2.2-rc.1.1',
      '0.2.2-rc.1',
      '0.2.1-rc.4',
    ])
  })
})
