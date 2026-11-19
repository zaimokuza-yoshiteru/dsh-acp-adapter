import { describe, expect, it } from 'vitest'
import { deriveAcpAgentState } from '../../../src/domain/session/agent-state.ts'
import {
  ACP_PROBE_CACHE_ERROR_TTL_MS,
  ACP_PROBE_CACHE_OK_TTL_MS,
  acpProbeFresh,
} from '../../../src/domain/session/agent-config.ts'

describe('deriveAcpAgentState', () => {
  it('reports an incompatible Host before considering the probe', () => {
    expect(deriveAcpAgentState(false, { kind: 'ok' })).toBe('incompatible')
    expect(deriveAcpAgentState(false, { kind: 'error', failureKind: 'crash' })).toBe('incompatible')
  })

  it('distinguishes an unverified configuration from a successful probe', () => {
    expect(deriveAcpAgentState(true, undefined)).toBe('saved-unverified')
    expect(deriveAcpAgentState(true, { kind: 'ok' })).toBe('ready')
  })

  it('requires an explicit authentication failure to prompt for login', () => {
    expect(deriveAcpAgentState(true, { kind: 'error', failureKind: 'auth_required' })).toBe('auth-required')
    for (const failureKind of ['spawn-failure', 'resource-exhausted', 'timeout', 'crash', 'protocol-error'])
      expect(deriveAcpAgentState(true, { kind: 'error', failureKind }), failureKind).toBe('unavailable')
  })
})

describe('acpProbeFresh（新鲜度集中判定）', () => {
  const OK_ENTRY = { key: 'k1', at: 1_000_000, result: { kind: 'ok' as const } }
  const ERROR_ENTRY = { key: 'k1', at: 1_000_000, result: { kind: 'error' as const } }

  it('key 不相等一律不新鲜（配置漂移口径不变）', () => {
    expect(acpProbeFresh(OK_ENTRY, 'other-key', 1_000_000)).toBe(false)
    expect(acpProbeFresh(ERROR_ENTRY, 'other-key', 1_000_000)).toBe(false)
  })

  it('ok 条目 TTL 10 分钟：边界内新鲜、恰过界过期', () => {
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000)).toBe(true)
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_OK_TTL_MS - 1)).toBe(true)
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_OK_TTL_MS)).toBe(false)
    expect(ACP_PROBE_CACHE_OK_TTL_MS).toBe(10 * 60_000)
  })

  it('error 条目 TTL 30 秒（负缓存短窗口）：边界内新鲜、恰过界过期', () => {
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000)).toBe(true)
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_ERROR_TTL_MS - 1)).toBe(true)
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_ERROR_TTL_MS)).toBe(false)
    expect(ACP_PROBE_CACHE_ERROR_TTL_MS).toBe(30_000)
  })
})
