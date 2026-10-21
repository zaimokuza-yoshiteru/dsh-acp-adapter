import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MockPeer, MockSession, PromptMessage } from './types.ts'

/** Mirrors the seven real Devin choices; the fixture records the exact choice, not a persistent grant. */
export const PARENT_PERMISSION_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
  {
    optionId: 'allow_session',
    kind: 'allow_always',
    name: 'Yes, allow calling write on the dsh MCP server (this session)',
  },
  { optionId: 'allow_always', kind: 'allow_always', name: 'Yes, always allow calling write on the dsh MCP server' },
  {
    optionId: 'allow_server_session',
    kind: 'allow_always',
    name: 'Yes, allow calling all tools on the dsh MCP server (this session)',
  },
  {
    optionId: 'allow_server_always',
    kind: 'allow_always',
    name: 'Yes, always allow calling tools on the dsh MCP server',
  },
  { optionId: 'switch_bypass', kind: 'allow_always', name: 'Yes, switch to bypass mode' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
] as const

export function parentPermissionMarker(key: string): string {
  return `parent-permission-${key}.jsonl`
}

/** Distinct opt-in prompt keeps the existing four-option regression unchanged. */
export async function parentPermissionOptionsTurn(session: MockSession, msg: PromptMessage, peer: MockPeer) {
  const text = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const key = /E2E_PARENT_PERMISSION_OPTIONS:([a-z0-9-]+)/.exec(text)?.[1]
  if (key === undefined) return false
  const cancelled = Promise.withResolvers<null>()
  const turn = (session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      cancelled.resolve(null)
    },
  })
  try {
    const markerPath = join(session.cwd, parentPermissionMarker(key))
    const fileWrite = key.startsWith('file-write-')
    const longScope = key.startsWith('long-scope-')
    const command = longScope
      ? `node -e 'process.stdout.write(process.argv[1])' '${'review-permission-context '.repeat(120)}' > '${markerPath}' # ACP_LONG_COMMAND_END`
      : `write ${parentPermissionMarker(key)}`
    const answer = await Promise.race([
      peer.sendAgentRequest('session/request_permission', {
        sessionId: session.id,
        toolCall: {
          toolCallId: `parent-scope-${key}`,
          kind: fileWrite ? 'other' : 'execute',
          title: fileWrite ? 'write' : `External ACP marker ${key}`,
          rawInput: fileWrite
            ? { content: 'A short review marker.', file_path: markerPath }
            : {
                command,
                cwd: session.cwd,
                ...(longScope
                  ? {
                      additionalPermissions: {
                        filesystem: { write: { paths: [markerPath], policy: 'ASK_BEFORE_SCOPE_EXPANSION' } },
                        network: { domains: ['review.example.invalid'], mode: 'REQUIRES_OPERATOR_REVIEW_AT_END' },
                      },
                    }
                  : {}),
              },
          ...(fileWrite ? {} : { locations: [{ path: markerPath }] }),
        },
        options: PARENT_PERMISSION_OPTIONS,
      }),
      cancelled.promise,
    ])
    peer.log(`parent-options-answer key=${key} session=${session.id} answer=${JSON.stringify(answer)}`)
    const optionId = answer?.outcome.optionId
    if (!turn.cancelled && optionId !== undefined && optionId !== 'reject_once')
      appendFileSync(
        join(session.cwd, parentPermissionMarker(key)),
        `${JSON.stringify({ key, sessionId: session.id, optionId })}\n`,
      )
    if (!turn.cancelled)
      peer.sendUpdate(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `PARENT_OPTION_RESULT ${key} ${optionId ?? 'cancelled'}` },
      })
    peer.respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' })
    return true
  } finally {
    if (session.turn === turn) session.turn = null
  }
}
