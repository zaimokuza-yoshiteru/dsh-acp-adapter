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
