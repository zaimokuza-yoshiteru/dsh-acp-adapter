import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { plainToolRecord, qualifiedMcpTool } from './mcp-tool.ts'

/** Refined Antigravity wrapper's documented executable override. */
export const antigravityCompatibility = {
  executableOverrideEnv: 'REFINED_AGY_ACP_BIN',
  probeModelConfigOptions: true,
} as const

/** Match only the observed Antigravity interaction transport signature; this is not permission authority. */
export function isAntigravityInteractionCall(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const call = value as Record<string, unknown>
  if (
    typeof call.toolCallId !== 'string' ||
    !/^interaction_[0-9a-f]{8}$/.test(call.toolCallId) ||
    typeof call.title !== 'string' ||
    call.title.trim() === '' ||
    call.name != null ||
    call.kind != null
  )
    return false

  const rawInput = call.rawInput
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return false
  const prototype = Object.getPrototypeOf(rawInput)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(rawInput).length !== 0) return false

  const meta = call._meta
  if (meta != null) {
    if (typeof meta !== 'object' || Array.isArray(meta)) return false
    const metadata = meta as Record<string, unknown>
    if (
      [
        'mcp',
        'is_mcp_tool_call',
        'server',
        'serverName',
        'tool',
        'toolName',
        'claudeCode',
        'cognition.ai/toolName',
      ].some((key) => key in metadata)
    )
      return false
  }
  return !['server', 'serverName', 'tool', 'toolName', 'mcp', 'is_mcp_tool_call'].some((key) => key in call)
}

/** Only the matching MCP envelope can identify an advertised Antigravity tool. */
export function antigravityToolIdentity(
  call: ToolCallUpdate,
  serverName: string,
): {
  tool?: string
  source?: 'antigravity-meta' | 'name'
} {
  if (isAntigravityInteractionCall(call)) return {}
  const metadata = plainToolRecord(call._meta)
  const mcp = plainToolRecord(metadata?.mcp)
  const hasMetadataIdentity =
    metadata !== undefined &&
    ['mcp', 'is_mcp_tool_call', 'server', 'serverName', 'tool', 'toolName'].some((key) => Object.hasOwn(metadata, key))
  if (metadata === undefined || mcp === undefined) {
    return {
      ...(call.name == null ? {} : { source: 'name' }),
      ...(hasMetadataIdentity ? { source: 'antigravity-meta' } : {}),
    }
  }

  const server = mcp.server
  const tool = mcp.tool
  if (typeof server !== 'string' || server.length === 0 || server !== serverName) return { source: 'antigravity-meta' }
  if (typeof tool !== 'string' || tool.length === 0) return { source: 'antigravity-meta' }
  const metaMatches = (record: Record<string, unknown>, key: string, expected: string): boolean =>
    !Object.hasOwn(record, key) || record[key] === expected
  const nameMatches =
    call.name == null ||
    call.name === tool ||
    call.name === `mcp__${serverName}__${tool}` ||
    call.name === `${serverName}_${tool}`
  const claudeCode = plainToolRecord(metadata.claudeCode)
  const claudeIdentityValid =
    !Object.hasOwn(metadata, 'claudeCode') ||
    (claudeCode !== undefined &&
      Object.hasOwn(claudeCode, 'toolName') &&
      qualifiedMcpTool(serverName, claudeCode.toolName) === tool)
  const devinIdentityValid =
    !Object.hasOwn(metadata, 'cognition.ai/toolName') ||
    qualifiedMcpTool(serverName, metadata['cognition.ai/toolName']) === tool

  if (
    !nameMatches ||
    (Object.hasOwn(metadata, 'is_mcp_tool_call') && metadata.is_mcp_tool_call !== true) ||
    !metaMatches(metadata, 'server', server) ||
    !metaMatches(metadata, 'serverName', server) ||
    !metaMatches(metadata, 'tool', tool) ||
    !metaMatches(metadata, 'toolName', tool) ||
    !metaMatches(mcp, 'serverName', server) ||
    !metaMatches(mcp, 'toolName', tool) ||
    !claudeIdentityValid ||
    !devinIdentityValid
  )
    return { source: 'antigravity-meta' }
  return { tool, source: 'antigravity-meta' }
}

/** An unqualified title may identify a presentation row, never a permission. */
export function antigravityTitledTool(title: unknown, serverName: string): string | undefined {
  const prefix = `${serverName}_`
  return typeof title === 'string' && title.startsWith(prefix) ? title.slice(prefix.length) : undefined
}

export function antigravityPresentationTool(call: ToolCallUpdate, serverName: string): string | undefined {
  const name = antigravityTitledTool(call.title, serverName)
  return name !== undefined &&
    (call.name == null ||
      call.name === name ||
      call.name === `mcp__${serverName}__${name}` ||
      call.name === `${serverName}_${name}`)
    ? name
    : undefined
}
