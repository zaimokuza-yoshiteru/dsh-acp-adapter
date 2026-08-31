/** Shared, dependency-free redaction for process diagnostics and ACP activity detail. */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const GITHUB = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/g
const OPENAI = /\bsk-[A-Za-z0-9_-]{16,}/g
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi
const ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)[A-Za-z0-9_-]*)\b(\s*[=:]\s*["']?)[^\s"',}\]]+/gi

export function redactSecretText(value: string): string {
  return value
    .replace(JWT, '<redacted-jwt>')
    .replace(GITHUB, '<redacted-token>')
    .replace(OPENAI, '<redacted-token>')
    .replace(BEARER, 'Bearer <redacted>')
    .replace(ASSIGNMENT, '$1$2<redacted>')
}
