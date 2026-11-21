import { expect, it } from 'vitest'
import { createCodeBuddyReviewRecorder } from '../../../src/host/composition/codebuddy-review.ts'
import type { AcpCodeBuddyReviewAuditData } from '../../../src/domain/policy/events.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'

const launch = { command: 'codebuddy', args: ['--acp'] }
const start: AcpSessionNotification = {
  sessionId: 'session',
  update: { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read' },
}

// These fixtures use the tool_call_update envelope emitted by the official 2.161.2
// broadcaster with synthetic inputs. An unmarked broadcast may follow a member tool call.
function frame(conclusions: unknown, toolName = 'Read', toolCallId = 'call'): AcpSessionNotification {
  return {
    sessionId: 'session',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      _meta: { 'codebuddy.ai': { toolName, toolMetaData: { securityConclusions: conclusions } } },
    },
  }
}

function recording(profile: Parameters<typeof createCodeBuddyReviewRecorder>[0] = launch) {
  const rows: AcpCodeBuddyReviewAuditData[] = []
  const record = createCodeBuddyReviewRecorder(profile, async (row) => rows.push(row))
  return (notification: AcpSessionNotification, peer?: string) => {
    record(peer, notification)
    return rows.splice(0)
  }
}

it('keeps only published AI decision and scope combinations without private tool content', () => {
  const observe = recording()
  observe(start)
  const sensitive = { scope: 'sensitive', decision: 'allow', decidedBy: 'ai' }
  const denied = { scope: 'tool_result', decision: 'deny', decidedBy: 'ai' }
  const input = [
    { ...sensitive, approvalId: 'private approval', entryCount: 7 },
    sensitive,
    { ...denied, contentPreview: 'customer record', reason: 'private excerpt', reviewReason: 'secret reason' },
    { ...denied, scope: 'sandbox' },
    { ...denied, scope: 'tool_call' },
    { ...denied, scope: 'sensitive' },
    { ...denied, decidedBy: 'policy' },
    { ...denied, decidedBy: 'user' },
    { ...denied, scope: 'unknown' },
    { ...denied, decision: 'allow' },
    null,
  ]
  const common = { phase: 'codebuddy-review', agentSessionId: 'session', toolCallId: 'call', toolName: 'Read' }
  expect(observe(frame(input))).toEqual([
    { ...common, ...sensitive },
    { ...common, ...denied },
    { ...common, ...denied, scope: 'sandbox' },
    { ...common, ...denied, scope: 'tool_call' },
  ])
  expect(observe(frame(Array(17).fill(denied)))).toEqual([])
  expect(observe(frame([denied], 'ghp_0123456789abcdef0123456789abcdef'))[0]).not.toHaveProperty('toolName')
  expect(
    observe({
      ...start,
      update: { sessionUpdate: 'session_info_update', _meta: { securityConclusions: [sensitive] } },
    }),
  ).toEqual([])
})

it('requires the initial root tool, matching session and known peer or launch', () => {
  const report = frame([{ scope: 'tool_call', decision: 'deny', decidedBy: 'ai' }])
  const observe = recording()
  expect(observe(report)).toEqual([])
  observe({ ...start, update: { ...start.update, _meta: { 'codebuddy.ai/memberEvent': 'member' } } })
  expect(observe(report)).toEqual([])
  observe(start)
  expect(observe(report)).toHaveLength(1)
  expect(observe(report, 'OpenCode')).toEqual([])
  const anonymousWrapper = recording({ command: 'custom-wrapper', args: [] })
  anonymousWrapper(start)
  expect(anonymousWrapper(report)).toEqual([])
  const mismatched = recording({ ...launch, runtime: 'codex' })
  mismatched(start, 'codebuddy-code')
  expect(mismatched(report, 'codebuddy-code')).toEqual([])
  expect(observe(report, 'codebuddy-code')).toHaveLength(1)
  observe({ ...report, _meta: { 'codebuddy.ai/memberEvent': 'other' } })
  expect(observe(report)).toEqual([])
  observe(start)
  expect(observe({ ...report, sessionId: 'another-session' })).toEqual([])
  expect(observe(report)).toEqual([])
})

it('retains a live root call through many completed roots and bounds only late terminal broadcasts', () => {
  const observe = recording()
  const conclusion = [{ scope: 'sandbox', decision: 'deny', decidedBy: 'ai' }]
  const decision = frame(conclusion)
  function send(id: string, status?: 'completed' | 'failed') {
    return observe({
      sessionId: start.sessionId,
      update: status
        ? { sessionUpdate: 'tool_call_update', toolCallId: id, status }
        : { sessionUpdate: 'tool_call', toolCallId: id, title: 'Read' },
    })
  }
  send('call')
  for (let i = 0; i < 257; ++i) {
    send(`other-${i}`)
    send(`other-${i}`, 'completed')
  }
  expect(observe(decision)).toHaveLength(1)
  send('call', 'failed')
  expect(observe(decision)).toHaveLength(1)
  expect(observe(frame(conclusion, 'Read', 'other-0'))).toEqual([])
  expect(observe(frame(conclusion, 'Read', 'other-256'))).toHaveLength(1)
  observe({ ...decision, _meta: { 'codebuddy.ai/memberEvent': 'member' } })
  expect(observe(decision)).toEqual([])
})
