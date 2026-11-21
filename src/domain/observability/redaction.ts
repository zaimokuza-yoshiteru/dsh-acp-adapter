import { createSensitiveFieldMatcher, redactSecretText } from '../../contract/redaction.ts'

export { createSensitiveFieldMatcher, isSensitiveActivityField, redactSecretText } from '../../contract/redaction.ts'

/** Redact an activity's structured payload before it is flattened or clipped for display. */
export function redactActivityValue(input: unknown, maxStringChars = Infinity): unknown {
  const sensitive = createSensitiveFieldMatcher()
  function redact(value: unknown, depth: number): unknown {
    if (depth > 5) return '[nested value omitted]'
    if (typeof value === 'string') {
      const text = redactSecretText(value)
      return text.length > maxStringChars ? `${text.slice(0, maxStringChars)}… [truncated]` : text
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 64)
        .map((item, i) => (sensitive(String(i), item, value) ? '[redacted]' : redact(item, depth + 1)))
    }
    if (value === null || typeof value !== 'object') return value
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (redactSecretText(key) !== key) continue
      result[key] = sensitive(key, item, value) ? '[redacted]' : redact(item, depth + 1)
    }
    return result
  }
  return redact(input, 0)
}
