import { expect, it } from 'vitest'
import { settleDevinLiveResult } from '../../../scripts/devin-live-result.ts'

const passingCleanup = {
  currentResult: 'pass' as const,
  exitCode: 0,
  budgetViolation: undefined,
  turnFailureCount: 0,
}

it('fails settlement when a late budget violation arrives during cleanup', () => {
  expect(settleDevinLiveResult({ ...passingCleanup, budgetViolation: 'LIVE_TOTAL_TOOL_BUDGET_EXCEEDED' })).toBe(
    'LIVE_BUDGET_VIOLATION_DURING_CLEANUP',
  )
})

it('fails settlement when a late turn failure arrives during cleanup', () => {
  expect(settleDevinLiveResult({ ...passingCleanup, turnFailureCount: 1 })).toBe('LIVE_TURN_FAILURES_PRESENT')
})

it('passes only when cleanup remains clean', () => {
  expect(settleDevinLiveResult(passingCleanup)).toBeUndefined()
  expect(settleDevinLiveResult({ ...passingCleanup, exitCode: 2 })).toBe('LIVE_EXIT_CODE_NONZERO_DURING_CLEANUP')
})

it('keeps any existing failure state irreversible during settlement', () => {
  expect(
    settleDevinLiveResult({
      currentResult: 'fail',
      exitCode: 1,
      budgetViolation: 'LIVE_TOTAL_TOOL_BUDGET_EXCEEDED',
      turnFailureCount: 1,
    }),
  ).toBeUndefined()
})
