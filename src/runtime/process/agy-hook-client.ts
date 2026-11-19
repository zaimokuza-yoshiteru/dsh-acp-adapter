/** Google PreToolUse command. Forward only the tool facts, never the user's prompt or transcript. */
import { request } from 'node:http'
import {
  HOOK_DEADLINE_MS,
  HOOK_KEY_ENV,
  HOOK_SOCKET_ENV,
  HOOK_UNAVAILABLE,
  isAgyHookInput,
  readHookJson,
} from './agy-hook-wire.ts'

async function decision() {
  const socketPath = process.env[HOOK_SOCKET_ENV]
  const key = process.env[HOOK_KEY_ENV]
  if (!socketPath || !key) return HOOK_UNAVAILABLE
  const input = (await readHookJson(process.stdin)) as {
    hookEventName?: string
    conversationId?: unknown
    cwd?: unknown
    toolCall?: { name?: unknown; args?: unknown }
  } | null
  if (input?.hookEventName !== 'PreToolUse') return HOOK_UNAVAILABLE
  const facts = {
    sessionId: input.conversationId,
    cwd: input.cwd,
    toolName: input.toolCall?.name,
    args: input.toolCall?.args,
  }
  if (!isAgyHookInput(facts)) return HOOK_UNAVAILABLE

  const reply = await new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: 'POST',
        path: '/',
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(HOOK_DEADLINE_MS),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(null)
          return
        }
        readHookJson(res).then(resolve, reject)
      },
    )
    req.once('error', reject)
    req.end(JSON.stringify(facts))
  })
  if (typeof reply === 'object' && reply !== null && 'decision' in reply) {
    if (reply.decision === 'deny' && 'reason' in reply && typeof reply.reason === 'string') {
      return { decision: 'deny', reason: reply.reason }
    }
    // Google's "allow" delegates to the next hook or its normal policy. It is distinct from "auto_approve".
    if (reply.decision === 'delegate') return { decision: 'allow' }
  }
  return HOOK_UNAVAILABLE
}

process.stdout.write(JSON.stringify(await decision().catch(() => HOOK_UNAVAILABLE)) + '\n')
