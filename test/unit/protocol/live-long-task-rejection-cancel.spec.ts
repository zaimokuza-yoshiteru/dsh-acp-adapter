import { expect, it } from 'vitest'
import {
  confirmsRejectedCancellation,
  leadControlClaimMarker,
  type RejectedCancellationExpectation,
  type RejectedCancellationFacts,
} from '../../e2e/live-long-task-rejection-cancel.ts'

const expected: RejectedCancellationExpectation = {
  profile: 'codebuddy',
  scene: 'C',
  phase: 'C:lead-reject',
  operation: 'lead-reject',
  owner: 'owner-hash',
  acpSession: 'acp-hash',
  requestId: 'request-hash',
  promptOrdinal: 7,
  leaseId: 'lease-hash',
  turn: 12,
  callId: 'call-hash',
}

const facts: RejectedCancellationFacts = {
  profile: 'codebuddy',
  scene: 'C',
  phase: 'C:lead-reject',
  operation: 'lead-reject',
  owner: 'owner-hash',
  acpSession: 'acp-hash',
  requestId: 'request-hash',
  decidedOutcome: 'rejected',
  promptOrdinal: 7,
  leaseId: 'lease-hash',
  stopReason: 'cancelled',
  promptSignalAbortedAtEnd: false,
  permissionCallId: 'call-hash',
  permissionOutcome: 'selected',
  permissionOptionKind: 'reject_once',
  permissionResponses: 1,
  permissionSignalAbortedAtReturn: false,
  nativeCalls: [{ callId: 'call-hash', status: 'pending' }],
  turn: 12,
  turnReason: 'aborted',
  hostAdmissions: 0,
  hostResults: 0,
  fileExists: false,
  localStop: false,
  guardCancelled: false,
}

it('matches the exact Lead control claim markers used by posted prompts', () => {
  const runSuffix = 'f1a3f5db'
  expect(leadControlClaimMarker(JSON.stringify({ text: 'LONGTASK_C_lead-allow_f1a3f5db' }), runSuffix)).toBe(
    'LONGTASK_C_lead-allow_f1a3f5db',
  )
  expect(leadControlClaimMarker(JSON.stringify({ text: 'LONGTASK_C_lead-reject_f1a3f5db' }), runSuffix)).toBe(
    'LONGTASK_C_lead-reject_f1a3f5db',
  )
  expect(leadControlClaimMarker('LONGTASK_C_lead-reject-f1a3f5db', runSuffix)).toBeUndefined()
  expect(leadControlClaimMarker('LONGTASK_C_lead-reject_f1a3f5dc', runSuffix)).toBeUndefined()
  expect(leadControlClaimMarker('LONGTASK_C_lead-allow_f1a3f5db', 'not-hex')).toBeUndefined()
  expect(leadControlClaimMarker('LONGTASK_C_member-reject_f1a3f5db', runSuffix)).toBeUndefined()
  expect(leadControlClaimMarker('LONGTASK_D_RUNNING_f1a3f5db', runSuffix)).toBeUndefined()
})

it('confirms only a fully correlated remote Ask-reject cancellation with no side effects', () => {
  expect(confirmsRejectedCancellation(expected, facts)).toBe(true)
})

it.each([
  ['wrong profile', { profile: 'devin' }],
  ['wrong scene', { scene: 'D' }],
  ['wrong owner', { owner: 'other-owner' }],
  ['wrong ACP session', { acpSession: 'other-acp' }],
  ['wrong phase', { phase: 'C:lead-allow' }],
  ['wrong request', { requestId: 'other-request' }],
  ['wrong prompt ordinal', { promptOrdinal: 8 }],
  ['wrong lease', { leaseId: 'other-lease' }],
  ['approval not rejected', { decidedOutcome: 'allowed-once' }],
  ['permission response missing selection', { permissionOutcome: 'cancelled' }],
  ['selected option was not reject once', { permissionOptionKind: 'allow_once' }],
  ['permission response is duplicated', { permissionResponses: 2 }],
  ['permission signal aborted', { permissionSignalAbortedAtReturn: true }],
  ['remote prompt did not cancel', { stopReason: 'end_turn' }],
  ['remote prompt end missing', { stopReason: 'unknown' }],
  ['prompt was locally aborted', { promptSignalAbortedAtEnd: true }],
  ['native call mismatch', { nativeCalls: [{ callId: 'other-call', status: 'pending' }] }],
  [
    'duplicate native calls',
    {
      nativeCalls: [
        { callId: 'call-hash', status: 'pending' },
        { callId: 'call-hash', status: 'pending' },
      ],
    },
  ],
  ['native call completed', { nativeCalls: [{ callId: 'call-hash', status: 'completed' }] }],
  ['wrong native turn', { turn: 13 }],
  ['turn completed instead of aborting', { turnReason: 'completed' }],
  ['host body ran', { hostAdmissions: 1 }],
  ['host result exists', { hostResults: 1 }],
  ['file side effect exists', { fileExists: true }],
  ['user Stop was involved', { localStop: true }],
  ['guard cancellation was involved', { guardCancelled: true }],
])('rejects an uncorrelated or unsafe cancellation: %s', (_label, update) => {
  expect(confirmsRejectedCancellation(expected, { ...facts, ...update })).toBe(false)
})
