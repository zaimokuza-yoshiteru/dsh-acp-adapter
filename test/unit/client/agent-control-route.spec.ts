import { describe, expect, it } from 'vitest'
import { snapshotIsAcp } from '../../../src/client/ui/AcpAgentControl.ts'

describe('ACP Agent control route selection', () => {
  const owns = (provider: string | undefined): boolean => provider === 'acp-devin'

  it('uses the pending next selection as the current route', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: 'native' } }, owns)).toBe(false)
    expect(snapshotIsAcp({ lastUsed: { provider: 'native' }, next: { provider: 'acp-devin' } }, owns)).toBe(true)
  })

  it('falls back from an empty session projection to the host default route', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' } }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: undefined }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: undefined } }, owns)).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: null }, owns, 'acp-devin')).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: null }, owns, 'native')).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: null }, owns, 'native')).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: { provider: 'native' } }, owns, 'acp-devin')).toBe(false)
    expect(snapshotIsAcp(null, owns, 'acp-devin')).toBe(true)
  })
})
