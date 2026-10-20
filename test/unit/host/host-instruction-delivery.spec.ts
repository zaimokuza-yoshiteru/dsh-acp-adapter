import type * as acp from '@agentclientprotocol/sdk'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (text: string) => ({ ...user(text), role: 'system' as const })
const textOf = (prompt: readonly acp.ContentBlock[]) =>
  prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
const consume = async (stream: AsyncIterable<StreamChunk>) => {
  for await (const _chunk of stream) {
    /* wait for the public stream to settle */
  }
}

async function fixture(activeText = 'B active') {
  const first = user('completed A turn')
  const second = user('ongoing B turn')
  const history = [first]
  const events = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: first },
  ] as { type: string; seq: number; data: unknown }[]
  let turn = 1
  let step = 0
  const request = (instructions: string): GenerateOptions =>
    markAgentLoopRequest({
      provider: 'acp-test',
      model: 'model-a',
      sessionId: 'host-instructions' as never,
      messages: [system(instructions), ...history],
    })
  const admit = (message: ReturnType<typeof user>, newTurn = false) => {
    events.push({ type: 'step/end', seq: events.length + 1, data: { turn, step } })
    if (newTurn) {
      turn += 1
      step = 0
    } else step += 1
    events.push({ type: 'step/start', seq: events.length + 1, data: { turn, step } })
    events.push({ type: 'user/message', seq: events.length + 1, data: message })
    history.push(message)
  }
  let steerInput = () => {}
  let notify: (notification: AcpSessionNotification) => void = () => {}
  const finish = Promise.withResolvers<acp.PromptResponse>()
  const oldSettled = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<void>()
  let recovery: unknown
  let dispatch: DispatchRecord | undefined
  let settledCount = 0
  const ledger: DispatchLedgerStore = {
    async begin(record) {
      if (dispatch?.state === 'dispatch-uncertain') throw new Error('ACP_RECOVERY_REQUIRED')
      dispatch = record
    },
    async settle() {
      if (dispatch !== undefined) dispatch = { ...dispatch, state: 'settled' }
      if (++settledCount === 2) oldSettled.resolve()
    },
    async read() {
      return dispatch
    },
  }
  const sent: acp.ContentBlock[][] = []
  const injected: acp.ContentBlock[][] = []
  const view = Object.assign(withSessionFacts({ header: { cwd: '/workspace' }, snapshotEvents: () => events }), {
    watchSteering: (listener: () => void) => {
      steerInput = listener
      return () => {}
    },
  })
  const say = (text: string) =>
    notify({
      sessionId: 'host-instructions',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
  let inject = async (_prompt: acp.ContentBlock[]): Promise<'injected' | 'promptRequired'> => 'injected'
  const runtime = {
    acpSessionId: 'host-instructions',
    canSteer: true,
    start: async () => undefined,
    close: async () => undefined,
    prompt: async (content: acp.ContentBlock[], onUpdate: typeof notify) => {
      sent.push(content)
      notify = onUpdate
      say(sent.length === 2 ? activeText : 'completed')
      if (sent.length === 2) return await finish.promise
      return { stopReason: 'end_turn' } as acp.PromptResponse
    },
    steer: async (content: acp.ContentBlock[], onDispatch?: () => void) => {
      injected.push(content)
      onDispatch?.()
      return await inject(content)
    },
  }
  const sidecar = {
    append: async () => undefined,
    readLatestBinding: async () => undefined,
    readModeIntent: async () => undefined,
    readRecoveryState: async () => recovery,
    writeRecoveryState: async (value: { kind: string }) => {
      recovery = value
      if (value.kind === 'outcome-unknown') failed.resolve()
    },
    writeOptionSnapshot: async () => undefined,
  } as unknown as AcpSidecar
  const adapter = new AcpProfileAdapter(
    'test',
    () => ({ name: 'Test', command: 'agent', args: ['acp'], env: {} }),
    { ok: true, seam: undefined as never },
    () => view,
    ledger,
    undefined,
    () => runtime,
    sidecar,
  )
  await consume(adapter.stream(request('HOST_A')))
  admit(second, true)
  let stream = adapter.stream(request('HOST_B'))[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ type: 'text-delta', text: activeText })
  return {
    sent,
    injected,
    finish,
    oldSettled: oldSettled.promise,
    failed: failed.promise,
    onInject: (callback: typeof inject) => {
      inject = callback
    },
    async steer(instructions: string) {
      const pending = stream.next()
      steerInput()
      expect((await pending).value).toMatchObject({ type: 'finish' })
      await stream.return?.()
      admit(user(`steering ${history.length}`))
      stream = adapter.stream(request(instructions))[Symbol.asyncIterator]()
      return { next: () => stream.next(), [Symbol.asyncIterator]: () => stream }
    },
    followup(instructions: string) {
      admit(user('followup'), true)
      return adapter.stream(request(instructions))
    },
    say,
    async close() {
      finish.resolve({ stopReason: 'end_turn' })
      await adapter.close()
    },
  }
}

it('compares steering with the current prompt and later confirmed injections', async () => {
  const f = await fixture()
  try {
    f.onInject(async () => {
      f.say('injected A')
      return 'injected'
    })
    const first = await f.steer('HOST_A')
    expect((await first.next()).value).toMatchObject({ type: 'text-delta', text: 'injected A' })
    expect(textOf(f.injected[0]!)).toContain('HOST_A')
    f.onInject(async () => {
      f.say('same A')
      f.finish.resolve({ stopReason: 'end_turn' })
      return 'injected'
    })
    await consume(await f.steer('HOST_A'))
    expect(textOf(f.injected[1]!)).not.toContain('Current host instructions')
    await consume(f.followup('HOST_A'))
    expect(textOf(f.sent.at(-1)!)).not.toContain('Current host instructions')
  } finally {
    await f.close()
  }
})

it('keeps the old instructions when promptRequired follows an already settled end_turn', async () => {
  const f = await fixture()
  try {
    f.onInject(async () => {
      f.finish.resolve({ stopReason: 'end_turn' })
      await f.oldSettled
      return 'promptRequired'
    })
    await consume(await f.steer('HOST_C'))
    expect(textOf(f.sent[2]!)).toContain('HOST_C')
    await consume(f.followup('HOST_C'))
    expect(textOf(f.sent[3]!)).not.toContain('Current host instructions')
  } finally {
    await f.close()
  }
})

it('sends an explicit empty replacement and retains it after a confirmed injection', async () => {
  const f = await fixture()
  try {
    f.onInject(async () => {
      f.finish.resolve({ stopReason: 'end_turn' })
      await f.oldSettled
      return 'injected'
    })
    await consume(await f.steer(''))
    expect(textOf(f.injected[0]!)).toContain('No additional host instructions.')
    await consume(f.followup(''))
    expect(textOf(f.sent.at(-1)!)).not.toContain('Current host instructions')
  } finally {
    await f.close()
  }
})

it.each(['cancelled', 'max_tokens', 'refusal'] as const)(
  'does not certify host instructions from a late steering ACK after %s',
  async (stopReason) => {
    const f = await fixture()
    try {
      f.onInject(async () => {
        f.finish.resolve({ stopReason })
        await f.oldSettled
        return 'injected'
      })
      await consume(await f.steer('HOST_C'))
      await consume(f.followup('HOST_C'))
      expect(textOf(f.sent.at(-1)!)).toContain('HOST_C')
    } finally {
      await f.close()
    }
  },
)

it('does not certify host instructions when end_turn becomes a no-visible-response failure', async () => {
  const f = await fixture(' \n ')
  try {
    f.onInject(async () => {
      f.finish.resolve({ stopReason: 'end_turn' })
      await f.oldSettled
      return 'injected'
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of await f.steer('HOST_C')) chunks.push(chunk)
    expect(chunks).toContainEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'ACP_NO_VISIBLE_RESPONSE',
          message: 'ACP agent completed without a visible response',
        },
      },
    })
    await consume(f.followup('HOST_C'))
    expect(textOf(f.sent.at(-1)!)).toContain('HOST_C')
  } finally {
    await f.close()
  }
})

it('retains an unknown-outcome gate when a late steering ACK follows a lost prompt result', async () => {
  const f = await fixture()
  try {
    f.onInject(async () => {
      f.finish.reject(new Error('terminal response lost'))
      await f.failed
      return 'injected'
    })
    await expect(consume(await f.steer('HOST_C'))).rejects.toThrow()
    await expect(consume(f.followup('HOST_C'))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    expect(f.sent).toHaveLength(2)
  } finally {
    await f.close()
  }
})
