import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ensureHostLiveDiagnostics } from '../../../src/host/composition/live-diagnostics.ts'
import type { LiveDiagnosticEvent, LiveDiagnosticTraceSink } from '../../../src/contract/live-diagnostic-trace.ts'

const event: LiveDiagnosticEvent = {
  type: 'adapter-prompt/start',
  sessionId: 'h:111111111111111111111111',
  promptOrdinal: 1,
}

function sink(write: (event: LiveDiagnosticEvent) => void | Promise<void>): LiveDiagnosticTraceSink {
  return Object.assign(write, {
    id: () => 'h:111111111111111111111111',
    fingerprint: () => ({ hmac: 'h:111111111111111111111111', bytes: 1, complete: true }),
  })
}

it('keeps one explicit observer across plugin remounts and isolates another Host', async () => {
  const first = new Context()
  const second = new Context()
  const firstEvents: LiveDiagnosticEvent[] = []
  const secondEvents: LiveDiagnosticEvent[] = []
  try {
    const mount = first.plugin((ctx) => {
      ensureHostLiveDiagnostics(ctx)
    })
    await mount
    const trace = first.acpLiveDiagnostics
    trace.install(
      sink((value) => {
        firstEvents.push(value)
      }),
    )
    ensureHostLiveDiagnostics(second).install(
      sink((value) => {
        secondEvents.push(value)
      }),
    )
    trace.emit(event)
    await mount.dispose()
    const remount = first.plugin((ctx) => {
      expect(ensureHostLiveDiagnostics(ctx)).toBe(trace)
    })
    await remount
    first.acpLiveDiagnostics.emit(event)
    second.acpLiveDiagnostics.emit(event)
    expect(firstEvents).toEqual([event, event])
    expect(secondEvents).toEqual([event])
    await remount.dispose()
  } finally {
    await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
  }
})

it('drains an accepted diagnostic write before Host withdrawal and rejects new delivery', async () => {
  const ctx = new Context()
  const trace = ensureHostLiveDiagnostics(ctx)
  const gate = Promise.withResolvers<void>()
  let writes = 0
  trace.install(
    sink(async () => {
      writes += 1
      await gate.promise
    }),
  )
  trace.emit(event)
  let closed = false
  const closing = ctx.fiber.dispose().then(() => {
    closed = true
  })
  try {
    await Promise.resolve()
    expect(trace.enabled()).toBe(false)
    expect(closed).toBe(false)
    trace.emit(event)
    expect(writes).toBe(1)
  } finally {
    gate.resolve()
    await closing
  }
  expect(ctx.get('acpLiveDiagnostics', false)).toBeUndefined()
  expect(() => trace.install(sink(() => {}))).toThrow('disposed')
})
