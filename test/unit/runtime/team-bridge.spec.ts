import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RequestPermissionRequest, CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTeamBridge } from '../../../src/host/teams/bridge.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).reverse().map(close => close())) })

async function setup(wireProfile?: string) {
  const agent = { id: 'lead', inbox: { nextStep: [] }, steer: vi.fn() }
  const definitions = new Map<string, unknown>()
  const execute = vi.fn(async (input) => ({ content: [{ type: 'text', text: input.name }], isError: false }))
  const services: Record<string, unknown> = {
    agentTeams: { tryMembership: () => ({ role: 'lead' }) },
    agents: { get: (id: string) => id === 'lead' ? agent : undefined },
    tools: { get: (name: string) => {
      if (!definitions.has(name)) definitions.set(name, { name, description: name, parameters: { type: 'object', properties: {} } })
      return definitions.get(name)
    }, execute },
  }
  const listeners = new Map<string, (...args: any[]) => void>()
  const ctx = { get: (name: string) => services[name], on: (name: string, listener: (...args: any[]) => void) => {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  } } as unknown as Context
  const lease = (await createTeamBridge(ctx, 'lead', { mcpCapabilities: { http: true } }, wireProfile))!
  cleanup.push(() => lease.close())
  const server = lease.servers[0]!
  if (!('url' in server)) throw new Error('Expected HTTP')
  const client = new Client({ name: 'fixture', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)) as Parameters<Client['connect']>[0])
  cleanup.push(() => client.close())
  const tools = (await client.listTools()).tools
  const name = tools.find(tool => tool.name.endsWith('_list_agents'))!.name
  const permission = (toolName?: string): RequestPermissionRequest => ({
    sessionId: 'acp', toolCall: { toolCallId: 'permission', ...(toolName === undefined ? {} : { name: toolName }) },
    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }],
  })
  return { ctx, services, execute, definitions, agent, lease, server, client, tools, name, permission, listeners }
}

describe('session-owned native Teams MCP bridge', () => {
  it('stays absent when Teams is disabled or the session is not a member', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(await createTeamBridge(ctx, 'lead', {})).toBeUndefined()
    const fixture = await setup()
    expect(await createTeamBridge(fixture.ctx, 'another', {})).toBeUndefined()
  })
  it('exports nine upstream schemas, dispatches exact identity, and rejects fork and non-Team tools', async () => {
    const { lease, client, tools, name, execute, agent } = await setup()
    expect(tools).toHaveLength(9)
    expect((await client.callTool({ name })).isError).toBe(true)
    lease.beginPrompt(new AbortController().signal)
    expect((await client.callTool({ name })).content).toEqual([{ type: 'text', text: 'list_agents' }])
    expect(execute.mock.calls[0]![0].agent).toBe(agent)
    expect((await client.callTool({ name: 'bash', arguments: { command: 'echo no' } })).isError).toBe(true)
    const spawn = tools.find(tool => tool.name.endsWith('_spawn_teammate'))!
    expect((await client.callTool({ name: spawn.name, arguments: { context: 'fork' } })).isError).toBe(true)
    for (const override of [{ model: 'other' }, { provider: 'acp-other' }, { agent: 'other' }, { reasoningEffort: 'high' }]) {
      expect((await client.callTool({ name: spawn.name, arguments: { context: 'fresh', ...override } })).isError).toBe(true)
    }
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('only suppresses approval for this live bridge identity; titles and old connections do not grant permission', async () => {
    const { lease, server, name, permission } = await setup()
    expect(lease.permission(permission(name))).toBeUndefined()
    lease.beginPrompt(new AbortController().signal)
    expect(lease.permission(permission(`mcp__${server.name}__${name}`))?.outcome).toEqual({ outcome: 'selected', optionId: 'yes' })
    expect(lease.permission({ ...permission(), toolCall: { toolCallId: 'devin', _meta: { 'cognition.ai/toolName': `mcp__${server.name}__${name}` } } })?.outcome).toEqual({ outcome: 'selected', optionId: 'yes' })
    expect(lease.permission(permission('list_agents'))).toBeUndefined()
    const raw = { toolCallId: 'display', name: `mcp__${server.name}__${name}`, title: name }
    expect(lease.presentTool!(raw).title).toBe('list_agents')
    expect(raw.title).toBe(name)
    expect(lease.presentTool!({ toolCallId: 'display', title: 'Updated transport label' }).title).toBe('list_agents')
    expect(lease.permission({ ...permission(), toolCall: { toolCallId: 'fake', title: name, rawInput: { command: name } } })).toBeUndefined()
    const other = await setup()
    expect(other.lease.permission(permission(name))).toBeUndefined()
    lease.endPrompt()
    expect(lease.permission(permission(name))).toBeUndefined()
  })
  it('rejects hostile origins and capabilities after feature removal or tool replacement', async () => {
    const { lease, server, definitions, name, client, services } = await setup()
    lease.beginPrompt(new AbortController().signal)
    expect((await fetch(server.url, { headers: { Origin: 'https://example.com' } })).status).toBe(403)
    definitions.set('list_agents', {})
    await expect(client.callTool({ name })).rejects.toThrow()
    delete services.agentTeams
    expect((await fetch(server.url)).status).toBe(403)
  })
  it('propagates prompt cancellation to native execution and revokes coordination permission', async () => {
    const { lease, execute, client, name, permission } = await setup()
    const abort = new AbortController()
    lease.beginPrompt(abort.signal)
    execute.mockImplementationOnce(async input => await new Promise(resolve => {
      input.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: false }), { once: true })
    }))
    const pending = client.callTool({ name })
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    abort.abort()
    expect((await pending).content).toEqual([{ type: 'text', text: 'cancelled' }])
    expect(lease.permission(permission(name))).toBeUndefined()
  })
  it('releases the capability immediately when its native member is disposed or Teams is disabled', async () => {
    const first = await setup()
    first.listeners.get('agent/disposed')!({ agent: first.agent })
    expect(first.lease.signal.aborted).toBe(true)
    await first.lease.close()
    await expect(fetch(first.server.url)).rejects.toThrow()
    const second = await setup()
    delete second.services.agentTeams
    second.listeners.get('internal/service')!('agentTeams')
    expect(second.lease.signal.aborted).toBe(true)
    expect(second.listeners.size).toBe(0)
  })
  it('recognizes Kimi’s exact qualified title only on its descriptor and current capability', async () => {
    const { lease, server, name, permission } = await setup('kimi')
    lease.beginPrompt(new AbortController().signal)
    expect(lease.permission({ ...permission(), toolCall: { toolCallId: 'kimi', title: `mcp__${server.name}__${name}` } })?.outcome).toEqual({ outcome: 'selected', optionId: 'yes' })
    expect(lease.permission({ ...permission(), toolCall: { toolCallId: 'kimi', title: 'spawn_teammate' } })).toBeUndefined()
  })
  it('answers only a correlated Codex MCP approval with once scope, never other forms or servers', async () => {
    const { lease, server, name } = await setup('codex')
    const request: CreateElicitationRequest = { sessionId: 'acp', toolCallId: 'call', mode: 'form', message: 'not used as authority', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } }, required: ['persist'] } }
    const toolCall = { toolCallId: 'call', _meta: { is_mcp_tool_call: true }, rawInput: { server: server.name, tool: name, arguments: {} } }
    expect(lease.elicitation!(request, toolCall)).toBeUndefined()
    lease.beginPrompt(new AbortController().signal)
    expect(lease.elicitation!(request, toolCall)).toEqual({ action: 'accept', content: { persist: 'once' } })
    expect(lease.elicitation!(request, undefined)).toBeUndefined()
    expect(lease.elicitation!({ ...request, _meta: {} }, toolCall)).toBeUndefined()
    expect(lease.elicitation!(request, { ...toolCall, rawInput: { server: 'other', tool: name } })).toBeUndefined()
    expect(lease.elicitation!({ ...request, requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } }, toolCall)).toBeUndefined()
    lease.endPrompt()
    expect(lease.elicitation!(request, toolCall)).toBeUndefined()
  })
})
