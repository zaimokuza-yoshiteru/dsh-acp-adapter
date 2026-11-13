/** Register one native Devin MCP entry. Session capabilities live only in child environments. */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../runtime/process/subprocess.ts'
import { stopSubprocess } from '../../runtime/process/cleanup.ts'
import { finished } from 'node:stream/promises'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'
import { isSubprocessLaunchFailure } from '../../runtime/process/subprocess.ts'

const DEVIN_MCP_NAME = 'dsh'

interface DevinMcpOptions {
  subprocess: SubprocessSeam
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  lease: AcpMcpLease
}

/** OS-released SQLite transaction lock: serialized across processes, with no stale pid/lock cleanup race. */
async function lock(directory: string, signal: AbortSignal): Promise<() => void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(join(directory, 'registration.sqlite'))
  database.exec('PRAGMA busy_timeout = 0')
  const deadline = Date.now() + 35_000
  try {
    while (true) {
      signal.throwIfAborted()
      try {
        database.exec('BEGIN IMMEDIATE')
        return () => {
          try {
            database.exec('COMMIT')
          } finally {
            database.close()
          }
        }
      } catch (error) {
        const code = (error as { errcode?: number }).errcode
        if (code !== 5 && code !== 6) throw error
        if (Date.now() >= deadline)
          throw new Error('DSH MCP registration is busy; retry after the other Devin launch finishes')
        // Do not synchronously wait: the owner may be another session in this process.
        await delay(100, undefined, { signal })
      }
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export async function prepareDevinMcp({
  subprocess,
  command,
  args,
  cwd,
  env,
  lease,
}: DevinMcpOptions): Promise<{ env: Record<string, string>; lease: AcpMcpLease }> {
  try {
    const server = lease.servers[0]
    if (lease.servers.length !== 1 || server === undefined || !('type' in server) || server.type !== 'http')
      throw new Error('Devin requires one local DSH HTTP bridge')
    // A stable, dependency-free launcher survives plugin upgrades. It is inert outside a DSH launch.
    const directory = join(env.HOME ?? homedir(), '.dsh', 'acp', 'mcp')
    const launcher = join(directory, 'dsh-mcp-launcher.mjs')
    const release = await lock(directory, lease.signal)
    try {
      const bytes = await readFile(
        fileURLToPath(new URL('../../../lib/runtime/session/dsh-mcp-launcher.mjs', import.meta.url)),
      )
      const existing = await readFile(launcher).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
      if (!existing?.equals(bytes)) {
        const temporary = `${launcher}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, bytes, { mode: 0o600 })
          await rename(temporary, launcher)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      const index = args.lastIndexOf('acp')
      const prefix = index < 0 ? [...args] : args.slice(0, index)
      const cli = async (parameters: ['get' | 'add', ...string[]]) => {
        type Failure = 'timeout' | 'cancelled' | 'output-limit' | 'spawn' | 'exit' | 'io'
        let failure: Failure | undefined
        const fail = (kind: Failure) => {
          failure ??= kind
        }
        const started = Date.now()
        const abort = new AbortController()
        const timer = setTimeout(() => {
          fail('timeout')
          abort.abort()
        }, 10_000)
        const cancelled = () => fail('cancelled')
        lease.signal.addEventListener('abort', cancelled, { once: true })
        if (lease.signal.aborted) cancelled()
        let handle: AcpSubprocessHandle | undefined
        let outcome: { exitCode: number | null; signal: string | null } | undefined
        let stdout = '',
          stderr = '',
          stdoutBytes = 0,
          stderrBytes = 0
        try {
          handle = subprocess.spawn({
            argv: [command, ...prefix, 'mcp', ...parameters],
            cwd,
            env,
            graceMs: 500,
            signal: AbortSignal.any([abort.signal, lease.signal]),
          })
          const collect = (chunk: Buffer, target: 'out' | 'err') => {
            if (target === 'out') stdoutBytes += chunk.length
            else stderrBytes += chunk.length
            if (stdoutBytes + stderrBytes > 1024 * 1024) {
              fail('output-limit')
              abort.abort()
              return
            }
            if (target === 'out') stdout += chunk.toString()
            else stderr += chunk.toString()
          }
          handle.stdout?.on('data', (chunk) => collect(chunk, 'out'))
          handle.stderr?.on('data', (chunk) => collect(chunk, 'err'))
          handle.stdin?.end()
          const [result] = await Promise.all([
            handle.done.then((result) => {
              outcome = result
              return result
            }),
            ...[handle.stdout, handle.stderr]
              .filter((stream) => stream !== undefined)
              .map((stream) => finished(stream)),
          ])
          if (failure === undefined && result.exitCode === 0) return { stdout }
          if (
            failure === undefined &&
            parameters[0] === 'get' &&
            result.exitCode === 1 &&
            stderr.includes("Server 'dsh' not found")
          )
            return undefined
          fail('exit')
          throw new Error('command failed')
        } catch (error) {
          fail(handle === undefined || isSubprocessLaunchFailure(error) ? 'spawn' : 'io')
          const kind = failure!
          const elapsedMs = Math.max(0, Date.now() - started)
          const exitCode = Number.isSafeInteger(outcome?.exitCode) ? outcome!.exitCode : null
          const signal =
            outcome?.signal == null
              ? null
              : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGHUP', 'SIGQUIT', 'SIGPIPE'].includes(outcome.signal)
                ? outcome.signal
                : 'other'
          // Only our classifications and numeric observations cross the public boundary.
          // Third-party errors, argv, output and abort reasons can contain credentials.
          const facts = Object.freeze({
            operation: parameters[0],
            kind,
            elapsedMs,
            exitCode,
            signal,
            stdoutBytes,
            stderrBytes,
          })
          const message =
            kind === 'timeout'
              ? "Preparing Devin's tool connection timed out; check that Devin CLI responds before sending your message again."
              : kind === 'cancelled'
                ? "Preparing Devin's tool connection was cancelled; send your message again when the session is ready."
                : kind === 'spawn'
                  ? 'Devin CLI could not start; check its executable path and permissions in ACP settings.'
                  : kind === 'output-limit'
                    ? 'Devin CLI returned too much output while preparing tools; check the CLI command in ACP settings.'
                    : "Devin's tool connection could not be prepared; check that Devin CLI runs correctly and can read its configuration."
          throw new HarnessError(message, `ACP_DEVIN_MCP_${kind.replace('-', '_').toUpperCase()}`, { cause: facts })
        } finally {
          clearTimeout(timer)
          lease.signal.removeEventListener('abort', cancelled)
          if (handle !== undefined) await stopSubprocess(handle, { eofGraceMs: 100, exitWaitMs: 1500 })
        }
      }
      const current = await cli(['get', DEVIN_MCP_NAME])
      const expected = `Command: ${process.execPath} ${launcher}`
      if (current !== undefined && !current.stdout.split('\n').some((line) => line.trim() === expected)) {
        // A previous install may have used another Node executable, but an unrelated server is never overwritten.
        if (
          !current.stdout
            .split('\n')
            .some((line) => line.trim().startsWith('Command: ') && line.trim().endsWith(` ${launcher}`))
        ) {
          throw new Error(
            'Devin already has an unrelated MCP server named dsh; rename that entry before connecting DSH',
          )
        }
      }
      // `mcp get` redacts environment values, so an identical command cannot prove
      // Electron Node mode is enabled. Reapply our owned entry through Devin's CLI;
      // this replaces the same server, preserves other servers and repairs missing/wrong env.
      await cli([
        'add',
        '--scope',
        'user',
        '-e',
        'ELECTRON_RUN_AS_NODE=1',
        DEVIN_MCP_NAME,
        '--',
        process.execPath,
        launcher,
      ])
      // Verify the effective entry, not merely that writing the user scope
      // succeeded. A higher-priority entry must not redirect a trusted server
      // identity or replace the per-process endpoint with a saved address.
      const effective = await cli(['get', DEVIN_MCP_NAME])
      if (
        effective === undefined ||
        !effective.stdout.split('\n').some((line) => line.trim() === expected) ||
        /\bDSH_ACP_TEAM_MCP_URL\s*=/.test(effective.stdout)
      ) {
        throw new Error(
          'Devin effective dsh MCP entry conflicts with this session bridge; check project-level MCP overrides',
        )
      }
      lease.signal.throwIfAborted()
    } finally {
      await release()
    }
    let closing: Promise<void> | undefined
    return {
      env: { ...env, DSH_ACP_TEAM_MCP_URL: server.url },
      lease: {
        ...lease,
        servers: [],
        close: () => (closing ??= lease.close()),
      },
    }
  } catch (error) {
    await lease.close()
    throw error
  }
}
