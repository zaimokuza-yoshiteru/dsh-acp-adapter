/** Generic DSH tools transport. This module contains no tool implementations or session registry. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const address = process.env.DSH_ACP_TEAM_MCP_URL
delete process.env.DSH_ACP_TEAM_MCP_URL
let client: Client | undefined
if (address !== undefined) {
  const endpoint = new URL(address)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
    throw new Error('ACP_DSH_ENDPOINT_INVALID')
  client = new Client({ name: 'dsh-tools-stdio', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(endpoint))
}
const server = new Server(
  { name: 'DSH tools', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    ...(client?.getInstructions() === undefined ? {} : { instructions: client.getInstructions()! }),
  },
)
// A standalone Devin sees an inert entry, never another session's tools.
server.setRequestHandler('tools/list', async () => (client === undefined ? { tools: [] } : await client.listTools()))
server.setRequestHandler('tools/call', async (request, context) => {
  if (client === undefined) return { isError: true, content: [{ type: 'text', text: 'No active DSH session' }] }
  return await client.callTool(request.params, { signal: context.mcpReq.signal, timeout: 3_660_000 })
})
server.onclose = () => {
  void client?.close()
}
await server.connect(new StdioServerTransport())
