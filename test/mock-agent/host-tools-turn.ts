import type { MockSession, PromptMessage, MockPeer } from './types.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function hostToolsTurn(session: MockSession, msg: PromptMessage, { sendUpdate, sendAgentRequest, respond }: Omit<MockPeer, 'log'>) {
  const prompt = msg.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const present = prompt.includes('E2E_PRESENT')
  const shell = prompt.includes('E2E_HOST_BASH')
  if (!present && !shell && !prompt.includes('E2E_HOST_TOOLS')) return false
  const client = new Client({ name: 'host-tool-fixture', version: '1' })
  try {
    const server = session.mcpServers?.[0]
    if (!server) throw new Error('No DSH tools bridge')
    await client.connect(server.type === 'http' ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])), stderr: 'pipe' }))
    const tools = (await client.listTools()).tools
    const tool = tools.find(tool => tool.name === (shell ? 'bash' : present ? 'present' : prompt.includes('E2E_HOST_TOOLS_LATE') ? 'e2e_late_fixture' : 'e2e_fixture'))
    if (!tool) throw new Error('Native DSH tool was not discovered automatically')
    const codex = process.env.MOCK_PROFILE === 'codex'
    const shellArgs = { command: 'printf E2E_DSH_BASH_OK', description: 'Verify native command approval' }
    const toolCall = { toolCallId: 'host-plugin', name: `mcp__${server.name}__${tool.name}`, title: 'DSH plugin fixture', kind: 'other', status: 'pending', rawInput: {},
      ...(shell ? { name: null, title: `Calling ${tool.name} from ${server.name}`, rawInput: shellArgs } : {}),
      ...(codex ? { _meta: { is_mcp_tool_call: true }, rawInput: { server: server.name, tool: tool.name, arguments: {} } } : {}) }
    sendUpdate(session.id, { sessionUpdate: 'tool_call', ...toolCall })
    if (codex) {
      const answer = await sendAgentRequest('elicitation/create', { sessionId: session.id, toolCallId: toolCall.toolCallId,
        mode: 'form', message: `Allow the ${server.name} MCP server to run tool "${tool.name}"?`,
        _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {
          persist: { type: 'string', title: 'Approval scope', oneOf: [
            { const: 'once', title: 'Allow once' }, { const: 'session', title: 'Allow for this session' }, { const: 'always', title: "Allow and don't ask again" },
          ] },
        }, required: ['persist'] },
      })
      if (answer.action !== 'accept' || answer.content?.persist !== (present ? 'always' : 'session')) throw new Error('Incorrect Codex approval scope')
    } else {
      const answer = await sendAgentRequest('session/request_permission', { sessionId: session.id, toolCall,
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow this operation' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject this operation' }] })
      if (answer.outcome?.optionId !== 'allow') throw new Error('Fixture permission rejected')
    }
    const result = await client.callTool({ name: tool.name, ...(shell ? { arguments: shellArgs } : present ? { arguments: { files: [{ path: 'delivery.txt', description: 'ACP delivery through native DSH' }] } } : {}) })
    if (result.isError || !JSON.stringify(result).includes(shell ? 'E2E_DSH_BASH_OK' : present ? 'Presented delivery.txt' : 'E2E_HOST_POST')) throw new Error(`Native hook output missing: ${JSON.stringify(result)}`)
    sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed', rawOutput: result })
    sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: present ? 'E2E_PRESENT_DONE' : 'E2E_HOST_TOOLS_DONE' } })
    respond(msg.id, { stopReason: 'end_turn' })
    return true
  } finally { await client.close() }
}
