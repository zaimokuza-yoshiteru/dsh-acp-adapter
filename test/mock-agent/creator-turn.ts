import { appendFileSync } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CallToolResultSchema } from '@modelcontextprotocol/core'
import type { MockSession, PromptMessage, MockPeer } from './types.ts'

export const CREATOR_PLAN = 'E2E_CREATOR_PLAN '
export const CREATOR_TOOL = 'e2e_creator_fixture'
export const CREATOR_BUNDLE = '@local/acp-creator-fixture'
export interface CreatorPlan {
  label: string
  fixtureAvailable: boolean
  calls: { name: string; arguments?: Record<string, unknown> }[]
}
export interface CreatorRecord {
  label: string
  sessionId: string
  kind: 'directory' | 'call' | 'complete' | 'failure'
  names?: string[]
  name?: string
  text?: string
}

/** Only the external Agent is scripted: discovery, skill loading and bundle changes execute on the real Host. */
export async function creatorTurn(session: MockSession, msg: PromptMessage, peer: MockPeer): Promise<boolean> {
  const line = msg.params.prompt
    .filter((block) => block.type === 'text')
    .flatMap((block) => block.text.split('\n'))
    .find((line) => line.startsWith(CREATOR_PLAN))
  if (line === undefined) return false
  const plan = JSON.parse(line.slice(CREATOR_PLAN.length)) as CreatorPlan
  const output = process.env.MOCK_CREATOR_RESULTS
  if (output === undefined) throw new Error('MOCK_CREATOR_RESULTS is required')
  const record = (entry: Omit<CreatorRecord, 'label' | 'sessionId'>) =>
    appendFileSync(output, `${JSON.stringify({ label: plan.label, sessionId: session.id, ...entry })}\n`)
  const client = new Client({ name: 'creator-flow-fixture', version: '1' })
  const controller = new AbortController()
  session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      controller.abort()
    },
  }
  try {
    const server = session.mcpServers?.[0]
    if (server === undefined) throw new Error('Creator session has no DSH tools bridge')
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
    const names = (await client.listTools()).tools.map(({ name }) => name)
    record({ kind: 'directory', names })
    for (const name of ['skill', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']) {
      if (!names.includes(name)) throw new Error(`Creator capability missing: ${name}`)
    }
    if (names.includes(CREATOR_TOOL) !== plan.fixtureAvailable)
      throw new Error(`Fixture catalog did not match enabled state: ${plan.fixtureAvailable}`)
    for (const [index, call] of plan.calls.entries()) {
      const toolCallId = `creator-${plan.label}-${index}`
      peer.sendUpdate(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: call.name,
        name: `mcp__${server.name}__${call.name}`,
        kind: 'other',
        status: 'in_progress',
        rawInput: call.arguments ?? {},
      })
      const result = CallToolResultSchema.parse(
        await client.callTool({ name: call.name, arguments: call.arguments ?? {} }, { signal: controller.signal }),
      )
      const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      record({ kind: 'call', name: call.name, text })
      if (result.isError) throw new Error(`${call.name}: ${text}`)
      if (call.name === 'plugin_manager' && JSON.parse(text).application !== 'applied')
        throw new Error(`Plugin change did not apply live: ${text}`)
      if (
        call.name === 'skill' &&
        (!text.includes('<skill_content name="dsh-doc">') || !text.includes('references/plugin-development.md'))
      )
        throw new Error('Official creator skill did not load through DSH')
      if (
        call.name === 'read' &&
        call.arguments?.file_path?.toString().endsWith('/references/plugin-development.md') &&
        !text.includes('Persistent Harness plugins')
      )
        throw new Error('Official plugin development reference did not load through DSH read')
      if (call.name === CREATOR_TOOL && !text.includes('E2E_CREATOR_CAPABILITY_OK'))
        throw new Error('Installed fixture did not execute')
      peer.sendUpdate(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput: result,
      })
    }
    record({ kind: 'complete' })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_CREATOR_DONE ${plan.label}` },
    })
  } catch (error) {
    record({ kind: 'failure', text: String(error) })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_CREATOR_FAILED ${plan.label}` },
    })
  } finally {
    session.turn = null
    await client.close()
    peer.respond(msg.id, { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' })
  }
  return true
}
