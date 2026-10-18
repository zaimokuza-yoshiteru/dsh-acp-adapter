import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { waitForFileGate } from './file-gate.ts'

/** Hold each presentation phase until the browser has observed the preceding one. */
export async function workDetailsTurn(session: MockSession, message: PromptMessage, peer: MockPeer): Promise<boolean> {
  const text = message.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const match = /E2E_WORK_DETAILS(_NEXT)? ([a-z0-9-]+)/.exec(text)
  if (match === null) return false
  const id = match[2]!
  const say = (value: string, messageId?: string) =>
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: value },
      ...(messageId === undefined ? {} : { messageId }),
    })
  if (match[1] !== undefined) {
    say(`E2E_PREF_NEXT ${id}`)
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  }
  const directory = process.env.MOCK_WORK_DETAILS_GATE_DIR
  if (directory === undefined) throw new Error('MOCK_WORK_DETAILS_GATE_DIR is required for work-details fixtures')
  const cancellation = new AbortController()
  session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      cancellation.abort()
    },
  }
  const gate = (phase: string) => join(directory, `${id}-${phase}`)
  const wait = (phase: string) =>
    waitForFileGate(gate(phase), cancellation.signal, `Work-details fixture did not receive its ${phase} gate`)
  try {
    writeFileSync(gate('ready'), 'ready')
    if (!(await wait('output'))) {
      peer.respond(message.id, { stopReason: 'cancelled' })
      return true
    }
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `E2E_PREF_THOUGHT ${id}\nA second reasoning line.` },
    })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'work-details-setup',
      title: `printf E2E_PREF_SETUP_${id}`,
      kind: 'execute',
      status: 'completed',
      rawInput: { command: `printf E2E_PREF_SETUP_${id}`, cwd: session.cwd },
      rawOutput: { formatted_output: `E2E_PREF_SETUP_${id}`, exit_code: 0 },
    })
    say(`E2E_PREF_PROGRESS ${id}`, 'work-details-progress')
    peer.sendUpdate(session.id, {
      sessionUpdate: 'plan',
      entries: [
        {
          content: `E2E_PREF_PLAN ${id}: verify that a long recorded plan keeps its wrapped lines aligned with the text.`,
          status: 'in_progress',
          priority: 'high',
        },
      ],
    })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `E2E_PREF_CHECK ${id}\nCheck the final result.` },
    })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'work-details-tool',
      title: `printf E2E_PREF_TOOL_${id}`,
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: `printf E2E_PREF_TOOL_${id}`, cwd: session.cwd },
    })
    writeFileSync(gate('streaming'), 'streaming')
    if (!(await wait('finish'))) {
      peer.respond(message.id, { stopReason: 'cancelled' })
      return true
    }
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'work-details-tool',
      status: 'completed',
      rawOutput: { formatted_output: `E2E_PREF_TOOL_${id}`, exit_code: 0 },
    })
    say(`E2E_PREF_DONE ${id}`, 'work-details-answer')
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  } finally {
    cancellation.abort()
    session.turn = null
  }
}
