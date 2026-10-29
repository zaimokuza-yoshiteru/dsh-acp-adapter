import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveDiagnosticTrace } from '../../../src/contract/live-diagnostic-trace.ts'
import type { LiveDiagnosticTrace, LiveDiagnosticEvent } from '../../../src/contract/live-diagnostic-trace.ts'

const owners: LiveDiagnosticTrace[] = []
const owner = () => {
  const trace = createLiveDiagnosticTrace()
  owners.push(trace)
  return trace
}
const sink = (
  callback: (event: LiveDiagnosticEvent) => void | Promise<void>,
  id: (kind: string, value: unknown) => string = () => 'h:0123456789abcdef01234567',
  fingerprint = () => ({ hmac: 'h:0123456789abcdef01234567', bytes: 1, complete: true }),
) => Object.assign(callback, { id, fingerprint })
const event: LiveDiagnosticEvent = {
  type: 'acp-usage/update',
  sessionId: 'unavailable',
  contextUsed: 1,
  contextSize: 2,
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map((trace) => trace.dispose()))
})

describe('run-owned opt-in live diagnostics', () => {
  it('does not prepare fields or identities without an installed sink', () => {
    const trace = owner()
    const factory = vi.fn(() => ({ safe: true }))
    expect(trace.enabled()).toBe(false)
    expect(trace.collect(factory)).toBeUndefined()
    expect(trace.id('session', 'private-id')).toBeUndefined()
    expect(trace.fingerprint('body', 'private-body')).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    expect(() => trace.emit(event)).not.toThrow()
  })

  it('contains sync, async and preparation failures while retaining the run failure count', async () => {
    const trace = owner()
    trace.install(
      sink(() => {
        throw new Error('private failure')
      }),
    )
    expect(() => trace.emit(event)).not.toThrow()
    expect(trace.failureCount()).toBe(1)
    const remove = trace.install(sink(() => Promise.reject(new Error('private async failure'))))
    expect(() => trace.emit(event)).not.toThrow()
    expect(
      trace.collect(() => {
        throw new Error('private preparation')
      }),
    ).toBeUndefined()
    await remove()
    expect(trace.failureCount()).toBe(3)
  })

  it('preserves HMAC-only identities and rejects raw fingerprint output', () => {
    const trace = owner()
    trace.install(
      sink(
        () => {},
        () => 'raw-private-id',
        () => ({ hmac: 'raw-secret-body', bytes: -1, complete: true }),
      ),
    )
    expect(trace.id('session', 'private')).toBe('unavailable')
    expect(trace.fingerprint('body', 'private')).toEqual({ hmac: 'unavailable', bytes: null, complete: false })
    trace.install(
      sink(
        () => {},
        () => {
          throw new Error('private-id')
        },
        () => {
          throw new Error('private-body')
        },
      ),
    )
    expect(trace.id('session', 'raw')).toBeUndefined()
    expect(trace.fingerprint('body', 'raw')).toBeUndefined()
    expect(trace.failureCount()).toBe(2)
  })

  it('isolates concurrent Host owners and stops delivery through disposed owner references', async () => {
    const first = owner(),
      second = owner()
    const firstSink = vi.fn(),
      secondSink = vi.fn()
    first.install(sink(firstSink))
    second.install(sink(secondSink))
    first.emit(event)
    expect(firstSink).toHaveBeenCalledTimes(1)
    expect(secondSink).not.toHaveBeenCalled()
    await first.dispose()
    first.emit(event)
    second.emit(event)
    expect(firstSink).toHaveBeenCalledTimes(1)
    expect(secondSink).toHaveBeenCalledTimes(1)
    expect(() => first.install(sink(firstSink))).toThrow('disposed')
  })

  it('revokes a replaced sink immediately and lets its disposer drain only its accepted write', async () => {
    const trace = owner()
    const write = Promise.withResolvers<void>()
    const oldSink = vi.fn(() => write.promise),
      nextSink = vi.fn()
    const removeOld = trace.install(sink(oldSink))
    trace.emit(event)
    trace.install(sink(nextSink))
    let drained = false
    const disposing = removeOld().then(() => {
      drained = true
    })
    trace.emit(event)
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(oldSink).toHaveBeenCalledTimes(1)
    expect(nextSink).toHaveBeenCalledTimes(1)
    write.resolve()
    await disposing
    expect(trace.enabled()).toBe(true)
    trace.emit(event)
    expect(nextSink).toHaveBeenCalledTimes(2)
  })

  it('awaits accepted writes including a sink which disposes its owner reentrantly', async () => {
    const trace = owner()
    const write = Promise.withResolvers<void>()
    let closing: Promise<void> | undefined
    let finished = false
    const callback = vi.fn(() => {
      closing = trace.dispose().then(() => {
        finished = true
      })
      return write.promise
    })
    trace.install(sink(callback))
    trace.emit(event)
    expect(trace.enabled()).toBe(false)
    trace.emit(event)
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(callback).toHaveBeenCalledTimes(1)
    write.reject(new Error('private write failure'))
    await closing
    expect(finished).toBe(true)
    expect(trace.failureCount()).toBe(1)
  })

  it('accepts an explicit owner created by an independently loaded module graph', async () => {
    const trace = owner()
    const callback = vi.fn()
    trace.install(sink(callback))
    vi.resetModules()
    const otherGraph = await import('../../../src/contract/live-diagnostic-trace.ts')
    expect(otherGraph.createLiveDiagnosticTrace).not.toBe(createLiveDiagnosticTrace)
    const other = otherGraph.createLiveDiagnosticTrace()
    owners.push(other)
    expect(other.enabled()).toBe(false)
    const borrowed: import('../../../src/contract/live-diagnostic-trace.ts').LiveDiagnosticTrace = trace
    borrowed.emit(event)
    expect(callback).toHaveBeenCalledWith(event)
    expect(other.failureCount()).toBe(0)
  })
})
