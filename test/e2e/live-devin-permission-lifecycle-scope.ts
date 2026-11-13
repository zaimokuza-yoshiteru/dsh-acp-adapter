import type {
  AcpPermissionAskedAuditData,
  AcpPermissionCheckAuditData,
  AcpPermissionDecidedAuditData,
} from '../../src/domain/policy/events.ts'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'
import { exactOnceOption, intactPermissionInput, isKnownDevinManualTitleRequest } from './live-devin-team-scope.ts'

export type DevinPermissionPhase = 'allow' | 'reject' | 'stop'
export type MarkerWrite = { readonly file_path: string; readonly content: string }

/** One exact temporary-file operation, preserving the original CLI choices and identity evidence. */
export function validateDevinMarkerPermission(input: {
  asked: AcpPermissionAskedAuditData
  bridge: AcpPermissionCheckAuditData
  detail?: string | undefined
  expected: MarkerWrite
  cliVersion: string
}) {
  const { asked, bridge, expected, cliVersion } = input
  if (
    bridge.agentSessionId !== asked.agentSessionId ||
    bridge.toolCallId !== asked.toolCall.toolCallId ||
    bridge.toolName !== 'write' ||
    bridge.reason !== 'approval-required'
  )
    throw new Error('LIVE_DEVIN_PERMISSION_IDENTITY_MISMATCH')
  const identity =
    bridge.structuredIdentityPresent === true && bridge.identitySource === 'devin-meta'
      ? 'devin-meta'
      : isKnownDevinManualTitleRequest(cliVersion, asked, bridge)
        ? 'known-cli-manual'
        : undefined
  if (identity === undefined) throw new Error('LIVE_DEVIN_PERMISSION_IDENTITY_UNPROVEN')
  const original = intactPermissionInput(asked.toolCall.rawInputSummary, asked.toolCall.rawInputHash, input.detail)
  if (summarizeRawInputForAudit(original).hash !== summarizeRawInputForAudit(expected).hash)
    throw new Error('LIVE_DEVIN_PERMISSION_OPERATION_MISMATCH')
  if (asked.optionCount !== asked.options.length || (asked.omittedOptionCount ?? 0) !== 0)
    throw new Error('LIVE_DEVIN_PERMISSION_OPTIONS_INCOMPLETE')
  const allow = exactOnceOption(asked.options)
  const reject = asked.options.filter((option) => option.kind === 'reject_once')
  if (reject.length !== 1) throw new Error('LIVE_DEVIN_PERMISSION_REJECT_AMBIGUOUS')
  return { identity, allow, reject: reject[0]!, original }
}

/** Reject is an original option selection; Stop cancels the outstanding request without selecting any option. */
export function assertDevinMarkerDecision(
  asked: AcpPermissionAskedAuditData,
  decided: AcpPermissionDecidedAuditData,
  phase: DevinPermissionPhase,
): void {
  if (
    decided.requestId !== asked.requestId ||
    decided.agentSessionId !== asked.agentSessionId ||
    decided.toolCallId !== asked.toolCall.toolCallId ||
    decided.decisionVia !== 'native-question'
  )
    throw new Error('LIVE_DEVIN_PERMISSION_DECISION_IDENTITY_CHANGED')
  if (phase === 'stop') {
    if (decided.outcome !== 'cancelled' || decided.optionId !== undefined || decided.selectedOptionKind !== undefined)
      throw new Error('LIVE_DEVIN_PERMISSION_STOP_SELECTED_OPTION')
    return
  }
  const kind = phase === 'allow' ? 'allow_once' : 'reject_once'
  const options = asked.options.filter((option) => option.kind === kind)
  if (
    options.length !== 1 ||
    decided.outcome !== 'selected' ||
    decided.selectedOptionKind !== kind ||
    decided.optionId !== options[0]?.optionId
  )
    throw new Error('LIVE_DEVIN_PERMISSION_WRONG_DECISION')
}
