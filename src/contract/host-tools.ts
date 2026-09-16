/** Exact MCP tool names; never patterns or duplicated entries. */
export function validHostTools(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(name => typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name)) && new Set(value).size === value.length
}
