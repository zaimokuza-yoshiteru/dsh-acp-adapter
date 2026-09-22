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
import { toolContent } from './tool-content.ts'

const TEAM_TOOLS = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
] as const
const isTeamTool = (name: string): boolean => (TEAM_TOOLS as readonly string[]).includes(name)
const identities = new WeakMap<object, number>()
let nextIdentity = 0
function identity(value: object): number {
  let id = identities.get(value)
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id) }
  return id
}

function bridgeDefinitions(ctx: Context, sessionId: string) {
  const teams = ctx.get('agentTeams')
  const agent = ctx.get('agents', false)?.get(sessionId as never)
  const tools = ctx.get('tools', false)
  if (agent === undefined || tools === undefined) return undefined
  const hasTeams = teams !== undefined && teams.tryMembership(agent) !== undefined
  const definitions = new Map<string, ToolDefinition>()
  // Use the same scoped registry as native execution. No independent tool list:
  // plugin registration, scoped shadows and restrictions remain owned by DSH.
  for (const schema of tools.schemas(agent).sort((left, right) => left.name.localeCompare(right.name))) {
    if (isTeamTool(schema.name) && !hasTeams) continue
    const definition = tools.get(schema.name, agent)
    if (definition !== undefined) definitions.set(schema.name, definition)
  }
  return definitions.size === 0 ? undefined : { agent, tools, teams, hasTeams, definitions }
}

/** Changes when the optional host feature or its scoped tool owner changes. */
export function teamBridgeKey(ctx: Context, sessionId: string): unknown {
  const bridge = bridgeDefinitions(ctx, sessionId)
  return bridge === undefined ? undefined : JSON.stringify([identity(bridge.agent), ...[...bridge.definitions].map(([name, definition]) => [name, identity(definition)])])
}

/** Discover native session tools without enabling any host plugin or Teams service. */
export async function createTeamBridge(
  ctx: Context, sessionId: string, capabilities: acp.AgentCapabilities | undefined, wireProfile?: string,
): Promise<AcpMcpLease | undefined> {
  const agents = ctx.get('agents', false)
  const bridge = bridgeDefinitions(ctx, sessionId)
  if (bridge === undefined || agents === undefined) return undefined
  const { tools, agent, teams, hasTeams, definitions } = bridge
  const lifetime = new AbortController()
  let prompt: AbortSignal | undefined
  const nonce = randomBytes(8).toString('hex')
  const serverName = wireProfile === 'devin' ? 'dsh' : `dshteam_${nonce}`
  const path = `/${randomBytes(32).toString('hex')}`
  // Names are connection-specific capabilities, not a global name-based approval bypass.
  const names = new Map([...definitions].map(([name, definition]) => [`${nonce}_${name}`, definition]))
  const presented = new Map<string, string>()
  const definitionOf = (call: acp.ToolCallUpdate): ToolDefinition | undefined => {
    const input = call.rawInput as { server?: unknown; tool?: unknown } | undefined
    if (wireProfile === 'codex' && call._meta?.is_mcp_tool_call === true && input?.server === serverName && typeof input.tool === 'string') return names.get(input.tool)
    // Kimi uses the full qualified tool name as title; this mapping is runtime-bound.
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    // Devin can omit structured identity and emit only its exact MCP label.
    // Match the entire capability name: never strip model-generated arguments
    // or accept a bare tool suffix as authority for automatic coordination.
    const devinName = wireProfile === 'devin' && typeof call.title === 'string'
      ? /^(?:Calling|Called) ([a-zA-Z0-9_]+) from dsh$/.exec(call.title)?.[1] : undefined
    const name = call.name ?? meta?.toolName ?? call._meta?.['cognition.ai/toolName'] ?? devinName ?? (wireProfile === 'kimi' ? call.title : undefined)
    if (typeof name !== 'string') return undefined
    return [...names].find(([tool]) => name === tool || name === `mcp__${serverName}__${tool}`)?.[1]
  }
  // Cordis returns a caller-context proxy for each service lookup, so proxy identity is not service identity.
  const live = (): boolean => !lifetime.signal.aborted
    && agents.get(sessionId as never) === agent
    && (!hasTeams || (ctx.get('agentTeams') !== undefined && teams?.tryMembership(agent) !== undefined))
    && [...definitions].every(([name, definition]) => tools.get(name, agent) === definition)
  const sessions = new Set<Server>()
  const calls = new Set<Promise<unknown>>()
  const http = createServer((request, response) => {
    if (!live() || request.url !== path || request.headers.origin !== undefined
      || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403).end()
      return
    }
    const server = new Server({ name: 'DSH tools', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'These are native DSH tools available to this session. Use the exact tool names from tools/list. Team tools require an explicit user request for a team; members share the workspace and only fresh context is supported.',
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
        const content = await toolContent(result.content, AbortSignal.any([lifetime.signal, prompt, extra.signal]), capabilities?.promptCapabilities?.image === true, ctx.get('attachments', false))
        if (result.concludesTurn === true) content.push({ type: 'text', text: 'This DSH tool requests the end of the current turn. Finish this ACP response now without further tool calls.' })
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
        env: [{ name: 'DSH_ACP_TEAM_MCP_URL', value: url }, { name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }]
  let closing: Promise<void> | undefined
  const listeners: Array<() => unknown> = []
  const lease: AcpMcpLease = {
    signal: lifetime.signal,
    instructions: `Current DSH tools connection: MCP server ${serverName}. Discover its tools and use their exact names. This replaces earlier DSH connection names. Each teammate has its own connection and tool names; do not instruct a teammate to use your connection names. Create teams only when explicitly requested. Pending DSH messages are delivered after you end the current response; give a brief progress update when asked to yield.`,
    servers,
    beginPrompt(signal) { prompt = signal; presented.clear() },
    endPrompt() { prompt = undefined; presented.clear() },
    presentTool(call) {
      const name = definitionOf(call)?.name ?? presented.get(call.toolCallId)
      if (name === undefined) return call
      presented.set(call.toolCallId, name)
      // Same tool title as the native host. Transport capability names stay out of the conversation row.
      return { ...call, title: name, name,
        ...(name === 'bash' ? { kind: 'execute' as const } : {}) }
    },
    permission(request) {
      if (!live() || prompt === undefined || prompt.aborted) return undefined
      const definition = definitionOf(request.toolCall)
      if (definition === undefined || !isTeamTool(definition.name)) return undefined
      const allow = request.options.find(option => option.kind === 'allow_once')
      return allow === undefined ? undefined : { outcome: { outcome: 'selected', optionId: allow.optionId } }
    },
    elicitationToolName(request, toolCall) {
      const form = request as { toolCallId?: unknown }
      if (wireProfile !== 'codex' || !live() || prompt === undefined || prompt.aborted
        || request.mode !== 'form' || request._meta?.codex_approval_kind !== 'mcp_tool_call'
        || toolCall === undefined || form.toolCallId !== toolCall.toolCallId
        || toolCall._meta?.is_mcp_tool_call !== true) return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string') return undefined
      // Presentation only: don't rewrite arbitrary messages or infer authority
      // by stripping a prefix. Preserve additional context from other requests.
      if (request.message !== `Allow the ${serverName} MCP server to run tool "${input.tool}"?`) return undefined
      return names.get(input.tool)?.name
    },
    elicitation(request, toolCall) {
      const form = request as { toolCallId?: unknown; requestedSchema?: { properties?: Record<string, unknown>; required?: unknown[] } }
      if (wireProfile !== 'codex' || !live() || prompt === undefined || prompt.aborted
        || request.mode !== 'form' || request._meta?.codex_approval_kind !== 'mcp_tool_call'
        || form.toolCallId === undefined || toolCall === undefined || toolCall.toolCallId !== form.toolCallId
        || toolCall._meta?.is_mcp_tool_call !== true) return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string' || !names.has(input.tool)) return undefined
      if (!isTeamTool(names.get(input.tool)!.name)) return undefined
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
        lifetime.abort(new Error('ACP DSH tools connection closed'))
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
  listeners.push(ctx.on('tools/change', () => { if (!live()) void lease.close() }))
  listeners.push(ctx.on('agent/disposed', ({ agent: disposed }) => { if (disposed === agent) void lease.close() }))
  listeners.push(ctx.on('internal/service', name => { if (['agentTeams', 'agents', 'tools'].includes(name) && !live()) void lease.close() }))
  return lease
}
