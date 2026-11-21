import { reviewPeerStatus } from './review-peer.ts'
import type { AcpAgentConfig } from './agent-config.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from './config-options.ts'

// Interactive forms, delegation and extension-defined tools have different decision owners.
const reviewTools = new Set(['read', 'write', 'edit', 'patch', 'shell', 'glob', 'grep', 'webfetch', 'websearch'])

export function isOpenCodeReviewTool(name: string | null | undefined): boolean {
  return name != null && reviewTools.has(name)
}

export function isLocalOpenCodeReviewProfile(profile: Pick<AcpAgentConfig, 'command' | 'args'>): boolean {
  return (
    /^opencode(?:\.exe)?$/i.test(profile.command.split(/[\\/]/).at(-1) ?? '') &&
    profile.args.length === 1 &&
    profile.args[0] === 'acp'
  )
}

export function isOpenCodeReviewerAgent(info: Parameters<typeof reviewPeerStatus>[1]): boolean {
  return reviewPeerStatus('opencode', info) === 'verified'
}

/** A model explicitly chosen from the native catalog; OpenRouter IDs may include another slash. */
export function isOpenCodeReviewModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ACP_CONFIG_IDENTIFIER_MAX &&
    /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.:/-]*$/.test(value) &&
    !value.endsWith('/') &&
    !value.includes('//')
  )
}
