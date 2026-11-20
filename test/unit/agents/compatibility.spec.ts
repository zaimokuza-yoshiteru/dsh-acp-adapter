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

  it('scopes cancellation refresh to explicit CodeBuddy and verified direct launches', () => {
    const profile = { command: '/opt/bin/codebuddy', args: ['--acp'] }
    const explicit = sessionCompatibilityOptions('codebuddy').refreshSessionAfterCancelledPrompt
    expect(explicit?.(undefined)).toBe(true)
    const manual = sessionCompatibilityOptions(undefined, profile).refreshSessionAfterCancelledPrompt
    expect(manual?.(undefined)).toBe(true)
    expect(manual?.('codebuddy-code')).toBe(true)
    expect(manual?.('OpenCode')).toBe(false)
    expect(sessionCompatibilityOptions('codex', profile).refreshSessionAfterCancelledPrompt).toBeUndefined()
    for (const launch of [
      { ...profile, command: 'custom-wrapper' },
      { ...profile, args: ['--acp', '--custom'] },
      { command: 'npx', args: ['-y', '@tencent-ai/codebuddy-code', '--acp'] },
    ])
      expect(sessionCompatibilityOptions(undefined, launch).refreshSessionAfterCancelledPrompt).toBeUndefined()
  })

  it('keeps other runtime opt-ins on their explicit bindings', () => {
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
