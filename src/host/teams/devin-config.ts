/** Register one native Devin MCP entry. Session capabilities live only in child environments. */
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../runtime/process/subprocess.ts'
import { stopSubprocess } from '../../runtime/process/cleanup.ts'
import { finished } from 'node:stream/promises'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'

export const DEVIN_MCP_NAME = 'dsh'

interface DevinMcpOptions {
  subprocess: SubprocessSeam
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  lease: AcpMcpLease
}

/** Serialize our native CLI writes across sessions and DSH processes. A crashed owner is recoverable. */
async function lock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'registration.lock')
  const deadline = Date.now() + 35_000
  while (true) {
    try {
      await mkdir(path)
      await writeFile(join(path, 'pid'), String(process.pid))
      return async () => { await rm(path, { recursive: true, force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const pid = Number(await readFile(join(path, 'pid'), 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path, { recursive: true, force: true }); continue }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // A crash can leave the directory before its pid file is written.
        const info = await stat(path).catch(() => undefined)
        if (info === undefined) continue
        if (Date.now() - info.mtimeMs > 60_000) { await rm(path, { recursive: true, force: true }); continue }
      }
      if (Date.now() >= deadline) throw new Error('DSH MCP registration is busy; retry after the other Devin launch finishes')
      await delay(100)
    }
  }
}

export async function prepareDevinMcp({ subprocess, command, args, cwd, env, lease }: DevinMcpOptions): Promise<{ env: Record<string, string>; lease: AcpMcpLease }> {
  try {
    const server = lease.servers[0]
    if (lease.servers.length !== 1 || server === undefined || !('type' in server) || server.type !== 'http') throw new Error('Devin requires one local DSH HTTP bridge')
    // A stable, dependency-free launcher survives plugin upgrades. It is inert outside a DSH launch.
    const directory = join(env.HOME ?? homedir(), '.dsh', 'acp', 'mcp')
    const launcher = join(directory, 'dsh-mcp-launcher.mjs')
    const release = await lock(directory)
    try {
      const bytes = await readFile(fileURLToPath(new URL('../../../lib/runtime/session/dsh-mcp-launcher.mjs', import.meta.url)))
      const existing = await readFile(launcher).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (!existing?.equals(bytes)) {
        const temporary = `${launcher}.${randomUUID()}.tmp`
        try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, launcher) }
        finally { await rm(temporary, { force: true }) }
      }
      const index = args.lastIndexOf('acp')
      const prefix = index < 0 ? [...args] : args.slice(0, index)
      const cli = async (parameters: string[]) => {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 10_000)
        let handle: AcpSubprocessHandle
        try { handle = subprocess.spawn({ argv: [command, ...prefix, 'mcp', ...parameters], cwd, env, graceMs: 500, signal: AbortSignal.any([abort.signal, lease.signal]) }) }
        catch { clearTimeout(timer); throw new Error('Cannot launch Devin MCP registration command') }
        let stdout = '', stderr = ''
        const collect = (chunk: Buffer, target: 'out' | 'err') => {
          if (stdout.length + stderr.length > 1024 * 1024) { abort.abort(); return }
          if (target === 'out') stdout += chunk.toString()
          else stderr += chunk.toString()
        }
        handle.stdout?.on('data', chunk => collect(chunk, 'out'))
        handle.stderr?.on('data', chunk => collect(chunk, 'err'))
        try {
          handle.stdin?.end()
          const [result] = await Promise.all([handle.done, ...[handle.stdout, handle.stderr].filter(stream => stream !== undefined).map(stream => finished(stream))])
          if (result.exitCode === 0 && !abort.signal.aborted) return { stdout }
          if (parameters[0] === 'get' && result.exitCode === 1 && stderr.includes("Server 'dsh' not found")) return undefined
          throw new Error('command failed')
        } catch {
          // Never surface third-party argv/stdout/stderr: they may contain credentials.
          throw new Error(`Devin MCP ${parameters[0]} failed; check the Devin executable and native config permissions`)
        } finally {
          clearTimeout(timer)
          await stopSubprocess(handle, { eofGraceMs: 100, exitWaitMs: 1500 })
        }
      }
      const current = await cli(['get', DEVIN_MCP_NAME])
      const expected = `Command: ${process.execPath} ${launcher}`
      if (current !== undefined && !current.stdout.split('\n').some(line => line.trim() === expected)) {
        // A previous install may have used another Node executable, but an unrelated server is never overwritten.
        if (!current.stdout.split('\n').some(line => line.trim().startsWith('Command: ') && line.trim().endsWith(` ${launcher}`))) {
          throw new Error('Devin already has an unrelated MCP server named dsh; rename that entry before connecting DSH')
        }
      }
      if (current === undefined || !current.stdout.split('\n').some(line => line.trim() === expected)) {
        await cli(['add', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', DEVIN_MCP_NAME, '--', process.execPath, launcher])
      }
      lease.signal.throwIfAborted()
    } finally { await release() }
    let closing: Promise<void> | undefined
    return {
      env: { ...env, DSH_ACP_TEAM_MCP_URL: server.url },
      lease: {
        ...lease,
        servers: [],
        close: () => closing ??= lease.close(),
      },
    }
  } catch (error) { await lease.close(); throw error }
}
