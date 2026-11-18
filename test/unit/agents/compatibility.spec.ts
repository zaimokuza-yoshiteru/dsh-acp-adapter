import { describe, expect, it } from 'vitest'
import { effectiveRuntimeOf, retiredAgentReason, ACP_AGENT_IDS } from '../../../src/contract/agent-config.ts'
import {
  hasModelSpecificConfiguration,
  modelProbeOptions,
  sessionCompatibilityOptions,
  executableOverrideEnvFor,
} from '../../../src/agents/compatibility.ts'

describe('Agent compatibility boundaries', () => {
  it('keeps manual generic ACP profiles usable without adding a runtime', () => {
    expect(effectiveRuntimeOf('custom', { catalogId: 'codebuddy-code' } as {})).toBeUndefined()
    expect(retiredAgentReason('custom')).toBeUndefined()
    expect(sessionCompatibilityOptions(undefined)).toEqual({ enableClaudeDraftSubagents: false })
    expect(modelProbeOptions(undefined)).toEqual({ probeModelConfigOptions: false, probeModelConfigConcurrency: 1 })
    expect(executableOverrideEnvFor(undefined)).toBeUndefined()
  })

  it('discovers CodeBuddy and Qwen model-specific configuration by actual handshake identity', () => {
    expect(hasModelSpecificConfiguration('codebuddy-code')).toBe(true)
    expect(hasModelSpecificConfiguration('qwen-code')).toBe(true)
    for (const name of ['codebuddy', 'CodeBuddy', 'custom', undefined])
      expect(hasModelSpecificConfiguration(name)).toBe(false)
  })

  it('keeps stateful cancel replacement and protocol opt-ins limited to explicit bindings', () => {
    expect(sessionCompatibilityOptions('codebuddy')).toEqual({
      enableClaudeDraftSubagents: false,
      refreshSessionAfterCancelledPrompt: true,
    })
    expect(sessionCompatibilityOptions('claude')).toEqual({ enableClaudeDraftSubagents: true })
    expect(sessionCompatibilityOptions('codex')).toEqual({ enableClaudeDraftSubagents: false })
    expect(modelProbeOptions('devin').probeModelConfigConcurrency).toBe(8)
    expect(modelProbeOptions('codex').probeModelConfigConcurrency).toBe(1)
  })

  it('retires explicit and legacy bindings without assigning a generic runtime', () => {
    expect(ACP_AGENT_IDS).not.toContain('kimi')
    expect(retiredAgentReason('custom', { runtime: 'kimi' })).toBeDefined()
    expect(retiredAgentReason('kimi')).toBeDefined()
    expect(retiredAgentReason('kimi', { runtime: 'codex' })).toBeUndefined()
    expect(effectiveRuntimeOf('kimi', { runtime: 'codex' })).toBe('codex')
  })
})
