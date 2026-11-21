/** Shared, dependency-free redaction for process diagnostics and ACP activity detail. */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const GITHUB = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/g
const OPENAI = /\bsk-[A-Za-z0-9_-]{16,}/g
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi
const BASIC = /\bBasic[ \t]+[A-Za-z0-9+/=]{4,}/gi
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const SLACK = /\bxox[bparsce]-[A-Za-z0-9-]{16,}\b/g
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g
const GOOGLE_CLIENT_SECRET = /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g
const PEM_PRIVATE_KEY = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const COOKIE_HEADER_LINE = /^([ \t]*(?:set-)?cookie[ \t]*:)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gim
// Preserve the rest of the command or serialized request, including its destination.
const QUOTED_COOKIE_HEADER = /(?<!\\)(["'])((?:set-)?cookie[ \t]*:)(?:\\[^\r\n]|(?!\1)[^\\\r\n])*(\1|$)/gim
const ESCAPED_COOKIE_HEADER = /(\\["'])((?:set-)?cookie[ \t]*:)[^\r\n]*?(\1|$)/gim
const JSON_COOKIE_HEADER = /("(?:set-)?cookie"\s*:\s*)"(?:\\[\s\S]|[^"\\])*"/gi
const NUMERIC_USAGE_FIELDS = new Set([
  'inputtokens',
  'outputtokens',
  'totaltokens',
  'cachereadtokens',
  'cachewritetokens',
])
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i
// A preceding label such as "Agent error:" must not consume the following key/value pair.
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`\b((?=[a-z])[a-z0-9_-]*${SENSITIVE_FIELD.source}[a-z0-9_-]*)\b(["']?\s*[=:]\s*["']?)([^\s"',}{\[]+)`,
  'gi',
)

/** These exact structured counters are public usage metadata, not credentials. */
function isSafeNumericUsageField(key: string, value: unknown): boolean {
  return (
    NUMERIC_USAGE_FIELDS.has(key.toLowerCase()) &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function isCookieHeaderName(value: unknown): boolean {
  return typeof value === 'string' && /^(?:set-)?cookie$/i.test(value.trim())
}

/** Also accept native header tuples and { name, value } entries when the caller has the parent. */
export function isSensitiveActivityField(key: string, value: unknown, parent?: unknown): boolean {
  if (isSafeNumericUsageField(key, value)) return false
  if (SENSITIVE_FIELD.test(key)) return true
  if (Array.isArray(parent)) return Number(key) % 2 === 1 && isCookieHeaderName(parent[Number(key) - 1])
  if (key !== 'value' || !parent || typeof parent !== 'object') return false
  return ('name' in parent && isCookieHeaderName(parent.name)) || ('key' in parent && isCookieHeaderName(parent.key))
}

export function redactSecretText(value: string): string {
  return value
    .replace(JSON_COOKIE_HEADER, '$1"<redacted>"')
    .replace(ESCAPED_COOKIE_HEADER, '$1$2 <redacted>$3')
    .replace(QUOTED_COOKIE_HEADER, '$1$2 <redacted>$3')
    .replace(COOKIE_HEADER_LINE, '$1 <redacted>')
    .replace(JWT, '<redacted-jwt>')
    .replace(GITHUB, '<redacted-token>')
    .replace(OPENAI, '<redacted-token>')
    .replace(AWS_ACCESS_KEY_ID, '<redacted-aws-key>')
    .replace(SLACK, '<redacted-slack-token>')
    .replace(GOOGLE_API_KEY, '<redacted-google-key>')
    .replace(GOOGLE_CLIENT_SECRET, '<redacted-google-secret>')
    .replace(PEM_PRIVATE_KEY, '<redacted-private-key>')
    .replace(BEARER, 'Bearer <redacted>')
    .replace(BASIC, 'Basic <redacted>')
    .replace(SENSITIVE_ASSIGNMENT, (match, key: string, separator: string, secret: string) => {
      if (secret === '<redacted>\\') return match
      if (NUMERIC_USAGE_FIELDS.has(key.toLowerCase()) && /^\d+$/.test(secret)) return match
      return `${key}${separator}<redacted>`
    })
}
