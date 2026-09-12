/** Standard MCP stdio transport for ACP Agents without HTTP support. No tool implementation lives here. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const endpoint = new URL(process.env.DSH_ACP_TEAM_MCP_URL ?? '')
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('ACP_TEAM_ENDPOINT_INVALID')
delete process.env.DSH_ACP_TEAM_MCP_URL
const client = new Client({ name: 'dsh-acp-team-stdio', version: '1.0.0' })
// The SDK's standard transport declares optional properties with explicit undefined.
await client.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client['connect']>[0])
const server = new Server({ name: 'DSH Agent Teams', version: '1.0.0' }, {
  capabilities: { tools: {} },
  ...(client.getInstructions() === undefined ? {} : { instructions: client.getInstructions()! }),
})
server.setRequestHandler(ListToolsRequestSchema, async () => await client.listTools())
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => await client.callTool(request.params, undefined, { signal: extra.signal, timeout: 3_660_000 }))
server.onclose = () => { void client.close() }
await server.connect(new StdioServerTransport())
