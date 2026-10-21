import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createDshToolBridge } from '../../../src/host/tools/bridge.ts'
import { apply as installControl } from '@deepseek-ai/dsh-tool-subagent-control'
import { apply as installList } from '@deepseek-ai/dsh-tool-subagent-control/list-agents'

describe('published native subagent tools survive the ACP bridge', () => {
  it.each(['Teams absent', 'Teams present with independent child'])('%s', async (scenario) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    installControl(ctx)
    installList(ctx)
    ctx.tools.register(
      defineTool({
        name: 'probe_read',
        description: 'Read marker.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] },
        execute: async () => 'ok',
      }),
    )
    const agent = {
      id: 'ordinary-child',
      inbox: { nextStep: [], nextTurn: [] },
      session: { header: { cwd: process.cwd() }, append() {} },
      steer() {},
      inject() {},
    }
    const assembly = await ctx.systemPrompt.assemble({ scope: agent as never })
    const nativeNames = assembly.tools.map((t) => t.name).sort()
    const expected = ['interrupt_agent', 'list_agents', 'probe_read', 'send_message']
    expect(nativeNames).toEqual(expected)
    const bridgeCtx = {
      on: (name: string, listener: (...args: never[]) => unknown) => ctx.on(name as never, listener as never),
      get: (name: string) =>
        name === 'agents'
          ? {
              get: (id: string) => (id === agent.id ? agent : undefined),
              withInitiator: (_: unknown, op: () => unknown) => op(),
            }
          : name === 'agentTeams'
            ? scenario.startsWith('Teams present')
              ? { tryMembership: () => undefined }
              : undefined
            : ctx.get(name as never),
    }
    let lease: Awaited<ReturnType<typeof createDshToolBridge>>
    let client: Client | undefined
    try {
      lease = await createDshToolBridge(
        bridgeCtx as never,
        agent.id,
        { mcpCapabilities: { http: true } },
        undefined,
        async () => 'auto',
        undefined,
        assembly.tools,
      )
      expect(lease).toBeDefined()
      const server = lease!.servers[0]!
      if (!('url' in server)) throw new Error('expected HTTP lease')
      client = new Client({ name: 'native-control-audit', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
      const acpNames = (await client.listTools()).tools.map((t) => t.name).sort()
      console.log(
        JSON.stringify({ scenario, nativeNames, acpNames, missing: nativeNames.filter((n) => !acpNames.includes(n)) }),
      )
      expect(acpNames).toEqual(expected)
    } finally {
      await client?.close()
      await lease?.close()
      await ctx.fiber.dispose()
    }
  })
})
