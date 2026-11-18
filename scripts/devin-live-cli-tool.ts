/** Fixed diagnostic vocabulary; unknown identifiers and arguments are never emitted. */
export type DevinCliToolKind =
  'dsh-subagent' | 'dsh-send-message' | 'dsh-other' | 'mcp-discovery' | 'mcp-dispatch' | 'native-subagent' | 'other'
export function classifyDevinCliTool(name: unknown, target: unknown, server: unknown): DevinCliToolKind {
  if (name === 'mcp__dsh__subagent') return 'dsh-subagent'
  if (name === 'mcp__dsh__send_message') return 'dsh-send-message'
  if (typeof name === 'string' && name.startsWith('mcp__dsh__')) return 'dsh-other'
  if (name === 'list_mcp_tools' || name === 'search_mcp_tools' || name === 'get_mcp_tool') return 'mcp-discovery'
  if (name === 'call_mcp_tool') {
    if (server === 'dsh' && target === 'subagent') return 'dsh-subagent'
    if (server === 'dsh' && target === 'send_message') return 'dsh-send-message'
    return 'mcp-dispatch'
  }
  if (name === 'subagent' || name === 'spawn_subagent') return 'native-subagent'
  return 'other'
}
