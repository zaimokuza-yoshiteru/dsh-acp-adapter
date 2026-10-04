export type DevinLiveFinalResult = 'pass' | 'fail'

export type DevinLiveSettlementFailure =
  'LIVE_EXIT_CODE_NONZERO_DURING_CLEANUP' | 'LIVE_BUDGET_VIOLATION_DURING_CLEANUP' | 'LIVE_TURN_FAILURES_PRESENT'

/** Fail closed after cleanup; a previously recorded failure can never become a pass. */
export function settleDevinLiveResult(input: {
  readonly currentResult: DevinLiveFinalResult
  readonly exitCode: number | string | null | undefined
  readonly budgetViolation: string | undefined
  readonly turnFailureCount: number
}): DevinLiveSettlementFailure | undefined {
  if (input.currentResult === 'fail') return undefined
  if (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0)
    return 'LIVE_EXIT_CODE_NONZERO_DURING_CLEANUP'
  if (input.budgetViolation !== undefined) return 'LIVE_BUDGET_VIOLATION_DURING_CLEANUP'
  if (input.turnFailureCount > 0) return 'LIVE_TURN_FAILURES_PRESENT'
  return undefined
}
