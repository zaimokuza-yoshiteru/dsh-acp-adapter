/**
 * stderr 环形缓冲与脱敏（自 acp-client.ts 切出）：行数与总字节双上限；
 * 写入即脱敏，原文不进内存。
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

/** stderr 环形缓冲：行数与总字节双上限；写入即脱敏，原文不进内存。 */
export class StderrRing {
  private lines: string[] = []
  private bytes = 0

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
    private readonly redact: (line: string) => string,
  ) {}

  push(rawLine: string): void {
    let line = this.redact(rawLine)
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
