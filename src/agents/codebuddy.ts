import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { isAnonymousCodeBuddyLaunch } from '../contract/codebuddy-profile.ts'
import { plainToolRecord, qualifiedMcpTool } from './mcp-tool.ts'
import type { AcpAgentId, AcpStubAgentConfig } from '../contract/agent-config.ts'

/** CodeBuddy resets its remote session after cancelling a prompt. The shared
 * runtime still owns cancellation, replacement, and durable binding updates. */
export function codebuddySessionOptions(
  runtime: AcpAgentId | undefined,
  profile?: Pick<AcpStubAgentConfig, 'command' | 'args' | 'runtime'>,
): { refreshSessionAfterCancelledPrompt?: (agentName: string | undefined) => boolean } {
  if (runtime === 'codebuddy') return { refreshSessionAfterCancelledPrompt: () => true }
  if (runtime !== undefined || !isAnonymousCodeBuddyLaunch(profile)) return {}
  return {
    refreshSessionAfterCancelledPrompt: (agentName) => agentName === undefined || isCodeBuddyPeer(agentName),
  }
}

/** Handshake identity also covers manually configured generic profiles. */
export function isCodeBuddyPeer(agentName: string | undefined): boolean {
  return agentName === 'codebuddy-code'
}

/** An empty result marks a conflicting or incomplete wrapper, preventing fallback to a remembered presentation. */
export function codeBuddyDeferredInput(
  call: ToolCallUpdate,
  serverName: string,
):
  | {
      tool?: string
      params?: Record<string, unknown>
    }
  | undefined {
  const input = plainToolRecord(call.rawInput)
  if (call.name !== 'DeferExecuteTool' && !(input && Object.hasOwn(input, 'toolName'))) return undefined
  const tool = qualifiedMcpTool(serverName, input?.toolName)
  const params = plainToolRecord(input?.params)
  if (tool === undefined || params === undefined) return {}
  if (call.name != null && call.name !== 'DeferExecuteTool' && qualifiedMcpTool(serverName, call.name) !== tool)
    return {}
  return { tool, params }
}
