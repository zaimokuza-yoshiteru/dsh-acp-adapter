import { join } from 'node:path'
import type { ToolCallContent } from '@agentclientprotocol/sdk'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { waitForFileGate } from './file-gate.ts'

/** Legal mixed tool content, distinct from model images saved as DSH attachments. */
export async function richMixedTurn(session: MockSession, message: PromptMessage, peer: MockPeer): Promise<boolean> {
  const prompt = message.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (message.params.prompt.some((block) => block.type === 'text' && block.text === 'E2E_RICH_MIXED_FOLLOWUP')) {
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'E2E_RICH_MIXED_FOLLOWUP_DONE' },
    })
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  }
  const match = /E2E_RICH_MIXED (generic|diff|reasoning-first|reasoning-cancel|progress-reasoning)/.exec(prompt)
  if (match === null) return false
  const variant = match[1]!
  const path = join(session.cwd, 'mixed-report.txt')
  const content: ToolCallContent[] = [
    { type: 'content', content: { type: 'text', text: 'E2E_MIXED_CAPTION' } },
    {
      type: 'content',
      content: {
        type: 'resource_link',
        name: 'E2E_MIXED_REPORT',
        uri: 'https://example.test/report?token=PRIVATE_QUERY',
        mimeType: 'text/plain',
      },
    },
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'UEFZTE9BRF9NVVNUX05PVF9SRU5ERVI=' } },
    {
      type: 'content',
      content: {
        type: 'resource_link',
        name: 'E2E_MIXED_UNSAFE_REFERENCE',
        uri: `data:text/plain;base64,${'UEFZTE9BRA=='.repeat(128)}`,
      },
    },
    ...(variant === 'diff'
      ? [{ type: 'diff' as const, path, oldText: 'E2E_MIXED_OLD\n', newText: 'E2E_MIXED_NEW\n' }]
      : []),
  ]
  const directory = process.env.MOCK_RICH_MIXED_GATE_DIR
  if (directory === undefined) throw new Error('MOCK_RICH_MIXED_GATE_DIR is required for mixed-output fixtures')
  const gate = join(directory, `rich-mixed-${variant}-finish`)
  const cancellation = new AbortController()
  session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      cancellation.abort()
    },
  }
  if (variant === 'progress-reasoning') {
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'E2E_MIXED_PROGRESS I will inspect the files first.' },
    })
  }
  if (variant === 'reasoning-first' || variant === 'reasoning-cancel' || variant === 'progress-reasoning') {
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'E2E_MIXED_REASONING Inspect before exporting the report.' },
    })
  }
  peer.sendUpdate(session.id, {
    sessionUpdate: 'tool_call',
    toolCallId: `rich-mixed-${variant}`,
    title: variant === 'diff' ? 'Edit mixed-report.txt' : 'Export mixed report',
    kind: variant === 'diff' ? 'edit' : 'other',
    status: 'in_progress',
    rawInput: variant === 'diff' ? { path } : { report: 'mixed' },
    content: content.filter((item) => item.type === 'diff'),
  })
  try {
    const released = await waitForFileGate(gate, cancellation.signal, `Mixed output fixture did not receive ${gate}`)
    if (!released) {
      peer.log(`rich-mixed ${variant} cancelled`)
      peer.respond(message.id, { stopReason: 'cancelled' })
      return true
    }
    peer.sendUpdate(session.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: `rich-mixed-${variant}`,
      status: 'completed',
      content,
    })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_RICH_MIXED_DONE ${variant}` },
    })
    peer.respond(message.id, { stopReason: 'end_turn' })
    return true
  } finally {
    cancellation.abort()
    session.turn = null
  }
}
