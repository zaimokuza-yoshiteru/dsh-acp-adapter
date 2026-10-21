import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, markAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpActivityInput, AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'
import type { AcpHostToolControlOutcome } from '../../../src/contract/tool-control-outcome.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const adapters: AcpProfileAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close()
})

const tool = (status: string, text = 'Tool failure details'): AcpSessionNotification =>
  ({
    sessionId: 'empty-response-remote',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'isolated-write',
      title: 'Write isolated marker',
      kind: 'edit',
      status,
      content: [{ type: 'content', content: { type: 'text', text } }],
    },
  }) as AcpSessionNotification

async function run(options: {
  updates?: readonly AcpSessionNotification[]
  profileId?: string
  locale?: string
  localeFails?: boolean
  stopReason?: acp.PromptResponse['stopReason']
  hostToolSucceeded?: boolean
  hostToolSucceededAfterUpdate?: number
  steeredUpdates?: readonly AcpSessionNotification[]
  hostToolSucceededAfterSteering?: boolean
  hostConclusion?: 'report' | 'conclude'
  controlOutcome?: AcpHostToolControlOutcome | undefined
}) {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use the tool.' }] })
  const events: { type: string; seq: number; data: unknown }[] = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: message },
  ]
  let pendingInput = () => {}
  const current = Object.assign(
    withSessionFacts({
      header: { cwd: '/workspace' },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
    }),
    {
      watchSteering: (listener: () => void) => {
        pendingInput = listener
        return () => {}
      },
    },
  )
  const settled = Promise.withResolvers<acp.PromptResponse>()
  let notify: (notification: AcpSessionNotification) => void = () => {}
  let successfulHostResult: (() => void) | undefined
  let dispatch: DispatchRecord | undefined
  const rows: AcpActivityInput[] = []
  const sidecar = {
    append: async () => undefined,
    readLatestBinding: async () => undefined,
    readModeIntent: async () => undefined,
    readRecoveryState: async () => undefined,
    writeRecoveryState: async () => undefined,
    writeOptionSnapshot: async () => undefined,
    upsertActivity: async (row: AcpActivityInput) => {
      rows.push(row)
    },
  } as unknown as AcpSidecar
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'empty-response-remote',
    start: async () => undefined,
    close: async () => undefined,
    toolControlOutcome: () => options.controlOutcome,
    ...(options.steeredUpdates === undefined
      ? {}
      : {
          canSteer: true,
          steer: async (_content: acp.ContentBlock[], onDispatch?: () => void) => {
            onDispatch?.()
            for (const notification of options.steeredUpdates ?? []) notify(notification)
            if (options.hostToolSucceededAfterSteering) successfulHostResult?.()
            settled.resolve({ stopReason: options.stopReason ?? 'end_turn' })
            return 'injected' as const
          },
        }),
    prompt: async (_content, onUpdate, _signal, onReport, onConcluded, onSuccessfulToolResult) => {
      notify = onUpdate
      successfulHostResult = onSuccessfulToolResult
      for (const [index, notification] of (options.updates ?? []).entries()) {
        onUpdate(notification)
        if (options.hostToolSucceededAfterUpdate === index) onSuccessfulToolResult?.()
      }
      if (options.hostToolSucceeded) onSuccessfulToolResult?.()
      if (options.hostConclusion === 'report') onReport?.()
      if (options.hostConclusion === 'conclude') onConcluded?.()
      if (options.steeredUpdates !== undefined) return await settled.promise
      return { stopReason: options.stopReason ?? 'end_turn' }
    },
  }
  const adapter = new AcpProfileAdapter(
    options.profileId ?? 'test',
    () => ({ name: 'Test', command: 'fixture', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    () => current,
    {
      begin: async (record) => {
        dispatch = record
      },
      read: async () => dispatch,
      settle: async () => {
        if (dispatch !== undefined) dispatch = { ...dispatch, state: 'settled' }
      },
    },
    undefined,
    () => runtime,
    sidecar,
    undefined,
    () => {
      if (options.localeFails) throw new Error('locale unavailable')
      return { locale: options.locale, getAgent: () => ({}) } as never
    },
  )
  adapters.push(adapter)
  const chunks: StreamChunk[] = []
  const request = (messages = [message]) =>
    markAgentLoopRequest({
      provider: 'acp-test',
      model: 'test',
      sessionId: 'empty-response-host' as never,
      messages,
    })
  let response = adapter.stream(request())
  if (options.steeredUpdates !== undefined) {
    const initial = response[Symbol.asyncIterator]()
    const first = await initial.next()
    expect(first.done).toBe(false)
    if (!first.done) chunks.push(first.value)
    const pending = initial.next()
    pendingInput()
    const interrupted = await pending
    expect(interrupted.value).toMatchObject({ type: 'finish' })
    await initial.return?.()
    const next = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue here.' }] })
    events.push(
      { type: 'step/end', seq: 3, data: { turn: 1, step: 0 } },
      { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 5, data: next },
    )
    response = adapter.stream(request([message, next]))
  }
  for await (const chunk of response) chunks.push(chunk)
  return { chunks, finish: chunks.find((chunk) => chunk.type === 'finish'), rows, dispatch }
}

describe('empty ACP responses after a failed tool', () => {
  const visibleReply = (text: string): AcpSessionNotification => ({
    sessionId: 'empty-response-remote',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })

  it('does not treat Devin text before a failed operation as a post-operation response', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [
        visibleReply('I will attempt the requested operation.'),
        tool('running'),
        tool('failed', 'The operation was rejected.'),
      ],
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
    expect(result.chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      expect.objectContaining({ text: 'I will attempt the requested operation.' }),
    ])
    expect(result.dispatch?.state).toBe('settled')
  })

  it('does not invalidate a Devin explanation when a failed tool status arrives late', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [tool('running'), visibleReply('The operation was rejected.'), tool('failed')],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not infer an operation start from a first-seen terminal failure after an explanation', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('The operation was rejected.'), tool('failed')],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not generalize the Devin missing follow-up safeguard to an unverified provider', async () => {
    const result = await run({
      updates: [visibleReply('I will attempt the requested operation.'), tool('running'), tool('failed')],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('replays the observed Devin catalog-success, preamble, denied-write and reasoning-only ending', async () => {
    const catalog = (status: string) => {
      const notification = tool(status, 'write')
      return { ...notification, update: { ...notification.update, toolCallId: 'catalog' } } as AcpSessionNotification
    }
    const result = await run({
      profileId: 'devin',
      locale: 'zh-CN',
      updates: [
        visibleReply(
          "I'll attempt the required DSH write call. First, let me discover the tool schema on the `dsh` server.",
        ),
        catalog('running'),
        catalog('completed'),
        {
          sessionId: 'empty-response-remote',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Now attempting the write.' },
          },
        },
        tool('running'),
        tool('failed', 'Permission to call write was denied by a project-local rule.'),
      ],
    })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_INCOMPLETE_TOOL_RESPONSE',
          message: '工具调用失败后，Devin 未返回后续回复。请查看失败步骤的详情。',
        },
      },
    })
    expect(result.dispatch?.state).toBe('settled')
    expect(result.rows.some((row) => row.kind === 'tool' && row.status === 'failed')).toBe(true)
  })

  it('does not let a prior successful Host result excuse a later failed Devin operation', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('An earlier action completed.'), tool('running'), tool('failed')],
      hostToolSucceededAfterUpdate: 0,
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it('does not let an anonymous parallel Host success cover a failed operation without a follow-up', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('I will attempt the action.'), tool('running'), tool('failed')],
      hostToolSucceeded: true,
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it('preserves the pre-existing empty Devin response contract for a delivered Host result', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [tool('running'), tool('failed')],
      hostToolSucceeded: true,
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each(['report', 'conclude'] as const)('retains an explicit Host %s after failed work', async (hostConclusion) => {
    const result = await run({
      profileId: 'devin',
      hostConclusion,
      updates: [visibleReply('I will attempt the action.'), tool('running'), tool('failed')],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each(['completed', 'cancelled', 'running'])(
    'retains Devin completion when the later operation is %s rather than failed',
    async (status) => {
      const result = await run({
        profileId: 'devin',
        updates: [visibleReply('Existing response.'), tool(status, 'denied failed permission')],
      })
      expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
    },
  )

  it('keeps a later real response and does not inspect its wording', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [
        visibleReply('Initial text.'),
        tool('running'),
        tool('failed'),
        visibleReply('The result is shown above.'),
      ],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not accept later whitespace or private reasoning as a visible follow-up', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [
        visibleReply('Initial text.'),
        tool('running'),
        tool('failed'),
        visibleReply(' \n '),
        {
          sessionId: 'empty-response-remote',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private reasoning.' } },
        },
      ],
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it('does not let an earlier parallel tool reply cover a subsequently started failed operation', async () => {
    const parallel = {
      ...tool('running'),
      update: { ...tool('running').update, toolCallId: 'parallel' },
    } as AcpSessionNotification
    const result = await run({
      profileId: 'devin',
      updates: [parallel, visibleReply('Earlier tool result.'), tool('running'), tool('failed')],
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it('keeps a current reply when a foreign-session tool fails later', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('Current reply.'), { ...tool('failed'), sessionId: 'foreign' }],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not carry an earlier anchor failure into a new steered response', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('Earlier response.'), tool('failed')],
      steeredUpdates: [visibleReply('New admitted response.')],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not let earlier-anchor text or a callback after steering cover a new failed operation', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('Earlier response.')],
      steeredUpdates: [tool('running'), tool('failed')],
      hostToolSucceededAfterSteering: true,
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it.each([
    ['cancelled', 'aborted', 'ACP_ABORTED'],
    ['refusal', 'error', 'ACP_REFUSAL'],
    ['max_turn_requests', 'error', 'ACP_MAX_TURN_REQUESTS'],
    ['max_tokens', 'max-tokens', undefined],
  ] as const)('preserves Devin %s with preamble-only failed work', async (stopReason, kind, code) => {
    const result = await run({
      profileId: 'devin',
      updates: [visibleReply('Initial text.'), tool('running'), tool('failed')],
      stopReason,
    })
    expect(result.finish).toMatchObject({ reason: { kind, ...(code === undefined ? {} : { failure: { code } }) } })
  })

  const controlOutcome: AcpHostToolControlOutcome = {
    source: 'dsh-tool-bridge',
    kind: 'deferred-team-message',
    dshSessionId: 'empty-response-host',
    toolCallId: 'wait-control',
    tool: 'wait_agent',
    executed: false,
  }
  const deferredWait: AcpSessionNotification = {
    sessionId: 'empty-response-remote',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'wait-control',
      name: 'wait_agent',
      title: 'wait_agent',
      kind: 'other',
      status: 'failed',
    },
  }

  it('does not mistake a Host-proven deferred wait after Devin text for an unanswered failure', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [
        visibleReply('Existing response.'),
        { ...deferredWait, update: { ...deferredWait.update, status: 'running' } } as AcpSessionNotification,
        deferredWait,
      ],
      controlOutcome,
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('does not accept a mismatched control proof to hide a Devin failure after its preamble', async () => {
    const result = await run({
      profileId: 'devin',
      updates: [
        visibleReply('Existing response.'),
        { ...deferredWait, update: { ...deferredWait.update, status: 'running' } } as AcpSessionNotification,
        deferredWait,
      ],
      controlOutcome: { ...controlOutcome, dshSessionId: 'foreign' },
    })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_INCOMPLETE_TOOL_RESPONSE' } },
    })
  })

  it('does not call a Host-proven unexecuted wait a failed operation or a successful answer', async () => {
    const result = await run({ updates: [deferredWait], controlOutcome })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message: 'ACP agent completed without a visible response',
        },
      },
    })
    expect(result.rows.find((row) => row.kind === 'tool')?.status).toBe('failed')
    expect(result.chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
  })

  it.each([
    undefined,
    { ...controlOutcome, dshSessionId: 'other-owner' },
    { ...controlOutcome, toolCallId: 'other-call' },
  ])('keeps failed-tool diagnostics without an exactly matching Host proof (%j)', async (proof) => {
    const result = await run({ updates: [deferredWait], controlOutcome: proof })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message:
            'A tool call failed, and the ACP agent ended this turn without a visible response. See the failed step for details.',
        },
      },
    })
  })

  it('does not let a deferred wait conceal another failed tool in the same turn', async () => {
    const result = await run({ updates: [deferredWait, tool('failed')], controlOutcome })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message:
            'A tool call failed, and the ACP agent ended this turn without a visible response. See the failed step for details.',
        },
      },
    })
  })

  it.each([
    [
      'en',
      'A tool call failed, and the ACP agent ended this turn without a visible response. See the failed step for details.',
    ],
    ['zh-CN', '工具调用失败，ACP 智能体结束本轮时未返回可见回复。请查看失败步骤的详情。'],
  ])('explains typed tool failure in %s while preserving the failed turn', async (locale, message) => {
    const result = await run({ locale, updates: [tool('running'), tool('failed', 'Project rule denied this call')] })
    expect(result.finish).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message } },
    })
    expect(result.chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
    expect(result.rows.some((row) => row.kind === 'tool' && row.status === 'failed')).toBe(true)
    expect(result.dispatch?.state).toBe('settled')
  })

  it.each(['completed', 'running', 'cancelled'])(
    'does not infer failure from deny words on a %s tool',
    async (status) => {
      const result = await run({ updates: [tool(status, 'Denied failed error permission policy')] })
      expect(result.finish).toMatchObject({
        reason: {
          kind: 'error',
          failure: {
            code: 'ACP_NO_VISIBLE_RESPONSE',
            message: 'ACP agent completed without a visible response',
          },
        },
      })
    },
  )

  it('does not use a different ACP session tool failure as root-turn evidence', async () => {
    const result = await run({ updates: [{ ...tool('failed'), sessionId: 'another-remote' }] })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message: 'ACP agent completed without a visible response',
        },
      },
    })
  })

  it('localizes an empty response without inventing a failed operation', async () => {
    const result = await run({ locale: 'zh-CN' })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message: 'ACP 智能体结束本轮时未返回可见回复。',
        },
      },
    })
  })

  it('keeps locale lookup failure presentation-only', async () => {
    const result = await run({ localeFails: true, updates: [tool('failed')] })
    expect(result.finish).toMatchObject({
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message:
            'A tool call failed, and the ACP agent ended this turn without a visible response. See the failed step for details.',
        },
      },
    })
    expect(result.dispatch?.state).toBe('settled')
  })

  it('keeps the existing successful Host tool-result completion', async () => {
    const result = await run({ updates: [tool('failed')], hostToolSucceeded: true })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each([
    ['cancelled', 'aborted', 'ACP_ABORTED'],
    ['refusal', 'error', 'ACP_REFUSAL'],
    ['max_turn_requests', 'error', 'ACP_MAX_TURN_REQUESTS'],
    ['max_tokens', 'max-tokens', undefined],
  ] as const)('preserves %s after a failed tool', async (stopReason, kind, code) => {
    const result = await run({ updates: [tool('failed')], stopReason })
    expect(result.finish).toMatchObject({ reason: { kind, ...(code === undefined ? {} : { failure: { code } }) } })
  })

  it('retains an actual assistant explanation after denial', async () => {
    const result = await run({
      updates: [
        tool('failed'),
        {
          sessionId: 'empty-response-remote',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'The project rule denied this write.' },
          },
        },
      ],
    })
    expect(result.finish).toMatchObject({ reason: { kind: 'stop' } })
    expect(result.chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      expect.objectContaining({ text: 'The project rule denied this write.' }),
    ])
  })
})
