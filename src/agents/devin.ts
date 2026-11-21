/** Devin's separate model sessions permit bounded parallel discovery. */
export const devinModelProbeOptions = {
  probeModelConfigOptions: true,
  probeModelConfigConcurrency: 8,
} as const

/** Devin retains large discovery results in its own files, outside DSH tool output. */
export const devinToolDiscoveryInstructions =
  'To discover this server’s tools, use mcp_list_tools. If Devin saves the catalog to an overflow file, use Devin’s built-in grep to locate the needed definitions and read to inspect bounded sections of that exact returned file. Use those native tools directly. Never use exec, shell commands or DSH file tools to inspect the catalog. Your native tool permissions still apply. Use the discovered DSH tools through this MCP connection.'

/** Devin may identify an MCP call by its exact server-qualified display title. */
export function devinTitledTool(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const match = /^(?:Calling|Called) (.+) from dsh$/.exec(title)
  return match?.[0] === title ? match[1] : undefined
}

/** Only a plain native tool name can appear in the title-match audit indicator. */
export function devinToolTitleHint(title: unknown): string | undefined {
  const name = devinTitledTool(title)
  return name !== undefined && /^[a-zA-Z0-9_]+$/.test(name) ? name : undefined
}
