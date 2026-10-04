import { describe, expect, it } from 'vitest'
import { recoveryViewWithLocalStatus } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpRecoveryState } from '../../../src/persistence/sidecar.ts'

describe('ACP recovery view settlement context', () => {
  it('adds volatile settlement status to healthy views only', () => {
    const state: AcpRecoveryState = { dshSessionId: 'session-1', kind: 'healthy', updatedAt: 10 }
    const view = recoveryViewWithLocalStatus('session-1', state, 'saving-results')
    expect(view).toMatchObject({ kind: 'healthy', localStatus: 'saving-results', updatedAt: 10 })
    expect(recoveryViewWithLocalStatus('session-1', state, undefined)).toMatchObject({ kind: 'healthy' })
    expect(recoveryViewWithLocalStatus('session-1', undefined, undefined)).toBeUndefined()
  })

  it('keeps a real unknown outcome ahead of temporary settlement status', () => {
    const state: AcpRecoveryState = {
      dshSessionId: 'session-1',
      kind: 'outcome-unknown',
      cause: 'steering-uncertain',
      updatedAt: 10,
    }
    expect(recoveryViewWithLocalStatus('session-1', state, 'storage-error')).toMatchObject({
      kind: 'outcome-unknown',
      cause: 'steering-uncertain',
    })
    expect(recoveryViewWithLocalStatus('session-1', state, 'storage-error')).not.toHaveProperty('localStatus')
  })
})
