/**
 * stderr 环形缓冲与脱敏（自 acp-client.ts 切出）：行数与总字节双上限；
 * 写入缓冲前脱敏，不在缓冲中保留敏感原文。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/stderr
 */

export const DEFAULT_STDERR_MAX_LINES = 200
export const DEFAULT_STDERR_MAX_BYTES = 64 * 1024

/**
 * 默认 stderr 脱敏：滤常见 token 形状——JWT、GitHub 系令牌、`sk-` 系 API key、
 * Bearer 头、`api_key/token/secret/password=value` 形键值对。
 */
import { redactSecretText } from '../../domain/observability/redaction.ts'

export const defaultRedactStderrLine = redactSecretText

/** stderr 环形缓冲：行数与总字节双上限；敏感内容不会进入缓冲。 */
export class StderrRing {
  private lines: string[] = []
  private bytes = 0
  private privateKeyEndMarker: string | undefined

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
    private readonly redact: (line: string) => string,
  ) {}

  push(rawLine: string): void {
    // The shared redactor removes complete PEM blocks in one pass. Keep this
    // state for key blocks split across pushes.
    const inputLines = this.redact(rawLine).split(/\r?\n/u)
    if (rawLine.endsWith('\n')) inputLines.pop()
    for (const inputLine of inputLines) this.pushRedactedLine(inputLine)
  }

  private pushRedactedLine(redactedLine: string): void {
    let line = redactedLine
    if (this.privateKeyEndMarker !== undefined) {
      const end = line.indexOf(this.privateKeyEndMarker)
      if (end === -1) return
      line = line.slice(end + this.privateKeyEndMarker.length)
      this.privateKeyEndMarker = undefined
      if (line.length === 0) return
    }

    const begin = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/u.exec(line)
    if (begin !== null) {
      const beginAt = begin.index ?? 0
      const endMarker = `-----END ${begin[1]}-----`
      const bodyAt = beginAt + begin[0].length
      if (line.indexOf(endMarker, bodyAt) === -1) this.privateKeyEndMarker = endMarker
      this.store('<redacted-private-key>')
      return
    }

    this.store(line)
  }

  private store(line: string): void {
    if (line.length > this.maxBytes) line = line.slice(line.length - this.maxBytes)
    this.lines.push(line)
    this.bytes += line.length + 1
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const dropped = this.lines.shift()
      if (dropped === undefined) break
      this.bytes -= dropped.length + 1
    }
  }

  snapshot(): string[] {
    return [...this.lines]
  }
}
