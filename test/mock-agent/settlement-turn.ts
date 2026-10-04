import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import fs from 'node:fs'
import { dirname, join } from 'node:path'

const scenarios = ['E2E_SETTLEMENT_NATURAL_ENDTURN_v1', 'E2E_SETTLEMENT_STOP_ENDTURN_v1'] as const

async function waitForFile(path: string, description: string): Promise<void> {
  if (fs.existsSync(path)) return
  await new Promise<void>((resolve, reject) => {
    let watcher: ReturnType<typeof fs.watch> | undefined
    const cleanup = (): void => {
      watcher?.close()
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${description}`))
    }, 30_000)
    watcher = fs.watch(dirname(path), () => {
      if (!fs.existsSync(path)) return
      cleanup()
      resolve()
    })
    watcher.once('error', (error) => {
      cleanup()
      reject(error)
    })
    if (fs.existsSync(path)) {
      cleanup()
      resolve()
    }
  })
}

/** Run one MCP Host tool past the natural ACP turn boundary, then deliver its real result. */
export async function settlementTurn(
  session: MockSession,
  msg: PromptMessage,
  { sendUpdate, sendAgentRequest, respond, log }: MockPeer,
): Promise<boolean> {
  const prompt = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const scenario = scenarios.find((candidate) => prompt.includes(candidate))
  if (scenario === undefined) return false
  if (process.env.MOCK_PROFILE !== 'devin') throw new Error('Settlement fixture requires the Devin protocol profile')
  log('settlement scenario started')
  const server = session.mcpServers?.[0]
  if (!server) throw new Error('No DSH tools bridge')
  const toolName = 'e2e_settlement_fixture'
  const startedFileName = '.e2e-settlement-host-tool-started'
  const cancelledFileName = '.e2e-settlement-host-tool-cancelled'
  const cleanupFileName = '.e2e-settlement-host-tool-cleaned'
  const startedFile = join(session.cwd, startedFileName)
  const cancelledFile = join(session.cwd, cancelledFileName)
  const cleanupFile = join(session.cwd, cleanupFileName)
  const toolCallId = 'settlement-host-tool'
  const client = new Client({ name: 'host-settlement-fixture', version: '1' })
  let closeAfterResult = false
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
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === toolName)
    if (!tool) throw new Error(`Native DSH MCP tool ${toolName} was not discovered`)
    const toolCall = {
      toolCallId,
      title: `Calling ${toolName} from ${server.name}`,
      kind: 'other',
      status: 'pending',
      rawInput: { startedFile, cancelledFile, cleanupFile },
    }
    sendUpdate(session.id, { sessionUpdate: 'tool_call', ...toolCall })
    const permission = await sendAgentRequest('session/request_permission', {
      sessionId: session.id,
      toolCall,
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    })
    if (permission.outcome?.optionId !== 'allow-once') throw new Error('Fixture permission rejected')

    // Start the real Host invocation. The Host body writes startedFile on entry;
    // only that filesystem fact allows this mock Agent to report end_turn.
    const toolResult = client.callTool({ name: toolName, arguments: { startedFile, cancelledFile, cleanupFile } })
    void toolResult.catch(() => undefined)
    await waitForFile(startedFile, 'the Host settlement tool body to start')
    sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${scenario}_MODEL_DONE` },
    })
    respond(msg.id, { stopReason: 'end_turn' })
    closeAfterResult = true

    const receivedToolResult = toolResult
      .then((result) => {
        log(`settlement tool result=${JSON.stringify(result)}`)
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: result.isError ? 'failed' : 'completed',
          rawOutput: result,
        })
      })
      .catch((error: unknown) => {
        log(`settlement tool failed=${error instanceof Error ? error.message : String(error)}`)
        sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
      })
    void Promise.all([receivedToolResult, waitForFile(cleanupFile, 'Host tool cleanup release')])
      .then(async () => {
        await client.close()
        log('settlement MCP client closed after tool result and Host cleanup')
      })
      .catch((error: unknown) => {
        log(`settlement Host cleanup or MCP close failed=${error instanceof Error ? error.message : String(error)}`)
        return client.close()
      })
    return true
  } finally {
    if (!closeAfterResult) {
      await client.close()
    }
  }
}
