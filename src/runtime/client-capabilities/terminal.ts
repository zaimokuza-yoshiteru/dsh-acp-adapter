import { isSubprocessLaunchFailure } from '../process/subprocess.ts'
import { stopSubprocess } from '../process/cleanup.ts'
/**
 * ACP v1 client terminal capability.
 *
 * Terminals are agent-owned process trees started through the host subprocess
 * seam. This is Native Agent Access: the adapter does not add a sandbox or a
 * second approval boundary. The host still owns lifecycle, correlation and
 * bounded cleanup, while the agent remains responsible for deciding when to
 * create and release a terminal.
 */

/// <reference types="node" />

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpSubprocessExitFact, AcpSubprocessHandle, SubprocessSeam } from '../../runtime/process/subprocess.ts'
import type { AcpTerminalHandlers } from '../../protocol/v1/types.ts'
import type { AcpTerminalAuditData } from '../../domain/policy/events.ts'
import { terminalFailureFacts } from './terminal-failure.ts'
import type {
  AcpTerminalJobHandle,
  AcpTerminalJobHooks,
  AcpTerminalJobOutput,
  AcpTerminalJobStarter,
} from './terminal-job.ts'

/** Keep individual terminal snapshots bounded even when an agent omits a limit. */
export const ACP_TERMINAL_DEFAULT_OUTPUT_BYTES = 1_048_576
export const ACP_TERMINAL_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024
export const ACP_TERMINAL_RELEASE_WAIT_MS = 10_000
export const ACP_TERMINAL_MAX_ACTIVE = 64

export interface AcpTerminalHandlersOptions {
  readonly subprocess: SubprocessSeam
  readonly profileId: string
  readonly dshSessionId: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly audit?: (event: AcpTerminalAuditData) => Promise<void>
  /** In-memory process fact; must not wait behind durable audit I/O. */
  readonly onExit?: (event: AcpTerminalAuditData) => void
  readonly onAuditError?: (error: unknown, event: AcpTerminalAuditData) => void
  readonly releaseWaitMs?: number
  readonly startJob?: AcpTerminalJobStarter | undefined
}

class TerminalOutputRing {
  private data = Buffer.alloc(0)
  private didTruncate = false
  readonly limit: number

  constructor(requested: number | null | undefined) {
    const normalized =
      requested === null || requested === undefined
        ? ACP_TERMINAL_DEFAULT_OUTPUT_BYTES
        : Number.isSafeInteger(requested) && requested >= 0
          ? requested
          : (() => {
              throw new Error('terminal outputByteLimit must be a non-negative integer')
            })()
    this.limit = Math.min(normalized, ACP_TERMINAL_MAX_OUTPUT_BYTES)
  }

  append(chunk: unknown): void {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk), 'utf8')
    if (bytes.length === 0) return
    if (this.limit === 0) {
      this.didTruncate = true
      this.data = Buffer.alloc(0)
      return
    }
    const combined = Buffer.concat([this.data, bytes])
    if (combined.length <= this.limit) {
      this.data = combined
      return
    }
    this.didTruncate = true
    let start = combined.length - this.limit
    // The retained suffix must start at a UTF-8 character boundary. If the
    // stream contained malformed bytes, Buffer.toString('utf8') still gives a
    // valid replacement-character string rather than leaking invalid text.
    while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1
    this.data = combined.subarray(start)
  }

  get bytes(): number {
    return this.data.length
  }
  get truncated(): boolean {
    return this.didTruncate
  }
  text(): string {
    return this.data.toString('utf8')
  }
}

interface TerminalRecord {
  readonly id: string
  readonly dshSessionId: string
  readonly profileId: string
  readonly acpSessionId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  handle: AcpSubprocessHandle
  readonly output: TerminalOutputRing
  readonly flushJobOutput: () => void
  done: Promise<AcpSubprocessExitFact | undefined>
  exit: AcpSubprocessExitFact | null
  released: boolean
  killRequested: boolean
  error?: Error
  failure?: AcpTerminalAuditData['failure']
  auditTail: Promise<void>
  releasePromise?: Promise<boolean>
  job?: AcpTerminalJobHandle
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function assertSession(paramsSessionId: string, expected: string): void {
  if (paramsSessionId !== expected) throw new Error('terminal request belongs to a different ACP session')
}

function assertCommand(command: string): void {
  if (command.length === 0 || command.includes('\0'))
    throw new Error('terminal command must be a non-empty executable without NUL')
}

function assertArgs(args: readonly string[]): void {
  if (args.some((arg) => arg.includes('\0'))) throw new Error('terminal arguments must not contain NUL')
}

function isSpawnNotFound(error: unknown): boolean {
  return isSubprocessLaunchFailure(error) && (error as { code: string }).code === 'ENOENT'
}

function isShellCommandLaunchFailure(error: unknown, command: string): boolean {
  if (isSpawnNotFound(error)) return true
  if (typeof error !== 'object' || error === null) return false
  const { code, syscall } = error as { code?: unknown; syscall?: unknown }
  if (
    code !== 'ENAMETOOLONG' ||
    typeof syscall !== 'string' ||
    !(syscall === 'spawn' || syscall.startsWith('spawn ') || syscall === 'execve') ||
    Buffer.byteLength(command, 'utf8') <= 255
  )
    return false
  // A long `node -e "..."` can exceed the executable-name limit before ENOENT.
  // Admit only an ordinary bare program followed by argument text. A real
  // executable path, an overlong first token or an ambiguous quoted prefix
  // must keep its launch error rather than become shell syntax.
  const program = /^([A-Za-z0-9_][A-Za-z0-9_.+-]*)[ \t\r\n]+\S/.exec(command)?.[1]
  return program !== undefined && program.length <= 255
}

/**
 * A few ACP clients send a shell command in `command` while leaving `args`
 * empty (for example `uname -s`). Try the structured executable first; a
 * launch-level ENOENT or an unambiguous long command's ENAMETOOLONG may fall
 * back once to the platform shell. An exited command (including shell exit
 * 127) is never retried, so this cannot duplicate an already-running process.
 */
function shellFallbackArgv(command: string, args: readonly string[]): readonly string[] {
  const commandLine = [command, ...args].join(' ')
  return process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', commandLine] : ['/bin/sh', '-c', commandLine]
}

function assertEnvName(name: string): void {
  if (name.length === 0 || name.includes('=') || /[\0\r\n]/.test(name))
    throw new Error('terminal environment names must be non-empty and must not contain =, NUL, or line breaks')
}

function exitStatus(exit: AcpSubprocessExitFact | null): acp.TerminalExitStatus | null {
  return exit === null ? null : { exitCode: exit.exitCode, signal: exit.signal }
}

function auditEvent(
  record: TerminalRecord,
  operation: AcpTerminalAuditData['operation'],
  outcome: AcpTerminalAuditData['outcome'],
): AcpTerminalAuditData {
  const event: AcpTerminalAuditData = {
    operation,
    terminalId: record.id,
    dshSessionId: record.dshSessionId,
    profileId: record.profileId,
    acpSessionId: record.acpSessionId,
    command: record.command,
    argCount: record.args.length,
    cwd: record.cwd,
    outputBytes: record.output.bytes,
    truncated: record.output.truncated,
    outcome,
    terminationRequested: record.killRequested,
    ...(record.exit === null ? {} : { exitCode: record.exit.exitCode, signal: record.exit.signal }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  }
  return event
}

function attachOutput(stream: Readable | undefined, append: (chunk: unknown) => void): void {
  stream?.on('data', append)
  stream?.on('error', () => {})
}

/** Decode each pipe independently; native readers never consume ACP's ring. */
function attachJobOutput(stream: Readable | undefined, append: (text: string) => void): () => void {
  if (stream === undefined) return () => {}
  const decoder = new StringDecoder('utf8')
  let flushed = false
  const write = (text: string): void => {
    if (text.length > 0) append(text)
  }
  const onData = (chunk: unknown): void => {
    const bytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), 'utf8')
    write(decoder.write(bytes))
  }
  const flush = (): void => {
    if (flushed) return
    flushed = true
    stream.off('data', onData)
    stream.off('end', flush)
    stream.off('close', flush)
    write(decoder.end())
  }
  stream.on('data', onData)
  stream.once('end', flush)
  stream.once('close', flush)
  return flush
}

/** Create a per-connection ACP v1 terminal host. */
export function createAcpTerminalHandlers(options: AcpTerminalHandlersOptions): AcpTerminalHandlers {
  const active = new Map<string, TerminalRecord>()
  let disposed = false
  const releaseWaitMs = options.releaseWaitMs ?? ACP_TERMINAL_RELEASE_WAIT_MS

  const recordAudit = (
    record: TerminalRecord,
    operation: AcpTerminalAuditData['operation'],
    outcome: AcpTerminalAuditData['outcome'],
  ): Promise<void> => {
    const event = auditEvent(record, operation, outcome)
    const audit = options.audit
    if (audit === undefined) return Promise.resolve()
    const operationPromise = record.auditTail
      .then(() => audit(event))
      .catch((error: unknown) => options.onAuditError?.(error, event))
      .then(() => {})
    record.auditTail = operationPromise
    return operationPromise
  }

  const get = (terminalId: string, acpSessionId: string): TerminalRecord => {
    if (disposed) throw new Error('terminal host is disposed')
    const record = active.get(terminalId)
    if (record === undefined) throw new Error('terminal ID is unknown or already released')
    assertSession(acpSessionId, record.acpSessionId)
    return record
  }

  const requestKill = (record: TerminalRecord): void => {
    if (record.killRequested) return
    record.handle.terminate()
    record.killRequested = true
    void recordAudit(record, 'kill', 'killed')
  }

  const cancelRecord = (record: TerminalRecord): void => {
    if (record.killRequested) return
    if (record.job === undefined) return requestKill(record)
    try {
      record.job.cancel()
    } catch {
      // The owner/registry may already have been disposed. The terminal still
      // owns its handle and must finish cleanup independently of presentation.
      requestKill(record)
    }
  }

  const jobDone = async (record: TerminalRecord): AcpTerminalJobHooks['done'] => {
    const fact = await record.done
    let cleanupError: string | undefined
    let exited = false
    try {
      // Command completion is separate from managed-range quiescence. Always
      // use the provider's bounded cleanup ladder: a detached child can keep
      // waitForExit pending after the main command has already settled.
      exited = await stopSubprocess(record.handle, { eofGraceMs: 0, exitWaitMs: releaseWaitMs })
    } catch (error) {
      cleanupError = `terminal cleanup failed: ${String(error)}; managed-range exit remains unconfirmed`
    }
    if (!exited && cleanupError === undefined)
      cleanupError = 'terminal managed-range exit was not confirmed; cleanup remains unconfirmed'
    const failure =
      [record.error?.message, cleanupError].filter((detail): detail is string => detail !== undefined).join('; ') ||
      undefined
    // Flush a trailing partial UTF-8 sequence before the native registry seals
    // its ring. ACP retains its independent byte snapshot until release.
    record.flushJobOutput()
    return {
      status:
        failure !== undefined
          ? 'failed'
          : record.killRequested
            ? 'killed'
            : fact?.exitCode === 0
              ? 'completed'
              : 'failed',
      detail:
        failure ?? (fact?.signal ? `signal: ${fact.signal}` : `exit code: ${String(fact?.exitCode ?? 'unknown')}`),
    }
  }

  const createTerminal = async (params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> => {
    if (disposed) throw new Error('terminal host is disposed')
    if (active.size >= ACP_TERMINAL_MAX_ACTIVE) throw new Error('terminal host has reached its active terminal limit')
    assertCommand(params.command)
    const args = params.args ?? []
    assertArgs(args)
    const cwd = params.cwd ?? options.cwd
    if (!isAbsolutePath(cwd) || cwd.includes('\0')) throw new Error('terminal cwd must be an absolute path without NUL')
    const env = { ...options.env }
    for (const variable of params.env ?? []) {
      assertEnvName(variable.name)
      if (variable.value.includes('\0')) throw new Error('terminal environment values must not contain NUL')
      env[variable.name] = variable.value
    }
    const output = new TerminalOutputRing(params.outputByteLimit)
    const spawnSpec = {
      argv: [params.command, ...args],
      cwd,
      env,
      graceMs: 2_000,
    } as const
    const canShellFallback = args.length === 0
    const id = `term_${randomUUID().replaceAll('-', '')}`
    let attempt: 'direct' | 'shell-fallback' = 'direct'
    let phase: 'spawn' | 'completion' = 'spawn'
    let spawnAttempted = false
    const spawn = (argv: readonly string[], nextAttempt: typeof attempt): AcpSubprocessHandle => {
      attempt = nextAttempt
      phase = 'spawn'
      spawnAttempted = true
      const handle = options.subprocess.spawn({ ...spawnSpec, argv })
      phase = 'completion'
      return handle
    }
    const start = (jobOutput?: AcpTerminalJobOutput): TerminalRecord => {
      let handle: AcpSubprocessHandle
      try {
        handle = spawn(spawnSpec.argv, 'direct')
      } catch (error) {
        if (!canShellFallback || !isShellCommandLaunchFailure(error, params.command)) throw error
        handle = spawn(shellFallbackArgv(params.command, args), 'shell-fallback')
      }
      const outputFlushers: (() => void)[] = []
      const record = {
        id,
        acpSessionId: params.sessionId,
        command: params.command,
        args: [...args],
        cwd,
        handle,
        output,
        flushJobOutput: () => {
          for (const flush of outputFlushers) flush()
        },
        exit: null,
        released: false,
        killRequested: false,
        dshSessionId: options.dshSessionId,
        profileId: options.profileId,
        done: Promise.resolve(undefined),
        auditTail: Promise.resolve(),
      } as TerminalRecord
      active.set(id, record)
      const attachHandle = (nextHandle: AcpSubprocessHandle): void => {
        record.handle = nextHandle
        attachOutput(nextHandle.stdout, (chunk) => {
          record.output.append(chunk)
        })
        attachOutput(nextHandle.stderr, (chunk) => {
          record.output.append(chunk)
        })
        if (jobOutput !== undefined) {
          outputFlushers.push(
            attachJobOutput(nextHandle.stdout, (text) => jobOutput(text, 'stdout')),
            attachJobOutput(nextHandle.stderr, (text) => jobOutput(text, 'stderr')),
          )
        }
        // ACP v1 exposes no terminal stdin method. Closing stdin prevents commands
        // that read input from remaining alive forever while the Agent only polls output.
        try {
          nextHandle.stdin?.end()
        } catch {
          /* process teardown remains authoritative */
        }
      }
      attachHandle(handle)
      const settleProcess = async (): Promise<AcpSubprocessExitFact> => {
        try {
          return await handle.done
        } catch (error) {
          // A process that was accepted by the OS and later exits with an error
          // must not be retried. The shell itself is never retried either.
          if (!canShellFallback || attempt !== 'direct' || !isShellCommandLaunchFailure(error, params.command))
            throw error
          if (!(await stopSubprocess(handle, { eofGraceMs: 0, exitWaitMs: releaseWaitMs }))) throw error
          if (record.released || record.killRequested || disposed) throw error
          const fallback = spawn(shellFallbackArgv(params.command, args), 'shell-fallback')
          attachHandle(fallback)
          return await fallback.done
        }
      }
      record.done = settleProcess().then(
        (fact) => {
          record.exit = fact
          try {
            options.onExit?.(auditEvent(record, 'exit', 'exited'))
          } catch {
            // Presentation observers must never change the process result.
          }
          void recordAudit(record, 'exit', 'exited')
          return fact
        },
        (error: unknown) => {
          record.error = error instanceof Error ? error : new Error(String(error))
          record.failure = terminalFailureFacts(error, params.command, args, attempt, phase)
          void recordAudit(record, 'exit', 'error')
          return undefined
        },
      )
      return record
    }
    let record!: TerminalRecord
    try {
      if (options.startJob === undefined) record = start()
      else {
        const job = options.startJob([params.command, ...args].join(' '), (jobOutput) => {
          record = start(jobOutput)
          return { cancel: () => requestKill(record), done: jobDone(record) }
        })
        record.job = job
      }
    } catch (error) {
      if (spawnAttempted && options.audit !== undefined) {
        const event: AcpTerminalAuditData = {
          operation: 'create',
          terminalId: id,
          dshSessionId: options.dshSessionId,
          profileId: options.profileId,
          acpSessionId: params.sessionId,
          command: '[omitted]',
          argCount: args.length,
          cwd,
          outputBytes: 0,
          truncated: false,
          outcome: 'error',
          failure: terminalFailureFacts(error, params.command, args, attempt, phase),
        }
        try {
          await options.audit(event)
        } catch (auditError) {
          try {
            options.onAuditError?.(auditError, event)
          } catch {
            /* keep the original launch error */
          }
        }
      }
      throw error
    }
    await recordAudit(record, 'create', 'started')
    return { terminalId: id }
  }

  const terminalOutput = async (params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> => {
    const record = get(params.terminalId, params.sessionId)
    const outcome = record.error === undefined ? (record.exit === null ? 'running' : 'exited') : 'error'
    await recordAudit(record, 'output-summary', outcome)
    return {
      output: record.output.text(),
      truncated: record.output.truncated,
      exitStatus: exitStatus(record.exit),
    }
  }

  const waitForExit = async (params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> => {
    const record = get(params.terminalId, params.sessionId)
    await record.done
    const exit = record.exit
    if (exit === null) throw record.error ?? new Error('terminal exited without an exit fact')
    return { exitCode: exit.exitCode, signal: exit.signal }
  }

  const killTerminal = async (params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> => {
    const record = get(params.terminalId, params.sessionId)
    cancelRecord(record)
    await record.auditTail
    return {}
  }

  const releaseOne = async (record: TerminalRecord, signal?: AbortSignal): Promise<boolean> => {
    if (record.released) return true
    if (record.releasePromise !== undefined) return await record.releasePromise
    record.releasePromise = (async () => {
      if (record.job !== undefined) cancelRecord(record)
      record.killRequested = true
      const exited = await stopSubprocess(record.handle, { eofGraceMs: 0, exitWaitMs: releaseWaitMs, signal })
      if (!exited) {
        await recordAudit(record, 'release', 'timeout')
        delete record.releasePromise
        return false
      }
      record.released = true
      active.delete(record.id)
      // No protocol operation may use the released ID again.
      // A durable release audit is the final operation.
      await recordAudit(record, 'release', 'released')
      await record.auditTail
      record.job?.release()
      return true
    })()
    return await record.releasePromise
  }

  const releaseTerminal = async (params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> => {
    const record = get(params.terminalId, params.sessionId)
    if (!(await releaseOne(record)))
      throw new Error('terminal release timed out while the process tree was still running; retry release')
    return {}
  }

  const cancelSession = (acpSessionId: string): void => {
    for (const record of active.values()) {
      if (record.acpSessionId !== acpSessionId || record.killRequested) continue
      if (record.exit !== null && record.job === undefined) continue
      cancelRecord(record)
    }
  }

  const releaseSession = async (acpSessionId: string): Promise<void> => {
    const records = [...active.values()].filter((record) => record.acpSessionId === acpSessionId)
    const deadline = AbortSignal.timeout(releaseWaitMs)
    await Promise.all(records.map((record) => releaseOne(record, deadline)))
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    const records = [...active.values()]
    const deadline = AbortSignal.timeout(releaseWaitMs)
    await Promise.all(records.map((record) => releaseOne(record, deadline)))
  }

  return {
    createTerminal,
    terminalOutput,
    waitForExit,
    killTerminal,
    releaseTerminal,
    cancelSession,
    releaseSession,
    dispose,
  }
}
