/** Convert bounded sidecar facts into the client-facing ACP audit row. */
import type { AcpAuditSummaryCode } from '../../remote/service.ts'
import { redactSecretText } from '../../domain/policy/events.ts'
import type { AcpSidecarEntry } from '../../persistence/sidecar.ts'

function boundedAuditSubject(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = redactSecretText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (clean === '') return null
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean
}

/** Sidecar record → structured, locale-neutral audit row. */
export function auditTimelineRowOf(entry: AcpSidecarEntry): {
  readonly seq: number
  readonly time: number
  readonly kind: string
  readonly category: 'recovery' | 'permission' | 'agent' | 'files'
  readonly summaryCode: AcpAuditSummaryCode
  readonly subject: string | null
  readonly status: string | null
  readonly detail: string | null
} {
  const data = entry.data as unknown as Record<string, unknown>
  const category = entry.kind === 'reconciliation' || entry.kind === 'replay-assessment' || entry.kind === 'degradation' ? 'recovery'
    : entry.kind === 'permission' ? 'permission'
      : entry.kind === 'filesystem' || entry.kind === 'terminal' ? 'files'
        : 'agent'
  let summaryCode: AcpAuditSummaryCode = 'agent.event'
  let subject: string | null = null
  let status: string | null = null
  switch (entry.kind) {
    case 'binding':
      summaryCode = 'binding.established'
      subject = boundedAuditSubject(data['profileId'] ?? data['provider'] ?? data['agentSessionId'])
      break
    case 'permission': {
      summaryCode = data['phase'] === 'asked' ? 'permission.asked' : 'permission.decided'
      if (data['phase'] === 'asked') {
        const toolCall = data['toolCall'] as Record<string, unknown> | undefined
        subject = boundedAuditSubject(toolCall?.['title'] ?? toolCall?.['kind'] ?? data['toolCallId'])
      } else subject = boundedAuditSubject(data['toolCallId'])
      status = boundedAuditSubject(data['phase'] === 'decided' ? data['outcome'] : undefined)
      break
    }
    case 'reconciliation':
      summaryCode = 'reconciliation.required'
      subject = boundedAuditSubject(data['cause'])
      break
    case 'replay-assessment':
      if (data['status'] === 'matched' || data['status'] === 'different' || data['status'] === 'overflow'
        || data['status'] === 'not-compared' || data['status'] === 'unavailable') {
        summaryCode = `replay.${data['status']}` as AcpAuditSummaryCode
      } else summaryCode = 'replay.unavailable'
      break
    case 'degradation':
      summaryCode = 'degradation.recorded'
      subject = boundedAuditSubject(data['code'] ?? data['itemCount'])
      break
    case 'session-fork':
      summaryCode = 'session-fork.completed'
      subject = boundedAuditSubject(data['outcome'])
      status = data['reason'] === data['outcome'] ? null : boundedAuditSubject(data['reason'])
      break
    case 'filesystem':
      summaryCode = 'filesystem.operation'
      subject = boundedAuditSubject(data['path'])
      status = boundedAuditSubject(data['outcome'])
      break
    case 'terminal':
      summaryCode = 'terminal.operation'
      subject = boundedAuditSubject(data['command'] ?? data['terminalId'])
      status = boundedAuditSubject(data['outcome'])
      break
  }
  const raw = JSON.stringify(entry.data, null, 2)
  const detail = raw === undefined ? null : redactSecretText(raw).slice(0, 4_000)
  return { seq: entry.seq, time: entry.time, kind: entry.kind, category, summaryCode, subject, status, detail }
}
