export type RejectedCancellationExpectation = {
  readonly profile: 'codebuddy'
  readonly scene: 'C'
  readonly phase: string
  readonly operation: string
  readonly owner: string
  readonly acpSession: string
  readonly requestId: string
  readonly promptOrdinal: number
  readonly leaseId: string
  readonly turn: number
  readonly callId: string
}

export type RejectedCancellationFacts = {
  readonly profile: string
  readonly scene: string
  readonly phase: string
  readonly operation: string
  readonly owner: string
  readonly acpSession: string
  readonly requestId: string
  readonly decidedOutcome: string
  readonly promptOrdinal: number
  readonly leaseId: string
  readonly stopReason: string
  readonly promptSignalAbortedAtEnd: boolean
  readonly permissionCallId: string
  readonly permissionOutcome: string
  readonly permissionOptionKind: string
  readonly permissionResponses: number
  readonly permissionSignalAbortedAtReturn: boolean
  readonly nativeCalls: readonly { readonly callId: string; readonly status: string }[]
  readonly turn: number
  readonly turnReason: string
  readonly hostAdmissions: number
  readonly hostResults: number
  readonly fileExists: boolean
  readonly localStop: boolean
  readonly guardCancelled: boolean
}

/** Finds only the exact Lead-controls claim marker used by the posted prompts. */
export function leadControlClaimMarker(serializedMessage: string, runSuffix: string): string | undefined {
  if (!/^[a-f0-9]{8}$/u.test(runSuffix)) return undefined
  return serializedMessage.match(new RegExp(`LONGTASK_C_lead-(?:allow|reject)_${runSuffix}`, 'u'))?.[0]
}

/** Recognizes only the observed CodeBuddy Ask-reject cancellation handshake. */
export function confirmsRejectedCancellation(
  expected: RejectedCancellationExpectation,
  facts: RejectedCancellationFacts,
): boolean {
  return (
    expected.profile === 'codebuddy' &&
    expected.scene === 'C' &&
    expected.profile === facts.profile &&
    expected.scene === facts.scene &&
    expected.phase === facts.phase &&
    expected.operation === facts.operation &&
    expected.owner === facts.owner &&
    expected.acpSession === facts.acpSession &&
    expected.requestId === facts.requestId &&
    expected.promptOrdinal === facts.promptOrdinal &&
    expected.leaseId === facts.leaseId &&
    expected.callId === facts.permissionCallId &&
    facts.decidedOutcome === 'rejected' &&
    facts.stopReason === 'cancelled' &&
    !facts.promptSignalAbortedAtEnd &&
    facts.permissionOutcome === 'selected' &&
    facts.permissionOptionKind === 'reject_once' &&
    facts.permissionResponses === 1 &&
    !facts.permissionSignalAbortedAtReturn &&
    facts.nativeCalls.length === 1 &&
    facts.nativeCalls[0]?.callId === expected.callId &&
    ['pending', 'failed', 'cancelled'].includes(facts.nativeCalls[0]?.status ?? '') &&
    facts.turn === expected.turn &&
    facts.turnReason === 'aborted' &&
    facts.hostAdmissions === 0 &&
    facts.hostResults === 0 &&
    !facts.fileExists &&
    !facts.localStop &&
    !facts.guardCancelled
  )
}
