// Synthetic Devin ACP peer. Only a one-time grant on the wire triggers its actual MCP request.
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const sessionId = 'review-bridge'
const toolCallId = 'ticket-lookup'
const name = 'ticket_title'
const args = { issueKey: 'DEMO-1' }
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } })
let server
let promptId

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  switch (frame.method) {
    case 'initialize':
      send({
        id: frame.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'affogato', title: 'Devin Agent', version: '3000.14.30821' },
          agentCapabilities: { mcpCapabilities: { http: true } },
        },
      })
      break
    case 'session/new':
      server = frame.params.mcpServers.find((server) => server.name === 'dsh')
      send({ id: frame.id, result: { sessionId } })
      break
    case 'session/prompt':
      promptId = frame.id
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        name,
        title: 'Calling ticket_title from dsh',
        kind: 'read',
        status: 'pending',
        rawInput: args,
      })
      send({
        id: 'permission',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId },
          options: [
            { optionId: 'this-call', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'all-calls', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'decline', kind: 'reject_once', name: 'Decline' },
          ],
        },
      })
      break
    default: {
      if (frame.id !== 'permission') break
      const permission = frame.result?.outcome
      let call
      if (permission?.outcome === 'selected' && permission.optionId === 'this-call') {
        const client = new Client({ name: 'review-bridge-fixture', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
          call = await client.callTool({ name, arguments: args })
        } finally {
          await client.close()
        }
      }
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify({ permission, call }) },
      })
      send({ id: promptId, result: { stopReason: 'end_turn' } })
    }
  }
}
