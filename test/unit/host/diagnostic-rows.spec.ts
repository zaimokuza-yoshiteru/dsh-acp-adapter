import { describe, expect, it } from 'vitest'
import { auditTimelineRowOf } from '../../../src/host/composition/audit-row.ts'
import { matchesDiagnosticView } from '../../../src/contract/diagnostics.ts'
import { ACP_SIDECAR_SCHEMA_VERSION, type AcpSidecarEntryInput } from '../../../src/persistence/sidecar.ts'

function row(input: AcpSidecarEntryInput) {
  return auditTimelineRowOf({ ...input, seq: 1, time: 1, recordId: 'record', dshSessionId: 'session', schemaVersion: ACP_SIDECAR_SCHEMA_VERSION })
}

describe('ACP diagnostic facts', () => {
  it('keeps legacy replay non-comparison out of issues without claiming it was a real restore', () => {
    const value = row({ kind: 'replay-assessment', data: { status: 'not-compared', detail: '0 staged updates' } })
    expect(value.severity).toBe('info')
    expect(matchesDiagnosticView(value, 'issues')).toBe(false)
    expect(matchesDiagnosticView(value, 'technical')).toBe(true)
    expect(value.detail).toContain('0 staged updates')
    expect(row({ kind: 'replay-assessment', data: { status: 'different' } }).severity).toBe('warning')
  })

  it.each(['allow_once', 'reject_once', 'allow_always', 'reject_always'] as const)('preserves %s as an ordinary permission decision', option => {
    const value = row({ kind: 'permission', data: { phase: 'decided', requestId: 'request', agentSessionId: 'agent', toolCallId: 'call', outcome: 'selected', selectedOptionKind: option } })
    expect(value.status).toBe(option)
    expect(value.severity).toBe('info')
    expect(matchesDiagnosticView(value, 'operations')).toBe(true)
  })

  it('does not turn a missing legacy decision kind into permission to execute', () => {
    expect(row({ kind: 'permission', data: { phase: 'decided', requestId: 'request', agentSessionId: 'agent', toolCallId: 'call', outcome: 'selected', optionId: 'allow-looking-custom-id' } }).status).toBe('selected')
  })

  it('shows file failure reasons as recorded facts and does not invent missing write reasons', () => {
    const base = { path: '/missing', bytes: 0, beforeHash: null, afterHash: null, outcome: 'error' as const, acpSessionId: 'agent', profileId: 'custom-agent' }
    const read = row({ kind: 'filesystem', data: { ...base, operation: 'read', reason: 'not-found' } })
    expect(read).toMatchObject({ severity: 'error', summaryCode: 'filesystem.read' })
    expect(read.detail).toContain('not-found')
    expect(matchesDiagnosticView(read, 'operations')).toBe(true)
    expect(matchesDiagnosticView(read, 'issues')).toBe(true)
    const write = row({ kind: 'filesystem', data: { ...base, operation: 'write' } })
    expect(write).toMatchObject({ severity: 'error', summaryCode: 'filesystem.write' })
    expect(JSON.parse(write.detail!)).not.toHaveProperty('reason')
  })

  it('distinguishes termination intent from exit failure, including numeric cancellation exits', () => {
    const base = { terminalId: 'term', dshSessionId: 'session', acpSessionId: 'agent', profileId: 'custom', command: 'test', argCount: 0, cwd: '/tmp', outputBytes: 0, truncated: false }
    expect(row({ kind: 'terminal', data: { ...base, operation: 'kill', outcome: 'killed' } }).status).toBe('stop-requested')
    expect(row({ kind: 'terminal', data: { ...base, operation: 'exit', outcome: 'exited', exitCode: 7, terminationRequested: false } }).severity).toBe('error')
    expect(row({ kind: 'terminal', data: { ...base, operation: 'exit', outcome: 'exited', exitCode: 1, terminationRequested: true } }).severity).toBe('info')
    expect(row({ kind: 'terminal', data: { ...base, operation: 'exit', outcome: 'exited', exitCode: null, signal: 'SIGSEGV', terminationRequested: false } }).severity).toBe('error')
    expect(row({ kind: 'terminal', data: { ...base, operation: 'exit', outcome: 'exited', exitCode: null, signal: 'SIGTERM', terminationRequested: true } }).severity).toBe('info')
  })
})
