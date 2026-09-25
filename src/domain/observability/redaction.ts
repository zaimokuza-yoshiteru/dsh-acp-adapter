/** Shared, dependency-free redaction for process diagnostics and ACP activity detail. */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const GITHUB = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/g
const OPENAI = /\bsk-[A-Za-z0-9_-]{16,}/g
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const SLACK = /\bxox[bparsce]-[A-Za-z0-9-]{16,}\b/g
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g
const GOOGLE_CLIENT_SECRET = /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g
const PEM_PRIVATE_KEY = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]*)\b(\s*[=:]\s*["']?)([^\s"',}\]]+)/gi
const NUMERIC_USAGE_FIELDS = new Set(['inputtokens', 'outputtokens', 'totaltokens', 'cachereadtokens', 'cachewritetokens'])
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i

/** These exact structured counters are public usage metadata, not credentials. */
function isSafeNumericUsageField(key: string, value: unknown): boolean {
  return NUMERIC_USAGE_FIELDS.has(key.toLowerCase())
    && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Shared field policy for structured Activity payloads. */
export function isSensitiveActivityField(key: string, value: unknown): boolean {
  if (isSafeNumericUsageField(key, value)) return false
  return SENSITIVE_FIELD.test(key)
}

export function redactSecretText(value: string): string {
  return value
    .replace(JWT, '<redacted-jwt>')
    .replace(GITHUB, '<redacted-token>')
    .replace(OPENAI, '<redacted-token>')
    .replace(AWS_ACCESS_KEY_ID, '<redacted-aws-key>')
    .replace(SLACK, '<redacted-slack-token>')
    .replace(GOOGLE_API_KEY, '<redacted-google-key>')
    .replace(GOOGLE_CLIENT_SECRET, '<redacted-google-secret>')
    .replace(PEM_PRIVATE_KEY, '<redacted-private-key>')
    .replace(BEARER, 'Bearer <redacted>')
    .replace(ASSIGNMENT, (match, key: string, separator: string, secret: string) => {
      if (NUMERIC_USAGE_FIELDS.has(key.toLowerCase()) && /^\d+$/.test(secret)) return match
      return SENSITIVE_FIELD.test(key) ? `${key}${separator}<redacted>` : match
    })
}
