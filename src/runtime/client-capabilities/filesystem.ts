/// <reference types="node" />

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'

export const ACP_FS_MAX_BYTES = 8 * 1024 * 1024
export const ACP_FS_MAX_LINES = 20_000
export const ACP_FS_MAX_LINE = 1_000_000
export const ACP_FS_DEFAULT_TIMEOUT_MS = 30_000

/** Stable, content-free reason codes for failed filesystem requests. */
export type AcpFileAuditReason =
  | 'invalid-path'
  | 'not-regular-file'
  | 'file-too-large'
  | 'io-error'
  | 'invalid-utf8'
  | 'line-limit-exceeded'
  | 'invalid-line'
  | 'invalid-limit'
  | 'aborted'
  | 'timeout'
  | 'concurrent-change'
  | 'content-too-large'
  | 'invalid-content'

export interface AcpFileOperationAudit {
  readonly operation: 'read' | 'write'
  readonly path: string
  readonly bytes: number
  readonly beforeHash: string | null
  readonly afterHash: string | null
  readonly outcome: 'ok' | 'error' | 'aborted' | 'timeout' | 'concurrent-change'
  readonly acpSessionId: string
  readonly profileId: string
  /** Present for diagnostics on failed requests; never contains file content or OS error text. */
  readonly reason?: AcpFileAuditReason
  /** Original ACP read window, when supplied and representable as a safe integer. */
  readonly line?: number
  readonly limit?: number
}

export interface AcpFileSystemOptions {
  readonly profileId: string
  readonly signal?: AbortSignal
  readonly audit?: (event: AcpFileOperationAudit) => void | Promise<void>
  /** Warning sink for an audit failure after the file operation already happened. */
  readonly onAuditError?: (error: unknown, event: AcpFileOperationAudit) => void | Promise<void>
  readonly maxBytes?: number
  /** Per-request wall clock budget; system calls are raced, not magically cancelled. */
  readonly timeoutMs?: number
  /** Narrow fault-injection seam for deterministic IO deadline tests. */
  readonly io?: {
    readonly beforeRead?: () => Promise<void>
    readonly beforeWrite?: () => Promise<void>
    readonly writeFile?: typeof fs.promises.writeFile
    readonly rename?: typeof fs.promises.rename
  }
}

export interface AcpFileSystemHandlers {
  readonly readTextFile: (params: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>
  readonly writeTextFile: (params: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse>
  /** Abort in-flight operations when the ACP connection/session is disposed. */
  readonly dispose: () => void
}

function assertPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('ACP fs: path must be a non-empty absolute path without NUL')
  if (!path.isAbsolute(value)) throw new TypeError('ACP fs: path must be absolute')
  return path.normalize(value)
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('ACP fs operation aborted')
}

/**
 * Bounds the host wait even when a Node filesystem promise itself has no
 * cancellation primitive. The underlying syscall may finish later; callers
 * discard its late response. A rename that already committed in the OS cannot
 * be rolled back by this race, so the next operation re-reads disk truth.
 */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await operation
  assertNotAborted(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('ACP fs operation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, aborted]) } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function abortOutcome(signal: AbortSignal, timeoutSignal: AbortSignal): 'aborted' | 'timeout' {
  return timeoutSignal.aborted ? 'timeout' : signal.aborted ? 'aborted' : 'aborted'
}

function safeWindowNumber(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isSafeInteger(value) ? value : undefined
}

function readWindowFields(params: acp.ReadTextFileRequest): { readonly line?: number; readonly limit?: number } {
  const line = safeWindowNumber(params.line)
  const limit = safeWindowNumber(params.limit)
  return { ...(line === undefined ? {} : { line }), ...(limit === undefined ? {} : { limit }) }
}

function readFailureReason(error: unknown, signal: AbortSignal, timeoutSignal: AbortSignal): AcpFileAuditReason {
  if (timeoutSignal.aborted) return 'timeout'
  if (signal.aborted) return 'aborted'
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('path must')) return 'invalid-path'
  if (message.includes('not a regular file')) return 'not-regular-file'
  if (message.includes('exceeds') && message.includes('bytes')) return 'file-too-large'
  if (message.includes('line limits exceeded')) return 'line-limit-exceeded'
  if (message.includes('content is not valid UTF-8')) return 'invalid-utf8'
  if (message.includes('line must')) return 'invalid-line'
  if (message.includes('limit must')) return 'invalid-limit'
  return 'io-error'
}

async function emitRead(
  options: AcpFileSystemOptions,
  params: acp.ReadTextFileRequest,
  event: AcpFileOperationAudit,
  completed = false,
): Promise<void> {
  const enriched = { ...event, ...readWindowFields(params) }
  if (completed) await emitCompleted(options, enriched)
  else await emit(options.audit, enriched)
}

function checkReadWindow(text: string, line: number | null | undefined, limit: number | null | undefined): string {
  // ACP v1 permits zero for both fields. A zero line is treated as the first
  // line (the same compatibility behavior used by the reference clients),
  // while a zero limit intentionally returns an empty window.
  if (line !== undefined && line !== null && (!Number.isSafeInteger(line) || line < 0)) throw new TypeError('ACP fs: line must be a safe non-negative integer')
  // The request window is a presentation bound, not an additional file-size
  // limit.  Accept an oversized safe limit and clamp it to the host's maximum
  // instead of rejecting otherwise valid files (some ACP agents use a very
  // large sentinel/default here).
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError('ACP fs: limit must be a safe non-negative integer')
  if ((line === undefined || line === null) && (limit === undefined || limit === null)) return text
  const rows = text.split('\n')
  const start = line === undefined || line === null ? 0 : Math.max(0, line - 1)
  if (limit === 0) return ''
  const boundedLimit = limit === undefined || limit === null ? undefined : Math.min(limit, ACP_FS_MAX_LINES)
  return rows.slice(start, boundedLimit === undefined ? undefined : start + boundedLimit).join('\n')
}

async function emit(audit: ((event: AcpFileOperationAudit) => void | Promise<void>) | undefined, event: AcpFileOperationAudit): Promise<void> {
  if (audit !== undefined) await audit(event)
}

async function emitCompleted(
  options: AcpFileSystemOptions,
  event: AcpFileOperationAudit,
): Promise<void> {
  try {
    await emit(options.audit, event)
  } catch (error: unknown) {
    // A successful read/rename is a fact about the filesystem. Do not turn an
    // audit sink outage into a retriable ACP operation with the opposite meaning.
    try { await options.onAuditError?.(error, event) } catch { /* warning sinks are best effort */ }
  }
}

/** Native Agent Access file handlers. There is no workspace allow-list here by design. */
export function createAcpFileSystemHandlers(options: AcpFileSystemOptions): AcpFileSystemHandlers {
  const maxBytes = options.maxBytes ?? ACP_FS_MAX_BYTES
  const lifecycle = new AbortController()
  const signal = options.signal === undefined ? lifecycle.signal : AbortSignal.any([options.signal, lifecycle.signal])
  const timeoutMs = options.timeoutMs ?? ACP_FS_DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('ACP fs: timeoutMs must be positive')
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('ACP fs: maxBytes must be positive')
  const writeFile = options.io?.writeFile ?? fs.promises.writeFile
  const rename = options.io?.rename ?? fs.promises.rename
  const readTextFile = async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = AbortSignal.any([signal, timeoutSignal])
    const auditPath = typeof params.path === 'string' ? params.path : String(params.path)
    let target = auditPath
    let handle: fs.promises.FileHandle | undefined
    let bytes = Buffer.alloc(0)
    try {
      target = assertPath(params.path)
      assertNotAborted(requestSignal)
      if (options.io?.beforeRead !== undefined) await abortable(options.io.beforeRead(), requestSignal)
      handle = await abortable(fs.promises.open(target, 'r'), requestSignal)
      const stat = await abortable(handle.stat(), requestSignal)
      if (!stat.isFile()) throw new Error('target is not a regular file')
      if (stat.size > maxBytes) throw new Error(`file exceeds ${String(maxBytes)} bytes`)
      bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const read = await abortable(handle.read(bytes, offset, bytes.length - offset, offset), requestSignal)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      if (offset !== bytes.length) bytes = bytes.subarray(0, offset)
    } catch (error: unknown) {
      await emitRead(options, params, { operation: 'read', path: target, bytes: 0, beforeHash: null, afterHash: null, outcome: requestSignal.aborted ? abortOutcome(requestSignal, timeoutSignal) : 'error', acpSessionId: params.sessionId, profileId: options.profileId, reason: readFailureReason(error, requestSignal, timeoutSignal) })
      throw new Error(`ACP fs/read_text_file failed for ${target}: ${error instanceof Error ? error.message : String(error)}`)
    } finally { await handle?.close().catch(() => {}) }
    const beforeHash = hash(bytes)
    let content: string
    try { content = decode(bytes) } catch {
      await emitRead(options, params, { operation: 'read', path: target, bytes: bytes.byteLength, beforeHash, afterHash: null, outcome: 'error', acpSessionId: params.sessionId, profileId: options.profileId, reason: 'invalid-utf8' })
      throw new Error(`ACP fs/read_text_file refused ${target}: content is not valid UTF-8`)
    }
    try {
      const lines = content.split('\n')
      if (lines.length > ACP_FS_MAX_LINES || lines.some((row) => row.length > ACP_FS_MAX_LINE)) {
        throw new Error('line limits exceeded')
      }
      const result = checkReadWindow(content, params.line, params.limit)
      await emitRead(options, params, { operation: 'read', path: target, bytes: Buffer.byteLength(result), beforeHash, afterHash: beforeHash, outcome: 'ok', acpSessionId: params.sessionId, profileId: options.profileId }, true)
      return { content: result }
    } catch (error: unknown) {
      await emitRead(options, params, { operation: 'read', path: target, bytes: bytes.byteLength, beforeHash, afterHash: null, outcome: requestSignal.aborted ? abortOutcome(requestSignal, timeoutSignal) : 'error', acpSessionId: params.sessionId, profileId: options.profileId, reason: readFailureReason(error, requestSignal, timeoutSignal) })
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ACP fs/read_text_file refused ${target}: ${message}`)
    }
  }

  const writeTextFile = async (params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = AbortSignal.any([signal, timeoutSignal])
    const auditPath = typeof params.path === 'string' ? params.path : String(params.path)
    let target = auditPath
    let bytes = new Uint8Array(0)
    try {
      target = assertPath(params.path)
      assertNotAborted(requestSignal)
      if (options.io?.beforeWrite !== undefined) await abortable(options.io.beforeWrite(), requestSignal)
      if (typeof params.content !== 'string' || params.content.length > maxBytes) throw new Error(`content exceeds ${String(maxBytes)} bytes`)
      bytes = new TextEncoder().encode(params.content)
      if (bytes.byteLength > maxBytes) throw new Error(`UTF-8 content exceeds ${String(maxBytes)} bytes`)
    } catch (error: unknown) {
      await emit(options.audit, { operation: 'write', path: target, bytes: bytes.byteLength, beforeHash: null, afterHash: null, outcome: requestSignal.aborted ? abortOutcome(requestSignal, timeoutSignal) : 'error', acpSessionId: params.sessionId, profileId: options.profileId })
      throw new Error(`ACP fs/write_text_file refused ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parent = path.dirname(target)
    let mode = 0o600
    let before: Buffer | undefined
    try {
      const stat = await fs.promises.lstat(target)
      if (stat.isSymbolicLink()) throw new Error('symlink targets are not replaceable')
      if (!stat.isFile()) throw new Error('target is not a regular file')
      mode = stat.mode & 0o7777
      before = await abortable(fs.promises.readFile(target), requestSignal)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await emit(options.audit, { operation: 'write', path: target, bytes: bytes.byteLength, beforeHash: before === undefined ? null : hash(before), afterHash: null, outcome: 'error', acpSessionId: params.sessionId, profileId: options.profileId })
        throw new Error(`ACP fs/write_text_file failed for ${target}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const beforeHash = before === undefined ? null : hash(before)
    const temp = path.join(parent, `.dsh-acp-${path.basename(target)}-${randomUUID()}.tmp`)
    try {
      await abortable(writeFile(temp, bytes, { flag: 'wx', mode }), requestSignal)
      await abortable(fs.promises.chmod(temp, mode), requestSignal)
      if (before !== undefined) {
        const current = await abortable(fs.promises.readFile(target), requestSignal)
        if (hash(current) !== beforeHash) throw new Error('concurrent file change')
      }
      assertNotAborted(requestSignal)
      await abortable(rename(temp, target), requestSignal)
      await emitCompleted(options, { operation: 'write', path: target, bytes: bytes.byteLength, beforeHash, afterHash: hash(bytes), outcome: 'ok', acpSessionId: params.sessionId, profileId: options.profileId })
      return {}
    } catch (error: unknown) {
      await fs.promises.rm(temp, { force: true }).catch(() => {})
      const concurrent = error instanceof Error && error.message === 'concurrent file change'
      await emit(options.audit, { operation: 'write', path: target, bytes: bytes.byteLength, beforeHash, afterHash: null, outcome: requestSignal.aborted ? abortOutcome(requestSignal, timeoutSignal) : concurrent ? 'concurrent-change' : 'error', acpSessionId: params.sessionId, profileId: options.profileId })
      throw new Error(`ACP fs/write_text_file failed for ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { readTextFile, writeTextFile, dispose: () => lifecycle.abort() }
}
