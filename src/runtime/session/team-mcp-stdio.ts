/** Generic DSH tools transport. This module contains no tool implementations or session registry. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const address = process.env.DSH_ACP_TEAM_MCP_URL
delete process.env.DSH_ACP_TEAM_MCP_URL
let client: Client | undefined
if (address !== undefined) {
  const endpoint = new URL(address)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('ACP_DSH_ENDPOINT_INVALID')
  client = new Client({ name: 'dsh-tools-stdio', version: '1.0.0' })
  // The SDK's transport declarations use optional properties with explicit undefined.
  await client.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client['connect']>[0])
}
const server = new Server({ name: 'DSH tools', version: '1.0.0' }, {
  capabilities: { tools: {} },
  ...(client?.getInstructions() === undefined ? {} : { instructions: client.getInstructions()! }),
})
// A standalone Devin sees an inert entry, never another session's tools.
server.setRequestHandler(ListToolsRequestSchema, async () => client === undefined ? { tools: [] } : await client.listTools())
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (client === undefined) return { isError: true, content: [{ type: 'text', text: 'No active DSH session' }] }
  return await client.callTool(request.params, undefined, { signal: extra.signal, timeout: 3_660_000 })
})
server.onclose = () => { void client?.close() }
await server.connect(new StdioServerTransport())
