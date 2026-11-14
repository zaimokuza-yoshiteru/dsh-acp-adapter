/** Devin's separate model sessions permit bounded parallel discovery. */
export const devinModelProbeOptions = {
  probeModelConfigOptions: true,
  probeModelConfigConcurrency: 8,
} as const

/** Devin retains large discovery results in its own files, outside DSH tool output. */
export const devinToolDiscoveryInstructions =
  'To discover this server’s tools, use mcp_list_tools. If Devin saves the catalog to an overflow file, use Devin’s built-in grep to locate the needed definitions and read to inspect bounded sections of that exact returned file. Use those native tools directly. Never use exec, shell commands or DSH file tools to inspect the catalog. Your native tool permissions still apply. Use the discovered DSH tools through this MCP connection.'
