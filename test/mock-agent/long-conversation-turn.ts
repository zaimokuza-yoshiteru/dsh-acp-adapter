import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CallToolResultSchema } from '@modelcontextprotocol/core'
import { longTurnSpec, LONG_FLOW_DELIVERY, LONG_FLOW_FILE, parseLongTurn } from './long-conversation-script.ts'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Long-flow release gate timed out: ${path}`)
    await pause(20)
  }
}

/** Deterministic Devin-wire turn used by the long native-renderer comparison. */
export async function longConversationTurn(
  session: MockSession,
  msg: PromptMessage,
  { sendUpdate, respond, log }: MockPeer,
): Promise<boolean> {
  const prompt = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const index = parseLongTurn(prompt)
  if (index === undefined) return false

  const turnCount = Number(/\btotal=(\d+)/.exec(prompt)?.[1] ?? 100)
  const historyResume = prompt.includes('resume=history-read')
  const spec = longTurnSpec(index, turnCount)
  const releaseDir = process.env.MOCK_LONG_FLOW_GATE_DIR
  const releaseFile =
    releaseDir === undefined ? undefined : `${releaseDir}/acp-devin-release-${historyResume ? 'history' : 'last'}`
  const finishReleaseFile =
    releaseDir === undefined || index !== turnCount || historyResume
      ? undefined
      : `${releaseDir}/acp-devin-release-finish`
  const say = (text: string, messageId = `long-flow-${index}`) =>
    sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      messageId,
    })
  const toolNames: Partial<Record<typeof spec.kind, string>> = {
    'fixture-tool': 'long_fixture',
    read: 'read',
    edit: 'edit',
    'run-code': 'run_code',
    present: 'present',
    'failed-read': 'read',
  }

  if (spec.kind === 'reasoning') {
    sendUpdate(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: {
        type: 'text',
        text: `${spec.marker}_THOUGHT Keep the earlier requirement and check the next condition.`,
      },
      messageId: `long-thought-${index}`,
    })
  }

  const toolName = toolNames[spec.kind]
  if (toolName !== undefined) {
    const toolCallId = `long-flow-tool-${index}`
    const file = spec.kind === 'present' ? LONG_FLOW_DELIVERY : LONG_FLOW_FILE
    const rawInput =
      spec.kind === 'read' || spec.kind === 'failed-read'
        ? { file_path: spec.kind === 'failed-read' ? 'long-flow-missing.txt' : file }
        : spec.kind === 'edit'
          ? { file_path: file, old_string: 'LONG_FLOW_SEED', new_string: `${spec.marker}_EDITED` }
          : spec.kind === 'present'
            ? { files: [{ path: file, description: 'Long conversation artifact' }] }
            : spec.kind === 'run-code'
              ? {
                  code: `await tools.read({"file_path": "${file}"})\nreturn await tools.edit({"file_path": "${file}", "old_string": "LONG_FLOW_007_EDITED", "new_string": "${spec.marker}_PTC_EDITED"})`,
                  description: 'Read the fixture and make the requested single edit',
                }
              : { marker: spec.marker }
    sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `${toolName} ${JSON.stringify(rawInput)}`,
      kind: spec.kind === 'read' || spec.kind === 'failed-read' ? 'read' : spec.kind === 'edit' ? 'edit' : 'other',
      status: 'in_progress',
      rawInput,
    })
    const server = session.mcpServers?.[0]
    if (!server) throw new Error('Long conversation fixture has no native DSH tool bridge')
    const client = new Client({ name: 'long-conversation-fixture', version: '1' })
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
      const tools = (await client.listTools()).tools
      const tool = tools.find((item) => item.name === toolName)
      if (!tool) throw new Error(`Native DSH tool ${toolName} is not available in this session`)
      const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: rawInput }))
      sendUpdate(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: result.isError ? 'failed' : 'completed',
        rawOutput: result,
        content: result.content.map((content) => ({ type: 'content', content })),
      })
      log(
        `long-flow tool=${toolName} turn=${index} error=${String(result.isError)} output=${JSON.stringify(result.content)}`,
      )
      if (spec.kind === 'failed-read' && result.isError !== true)
        throw new Error('Missing-file read unexpectedly succeeded')
      if (spec.kind !== 'failed-read' && result.isError)
        throw new Error(`${toolName} failed: ${JSON.stringify(result.content)}`)
    } finally {
      await client.close()
    }
  }

  for (const [deltaIndex, delta] of spec.deltas.entries()) {
    say(delta)
    if ((index === turnCount || historyResume) && deltaIndex === 0 && releaseFile !== undefined)
      await waitForRelease(releaseFile)
    await pause(1)
  }
  if (finishReleaseFile !== undefined) await waitForRelease(finishReleaseFile)
  respond(msg.id, { stopReason: 'end_turn' })
  return true
}
