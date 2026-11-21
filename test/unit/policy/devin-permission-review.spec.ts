import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'
import type { PermissionRiskReviewer } from '../../../src/domain/policy/permission-review.ts'
import {
  ApprovalReviewError,
  approvalReviewFailures,
  permissionAuditFailureMessage,
} from '../../../src/contract/approval-review.ts'
import { permissionOperationHash } from '../../../src/domain/policy/events.ts'
import type { AcpPermissionQuestionService } from '../../../src/domain/policy/elicitation.ts'
import {
  createAcpNativePermissionHandler,
  discardPermissionResponse,
  NO_EXTERNAL_POLICY,
  type AcpPermissionAuditRecord,
  type AcpNativePermissionBridgeDeps,
} from '../../../src/domain/policy/permissions.ts'

function request(): RequestPermissionRequest {
  return {
    sessionId: 'member-acp-session',
    toolCall: { toolCallId: 'call-1', kind: 'execute', rawInput: { command: 'echo preview' } },
    options: [
      { optionId: 'mode-bypass', kind: 'allow_always', name: 'Switch mode' },
      { optionId: 'single-original-id', kind: 'allow_once', name: 'Allow this time' },
      { optionId: 'deny-original-id', kind: 'reject_once', name: 'Reject this time' },
    ],
  }
}
function fixture(overrides: Partial<AcpNativePermissionBridgeDeps> = {}, auditAvailable = true) {
  const agent = {}
  const records: AcpPermissionAuditRecord[] = []
  const append = vi.fn(async (record: AcpPermissionAuditRecord) => {
    records.push(record)
  })
  const review = vi
    .fn<PermissionRiskReviewer['review']>()
    .mockResolvedValue({ risk: 'not_high', reason: 'Reversible change' })
  const ask = vi.fn<AcpPermissionQuestionService['ask']>(async ({ questions }, present) => {
    present?.({ rootSessionId: 'lead', path: ['member'] })
    return { answers: [{ id: questions[0]!.id, selected: ['Reject this time'] }] }
  })
  const nativeApproval = vi.fn(async () => 'allowed-once' as const)
  const deps = {
    permissionProfile: 'devin',
    riskReviewer: { agent: 'devin' as const, model: 'swe-2-high', policyVersion: 'v1', review },
    getAgent: () => agent,
    approval: { request: nativeApproval },
    ...(auditAvailable ? { audit: { append } } : {}),
    permissionQuestions: { ask },
    ...overrides,
  }
  return { records, append, review, ask, nativeApproval, handle: createAcpNativePermissionHandler(deps) }
}

it('reviews the frozen complete call, persists the assessment and returns exactly one offered grant', async () => {
  const f = fixture()
  const params = request()
  const command = 'x'.repeat(1000) + ' tail'
  params.toolCall.rawInput = { command }
  const pending = f.handle(params)
  params.toolCall.rawInput = { command: 'another action' }
  params.options[1]!.optionId = 'replacement'
  await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'single-original-id' } })
  expect(f.review.mock.calls[0]?.[0].rawInput).toEqual({ command })
  expect(f.nativeApproval).not.toHaveBeenCalled()
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.records.map((r) => r.data.phase)).toEqual(['asked', 'ai-review-started', 'ai-review-result', 'decided'])
  expect(new Set(f.records.map((r) => r.data.requestId)).size).toBe(1)
  const started = f.records[1]!.data
  expect(started).toMatchObject({
    phase: 'ai-review-started',
    agentSessionId: 'member-acp-session',
    model: 'swe-2-high',
    policyVersion: 'v1',
  })
  expect(f.records[2]!.data).toMatchObject({
    attemptId: started.phase === 'ai-review-started' && started.attemptId,
    status: 'not_high',
    reason: 'Reversible change',
  })
  expect(f.records[3]!.data).toMatchObject({ decisionVia: 'devin-ai', selectedOptionKind: 'allow_once' })
})

it.each([
  ['zh', '风险较高'],
  ['en', 'high risk'],
])('routes even a binary high-risk request to a single human question (%s)', async (locale, message) => {
  const f = fixture({ locale })
  f.review.mockResolvedValue({ risk: 'high', reason: 'Public access' })
  const params = request()
  params.options.shift()
  await expect(f.handle(params)).resolves.toMatchObject({ outcome: { optionId: 'deny-original-id' } })
  expect(f.nativeApproval).not.toHaveBeenCalled()
  expect(f.ask).toHaveBeenCalledTimes(1)
  const question = f.ask.mock.calls[0]![0].questions[0]!
  expect(question.question).toContain(message)
  expect(question.question).toContain('Public access')
  expect(question.options?.map((o) => o.label)).toEqual(params.options.map((o) => o.name))
  expect(f.records.at(-1)!.data).toMatchObject({
    decisionVia: 'native-question',
    presentation: { rootSessionId: 'lead', path: ['member'] },
  })
})

it('fingerprints and evaluates the same frozen wire diff, independent of the native card representation', async () => {
  const original = {
    toolCallId: 'call-1',
    kind: 'edit' as const,
    content: [{ type: 'diff' as const, path: 'doc', newText: 'internal' }],
  }
  const expected = permissionOperationHash(original)
  const review = vi
    .fn<PermissionRiskReviewer['review']>()
    .mockResolvedValue({ risk: 'not_high', reason: 'Reversible edit' })
  const f = fixture({
    riskReviewer: { agent: 'devin' as const, model: 'test', policyVersion: '1', toolCall: original, review },
  })
  const result = f.handle(request())
  original.content[0]!.newText = 'public'
  expect(permissionOperationHash(original)).not.toBe(expected)
  await expect(result).resolves.toMatchObject({ outcome: { optionId: 'single-original-id' } })
  expect(review.mock.calls[0]![0].content).toMatchObject([{ newText: 'internal' }])
  expect(f.records[1]?.data).toMatchObject({ operationHash: expected })
})

it('versions the audit fingerprint and includes reviewed text without persisting its body', async () => {
  const f = fixture()
  const params = request()
  const text = 'private body of the explanation'
  const call = params.toolCall
  call.content = [{ type: 'content', content: { type: 'text', text } }]
  const digest = permissionOperationHash(call)
  await f.handle(params)
  for (const record of f.records.filter(
    ({ data }) => data.phase === 'ai-review-started' || data.phase === 'ai-review-result',
  )) {
    expect(record.data).toMatchObject({ operationHashVersion: 2, operationHash: digest })
    expect(JSON.stringify(record.data)).not.toContain(text)
  }
  expect(
    permissionOperationHash({ ...call, content: [{ type: 'content', content: { type: 'text', text: 'changed' } }] }),
  ).not.toBe(digest)
  expect(permissionOperationHash({ ...call, rawInput: { command: 'changed' } })).not.toBe(digest)
  expect(permissionOperationHash({ ...call, title: null })).not.toBe(digest)
})

it('explains an unavailable reviewer on the existing manual card', async () => {
  const f = fixture({ humanReviewOnly: 'review-unavailable', locale: 'zh' })
  await f.handle(request())
  expect(f.review).not.toHaveBeenCalled()
  expect(f.ask.mock.calls[0]![0].questions[0]!.question).toContain('AI 未能判断')
})

it.each(['missing-once', 'ambiguous-once', 'manual-policy', 'no-audit'] as const)(
  'skips inference and preserves manual choices: %s',
  async (scenario) => {
    const params = request()
    const f = fixture(scenario === 'manual-policy' ? { humanReviewOnly: true } : {}, scenario !== 'no-audit')
    if (scenario === 'missing-once') params.options.splice(1, 1)
    if (scenario === 'ambiguous-once') params.options.push({ name: 'Extra', kind: 'allow_once', optionId: 'extra' })
    await expect(f.handle(params)).resolves.toMatchObject({ outcome: { optionId: 'deny-original-id' } })
    expect(f.review).not.toHaveBeenCalled()
    expect(f.ask.mock.calls[0]![0].questions[0]!.options).toHaveLength(params.options.length)
  },
)

it.each(['ai-review-started', 'ai-review-result', 'decided'] as const)(
  'never releases the AI grant when its %s write fails',
  async (phase) => {
    const onUnavailable = vi.fn()
    const f = fixture({ onUnavailable })
    let failed = false
    f.append.mockImplementation(async (record) => {
      if (record.data.phase === phase && !failed) {
        failed = true
        throw Error('write failed')
      }
      f.records.push(record)
    })
    await expect(f.handle(request())).resolves.toMatchObject({ outcome: { optionId: 'deny-original-id' } })
    expect(f.review).toHaveBeenCalledTimes(phase === 'ai-review-started' ? 0 : 1)
    expect(f.records.at(-1)?.data).toMatchObject({
      phase: 'decided',
      outcome: 'selected',
      selectedOptionKind: 'reject_once',
      decisionVia: 'native-question',
    })
    expect(f.ask).toHaveBeenCalledTimes(1)
    expect(onUnavailable).not.toHaveBeenCalled()
  },
)

it.each([
  ['asked', 'en'],
  ['decided', 'zh'],
] as const)('reports a terminal %s storage failure once and cancels the original request', async (phase, locale) => {
  const log = vi.fn()
  const onUnavailable = vi.fn(async () => {
    throw Error('notification transport')
  })
  const f = fixture({ onUnavailable, log, locale })
  f.append.mockImplementation(async (record) => {
    if (record.data.phase === phase) throw Error('private storage detail')
    f.records.push(record)
  })
  await expect(f.handle(request())).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  expect(f.ask).toHaveBeenCalledTimes(phase === 'asked' ? 0 : 1)
  expect(f.review).toHaveBeenCalledTimes(phase === 'asked' ? 0 : 1)
  expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
    code: 'ACP_PERMISSION_AUDIT_UNAVAILABLE',
    message: permissionAuditFailureMessage[locale],
  })
  expect(JSON.stringify([f.records, log.mock.calls])).not.toContain('private storage detail')
})

it('does not report a pending audit failure to a replacement Agent', async () => {
  const onUnavailable = vi.fn()
  let owner = {}
  const f = fixture({ onUnavailable, getAgent: () => owner })
  f.append.mockImplementationOnce(async () => {
    owner = {}
    throw Error('storage unavailable')
  })
  await expect(f.handle(request())).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  expect(onUnavailable).not.toHaveBeenCalled()
  expect(f.review).not.toHaveBeenCalled()
})

it('shares concurrent withdrawal writes and can retry if the store could not retain the outcome', async () => {
  const log = vi.fn()
  const f = fixture({ log })
  const selected = await f.handle(request())
  f.append.mockRejectedValueOnce(new Error('private storage detail'))
  const cancel = { outcome: { outcome: 'cancelled' } }
  const discard = () => discardPermissionResponse(selected)
  await expect(Promise.all([discard(), discard()])).resolves.toEqual([cancel, cancel])
  expect(log).toHaveBeenCalledExactlyOnceWith('dsh-acp: failed to persist a confirmed permission withdrawal')
  await expect(Promise.all([discard(), discard()])).resolves.toEqual([cancel, cancel])
  expect(f.records.filter((record) => record.data.phase === 'decision-withdrawn')).toHaveLength(1)
  expect(f.append.mock.calls.filter(([record]) => record.data.phase === 'decision-withdrawn')).toHaveLength(2)
})

it.each([
  'invalid-response',
  'incomplete-evidence',
  'unverified-reviewer',
  'model-unavailable',
  'review-unavailable',
  'timeout',
] as const)('records the safe %s reason and offers one manual decision', async (status) => {
  const f = fixture({ locale: 'zh' })
  if (status === 'invalid-response') f.review.mockResolvedValue({ risk: 'not_high', reason: ' ' })
  else if (status === 'timeout') f.review.mockRejectedValue(new DOMException('private upstream text', 'TimeoutError'))
  else if (status === 'review-unavailable') f.review.mockRejectedValue(new Error('private upstream text'))
  else f.review.mockRejectedValue(new ApprovalReviewError(status, 'private upstream text'))
  await expect(f.handle(request())).resolves.toMatchObject({ outcome: { optionId: 'deny-original-id' } })
  const expected = status === 'timeout' ? { status: 'timeout' } : { status: 'error', failureCode: status }
  expect(f.records[2]!.data).toMatchObject(expected)
  expect(JSON.stringify([f.records, f.ask.mock.calls])).not.toContain('private upstream text')
  expect(f.ask).toHaveBeenCalledTimes(1)
  const question = f.ask.mock.calls[0]![0].questions[0]!
  expect(question.question).toContain(status === 'timeout' ? '审查超时' : approvalReviewFailures.zh[status])
})

it.each(['ai-review-started', 'ai-review-result', 'decided'] as const)(
  'discards a stale grant while awaiting the %s write',
  async (phase) => {
    let owner = {}
    const f = fixture({ getAgent: () => owner })
    f.append.mockImplementation(async (record) => {
      f.records.push(record)
      if (record.data.phase === phase) owner = {}
    })
    await expect(f.handle(request())).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.review).toHaveBeenCalledTimes(phase === 'ai-review-started' ? 0 : 1)
    expect(f.records.at(-1)?.data).toMatchObject({
      phase: phase === 'decided' ? 'decision-withdrawn' : 'decided',
      outcome: 'cancelled',
    })
  },
)

it('cancels the reviewer with the prompt and records the interrupted attempt', async () => {
  const controller = new AbortController()
  const f = fixture()
  const started = Promise.withResolvers<void>()
  f.review.mockImplementation(
    (_tool, signal) =>
      new Promise((_, reject) => {
        started.resolve()
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }),
  )
  const pending = f.handle(request(), controller.signal)
  await started.promise
  controller.abort()
  await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  expect(f.records[2]!.data).toMatchObject({ phase: 'ai-review-result', status: 'cancelled' })
  expect(f.ask).not.toHaveBeenCalled()
})

it.each([
  ['no-rules', NO_EXTERNAL_POLICY, 'single-original-id', 1],
  ['policy-denial', 'deny-once', 'deny-original-id', 0],
  ['policy-allow', 'allow-once', 'single-original-id', 0],
  ['explicit-human', 'not-applicable', 'deny-original-id', 0],
  ['manual-explanation', { decision: 'not-applicable', reason: 'Check with owner' }, 'deny-original-id', 0],
  ['policy-failure', 'failed', undefined, 0],
] as const)('runs OpenCode review after external policy (%s)', async (_scenario, decision, option, reviews) => {
  const review = vi.fn(async () => ({ risk: 'not_high' as const, reason: 'Reads the requested file' }))
  const f = fixture({
    permissionProfile: undefined,
    riskReviewer: { agent: 'opencode', model: 'test/model', policyVersion: '1', review },
    approval: { request: vi.fn(), evaluateExternal: vi.fn(async () => decision) },
  })
  const result = await f.handle(request())
  expect(result.outcome).toEqual(option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' })
  expect(review).toHaveBeenCalledTimes(reviews)
  if (reviews) {
    expect(f.records[1]?.data).toMatchObject({
      phase: 'ai-review-started',
      reviewAgent: 'opencode',
      model: 'test/model',
    })
    expect(f.records.at(-1)?.data).toMatchObject({
      phase: 'decided',
      decisionVia: 'opencode-ai',
      selectedOptionKind: 'allow_once',
    })
  }
})

it('an OpenCode human-only request can still be denied by policy, and cannot take a machine grant', async () => {
  for (const decision of ['allow-once', 'deny-once'] as const) {
    const f = fixture({
      permissionProfile: undefined,
      humanReviewOnly: true,
      approval: { request: vi.fn(), evaluateExternal: vi.fn(async () => decision) },
    })
    await expect(f.handle(request())).resolves.toMatchObject({ outcome: { optionId: 'deny-original-id' } })
    expect(f.ask).toHaveBeenCalledTimes(decision === 'allow-once' ? 1 : 0)
    expect(f.review).not.toHaveBeenCalled()
  }
})
