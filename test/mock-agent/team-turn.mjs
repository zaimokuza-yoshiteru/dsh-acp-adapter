import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function teamTurn(session, msg, { sendUpdate, sendAgentRequest, respond, log }) {
  const prompt = msg.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (!prompt.includes('E2E_TEAM_')) return false
  const client = new Client({ name: 'acp-team-fixture', version: '1' })
  const server = session.mcpServers?.[0]
  const say = text => { log(text); sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) }
  let ordinal = 0
  try {
    if (!server) throw new Error('No Teams MCP server provided')
    const transport = server.type === 'http' ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])), stderr: 'pipe' })
    if ('stderr' in transport) transport.stderr?.on('data', data => log(`team stdio: ${String(data)}`))
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    const call = async (shortName, args = {}, expectedError) => {
      const tool = tools.find(tool => tool.name.endsWith(`_${shortName}`))
      if (!tool) throw new Error(`Missing ${shortName}`)
      const toolCallId = `team-${++ordinal}`
      const name = `mcp__${server.name}__${tool.name}`
      const profile = process.env.MOCK_PROFILE
      const toolCall = { toolCallId, title: shortName, kind: 'other', status: 'pending', rawInput: args,
        ...(profile === 'claude' ? { _meta: { claudeCode: { toolName: name } } }
          : profile === 'devin' ? { _meta: { 'cognition.ai/toolName': name } }
            : profile === 'kimi' ? { title: name }
              : { title: `mcp.${server.name}.${tool.name}`, _meta: { is_mcp_tool_call: true }, rawInput: { server: server.name, tool: tool.name, arguments: args } }) }
      sendUpdate(session.id, { sessionUpdate: 'tool_call', ...toolCall })
      if (profile === 'codex') {
        const permission = await sendAgentRequest('elicitation/create', { sessionId: session.id, toolCallId, mode: 'form', message: 'Approve MCP tool',
          _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } }, required: ['persist'] } })
        if (permission.action !== 'accept' || permission.content?.persist !== 'once') throw new Error('Team elicitation required extra approval')
      } else {
        const permission = await sendAgentRequest('session/request_permission', { sessionId: session.id, toolCall,
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject' }] })
        if (permission.outcome?.optionId !== 'allow') throw new Error('Team coordination required extra approval')
      }
      const result = await client.callTool({ name: tool.name, arguments: args })
      sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', content: result.content.map(content => ({ type: 'content', content })) })
      if (expectedError) {
        const text = JSON.stringify(result.content)
        if (!result.isError || !text.includes(expectedError)) throw new Error(`Expected ${expectedError}; got ${text}`)
        log(`team rejected ${expectedError}`)
        return
      }
      if (result.isError) throw new Error(JSON.stringify(result.content))
      log(`team ${shortName} ${JSON.stringify(result.content)}`)
      return JSON.parse(result.content[0].text)
    }
    const roster = await call('list_agents')
    log(`team model=${session.configOptions.find(option => option.id === 'model')?.currentValue}`)
    if (/\bE2E_TEAM_INTERRUPT\b/.test(prompt)) {
      await call('interrupt_agent', { target: 'calculator' })
      say('E2E_TEAM_INTERRUPTED')
    } else if (prompt.includes('E2E_TEAM_SECOND')) {
      await call('spawn_teammate', { name: 'calculator-b', description: 'Model B member', prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      say('E2E_TEAM_SECOND_READY')
    } else if (prompt.includes('E2E_TEAM_WAKE')) {
      await call('send_message', { target: 'calculator', message: 'E2E_TEAM_CONTINUE' })
      say('E2E_TEAM_WOKEN')
    } else if (prompt.includes('E2E_TEAM_REPLY')) {
      say('E2E_TEAM_LEAD_RECEIVED')
    } else if (/\bE2E_TEAM_CONTINUE\b/.test(prompt)) {
      await call('send_message', { target: 'lead', message: 'E2E_TEAM_REPLY continued' })
      say('E2E_TEAM_MEMBER_CONTINUED')
    } else if (/\bE2E_TEAM_MEMBER\b/.test(prompt)) {
      await call('spawn_teammate', { name: 'nested', description: 'Denied nested spawn', prompt: 'do nothing' }, 'only the Team Lead')
      sendUpdate(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private fixture reasoning' } })
      const response = await sendAgentRequest('session/request_permission', { sessionId: session.id,
        toolCall: { toolCallId: 'member-shell', name: 'bash', title: 'Run member command', kind: 'execute', rawInput: { command: 'echo E2E_TEAM_PERMISSION' } },
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject' }] })
      if (response.outcome?.optionId !== 'allow') {
        say(response.outcome?.outcome === 'cancelled' ? 'E2E_TEAM_MEMBER_CANCELLED' : 'E2E_TEAM_MEMBER_DENIED')
        return true
      }
      await call('send_message', { target: 'lead', message: 'E2E_TEAM_REPLY result=2' })
      say('E2E_TEAM_MEMBER_DONE')
    } else if (prompt.includes('E2E_TEAM_START')) {
      if (roster.length !== 1) throw new Error('Expected fresh team')
      const wait = await call('wait_agent', { timeout_ms: 10_000 })
      if (!wait.noProgress) throw new Error('Native wait must not poll without an active peer')
      const task = await call('team_task_create', { subject: 'Compute fixture', description: 'Return 2' })
      await call('team_task_get', { task_id: task.id })
      await call('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'claim' })
      await call('team_task_list')
      await call('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'complete' }, 'stale team task')
      const blocked = await call('team_task_create', { subject: 'Blocked fixture', description: 'Wait for compute', blocked_by: [task.id] })
      await call('team_task_update', { task_id: blocked.id, expected_revision: blocked.revision, action: 'claim' }, 'not ready to claim')
      await call('send_message', { target: 'missing-member', message: 'must not deliver' }, 'not found')
      for (const override of [{ context: 'fork' }, { model: 'mock-model-b' }, { agent: 'other' }, { provider: 'acp-other' }]) {
        await call('spawn_teammate', { name: 'invalid', description: 'Must not create', prompt: 'do nothing', ...override }, override.context ? 'ACP_TEAM_FORK_UNSUPPORTED' : 'ACP_TEAM_ROUTE_OVERRIDE_UNSUPPORTED')
      }
      await call('spawn_teammate', { name: 'calculator', description: 'Compute fixture', prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      say('E2E_TEAM_READY')
    } else {
      say('E2E_TEAM_NOTICE_RECEIVED')
    }
  } catch (error) {
    log(`team failed ${error.stack}`)
    say(`E2E_TEAM_ERROR ${error.message}`)
  } finally {
    await client.close()
    respond(msg.id, { stopReason: 'end_turn' })
    session.turn = null
  }
  return true
}
