import { randomBytes, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-tools'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'
import { ACP_PERMISSION_ID_MAX_BYTES, ACP_PERMISSION_OPTIONS_MAX } from '../../domain/policy/permissions.ts'
import { toolContent } from './tool-content.ts'

const TEAM_TOOLS = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const
function bridgeInstructions(names: ReadonlyMap<string, ToolDefinition>, hasTeams: boolean): string {
  const skillRoute = names.has('skill')
    ? 'The DSH MCP tool "skill" is listed; access DSH skill-catalog entries through that tool using its exact tools/list schema and names.'
    : names.has(RUN_CODE_NAME)
      ? `No direct DSH skill tool is listed. If DSH skill access is exposed through the generated SDK, call it inside "${RUN_CODE_NAME}" using the host-provided SDK instructions and listed schema; do not invent a direct skill tool.`
      : 'No DSH skill-loading entry point is listed. Do not claim DSH skill-catalog entries are available through an Agent-native skill tool; explain that this DSH connection has no listed skill entry point.'
  return `These are native DSH tools available to this session. Use the exact tool names and schemas from tools/list. Tools and skills discovered in DSH context, including skill-catalog entries, must use this session's DSH MCP tools; do not route them through the Agent's native skill invocation or private skill directory, and do not copy DSH skill files into that directory. This does not replace or modify the Agent's own skills. Do not assume or expose tools or permissions absent from this DSH connection. ${skillRoute}${hasTeams ? ' Team tools require an explicit user request for a team; members share the workspace and only fresh context is supported.' : ''}`
}
const isTeamTool = (name: string): boolean => (TEAM_TOOLS as readonly string[]).includes(name)
const identities = new WeakMap<object, number>()
let nextIdentity = 0
function identity(value: object): number {
  let id = identities.get(value)
  if (id === undefined) {
    id = ++nextIdentity
    identities.set(value, id)
  }
  return id
}

function schemaValueKey(schemas: readonly ToolSchema[]): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
  return JSON.stringify(
    [...schemas].sort((left, right) => left.name.localeCompare(right.name)).map((schema) => stable(schema)),
  )
}

function bridgeDefinitions(ctx: Context, sessionId: string, schemas: readonly ToolSchema[] | undefined) {
  if (schemas === undefined) return undefined
  const teams = ctx.get('agentTeams')
  const agent = ctx.get('agents', false)?.get(sessionId as never)
  const tools = ctx.get('tools', false)
  if (agent === undefined || tools === undefined) return undefined
  const hasTeams = teams !== undefined && teams.tryMembership(agent) !== undefined
  const visible = new Map<string, ToolSchema>()
  const duplicates = new Set<string>()
  for (const schema of schemas) {
    if (visible.has(schema.name)) duplicates.add(schema.name)
    else visible.set(schema.name, schema)
  }
  const definitions = new Map<string, ToolDefinition>()
  // Use the same scoped registry as native execution. No independent tool list:
  // plugin registration, scoped shadows and restrictions remain owned by DSH.
  for (const schema of tools.schemas(agent).sort((left, right) => left.name.localeCompare(right.name))) {
    const visibleSchema = visible.get(schema.name)
    if (visibleSchema === undefined || duplicates.has(schema.name)) continue
    if (isTeamTool(schema.name) && !hasTeams) continue
    const definition = tools.get(schema.name, agent)
    if (definition !== undefined) definitions.set(schema.name, definition)
  }
  const currentSchemaKey = schemaValueKey([...definitions.keys()].map((name) => visible.get(name)!))
  return definitions.size === 0 ? undefined : { agent, tools, teams, hasTeams, definitions, visible, currentSchemaKey }
}

/** Changes when the optional host feature or its scoped tool owner changes. */
export function teamBridgeKey(ctx: Context, sessionId: string, schemas?: readonly ToolSchema[]): unknown {
  const bridge = bridgeDefinitions(ctx, sessionId, schemas)
  return bridge === undefined
    ? undefined
    : JSON.stringify([
        identity(bridge.agent),
        bridge.currentSchemaKey,
        ...[...bridge.definitions].map(([name, definition]) => [name, identity(definition)]),
      ])
}

/** Discover native session tools without enabling any host plugin or Teams service. */
export async function createTeamBridge(
  ctx: Context,
  sessionId: string,
  capabilities: acp.AgentCapabilities | undefined,
  wireProfile?: string,
  resolveApprovalPolicy?: () => Promise<'auto' | 'ask'>,
  onPolicyContextChange?: () => void,
  schemas?: readonly ToolSchema[],
): Promise<AcpMcpLease | undefined> {
  const agents = ctx.get('agents', false)
  const bridge = bridgeDefinitions(ctx, sessionId, schemas)
  if (bridge === undefined || agents === undefined) return undefined
  const { tools, agent, teams, hasTeams, definitions, visible } = bridge
  const initialMembership = hasTeams ? teams?.tryMembership(agent) : undefined
  const lifetime = new AbortController()
  let prompt: AbortSignal | undefined
  let promptGeneration = 0
  let onTeamReport: (() => void) | undefined
  const nonce = randomBytes(8).toString('hex')
  const serverName = wireProfile === 'devin' ? 'dsh' : `dshteam_${nonce}`
  const path = `/${randomBytes(32).toString('hex')}`
  // The connection owns caller identity. Keep native tool names intact so
  // upstream prompts, descriptions and plugin instructions share one contract.
  const names = definitions
  const scopedInstructions = bridgeInstructions(names, hasTeams)
  const presented = new Map<string, string>()
  const permissionFences = new WeakMap<object, { generation: number; prompt: AbortSignal }>()
  const identityOf = (call: acp.ToolCallUpdate): { tool?: string; source?: AcpPermissionCheck['identitySource'] } => {
    const qualified = (value: unknown): string | undefined =>
      typeof value === 'string' && value.startsWith(`mcp__${serverName}__`)
        ? value.slice(`mcp__${serverName}__`.length)
        : undefined
    const input = call.rawInput as { server?: unknown; tool?: unknown } | undefined
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const candidates: Array<{ tool: string | undefined; source: AcpPermissionCheck['identitySource'] }> = []
    if (wireProfile === 'codex' && call._meta?.is_mcp_tool_call === true)
      candidates.push({
        tool: input?.server === serverName && typeof input.tool === 'string' ? input.tool : undefined,
        source: 'codex-input',
      })
    if (meta?.toolName != null) candidates.push({ tool: qualified(meta.toolName), source: 'claude-meta' })
    if (call._meta?.['cognition.ai/toolName'] != null)
      candidates.push({ tool: qualified(call._meta['cognition.ai/toolName']), source: 'devin-meta' })
    if (typeof call.name === 'string' && call.name.startsWith('mcp__'))
      candidates.push({ tool: qualified(call.name), source: 'name' })
    // Only runtime-specific, complete labels identify a server. A bare native
    // name alone never grants approval; Devin may also repeat the exact native
    // name alongside its complete server label, which must agree byte-for-byte.
    if (candidates.length === 0 && (call.name == null || wireProfile === 'devin')) {
      if (wireProfile === 'devin' && typeof call.title === 'string') {
        const match = /^(?:Calling|Called) (.+) from dsh$/.exec(call.title)
        if (match?.[0] === call.title && (call.name == null || call.name === match[1])) {
          candidates.push({ tool: match[1], source: 'devin-title' })
        }
      } else if (wireProfile === 'kimi') candidates.push({ tool: qualified(call.title), source: 'kimi-title' })
    }
    const first = candidates[0]
    if (first === undefined) return call.name == null ? {} : { source: 'name' }
    if (
      first.tool === undefined ||
      candidates.some((candidate) => candidate.tool !== first.tool) ||
      (call.name != null && call.name !== first.tool && qualified(call.name) !== first.tool)
    )
      return { source: first.source }
    return { tool: first.tool, source: first.source }
  }
  const definitionOf = (call: acp.ToolCallUpdate): ToolDefinition | undefined => {
    const tool = identityOf(call).tool
    return tool === undefined ? undefined : names.get(tool)
  }
  // Freeze a durable session default before the first prompt. Failure stays
  // fail-closed in each permission resolver below.
  if (resolveApprovalPolicy !== undefined) await resolveApprovalPolicy().catch(() => undefined)
  // Cordis returns a caller-context proxy for each service lookup, so proxy identity is not service identity.
  const live = (): boolean =>
    !lifetime.signal.aborted &&
    agents.get(sessionId as never) === agent &&
    (!hasTeams ||
      (() => {
        const current = ctx.get('agentTeams') === undefined ? undefined : teams?.tryMembership(agent)
        if (
          current === undefined ||
          initialMembership === undefined ||
          current.id !== initialMembership.id ||
          current.root !== initialMembership.root ||
          current.role !== initialMembership.role
        )
          return false
        const root = initialMembership.root
        const lead = teams?.tryMembership(root)
        return (
          agents.get(root.id as never) === root &&
          lead?.role === 'lead' &&
          lead.root === root &&
          lead.id === initialMembership.id
        )
      })()) &&
    [...definitions].every(([name, definition]) => tools.get(name, agent) === definition)
  const inspectPermission: NonNullable<AcpMcpLease['inspectPermission']> = async (request) => {
    const capturedPrompt = prompt
    const capturedGeneration = promptGeneration
    const call = request.toolCall
    const identity = identityOf(call)
    const meta = call._meta?.claudeCode as { toolName?: unknown } | undefined
    const source = identity.source
    const titleName =
      wireProfile === 'devin' && typeof call.title === 'string'
        ? /^(?:Calling|Called) ([a-zA-Z0-9_]+) from dsh$/.exec(call.title)?.[1]
        : undefined
    const facts: Omit<AcpPermissionCheck, 'reason'> = {
      ...(source === undefined ? {} : { identitySource: source }),
      structuredIdentityPresent:
        call.name != null ||
        meta?.toolName != null ||
        call._meta?.['cognition.ai/toolName'] != null ||
        source === 'codex-input',
      titleMatchesCurrentTool: titleName !== undefined && names.has(titleName),
    }
    if (!live()) return { ...facts, reason: 'inactive-connection' }
    if (capturedPrompt === undefined || capturedPrompt.aborted) return { ...facts, reason: 'inactive-prompt' }
    const definition = definitionOf(call)
    if (definition === undefined) {
      // An identified call to our own server with an unknown name cannot
      // execute, even after approval. Do not ask a user to repair a protocol
      // error, and never strip markup or guess arguments to make it runnable.
      if (identity.tool !== undefined) {
        const reject = request.options.find((option) => option.kind === 'reject_once')
        return {
          ...facts,
          reason: 'invalid-tool-name',
          response: {
            outcome:
              reject === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reject.optionId },
          },
        }
      }
      return { ...facts, reason: 'identity-unmatched' }
    }
    const identified = { ...facts, toolName: definition.name }
    const policy = resolveApprovalPolicy === undefined ? 'ask' : await resolveApprovalPolicy().catch(() => undefined)
    if (prompt !== capturedPrompt || promptGeneration !== capturedGeneration || capturedPrompt.aborted || !live())
      return { ...identified, reason: 'inactive-prompt' }
    // Policy reads fail closed. A cancelled response prevents the Agent from
    // treating an unavailable host policy as permission to proceed.
    if (policy === undefined) {
      return { ...identified, reason: 'policy-unavailable', response: { outcome: { outcome: 'cancelled' } } }
    }
    if (policy !== 'auto') return { ...identified, reason: 'approval-required' }
    if (!live() || prompt !== capturedPrompt || promptGeneration !== capturedGeneration || capturedPrompt.aborted)
      return { ...identified, reason: 'inactive-prompt' }
    const allows = request.options.filter((option) => option.kind === 'allow_once')
    const ids = request.options.map((option) => option.optionId)
    const boundedOptions =
      request.options.length <= ACP_PERMISSION_OPTIONS_MAX &&
      Buffer.byteLength(request.toolCall.toolCallId, 'utf8') <= ACP_PERMISSION_ID_MAX_BYTES &&
      ids.every(
        (id) => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id, 'utf8') <= ACP_PERMISSION_ID_MAX_BYTES,
      )
    const allow = boundedOptions && allows.length === 1 && new Set(ids).size === ids.length ? allows[0] : undefined
    return allow === undefined
      ? { ...identified, reason: 'allow-once-unavailable' }
      : (permissionFences.set(request, { generation: capturedGeneration, prompt: capturedPrompt }),
        {
          ...identified,
          reason: 'auto-approved',
          response: { outcome: { outcome: 'selected', optionId: allow.optionId } },
        })
  }
  const sessions = new Set<Server>()
  const calls = new Set<Promise<unknown>>()
  const http = createServer((request, response) => {
    if (
      !live() ||
      request.url !== path ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${port}`
    ) {
      response.writeHead(403).end()
      return
    }
    const server = new Server(
      { name: 'DSH tools', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions: scopedInstructions,
      },
    )
    sessions.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...names]
        .filter(([, definition]) => tools.get(definition.name, agent) === definition)
        .map(([name, definition]) => ({
          name,
          description: visible.get(name)!.description,
          inputSchema: {
            ...visible.get(name)!.parameters,
            type: 'object' as const,
            ...(definition.name !== 'spawn_teammate'
              ? {}
              : {
                  additionalProperties: false,
                  properties: {
                    ...(definition.parameters.properties as Record<string, unknown>),
                    context: {
                      type: 'string',
                      enum: ['fresh'],
                      description: 'Fresh ACP session; history fork is unsupported.',
                    },
                  },
                }),
          },
        })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const call = (async () => {
        const definition = names.get(request.params.name)
        if (!live() || prompt === undefined || prompt.aborted) throw new Error('ACP_TEAM_PROMPT_INACTIVE')
        if (definition === undefined || tools.get(definition.name, agent) !== definition)
          throw new Error('ACP_TEAM_TOOL_UNAVAILABLE')
        const args = request.params.arguments ?? {}
        if (
          definition.name === 'spawn_teammate' &&
          Object.keys(args).some((key) => !['name', 'description', 'prompt', 'context'].includes(key))
        )
          throw new Error('ACP_TEAM_ROUTE_OVERRIDE_UNSUPPORTED: teammates inherit the lead Agent and model')
        if (definition.name === 'spawn_teammate' && args.context !== undefined && args.context !== 'fresh')
          throw new Error('ACP_TEAM_FORK_UNSUPPORTED: use fresh context')
        const membership = definition.name === 'send_message' ? teams?.tryMembership(agent) : undefined
        const membershipRole = membership?.role
        const membershipId = membership?.id
        const membershipRoot = membership?.root
        const executedPrompt = prompt
        const executedGeneration = promptGeneration
        const result = await tools.execute({
          callId: `acp-team-${randomUUID()}` as never,
          name: definition.name,
          arguments: args,
          agent,
          signal: AbortSignal.any([lifetime.signal, executedPrompt, extra.signal]),
        })
        onPolicyContextChange?.()
        for (const context of result.additionalContexts ?? []) agent.steer(context)
        const content = await toolContent(
          result.content,
          AbortSignal.any([lifetime.signal, executedPrompt, extra.signal]),
          capabilities?.promptCapabilities?.image === true,
          ctx.get('attachments', false),
        )
        const currentMembership = teams?.tryMembership(agent)
        if (
          definition.name === 'send_message' &&
          args.target === 'lead' &&
          typeof args.message === 'string' &&
          args.message.trim().length > 0 &&
          result.isError !== true &&
          membershipRole === 'teammate' &&
          currentMembership?.role === 'teammate' &&
          currentMembership.id === membershipId &&
          currentMembership.root === membershipRoot &&
          executedPrompt !== undefined &&
          !executedPrompt.aborted &&
          !extra.signal.aborted &&
          prompt === executedPrompt &&
          promptGeneration === executedGeneration &&
          live()
        ) {
          onTeamReport?.()
        }
        if (result.concludesTurn === true)
          content.push({
            type: 'text',
            text: 'This DSH tool requests the end of the current turn. Finish this ACP response now without further tool calls.',
          })
        // Do not steal or duplicate inbox messages. Only the native loop claims them.
        if (agent.inbox.nextStep.length > 0)
          content.push({
            type: 'text',
            text: 'DSH has queued input for your next step. End this ACP response now with a brief progress update, without a final answer; DSH will deliver the pending input and continue the turn.',
          })
        return { content, isError: result.isError }
      })()
      calls.add(call)
      try {
        return await call
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'ACP_TEAM_TOOL_FAILED' }],
        }
      } finally {
        calls.delete(call)
      }
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    response.on('close', () => {
      sessions.delete(server)
      void server.close().catch(() => undefined)
    })
    // SDK transport declarations do not use exactOptionalPropertyTypes; this is its standard Node transport.
    void server
      .connect(transport as Parameters<Server['connect']>[0])
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
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
  const servers: acp.McpServer[] =
    capabilities?.mcpCapabilities?.http === true
      ? [{ type: 'http', name: serverName, url, headers: [] }]
      : [
          {
            name: serverName,
            command: process.execPath,
            args: [fileURLToPath(new URL('../../runtime/session/team-mcp-stdio.js', import.meta.url))],
            env: [
              { name: 'DSH_ACP_TEAM_MCP_URL', value: url },
              { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            ],
          },
        ]
  let closing: Promise<void> | undefined
  const listeners: Array<() => unknown> = []
  const lease: AcpMcpLease = {
    signal: lifetime.signal,
    instructions: `Current DSH tools connection: MCP server ${serverName}. ${scopedInstructions} Each session has its own connection and caller identity. Do not copy a connection address or server identity to another session.${hasTeams ? ' Team target names resolve within the caller’s Team. Create teams only when explicitly requested.' : ''} Pending DSH messages are delivered after you end the current response; give a brief progress update when asked to yield.`,
    servers,
    beginPrompt(signal, reportCallback) {
      prompt = signal
      onTeamReport = reportCallback
      promptGeneration++
      presented.clear()
    },
    endPrompt() {
      prompt = undefined
      onTeamReport = undefined
      promptGeneration++
      presented.clear()
    },
    presentTool(call) {
      const name = definitionOf(call)?.name ?? presented.get(call.toolCallId)
      if (name === undefined) return call
      presented.set(call.toolCallId, name)
      // Same tool title as the native host. Transport capability names stay out of the conversation row.
      return { ...call, title: name, name, ...(name === 'bash' ? { kind: 'execute' as const } : {}) }
    },
    inspectPermission,
    validatePermissionDecision(request) {
      const fence = permissionFences.get(request)
      if (
        fence === undefined ||
        !live() ||
        prompt !== fence.prompt ||
        promptGeneration !== fence.generation ||
        fence.prompt.aborted
      )
        return false
      const definition = definitionOf(request.toolCall)
      return (
        definition !== undefined &&
        names.get(definition.name) === definition &&
        tools.get(definition.name, agent) === definition
      )
    },
    async permission(request) {
      return (await inspectPermission(request)).response
    },
    elicitationToolName(request, toolCall) {
      const form = request as { toolCallId?: unknown }
      if (
        wireProfile !== 'codex' ||
        !live() ||
        prompt === undefined ||
        prompt.aborted ||
        request.mode !== 'form' ||
        request._meta?.codex_approval_kind !== 'mcp_tool_call' ||
        toolCall === undefined ||
        form.toolCallId !== toolCall.toolCallId ||
        toolCall._meta?.is_mcp_tool_call !== true
      )
        return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string') return undefined
      // Presentation only: don't rewrite arbitrary messages or infer authority
      // by stripping a prefix. Preserve additional context from other requests.
      if (request.message !== `Allow the ${serverName} MCP server to run tool "${input.tool}"?`) return undefined
      return names.get(input.tool)?.name
    },
    async elicitation(request, toolCall) {
      const form = request as {
        toolCallId?: unknown
        requestedSchema?: { properties?: Record<string, unknown>; required?: unknown[] }
      }
      if (
        wireProfile !== 'codex' ||
        !live() ||
        prompt === undefined ||
        prompt.aborted ||
        request.mode !== 'form' ||
        request._meta?.codex_approval_kind !== 'mcp_tool_call' ||
        form.toolCallId === undefined ||
        toolCall === undefined ||
        toolCall.toolCallId !== form.toolCallId ||
        toolCall._meta?.is_mcp_tool_call !== true
      )
        return undefined
      const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | undefined
      if (input?.server !== serverName || typeof input.tool !== 'string' || !names.has(input.tool)) return undefined
      const capturedPrompt = prompt
      const capturedGeneration = promptGeneration
      const policy = resolveApprovalPolicy === undefined ? 'ask' : await resolveApprovalPolicy().catch(() => undefined)
      if (
        policy !== 'auto' ||
        capturedPrompt === undefined ||
        capturedPrompt.aborted ||
        prompt !== capturedPrompt ||
        promptGeneration !== capturedGeneration ||
        !live()
      )
        return undefined
      // Codex may add the persistence selector to an otherwise empty tool-approval form.
      // Never answer unrelated fields or grant persistent permission.
      const properties = form.requestedSchema?.properties
      const required = form.requestedSchema?.required
      if (
        properties === null ||
        typeof properties !== 'object' ||
        Array.isArray(properties) ||
        Object.keys(properties).some((key) => key !== 'persist') ||
        (required !== undefined && (!Array.isArray(required) || required.some((key) => key !== 'persist')))
      )
        return undefined
      if (properties.persist === undefined) return { action: 'accept', content: {} }
      const persist = properties.persist as { oneOf?: Array<{ const?: unknown }>; enum?: unknown[] }
      if (
        persist === null ||
        typeof persist !== 'object' ||
        (!(Array.isArray(persist.oneOf) && persist.oneOf.some((option) => option?.const === 'once')) &&
          !(Array.isArray(persist.enum) && persist.enum.includes('once')))
      )
        return undefined
      return { action: 'accept', content: { persist: 'once' } }
    },
    close() {
      closing ??= (async () => {
        lifetime.abort(new Error('ACP DSH tools connection closed'))
        for (const dispose of listeners.splice(0)) dispose()
        prompt = undefined
        presented.clear()
        http.closeAllConnections()
        await new Promise<void>((resolve) => {
          http.close(() => resolve())
        })
        await Promise.allSettled([...sessions].map((server) => server.close()))
        await Promise.allSettled([...calls])
      })()
      return closing
    },
  }
  listeners.push(
    ctx.on('tools/change', () => {
      if (!live()) void lease.close()
    }),
  )
  listeners.push(
    ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === agent) void lease.close()
    }),
  )
  listeners.push(
    ctx.on('internal/service', (name) => {
      if (['agentTeams', 'agents', 'tools'].includes(name) && !live()) void lease.close()
    }),
  )
  return lease
}
