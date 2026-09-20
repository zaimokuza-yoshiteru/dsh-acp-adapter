import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function connect(url?: string) {
  const client = new Client({ name: 'stdio-isolation-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../../src/runtime/session/team-mcp-stdio.ts', import.meta.url))],
    env: { ...(url === undefined ? {} : { DSH_ACP_TEAM_MCP_URL: url }), ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe',
  })
  cleanup.push(async () => { await client.close(); await transport.close() })
  await client.connect(transport as Parameters<Client['connect']>[0])
  return client
}
async function endpoint(name: string) {
  let calls = 0
  const http = createServer(async (request, response) => {
    const server = new Server({ name, version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name, inputSchema: { type: 'object' as const } }] }))
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name !== name) return { isError: true, content: [] }
      calls++
      return { content: [{ type: 'text', text: name }] }
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    response.once('close', () => { void server.close() })
    await server.connect(transport as Parameters<Server['connect']>[0])
    await transport.handleRequest(request, response)
  })
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())) })
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/private`, calls: () => calls }
}

it('is inert outside DSH and exposes no stale tools', async () => {
  const client = await connect()
  expect((await client.listTools()).tools).toEqual([])
  expect((await client.callTool({ name: 'old_session_tool' })).isError).toBe(true)
})

it('routes concurrent stdio children only to their own endpoint and rejects cross-session calls', async () => {
  const [a, b] = await Promise.all([endpoint('session_a_tool'), endpoint('session_b_tool')])
  const [one, two] = await Promise.all([connect(a.url), connect(b.url)])
  expect((await one.listTools()).tools.map(t => t.name)).toEqual(['session_a_tool'])
  expect((await two.listTools()).tools.map(t => t.name)).toEqual(['session_b_tool'])
  expect((await one.callTool({ name: 'session_a_tool' })).content).toEqual([{ type: 'text', text: 'session_a_tool' }])
  expect((await two.callTool({ name: 'session_b_tool' })).content).toEqual([{ type: 'text', text: 'session_b_tool' }])
  expect((await one.callTool({ name: 'session_b_tool' })).isError).toBe(true)
  expect(a.calls()).toBe(1); expect(b.calls()).toBe(1)
})
