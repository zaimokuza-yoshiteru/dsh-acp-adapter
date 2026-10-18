import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { AcpAgentTurnOutcomeError } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpPendingAgentTurnFailure } from '../../../src/runtime/session/session-runtime.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function consume(stream: AsyncIterable<StreamChunk>, chunks: StreamChunk[] = []): Promise<void> {
  for await (const chunk of stream) chunks.push(chunk)
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'acp-qwen-failure-host-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const sidecar = createAcpSidecar({ root })
  cleanup.push(() => sidecar.dispose())
  let current: UserMessage = user('initial')
  let pending: AcpPendingAgentTurnFailure | undefined
  let workingDirectory = root
  let configured = { name: 'Qwen fixture', command: 'fixture-qwen', args: [] as string[], env: {} }
  const live = withSessionFacts({
    header: { cwd: root },
    get workingDirectory() {
      return workingDirectory
    },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: current },
    ],
  })
  let visibleSession = live
  const dispatches: DispatchRecord[] = []
  const initialize = vi.fn(async () => undefined)
  const start = vi.fn(async () => undefined)
  const restore = vi.fn(async () => 'reused' as const)
  const close = vi.fn(async () => undefined)
  const setConfigOption = vi.fn(async () => {
    throw new Error('a failed automatic turn must never be reconfigured')
  })
  const prompt = vi.fn<AcpProfileRuntime['prompt']>(async (_content, onUpdate) => {
    if (pending !== undefined) {
      onUpdate({
        sessionId: pending.acpSessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'automatic partial output' } },
      })
      throw pending.error
    }
    onUpdate({
      sessionId: 'qwen-remote',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'initial answer' } },
    })
    return { stopReason: 'end_turn' }
  })
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'qwen-remote',
    agentInfo: { name: 'qwen-code', version: '0.25.2' },
    agentCapabilities: {},
    get pendingAgentTurnFailure() {
      return pending
    },
    configOptions: [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'original-model',
        options: [
          { value: 'original-model', name: 'Original' },
          { value: 'another-model', name: 'Another' },
        ],
      },
    ],
    initialize,
    start,
    restore,
    close,
    setConfigOption,
    prompt,
  }
  const create = (source = runtime) => {
    const adapter = new AcpProfileAdapter(
      'qwen',
      () => configured,
      { ok: true, seam: undefined as never },
      () => visibleSession,
      {
        begin: async (record) => {
          dispatches.push(record)
          await sidecar.beginDispatch(record)
        },
        read: (id, key) => sidecar.readDispatch(id as never, key),
        settle: (id, key) => sidecar.settleDispatch(id as never, key),
      },
      undefined,
      () => source,
      sidecar,
    )
    cleanup.push(() => adapter.close())
    return adapter
  }
  const request = (message: UserMessage, extra: Partial<GenerateOptions> = {}) => {
    current = message
    return markAgentLoopRequest({
      provider: 'acp-qwen',
      model: 'original-model',
      sessionId: 'qwen-host-owner' as never,
      messages: [message],
      ...extra,
    })
  }
  const adapter = create()
  await consume(adapter.stream(request(current)))
  return {
    adapter,
    create,
    request,
    runtime,
    sidecar,
    dispatches,
    initialize,
    start,
    restore,
    close,
    prompt,
    setConfigOption,
    changeDirectory() {
      workingDirectory = tmpdir()
    },
    changeProfile() {
      configured = { ...configured, command: 'another-qwen' }
    },
    replaceOwner() {
      visibleSession = withSessionFacts({
        header: { cwd: root },
        get workingDirectory() {
          return workingDirectory
        },
        inheritedEventCount: 0,
        snapshotEvents: live.snapshotEvents,
      })
    },
    fail() {
      pending = {
        acpSessionId: 'qwen-remote',
        turnId: 'qwen-notification-1',
        error: new AcpAgentTurnOutcomeError('missing-terminal'),
      }
    },
  }
}

describe('Qwen automatic failure through the Host durable owner', () => {
  it('consumes a failure before an unrelated user input, retains its prefix and gates the next owner', async () => {
    const h = await harness()
    h.fail()
    const chunks: StreamChunk[] = []
    await expect(
      consume(h.adapter.stream(h.request(user('new input before the wake'), { model: 'another-model' })), chunks),
    ).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR' })
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      expect.objectContaining({ text: 'automatic partial output' }),
    ])
    expect(h.prompt.mock.calls[1]?.[6]).toMatchObject({ adoptAgentTurn: true })
    expect(h.initialize).toHaveBeenCalledTimes(1)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.setConfigOption).not.toHaveBeenCalled()
    expect(await h.sidecar.readRecoveryState('qwen-host-owner' as never)).toMatchObject({
      kind: 'outcome-unknown',
      acpSessionId: 'qwen-remote',
    })
    const dispatch = h.dispatches[1]!
    expect(await h.sidecar.readDispatch('qwen-host-owner' as never, dispatch.key)).toMatchObject({
      state: 'dispatch-uncertain',
    })
    await h.adapter.close()
    const restartedPrompt = vi.fn<AcpProfileRuntime['prompt']>(async (...args) => h.runtime.prompt(...args))
    const restarted = h.create({ ...h.runtime, pendingAgentTurnFailure: undefined, prompt: restartedPrompt })
    await expect(consume(restarted.stream(h.request(user('after owner restart'))))).rejects.toMatchObject({
      code: 'ACP_RECOVERY_REQUIRED',
    })
    expect(restartedPrompt).not.toHaveBeenCalled()
  })

  it('persists an unconsumed failure when new input fails capability validation before WAL', async () => {
    const h = await harness()
    h.fail()
    const image = createUserMessage({
      source: { kind: 'user' },
      content: [
        {
          type: 'image',
          attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        },
      ],
    })
    await expect(consume(h.adapter.stream(h.request(image)))).rejects.toMatchObject({ code: 'ACP_INPUT_NOT_SUPPORTED' })
    expect(h.dispatches).toHaveLength(1)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(await h.sidecar.readRecoveryState('qwen-host-owner' as never)).toMatchObject({
      kind: 'outcome-unknown',
      acpSessionId: 'qwen-remote',
      generation: 1,
    })
    await expect(consume(h.adapter.stream(h.request(user('retry after invalid input'))))).rejects.toMatchObject({
      code: 'ACP_RECOVERY_REQUIRED',
    })
    expect(h.prompt).toHaveBeenCalledTimes(1)
  })

  it('preserves a failed unadopted turn during adapter close before a delayed native wake', async () => {
    const h = await harness()
    h.fail()
    await h.adapter.close()
    expect(await h.sidecar.readRecoveryState('qwen-host-owner' as never)).toMatchObject({
      kind: 'outcome-unknown',
      generation: 1,
    })
    const nextPrompt = vi.fn<AcpProfileRuntime['prompt']>(async (...args) => h.runtime.prompt(...args))
    const next = h.create({ ...h.runtime, pendingAgentTurnFailure: undefined, prompt: nextPrompt })
    await expect(consume(next.stream(h.request(user('delayed wake after close'))))).rejects.toMatchObject({
      code: 'ACP_RECOVERY_REQUIRED',
    })
    expect(nextPrompt).not.toHaveBeenCalled()
    expect(h.prompt).toHaveBeenCalledTimes(1)
  })

  it('keeps a cancelled admission from dispatching and saves the pending failure before owner close', async () => {
    const h = await harness()
    h.fail()
    const controller = new AbortController()
    controller.abort(new DOMException('controlled cancelled admission', 'AbortError'))
    await expect(
      consume(h.adapter.stream(h.request(user('cancelled input'), { signal: controller.signal }))),
    ).rejects.toBeDefined()
    expect(h.dispatches).toHaveLength(1)
    expect(h.prompt).toHaveBeenCalledTimes(1)
    await h.adapter.close()
    expect(await h.sidecar.readRecoveryState('qwen-host-owner' as never)).toMatchObject({ kind: 'outcome-unknown' })
  })

  it.each(['directory', 'profile'] as const)(
    'retains the recovery gate when a new %s fails preflight',
    async (change) => {
      const h = await harness()
      h.fail()
      if (change === 'directory') h.changeDirectory()
      else h.changeProfile()
      await expect(
        consume(h.adapter.stream(h.request(user('do not send into changed context')))),
      ).rejects.toMatchObject({
        code: 'ACP_RECONCILIATION_REQUIRED',
      })
      expect(h.prompt).toHaveBeenCalledTimes(1)
      expect(h.dispatches).toHaveLength(1)
      expect(await h.sidecar.readRecoveryState('qwen-host-owner' as never)).toMatchObject({
        kind: 'reconciliation-required',
        cause: change === 'directory' ? 'cwd-changed' : 'profile-changed',
      })
      await h.adapter.close()
      const nextPrompt = vi.fn<AcpProfileRuntime['prompt']>(async (...args) => h.runtime.prompt(...args))
      const next = h.create({ ...h.runtime, pendingAgentTurnFailure: undefined, prompt: nextPrompt })
      await expect(consume(next.stream(h.request(user('after changed context restart'))))).rejects.toMatchObject({
        code: 'ACP_RECOVERY_REQUIRED',
      })
      expect(nextPrompt).not.toHaveBeenCalled()
    },
  )

  it.each(['session owner', 'binding generation'] as const)(
    'does not let a retiring failure overwrite a replacement %s while a sidecar read is paused',
    async (replacement) => {
      const h = await harness()
      h.fail()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const readRecovery = h.sidecar.readRecoveryState.bind(h.sidecar)
      const pausedRead = vi.spyOn(h.sidecar, 'readRecoveryState').mockImplementationOnce(async (id) => {
        const snapshot = await readRecovery(id)
        entered.resolve()
        await release.promise
        return snapshot
      })
      const closing = h.adapter.close()
      await entered.promise
      if (replacement === 'session owner') h.replaceOwner()
      else {
        const lookup = await h.sidecar.readLatestBinding('qwen-host-owner' as never)
        if (lookup?.status !== 'ok') throw new Error('expected a durable fixture binding')
        await h.sidecar.append('qwen-host-owner' as never, {
          kind: 'binding',
          data: {
            ...lookup.binding,
            generation: 2,
            bindingEpoch: 2,
            committedPromptOrdinal: 0,
            historyBaseSeq: lookup.binding.dshCommittedSeq,
            establishedAt: Date.now(),
          },
        })
        await h.sidecar.writeRecoveryState({
          dshSessionId: 'qwen-host-owner',
          kind: 'healthy',
          provider: 'acp-qwen',
          acpSessionId: 'qwen-remote',
          generation: 2,
          lastUserAction: 'rebind-blank',
          updatedAt: Date.now(),
        })
      }
      release.resolve()
      await closing
      pausedRead.mockRestore()
      expect(await readRecovery('qwen-host-owner' as never)).toMatchObject({
        kind: 'healthy',
        generation: replacement === 'binding generation' ? 2 : 1,
      })
      expect(h.adapter.recoveryStateFallback('qwen-host-owner')).toBeUndefined()
    },
  )

  it('keeps the existing in-memory gate when retiring-failure persistence is unavailable', async () => {
    const h = await harness()
    h.fail()
    const writeRecovery = h.sidecar.writeRecoveryState.bind(h.sidecar)
    const failedWrite = vi.spyOn(h.sidecar, 'writeRecoveryState').mockImplementation(async (state, options) => {
      if (state.kind === 'outcome-unknown') throw new Error('controlled unavailable store')
      return writeRecovery(state, options)
    })
    // Leave the provider before its automatic-turn buffer can be consumed.
    const image = createUserMessage({
      source: { kind: 'user' },
      content: [
        {
          type: 'image',
          attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        },
      ],
    })
    await expect(consume(h.adapter.stream(h.request(image)))).rejects.toMatchObject({ code: 'ACP_INPUT_NOT_SUPPORTED' })
    expect(h.adapter.recoveryStateFallback('qwen-host-owner')).toMatchObject({ kind: 'outcome-unknown' })
    await expect(
      consume(h.adapter.stream(h.request(user('do not continue after a failed write')))),
    ).rejects.toMatchObject({
      code: 'ACP_RECOVERY_REQUIRED',
    })
    expect(h.prompt).toHaveBeenCalledTimes(1)
    failedWrite.mockRestore()
  })
})
