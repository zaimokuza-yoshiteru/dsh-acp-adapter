import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

async function fixture(
  options: {
    fork?: boolean
    forkFailure?: 'before' | 'after'
    stop?: boolean
    stopDuringFork?: boolean
    late?: boolean
  } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-directory-')))
  const original = path.join(root, 'project')
  const target = path.join(root, 'checkout')
  fs.mkdirSync(original)
  fs.mkdirSync(target)
  const sidecar = createAcpSidecar({ root: path.join(root, 'data') })
  let cwd = original
  let observer: ((cwd: string) => void) | undefined
  const message = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Create an isolated checkout and continue my task.' }],
  })
  const events = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: message },
  ]
  const session = withSessionFacts({
    header: { cwd: original },
    get workingDirectory() {
      return cwd
    },
    snapshotEvents: () => events,
    watchWorkingDirectory: (listener: (directory: string) => void) => {
      observer = listener
      return () => {
        observer = undefined
      }
    },
  })
  const controller = new AbortController()
  const calls: { kind: string; cwd: string; parent?: string }[] = []
  let runtimeNumber = 0
  let stoppedDuringFork = false
  let command = 'agent'
  const adapter = new AcpProfileAdapter(
    'test',
    () => ({ name: 'Test', command, args: [], env: {} }),
    { ok: true, seam: undefined as never },
    () => session,
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: async (id, key) => {
        if (options.late) {
          cwd = target
          observer?.(target)
        }
        await sidecar.settleDispatch(id as never, key)
      },
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    undefined,
    (launch) => {
      const ordinal = ++runtimeNumber
      let id = ordinal === 1 ? 'original-agent' : undefined
      const runtime: AcpProfileRuntime = {
        get acpSessionId() {
          return id
        },
        agentInfo: { name: 'fixture', version: '1' },
        agentCapabilities: { sessionCapabilities: { resume: {}, ...(options.fork === false ? {} : { fork: {} }) } },
        protocolVersion: 1,
        start: async () => {
          calls.push({ kind: 'new', cwd: launch.cwd })
        },
        restore: async () => 'reused',
        close: async () => {
          calls.push({ kind: 'close', cwd: launch.cwd })
        },
        fork: async (parent, signal, _expected, beforeDispatch) => {
          if (options.forkFailure === 'before') throw new Error('ACP_FORK_UNSUPPORTED')
          if (options.stopDuringFork && !stoppedDuringFork) {
            stoppedDuringFork = true
            controller.abort(new Error('User Stop before fork dispatch'))
            throw signal?.reason ?? controller.signal.reason
          }
          await beforeDispatch?.()
          calls.push({ kind: 'fork', cwd: launch.cwd, parent })
          if (options.forkFailure === 'after') throw new Error('transport ended after fork dispatch')
          id = 'forked-agent'
          return { sessionId: id }
        },
        prompt: async (_content, onUpdate, signal, _report, _concluded, _success, promptOptions) => {
          calls.push({ kind: 'prompt', cwd: launch.cwd })
          if (ordinal > 1) {
            onUpdate({
              sessionId: 'forked-agent',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Continuing in checkout.' },
              },
            })
            return { stopReason: 'end_turn' }
          }
          if (options.late) {
            onUpdate({
              sessionId: 'original-agent',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Checkout is finishing.' },
              },
            })
            return { stopReason: 'end_turn' }
          }
          cwd = target
          observer?.(target)
          expect(signal?.aborted).toBe(true)
          expect(promptOptions?.hostBodySignal?.aborted).toBe(false)
          if (options.stop) controller.abort(new Error('User Stop'))
          if (options.stop) expect(promptOptions?.hostBodySignal?.aborted).toBe(true)
          return { stopReason: 'cancelled' }
        },
      }
      return runtime
    },
    sidecar,
  )
  const request: GenerateOptions = markAgentLoopRequest({
    provider: 'acp-test',
    model: 'model-a',
    sessionId: 's' as never,
    messages: [message],
    signal: controller.signal,
  })
  return {
    adapter,
    sidecar,
    calls,
    session,
    target,
    original,
    request,
    setCommand: (next: string) => {
      command = next
    },
    continueRequest: () => {
      const next = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue the task.' }],
      })
      events.push(
        { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 4, data: next },
      )
      return markAgentLoopRequest({ ...request, messages: [message, next], signal: new AbortController().signal })
    },
    close: async () => {
      await adapter.close()
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function drain(request: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of request) chunks.push(chunk)
  return chunks
}

describe('ACP working-directory handoff', () => {
  it('observes a late Host commit after the remote terminal and publishes the replacement replay identity', async () => {
    const world = await fixture({ late: true })
    try {
      const chunks = await drain(world.adapter.stream(world.request))
      expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(1)
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        replayState: { response: { kind: 'dsh-acp', agentSessionId: 'forked-agent', profileGeneration: 2 } },
      })
    } finally {
      await world.close()
    }
  })
  it('settles the old prompt and forks its context into the target cwd without session/new or replay', async () => {
    const world = await fixture()
    try {
      const chunks = await drain(world.adapter.stream(world.request))
      expect(world.calls.filter((call) => call.kind === 'new')).toEqual([{ kind: 'new', cwd: world.original }])
      expect(world.calls.filter((call) => call.kind === 'fork')).toEqual([
        { kind: 'fork', cwd: world.target, parent: 'original-agent' },
      ])
      expect(world.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const binding = await world.sidecar.readLatestBinding('s' as never)
      expect(binding).toMatchObject({
        status: 'ok',
        binding: {
          agentSessionId: 'forked-agent',
          canonicalCwd: world.target,
          generation: 2,
          bindingEpoch: 2,
          committedPromptOrdinal: 1,
        },
      })
      expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({
        kind: 'healthy',
        acpSessionId: 'forked-agent',
      })
      expect(world.session.header.cwd).toBe(world.original)
    } finally {
      await world.close()
    }
  })

  it.each(['before', 'after'] as const)(
    'keeps a durable gate when the context fork fails %s dispatch',
    async (forkFailure) => {
      const world = await fixture({ forkFailure })
      try {
        await expect(drain(world.adapter.stream(world.request))).rejects.toThrow('directory handoff did not complete')
        expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
        expect(world.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
        expect(await world.sidecar.readLatestBinding('s' as never)).toMatchObject({
          status: 'ok',
          binding: { agentSessionId: 'original-agent', canonicalCwd: world.original },
        })
        expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({
          kind: forkFailure === 'after' ? 'outcome-unknown' : 'reconciliation-required',
        })
      } finally {
        await world.close()
      }
    },
  )

  it('interrupts an out-of-band directory change even when the Agent cannot fork', async () => {
    const world = await fixture({ fork: false })
    try {
      await expect(drain(world.adapter.stream(world.request))).rejects.toThrow('cannot fork its conversation')
      expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
      expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({
        kind: 'reconciliation-required',
        cause: 'cwd-changed',
      })
    } finally {
      await world.close()
    }
  })

  it('defers the known directory handoff until the next request after User Stop', async () => {
    const world = await fixture({ stop: true })
    try {
      await drain(world.adapter.stream(world.request))
      expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
      expect(await world.sidecar.readLatestBinding('s' as never)).toMatchObject({
        status: 'ok',
        binding: { agentSessionId: 'original-agent' },
      })
      const pending = await world.sidecar.readRecoveryState('s' as never)
      expect(pending).toMatchObject({
        cause: 'cwd-handoff-pending',
        targetCwd: world.target,
      })
      if (pending === undefined) throw new Error('missing pending handoff state')
      expect(await world.adapter.isAutomaticDirectoryHandoff('s', pending)).toBe(true)
      expect(await world.sidecar.readRecoveryState('s' as never)).toEqual(pending)
      const chunks = await drain(world.adapter.stream(world.continueRequest()))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
      expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(1)
      expect(world.calls.filter((call) => call.kind === 'prompt').at(-1)?.cwd).toBe(world.target)
      expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({ kind: 'healthy' })
    } finally {
      await world.close()
    }
  })

  it('retains a real recovery gate when an unsupported external directory change coincides with Stop', async () => {
    const world = await fixture({ fork: false, stop: true })
    try {
      await drain(world.adapter.stream(world.request))
      const recovery = await world.sidecar.readRecoveryState('s' as never)
      expect(recovery).toMatchObject({ kind: 'reconciliation-required', cause: 'cwd-changed' })
      expect(recovery?.targetCwd).toBeUndefined()
      if (recovery === undefined) throw new Error('missing unsupported directory recovery state')
      expect(await world.adapter.isAutomaticDirectoryHandoff('s', recovery)).toBe(false)
      await expect(drain(world.adapter.stream(world.continueRequest()))).rejects.toMatchObject({
        code: 'ACP_RECOVERY_REQUIRED',
      })
      expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
      expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
      expect(world.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
      expect(await world.sidecar.readLatestBinding('s' as never)).toMatchObject({
        status: 'ok',
        binding: { agentSessionId: 'original-agent', canonicalCwd: world.original },
      })
    } finally {
      await world.close()
    }
  })
})

it('keeps a pending Stop handoff gated when its target directory changes again before continuation', async () => {
  const world = await fixture({ stop: true })
  try {
    await drain(world.adapter.stream(world.request))
    const pending = await world.sidecar.readRecoveryState('s' as never)
    const binding = await world.sidecar.readLatestBinding('s' as never)
    expect(pending).toMatchObject({ cause: 'cwd-handoff-pending', targetCwd: world.target })
    const alternate = path.join(path.dirname(world.original), 'alternate-checkout')
    fs.mkdirSync(alternate)
    // Represent a subsequent committed directory state while the ACP prompt is
    // idle; the original pending target must not authorize this different cwd.
    Object.defineProperty(world.session, 'workingDirectory', { get: () => alternate, configurable: true })
    if (pending === undefined) throw new Error('missing pending handoff state')
    expect(await world.adapter.isAutomaticDirectoryHandoff('s', pending)).toBe(false)
    await expect(drain(world.adapter.stream(world.continueRequest()))).rejects.toMatchObject({
      code: 'ACP_RECOVERY_REQUIRED',
    })
    expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
    expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
    expect(world.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
    expect(await world.sidecar.readLatestBinding('s' as never)).toEqual(binding)
    expect(await world.sidecar.readRecoveryState('s' as never)).toEqual(pending)
  } finally {
    await world.close()
  }
})

it('keeps changed profiles and mismatched pending binding facts visible as real recovery gates', async () => {
  const world = await fixture({ stop: true })
  try {
    await drain(world.adapter.stream(world.request))
    const pending = await world.sidecar.readRecoveryState('s' as never)
    if (pending === undefined) throw new Error('missing pending handoff state')
    expect(await world.adapter.isAutomaticDirectoryHandoff('s', pending)).toBe(true)
    for (const changed of [
      { dshSessionId: 'other-session' },
      { provider: 'acp-other' },
      { acpSessionId: 'other-agent' },
      { generation: 2 },
      { kind: 'outcome-unknown' as const },
      { cause: 'fork-intent' },
    ]) {
      expect(await world.adapter.isAutomaticDirectoryHandoff('s', { ...pending, ...changed })).toBe(false)
    }
    world.setCommand('different-agent')
    expect(await world.adapter.isAutomaticDirectoryHandoff('s', pending)).toBe(false)
    expect(await world.sidecar.readRecoveryState('s' as never)).toEqual(pending)
    expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
  } finally {
    await world.close()
  }
})

it('retries a known directory handoff after one Stop before fork dispatch without starting blank', async () => {
  const world = await fixture({ stopDuringFork: true })
  try {
    await expect(drain(world.adapter.stream(world.request))).rejects.toThrow('directory handoff did not complete')
    expect(world.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
    expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
    expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({
      kind: 'reconnect-required',
      cause: 'cwd-handoff-pending',
      targetCwd: world.target,
      provider: 'acp-test',
      acpSessionId: 'original-agent',
      generation: 1,
    })
    expect(await world.sidecar.readLatestBinding('s' as never)).toMatchObject({
      status: 'ok',
      binding: { agentSessionId: 'original-agent', canonicalCwd: world.original, generation: 1 },
    })
    const chunks = await drain(world.adapter.stream(world.continueRequest()))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(world.calls.filter((call) => call.kind === 'fork')).toEqual([
      { kind: 'fork', cwd: world.target, parent: 'original-agent' },
    ])
    expect(world.calls.filter((call) => call.kind === 'new')).toHaveLength(1)
    expect(world.calls.filter((call) => call.kind === 'prompt').at(-1)?.cwd).toBe(world.target)
    expect(await world.sidecar.readRecoveryState('s' as never)).toMatchObject({ kind: 'healthy' })
  } finally {
    await world.close()
  }
})
