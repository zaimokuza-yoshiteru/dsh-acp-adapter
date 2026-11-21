/** Wire evidence is accepted only from ordinary ACP JSON objects. */
export function plainToolRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined
}

export function qualifiedMcpTool(serverName: string, value: unknown): string | undefined {
  const prefix = `mcp__${serverName}__`
  return typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}
