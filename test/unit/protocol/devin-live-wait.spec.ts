import { describe, expect, it } from 'vitest'
import { classifyDevinWaitResult } from '../../../scripts/devin-live-wait.ts'

describe('live wait_agent result projection', () => {
  it('uses the official booleans and noProgress reason without exposing its message', () => {
    expect(classifyDevinWaitResult({ timedOut: true })).toBe('timedOut')
    expect(
      classifyDevinWaitResult({
        timedOut: false,
        noProgress: { reason: 'no-active-peer', message: 'private host text' },
      }),
    ).toBe('noProgress')
    expect(classifyDevinWaitResult({ timedOut: false })).toBe('observedChange')
    expect(classifyDevinWaitResult({ status: 'completed' })).toBe('unknown')
    expect(classifyDevinWaitResult({ timedOut: false, noProgress: { reason: 'other' } })).toBe('unknown')
  })
})
