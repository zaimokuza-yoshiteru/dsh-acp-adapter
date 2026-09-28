import type { MockSession, PromptMessage, MockPeer } from './types.ts'
import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type ToolResult = Awaited<ReturnType<Client['callTool']>>

function value(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(`DSH schedule tool failed: ${JSON.stringify(result)}`)
  if (!Array.isArray(result.content))
    throw new Error(`DSH schedule tool returned no content array: ${JSON.stringify(result)}`)
  const text = result.content.find(
    (block: unknown): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string',
  )
  if (text === undefined) throw new Error(`DSH schedule tool returned no JSON text: ${JSON.stringify(result)}`)
  return JSON.parse(text.text) as Record<string, unknown>
}

/** Exercise the Schedule tools through the ACP session's own DSH MCP server. */
export async function scheduleTurn(session: MockSession, msg: PromptMessage, peer: MockPeer): Promise<boolean> {
  const prompt = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const delivery = ['IDLE', 'ACTIVE'].find((kind) => prompt.includes(`E2E_SCHEDULE_DELIVERY_${kind}`))
  if (delivery) {
    const record = {
      kind: 'delivery-consumed',
      delivery,
      acpSessionId: session.id,
      prompt,
      receivedAt: new Date().toISOString(),
    }
    if (process.env.MOCK_SCHEDULE_RESULTS)
      appendFileSync(process.env.MOCK_SCHEDULE_RESULTS, `${JSON.stringify(record)}\n`)
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_SCHEDULE_DELIVERED_${delivery}` },
    })
    peer.respond(msg.id, { stopReason: 'end_turn' })
    return true
  }
  const scenario = ['E2E_SCHEDULE_CRUD', 'E2E_SCHEDULE_IDLE', 'E2E_SCHEDULE_ACTIVE', 'E2E_SCHEDULE_PERSIST'].find(
    (marker) => prompt.includes(marker),
  )
  if (!scenario) return false
  const server = session.mcpServers?.[0]
  if (!server) throw new Error('ACP session has no DSH MCP server')
  const client = new Client({ name: 'acp-schedule-fixture', version: '1' })
  try {
    await client.connect(
      server.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url))
        : new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map((item) => [item.name, item.value])),
            stderr: 'pipe',
          }),
    )
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    const required = ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']
    if (required.some((name) => !names.includes(name)))
      throw new Error(`ACP DSH tool bridge did not expose Schedule tools: ${JSON.stringify(names)}`)
    const records: unknown[] = []
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      const parsed = value(result)
      records.push({ name, result: parsed })
      peer.log(`schedule-tool=${JSON.stringify({ name, result: parsed })}`)
      return parsed
    }
    let message: string
    if (scenario === 'E2E_SCHEDULE_CRUD') {
      const created = await call('schedule_create', {
        title: 'ACP CRUD fixture',
        prompt: 'never deliver this fixture',
        after_seconds: 120,
      })
      const id = String(created.id)
      await call('schedule_list')
      const updated = await call('schedule_update', {
        id,
        title: 'ACP updated fixture',
        prompt: 'updated fixture prompt',
      })
      if (updated.id !== id || updated.title !== 'ACP updated fixture')
        throw new Error('schedule_update did not retain and update the created reminder')
      const listed = await call('schedule_list')
      if (
        !Array.isArray(listed) ||
        !(listed as Record<string, unknown>[]).some((row) => row.id === id && row.title === 'ACP updated fixture')
      ) {
        throw new Error('schedule_list did not return the updated reminder')
      }
      const deleted = await call('schedule_delete', { id })
      if (deleted.deleted !== true) throw new Error('schedule_delete did not delete the reminder')
      message = 'E2E_SCHEDULE_CRUD_DONE'
    } else if (scenario === 'E2E_SCHEDULE_PERSIST') {
      await call('schedule_create', {
        title: 'ACP remount recovery',
        prompt: 'E2E_SCHEDULE_DELIVERY_ACTIVE',
        after_seconds: 15,
      })
      message = 'E2E_SCHEDULE_PERSIST_CREATED'
    } else {
      await call('schedule_create', {
        title: `ACP ${scenario === 'E2E_SCHEDULE_IDLE' ? 'idle' : 'active'} delivery`,
        prompt: `E2E_SCHEDULE_DELIVERY_${scenario === 'E2E_SCHEDULE_IDLE' ? 'IDLE' : 'ACTIVE'}`,
        after_seconds: 2,
      })
      // The active-turn case lets the host timer become due before ACP returns.
      if (scenario === 'E2E_SCHEDULE_ACTIVE') {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        if (process.env.MOCK_SCHEDULE_ACTIVE_DUE_FILE)
          appendFileSync(process.env.MOCK_SCHEDULE_ACTIVE_DUE_FILE, `${Date.now()}\n`)
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      message = `${scenario}_CREATED`.replace('E2E_E2E_', 'E2E_')
    }
    if (process.env.MOCK_SCHEDULE_RESULTS)
      appendFileSync(
        process.env.MOCK_SCHEDULE_RESULTS,
        `${JSON.stringify({ scenario, acpSessionId: session.id, names, records })}\n`,
      )
    peer.sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } })
    peer.respond(msg.id, { stopReason: 'end_turn' })
    return true
  } finally {
    await client.close()
  }
}
