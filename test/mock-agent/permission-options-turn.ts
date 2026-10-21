import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { parentPermissionOptionsTurn } from './parent-permission-options-turn.ts'

/** Real wire choices with effects only after the exact selected option. */
export async function permissionOptionsTurn(session: MockSession, msg: PromptMessage, peer: MockPeer) {
  if (await parentPermissionOptionsTurn(session, msg, peer)) return true
  const text = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (!text.includes('E2E_EXACT_PERMISSION_OPTIONS')) return false
  const cancelled = Promise.withResolvers<null>()
  const turn = (session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      cancelled.resolve(null)
    },
  })
  try {
    const answer = await Promise.race([
      peer.sendAgentRequest('session/request_permission', {
        sessionId: session.id,
        toolCall: {
          toolCallId: 'scope-options',
          kind: 'execute',
          title: 'Write isolated permission marker',
          rawInput: { command: 'write exact-option.txt in the temporary test workspace' },
        },
        options: [
          { optionId: 'allow-turn', kind: 'allow_once', name: 'Allow for this turn' },
          { optionId: 'allow-turn-strict', kind: 'allow_once', name: 'Allow for this turn with strict review' },
          { optionId: 'allow-session', kind: 'allow_always', name: 'Allow for this Agent session' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject this operation' },
        ],
      }),
      cancelled.promise,
    ])
    peer.log(`exact-options-answer=${JSON.stringify(answer)}`)
    const option = answer?.outcome.optionId
    if (option !== undefined && option !== 'reject') writeFileSync(join(session.cwd, 'exact-option.txt'), option)
    if (!turn.cancelled)
      peer.sendUpdate(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `EXACT_OPTION_RESULT ${option ?? 'cancelled'}` },
      })
    peer.respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' })
    return true
  } finally {
    if (session.turn === turn) session.turn = null
  }
}
