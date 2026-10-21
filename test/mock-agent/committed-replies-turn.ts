import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { waitForFileGate } from './file-gate.ts'

/** Commit a report only after the test has queued a native next-step notice. */
export async function committedRepliesTurn(
  session: MockSession,
  message: PromptMessage,
  peer: MockPeer,
): Promise<boolean> {
  const text = message.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const match = /E2E_COMMITTED_(REPORT|RECEIPT|NEXT) ([a-z0-9-]+)/.exec(text)
  if (match === null) return false
  const [, phase, id] = match
  const say = (value: string) =>
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: value },
    })
  if (phase !== 'REPORT') {
    say(phase === 'RECEIPT' ? `LATE_RECEIPT_${id}` : `NEXT_TURN_${id}`)
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  }
  const directory = process.env.MOCK_COMMITTED_REPLY_GATE_DIR
  if (directory === undefined) throw new Error('MOCK_COMMITTED_REPLY_GATE_DIR is required')
  writeFileSync(
    join(directory, `${id}-path.json`),
    JSON.stringify({
      acpCwd: session.cwd,
      linkedPath: join(session.cwd, 'report.md'),
    }),
  )
  const cancellation = new AbortController()
  session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      cancellation.abort()
    },
  }
  try {
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `PRIVATE_PROCESS_${id}` },
    })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: `report-read-${id}`,
      title: 'Read review input',
      kind: 'read',
      status: 'completed',
      rawInput: { path: join(session.cwd, 'report.md') },
      rawOutput: { content: 'Review fixture input' },
    })
    say(`MAIN_REPORT_${id}\n\nThe review completed. [Review file](${join(session.cwd, 'report.md')})`)
    if (!(await waitForFileGate(join(directory, `${id}-commit`), cancellation.signal, 'Expected queued-notice gate'))) {
      peer.respond(message.id, { stopReason: 'cancelled' })
      return true
    }
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  } finally {
    cancellation.abort()
    session.turn = null
  }
}
