import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type * as acp from '@agentclientprotocol/sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'

const TEAM_TOOLS = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
] as const

/** Changes when the optional host feature or its scoped tool owner changes. */
export function teamBridgeKey(ctx: Context, sessionId: string): unknown {
  const teams = ctx.get('agentTeams')
  const agent = ctx.get('agents', false)?.get(sessionId as never)
  if (teams === undefined || agent === undefined || teams.tryMembership(agent) === undefined) return undefined
  const tools = ctx.get('tools', false)
  if (tools === undefined || TEAM_TOOLS.some(name => tools.get(name, agent) === undefined)) return undefined
  return tools.get('spawn_teammate', agent)
}

/** Optional host lookup: loading the adapter never enables Teams itself. */
export async function createTeamBridge(
  ctx: Context, sessionId: string, capabilities: acp.AgentCapabilities | undefined, wireProfile?: string,
): Promise<AcpMcpLease | undefined> {
  const teams = ctx.get('agentTeams')
  const agents = ctx.get('agents', false)
  const tools = ctx.get('tools', false)
  const agent = agents?.get(sessionId as never)
  if (teams === undefined || agents === undefined || tools === undefined || agent === undefined || teams.tryMembership(agent) === undefined) return undefined
  const definitions = new Map<string, ToolDefinition>()
  for (const name of TEAM_TOOLS) {
    const definition = tools.get(name, agent)
    if (definition === undefined) return undefined
    definitions.set(name, definition)
  }
  const lifetime = new AbortController()
  let prompt: AbortSignal | undefined
  const nonce = randomBytes(8).toString('hex')
  const serverName = `dshteam_${nonce}`
  const path = `/${randomBytes(32).toString('hex')}`
  // Names are connection-specific capabilities, not a global name-based approval bypass.
  const names = new Map([...definitions].map(([name, definition]) => [`${nonce}_${name}`, definition]))
  const presented = new Map<string, string>()
  const definitionOf = (call: acp.ToolCallUpdate): ToolDefinition | undefined => {
    const input = call.rawInput as { server?: unknown; tool?: unknown } | undefined
    if (wireProfile === 'codex' && call._meta?.is_mcp_tool_call === true && input?.server === serverName && typeof input.tool === 'string') return names.get(input.tool)
    // Kimi uses the full qualified tool name as title; this mapping is descriptor-bound.
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const name = call.name ?? meta?.toolName ?? call._meta?.['cognition.ai/toolName'] ?? (wireProfile === 'kimi' ? call.title : undefined)
    if (typeof name !== 'string') return undefined
    return [...names].find(([tool]) => name === tool || name === `mcp__${serverName}__${tool}`)?.[1]
  }
  // Cordis returns a caller-context proxy for each service lookup, so proxy identity is not service identity.
  const live = (): boolean => !lifetime.signal.aborted && ctx.get('agentTeams') !== undefined
    && agents.get(sessionId as never) === agent && teams.tryMembership(agent) !== undefined
    && [...definitions].every(([name, definition]) => tools.get(name, agent) === definition)
  const sessions = new Set<Server>()
  const calls = new Set<Promise<unknown>>()
  const http = createServer((request, response) => {
    if (!live() || request.url !== path || request.headers.origin !== undefined
      || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403).end()
      return
    }
    const server = new Server({ name: 'DSH Agent Teams', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Use these tools for DSH Agent Teams when the user explicitly requests a team. Members share the workspace. Only fresh context is supported by this ACP bridge. Use the exact tool names from tools/list.',
    })
    sessions.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...names].filter(([, definition]) => tools.get(definition.name, agent) === definition).map(([name, definition]) => ({
        name, description: definition.description,
        inputSchema: {
          ...definition.parameters,
          type: 'object' as const,
          ...(definition.name !== 'spawn_teammate' ? {} : { additionalProperties: false, properties: {
            ...(definition.parameters.properties as Record<string, unknown>),
            context: { type: 'string', enum: ['fresh'], description: 'Fresh ACP session; history fork is unsupported.' },
          } }),
        },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const call = (async () => {
        const definition = names.get(request.params.name)
        if (!live() || prompt === undefined || prompt.aborted) throw new Error('ACP_TEAM_PROMPT_INACTIVE')
        if (definition === undefined || tools.get(definition.name, agent) !== definition) throw new Error('ACP_TEAM_TOOL_UNAVAILABLE')
        const args = request.params.arguments ?? {}
        if (definition.name === 'spawn_teammate' && Object.keys(args).some(key => !['name', 'description', 'prompt', 'context'].includes(key))) throw new Error('ACP_TEAM_ROUTE_OVERRIDE_UNSUPPORTED: teammates inherit the lead Agent and model')
        if (definition.name === 'spawn_teammate' && args.context !== undefined && args.context !== 'fresh') throw new Error('ACP_TEAM_FORK_UNSUPPORTED: use fresh context')
        const result = await tools.execute({
          callId: `acp-team-${randomUUID()}` as never, name: definition.name, arguments: args, agent,
          signal: AbortSignal.any([lifetime.signal, prompt, extra.signal]),
        })
        for (const context of result.additionalContexts ?? []) agent.steer(context)
        const content = result.content.filter(block => block.type === 'text')
        // Do not steal or duplicate inbox messages. Only the native loop claims them.
        if (agent.inbox.nextStep.length > 0) content.push({ type: 'text', text: 'DSH has queued input for your next step. End this ACP response now with a brief progress update, without a final answer; DSH will deliver the pending input and continue the turn.' })
        return { content, isError: result.isError }
      })()
      calls.add(call)
      try { return await call } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'ACP_TEAM_TOOL_FAILED' }] }
      } finally { calls.delete(call) }
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    response.on('close', () => { sessions.delete(server); void server.close().catch(() => undefined) })
    // SDK transport declarations do not use exactOptionalPropertyTypes; this is its standard Node transport.
    void server.connect(transport as Parameters<Server['connect']>[0]).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500).end()
      else response.end()
    })
  })
  let port = 0
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      const address = http.address()
      if (address === null || typeof address === 'string') return reject(new Error('ACP_TEAM_LISTEN_FAILED'))
      port = address.port
      resolve()
    })
  })
  const url = `http://127.0.0.1:${port}${path}`
  const servers: acp.McpServer[] = capabilities?.mcpCapabilities?.http === true
    ? [{ type: 'http', name: serverName, url, headers: [] }]
    : [{ name: serverName, command: process.execPath,
        args: [fileURLToPath(new URL('../../runtime/session/team-mcp-stdio.js', import.meta.url))],
        env: [{ name: 'DSH_ACP_TEAM_MCP_URL', value: url }] }]
  let closing: Promise<void> | undefined
  const listeners: Array<() => unknown> = []
  const lease: AcpMcpLease = {
    signal: lifetime.signal,
    instructions: `Current DSH Teams connection: MCP server ${serverName}. Discover its tools and use their exact names. This replaces earlier Teams connection names. Each teammate has its own server and tool names; do not instruct a teammate to use your connection names. Create teams only when explicitly requested. Pending DSH messages are delivered after you end the current response; give a brief progress update when asked to yield.`,
    servers,
    beginPrompt(signal) { prompt = signal; presented.clear() },
    endPrompt() { prompt = undefined; presented.clear() },
    presentTool(call) {
      const name = definitionOf(call)?.name ?? presented.get(call.toolCallId)
      if (name === undefined) return call
      presented.set(call.toolCallId, name)
      // Same tool title as the native host. Transport capability names stay out of the conversation row.
      return { ...call, title: name }
    },
    permission(request) {
      if (!live() || prompt === undefined || prompt.aborted) return undefined
      if (definitionOf(request.toolCall) === undefined) return undefined
      const allow = request.options.find(option => option.kind === 'allow_once')
      return allow === undefined ? undefined : { outcome: { outcome: 'selected', optionId: allow.optionId } }
    },
    elicitation(request, toolCall) {
      const form = request as { toolCallId?: unknown; requestedSchema?: { properties?: Record<string, unknown>; required?: unknown[] } }
      if (wireProfile !== 'codex' || !live() || prompt === undefined || prompt.aborted
        || request.mode !== 'form' || request._meta?.codex_approval_kind !== 'mcp_tool_call'
        || form.toolCallId === undefined || toolCall === undefined || toolCall.toolCallId !== form.toolCallId
        || toolCall._meta?.is_mcp_tool_call !== true) return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string' || !names.has(input.tool)) return undefined
      // Codex may add the persistence selector to an otherwise empty tool-approval form.
      // Never answer unrelated fields or grant persistent permission.
      const properties = form.requestedSchema?.properties
      const required = form.requestedSchema?.required
      if (properties === null || typeof properties !== 'object' || Array.isArray(properties)
        || Object.keys(properties).some(key => key !== 'persist')
        || (required !== undefined && (!Array.isArray(required) || required.some(key => key !== 'persist')))) return undefined
      if (properties.persist === undefined) return { action: 'accept', content: {} }
      const persist = properties.persist as { oneOf?: Array<{ const?: unknown }>; enum?: unknown[] }
      if (persist === null || typeof persist !== 'object'
        || !(Array.isArray(persist.oneOf) && persist.oneOf.some(option => option?.const === 'once'))
          && !(Array.isArray(persist.enum) && persist.enum.includes('once'))) return undefined
      return { action: 'accept', content: { persist: 'once' } }
    },
    close() {
      closing ??= (async () => {
        lifetime.abort(new Error('ACP Teams connection closed'))
        for (const dispose of listeners.splice(0)) dispose()
        prompt = undefined
        presented.clear()
        http.closeAllConnections()
        await new Promise<void>((resolve) => { http.close(() => resolve()) })
        await Promise.allSettled([...sessions].map(server => server.close()))
        await Promise.allSettled([...calls])
      })()
      return closing
    },
  }
  listeners.push(ctx.on('agent/disposed', ({ agent: disposed }) => { if (disposed === agent) void lease.close() }))
  listeners.push(ctx.on('internal/service', name => { if (name === 'agentTeams' && !live()) void lease.close() }))
  return lease
}
