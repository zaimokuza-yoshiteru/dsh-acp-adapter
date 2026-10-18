import { expect, it } from 'vitest'
import { isMemberApprovalCoordination, memberCoordinationArguments } from '../../e2e/live-long-task-coordination.ts'

const request = {
  scene: 'C',
  phase: 'C:member-allow',
  owner: 'lead-session',
  lead: 'lead-session',
  member: 'runtime-reader-session',
  toolName: 'wait_agent',
  args: memberCoordinationArguments('wait_agent', 'wait_agent\n{\n  "timeout_ms": 60000\n}'),
  relaySucceeded: true,
}

it('keeps missing approval reasons denied instead of granting an empty coordination request', () => {
  expect(memberCoordinationArguments('list_agents', undefined)).toBe(null)
  expect(
    isMemberApprovalCoordination({
      ...request,
      toolName: 'list_agents',
      args: memberCoordinationArguments('list_agents', undefined),
    }),
  ).toBe(false)
})

it('accepts the observed read-only wait after the exact member command was successfully relayed', () => {
  expect(isMemberApprovalCoordination(request)).toBe(true)
  expect(isMemberApprovalCoordination({ ...request, phase: 'C:member-reject', args: {} })).toBe(true)
})

it.each(['C:member-allow', 'C:member-reject'])(
  'allows the exact Lead to discover names before relaying, but not to wait before relaying: %s',
  (phase) => {
    expect(
      isMemberApprovalCoordination({ ...request, phase, toolName: 'list_agents', args: {}, relaySucceeded: false }),
    ).toBe(true)
    expect(
      isMemberApprovalCoordination({ ...request, phase, toolName: 'list_agents', args: {}, relaySucceeded: true }),
    ).toBe(true)
    expect(isMemberApprovalCoordination({ ...request, phase, relaySucceeded: false })).toBe(false)
  },
)

it.each(['C:member-allow', 'C:member-reject'])(
  'allows only the current member to discover names after its exact command was relayed: %s',
  (phase) => {
    const memberRequest = {
      ...request,
      phase,
      owner: request.member,
      toolName: 'list_agents',
      args: memberCoordinationArguments('list_agents', 'list_agents\n{}'),
    }
    expect(isMemberApprovalCoordination(memberRequest)).toBe(true)
    expect(isMemberApprovalCoordination({ ...memberRequest, relaySucceeded: false })).toBe(false)
    expect(isMemberApprovalCoordination({ ...memberRequest, toolName: 'wait_agent', args: {} })).toBe(false)
    expect(
      isMemberApprovalCoordination({
        ...memberRequest,
        args: memberCoordinationArguments('list_agents', undefined),
      }),
    ).toBe(false)
  },
)

it.each([
  { member: undefined },
  { member: 'another-member-session' },
  { owner: 'another-member-session' },
  { lead: undefined },
  { scene: 'B' },
  { phase: 'C:lead-allow' },
  { phase: 'C:lead-reject' },
  { args: { timeout_ms: 60000 } },
  { args: { command: 'write marker' } },
  { args: [] },
  { args: null },
])('keeps post-relay member discovery within the exact current actor, phase and empty arguments: %j', (change) => {
  expect(
    isMemberApprovalCoordination({
      ...request,
      owner: request.member,
      toolName: 'list_agents',
      args: {},
      ...change,
    }),
  ).toBe(false)
})

it.each([
  { owner: 'other-session' },
  { lead: undefined },
  { scene: 'B' },
  { phase: 'C:lead-allow' },
  { phase: 'C:lead-reject' },
  { args: { timeout_ms: 60000 } },
  { args: { command: 'write marker' } },
  { args: [] },
  { args: null },
])('keeps pre-relay discovery within the exact Lead, member phase and empty arguments: %j', (change) => {
  expect(
    isMemberApprovalCoordination({
      ...request,
      toolName: 'list_agents',
      args: {},
      relaySucceeded: false,
      ...change,
    }),
  ).toBe(false)
})

it.each([
  { relaySucceeded: false },
  { owner: 'other-session' },
  { lead: undefined },
  { scene: 'B' },
  { phase: 'C:lead-allow' },
  { phase: 'C:lead-reject' },
  { toolName: 'bash', args: { command: 'write marker' } },
  { toolName: 'send_message', args: { target: 'runtime-reader', message: 'unrelated' } },
  { toolName: 'list_agents', args: { command: 'write marker' } },
  { args: { timeout_ms: 60000, command: 'write marker' } },
  { args: [] },
  { args: null },
])('denies coordination outside its exact actor, phase and read-only shape: %j', (change) => {
  expect(isMemberApprovalCoordination({ ...request, ...change })).toBe(false)
})

it.each([0, 9999, 60001, Infinity, NaN, '60000', null])('denies invalid or out-of-budget waits: %s', (timeout_ms) => {
  expect(isMemberApprovalCoordination({ ...request, args: { timeout_ms } })).toBe(false)
})

it.each([
  ['wait_agent', 'wait_agent\nnot json'],
  ['wait_agent', 'bash\n{"timeout_ms":60000}'],
  ['wait_agent', 'wait_agent\nnull'],
  ['bash', 'bash\n{}'],
])('does not convert an unrecognized approval into an allowed default: %s %s', (tool, reason) => {
  expect(
    isMemberApprovalCoordination({ ...request, toolName: tool, args: memberCoordinationArguments(tool, reason) }),
  ).toBe(false)
})
