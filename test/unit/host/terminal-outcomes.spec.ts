import { describe, expect, it, vi } from 'vitest'
import { HostTerminalOutcomes } from '../../../src/host/composition/terminal-outcomes.ts'
import { activityHostTerminalOutcome } from '../../../src/contract/terminal-outcome.ts'
import type { AcpTerminalAuditData } from '../../../src/domain/policy/events.ts'

const event = (patch: Partial<AcpTerminalAuditData> = {}): AcpTerminalAuditData => ({
  operation: 'exit',
  terminalId: 'terminal-1',
  dshSessionId: 'owner',
  profileId: 'codebuddy',
  acpSessionId: 'agent-1',
  command: 'original command',
  argCount: 0,
  cwd: '/workspace',
  outputBytes: 126,
  truncated: false,
  outcome: 'exited',
  exitCode: 2,
  signal: null,
  ...patch,
})
const content = [{ type: 'terminal', terminalId: 'terminal-1' }]

describe('Host terminal facts for explicit tool references', () => {
  it('retains an exit after release, and notifies only a new observed exit', () => {
    const store = new HostTerminalOutcomes('owner', 'codebuddy')
    const listener = vi.fn()
    const off = store.subscribe(listener)
    expect(store.resolve('agent-1', content)).toBeUndefined()
    store.observe(event())
    const result = store.resolve('agent-1', content)
    expect(result).toEqual({
      source: 'acp-client-terminal',
      dshSessionId: 'owner',
      acpSessionId: 'agent-1',
      terminalId: 'terminal-1',
      exitCode: 2,
      signal: null,
    })
    store.observe(event({ operation: 'release', outcome: 'released', terminationRequested: true }))
    store.observe(event())
    expect(store.resolve('agent-1', content)).toBe(result)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    store.observe(event({ terminalId: 'another-terminal' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each([
    { dshSessionId: 'other' },
    { profileId: 'other' },
    { operation: 'create' as const, outcome: 'started' as const },
    { outcome: 'error' as const },
    { exitCode: null, signal: null },
    { exitCode: NaN },
  ])('does not infer a process result from %j', (patch) => {
    const store = new HostTerminalOutcomes('owner', 'codebuddy')
    store.observe(event(patch))
    expect(store.resolve('agent-1', content)).toBeUndefined()
  })

  it('requires the exact ACP session and one explicit standard reference', () => {
    const store = new HostTerminalOutcomes('owner', 'codebuddy')
    store.observe(event())
    for (const value of [
      undefined,
      [],
      [{ type: 'text', text: 'terminal-1' }],
      [...content, ...content],
      [...content, { type: 'terminal', terminalId: 'another' }],
      [{ type: 'terminal', terminalId: 'unknown' }],
    ])
      expect(store.resolve('agent-1', value)).toBeUndefined()
    expect(store.resolve('other-agent', content)).toBeUndefined()
    expect(store.resolve(undefined, content)).toBeUndefined()
  })

  it('bounds retained facts without inventing a result for evicted references', () => {
    const store = new HostTerminalOutcomes('owner', 'codebuddy', 2)
    store.observe(event())
    store.observe(event({ terminalId: 'second' }))
    store.observe(event({ terminalId: 'third', exitCode: 0 }))
    expect(store.resolve('agent-1', content)).toBeUndefined()
    expect(store.resolve('agent-1', [{ type: 'terminal', terminalId: 'third' }])).toHaveProperty('exitCode', 0)
  })

  it('retains signal termination and validates persisted ownership and reference after reload', () => {
    const store = new HostTerminalOutcomes('owner', 'codebuddy')
    store.observe(event({ exitCode: null, signal: 'SIGTERM' }))
    const detail = JSON.parse(JSON.stringify({ content, hostTerminalOutcome: store.resolve('agent-1', content) }))
    expect(activityHostTerminalOutcome(detail, 'owner')).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
    expect(activityHostTerminalOutcome(detail, 'other')).toBeUndefined()
    expect(activityHostTerminalOutcome({ ...detail, content: [] }, 'owner')).toBeUndefined()
    expect(activityHostTerminalOutcome({ ...detail, content: [...content, ...content] }, 'owner')).toBeUndefined()
    expect(
      activityHostTerminalOutcome(
        { ...detail, hostTerminalOutcome: { ...detail.hostTerminalOutcome, source: 'vendor' } },
        'owner',
      ),
    ).toBeUndefined()
  })
})
