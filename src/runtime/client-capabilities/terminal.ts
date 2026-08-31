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
import type { Readable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpSubprocessExitFact, AcpSubprocessHandle, SubprocessSeam } from '../../runtime/process/subprocess.ts'
import type { AcpTerminalHandlers as AcpTerminalHandlerFace } from '../../protocol/v1/types.ts'
import type { AcpTerminalAuditData } from '../../domain/policy/events.ts'

/** Keep individual terminal snapshots bounded even when an agent omits a limit. */
export const ACP_TERMINAL_DEFAULT_OUTPUT_BYTES = 1_048_576
export const ACP_TERMINAL_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024
export const ACP_TERMINAL_RELEASE_WAIT_MS = 10_000
export const ACP_TERMINAL_PRESENTATION_MAX_COUNT = 128
export const ACP_TERMINAL_PRESENTATION_MAX_BYTES = 8 * 1_024 * 1_024
export const ACP_TERMINAL_MAX_ACTIVE = 64

export interface AcpTerminalHandlers extends AcpTerminalHandlerFace {
  /** A read-only snapshot for a future UI presentation seam. */
  readonly presentationSnapshot?: (terminalId: string) => AcpTerminalPresentationSnapshot | undefined
}

export interface AcpTerminalPresentationSnapshot {
  readonly terminalId: string
  readonly command: string
  readonly cwd: string
  readonly output: string
  readonly truncated: boolean
  readonly exitStatus: acp.TerminalExitStatus | null
  readonly state: 'running' | 'completed' | 'error'
  readonly released: boolean
}

export interface AcpTerminalHandlersOptions {
  readonly subprocess: SubprocessSeam
  readonly profileId: string
  readonly dshSessionId: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly audit?: (event: AcpTerminalAuditData) => Promise<void>
  readonly onAuditError?: (error: unknown, event: AcpTerminalAuditData) => void
  readonly releaseWaitMs?: number
}

class TerminalOutputRing {
  private data = Buffer.alloc(0)
  private didTruncate = false
  readonly limit: number

  constructor(requested: number | null | undefined) {
    const normalized = requested === null || requested === undefined
      ? ACP_TERMINAL_DEFAULT_OUTPUT_BYTES
      : Number.isSafeInteger(requested) && requested >= 0
        ? requested
        : (() => { throw new Error('terminal outputByteLimit must be a non-negative integer') })()
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

  get bytes(): number { return this.data.length }
  get truncated(): boolean { return this.didTruncate }
  text(): string { return this.data.toString('utf8') }
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
  done: Promise<AcpSubprocessExitFact | undefined>
  exit: AcpSubprocessExitFact | null
  released: boolean
  killRequested: boolean
  releasedAt?: number
  error?: Error
  auditTail: Promise<void>
  releasePromise?: Promise<boolean>
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function assertSession(paramsSessionId: string, expected: string): void {
  if (paramsSessionId !== expected) throw new Error('terminal request belongs to a different ACP session')
}

function assertCommand(command: string): void {
  if (command.length === 0 || command.includes('\0')) throw new Error('terminal command must be a non-empty executable without NUL')
}

function assertArgs(args: readonly string[]): void {
  if (args.some((arg) => arg.includes('\0'))) throw new Error('terminal arguments must not contain NUL')
}

function isSpawnNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly code?: unknown; readonly message?: unknown }
  return candidate.code === 'ENOENT' || (typeof candidate.message === 'string' && /(?:ENOENT|not found|cannot find)/iu.test(candidate.message))
}

/**
 * A few ACP clients send a shell command in `command` while leaving `args`
 * empty (for example `uname -s`). Try the structured executable first; only a
 * launch-level ENOENT may fall back to the platform shell. An exited command
 * (including shell exit 127) is never retried, so this cannot duplicate an
 * already-running process or hide an agent command failure.
 */
function shellFallbackArgv(command: string, args: readonly string[]): readonly string[] {
  const commandLine = [command, ...args].join(' ')
  return process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', commandLine]
    : ['/bin/sh', '-c', commandLine]
}

function assertEnvName(name: string): void {
  if (name.length === 0 || name.includes('=') || /[\0\r\n]/.test(name)) throw new Error('terminal environment names must be non-empty and must not contain =, NUL, or line breaks')
}

function exitStatus(exit: AcpSubprocessExitFact | null): acp.TerminalExitStatus | null {
  return exit === null ? null : { exitCode: exit.exitCode, signal: exit.signal }
}

function terminalState(record: Pick<TerminalRecord, 'exit' | 'error'>): AcpTerminalPresentationSnapshot['state'] {
  return record.error !== undefined ? 'error' : record.exit === null ? 'running' : 'completed'
}

function auditEvent(record: TerminalRecord, operation: AcpTerminalAuditData['operation'], outcome: AcpTerminalAuditData['outcome']): AcpTerminalAuditData {
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
    ...(record.exit === null ? {} : { exitCode: record.exit.exitCode, signal: record.exit.signal }),
  }
  return event
}

function attachOutput(stream: Readable | undefined, append: (chunk: unknown) => void): void {
  stream?.on('data', append)
  stream?.on('error', () => {})
}

/** Create a per-connection ACP v1 terminal host. */
export function createAcpTerminalHandlers(options: AcpTerminalHandlersOptions): AcpTerminalHandlers {
  const active = new Map<string, TerminalRecord>()
  const released = new Map<string, AcpTerminalPresentationSnapshot>()
  let disposed = false
  const releaseWaitMs = options.releaseWaitMs ?? ACP_TERMINAL_RELEASE_WAIT_MS

  const refreshReleasedSnapshot = (record: TerminalRecord): void => {
    if (!record.released) return
    const previous = released.get(record.id)
    if (previous === undefined) return
    released.set(record.id, {
      ...previous,
      output: record.output.text(),
      truncated: record.output.truncated,
      exitStatus: exitStatus(record.exit),
      state: terminalState(record),
    })
    pruneReleased()
  }

  const recordAudit = (record: TerminalRecord, operation: AcpTerminalAuditData['operation'], outcome: AcpTerminalAuditData['outcome']): Promise<void> => {
    const event = auditEvent(record, operation, outcome)
    const audit = options.audit
    if (audit === undefined) return Promise.resolve()
    const operationPromise = record.auditTail.then(() => audit(event)).catch((error: unknown) => options.onAuditError?.(error, event)).then(() => {})
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
    let handle: AcpSubprocessHandle
    try {
      handle = options.subprocess.spawn(spawnSpec)
    } catch (error) {
      if (!canShellFallback || !isSpawnNotFound(error)) throw error
      handle = options.subprocess.spawn({ ...spawnSpec, argv: shellFallbackArgv(params.command, args) })
    }
    const record = {
      id,
      acpSessionId: params.sessionId,
      command: params.command,
      args: [...args],
      cwd,
      handle,
      output,
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
      attachOutput(nextHandle.stdout, (chunk) => { record.output.append(chunk); refreshReleasedSnapshot(record) })
      attachOutput(nextHandle.stderr, (chunk) => { record.output.append(chunk); refreshReleasedSnapshot(record) })
      // ACP v1 exposes no terminal stdin method. Closing stdin prevents commands
      // that read input from remaining alive forever while the Agent only polls output.
      try { nextHandle.stdin?.end() } catch { /* process teardown remains authoritative */ }
    }
    attachHandle(handle)
    const settleProcess = async (): Promise<AcpSubprocessExitFact> => {
      try {
        return await handle.done
      } catch (error) {
        // A process that was accepted by the OS and later exits with an error
        // must not be retried. Only the launch-level ENOENT path is eligible.
        if (!canShellFallback || !isSpawnNotFound(error)) throw error
        const fallback = options.subprocess.spawn({ ...spawnSpec, argv: shellFallbackArgv(params.command, args) })
        attachHandle(fallback)
        return await fallback.done
      }
    }
    record.done = settleProcess().then((fact) => {
      record.exit = fact
      refreshReleasedSnapshot(record)
      void recordAudit(record, 'exit', 'exited')
      return fact
    }, (error: unknown) => {
      record.error = error instanceof Error ? error : new Error(String(error))
      void recordAudit(record, 'exit', 'error')
      return undefined
    })
    await recordAudit(record, 'create', 'started')
    return { terminalId: id }
  }

  const terminalOutput = async (params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> => {
    const record = get(params.terminalId, params.sessionId)
    const outcome = record.error === undefined
      ? record.exit === null ? 'running' : 'exited'
      : 'error'
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
    if (record.exit === null && !record.killRequested) {
      record.killRequested = true
      record.handle.terminate()
      await recordAudit(record, 'kill', 'killed')
    }
    return {}
  }

  const releaseOne = async (record: TerminalRecord, signal?: AbortSignal): Promise<boolean> => {
    if (record.released) return true
    if (record.releasePromise !== undefined) return await record.releasePromise
    record.releasePromise = (async () => {
      if (record.exit === null) {
        record.killRequested = true
        record.handle.terminate()
        const deadline = signal ?? AbortSignal.timeout(releaseWaitMs)
        const exited = await record.handle.waitForExit(deadline).catch(() => false)
        if (!exited && record.exit === null) {
          await recordAudit(record, 'release', 'timeout')
          delete record.releasePromise
          return false
        }
      }
      record.released = true
      record.releasedAt = Date.now()
      active.delete(record.id)
      const snapshot: AcpTerminalPresentationSnapshot = {
        terminalId: record.id,
        command: record.command,
        cwd: record.cwd,
        output: record.output.text(),
        truncated: record.output.truncated,
        exitStatus: exitStatus(record.exit),
        state: terminalState(record),
        released: true,
      }
      released.set(record.id, snapshot)
      pruneReleased()
      // Keep the embedded display snapshot, but no protocol operation may use
      // the released ID again. A durable release audit is the final operation.
      await recordAudit(record, 'release', 'released')
      await record.auditTail
      return true
    })()
    return await record.releasePromise
  }

  const pruneReleased = (): void => {
    let bytes = [...released.values()].reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.output, 'utf8'), 0)
    for (const [id, snapshot] of released) {
      if (released.size <= ACP_TERMINAL_PRESENTATION_MAX_COUNT && bytes <= ACP_TERMINAL_PRESENTATION_MAX_BYTES) break
      released.delete(id)
      bytes -= Buffer.byteLength(snapshot.output, 'utf8')
    }
  }

  const releaseTerminal = async (params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> => {
    const record = get(params.terminalId, params.sessionId)
    if (!await releaseOne(record)) throw new Error('terminal release timed out while the process tree was still running; retry release')
    return {}
  }

  const cancelSession = (acpSessionId: string): void => {
    for (const record of active.values()) {
      if (record.acpSessionId !== acpSessionId || record.exit !== null || record.killRequested) continue
      record.killRequested = true
      record.handle.terminate()
      void recordAudit(record, 'kill', 'killed')
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

  const presentationSnapshot = (terminalId: string): AcpTerminalPresentationSnapshot | undefined => {
    const activeRecord = active.get(terminalId)
    const snapshot = released.get(terminalId)
    if (activeRecord === undefined && snapshot !== undefined) return snapshot
    const record = activeRecord
    if (record === undefined) return undefined
    return {
      terminalId,
      command: record.command,
      cwd: record.cwd,
      output: record.output.text(),
      truncated: record.output.truncated,
      exitStatus: exitStatus(record.exit),
      state: terminalState(record),
      released: record.released,
    }
  }

  return { createTerminal, terminalOutput, waitForExit, killTerminal, releaseTerminal, cancelSession, releaseSession, dispose, presentationSnapshot }
}
