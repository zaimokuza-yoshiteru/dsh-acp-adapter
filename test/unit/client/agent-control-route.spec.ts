import { describe, expect, it } from 'vitest'
import { snapshotIsAcp } from '../../../src/client/ui/AcpAgentControl.ts'

describe('ACP Agent control route selection', () => {
  const owns = (provider: string | undefined): boolean => provider === 'acp-devin'

  it('uses the pending next selection as the current route', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: 'native' } }, owns)).toBe(false)
    expect(snapshotIsAcp({ lastUsed: { provider: 'native' }, next: { provider: 'acp-devin' } }, owns)).toBe(true)
  })

  it('falls back to lastUsed only when no next selection exists', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' } }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: undefined }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: undefined } }, owns)).toBe(false)
  })
})
