import type { MockSession, PromptMessage, MockPeer } from './types.ts'
import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

type ToolResult = Awaited<ReturnType<Client['callTool']>>

/** RC.1 model tools take an explicit one-occurrence RRULE and destination. */
function onceAfter(seconds: number): string {
  const at = new Date(Math.ceil((Date.now() + seconds * 1_000) / 1_000) * 1_000)
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, '')
  return `DTSTART:${at}\nRRULE:FREQ=DAILY;COUNT=1`
}

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
    const required = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
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
        rrule: onceAfter(120),
        target: 'this_session',
      })
      const id = String(created.id)
      await call('schedule_list')
      const viewed = await call('schedule_view', { id })
      if (viewed.id !== id || viewed.title !== 'ACP CRUD fixture')
        throw new Error('schedule_view did not return the created reminder')
      const updated = await call('schedule_edit', {
        id,
        action: 'update',
        title: 'ACP updated fixture',
        prompt: 'updated fixture prompt',
      })
      if (updated.id !== id || updated.title !== 'ACP updated fixture')
        throw new Error('schedule_edit did not retain and update the created reminder')
      const listed = await call('schedule_list')
      if (
        !Array.isArray(listed.items) ||
        listed.shown !== listed.items.length ||
        typeof listed.total !== 'number' ||
        listed.total < listed.items.length ||
        !listed.items.some((row) => row.id === id && row.title === 'ACP updated fixture')
      ) {
        throw new Error('schedule_list did not return the updated reminder')
      }
      const deleted = await call('schedule_edit', { id, action: 'delete' })
      if (deleted.deleted !== true) throw new Error('schedule_edit did not delete the reminder')
      message = 'E2E_SCHEDULE_CRUD_DONE'
    } else if (scenario === 'E2E_SCHEDULE_PERSIST') {
      await call('schedule_create', {
        title: 'ACP remount recovery',
        prompt: 'E2E_SCHEDULE_DELIVERY_ACTIVE',
        rrule: onceAfter(15),
        target: 'this_session',
      })
      message = 'E2E_SCHEDULE_PERSIST_CREATED'
    } else {
      const created = await call('schedule_create', {
        title: `ACP ${scenario === 'E2E_SCHEDULE_IDLE' ? 'idle' : 'active'} delivery`,
        prompt: `E2E_SCHEDULE_DELIVERY_${scenario === 'E2E_SCHEDULE_IDLE' ? 'IDLE' : 'ACTIVE'}`,
        rrule: onceAfter(2),
        target: 'this_session',
      })
      // The active-turn case lets the host timer become due before ACP returns.
      if (scenario === 'E2E_SCHEDULE_ACTIVE') {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(String(created.scheduledAt)) - Date.now()) + 100),
        )
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
