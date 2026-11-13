import type { MockSession, PromptMessage, MockPeer } from './types.ts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CallToolResultSchema } from '@modelcontextprotocol/core'

/** Exercise the optional composition through the actual Agent-facing MCP catalog. */
export async function presetTurn(session: MockSession, msg: PromptMessage, peer: MockPeer) {
  const prompt = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (!prompt.includes('E2E_ACP_PRESET')) return false
  const client = new Client({ name: 'acp-preset-fixture', version: '1' })
  try {
    const server = session.mcpServers?.[0]
    if (!server) throw new Error('Missing native tool bridge')
    await client.connect(
      server.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url))
        : new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            stderr: 'pipe',
          }),
    )
    const tools = (await client.listTools()).tools.map(({ name }) => name)
    for (const name of [
      'skill',
      'read',
      'edit',
      process.platform === 'win32' ? 'pwsh' : 'bash',
      'todo_write',
      'present',
    ]) {
      if (!tools.includes(name)) throw new Error(`Missing preset tool ${name}`)
    }
    if (tools.includes('plugin_manager') || tools.includes('subagent'))
      throw new Error('Unexpected prototype capability')
    const skill = CallToolResultSchema.parse(
      await client.callTool({ name: 'skill', arguments: { name: 'acp-preset-fixture' } }),
    )
    if (skill.isError || !JSON.stringify(skill.content).includes('ACP_PRESET_SKILL_CONTENT'))
      throw new Error(`Skill did not load: ${JSON.stringify(skill)}`)
    peer.log(`preset session=${session.id} tools=${JSON.stringify(tools)}`)
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'E2E_ACP_PRESET_OK' },
    })
    peer.respond(msg.id, { stopReason: 'end_turn' })
  } catch (error) {
    peer.log(`preset error=${String(error)}`)
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_ACP_PRESET_FAILED ${String(error)}` },
    })
    peer.respond(msg.id, { stopReason: 'end_turn' })
  } finally {
    await client.close()
  }
  return true
}
