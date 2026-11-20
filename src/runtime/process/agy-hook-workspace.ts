/** One private customization workspace and policy endpoint per verified agy process. */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOOK_DEADLINE_MS,
  HOOK_KEY_ENV,
  HOOK_SOCKET_ENV,
  HOOK_UNAVAILABLE,
  isAgyHookInput,
  readHookJson,
} from './agy-hook-wire.ts'
import type { AgyPreToolUseInput, AgyPreToolUseReply } from './agy-hook-wire.ts'

type AgyHookEvaluator = (input: AgyPreToolUseInput, signal: AbortSignal) => Promise<AgyPreToolUseReply>

export interface AgyHookLaunch {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  close(): Promise<void>
}

function shellQuote(path: string): string {
  return "'" + path.replaceAll("'", "'\\''") + "'"
}

export async function openAgyHookWorkspace(
  argv: readonly string[],
  env: Record<string, string>,
  evaluate: AgyHookEvaluator,
): Promise<AgyHookLaunch> {
  // Darwin's per-user TMPDIR can exceed its UNIX socket path limit. mkdtemp creates a private 0700 directory.
  const root = await mkdtemp('/tmp/dsh-agy-')
  const socketPath = join(root, 'policy.sock')
  const customizations = join(root, 'workspace')
  const key = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  const evaluating = new Set<Promise<AgyPreToolUseReply>>()
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== 'Bearer ' + key) {
      res.writeHead(403).end()
      return
    }
    const client = new AbortController()
    res.once('close', () => client.abort())
    const signal = AbortSignal.any([lifetime.signal, client.signal, AbortSignal.timeout(HOOK_DEADLINE_MS)])
    let reply: AgyPreToolUseReply = HOOK_UNAVAILABLE
    try {
      const input = await readHookJson(req)
      if (isAgyHookInput(input) && !signal.aborted) {
        const accepted = Promise.resolve().then(() => evaluate(input, signal))
        evaluating.add(accepted)
        try {
          reply = await accepted
        } finally {
          evaluating.delete(accepted)
        }
      }
    } catch {
      // Keep the command denied when the policy result is unknown.
    }
    if (!signal.aborted) res.end(JSON.stringify(reply))
  })
  server.requestTimeout = HOOK_DEADLINE_MS
  server.headersTimeout = HOOK_DEADLINE_MS
  let closing: Promise<void> | undefined
  function close() {
    return (closing ??= (async () => {
      lifetime.abort()
      if (server.listening) {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await stopped
      }
      await Promise.allSettled(evaluating)
      await rm(root, { recursive: true, force: true })
    })())
  }
  try {
    await mkdir(join(customizations, '.agents'), { recursive: true, mode: 0o700 })
    const hookClient = fileURLToPath(new URL('./agy-hook-client.js', import.meta.url))
    const command = '/usr/bin/env ELECTRON_RUN_AS_NODE=1 ' + shellQuote(process.execPath) + ' ' + shellQuote(hookClient)
    const hooks = {
      dshAcpAdapterPolicy: {
        enabled: true,
        PreToolUse: [{ matcher: '^run_command$', hooks: [{ type: 'command', command, timeout: 12 }] }],
      },
    }
    await writeFile(join(customizations, '.agents', 'hooks.json'), JSON.stringify(hooks), { mode: 0o600, flag: 'wx' })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    return {
      argv: [...argv, '--add-dir', customizations],
      env: { ...env, [HOOK_SOCKET_ENV]: socketPath, [HOOK_KEY_ENV]: key },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
