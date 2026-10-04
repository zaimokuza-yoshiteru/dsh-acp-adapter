import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEVIN_LIVE_TRACE_MAX_BYTES, DevinLiveTrace } from '../../../scripts/devin-live-trace.ts'

const roots: string[] = []
const directory = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'devin-live-trace-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Devin live diagnostic trace', () => {
  it('HMACs identities and canonical arguments without persisting raw IDs, text, or unapproved fields', () => {
    const trace = new DevinLiveTrace({ directory: directory(), key: Buffer.alloc(32, 7) })
    const message = 'private-message-never-store'
    const first = trace.fingerprint('tool-arguments', { target: 'lead', message })
    const reordered = trace.fingerprint('tool-arguments', { message, target: 'lead' })
    const nextCall = trace.id('host-call', 'host-call-2')
    trace.record('tool/admission', {
      actorRole: 'teammate',
      hostCallId: trace.id('host-call', 'host-call-1'),
      mcpRequestId: 'unavailable',
      argsHmac: first.hmac,
      argsBytes: first.bytes,
      rawArguments: message,
      unsafeLabel: message,
    })
    trace.record('tool/admission', {
      actorRole: 'teammate',
      hostCallId: nextCall,
      mcpRequestId: 'unavailable',
      argsHmac: reordered.hmac,
      argsBytes: reordered.bytes,
      transportRetryRelation: 'unavailable',
    })
    trace.finish('pass', {})

    const text = readFileSync(trace.filePath, 'utf8')
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(first).toEqual(reordered)
    expect(nextCall).not.toBe(rows[1]?.hostCallId)
    expect(rows[1]?.argsHmac).toBe(rows[2]?.argsHmac)
    expect(rows[1]?.rawArguments).toBeUndefined()
    expect(rows[1]?.unsafeLabel).toBeUndefined()
    expect(text).not.toContain(message)
    expect(text).not.toContain('host-call-1')
  })

  it('keeps append-only partial evidence readable when a failed run is finalized', () => {
    const trace = new DevinLiveTrace({ directory: directory() })
    trace.record('session/event', { hostEvent: 'step/start', turn: 2, step: 3 })
    const beforeFinish = readFileSync(trace.filePath, 'utf8')
    expect(beforeFinish).toContain('step/start')
    trace.finish('fail', { exitCode: 1 })
    const text = readFileSync(trace.filePath, 'utf8')
    expect(text).toContain('"testResult":"fail"')
    expect(text).toContain('"event":"trace/final"')
    expect(statSync(trace.filePath).size).toBe(Buffer.byteLength(text))
  })

  it('bounds output and records that later evidence was omitted', () => {
    const trace = new DevinLiveTrace({ directory: directory(), maxBytes: 4096 })
    for (let i = 0; i < 1000; i++) trace.record('session/event', { hostEvent: 'assistant/message', sessionSeq: i })
    trace.finish('fail', { exitCode: 1 })

    const text = readFileSync(trace.filePath, 'utf8')
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(statSync(trace.filePath).size).toBeLessThanOrEqual(4096)
    expect(rows.some((row) => row.event === 'trace/truncated' && row.truncated === true)).toBe(true)
    expect(rows.at(-1)).toMatchObject({ event: 'trace/final', testResult: 'fail', truncated: true })
    expect(rows.at(-1)?.omittedEvents).toBeGreaterThan(0)
    expect(DEVIN_LIVE_TRACE_MAX_BYTES).toBeGreaterThan(4096)
  })

  it('marks partial or cyclic fingerprints unavailable instead of treating them as matching', () => {
    const trace = new DevinLiveTrace({ directory: directory(), key: Buffer.alloc(32, 3) })
    const circular: Record<string, unknown> = { text: 'private' }
    circular.self = circular
    expect(trace.fingerprint('args', circular)).toEqual({ hmac: 'unavailable', bytes: null, complete: false })
    expect(trace.fingerprint('args', { text: 'x'.repeat(300_000) })).toEqual({
      hmac: 'unavailable',
      bytes: null,
      complete: false,
    })
    expect(trace.id('session', undefined)).toBe('unavailable')
    expect(trace.diagnosticIncomplete).toBe(true)
    trace.finish('fail', {})
  })

  it('reports an output-path failure without throwing from diagnostics construction', () => {
    const root = directory()
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'occupied')
    let signalled = 0
    const trace = new DevinLiveTrace({ directory: file, onWriteFailure: () => signalled++ })
    expect(trace.writeFailed).toBe(true)
    expect(signalled).toBe(1)
    expect(() => trace.record('test/fail', { phaseCode: 'LIVE_TEST_FAILED' })).not.toThrow()
  })
})
