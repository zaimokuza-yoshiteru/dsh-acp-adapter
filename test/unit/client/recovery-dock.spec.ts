import { describe, expect, it, vi } from 'vitest'
import {
  localSettlementText,
  projectionIsAcp,
  publishRecoveryActionResult,
} from '../../../src/client/ui/AcpRecoveryDock.ts'
import type { AcpRecoveryView } from '../../../src/contract/remote.ts'

describe('ACP recovery dock projection gate', () => {
  it('only reads recovery state for an ACP selection', () => {
    const owns = (provider: string | undefined): boolean => provider === 'acp-kimi' || provider === 'acp-codex'
    expect(projectionIsAcp({ lastUsed: { provider: 'openai' }, next: { provider: 'openai' } }, owns)).toBe(false)
    expect(projectionIsAcp({ lastUsed: null, next: { provider: 'acp-kimi' } }, owns)).toBe(true)
    expect(projectionIsAcp({ lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } }, owns)).toBe(true)
    expect(projectionIsAcp(undefined, owns)).toBe(false)
  })

  it('shows only transient healthy settlement facts and lets a real unknown outcome win', () => {
    const t = (key: string): string => key
    const healthy: AcpRecoveryView = {
      dshSessionId: 'session-1',
      kind: 'healthy',
      localStatus: 'finishing-tools',
      cause: null,
      detail: null,
      provider: null,
      acpSessionId: null,
      generation: null,
      interruptedTurnId: null,
      lastAttemptAt: null,
      lastUserAction: null,
      updatedAt: 1,
    }
    expect(localSettlementText(t, healthy)).toBe('recoveryFinishingTools')
    expect(localSettlementText(t, { ...healthy, localStatus: 'saving-results' })).toBe('recoverySavingResults')
    expect(localSettlementText(t, { ...healthy, localStatus: 'storage-error' })).toBe('recoveryStorageError')
    const healthyWithoutLocalStatus = { ...healthy }
    delete healthyWithoutLocalStatus.localStatus
    expect(localSettlementText(t, { ...healthyWithoutLocalStatus, kind: 'healthy' })).toBeNull()
    expect(localSettlementText(t, { ...healthy, kind: 'outcome-unknown' })).toBeNull()
  })

  it('publishes the recovery view returned by an action only for the same live generation', () => {
    const view: AcpRecoveryView = {
      dshSessionId: 'session-1',
      kind: 'healthy',
      cause: null,
      detail: null,
      provider: 'acp-kimi',
      acpSessionId: 'agent-session',
      generation: 3,
      interruptedTurnId: null,
      lastAttemptAt: 1,
      lastUserAction: 'retry-original',
      updatedAt: 2,
    }
    const publish = vi.fn()
    expect(publishRecoveryActionResult(view, () => true, publish)).toBe(true)
    expect(publish).toHaveBeenCalledWith(view)
    expect(publishRecoveryActionResult(view, () => false, publish)).toBe(false)
    expect(publish).toHaveBeenCalledOnce()
    expect(publishRecoveryActionResult(undefined, () => true, publish)).toBe(false)
  })
})
