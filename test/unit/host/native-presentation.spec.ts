import { ActivityRow, activityRowElement } from '../../../src/client/ui/AcpActivityNode.ts'
import { withSessionFacts } from '../../support/session-facts.ts'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import type { AcpSidecar, AcpActivityInput } from '../../../src/persistence/sidecar.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'
import type * as acp from '@agentclientprotocol/sdk'

const profile = (): AcpAgentConfig => ({ name: 'Test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const request = (sessionId: string, messages: GenerateOptions['messages']) => markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: sessionId as never, messages })
const session = (message: ReturnType<typeof user>, seq = 2) => (withSessionFacts({
  header: { cwd: '/workspace' },
  inheritedEventCount: 0,
  snapshotEvents: () => [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq, data: message },
  ],
}))

class Ledger implements DispatchLedgerStore {
  records: DispatchRecord[] = []
  async begin(record: DispatchRecord): Promise<void> {
    if (this.records.some(entry => entry.key === record.key || entry.state === 'dispatch-uncertain')) throw new Error('ACP_RECOVERY_REQUIRED')
    this.records = [record]
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const record = this.records.find(entry => entry.key === key)
    if (record !== undefined) this.records = [{ ...record, state: 'settled' }]
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> { return this.records.find(entry => entry.key === key) }
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
  const adapter = new AcpProfileAdapter('test', () => profile(), seam(), () => Object.assign(session(message), { publishPlan }), new Ledger(), undefined, () => ({
    acpSessionId: 'audit-session', start: async () => undefined, close: async () => undefined,
    prompt: async (_content, onUpdate) => {
      onUpdate({ sessionId: 'audit-session', update } as never)
      onUpdate({ sessionId: 'audit-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Progress update' } } } as never)
      return { stopReason: 'end_turn' }
    },
  }), { ...durableSidecar, upsertActivity: async (row: AcpActivityInput) => { rows.push(row) } } as never)
  for await (const chunk of adapter.stream(request('audit-session', [message]))) { void chunk }
  return rows
}

describe('native ACP activity presentation', () => {
  it('renders the text and status from ACP plan entries', () => {
    const element = ActivityRow({
      row: { dshSessionId: 's', ownerDshSessionId: 's', promptAnchorMessageId: 'u',
        activityId: 'plan:session', activitySeq: 1, revisionSeq: 1, time: 1,
        kind: 'plan', status: 'running', presentation: 'Agent plan',
        rawDetail: JSON.stringify([{ content: 'PLAN_ENTRY_MUST_BE_VISIBLE', status: 'in_progress', priority: 'high' }]),
      }, t: key => key, openFile: () => {},
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
    const rows = await captureActivity({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', status: 'completed',
      content: [{ type: 'diff', path: '/workspace/a.ts', oldText: prefix + 'OLD_TAIL', newText: prefix + 'NEW_TAIL' }],
    })
    const diff = rows.find(row => row.kind === 'diff')!
    const element = activityRowElement({ row: { ...diff, activitySeq: 1, revisionSeq: 1 }, t: key => key, open: true })
    expect(JSON.stringify(element)).toContain('NEW_TAIL')
  })
  it('retains an incomplete plan when the ACP prompt ends with a progress reply', async () => {
    const rows = await captureActivity({ sessionUpdate: 'plan', entries: [{ content: 'Work remains', status: 'in_progress', priority: 'high' }] })
    const plan = rows.filter(row => row.kind === 'plan').at(-1)
    expect(plan!.status).toBe('running')
  })
})

async function steeringFixture() {
  const rows: AcpActivityInput[] = []
  const first = user('first'), second = user('second')
  const events = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: first },
  ] as { type: string; seq: number; data: unknown }[]
  let notify: (notification: AcpSessionNotification) => void = () => {}
  let steerInput = () => {}
  const finish = Promise.withResolvers<acp.PromptResponse>()
  const view = Object.assign(withSessionFacts({ header: { cwd: '/workspace' }, snapshotEvents: () => events }), {
    watchSteering: (listener: () => void) => { steerInput = listener; return () => {} },
  })
  const update = (value: object) => notify({ sessionId: 'steering-session', update: value } as AcpSessionNotification)
  const text = (value: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
  const runtime = {
    acpSessionId: 'steering-session', canSteer: true,
    start: async () => undefined, close: async () => undefined,
    steer: vi.fn(async (_content: acp.ContentBlock[]): Promise<'injected' | 'promptRequired'> => 'injected'),
    prompt: vi.fn(async (_content: acp.ContentBlock[], onUpdate: typeof notify, signal?: AbortSignal) => {
      notify = onUpdate
      if (runtime.prompt.mock.calls.length > 1) { text('replacement'); return { stopReason: 'end_turn' } as acp.PromptResponse }
      signal?.addEventListener('abort', () => finish.resolve({ stopReason: 'cancelled' }), { once: true })
      update({ sessionUpdate: 'tool_call', toolCallId: 'old-tool', title: 'Old tool', kind: 'edit', status: 'in_progress' })
      text('before')
      return await finish.promise
    }),
  }
  const adapter = new AcpProfileAdapter('test', () => profile(), seam(), () => view, new Ledger(), undefined,
    () => runtime, { ...durableSidecar, upsertActivity: async (row: AcpActivityInput) => { rows.push(row) } } as never)
  const stream = adapter.stream(request('steering-session', [first]))[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ text: 'before' })
  const pending = stream.next()
  steerInput()
  expect((await pending).value).toMatchObject({ type: 'finish' })
  await stream.return?.()
  events.push({ type: 'step/end', seq: 3, data: { turn: 1, step: 0 } },
    { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } }, { type: 'user/message', seq: 5, data: second })
  return { rows, first, second, runtime, update, text, finish,
    next: () => adapter.stream(request('steering-session', [first, second])) }
}

it('assigns pre-ack tools to the new input, retaining late children under their original tool', async () => {
  const f = await steeringFixture()
  // This already-produced tail becomes the first block of the new native reply.
  f.text('pending old tail')
  f.runtime.steer.mockImplementation(async () => {
    f.text('new answer')
    f.update({ sessionUpdate: 'tool_call', toolCallId: 'new-tool', title: 'New tool', kind: 'read', status: 'completed' })
    f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed',
      content: [{ type: 'diff', path: '/workspace/old.txt', oldText: 'a', newText: 'b' }] })
    f.finish.resolve({ stopReason: 'end_turn' })
    return 'injected'
  })
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['pending old tail', 'new answer'])
  expect(f.rows.find(row => row.presentation === 'New tool')).toMatchObject({ promptAnchorMessageId: f.second.id, contentIndex: 2 })
  expect(f.rows.find(row => row.kind === 'diff')).toMatchObject({ promptAnchorMessageId: f.first.id })
  expect(f.runtime.prompt).toHaveBeenCalledOnce()
})

it.each(['end_turn', 'max_tokens'] as const)('preserves buffered output and %s semantics when the original prompt ends during native admission', async stopReason => {
  const f = await steeringFixture()
  f.text('completed tail')
  f.finish.resolve({ stopReason })
  // Wait for the existing prompt's completion handler, before native admission resumes.
  await vi.waitFor(() => expect(f.rows.findLast(row => row.presentation === 'Old tool')?.status).toBe('completed'))
  const chunks = []
  for await (const chunk of f.next()) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(stopReason === 'end_turn' ? ['completed tail', 'replacement'] : ['completed tail'])
  expect(f.runtime.prompt).toHaveBeenCalledTimes(stopReason === 'end_turn' ? 2 : 1)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: stopReason === 'end_turn' ? 'stop' : 'max-tokens' } })
})
