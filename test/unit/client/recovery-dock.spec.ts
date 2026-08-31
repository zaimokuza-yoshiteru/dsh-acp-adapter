import { describe, expect, it } from 'vitest'
import { projectionIsAcp } from '../../../src/client/ui/AcpRecoveryDock.ts'

describe('ACP recovery dock projection gate', () => {
  it('only reads recovery state for an ACP selection', () => {
    const owns = (provider: string | undefined): boolean => provider === 'acp-kimi' || provider === 'acp-codex'
    expect(projectionIsAcp({ lastUsed: { provider: 'openai' }, next: { provider: 'openai' } }, owns)).toBe(false)
    expect(projectionIsAcp({ lastUsed: null, next: { provider: 'acp-kimi' } }, owns)).toBe(true)
    expect(projectionIsAcp({ lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } }, owns)).toBe(true)
    expect(projectionIsAcp(undefined, owns)).toBe(false)
  })
})
