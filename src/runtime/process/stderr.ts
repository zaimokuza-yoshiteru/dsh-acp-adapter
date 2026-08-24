/**
 * stderr 环形缓冲与脱敏（自 acp-client.ts 切出）：行数与总字节双上限；
 * 写入即脱敏，原文不进内存。纯字符串处理，零 import。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/stderr
 */

export const DEFAULT_STDERR_MAX_LINES = 200
export const DEFAULT_STDERR_MAX_BYTES = 64 * 1024

/**
 * 默认 stderr 脱敏：滤常见 token 形状——JWT、GitHub 系令牌、`sk-` 系 API key、
 * Bearer 头、`api_key/token/secret/password=value` 形键值对。
 */
export function defaultRedactStderrLine(line: string): string {
  return line
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<redacted-jwt>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/g, '<redacted-token>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted-token>')
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(
      /\b(api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd|credential)([ \t]*[=:][ \t]*["']?)[A-Za-z0-9._~+/=-]{4,}/gi,
      '$1$2<redacted>',
    )
}

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
