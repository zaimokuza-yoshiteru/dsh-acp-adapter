import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpAgentProcess } from '../../../src/runtime/process/agent-process.ts'
import { stopSubprocess } from '../../../src/runtime/process/cleanup.ts'
import type { AcpSubprocessHandle } from '../../../src/runtime/process/subprocess.ts'

function handle(overrides: Partial<AcpSubprocessHandle> = {}): AcpSubprocessHandle {
  return {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(), waitForExit: vi.fn(async () => true), ...overrides,
  }
}

describe('host-managed process cleanup', () => {
  it.each(['exit', 'provider failure'])('cleans surviving range members after command %s', async outcome => {
    let terminated = false
    const child = handle({
      done: outcome === 'exit' ? Promise.resolve({ exitCode: 0, signal: null }) : Promise.reject(new Error('provider lost command observation')),
      terminate: vi.fn(() => { terminated = true }),
      waitForExit: vi.fn(async () => terminated),
    })
    const proc = new AcpAgentProcess({ argv: ['fixture'], cwd: process.cwd(), env: {}, subprocess: {
      spawn: () => child, resolveExecutable: async command => command,
    } }, { eofGraceMs: 0, exitWaitMs: 20 })
    await Promise.resolve()
    if (outcome === 'provider failure') {
      expect(proc.failure).toBeDefined()
      expect(proc.spawnFailure).toBeUndefined()
    } else expect(proc.exited).toEqual({ code: 0, signal: null })
    const closing = proc.close()
    expect(proc.close()).toBe(closing)
    await closing
    expect(child.terminate).toHaveBeenCalledOnce()
    await expect(child.waitForExit()).resolves.toBe(true)
  })

  it('still terminates after the first observation fails and records the failure', async () => {
    const warn = vi.fn()
    const child = handle({ waitForExit: vi.fn().mockRejectedValueOnce(new Error('lost observation')).mockResolvedValue(true) })
    await expect(stopSubprocess(child, { eofGraceMs: 0, exitWaitMs: 20, warn })).resolves.toBe(true)
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('observation failed'))
  })

  it('does not claim exit when the provider cannot observe it after termination', async () => {
    const warn = vi.fn()
    const child = handle({ waitForExit: vi.fn(async () => { throw new Error('range unavailable') }) })
    await expect(stopSubprocess(child, { eofGraceMs: 0, exitWaitMs: 20, warn })).resolves.toBe(false)
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not confirmed'))
  })

  it('bounds a provider that ignores cancellation and observes its late rejection', async () => {
    const warn = vi.fn()
    const signals: AbortSignal[] = []
    let reject!: (error: Error) => void
    const pending = new Promise<boolean>((_, fail) => { reject = fail })
    const child = handle({ waitForExit: vi.fn(signal => { signals.push(signal!); return pending }) })
    await expect(stopSubprocess(child, { eofGraceMs: 0, exitWaitMs: 5, warn })).resolves.toBe(false)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    reject(new Error('late provider failure'))
    await Promise.resolve()
  })
})
