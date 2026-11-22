import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import type { SubprocessSeam } from '../../runtime/process/subprocess.ts'
import { readHookJson } from '../../runtime/process/agy-hook-wire.ts'
import { agyFields, type AccountFields } from './fields.ts'

// agy normally opens the system browser if its saved login expires. Keep local keychain
// access, but prevent this private terminal and its children from launching GUI sign-in on macOS.
export const MACOS_ACCOUNT_SANDBOX = `(version 1)
(allow default)
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd")
                  (global-name "com.apple.lsd.open") (global-name "com.apple.appleeventsd"))`

/**
 * Google emits its status over a per-process callback. Receive it inside a private
 * socket directory so the raw payload (which includes email and session IDs) never hits disk.
 * No input is written to the terminal, including when the CLI asks for authentication.
 */
export async function readAntigravityAccount(
  seam: SubprocessSeam,
  profile: AcpAgentConfig,
  signal: AbortSignal,
): Promise<AccountFields> {
  if (!seam.spawnTerminal) throw new Error('Account terminal unavailable')
  const root = await mkdtemp('/tmp/dsh-acp-account-')
  const socket = join(root, 'status.sock')
  let latest: AccountFields = { plan: null, credits: null, windows: [] }
  const ready = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/') {
      res.writeHead(404).end()
      return
    }
    try {
      const fields = agyFields(await readHookJson(req))
      // Fields arrive at different initialization stages, within this one live login.
      latest = {
        ...fields,
        plan: fields.plan ?? latest.plan,
        windows: fields.windows.length ? fields.windows : latest.windows,
      }
      res.end()
      if (latest.plan && latest.windows.length) ready.resolve()
    } catch {
      res.writeHead(400).end()
    }
  })
  let terminal: Awaited<ReturnType<NonNullable<SubprocessSeam['spawnTerminal']>>> | undefined
  const finished = () => ready.resolve()
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    // mkdtemp under the literal /tmp prefix produces a shell-safe socket name.
    const command =
      '/usr/bin/curl -q --silent --max-time 2 --noproxy "*" --unix-socket ' +
      socket +
      ' --data-binary @- http://localhost/'
    const executable = await seam.resolveExecutable(profile.command, profile.env, signal)
    terminal = await seam.spawnTerminal({
      argv: [
        '/usr/bin/sandbox-exec',
        '-p',
        MACOS_ACCOUNT_SANDBOX,
        executable,
        '--settings',
        JSON.stringify({ statusLine: { type: 'command', command } }),
      ],
      env: { ...profile.env, BROWSER: '/usr/bin/false' },
      cwd: root,
      cols: 100,
      rows: 32,
      terminalType: 'xterm-256color',
      graceMs: 300,
      signal,
    })
    terminal.output.on('error', finished).resume()
    signal.addEventListener('abort', finished, { once: true })
    if (signal.aborted) finished()
    await Promise.race([ready.promise, terminal.done])
    return latest
  } finally {
    signal.removeEventListener('abort', finished)
    try {
      if (terminal) await terminal.terminate()
    } finally {
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}
