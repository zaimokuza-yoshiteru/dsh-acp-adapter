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
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i
const NUMERIC_USAGE_FIELDS = new Set([
  'inputtokens',
  'outputtokens',
  'totaltokens',
  'cachereadtokens',
  'cachewritetokens',
])
const HEADER_FIELD_NAME = String.raw`(?!(?:${[...NUMERIC_USAGE_FIELDS].join('|')})[ \t]*:)[a-z0-9_.-]*${SENSITIVE_FIELD.source}[a-z0-9_.-]*`
const HEADER_LINE = new RegExp(String.raw`^([ \t]*${HEADER_FIELD_NAME}[ \t]*:)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*`, 'gim')
// Stop at the closing quote so the following shell arguments and destination remain visible.
const QUOTED_HEADER = new RegExp(
  String.raw`(?<!\\)(["'])(${HEADER_FIELD_NAME}[ \t]*:)(?:\\[^\r\n]|(?!\1)[^\\\r\n])*(\1|$)`,
  'gim',
)
const ESCAPED_HEADER = new RegExp(String.raw`(\\["'])(${HEADER_FIELD_NAME}[ \t]*:)[^\r\n]*?(\1|$)`, 'gim')
const JSON_HEADER = new RegExp(String.raw`("${HEADER_FIELD_NAME}"\s*:\s*)"(?:\\[\s\S]|[^"\\])*"`, 'gi')
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

// Only a field name can label a neighbouring value. URLs and command text may also contain "token" or "cookie".
function isSensitiveHeaderName(name: unknown, value: unknown): boolean {
  if (typeof name !== 'string') return false
  const field = name.trim()
  return (
    /^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(field) && SENSITIVE_FIELD.test(field) && !isSafeNumericUsageField(field, value)
  )
}

export function isSensitiveActivityField(key: string, value: unknown): boolean {
  return SENSITIVE_FIELD.test(key) && !isSafeNumericUsageField(key, value)
}

/** Track header collections during one JSON traversal. Positional arguments can include filenames like "secrets.md". */
export function createSensitiveFieldMatcher() {
  const headerArrays = new WeakSet<unknown[]>()
  return (key: string, value: unknown, parent: unknown): boolean => {
    const inHeaders = Array.isArray(parent) && headerArrays.has(parent)
    if (Array.isArray(value) && (inHeaders || /headers?$/i.test(key))) headerArrays.add(value)
    if (isSensitiveActivityField(key, value)) return true
    if (Array.isArray(parent)) {
      const name = parent[Number(key) - 1]
      if (Number(key) % 2 !== 1 || !isSensitiveHeaderName(name, value)) return false
      // Standalone pairs also occur without a containing "headers" property.
      return inHeaders || /^(?:(?:set-)?cookie|(?:proxy-)?authorization|api[_-]?key|x-[a-z0-9_-]+)$/i.test(name.trim())
    }
    if (key !== 'value' || !parent || typeof parent !== 'object') return false
    return (
      ('name' in parent && isSensitiveHeaderName(parent.name, value)) ||
      ('key' in parent && isSensitiveHeaderName(parent.key, value))
    )
  }
}

export function redactSecretText(value: string): string {
  return value
    .replace(JSON_HEADER, '$1"<redacted>"')
    .replace(ESCAPED_HEADER, '$1$2 <redacted>$3')
    .replace(QUOTED_HEADER, '$1$2 <redacted>$3')
    .replace(HEADER_LINE, '$1 <redacted>')
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
