import { withSessionFacts } from '../../support/session-facts.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { SessionLike } from '../../../src/domain/session/current-step-admission.ts'
import { profileLaunchIdentityHash } from '../../../src/domain/session/launch-fingerprint.ts'
import { acpOptionsSnapshotOf } from '../../../src/persistence/options-snapshot.ts'
import { createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { AcpHostSettlementError } from '../../../src/runtime/session/mcp-lease.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []

afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function tempSidecar(): { readonly root: string; readonly sidecar: AcpSidecar } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-local-settlement-'))
  roots.push(root)
  const sidecar = createAcpSidecar({ root })
  sidecars.push(sidecar)
  return { root, sidecar }
}

const profile = (): AcpAgentConfig => ({ name: 'Settlement test', command: 'agent', args: [], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const session = (message: ReturnType<typeof user>, turn: number): SessionLike =>
  withSessionFacts({
    header: { cwd: os.tmpdir() },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: turn * 10 + 1, data: { turn, step: 0 } },
      { type: 'user/message', seq: turn * 10 + 2, data: message },
    ],
  })
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })
const request = (id: string, message: ReturnType<typeof user>, signal?: AbortSignal): GenerateOptions =>
  markAgentLoopRequest({
    provider: 'acp-settlement',
    model: 'model-a',
    sessionId: id as never,
    messages: [message],
    ...(signal === undefined ? {} : { signal }),
  })

function ledgerFor(sidecar: AcpSidecar, failSettles?: { remaining: number; calls: number }) {
  return {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: async (sessionId: string, key: string) => {
      if (failSettles !== undefined) {
        failSettles.calls += 1
        if (failSettles.remaining > 0) {
          failSettles.remaining -= 1
          throw new Error('temporary ledger write failure')
        }
      }
      return sidecar.settleDispatch(sessionId as never, key)
    },
    read: (sessionId: string, key: string) => sidecar.readDispatch(sessionId as never, key),
  }
}

function adapter(
  sidecar: AcpSidecar,
  sessions: Map<string, SessionLike>,
  hostRoot: Context,
  runtimeFactory: () => AcpProfileRuntime,
  failSettles?: { remaining: number; calls: number },
  controlsChanged?: (sessionId: string) => void,
) {
  return new AcpProfileAdapter(
    'settlement',
    profile,
    seam(),
    (id) => sessions.get(id),
    ledgerFor(sidecar, failSettles),
    undefined,
    runtimeFactory,
    sidecar,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controlsChanged,
    hostRoot,
  )
}

function scriptedRuntime(
  promptCount: { value: number },
  closeCount = { value: 0 },
  hostSettlementPending = false,
  canFlushHostFeedback: () => boolean = () => true,
) {
  return (): AcpProfileRuntime => {
    const settlement = { pending: hostSettlementPending }
    return {
      acpSessionId: 'agent-local-settlement',
      get hostSettlementPending() {
        return settlement.pending
      },
      start: async () => undefined,
      flushHostFeedback: async () => {
        if (!canFlushHostFeedback()) throw new Error('Host feedback storage unavailable')
        settlement.pending = false
      },
      restore: async () => 'reused',
      prompt: async (_content, onUpdate) => {
        promptCount.value += 1
        onUpdate({
          sessionId: 'agent-local-settlement',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `answer-${promptCount.value}` },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => {
        closeCount.value += 1
      },
    }
  }
}

async function collect(adapterInstance: AcpProfileAdapter, options: GenerateOptions) {
  const chunks: unknown[] = []
  for await (const chunk of adapterInstance.stream(options)) chunks.push(chunk)
  return chunks
}

describe('ACP adapter local terminal settlement', () => {
  it('retries one transient ledger failure and exposes the original successful response', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const first = user('first request')
    const sessions = new Map<string, SessionLike>([['local-session', session(first, 1)]])
    const failures = { remaining: 1, calls: 0 }
    const promptCount = { value: 0 }
    const instance = adapter(sidecar, sessions, hostRoot, scriptedRuntime(promptCount), failures)

    const chunks = await collect(instance, request('local-session', first))

    expect(failures.calls).toBe(2)
    expect(promptCount.value).toBe(1)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-1' }))
    expect(chunks.find((chunk) => (chunk as { type?: string }).type === 'finish')).toBeDefined()
    const binding = await sidecar.readLatestBinding('local-session' as never)
    expect(binding?.status === 'ok' && binding.binding.committedPromptOrdinal).toBe(1)
    await instance.close()
  })

  it('keeps the known terminal turn open after local writes fail and finishes after background recovery', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const first = user('first request')
    const second = user('second request')
    const sessions = new Map<string, SessionLike>([['local-session', session(first, 1)]])
    const promptCount = { value: 0 }
    const closeCount = { value: 0 }
    let feedbackStorageAvailable = false
    let failedFlushes = 0
    let instance!: AcpProfileAdapter
    let resolveStorageError!: () => void
    const storageError = new Promise<void>((resolve) => (resolveStorageError = resolve))
    instance = adapter(
      sidecar,
      sessions,
      hostRoot,
      scriptedRuntime(promptCount, closeCount, true, () => {
        if (feedbackStorageAvailable) return true
        failedFlushes += 1
        return false
      }),
      undefined,
      () => {
        if (instance.localSettlementStatus('local-session') === 'storage-error') resolveStorageError()
      },
    )
    let firstTurnFinished = false
    const firstTurn = collect(instance, request('local-session', first)).then((chunks) => {
      firstTurnFinished = true
      return chunks
    })
    void firstTurn.catch(() => undefined)

    await storageError
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(failedFlushes).toBe(3)
    expect(firstTurnFinished).toBe(false)
    expect(promptCount.value).toBe(1)
    expect(closeCount.value).toBe(0)
    expect(instance.localSettlementStatus('local-session')).toBe('storage-error')

    feedbackStorageAvailable = true
    const firstChunks = await firstTurn
    expect(firstChunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-1' }))

    sessions.set('local-session', session(second, 2))
    const secondChunks = await collect(instance, request('local-session', second))
    expect(promptCount.value).toBe(2)
    expect(secondChunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-2' }))
    const binding = await sidecar.readLatestBinding('local-session' as never)
    expect(binding?.status === 'ok' && binding.binding.committedPromptOrdinal).toBe(2)
    await instance.close()
  })

  it('waits on the same next prompt while local storage recovers, and a pre-aborted call starts no prompt', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const first = user('first request')
    const second = user('second request')
    const oldSession = session(first, 1)
    const sessions = new Map<string, SessionLike>([['local-session', oldSession]])
    const promptCount = { value: 0 }
    let storageAvailable = false
    let instance!: AcpProfileAdapter
    let storageErrorCount = 0
    let lastLocalStatus: string | undefined
    const storageErrorWaiters = new Map<number, () => void>()
    const waitForStorageError = (count: number): Promise<void> => {
      if (storageErrorCount >= count) return Promise.resolve()
      return new Promise((resolve) => storageErrorWaiters.set(count, resolve))
    }
    const originalWriteSnapshot = sidecar.writeOptionSnapshot.bind(sidecar)
    vi.spyOn(sidecar, 'writeOptionSnapshot').mockImplementation(async (...args) => {
      if (!storageAvailable) throw new Error('temporary snapshot storage failure')
      return await originalWriteSnapshot(...args)
    })
    instance = adapter(sidecar, sessions, hostRoot, scriptedRuntime(promptCount), undefined, () => {
      const status = instance.localSettlementStatus('local-session')
      if (status === 'storage-error' && lastLocalStatus !== 'storage-error') {
        storageErrorCount += 1
        for (const [count, resolve] of storageErrorWaiters) {
          if (storageErrorCount >= count) {
            storageErrorWaiters.delete(count)
            resolve()
          }
        }
      }
      lastLocalStatus = status
    })
    let nextPrompt: Promise<readonly unknown[]> | undefined
    const firstTurnController = new AbortController()
    const nextPromptController = new AbortController()
    try {
      const firstTurn = collect(instance, request('local-session', first, firstTurnController.signal))
      const firstCancelled = expect(firstTurn).rejects.toMatchObject({ name: 'AbortError' })
      await waitForStorageError(1)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(instance.localSettlementStatus('local-session')).toBe('storage-error')
      expect(promptCount.value).toBe(1)
      firstTurnController.abort(new DOMException('Stopped', 'AbortError'))
      await firstCancelled
      expect(instance.localSettlementStatus('local-session')).toBe('storage-error')
      expect(promptCount.value).toBe(1)

      sessions.set('local-session', session(second, 2))
      const alreadyStopped = new AbortController()
      alreadyStopped.abort(new DOMException('Stopped', 'AbortError'))
      await expect(collect(instance, request('local-session', second, alreadyStopped.signal))).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(promptCount.value).toBe(1)

      nextPrompt = collect(instance, request('local-session', second, nextPromptController.signal))
      let nextPromptFinished = false
      void nextPrompt.then(
        () => (nextPromptFinished = true),
        () => undefined,
      )
      await instance.disposeSession({ id: 'local-session', identity: oldSession.identity ?? oldSession })
      await waitForStorageError(2)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(nextPromptFinished).toBe(false)
      expect(promptCount.value).toBe(1)

      storageAvailable = true
      const chunks = await nextPrompt
      expect(promptCount.value).toBe(2)
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-2' }))
      const binding = await sidecar.readLatestBinding('local-session' as never)
      expect(binding?.status === 'ok' && binding.binding.committedPromptOrdinal).toBe(2)
    } finally {
      storageAvailable = true
      nextPromptController.abort(new DOMException('Test finished', 'AbortError'))
      await instance.close()
      await nextPrompt?.catch(() => undefined)
    }
  })

  it('retries through a replacement adapter and uses its current sidecar sink', async () => {
    const { root, sidecar: oldSidecar } = tempSidecar()
    const hostRoot = new Context()
    const first = user('first request')
    const second = user('second request')
    const sessions = new Map<string, SessionLike>([['local-session', session(first, 1)]])
    const failures = { remaining: 3, calls: 0 }
    const promptCount = { value: 0 }
    let oldAdapter!: AcpProfileAdapter
    let resolveStorageError!: () => void
    const storageError = new Promise<void>((resolve) => (resolveStorageError = resolve))
    oldAdapter = adapter(oldSidecar, sessions, hostRoot, scriptedRuntime(promptCount), failures, () => {
      if (oldAdapter.localSettlementStatus('local-session') === 'storage-error') resolveStorageError()
    })
    let firstTurnFinished = false
    const firstTurn = collect(oldAdapter, request('local-session', first)).then((chunks) => {
      firstTurnFinished = true
      return chunks
    })
    void firstTurn.catch(() => undefined)

    await storageError
    expect(firstTurnFinished).toBe(false)
    expect(promptCount.value).toBe(1)
    expect(oldAdapter.localSettlementStatus('local-session')).toBe('storage-error')
    await oldAdapter.close()
    await expect(firstTurn).rejects.toMatchObject({ name: 'AbortError' })
    await oldSidecar.dispose()

    const newSidecar = createAcpSidecar({ root })
    sidecars.push(newSidecar)
    sessions.set('local-session', session(second, 2))
    const newAdapter = adapter(newSidecar, sessions, hostRoot, scriptedRuntime(promptCount))
    const chunks = await collect(newAdapter, request('local-session', second))

    expect(promptCount.value).toBe(2)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-2' }))
    const binding = await newSidecar.readLatestBinding('local-session' as never)
    expect(binding?.status === 'ok' && binding.binding.committedPromptOrdinal).toBe(2)
    await newAdapter.close()
  })

  it('reads back a binding append that committed before throwing and does not advance twice', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const message = user('commit binding')
    const sessions = new Map<string, SessionLike>([['local-session', session(message, 1)]])
    const promptCount = { value: 0 }
    const originalAppend = sidecar.append.bind(sidecar)
    let threwAfterCommit = false
    const append = vi.spyOn(sidecar, 'append').mockImplementation(async (sessionId, event) => {
      const result = await originalAppend(sessionId, event)
      const data = event as { readonly kind?: string; readonly data?: { readonly committedPromptOrdinal?: number } }
      if (data.kind === 'binding' && data.data?.committedPromptOrdinal === 1 && !threwAfterCommit) {
        threwAfterCommit = true
        throw new Error('append acknowledgement lost')
      }
      return result
    })
    const instance = adapter(sidecar, sessions, hostRoot, scriptedRuntime(promptCount))

    await collect(instance, request('local-session', message))

    const binding = await sidecar.readLatestBinding('local-session' as never)
    expect(threwAfterCommit).toBe(true)
    const targetAppends = append.mock.calls.filter(([, event]) => {
      const data = event as { readonly kind?: string; readonly data?: { readonly committedPromptOrdinal?: number } }
      return data.kind === 'binding' && data.data?.committedPromptOrdinal === 1
    })
    expect(targetAppends).toHaveLength(1)
    expect(binding?.status === 'ok' && binding.binding.committedPromptOrdinal).toBe(1)
    await instance.close()
  })

  it('finishes with the matched remote response after local Host feedback flush succeeds', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const message = user('finish after feedback flush')
    const sessions = new Map<string, SessionLike>([['local-session', session(message, 1)]])
    const promptCount = { value: 0 }
    const flushHostFeedback = vi.fn(async () => undefined)
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-local-settlement',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        promptCount.value += 1
        onUpdate({
          sessionId: 'agent-local-settlement',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'completed answer' },
          },
        } as never)
        throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
          remoteOutcomeKnown: true,
          remoteResponse: { stopReason: 'end_turn' } as never,
        })
      },
      flushHostFeedback,
      close: async () => undefined,
    })
    const instance = adapter(sidecar, sessions, hostRoot, runtimeFactory)

    const chunks = await collect(instance, request('local-session', message))
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'finish') as
      { readonly reason?: { readonly kind?: string } } | undefined

    expect(promptCount.value).toBe(1)
    expect(flushHostFeedback).toHaveBeenCalledTimes(1)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'completed answer' }))
    expect(finish?.reason?.kind).toBe('stop')
    await instance.close()
  })

  it('preserves the last valid option and mode snapshot when runtime metadata cannot be projected', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const message = user('terminal result with malformed runtime metadata')
    const sessions = new Map<string, SessionLike>([['local-session', session(message, 1)]])
    const fingerprint = profileLaunchIdentityHash('settlement', profile())
    const previousSnapshot = acpOptionsSnapshotOf(
      [
        {
          id: 'mode-option',
          name: 'Mode option',
          type: 'select',
          currentValue: 'careful',
          options: [{ value: 'careful', name: 'Careful' }],
        },
      ] as never,
      'plan',
      fingerprint,
      1,
    )
    await sidecar.writeOptionSnapshot('local-session' as never, previousSnapshot)
    const writeOptionSnapshot = vi.spyOn(sidecar, 'writeOptionSnapshot')
    const promptCount = { value: 0 }
    const instance = adapter(sidecar, sessions, hostRoot, () => ({
      ...scriptedRuntime(promptCount)(),
      modes: { currentModeId: 'new-mode', availableModes: null } as never,
    }))

    await collect(instance, request('local-session', message))

    expect(promptCount.value).toBe(1)
    expect(writeOptionSnapshot).not.toHaveBeenCalled()
    expect(await sidecar.readOptionSnapshot('local-session' as never)).toEqual(previousSnapshot)
    await instance.close()
  })

  it('settles a successful remote response when an Agent mode description exceeds the snapshot field limit', async () => {
    const { sidecar } = tempSidecar()
    const hostRoot = new Context()
    const message = user('terminal result with a long mode description')
    const sessions = new Map<string, SessionLike>([['local-session', session(message, 1)]])
    const promptCount = { value: 0 }
    const modes = Array.from({ length: 8 }, (_, index) => ({
      id: `mode-${String(index)}`,
      name: `Mode ${String(index)}`,
      ...(index === 3 ? { description: 'd'.repeat(224) } : {}),
    }))
    const writeOptionSnapshot = vi.spyOn(sidecar, 'writeOptionSnapshot')
    const instance = adapter(sidecar, sessions, hostRoot, () => ({
      ...scriptedRuntime(promptCount)(),
      modes: { currentModeId: 'mode-3', availableModes: modes } as never,
    }))

    const chunks = await collect(instance, request('local-session', message))
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'finish') as
      { readonly reason?: { readonly kind?: string } } | undefined

    expect(promptCount.value).toBe(1)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'answer-1' }))
    expect(finish?.reason?.kind).toBe('stop')
    expect(instance.localSettlementStatus('local-session')).toBeUndefined()
    // One pre-dispatch runtime snapshot plus the known-terminal settlement snapshot.
    expect(writeOptionSnapshot).toHaveBeenCalledTimes(2)
    const persisted = await sidecar.readOptionSnapshot('local-session' as never)
    expect(persisted?.modes?.currentModeId).toBe('mode-3')
    expect(persisted?.modes?.availableModes[3]?.description).toHaveLength(224)
    await instance.close()
  })

  it('persists the active generation fingerprint when configuration disappears during a held prompt', async () => {
    const { sidecar } = tempSidecar()
    const originalProfile = profile()
    let currentProfile: AcpAgentConfig | undefined = originalProfile
    const hostRoot = new Context()
    const first = user('held request')
    const second = user('after removal')
    const sessions = new Map<string, SessionLike>([['local-session', session(first, 1)]])
    const promptCount = { value: 0 }
    let markPromptStarted!: () => void
    let releaseResponse!: () => void
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const instance = new AcpProfileAdapter(
      'settlement',
      () => currentProfile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      () => ({
        acpSessionId: 'agent-local-settlement',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          promptCount.value += 1
          onUpdate({
            sessionId: 'agent-local-settlement',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'held answer' },
            },
          } as never)
          markPromptStarted()
          await responseGate
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }),
      sidecar,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      hostRoot,
    )

    const response = collect(instance, request('local-session', first))
    await promptStarted
    currentProfile = undefined
    releaseResponse()
    const chunks = await response
    const savedSnapshot = await sidecar.readOptionSnapshot('local-session' as never)

    expect(promptCount.value).toBe(1)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'held answer' }))
    expect(savedSnapshot?.fingerprint).toBe(profileLaunchIdentityHash('settlement', originalProfile as never))

    sessions.set('local-session', session(second, 2))
    await expect(collect(instance, request('local-session', second))).rejects.toMatchObject({
      code: 'ACP_UNKNOWN_PROFILE',
    })
    expect(promptCount.value).toBe(1)
    await instance.close()
  })

  it('restores the confirmed mode when Stop interrupts a known cancelled response settlement', async () => {
    const { sidecar } = tempSidecar()
    const sessionId = 'review-mode-settle'
    const messages = ['first', 'cancel', 'continue'].map(user)
    let events: Array<{ type: string; seq: number; data: unknown }> = [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: messages[0] },
    ]
    const live = withSessionFacts({
      id: sessionId,
      header: { cwd: os.tmpdir() },
      snapshotEvents: () => events,
    })
    let mode = 'default'
    let refreshPending = false
    let feedbackAvailable = true
    let promptCount = 0
    const runtimeFactoryCalls = { value: 0 }
    const closeCount = { value: 0 }
    const modesAtPrompt: string[] = []
    const flushFailed = Promise.withResolvers<void>()
    const controller = new AbortController()
    const runtimeFactory = (): AcpProfileRuntime => {
      runtimeFactoryCalls.value += 1
      return {
        acpSessionId: 'remote-review',
        get cancelledSessionRefreshPending() {
          return refreshPending
        },
        get cancelledSessionRefreshBindingId() {
          return 'remote-review'
        },
        get currentModeId() {
          return mode
        },
        get modes() {
          return {
            currentModeId: mode,
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' },
            ],
          }
        },
        get configOptions() {
          return [
            {
              id: 'model',
              category: 'model',
              name: 'Model',
              type: 'select' as const,
              currentValue: 'm',
              options: [{ value: 'm', name: 'M' }],
            },
          ]
        },
        setMode: async (id: string) => {
          mode = id
        },
        hasUncommittedHostFeedback: () => !feedbackAvailable,
        hasRetainedHostFeedback: () => !feedbackAvailable,
        flushHostFeedback: async () => {
          if (!feedbackAvailable) {
            flushFailed.resolve()
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', { remoteOutcomeKnown: true })
          }
        },
        start: async () => undefined,
        restore: async () => {
          if (!refreshPending) return 'reused'
          refreshPending = false
          mode = 'default'
          return 'loaded'
        },
        prompt: async (_prompt, onUpdate) => {
          modesAtPrompt.push(mode)
          promptCount += 1
          if (promptCount === 2) {
            refreshPending = true
            feedbackAvailable = false
            throw new AcpHostSettlementError('ACP_HOST_FEEDBACK_COMMIT_FAILED', {
              remoteOutcomeKnown: true,
              remoteResponse: { stopReason: 'cancelled' } as never,
            })
          }
          onUpdate({
            sessionId: 'remote-review',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
          } as never)
          return { stopReason: 'end_turn' } as never
        },
        close: async () => {
          closeCount.value += 1
        },
      }
    }
    const instance = new AcpProfileAdapter(
      'review',
      () => ({ ...profile(), runtime: 'codebuddy' }),
      seam(),
      () => live,
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const makeRequest = (index: number, signal?: AbortSignal) =>
      markAgentLoopRequest({
        sessionId: sessionId as never,
        provider: 'acp-review',
        model: 'm',
        messages: [messages[index]!],
        ...(signal === undefined ? {} : { signal }),
      })
    try {
      await collect(instance, makeRequest(0))
      await instance.setAgentSessionOption(sessionId, { kind: 'mode', id: 'plan' })
      const bindingBefore = await sidecar.readLatestBinding(sessionId as never)
      if (bindingBefore?.status !== 'ok') throw new Error('missing binding before cancelled response')
      events = [
        ...events,
        { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 4, data: messages[1] },
      ]
      const cancelled = collect(instance, makeRequest(1, controller.signal))
      const cancelledResult = cancelled.then(
        () => undefined,
        (error) => error,
      )
      await flushFailed.promise
      controller.abort(new DOMException('Stopped', 'AbortError'))
      await expect(cancelledResult).resolves.toMatchObject({ name: 'AbortError' })
      feedbackAvailable = true
      events = [
        ...events,
        { type: 'step/start', seq: 5, data: { turn: 3, step: 0 } },
        { type: 'user/message', seq: 6, data: messages[2] },
      ]
      await collect(instance, makeRequest(2))
      expect(modesAtPrompt).toEqual(['default', 'plan', 'plan'])
      const bindingAfter = await sidecar.readLatestBinding(sessionId as never)
      expect(bindingAfter?.status === 'ok' ? bindingAfter.binding : undefined).toMatchObject({
        profileId: bindingBefore.binding.profileId,
        provider: bindingBefore.binding.provider,
        agentSessionId: bindingBefore.binding.agentSessionId,
        generation: bindingBefore.binding.generation,
      })
      expect(runtimeFactoryCalls.value).toBe(1)
      expect(closeCount.value).toBe(0)
    } finally {
      await instance.close()
    }
    expect(closeCount.value).toBe(1)
  })
})
