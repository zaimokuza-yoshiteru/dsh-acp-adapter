import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureLiveDiagnostic,
  collectLiveDiagnostic,
  emitLiveDiagnostic,
  installLiveDiagnosticTrace,
  liveDiagnosticId,
  liveDiagnosticTraceEnabled,
  liveDiagnosticTraceFailureCount,
} from '../../../src/contract/live-diagnostic-trace.ts'

const removers: Array<() => void> = []
const install = (
  callback: (event: unknown) => void | Promise<void>,
  id: (kind: string, value: unknown) => string = () => 'h:0123456789abcdef01234567',
  fingerprint: () => { hmac: string; bytes: number | null; complete: boolean } = () => ({
    hmac: 'h:0123456789abcdef01234567',
    bytes: 1,
    complete: true,
  }),
) => {
  const remove = installLiveDiagnosticTrace(Object.assign(callback, { id, fingerprint }))
  removers.push(remove)
  return remove
}

afterEach(() => {
  for (const remove of removers.splice(0)) remove()
})

describe('opt-in live diagnostics observer', () => {
  it('does no field collection when disabled', () => {
    expect(liveDiagnosticTraceEnabled()).toBe(false)
    const factory = vi.fn(() => ({ safe: true }))
    expect(collectLiveDiagnostic(factory)).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    emitLiveDiagnostic({
      type: 'acp-usage/update',
      sessionId: 'unavailable',
      contextUsed: 10,
      contextSize: 20,
    })
  })

  it('isolates synchronous and asynchronous observer failures from Host events', async () => {
    const sink = vi.fn((_event: unknown) => {
      throw new Error('private failure text')
    })
    install(sink)
    const factory = vi.fn(() => ({
      type: 'acp-usage/update' as const,
      sessionId: 'unavailable',
      contextUsed: 1,
      contextSize: 2,
    }))
    expect(collectLiveDiagnostic(factory)).toEqual({
      type: 'acp-usage/update',
      sessionId: 'unavailable',
      contextUsed: 1,
      contextSize: 2,
    })
    expect(() => captureLiveDiagnostic(() => factory() as never)).not.toThrow()
    expect(liveDiagnosticTraceFailureCount()).toBe(1)
    const asyncSink = vi.fn(() => Promise.reject(new Error('private async failure')))
    install(asyncSink)
    expect(() =>
      emitLiveDiagnostic({
        type: 'acp-usage/update',
        sessionId: 'unavailable',
        contextUsed: 3,
        contextSize: 4,
      }),
    ).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(liveDiagnosticTraceFailureCount()).toBe(1)
  })

  it('treats identity and fingerprint callback failures as unavailable', () => {
    install(
      () => undefined,
      () => {
        throw new Error('secret-like-id')
      },
      () => {
        throw new Error('secret-like-args')
      },
    )
    expect(liveDiagnosticId('session', 'raw-session-id')).toBeUndefined()
    expect(liveDiagnosticTraceFailureCount()).toBe(1)
  })
})
