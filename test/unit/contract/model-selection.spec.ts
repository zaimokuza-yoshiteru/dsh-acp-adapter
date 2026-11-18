import { describe, expect, it } from 'vitest'
import {
  ACP_AGENT_MANAGED_MODEL_ID,
  ACP_CURRENT_CONFIG_MODEL_ID,
  ACP_MODEL_ROUTE_MAX,
  acpDeclaredModelRoute,
  acpModelSelection,
  isAcpModelRouteWithinBounds,
} from '../../../src/contract/model-selection.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../../src/contract/config-options.ts'

describe('ACP model routing identities', () => {
  it('allows framing around a maximum-size Agent value without increasing the protocol value bound', () => {
    const value = 'dsh-acp:'.padEnd(ACP_CONFIG_IDENTIFIER_MAX, 'x')
    const route = acpDeclaredModelRoute(value)
    expect(route).toHaveLength(ACP_MODEL_ROUTE_MAX)
    expect(isAcpModelRouteWithinBounds(route)).toBe(true)
    expect(isAcpModelRouteWithinBounds(`${route}x`)).toBe(false)
    expect(isAcpModelRouteWithinBounds('x'.repeat(ACP_CONFIG_IDENTIFIER_MAX + 1))).toBe(false)
    expect(isAcpModelRouteWithinBounds('')).toBe(false)
  })

  it.each([ACP_CURRENT_CONFIG_MODEL_ID, ACP_AGENT_MANAGED_MODEL_ID])(
    'keeps %s distinct from an identical Agent value',
    (id) => {
      expect(acpModelSelection(id)).toEqual({ kind: 'current-config' })
      const declared = acpDeclaredModelRoute(id)
      expect(declared).not.toBe(id)
      expect(acpModelSelection(declared)).toEqual({ kind: 'declared-model', value: id })
    },
  )

  it.each(['model-a', 'dsh-acp:model:dsh-acp:current-config', 'dsh-acp:vendor-model'])(
    'round-trips the opaque declared value %s exactly once',
    (value) => {
      expect(acpModelSelection(acpDeclaredModelRoute(value))).toEqual({ kind: 'declared-model', value })
    },
  )
})
