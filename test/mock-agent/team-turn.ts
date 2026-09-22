import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { MockSession, PromptMessage, MockPeer } from './types.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function teamTurn(session: MockSession, msg: PromptMessage, { sendUpdate, sendAgentRequest, respond, log }: MockPeer) {
  const prompt = msg.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (!prompt.includes('E2E_TEAM_')) return false
  const client = new Client({ name: 'acp-team-fixture', version: '1' })
  const turn = { cancelled: false, cancel() { this.cancelled = true } }
  session.turn = turn
  const server = session.mcpServers?.[0]
  const say = (text: string) => { log(text); sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) }
  let ordinal = 0
  try {
    if (/\bE2E_TEAM_(?:MEMBER|CONTINUE)\b/.test(prompt) && /Approval prompts are disabled in this session|operations that require approval are rejected automatically/.test(prompt)) throw new Error('Member first prompt incorrectly disables approval')
    if (!server) throw new Error('No Teams MCP server provided')
    const transport = server.type === 'http' ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])), stderr: 'pipe' })
    if ('stderr' in transport) transport.stderr?.on('data', data => log(`team stdio: ${String(data)}`))
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    const call = async (shortName: string, args: Record<string, unknown> = {}, expectedError?: string) => {
      const tool = tools.find(tool => tool.name.endsWith(`_${shortName}`))
      if (!tool) throw new Error(`Missing ${shortName}`)
      const toolCallId = `team-${++ordinal}`
      const name = `mcp__${server.name}__${tool.name}`
      const profile = process.env.MOCK_PROFILE
      const toolCall = { toolCallId, title: shortName, kind: 'other', status: 'pending', rawInput: args,
        ...(profile === 'claude' ? { _meta: { claudeCode: { toolName: name } } }
          : profile === 'devin' ? { title: `Calling ${tool.name} from ${server.name}` }
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
      const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: args }))
      sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', content: result.content.map(content => ({ type: 'content', content })) })
      if (expectedError) {
        const text = JSON.stringify(result.content)
        if (!result.isError || !text.includes(expectedError)) throw new Error(`Expected ${expectedError}; got ${text}`)
        log(`team rejected ${expectedError}`)
        return
      }
      if (result.isError) throw new Error(JSON.stringify(result.content))
      log(`team ${shortName} ${JSON.stringify(result.content)}`)
      const first = result.content[0]
      if (!first || first.type !== 'text') throw new Error('Expected team tool JSON text')
      return JSON.parse(first.text)
    }
    const roster = await call('list_agents')
    log(`team model=${session.configOptions?.find(option => option.id === 'model')?.currentValue}`)
    if (/\bE2E_TEAM_INTERRUPT\b/.test(prompt)) {
      await call('interrupt_agent', { target: 'calculator' })
      say('E2E_TEAM_INTERRUPTED')
    } else if (prompt.includes('E2E_TEAM_LAYOUT')) {
      for (const [name, description] of [
        ['worker-deepseek-harness', 'Owner worker for reference/deepseek-harness (DSH agent harness, TypeScript monorepo). Review native message rendering and plugin compatibility.'],
        ['worker-deer-flow', 'Owner worker for reference/deer-flow (Python LangGraph + Node frontend). Review streaming, tools and approval boundaries.'],
      ]) await call('spawn_teammate', { name, description, prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      say('E2E_TEAM_LAYOUT_READY')
    } else if (prompt.includes('E2E_TEAM_DEMO')) {
      const task = await call('team_task_create', { subject: '整理需求', description: '梳理成员管理和集中审批的验收要点' })
      await call('team_task_create', { subject: '复核方案', description: '等待需求整理完成，再检查边界', blocked_by: [task.id] })
      await call('spawn_teammate', { name: 'analyst', description: '整理需求与验收要点', prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      await call('spawn_teammate', { name: 'reviewer', description: '检查实现与审批边界', prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      say('团队演示已就绪。两个成员的审批可在下方直接处理；点击右上角人员图标，可查看成员模式，并按 ACP 类型批量调整成员模式；休眠成员下次运行生效。共享任务在原生 Agent Team 面板中。此实例使用本地测试 Agent。')
    } else if (prompt.includes('E2E_TEAM_EIGHT')) {
      for (let index = 1; index <= 8; index++) await call('spawn_teammate', { name: `worker-${index}`, description: 'Batch approval member', prompt: `E2E_TEAM_MEMBER calculate 1+1${index === 1 ? ' E2E_TEAM_FOLLOWUP_PERMISSION' : ''}`, context: 'fresh' })
      say('E2E_TEAM_EIGHT_READY')
    } else if (prompt.includes('E2E_TEAM_SECOND')) {
      await call('spawn_teammate', { name: 'calculator-b', description: 'Model B member', prompt: 'E2E_TEAM_MEMBER calculate 1+1', context: 'fresh' })
      say('E2E_TEAM_SECOND_READY')
    } else if (prompt.includes('E2E_TEAM_WAKE')) {
      await call('send_message', { target: 'calculator', message: 'E2E_TEAM_CONTINUE' })
      say('E2E_TEAM_WOKEN')
    } else if (prompt.includes('E2E_TEAM_REPLY')) {
      say('E2E_TEAM_LEAD_RECEIVED')
    } else if (/\bE2E_TEAM_CONTINUE\b/.test(prompt)) {
      say(`E2E_TEAM_MEMBER_MODE ${session.configOptions?.find(option => option.id === 'mode')?.currentValue}`)
      await call('send_message', { target: 'lead', message: 'E2E_TEAM_REPLY continued' })
      say('E2E_TEAM_MEMBER_CONTINUED')
    } else if (/\bE2E_TEAM_MEMBER\b/.test(prompt)) {
      await call('spawn_teammate', { name: 'nested', description: 'Denied nested spawn', prompt: 'do nothing' }, 'only the Team Lead')
      sendUpdate(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private fixture reasoning' } })
      const response = await sendAgentRequest('session/request_permission', { sessionId: session.id,
        toolCall: { toolCallId: 'member-shell', name: 'bash', title: 'Run member command', kind: 'execute', rawInput: { command: 'echo E2E_TEAM_PERMISSION' } },
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject' }] })
      if (prompt.includes('E2E_TEAM_FOLLOWUP_PERMISSION')) {
        const answer = await sendAgentRequest('session/request_permission', { sessionId: session.id,
          toolCall: { toolCallId: 'member-late-shell', name: 'bash', title: 'Run next member command', kind: 'execute', rawInput: { command: 'echo E2E_TEAM_LATE_PERMISSION' } },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject' }] })
        if (answer.outcome?.optionId !== 'deny') throw new Error(`Unexpected late permission: ${JSON.stringify(answer)}`)
        say('E2E_TEAM_LATE_DENIED')
      }
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
    if (turn.cancelled) log('team cancelled')
    else {
      log(`team failed ${(error instanceof Error ? error.stack : String(error))}`)
      say(`E2E_TEAM_ERROR ${(error instanceof Error ? error.message : String(error))}`)
    }
  } finally {
    await client.close()
    respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' })
    if (session.turn === turn) session.turn = null
  }
  return true
}
