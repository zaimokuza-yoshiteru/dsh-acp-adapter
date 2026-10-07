import { expect, it } from 'vitest'
import {
  classifyExecutionRoute,
  createNativeExecuteObserver,
  nativeExecuteCommand,
} from '../../e2e/live-long-task-native-execute.ts'
import { wrapObservedCallback } from '../../e2e/live-long-task-native-read.ts'
import type { ExecuteRegistration } from '../../e2e/live-long-task-native-execute.ts'

const lead = 'dsh-lead-session'
const acp = 'acp-runtime-session'
const allowedCommand = "printf '%s' 'lead-allow-run-id' >> '/tmp/workspace/lead-allow-run-id.txt'"
const registrations: ExecuteRegistration[] = [
  { scene: 'C', ownerDshSessionId: lead, operation: 'lead-allow', command: allowedCommand },
]
const hashIdentifier = (kind: string, value: string): string => `${kind}:h:${value.length}`

it('extracts only explicit command fields and rejects unknown input shapes', () => {
  expect(nativeExecuteCommand(allowedCommand)).toBe(allowedCommand)
  expect(nativeExecuteCommand({ command: allowedCommand })).toBe(allowedCommand)
  expect(nativeExecuteCommand({ cmd: allowedCommand })).toBe(allowedCommand)
  expect(nativeExecuteCommand({ argv: allowedCommand })).toBe(allowedCommand)
  expect(nativeExecuteCommand({ argv: ['printf', 'not parsed'] })).toBeUndefined()
  expect(nativeExecuteCommand({ command: '' })).toBeUndefined()
})

it('ties an exact owner-scoped execute request to same-session status and approval reason without storing command text', () => {
  const violations: string[] = []
  const observer = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  observer.observePermission(
    {
      sessionId: acp,
      toolCall: { kind: 'execute', toolCallId: 'call-1', rawInput: { command: allowedCommand } },
    },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  expect(
    observer.matchApproval({
      scene: 'C',
      ownerDshSessionId: lead,
      operation: 'lead-allow',
      reason: `execute approval\n${allowedCommand}`,
      cardText: `Allow command\n${allowedCommand}`,
    }),
  ).toMatchObject({ operation: 'lead-allow', status: 'pending', scene: 'C' })
  observer.observeUpdate(
    {
      sessionId: acp,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', kind: 'execute', status: 'completed' },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  observer.observeUpdate(
    {
      sessionId: 'other-session',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  const evidence = observer.evidence()
  expect(evidence).toMatchObject([{ operation: 'lead-allow', status: 'completed' }])
  expect(JSON.stringify(evidence)).not.toContain(allowedCommand)
  expect(violations).toEqual([])
})

it('marks unknown owners or commands and repeated operation requests before approval', () => {
  const violations: string[] = []
  const observer = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  const request = (sessionId: string, callId: string, command: string, owner: string) =>
    observer.observePermission(
      { sessionId, toolCall: { kind: 'execute', toolCallId: callId, rawInput: { cmd: command } } },
      { scene: 'C', ownerDshSessionId: owner, activeAcpSessionId: acp },
    )
  request(acp, 'unknown', 'echo unrelated', lead)
  request(acp, 'wrong-owner', allowedCommand, 'other-owner')
  request(acp, 'first', allowedCommand, lead)
  request(acp, 'repeated-operation', allowedCommand, lead)
  expect(violations).toEqual([
    'LONG_TASK_NATIVE_EXECUTE_UNREGISTERED',
    'LONG_TASK_NATIVE_EXECUTE_UNREGISTERED',
    'LONG_TASK_NATIVE_EXECUTE_DUPLICATE_REQUEST',
  ])
  expect(observer.evidence().filter((entry) => entry.status === 'pending')).toHaveLength(1)
  expect(observer.evidence().filter((entry) => entry.status === 'unexpected')).toHaveLength(3)
})

it('records native terminal status for the caller to validate against its decision', () => {
  for (const [status, expected] of [
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed'],
  ] as const) {
    const observer = createNativeExecuteObserver({
      registrations: () => registrations,
      hashIdentifier,
      onViolation: () => {},
    })
    observer.observePermission(
      { sessionId: acp, toolCall: { kind: 'execute', toolCallId: `call-${status}`, rawInput: allowedCommand } },
      { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
    )
    observer.observeUpdate(
      {
        sessionId: acp,
        update: { sessionUpdate: 'tool_call_update', toolCallId: `call-${status}`, kind: 'execute', status },
      },
      { scene: 'C', ownerDshSessionId: lead },
    )
    expect(observer.evidence()[0]?.status).toBe(expected)
  }
})

it('ignores child and historical permissions plus non-tool updates sharing a call ID', () => {
  const violations: string[] = []
  const observer = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  observer.observePermission(
    { sessionId: 'child-session', toolCall: { kind: 'execute', toolCallId: 'old', rawInput: allowedCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  observer.observePermission(
    { sessionId: 'historical-session', toolCall: { kind: 'execute', toolCallId: 'old', rawInput: allowedCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  observer.observePermission(
    { sessionId: acp, toolCall: { kind: 'execute', toolCallId: 'live', rawInput: allowedCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  observer.observeUpdate(
    { sessionId: acp, update: { sessionUpdate: 'agent_message', toolCallId: 'live', status: 'completed' } },
    { scene: 'C', ownerDshSessionId: lead },
  )
  expect(observer.evidence()).toMatchObject([{ callId: hashIdentifier('acp-tool-call', 'live'), status: 'pending' }])
  expect(violations).toEqual([])
})

it('keeps equal ACP call IDs isolated by DSH owner identity', () => {
  const member = 'dsh-member-session'
  const memberCommand = "printf '%s' 'member-allow-run-id' >> '/tmp/workspace/member-allow-run-id.txt'"
  const violations: string[] = []
  const observer = createNativeExecuteObserver({
    registrations: () => [
      ...registrations,
      { scene: 'C', ownerDshSessionId: member, operation: 'member-allow', command: memberCommand },
    ],
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  for (const [ownerDshSessionId, command] of [
    [lead, allowedCommand],
    [member, memberCommand],
  ] as const) {
    observer.observePermission(
      { sessionId: acp, toolCall: { kind: 'execute', toolCallId: 'same-call-id', rawInput: command } },
      { scene: 'C', ownerDshSessionId, activeAcpSessionId: acp },
    )
  }
  observer.observeUpdate(
    {
      sessionId: acp,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'same-call-id', kind: 'execute', status: 'completed' },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  expect(observer.evidence()).toMatchObject([
    { operation: 'lead-allow', status: 'completed' },
    { operation: 'member-allow', status: 'pending' },
  ])
  expect(violations).toEqual([])
})

it('rejects contradictory or explicitly errored completed updates', () => {
  const violations: string[] = []
  const observer = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  const request = (callId: string) =>
    observer.observePermission(
      { sessionId: acp, toolCall: { kind: 'execute', toolCallId: callId, rawInput: allowedCommand } },
      { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
    )
  request('error-call')
  observer.observeUpdate(
    {
      sessionId: acp,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'error-call', status: 'completed', isError: true },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  expect(observer.evidence()[0]?.status).toBe('unexpected')
  expect(violations).toContain('LONG_TASK_NATIVE_EXECUTE_COMPLETED_WITH_ERROR')

  const conflictObserver = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: (code) => violations.push(code),
  })
  conflictObserver.observePermission(
    { sessionId: acp, toolCall: { kind: 'execute', toolCallId: 'conflicting-call', rawInput: allowedCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  for (const status of ['failed', 'completed'] as const)
    conflictObserver.observeUpdate(
      {
        sessionId: acp,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'conflicting-call', status },
      },
      { scene: 'C', ownerDshSessionId: lead },
    )
  expect(conflictObserver.evidence()[0]?.status).toBe('unexpected')
  expect(violations).toContain('LONG_TASK_NATIVE_EXECUTE_STATUS_CONFLICT')
})

it('does not treat null or false error fields as execution failures', () => {
  for (const [index, error] of [null, false].entries()) {
    const observer = createNativeExecuteObserver({
      registrations: () => registrations,
      hashIdentifier,
      onViolation: () => {},
    })
    const callId = `non-error-${index}`
    observer.observePermission(
      { sessionId: acp, toolCall: { kind: 'execute', toolCallId: callId, rawInput: allowedCommand } },
      { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
    )
    observer.observeUpdate(
      {
        sessionId: acp,
        update: { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed', error },
      },
      { scene: 'C', ownerDshSessionId: lead },
    )
    expect(observer.evidence()[0]?.status).toBe('completed')
  }
})

it('classifies Devin permission carriers independently from the actual Host execution route', () => {
  const observer = createNativeExecuteObserver({
    registrations: () => registrations,
    hashIdentifier,
    onViolation: () => {},
  })
  observer.observePermission(
    { sessionId: acp, toolCall: { kind: 'execute', toolCallId: 'devin-allow-call', rawInput: allowedCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  observer.observeUpdate(
    {
      sessionId: acp,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'devin-allow-call',
        kind: 'execute',
        status: 'completed',
      },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  const acpPermissionEvidence = observer.evidence()
  expect(acpPermissionEvidence).toMatchObject([{ operation: 'lead-allow', status: 'completed' }])
  expect(
    classifyExecutionRoute({
      decision: 'allow',
      hostAdmissions: 1,
      hostResults: [{ isError: false }],
      nativeCalls: acpPermissionEvidence,
      fileExists: true,
      fileContents: 'lead-allow-run-id',
      expectedContents: 'lead-allow-run-id',
    }),
  ).toBe('host-tool')

  const rejectCommand = "printf '%s' 'lead-reject-run-id' >> '/tmp/workspace/lead-reject-run-id.txt'"
  const rejectObserver = createNativeExecuteObserver({
    registrations: () => [
      ...registrations,
      { scene: 'C', ownerDshSessionId: lead, operation: 'lead-reject', command: rejectCommand },
    ],
    hashIdentifier,
    onViolation: () => {},
  })
  rejectObserver.observePermission(
    { sessionId: acp, toolCall: { kind: 'execute', toolCallId: 'devin-reject-call', rawInput: rejectCommand } },
    { scene: 'C', ownerDshSessionId: lead, activeAcpSessionId: acp },
  )
  rejectObserver.observeUpdate(
    {
      sessionId: acp,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'devin-reject-call',
        kind: 'execute',
        status: 'failed',
      },
    },
    { scene: 'C', ownerDshSessionId: lead },
  )
  expect(
    classifyExecutionRoute({
      decision: 'reject',
      hostAdmissions: 0,
      hostResults: [],
      nativeCalls: rejectObserver.evidence(),
      fileExists: false,
      fileContents: undefined,
      expectedContents: 'lead-reject-run-id',
    }),
  ).toBe('not-dispatched')

  expect(
    classifyExecutionRoute({
      decision: 'allow',
      hostAdmissions: 1,
      hostResults: [{ isError: false }],
      nativeCalls: acpPermissionEvidence,
      fileExists: true,
      fileContents: 'lead-allow-run-idlead-allow-run-id',
      expectedContents: 'lead-allow-run-id',
    }),
  ).toBe('unknown')
})

it('preserves the native permission callback receiver and arguments and invokes it once if observation fails', () => {
  const context = { token: 'receiver' }
  const args = [{ toolCall: { kind: 'execute' } }, new AbortController().signal]
  let calls = 0
  let observedFailure = 0
  const original = function (this: unknown, ...actual: unknown[]) {
    calls += 1
    expect(this).toBe(context)
    expect(actual).toEqual(args)
    return 'native-result'
  }
  const wrapped = wrapObservedCallback(
    original,
    () => {
      throw new Error('observer failure')
    },
    () => {
      observedFailure += 1
    },
  )
  expect(wrapped.apply(context, args)).toBe('native-result')
  expect(calls).toBe(1)
  expect(observedFailure).toBe(1)
})
