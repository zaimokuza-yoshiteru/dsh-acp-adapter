import { describe, expect, it } from 'vitest'
import {
  recoveryActionAvailability,
  recoveryDockVisible,
  recoverySummary,
  type RecoverySnapshot,
} from '../../../src/client/ui/AcpRecoveryInputDock.ts'

function snapshot(kind: string, modelSwitch: RecoverySnapshot['modelSwitch']['status'] = 'idle'): RecoverySnapshot {
  return {
    recovery: { kind, cause: null, detail: null, acpSessionId: null, generation: null },
    modelSwitch: { status: modelSwitch, ...(modelSwitch === 'pending' ? { operationId: 'op-1' } : {}) },
  }
}

describe('ACP recovery input dock projection', () => {
  it('hides healthy sessions and shows all three recovery exits for a blocker', () => {
    expect(recoveryDockVisible(snapshot('healthy'))).toBe(false)
    expect(recoveryDockVisible(snapshot('outcome-unknown'))).toBe(true)
    expect(recoveryActionAvailability(snapshot('outcome-unknown'), { reconnect: true, newSession: true })).toEqual({
      reconnect: true, rebind: true, rollback: false, newSession: true,
    })
  })

  it('does not offer reconnect for a healthy pending model switch', () => {
    const view = snapshot('healthy', 'pending')
    expect(recoveryActionAvailability(view, { reconnect: true, newSession: true })).toEqual({
      reconnect: false, rebind: true, rollback: true, newSession: true,
    })
  })

  it('honors independent action capabilities', () => {
    expect(recoveryActionAvailability(snapshot('session-lost'), { reconnect: false, newSession: false })).toEqual({
      reconnect: false, rebind: true, rollback: false, newSession: false,
    })
  })

  it('never exposes raw recovery diagnostics as the user-facing summary', () => {
    const view: RecoverySnapshot = {
      recovery: {
        kind: 'reconciliation-required',
        cause: 'profile-changed',
        detail: 'binding={"secret":"internal"} current={"secret":"internal"}',
        acpSessionId: 'agent-session',
        generation: 1,
      },
      modelSwitch: { status: 'idle' },
    }
    expect(recoverySummary(view)).toContain('environment')
    expect(recoverySummary(view)).not.toContain('binding=')
    expect(recoverySummary(view)).not.toContain('internal')
  })
})
