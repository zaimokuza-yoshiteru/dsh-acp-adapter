/** Immutable Agent differences. Shared connection, lifecycle and permission
 * owners consume these narrow facts; these modules never own a second client. */
import type { AcpAgentId } from '../contract/agent-config.ts'
import { antigravityCompatibility } from './antigravity.ts'
import { claudeCompatibility } from './claude.ts'
import { codebuddyHasModelSpecificConfiguration, codebuddySessionOptions } from './codebuddy.ts'
import { codexModelProbeOptions } from './codex.ts'
import { devinModelProbeOptions, devinToolDiscoveryInstructions } from './devin.ts'
import { qwenHasModelSpecificConfiguration } from './qwen.ts'

export function executableOverrideEnvFor(runtime: AcpAgentId | undefined): string | undefined {
  if (runtime === 'claude') return claudeCompatibility.executableOverrideEnv
  if (runtime === 'antigravity') return antigravityCompatibility.executableOverrideEnv
  return undefined
}

export function toolDiscoveryInstructions(runtime: string | undefined): string {
  return runtime === 'devin'
    ? devinToolDiscoveryInstructions
    : 'Use your MCP client’s supported discovery operations for this server to obtain the tool definitions you need. A truncated or partial catalog is not evidence that a tool is unavailable; retrieve the missing definitions before calling it.'
}

export function modelProbeOptions(runtime: AcpAgentId | undefined): {
  probeModelConfigOptions: boolean
  probeModelConfigConcurrency: number
} {
  if (runtime === 'devin') return devinModelProbeOptions
  if (runtime === 'codex') return codexModelProbeOptions
  return {
    probeModelConfigOptions: runtime === 'antigravity' && antigravityCompatibility.probeModelConfigOptions,
    probeModelConfigConcurrency: 1,
  }
}

/** These are observed protocol identities, not catalog names or profile ids. */
export function hasModelSpecificConfiguration(agentName: string | undefined): boolean {
  return codebuddyHasModelSpecificConfiguration(agentName) || qwenHasModelSpecificConfiguration(agentName)
}

export function sessionCompatibilityOptions(runtime: AcpAgentId | undefined): {
  enableClaudeDraftSubagents: boolean
  refreshSessionAfterCancelledPrompt?: true
} {
  return {
    enableClaudeDraftSubagents: runtime === 'claude' && claudeCompatibility.enableDraftSubagents,
    ...(runtime === 'codebuddy' ? codebuddySessionOptions : {}),
  }
}
