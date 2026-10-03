import { ActivityRow, activityRowElement } from '../../../src/client/ui/AcpActivityNode.ts'
import { withSessionFacts } from '../../support/session-facts.ts'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { StreamHandoff } from '../../../src/host/composition/stream-handoff.ts'
import { AcpSteeringRequestError } from '../../../src/protocol/v1/connection.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import type { AcpSidecar, AcpActivityInput } from '../../../src/persistence/sidecar.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'
import type * as acp from '@agentclientprotocol/sdk'

const profile = (): AcpAgentConfig => ({ name: 'Test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const request = (sessionId: string, messages: GenerateOptions['messages']) =>
  markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: sessionId as never, messages })
const session = (message: ReturnType<typeof user>, seq = 2) =>
  withSessionFacts({
    header: { cwd: '/workspace' },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq, data: message },
    ],
  })

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  async begin(record: DispatchRecord): Promise<void> {
    if (this.records.some((entry) => entry.key === record.key || entry.state === 'dispatch-uncertain'))
      throw new Error('ACP_RECOVERY_REQUIRED')
    this.records = [record]
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const record = this.records.find((entry) => entry.key === key)
    if (record !== undefined) this.records = [{ ...record, state: 'settled' }]
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.records.find((entry) => entry.key === key)
  }
}

function seam(): { ok: true; seam: never } {
  return { ok: true, seam: undefined as never }
}

const durableSidecar = {
  append: async () => undefined,
  readLatestBinding: async () => undefined,
  readModeIntent: async () => undefined,
  readRecoveryState: async () => undefined,
  writeRecoveryState: async () => undefined,
} as unknown as AcpSidecar

async function captureActivity(update: object, publishPlan = vi.fn()) {
  const rows: AcpActivityInput[] = []
  const message = user('audit request')
  const adapter = new AcpProfileAdapter(
    'test',
    () => profile(),
    seam(),
    () => Object.assign(session(message), { publishPlan }),
    new Ledger(),
    undefined,
    () => ({
      acpSessionId: 'audit-session',
      start: async () => undefined,
      close: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'audit-session', update } as never)
        onUpdate({
          sessionId: 'audit-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Progress update' } },
        } as never)
        return { stopReason: 'end_turn' }
      },
    }),
    {
      ...durableSidecar,
      upsertActivity: async (row: AcpActivityInput) => {
        rows.push(row)
      },
    } as never,
  )
  for await (const chunk of adapter.stream(request('audit-session', [message]))) {
    void chunk
  }
  return rows
}

async function finishWithoutVisibleText(
  hostConfirmed = false,
  update?: object,
  stopReason: acp.PromptResponse['stopReason'] = 'end_turn',
  abortAfterPrompt?: AbortController,
  locale?: string,
) {
  const message = user('delegate and report')
  const adapter = new AcpProfileAdapter(
    'test',
    () => profile(),
    seam(),
    () => session(message),
    new Ledger(),
    undefined,
    () => ({
      acpSessionId: 'report-session',
      start: async () => undefined,
      close: async () => undefined,
      prompt: async (_content, onUpdate, _signal, onTeamReport) => {
        if (update !== undefined) onUpdate({ sessionId: 'report-session', update } as never)
        if (hostConfirmed) onTeamReport?.()
        abortAfterPrompt?.abort()
        return { stopReason }
      },
    }),
    durableSidecar as never,
    undefined,
    locale === undefined ? undefined : ((() => ({ getAgent: () => ({}), locale })) as never),
  )
  const chunks = []
  const input = request('report-session', [message])
  for await (const chunk of adapter.stream({
    ...input,
    ...(abortAfterPrompt === undefined ? {} : { signal: abortAfterPrompt.signal }),
  }))
    chunks.push(chunk)
  return chunks.at(-1)
}

describe('native ACP activity presentation', () => {
  it('accepts only host-confirmed teammate report evidence for a textless normal end', async () => {
    expect(await finishWithoutVisibleText()).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } },
    })
    expect(await finishWithoutVisibleText(true)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(
      await finishWithoutVisibleText(false, {
        sessionUpdate: 'tool_call',
        toolCallId: 'fake',
        title: 'send_message',
        kind: 'other',
        status: 'completed',
      }),
    ).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } } })
    expect(
      await finishWithoutVisibleText(false, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'private reasoning only' },
      }),
    ).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } } })
    expect(await finishWithoutVisibleText(true, undefined, 'cancelled')).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted' },
    })
    expect(await finishWithoutVisibleText(true, undefined, 'max_tokens')).toMatchObject({
      type: 'finish',
      reason: { kind: 'max-tokens' },
    })
    expect(await finishWithoutVisibleText(true, undefined, 'refusal')).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_REFUSAL' } },
    })
    expect(
      await finishWithoutVisibleText(
        false,
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I cannot help with that request.' },
        },
        'refusal',
      ),
    ).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_REFUSAL' } },
    })
    expect(await finishWithoutVisibleText(false, undefined, 'max_turn_requests')).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_MAX_TURN_REQUESTS' } },
    })
    expect(await finishWithoutVisibleText(false, undefined, 'refusal', undefined, 'zh-CN')).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'ACP_REFUSAL', message: 'ACP 智能体拒绝了此请求。' },
      },
    })
    expect(
      await finishWithoutVisibleText(
        false,
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Partial answer before the limit.' },
        },
        'max_turn_requests',
      ),
    ).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_MAX_TURN_REQUESTS' } },
    })
    expect(await finishWithoutVisibleText(true, undefined, 'end_turn', new AbortController())).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } },
    })
  })
  it('renders the text and status from ACP plan entries', () => {
    const element = ActivityRow({
      row: {
        dshSessionId: 's',
        ownerDshSessionId: 's',
        promptAnchorMessageId: 'u',
        activityId: 'plan:session',
        activitySeq: 1,
        revisionSeq: 1,
        time: 1,
        kind: 'plan',
        status: 'running',
        presentation: 'Agent plan',
        rawDetail: JSON.stringify([{ content: 'PLAN_ENTRY_MUST_BE_VISIBLE', status: 'in_progress', priority: 'high' }]),
      },
      t: (key) => key,
      openFile: () => {},
    })
    expect(JSON.stringify(element)).toContain('PLAN_ENTRY_MUST_BE_VISIBLE')
  })
  it('projects valid plans into native state and clears explicit removal', async () => {
    const publish = vi.fn()
    const plan = [{ content: 'Work remains', status: 'pending' }]
    await captureActivity({ sessionUpdate: 'plan', entries: plan }, publish)
    expect(publish).toHaveBeenCalledWith(plan)
    await captureActivity({ sessionUpdate: 'plan_removed' }, publish)
    expect(publish).toHaveBeenLastCalledWith([])
  })

  it('preserves full old/new file text for native diff comparison', async () => {
    const prefix = 'unchanged line\n'.repeat(400)
    const rows = await captureActivity({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/workspace/a.ts', oldText: prefix + 'OLD_TAIL', newText: prefix + 'NEW_TAIL' }],
    })
    const diff = rows.find((row) => row.kind === 'diff')!
    const element = activityRowElement({
      row: { ...diff, activitySeq: 1, revisionSeq: 1 },
      t: (key) => key,
      open: true,
    })
    expect(JSON.stringify(element)).toContain('NEW_TAIL')
  })
  it('retains an incomplete plan when the ACP prompt ends with a progress reply', async () => {
    const rows = await captureActivity({
      sessionUpdate: 'plan',
      entries: [{ content: 'Work remains', status: 'in_progress', priority: 'high' }],
    })
    const plan = rows.filter((row) => row.kind === 'plan').at(-1)
    expect(plan!.status).toBe('running')
  })
})

async function steeringFixture(
  withVisiblePrefix = true,
  rejectOnCancel = false,
  sidecar: AcpSidecar = durableSidecar as never,
) {
  const rows: AcpActivityInput[] = []
  const first = user('first'),
    second = user('second')
  const events = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: first },
  ] as { type: string; seq: number; data: unknown }[]
  let notify: (notification: AcpSessionNotification) => void = () => {}
  let steerInput = () => {}
  let onCancel = () => {}
  const offTurnEnd = vi.fn()
  const offRouteChange = vi.fn()
  const controlsChanged = vi.fn()
  let report: () => void = () => {}
  const finish = Promise.withResolvers<acp.PromptResponse>()
  const view = Object.assign(withSessionFacts({ header: { cwd: '/workspace' }, snapshotEvents: () => events }), {
    watchSteering: (listener: () => void) => {
      steerInput = listener
      return () => {}
    },
    watchTurnEnd: (_listener: () => void) => offTurnEnd,
    watchRouteChange: (_provider: string, _listener: () => void) => offRouteChange,
  })
  const update = (value: object) => notify({ sessionId: 'steering-session', update: value } as AcpSessionNotification)
  const text = (value: string) =>
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
  const runtime = {
    acpSessionId: 'steering-session',
    canSteer: true,
    start: async () => undefined,
    close: async () => undefined,
    steer: vi.fn(
      async (_content: acp.ContentBlock[], onDispatch?: () => void): Promise<'injected' | 'promptRequired'> => {
        onDispatch?.()
        return 'injected'
      },
    ),
    prompt: vi.fn(
      async (
        _content: acp.ContentBlock[],
        onUpdate: typeof notify,
        signal?: AbortSignal,
        onTeamReport?: () => void,
      ) => {
        notify = onUpdate
        report = () => onTeamReport?.()
        if (runtime.prompt.mock.calls.length > 1) {
          text('replacement')
          return { stopReason: 'end_turn' } as acp.PromptResponse
        }
        signal?.addEventListener(
          'abort',
          () => {
            if (rejectOnCancel) {
              onCancel()
              finish.reject(new Error('old prompt failed while draining'))
            } else finish.resolve({ stopReason: 'cancelled' })
          },
          { once: true },
        )
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'old-tool',
          title: 'Old tool',
          kind: 'edit',
          status: 'in_progress',
        })
        if (withVisiblePrefix) text('before')
        else update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } })
        return await finish.promise
      },
    ),
  }
  const adapter = new AcpProfileAdapter(
    'test',
    () => profile(),
    seam(),
    () => view,
    new Ledger(),
    undefined,
    () => runtime,
    {
      ...sidecar,
      upsertActivity: async (row: AcpActivityInput) => {
        rows.push(row)
      },
    } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controlsChanged,
  )
  const stream = adapter.stream(request('steering-session', [first]))[Symbol.asyncIterator]()
  if (withVisiblePrefix) expect((await stream.next()).value).toMatchObject({ text: 'before' })
  else expect((await stream.next()).value).toMatchObject({ type: 'reasoning-delta' })
  const pending = stream.next()
  steerInput()
  expect((await pending).value).toMatchObject({ type: 'finish' })
  await stream.return?.()
  events.push(
    { type: 'step/end', seq: 3, data: { turn: 1, step: 0 } },
    { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 5, data: second },
  )
  return {
    rows,
    first,
    second,
    events,
    adapter,
    offTurnEnd,
    offRouteChange,
    controlsChanged,
    onCancel: (callback: () => void) => {
      onCancel = callback
    },
    runtime,
    update,
    text,
    steerInput: () => steerInput(),
    finish,
    report: () => report(),
    next: (messages: ReturnType<typeof user>[] = [first, second]) =>
      adapter.stream(request('steering-session', messages)),
  }
}

it('assigns pre-ack tools to the new input, retaining late children under their original tool', async () => {
  const f = await steeringFixture()
  // This already-produced tail becomes the first block of the new native reply.
  f.text('pending old tail')
  f.runtime.steer.mockImplementation(async (_content, onDispatch) => {
    onDispatch?.()
    f.text('new answer')
    f.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'new-tool',
      title: 'New tool',
      kind: 'read',
      status: 'completed',
    })
    f.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'old-tool',
      status: 'completed',
      content: [{ type: 'diff', path: '/workspace/old.txt', oldText: 'a', newText: 'b' }],
    })
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual([
    'pending old tail',
    'new answer',
  ])
  expect(f.rows.find((row) => row.presentation === 'New tool')).toMatchObject({
    promptAnchorMessageId: f.second.id,
    contentIndex: 2,
  })
  expect(f.rows.find((row) => row.kind === 'diff')).toMatchObject({ promptAnchorMessageId: f.first.id })
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
})

it('keeps the healthy suspended owner after local admission fails, then resumes it for valid input', async () => {
  const f = await steeringFixture()
  const closeRuntime = vi.spyOn(f.runtime, 'close')
  const liveEvents = [...f.events]
  f.events.splice(0, f.events.length, { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } })
  const error = await (async () => {
    try {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    } catch (caught) {
      return caught
    }
    throw new Error('expected local admission failure')
  })()
  expect(error).toMatchObject({ code: 'ACP_STEERING_FAILED' })
  expect((f.adapter as unknown as { handoffs: Map<string, unknown> }).handoffs.has('steering-session')).toBe(true)
  expect(f.runtime.steer).not.toHaveBeenCalled()
  expect(closeRuntime).not.toHaveBeenCalled()

  f.events.splice(0, f.events.length, ...liveEvents)
  f.runtime.steer.mockImplementation(async (_content, onDispatch) => {
    onDispatch?.()
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  expect(f.runtime.steer).toHaveBeenCalledOnce()
  expect(closeRuntime).not.toHaveBeenCalled()
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  await f.adapter.close()
})

it('restores the prior projection when the steering connection proves it failed before dispatch', async () => {
  const f = await steeringFixture()
  f.runtime.steer.mockRejectedValue(new AcpSteeringRequestError(false, new Error('connection is already closed')))
  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_STEERING_FAILED' })
  f.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'old-prompt-late-tool',
    title: 'Late old prompt tool',
    kind: 'read',
    status: 'in_progress',
  })
  f.runtime.steer.mockImplementation(async (_content, onDispatch) => {
    onDispatch?.()
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  for await (const _chunk of f.next()) {
    /* consume */
  }
  expect(f.rows.find((row) => row.presentation === 'Late old prompt tool')?.promptAnchorMessageId).toBe(f.first.id)
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
  await f.adapter.close()
})

it('keeps indices monotonic and emits late old-prompt output once after promptRequired', async () => {
  const f = await steeringFixture()
  f.runtime.steer.mockImplementationOnce(async (_content, onDispatch) => {
    onDispatch?.()
    // The Agent can produce old-prompt output after dispatch but before it
    // acknowledges that steering needs a new native prompt.
    f.text('late old-prompt output')
    return 'promptRequired'
  })
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  const textChunks = chunks.filter((chunk) => chunk.type === 'text-delta')
  expect(textChunks.map((chunk) => chunk.text)).toEqual(['late old-prompt output', 'replacement'])
  const indices = textChunks.map((chunk) => chunk.index)
  expect(indices.every((index): index is number => typeof index === 'number')).toBe(true)
  expect(indices).toEqual([...indices].sort((left, right) => left - right))
  expect(new Set(indices).size).toBe(indices.length)
  expect(f.runtime.prompt).toHaveBeenCalledTimes(2)
  await f.adapter.close()
})

it('keeps an outcome-unknown gate after an invoked steering RPC rejects', async () => {
  let recovery: unknown
  const sidecar = {
    ...durableSidecar,
    readRecoveryState: async () => recovery,
    writeRecoveryState: async (state: unknown) => {
      recovery = state
    },
  } as unknown as AcpSidecar
  const f = await steeringFixture(true, false, sidecar)
  f.runtime.steer.mockRejectedValue(new Error('steering response was lost'))
  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_STEERING_FAILED' })
  expect(recovery).toMatchObject({ kind: 'outcome-unknown' })

  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
  await f.adapter.close()
})

it('keeps a local recovery gate if persisting the steering uncertainty fails', async () => {
  const sidecar = {
    ...durableSidecar,
    clearDispatch: async () => {},
    readLatestBinding: async () => undefined,
    readRecoveryState: async () => ({
      dshSessionId: 'steering-session',
      kind: 'healthy' as const,
      updatedAt: 1,
    }),
    writeRecoveryState: async (state: { kind?: string }) => {
      if (state.kind === 'outcome-unknown') throw new Error('sidecar unavailable')
    },
  } as unknown as AcpSidecar
  const f = await steeringFixture(true, false, sidecar)
  f.controlsChanged.mockImplementationOnce(() => {
    throw new Error('recovery snapshot subscriber failed')
  })
  const controlsChangedBeforeFailure = f.controlsChanged.mock.calls.length
  f.runtime.steer.mockRejectedValue(new Error('steering response was lost'))
  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_STEERING_FAILED' })
  expect(f.controlsChanged.mock.calls.slice(controlsChangedBeforeFailure)).toContainEqual(['steering-session'])
  const controlsChangedAfterFailure = f.controlsChanged.mock.calls.length
  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
  expect(f.controlsChanged).toHaveBeenCalledTimes(controlsChangedAfterFailure)
  expect(f.adapter.recoveryStateFallback('steering-session')).toMatchObject({ kind: 'outcome-unknown' })
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
  await f.adapter.rebindBlank('steering-session')
  expect(f.adapter.recoveryStateFallback('steering-session')).toBeUndefined()
  await f.adapter.close()
})

it('retires a failed suspended drain, releases listeners, and starts the next owner once', async () => {
  const f = await steeringFixture(true, true)
  const owners = (f.adapter as unknown as { handoffs: Map<string, unknown> }).handoffs
  const replacement = {
    stream: new StreamHandoff(),
    generation: undefined,
    options: request('steering-session', [f.first, f.second]),
  }
  f.onCancel(() => owners.set('steering-session', replacement))
  f.offTurnEnd.mockImplementationOnce(() => {
    throw new Error('listener disposer failed')
  })
  f.runtime.canSteer = false
  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toThrow('old prompt failed while draining')
  expect(f.offTurnEnd).toHaveBeenCalledOnce()
  expect(f.offRouteChange).toHaveBeenCalledOnce()
  expect(owners.get('steering-session')).toBe(replacement)
  owners.delete('steering-session')

  await expect(
    (async () => {
      for await (const _chunk of f.next()) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
  await f.adapter.close()
})

it('does not let an earlier or late teammate report bless a newly steered request', async () => {
  const f = await steeringFixture(false)
  f.report()
  f.runtime.steer.mockImplementation(async (_content, onDispatch) => {
    onDispatch?.()
    f.report()
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } },
  })
})

it('keeps a later input ordered behind a steering request whose acknowledgement is pending', async () => {
  const f = await steeringFixture()
  const third = user('third')
  const acknowledgement = Promise.withResolvers<void>()
  f.runtime.steer.mockImplementation(async (_content, onDispatch) => {
    onDispatch?.()
    await acknowledgement.promise
    f.text('injected second-input answer')
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  const firstInput = (async () => {
    const chunks = []
    for await (const chunk of f.next()) chunks.push(chunk)
    return chunks
  })()
  await vi.waitFor(() => expect(f.runtime.steer).toHaveBeenCalledOnce())

  f.events.push(
    { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 7, data: { turn: 1, step: 2 } },
    { type: 'user/message', seq: 8, data: third },
  )
  f.steerInput()
  acknowledgement.resolve()
  const firstChunks = await firstInput
  expect(firstChunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1)

  const nextChunks = []
  for await (const chunk of f.next([f.first, f.second, third])) nextChunks.push(chunk)
  expect(nextChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toContain(
    'injected second-input answer',
  )
  expect(f.runtime.steer).toHaveBeenCalledOnce()
  expect(f.runtime.prompt).toHaveBeenCalledTimes(2)
  expect(nextChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  await f.adapter.close()
})

it.each(['end_turn', 'max_tokens'] as const)(
  'preserves buffered output and %s semantics when the original prompt ends during native admission',
  async (stopReason) => {
    const f = await steeringFixture()
    f.text('completed tail')
    f.finish.resolve({ stopReason })
    // Wait for the existing prompt's completion handler, before native admission resumes.
    await vi.waitFor(() => expect(f.rows.findLast((row) => row.presentation === 'Old tool')?.status).toBe('completed'))
    const chunks = []
    for await (const chunk of f.next()) chunks.push(chunk)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual(
      stopReason === 'end_turn' ? ['completed tail', 'replacement'] : ['completed tail'],
    )
    expect(f.runtime.prompt).toHaveBeenCalledTimes(stopReason === 'end_turn' ? 2 : 1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: stopReason === 'end_turn' ? 'stop' : 'max-tokens' },
    })
  },
)
