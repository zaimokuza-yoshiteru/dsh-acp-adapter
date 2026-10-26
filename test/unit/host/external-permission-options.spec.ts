import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type * as acp from '@agentclientprotocol/sdk'
import AcpPermissionPolicy from '../../../src/host/composition/external-permission-policy.ts'
import { externalAgentApproval } from '../../../src/host/composition/external-agent-approval.ts'
import type { AcpExternalPolicyDecision, AcpExternalPolicyRequest } from '../../../src/contract/permission-policy.ts'
import {
  createAcpNativePermissionHandler,
  type AcpNativePermissionBridgeDeps,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type {
  AcpNativeQuestionUnavailable,
  AcpNativeUserQuestionService,
} from '../../../src/domain/policy/elicitation.ts'
import { AcpUiFeedback, followAcpQuestionLimitations } from '../../../src/client/data/feedback.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function request(): acp.RequestPermissionRequest {
  return {
    sessionId: 'external-session',
    toolCall: {
      toolCallId: 'shared-call-id',
      kind: 'execute',
      rawInput: { command: 'printf fixture-only', permissions: { network: ['example.test'] } },
    },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ],
  }
}
const cancelled = { outcome: { outcome: 'cancelled' } }
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } })

function asked(records: readonly AcpPermissionAuditRecord[]) {
  const record = records[0]?.data
  if (record?.phase !== 'asked') throw new Error('Expected the original request audit')
  return record
}

function decided(records: readonly AcpPermissionAuditRecord[]) {
  const record = records[1]?.data
  if (record?.phase !== 'decided') throw new Error('Expected the original decision audit')
  return record
}

async function fixture({ service = true, profile = 'antigravity', policy = 'ask', locale = 'en' } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const fiber = service ? await ctx.plugin(AcpPermissionPolicy) : undefined
  const session = Session.create(SessionId(`external-policy-${contexts.length}`))
  session.append('turn/start', { turn: 1 })
  session.append('approval/policy', { policy: policy === 'never' ? 'never' : 'ask' })
  // Same minimal Agent seam as the owning approval tests; Cordis dispatch and
  // native Session/Approval services are the published implementations.
  const agent = { ctx, session, id: session.id, status: 'running' } as Agent
  let live: Agent | undefined = agent
  const records: AcpPermissionAuditRecord[] = []
  const append = vi.fn(async (record: AcpPermissionAuditRecord): Promise<void> => {
    records.push(record)
  })
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [{ id: questions[0]!.id, selected: ['Always allow'] }],
  }))
  const legacy = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', legacy)
  const notify = vi.fn(async (_issue: AcpNativeQuestionUnavailable): Promise<void> => {})
  const deps = {
    getAgent: () => live,
    permissionProfile: profile,
    nativeQuestionProfile: 'antigravity',
    approval: externalAgentApproval(ctx, () => live),
    userQuestions: { ask },
    audit: { append },
    locale,
    onUnavailable: notify,
  } satisfies AcpNativePermissionBridgeDeps
  return {
    ctx,
    agent,
    session,
    fiber,
    deps,
    records,
    append,
    ask,
    legacy,
    notify,
    handle: (params = request(), signal?: AbortSignal) => createAcpNativePermissionHandler(deps)(params, signal),
    replace: () => {
      // Same session ID is insufficient: the original live object must match.
      live = { ...agent } as Agent
    },
  }
}

describe('complete ACP options with an explicitly installed machine policy', () => {
  it.each(['allow-once', 'deny-once'] as const)(
    '%s selects only the exact original once ID and preserves the existing audit pair',
    async (decision) => {
      const f = await fixture()
      const provider = vi.fn(async (input: AcpExternalPolicyRequest) => {
        expect(f.records.map(({ data }) => data.phase)).toEqual(['asked'])
        expect(input.agent).toBe(f.agent)
        expect(input.profile).toBe('antigravity')
        expect(input.requestId).toBe(asked(f.records).requestId)
        return decision
      })
      f.ctx.on('dsh-acp/permission-policy', provider)
      const optionId = decision === 'allow-once' ? 'once' : 'deny'
      expect(await f.handle()).toEqual(selected(optionId))
      expect(provider).toHaveBeenCalledOnce()
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.legacy).not.toHaveBeenCalled()
      expect(f.records.map(({ data }) => data.phase)).toEqual(['asked', 'decided'])
      expect(f.records[1]!.data).toMatchObject({
        requestId: asked(f.records).requestId,
        agentSessionId: 'external-session',
        toolCallId: 'shared-call-id',
        decisionVia: 'external-policy',
        optionId,
        selectedOptionKind: decision === 'allow-once' ? 'allow_once' : 'reject_once',
      })
    },
  )

  it.each(['no-service', 'no-provider', 'not-applicable'] as const)(
    '%s preserves the complete original human choices without consulting legacy answerers',
    async (mode) => {
      const f = await fixture({ service: mode !== 'no-service' })
      if (mode === 'not-applicable') f.ctx.on('dsh-acp/permission-policy', async () => 'not-applicable')
      expect(await f.handle()).toEqual(selected('always'))
      expect(f.ask).toHaveBeenCalledOnce()
      expect(f.ask.mock.calls[0]![0].questions[0]!.options).toEqual(
        request().options.map(({ name }) => ({ label: name })),
      )
      expect(f.legacy).not.toHaveBeenCalled()
      expect(f.records.map(({ data }) => data.phase)).toEqual(['asked', 'decided'])
      expect(decided(f.records).decisionVia).toBe('native-question')
    },
  )

  it.each(['throw', 'invalid', 'failed', 'cancelled'] as const)(
    'policy %s never falls back to a human grant',
    async (mode) => {
      const f = await fixture()
      f.ctx.on('dsh-acp/permission-policy', async () => {
        if (mode === 'throw') throw new Error('private backend failure')
        // Deliberate runtime protocol violation, not an added public option.
        return (mode === 'invalid' ? 'allow-always' : mode) as AcpExternalPolicyDecision
      })
      expect(await f.handle()).toEqual(cancelled)
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.legacy).not.toHaveBeenCalled()
      expect(f.records.map(({ data }) => data.phase)).toEqual(['asked', 'decided'])
      expect(f.records[1]!.data).toMatchObject({ outcome: 'cancelled', decisionVia: 'external-policy' })
      expect(f.notify).toHaveBeenCalledTimes(mode === 'cancelled' ? 0 : 1)
    },
  )

  it('keeps distinct once scopes for the human to select', async () => {
    const f = await fixture()
    f.ctx.on('dsh-acp/permission-policy', async () => 'allow-once')
    f.ask.mockImplementationOnce(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Network only'] }],
    }))
    const input = request()
    input.options = [
      { optionId: 'local', kind: 'allow_once', name: 'Local only' },
      { optionId: 'network', kind: 'allow_once', name: 'Network only' },
      input.options[2]!,
    ]
    expect(await f.handle(input)).toEqual(selected('network'))
    expect(f.ask).toHaveBeenCalledOnce()
    expect(decided(f.records).decisionVia).toBe('native-question')
  })

  it.each(['persistent-only', 'multiple-once', 'missing'] as const)(
    'a deny with %s rejection options cancels without an allow fallback',
    async (shape) => {
      const f = await fixture()
      f.ctx.on('dsh-acp/permission-policy', async () => 'deny-once')
      const input = request()
      input.options = [
        ...input.options.slice(0, 2),
        ...(shape === 'persistent-only'
          ? [{ optionId: 'never', kind: 'reject_always' as const, name: 'Never allow' }]
          : shape === 'multiple-once'
            ? [input.options[2]!, { optionId: 'deny-other', kind: 'reject_once' as const, name: 'Deny other scope' }]
            : []),
      ]
      expect(await f.handle(input)).toEqual(cancelled)
      expect(f.ask).not.toHaveBeenCalled()
      expect(decided(f.records).decisionVia).toBe('external-policy')
    },
  )

  it('cannot manufacture a standing grant from a machine once allow', async () => {
    const f = await fixture()
    f.ctx.on('dsh-acp/permission-policy', async () => 'allow-once')
    const input = request()
    input.options = input.options.slice(1)
    expect(await f.handle(input)).toEqual(selected('always'))
    expect(f.ask).toHaveBeenCalledOnce()
    expect(decided(f.records).decisionVia).toBe('native-question')
  })

  it('keeps trusted Devin on the full human path despite forged metadata', async () => {
    const f = await fixture({ profile: 'devin' })
    const provider = vi.fn(async () => 'allow-once' as const)
    f.ctx.on('dsh-acp/permission-policy', provider)
    expect(await f.handle({ ...request(), _meta: { profile: 'antigravity', auto: true, mode: 'bypass' } })).toEqual(
      selected('always'),
    )
    expect(provider).not.toHaveBeenCalled()
    expect(f.ask).toHaveBeenCalledOnce()
  })

  it('keeps ordinary binary approval on its native chain', async () => {
    const f = await fixture()
    const provider = vi.fn(async () => 'deny-once' as const)
    f.ctx.on('dsh-acp/permission-policy', provider)
    const input = request()
    input.options = [input.options[0]!, input.options[2]!]
    expect(await f.handle(input)).toEqual(selected('once'))
    expect(provider).not.toHaveBeenCalled()
    expect(f.legacy).toHaveBeenCalledOnce()
    expect(decided(f.records).decisionVia).toBe('native-approval')
  })

  it('keeps Antigravity interaction questions with their original question owner', async () => {
    const f = await fixture()
    const provider = vi.fn(async () => 'deny-once' as const)
    f.ctx.on('dsh-acp/permission-policy', provider)
    f.ask.mockImplementationOnce(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Option B'] }],
    }))
    expect(
      await f.handle({
        sessionId: 'external-session',
        toolCall: { toolCallId: 'interaction_1234abcd', title: 'Choose a design', rawInput: {} },
        options: [
          { optionId: 'a', kind: 'allow_once', name: 'Option A' },
          { optionId: 'b', kind: 'allow_once', name: 'Option B' },
        ],
      }),
    ).toEqual(selected('b'))
    expect(provider).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
    expect(f.ask.mock.calls[0]![0].questions[0]!.question).toBe('Choose a design')
  })

  it('rejects duplicated option identities before dispatch or audit', async () => {
    const f = await fixture()
    const provider = vi.fn(async () => 'allow-once' as const)
    f.ctx.on('dsh-acp/permission-policy', provider)
    const input = request()
    input.options[1]!.optionId = input.options[0]!.optionId
    expect(await f.handle(input)).toEqual(cancelled)
    expect(provider).not.toHaveBeenCalled()
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.records).toHaveLength(0)
  })

  it.each(['asked', 'policy'] as const)(
    'captures option mapping before the asynchronous %s boundary',
    async (boundary) => {
      const f = await fixture()
      const arrived = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const captured: AcpExternalPolicyRequest[] = []
      f.append.mockImplementation(async (record) => {
        f.records.push(record)
        if (boundary === 'asked' && record.data.phase === 'asked') {
          arrived.resolve()
          await release.promise
        }
      })
      f.ctx.on('dsh-acp/permission-policy', async (input) => {
        captured.push(input)
        if (boundary === 'policy') {
          arrived.resolve()
          await release.promise
        }
        return 'allow-once'
      })
      const input = request()
      const pending = f.handle(input)
      await arrived.promise
      input.options[0]!.optionId = 'mutated-standing-grant'
      input.options[0]!.kind = 'allow_always'
      input.toolCall.rawInput = { command: 'different command' }
      input.sessionId = 'different-session'
      release.resolve()
      expect(await pending).toEqual(selected('once'))
      expect(captured[0]!.params).toMatchObject({
        sessionId: 'external-session',
        options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always' }, { optionId: 'deny' }],
        toolCall: { rawInput: { command: 'printf fixture-only' } },
      })
      expect(f.records[1]!.data).toMatchObject({ agentSessionId: 'external-session', optionId: 'once' })
    },
  )

  it.each(['cancel', 'replace'] as const)('%s during request audit prevents policy dispatch', async (mode) => {
    const f = await fixture()
    const controller = new AbortController()
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const provider = vi.fn(async () => 'allow-once' as const)
    f.ctx.on('dsh-acp/permission-policy', provider)
    f.append.mockImplementation(async (record) => {
      f.records.push(record)
      if (record.data.phase === 'asked') {
        arrived.resolve()
        await release.promise
      }
    })
    const pending = f.handle(request(), controller.signal)
    await arrived.promise
    if (mode === 'cancel') controller.abort()
    else f.replace()
    release.resolve()
    expect(await pending).toEqual(cancelled)
    expect(provider).not.toHaveBeenCalled()
    expect(f.ask).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'replace'] as const)('%s after policy abstention prevents a late human answer', async (mode) => {
    const f = await fixture()
    const controller = new AbortController()
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.ctx.on('dsh-acp/permission-policy', async () => 'not-applicable')
    f.ask.mockImplementation(async ({ questions }) => {
      arrived.resolve()
      await release.promise
      return { answers: [{ id: questions[0]!.id, selected: ['Always allow'] }] }
    })
    const pending = f.handle(request(), controller.signal)
    await arrived.promise
    if (mode === 'cancel') controller.abort()
    else f.replace()
    release.resolve()
    expect(await pending).toEqual(cancelled)
    expect(decided(f.records).decisionVia).toBe('native-question')
  })

  it.each(['cancel', 'replace'] as const)('%s during policy evaluation ignores a late allow', async (mode) => {
    const f = await fixture()
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<AcpExternalPolicyDecision>()
    const controller = new AbortController()
    f.ctx.on('dsh-acp/permission-policy', async () => {
      arrived.resolve()
      return release.promise
    })
    const pending = f.handle(request(), controller.signal)
    await arrived.promise
    if (mode === 'cancel') controller.abort()
    else f.replace()
    release.resolve('allow-once')
    expect(await pending).toEqual(cancelled)
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('service disposal cancels the request while awaiting provider cleanup', async () => {
    const f = await fixture()
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<AcpExternalPolicyDecision>()
    f.ctx.on('dsh-acp/permission-policy', async () => {
      arrived.resolve()
      return release.promise
    })
    const pending = f.handle()
    await arrived.promise
    let disposed = false
    const disposal = f.fiber!.dispose().then(() => {
      disposed = true
    })
    expect(await pending).toEqual(cancelled)
    expect(disposed).toBe(false)
    release.resolve('allow-once')
    await disposal
    expect(f.ask).not.toHaveBeenCalled()
  })

  it.each(['asked', 'decided'] as const)(
    'audit failure during %s never releases a selected response',
    async (phase) => {
      const f = await fixture()
      const provider = vi.fn(async () => 'allow-once' as const)
      f.ctx.on('dsh-acp/permission-policy', provider)
      f.append.mockImplementation(async (record) => {
        if (record.data.phase === phase) throw new Error('fixture disk unavailable')
        f.records.push(record)
      })
      expect(await f.handle()).toEqual(cancelled)
      expect(provider).toHaveBeenCalledTimes(phase === 'asked' ? 0 : 1)
      expect(f.ask).not.toHaveBeenCalled()
    },
  )

  it.each(['cancel', 'replace'] as const)('%s during decision persistence blocks late delivery', async (mode) => {
    const f = await fixture()
    const controller = new AbortController()
    f.ctx.on('dsh-acp/permission-policy', async () => 'allow-once')
    f.append.mockImplementation(async (record) => {
      f.records.push(record)
      if (record.data.phase === 'decided') {
        if (mode === 'cancel') controller.abort()
        else f.replace()
      }
    })
    expect(await f.handle(request(), controller.signal)).toEqual(cancelled)
    // The durable decision is not a wire-delivery acknowledgement.
    expect(f.records[1]!.data).toMatchObject({ phase: 'decided', decisionVia: 'external-policy' })
  })

  it('isolates two live Agent scopes sharing the same external call ID', async () => {
    const f = await fixture()
    const secondSession = Session.create(SessionId('second-policy-agent'))
    secondSession.append('turn/start', { turn: 1 })
    const second = { ctx: f.ctx, session: secondSession, id: secondSession.id, status: 'running' } as Agent
    const firstScope = createScope(f.ctx, f.agent)
    const secondScope = createScope(f.ctx, second)
    const firstArrived = Promise.withResolvers<void>()
    const secondArrived = Promise.withResolvers<void>()
    const firstAnswer = Promise.withResolvers<AcpExternalPolicyDecision>()
    const secondAnswer = Promise.withResolvers<AcpExternalPolicyDecision>()
    const firstProvider = vi.fn(async (input: AcpExternalPolicyRequest) => {
      expect(input.agent).toBe(f.agent)
      firstArrived.resolve()
      return firstAnswer.promise
    })
    const secondProvider = vi.fn(async (input: AcpExternalPolicyRequest) => {
      expect(input.agent).toBe(second)
      secondArrived.resolve()
      return secondAnswer.promise
    })
    firstScope.ctx.on('dsh-acp/permission-policy', firstProvider)
    secondScope.ctx.on('dsh-acp/permission-policy', secondProvider)
    const secondHandle = createAcpNativePermissionHandler({
      ...f.deps,
      getAgent: () => second,
      approval: externalAgentApproval(f.ctx, () => second),
    })
    const firstPending = f.handle()
    const secondPending = secondHandle({ ...request(), sessionId: 'second-external-session' })
    await Promise.all([firstArrived.promise, secondArrived.promise])
    secondAnswer.resolve('deny-once')
    expect(await secondPending).toEqual(selected('deny'))
    firstAnswer.resolve('allow-once')
    expect(await firstPending).toEqual(selected('once'))
    expect(firstProvider).toHaveBeenCalledOnce()
    expect(secondProvider).toHaveBeenCalledOnce()
    expect(new Set(f.records.flatMap(({ data }) => (data.phase === 'asked' ? [data.requestId] : []))).size).toBe(2)
  })

  it('does not change the managed child native never execution policy', async () => {
    const f = await fixture({ policy: 'never' })
    f.ctx.on('dsh-acp/permission-policy', async () => 'allow-once')
    expect(await f.handle()).toEqual(selected('once'))
    expect(f.ctx.approval.overrideOf(f.session)).toBe('never')
    expect(await f.ctx.approval.request({ agent: f.agent, toolName: 'native-escalation' })).toBe('rejected')
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it.each(['en', 'zh'] as const)(
    'reports a stable localized %s policy failure without leaking backend detail',
    async (locale) => {
      const f = await fixture({ locale })
      f.ctx.on('dsh-acp/permission-policy', async () => {
        throw new Error('private backend detail')
      })
      expect(await f.handle()).toEqual(cancelled)
      expect(f.notify).toHaveBeenCalledOnce()
      const issue = f.notify.mock.calls[0]![0]
      expect(issue.code).toBe('ACP_PERMISSION_POLICY_UNAVAILABLE')
      expect(issue.message).toContain(locale === 'zh' ? '本次操作未获授权' : 'This operation was not authorized')
      expect(issue.message).not.toContain('private backend detail')
      expect(f.ask).not.toHaveBeenCalled()
    },
  )

  it('a failed feedback surface cannot convert a failed policy into permission', async () => {
    const f = await fixture()
    f.notify.mockRejectedValueOnce(new Error('view unavailable'))
    f.ctx.on('dsh-acp/permission-policy', async () => 'failed')
    expect(await f.handle()).toEqual(cancelled)
    expect(f.records.map(({ data }) => data.phase)).toEqual(['asked', 'decided'])
  })
})

it('routes policy failures through existing source-attributed feedback and only accepts the exact marker', () => {
  const feedback = new AcpUiFeedback()
  let listener: ((sessionId: string, message: string) => void) | undefined
  const dispose = followAcpQuestionLimitations(
    (onError) => {
      listener = onError
      return () => {
        listener = undefined
      }
    },
    feedback,
    (id) => (id === 'child-session' ? 'Worker' : null),
  )
  listener!('child-session', 'Rule failed (ACP_PERMISSION_POLICY_UNAVAILABLE)')
  expect(feedback.getSnapshot()).toMatchObject({
    message: 'Rule failed',
    sourceSession: { id: 'child-session', title: 'Worker' },
  })
  const prior = feedback.getSnapshot()
  listener!('child-session', 'Rule failed (ACP_PERMISSION_POLICY_UNAVAILABLE) extra')
  listener!('', 'Rule failed (ACP_PERMISSION_POLICY_UNAVAILABLE)')
  expect(feedback.getSnapshot()).toBe(prior)
  dispose()
  expect(listener).toBeUndefined()
})
