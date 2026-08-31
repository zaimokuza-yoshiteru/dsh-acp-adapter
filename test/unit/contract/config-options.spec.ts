import { describe, expect, it } from 'vitest'
import { isAcpModelOrReasoningOption, normalizeAcpConfigOptionKey } from '../../../src/contract/config-options.ts'

describe('ACP config option classification', () => {
  it('normalizes only classification keys and leaves Agent values untouched', () => {
    expect(normalizeAcpConfigOptionKey(' Thought-Level ')).toBe('thought_level')
    expect(isAcpModelOrReasoningOption({ id: 'MODEL' })).toBe(true)
    expect(isAcpModelOrReasoningOption({ id: 'agent-model', category: 'MODEL' })).toBe(true)
    expect(isAcpModelOrReasoningOption({ id: 'thinking', category: 'thought-level' })).toBe(true)
    expect(isAcpModelOrReasoningOption({ id: 'thinking', category: 'reasoning-effort' })).toBe(true)
    expect(isAcpModelOrReasoningOption({ id: 'reasoning-effort' })).toBe(true)
    expect(isAcpModelOrReasoningOption({ id: 'temperature', category: 'model_config' })).toBe(false)
  })
})
