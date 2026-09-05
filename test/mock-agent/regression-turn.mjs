// Keyless product scenarios. Profiles vary wire representations, never assertions.
import fs from 'node:fs'

export async function regressionTurn(session, msg, { sendUpdate, sendAgentRequest, respond, log }) {
  const prompt = msg.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const profile = process.env.MOCK_PROFILE
  const model = session.configOptions.find(option => option.id === 'model')?.currentValue
  log(`regression prompt=${JSON.stringify(prompt)} model=${model}`)
  const file = /verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")/.exec(prompt)
  if (file) log(`regression file-bytes=${fs.readFileSync(JSON.parse(file[1]), 'utf8')}`)
  let release
  const cancelled = new Promise(resolve => { release = resolve })
  session.turn = { cancelled: false, cancel() { this.cancelled = true; release() } }
  const say = text => sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  try {
    if (prompt.includes('E2E_CRASH')) process.exit(49)
    if (prompt.includes('E2E_RECOVERED')) {
      say('E2E_RECOVERED_DONE')
    } else if (prompt.includes('E2E_RICH')) {
      sendUpdate(session.id, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read fixture file', kind: 'read', status: 'completed', rawInput: { path: 'fixture.txt' }, rawOutput: '1\tE2E_READ_LINE\n' })
      sendUpdate(session.id, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit fixture file', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'fixture.txt', oldText: 'E2E_OLD_LINE\n', newText: 'E2E_NEW_LINE\n' }] })
      sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMImHYnYNodBggFAC8WBwlf8b0ZAAAAAElFTkSuQmCC' } })
      say('E2E_RICH_DONE')
    } else if (prompt.includes('E2E_STOP')) {
      say('E2E_RUNNING')
      await cancelled
      log('regression cancelled')
      return respond(msg.id, { stopReason: 'cancelled' })
    } else if (prompt.includes('E2E_PERMISSION')) {
      const options = [
        { optionId: 'permit-single', kind: 'allow_once', name: 'Allow this operation' },
        { optionId: 'deny-single', kind: 'reject_once', name: 'Reject this operation' },
      ]
      const answer = await Promise.race([
        sendAgentRequest('session/request_permission', {
          sessionId: session.id,
          toolCall: { toolCallId: 'permission-1', title: 'Write approval marker', kind: 'execute', rawInput: { command: 'echo E2E_APPROVED' } },
          options: profile === 'kimi' ? [...options].reverse() : options,
        }),
        cancelled.then(() => null),
      ])
      log(`regression permission=${JSON.stringify(answer)}`)
      if (session.turn.cancelled) return respond(msg.id, { stopReason: 'cancelled' })
      const allowed = answer?.outcome?.optionId === 'permit-single'
      if (allowed) fs.writeFileSync(`${session.cwd}/approval-marker.txt`, 'E2E_APPROVED')
      say(allowed ? 'E2E_APPROVED' : 'E2E_DENIED')
    } else if (prompt.includes('E2E_PLUGIN_FOLLOWUP')) {
      if (!prompt.includes('E2E_SYSTEM_A') || prompt.includes('E2E_CONTEXT_A')) throw new Error('Host follow-up context is missing or earlier user input was replayed')
      say('E2E_FOLLOWUP_DONE')
    } else if (/E2E_CONTEXT_[AB]/.test(prompt)) {
      const version = prompt.includes('E2E_CONTEXT_B') ? 'B' : 'A'
      for (const marker of [`E2E_SYSTEM_${version}`, `E2E_RUNTIME_${version}`, 'E2E_PLUGIN_INPUT']) {
        if (!prompt.includes(marker)) throw new Error(`Missing host contribution: ${marker}`)
      }
      if (version === 'B' && (prompt.includes('E2E_CONTEXT_A') || prompt.includes('E2E_RUNTIME_A'))) throw new Error('Earlier host input was replayed')
      say(`E2E_CONTEXT_${version}_DONE`)
    } else if (prompt.includes('E2E_CHILD')) {
      const toolCallId = 'delegation-1'
      if (profile === 'claude') {
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call', toolCallId, title: 'Inspect fixture', kind: 'other', status: 'in_progress',
          rawInput: { prompt: 'E2E_CHILD_TASK', description: 'Inspect fixture' }, _meta: { claudeCode: { subagent: true } },
        })
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
          _meta: { claudeCode: { toolResponse: { agentId: 'child-1', status: 'completed', prompt: 'E2E_CHILD_TASK', content: [{ type: 'text', text: 'E2E_CHILD_RESULT' }] } } },
        })
      } else if (profile === 'devin') {
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call', toolCallId, title: 'Inspect fixture', kind: 'other', status: 'in_progress',
          _meta: { 'cognition.ai/subagent_started': { agentId: 'child-1', task: 'E2E_CHILD_TASK', title: 'Inspect fixture' } },
        })
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
          _meta: { 'cognition.ai/subagent_completed': { agentId: 'child-1', summary: 'E2E_CHILD_RESULT', success: true } },
        })
      } else {
        // These profiles do not supply the identity/task/result evidence needed
        // by the current projector. The product must not invent a child.
        sendUpdate(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Delegation without child evidence', kind: 'other', status: 'completed' })
      }
      say('E2E_PARENT_DONE')
    } else {
      const command = 'echo E2E_TOOL_OUTPUT'
      sendUpdate(session.id, { sessionUpdate: 'tool_call', toolCallId: 'execute-1', title: command, kind: 'execute', status: 'in_progress', rawInput: { command, cwd: session.cwd } })
      sendUpdate(session.id, {
        sessionUpdate: 'tool_call_update', toolCallId: 'execute-1', status: 'completed',
        ...(profile === 'codex'
          ? { rawOutput: { formatted_output: 'E2E_TOOL_OUTPUT\n', exit_code: 0 } }
          : { content: [{ type: 'content', content: { type: 'text', text: 'E2E_TOOL_OUTPUT\n' } }], rawOutput: { exitCode: 0 } }),
      })
      say('E2E_')
      await new Promise(resolve => setTimeout(resolve, 30))
      say(`DONE ${model}`)
    }
    respond(msg.id, { stopReason: 'end_turn' })
  } finally {
    session.turn = null
  }
}
