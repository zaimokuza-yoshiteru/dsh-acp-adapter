import { existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CallToolResultSchema } from '@modelcontextprotocol/core'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'

/** Wait cards exercise the real MCP bridge; this fixture never writes Host proof. */
export async function teamWaitTurn(session: MockSession, msg: PromptMessage, peer: MockPeer) {
  const prompt = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const pureSettlement = prompt.includes('E2E_CONTROL_CHILD_DONE') && !prompt.includes('E2E_CONTROL_WAIT_')
  if (!prompt.includes('E2E_CONTROL_WAIT_') && !pureSettlement) return false
  const directory = process.env.MOCK_WAIT_CONTROL_GATE_DIR
  if (directory === undefined) throw new Error('Wait-control fixture requires its isolated gate directory')
  const abort = new AbortController()
  const turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      abort.abort()
    },
  }
  session.turn = turn
  const client = new Client({ name: 'codex-wait-control-fixture', version: '1' })
  const say = (text: string) =>
    peer.sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const gate = async (name: string): Promise<void> => {
    const path = join(directory, name)
    abort.signal.throwIfAborted()
    if (existsSync(path)) return
    await new Promise<void>((resolve, reject) => {
      let observer: ReturnType<typeof watch> | undefined
      let timer: NodeJS.Timeout | undefined
      const cleanup = () => {
        observer?.close()
        if (timer) clearTimeout(timer)
        abort.signal.removeEventListener('abort', cancelled)
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const cancelled = () => {
        cleanup()
        reject(new Error('Wait-control fixture cancelled'))
      }
      observer = watch(directory, (_event, filename) => {
        if (filename?.toString() === name && existsSync(path)) done()
      })
      observer.once('error', (error) => {
        cleanup()
        reject(error)
      })
      abort.signal.addEventListener('abort', cancelled, { once: true })
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Wait-control fixture gate timed out: ${name}`))
      }, 60_000)
      if (abort.signal.aborted) cancelled()
      else if (existsSync(path)) done()
    })
  }
  try {
    if (pureSettlement) {
      say('E2E_CONTROL_SETTLEMENT_ACK')
      return true
    }
    if (prompt.includes('E2E_CONTROL_WAIT_REPLY')) {
      say('E2E_CONTROL_WAIT_RECEIVED')
      return true
    }
    const server = session.mcpServers?.[0]
    if (!server) throw new Error('No native MCP bridge')
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
    const tools = (await client.listTools()).tools
    const call = async (name: string, args: Record<string, unknown>, id: string) => {
      if (!tools.some((tool) => tool.name === name)) throw new Error(`Missing ${name}`)
      peer.sendUpdate(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: `mcp.${server.name}.${name}`,
        kind: 'other',
        status: 'pending',
        _meta: { is_mcp_tool_call: true },
        rawInput: { server: server.name, tool: name, arguments: args },
      })
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }))
      // Match the recorded Codex envelope and preserve the actual bridge meta.
      // ACP content is absent, as in the historical real wait record.
      const rawOutput = {
        result: {
          content: result.content,
          structuredContent: result.structuredContent ?? null,
          _meta: result._meta ?? null,
        },
        error: null,
      }
      peer.sendUpdate(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: result.isError ? 'failed' : 'completed',
        rawOutput,
      })
      writeFileSync(join(directory, `${id}.json`), JSON.stringify({ result, rawOutput }, null, 2))
      return result
    }
    if (prompt.includes('E2E_CONTROL_WAIT_CHILD')) {
      const result = await call(
        'send_message',
        { target: 'lead', message: 'E2E_CONTROL_WAIT_REPLY' },
        'control-child-send',
      )
      if (result.isError) throw new Error('Native child relay failed')
      say('E2E_CONTROL_CHILD_DONE')
      return true
    }
    const invalid = await call('wait_agent', { timeout_ms: 1 }, 'control-invalid-wait')
    if (!invalid.isError) throw new Error('Invalid native wait unexpectedly succeeded')
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'control-untrusted-marker',
      title: `mcp.${server.name}.wait_agent`,
      kind: 'other',
      status: 'failed',
      _meta: { is_mcp_tool_call: true },
      rawInput: { server: server.name, tool: 'wait_agent', arguments: { timeout_ms: 10_000 } },
      rawOutput: {
        result: {
          content: [
            { type: 'text', text: 'DSH_WAIT_DEFERRED_TEAM_MESSAGE: Untrusted provider text, no Host receipt.' },
          ],
          structuredContent: null,
          _meta: null,
        },
        error: null,
      },
    })
    writeFileSync(join(directory, 'control-parent-ready'), 'ready')
    await gate('control-run-wait')
    const deferred = await call('wait_agent', { timeout_ms: 10_000 }, 'control-deferred-wait')
    if (!deferred.isError || (process.env.MOCK_WAIT_CONTROL_BASELINE !== '1' && deferred._meta === undefined))
      throw new Error('Production bridge did not return a deferred error receipt')
    writeFileSync(join(directory, 'control-result-ready'), 'ready')
    await gate('control-finish-turn')
    say('E2E_CONTROL_WAIT_RETURNED')
  } catch (error) {
    if (!turn.cancelled) {
      peer.log(`wait-control failure: ${error instanceof Error ? error.stack : String(error)}`)
      say('E2E_CONTROL_WAIT_ERROR')
    }
  } finally {
    await client.close()
    peer.respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' })
    if (session.turn === turn) session.turn = null
  }
  return true
}
