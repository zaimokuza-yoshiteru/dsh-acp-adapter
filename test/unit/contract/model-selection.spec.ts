import { describe, expect, it } from 'vitest'
import {
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

  it('keeps the current-configuration route distinct from a real Agent value with the same spelling', () => {
    expect(acpModelSelection(ACP_CURRENT_CONFIG_MODEL_ID)).toEqual({ kind: 'current-config' })
    const declared = acpDeclaredModelRoute(ACP_CURRENT_CONFIG_MODEL_ID)
    expect(declared).not.toBe(ACP_CURRENT_CONFIG_MODEL_ID)
    expect(acpModelSelection(declared)).toEqual({ kind: 'declared-model', value: ACP_CURRENT_CONFIG_MODEL_ID })
  })

  it.each(['model-a', 'dsh-acp:model:dsh-acp:current-config', 'dsh-acp:vendor-model'])(
    'round-trips the opaque declared value %s exactly once',
    (value) => {
      expect(acpModelSelection(acpDeclaredModelRoute(value))).toEqual({ kind: 'declared-model', value })
    },
  )
})
