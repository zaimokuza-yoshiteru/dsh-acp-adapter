// Only diagnostic identifiers belong here. Callers keep prompt text and credentials out of log fields.
const fieldOrder = ['dshSessionId', 'acpProvider', 'operation', 'result'] as const
export type AcpLogFields = Readonly<Partial<Record<(typeof fieldOrder)[number], string>>>

function formatAcpLogFields(fields?: AcpLogFields): string {
  if (fields === undefined) return ''
  const parts: string[] = []
  for (const key of fieldOrder) {
    const value = fields[key]
    if (value !== undefined) parts.push(`${key}=${value.replace(/[\r\n\t]+/g, ' ').trim()}`)
  }
  return parts.length === 0 ? '' : ` [${parts.join(' ')}]`
}

interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: unknown): void
}

export function createAcpLogger(sink: LogSink) {
  return {
    info(message: string, fields?: AcpLogFields): void {
      sink.info(message + formatAcpLogFields(fields))
    },
    warn(message: string, fields?: AcpLogFields): void {
      sink.warn(message + formatAcpLogFields(fields))
    },
    error(message: unknown, fields?: AcpLogFields): void {
      sink.error(typeof message === 'string' ? message + formatAcpLogFields(fields) : message)
    },
  }
}
