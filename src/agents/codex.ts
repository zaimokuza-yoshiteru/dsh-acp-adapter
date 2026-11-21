import type { ToolCallUpdate, CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { plainToolRecord } from './mcp-tool.ts'

/** Codex exposes model-dependent reasoning choices; discovery remains serial. */
export const codexModelProbeOptions = {
  probeModelConfigOptions: true,
  probeModelConfigConcurrency: 1,
} as const

/** Codex and CodeBuddy may corroborate an MCP call with structured input. */
export function codexMcpInput(call: ToolCallUpdate, serverName: string): { tool?: string } | undefined {
  if (call._meta?.is_mcp_tool_call !== true) return undefined
  const input = plainToolRecord(call.rawInput)
  return input?.server === serverName && typeof input.tool === 'string' ? { tool: input.tool } : {}
}

export function codexElicitationTool(
  request: CreateElicitationRequest,
  call: ToolCallUpdate | undefined,
  serverName: string,
): string | undefined {
  const form = request as { toolCallId?: unknown }
  if (
    request.mode !== 'form' ||
    request._meta?.codex_approval_kind !== 'mcp_tool_call' ||
    call === undefined ||
    form.toolCallId === undefined ||
    call.toolCallId !== form.toolCallId
  )
    return undefined
  return codexMcpInput(call, serverName)?.tool
}

export function codexConflictsWithTool(call: ToolCallUpdate, serverName: string, tool: string): boolean {
  const input = plainToolRecord(call.rawInput)
  return (
    (input !== undefined &&
      ((Object.hasOwn(input, 'server') && input.server !== serverName) ||
        (Object.hasOwn(input, 'tool') && input.tool !== tool))) ||
    (call._meta != null && Object.hasOwn(call._meta, 'is_mcp_tool_call') && call._meta.is_mcp_tool_call !== true)
  )
}
