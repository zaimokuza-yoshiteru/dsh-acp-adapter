import { expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { openCodeQuestionFixture } from '../../fixtures/opencode-question.ts'
import { isOpenCodeQuestion } from '../../../src/agents/compatibility.ts'

it('correlates only the current OpenCode question after its input arrives as a separate patch', async () => {
  const { tool, request } = openCodeQuestionFixture()
  const script = `
    const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value })+'\\n')
    const { tool, request } = ${JSON.stringify({ tool, request })}
    const update = (fields) => send({ method: 'session/update', params: { sessionId: request.sessionId, update: fields } })
    let promptId
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'OpenCode', version: '2.3.2' } } })
      if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: request.sessionId } })
      if (msg.method === 'session/prompt') {
        promptId = msg.id
        update({ sessionUpdate: 'tool_call', toolCallId: tool.toolCallId, name: 'question', title: 'question', rawInput: {} })
        update({ sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, rawInput: tool.rawInput })
        send({ method: 'elicitation/create', id: 'wrong-call', params: { ...request, toolCallId: 'another-call' } })
      }
      if (msg.id === 'wrong-call' && !msg.method) send({ method: 'elicitation/create', id: 'current-call', params: request })
      if (msg.id === 'current-call' && !msg.method) send({ id: promptId, result: { stopReason: 'end_turn' } })
    })
  `
  const argv = [process.execPath, '-e', script]
  const observed: boolean[] = []
  const runtime = new AcpSessionRuntime({
    profileId: 'custom-profile',
    cwd: process.cwd(),
    config: { command: argv[0]!, args: argv.slice(1), env: {} },
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
    onElicitationRequest: async (params, _signal, _hostTool, _call, agentTool) => {
      observed.push(isOpenCodeQuestion(agentTool?.agentName, params, agentTool?.toolCall))
      return { action: 'cancel' }
    },
  })
  try {
    await runtime.prompt([{ type: 'text', text: 'Ask a question' }], () => {})
    expect(observed).toEqual([false, true])
  } finally {
    await runtime.close()
  }
})
