import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function hostToolsTurn(session, msg, { sendUpdate, sendAgentRequest, respond }) {
  if (!msg.params.prompt.some(block => block.type === 'text' && block.text.includes('E2E_HOST_TOOLS'))) return false
  const client = new Client({ name: 'host-tool-fixture', version: '1' })
  try {
    const server = session.mcpServers?.[0]
    if (!server) throw new Error('No DSH tools bridge')
    await client.connect(server.type === 'http' ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])), stderr: 'pipe' }))
    const tools = (await client.listTools()).tools
    if (tools.length !== 1 || !tools[0].name.endsWith('_e2e_fixture')) throw new Error('Unexpected DSH tools exposed')
    const tool = tools[0]
    const toolCall = { toolCallId: 'host-plugin', name: `mcp__${server.name}__${tool.name}`, title: 'DSH plugin fixture', kind: 'other', status: 'pending', rawInput: {} }
    sendUpdate(session.id, { sessionUpdate: 'tool_call', ...toolCall })
    const answer = await sendAgentRequest('session/request_permission', { sessionId: session.id, toolCall,
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow this operation' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject this operation' }] })
    if (answer.outcome?.optionId !== 'allow') throw new Error('Fixture permission rejected')
    const result = await client.callTool({ name: tool.name })
    if (result.isError || !JSON.stringify(result).includes('E2E_HOST_POST')) throw new Error(`Native hook output missing: ${JSON.stringify(result)}`)
    sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed', rawOutput: result })
    sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'E2E_HOST_TOOLS_DONE' } })
    respond(msg.id, { stopReason: 'end_turn' })
    return true
  } finally { await client.close() }
}
