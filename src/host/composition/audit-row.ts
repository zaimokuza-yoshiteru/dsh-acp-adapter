/** Convert bounded sidecar facts into the client-facing ACP audit row. */
import type { AcpAuditSummaryCode } from '../../remote/service.ts'
import { redactSecretText } from '../../domain/policy/events.ts'
import type { AcpSidecarEntry } from '../../persistence/sidecar.ts'
import type { AcpAuditTimelineEntry } from '../../contract/remote.ts'

function boundedAuditSubject(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = redactSecretText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (clean === '') return null
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean
}

/** Sidecar record → structured, locale-neutral audit row. */
export function auditTimelineRowOf(entry: AcpSidecarEntry): AcpAuditTimelineEntry {
  const data = entry.data as unknown as Record<string, unknown>
  const category = entry.kind === 'reconciliation' || entry.kind === 'replay-assessment' || entry.kind === 'degradation' ? 'recovery'
    : entry.kind === 'permission' ? 'permission'
      : entry.kind === 'filesystem' || entry.kind === 'terminal' ? 'files'
        : 'agent'
  let summaryCode: AcpAuditSummaryCode = 'agent.event'
  let subject: string | null = null
  let status: string | null = null
  let severity: AcpAuditTimelineEntry['severity'] = 'info'
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
      if (status === 'selected') {
        const option = data['selectedOptionKind']
        if (option === 'allow_once' || option === 'allow_always' || option === 'reject_once' || option === 'reject_always') status = option
      }
      if (['question-service-unavailable', 'agent-unavailable', 'custom-option-unsupported', 'invalid-option-id', 'question-error'].includes(String(data['note']))) severity = 'warning'
      break
    }
    case 'reconciliation':
      severity = 'warning'
      summaryCode = 'reconciliation.required'
      subject = boundedAuditSubject(data['cause'])
      break
    case 'replay-assessment':
      if (data['status'] === 'different' || data['status'] === 'overflow') severity = 'warning'
      if (data['status'] === 'matched' || data['status'] === 'different' || data['status'] === 'overflow'
        || data['status'] === 'not-compared' || data['status'] === 'unavailable') {
        summaryCode = `replay.${data['status']}` as AcpAuditSummaryCode
      } else summaryCode = 'replay.unavailable'
      break
    case 'degradation':
      severity = 'warning'
      summaryCode = 'degradation.recorded'
      // Human wording belongs in locale; retain technical codes in details.
      break
    case 'session-fork':
      if (data['outcome'] === 'blank') severity = 'warning'
      summaryCode = 'session-fork.completed'
      subject = boundedAuditSubject(data['outcome'])
      status = data['reason'] === data['outcome'] ? null : boundedAuditSubject(data['reason'])
      break
    case 'filesystem':
      summaryCode = data['operation'] === 'read' ? 'filesystem.read' : data['operation'] === 'write' ? 'filesystem.write' : 'filesystem.operation'
      subject = boundedAuditSubject(data['path'])
      status = boundedAuditSubject(data['outcome'])
      if (['error', 'timeout', 'concurrent-change'].includes(String(data['outcome']))) severity = 'error'
      break
    case 'terminal':
      summaryCode = 'terminal.operation'
      subject = boundedAuditSubject(data['command'] ?? data['terminalId'])
      // Reading the final output commonly follows the process exit in the same
      // millisecond.  Showing both rows as merely “Exited” makes one lifecycle
      // look duplicated even though the second fact is an ACP output read.
      status = boundedAuditSubject(data['operation'] === 'output-summary' ? 'output-summary' : data['outcome'])
      if (data['operation'] === 'kill') status = 'stop-requested'
      if (data['outcome'] === 'error' || data['outcome'] === 'timeout') severity = 'error'
      if (data['operation'] === 'exit' && data['terminationRequested'] !== true
        && ((typeof data['exitCode'] === 'number' && data['exitCode'] !== 0)
          || (typeof data['signal'] === 'string' && data['signal'] !== ''))) {
        // Legacy rows did not record cancellation intent. Keep the exit fact
        // visible without claiming an intentional stop was a process failure.
        severity = data['terminationRequested'] === false ? 'error' : 'warning'
        status = data['terminationRequested'] === false ? 'error' : 'exit-unverified'
      }
      break
  }
  const raw = JSON.stringify(entry.data, null, 2)
  const detail = raw === undefined ? null : redactSecretText(raw).slice(0, 4_000)
  return { seq: entry.seq, time: entry.time, kind: entry.kind, severity, category, summaryCode, subject, status, detail }
}
