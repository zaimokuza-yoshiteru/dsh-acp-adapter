import { withSessionFacts } from '../../support/session-facts.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { AcpHostSettlementError } from '../../../src/runtime/session/mcp-lease.ts'
import { AcpSessionRefreshRetryError } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { SessionLike } from '../../../src/domain/session/current-step-admission.ts'
import { createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []
afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function testSidecar(root: string): AcpSidecar {
  const sidecar = createAcpSidecar({ root })
  sidecars.push(sidecar)
  return sidecar
}

const profile = (): AcpAgentConfig => ({ name: 'Activity test', command: 'agent', args: [], env: {} })
const claudeProfile = (): AcpAgentConfig => ({
  name: 'Claude',
  command: 'claude-agent-acp',
  args: [],
  env: {},
  runtime: 'claude',
})
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const session = (message: ReturnType<typeof user>): SessionLike =>
  withSessionFacts({
    header: { cwd: os.tmpdir() },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: message },
    ],
  })
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })
const request = (id: string, message: ReturnType<typeof user>): GenerateOptions =>
  markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: id as never, messages: [message] })

function ledgerFor(sidecar: AcpSidecar) {
  return {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: (sessionId: string, key: string) => sidecar.settleDispatch(sessionId as never, key),
    read: (sessionId: string, key: string) => sidecar.readDispatch(sessionId as never, key),
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iterable) {
    // Consume the stream through its terminal settlement.
  }
}

describe('provider activity bridge', () => {
  it.each([
    ['config', 'unsupported'],
    ['legacy', 'unsupported'],
    ['config', 'vendor-update'],
    ['legacy', 'vendor-update'],
    ['config', 'restore-retry'],
    ['legacy', 'restore-retry'],
    ['config', 'new-choice'],
    ['legacy', 'new-choice'],
    ['config', 'user-stop'],
    ['legacy', 'user-stop'],
  ] as const)('handles explicitly selected %s mode after cancellation (%s)', async (modeKind, scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-acp-mode-refresh-${modeKind}-`))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = `mode-refresh-${modeKind}`
    const messages = [user('first'), user('cancel'), user('continue')]
    let events = [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: messages[0]! },
    ]
    const live = withSessionFacts({
      header: { cwd: os.tmpdir() },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
      id: sessionId,
    })
    const calls: string[] = []
    const stopController = scenario === 'user-stop' ? new AbortController() : undefined
    const stoppedPromptStarted = Promise.withResolvers<void>()
    let mode = 'default'
    let availableModes = [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ]
    let closed = false
    let refreshPending = false
    let promptCount = 0
    let failNextModeWrite = false
    const runtimeFactory = (): AcpProfileRuntime => ({
      get acpSessionId() {
        return closed ? undefined : 'agent-mode-refresh'
      },
      get cancelledSessionRefreshPending() {
        return refreshPending
      },
      get cancelledSessionRefreshBindingId() {
        return 'agent-mode-refresh'
      },
      get isBusy() {
        return false
      },
      get currentModeId() {
        return mode
      },
      get modes() {
        return {
          currentModeId: mode,
          availableModes,
        }
      },
      get configOptions() {
        return [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'model-a',
            options: [{ value: 'model-a', name: 'Model A' }],
          },
          ...(modeKind === 'config'
            ? [
                {
                  id: 'mode',
                  name: 'Mode',
                  type: 'select' as const,
                  category: 'mode',
                  currentValue: mode,
                  options: availableModes.map(({ id, name }) => ({ value: id, name })),
                },
              ]
            : []),
        ] satisfies readonly acp.SessionConfigOption[]
      },
      start: async () => {
        calls.push('new')
        closed = false
      },
      restore: async () => {
        if (!closed && !refreshPending) return 'reused'
        calls.push('load')
        mode = 'default' // The Agent's session/load snapshot reset reproduces CodeBuddy behavior.
        closed = false
        refreshPending = false
        return 'loaded'
      },
      setMode: async (id) => {
        calls.push(`legacy:${id}`)
        if (failNextModeWrite) {
          failNextModeWrite = false
          throw new Error('transient mode restore failure')
        }
        mode = id
      },
      setConfigOption: async (id, value) => {
        if (id !== 'mode') throw new Error(`unexpected config option: ${id}`)
        calls.push(`config:${String(value)}`)
        if (failNextModeWrite) {
          failNextModeWrite = false
          throw new Error('transient mode restore failure')
        }
        mode = String(value)
      },
      prompt: async (_content, onUpdate, signal) => {
        promptCount++
        calls.push(`prompt:${promptCount}:${mode}`)
        if (promptCount === 2) {
          if (scenario === 'vendor-update') {
            availableModes = [
              { id: 'default', name: 'Default' },
              { id: 'review', name: 'Review' },
            ]
            mode = 'review' // A newer vendor update must supersede the remembered user choice.
          }
          if (scenario === 'user-stop') {
            stoppedPromptStarted.resolve()
            if (!signal?.aborted)
              await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
          }
          refreshPending = true
          return { stopReason: 'cancelled' }
        }
        onUpdate({
          sessionId: 'agent-mode-refresh',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        })
        return { stopReason: 'end_turn' }
      },
      retireCancelledSession: async () => {
        calls.push('retire')
        closed = true
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'mode-refresh',
      () => ({ ...profile(), runtime: 'codebuddy' }),
      seam(),
      () => live,
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const requestFor = (message: ReturnType<typeof user>, signal?: AbortSignal) =>
      markAgentLoopRequest({
        ...request(sessionId, message),
        provider: 'acp-mode-refresh',
        ...(signal === undefined ? {} : { signal }),
      })
    try {
      await drain(adapter.stream(requestFor(messages[0]!)))
      await adapter.setAgentSessionOption(
        sessionId,
        modeKind === 'legacy' ? { kind: 'mode', id: 'plan' } : { kind: 'config', id: 'mode', value: 'plan' },
      )
      events = [
        ...events,
        { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 4, data: messages[1]! },
      ]
      if (scenario === 'user-stop') {
        const stopped = drain(adapter.stream(requestFor(messages[1]!, stopController!.signal)))
        await stoppedPromptStarted.promise
        stopController!.abort()
        await stopped
      } else {
        await drain(adapter.stream(requestFor(messages[1]!)))
      }
      const nextTurn = [
        ...events,
        { type: 'step/start', seq: 5, data: { turn: 3, step: 0 } },
        { type: 'user/message', seq: 6, data: messages[2]! },
      ]
      availableModes =
        scenario === 'restore-retry' || scenario === 'new-choice' || scenario === 'user-stop'
          ? [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' },
              { id: 'review', name: 'Review' },
            ]
          : [
              { id: 'default', name: 'Default' },
              { id: 'review', name: 'Review' },
            ]
      events = nextTurn
      if (scenario === 'vendor-update') {
        await drain(adapter.stream(requestFor(messages[2]!)))
        expect(promptCount).toBe(3)
        expect(calls).toEqual([
          'new',
          'prompt:1:default',
          ...(modeKind === 'legacy' ? ['legacy:plan'] : ['config:plan']),
          'prompt:2:plan',
          'retire',
          'load',
          'prompt:3:default',
        ])
      } else if (scenario === 'unsupported') {
        await expect(drain(adapter.stream(requestFor(messages[2]!)))).rejects.toMatchObject({
          code: 'ACP_CONFIG_UNSUPPORTED',
        })
        expect(promptCount).toBe(2)
        await adapter.setAgentSessionOption(
          sessionId,
          modeKind === 'legacy' ? { kind: 'mode', id: 'review' } : { kind: 'config', id: 'mode', value: 'review' },
        )
        await drain(adapter.stream(requestFor(messages[2]!)))
        expect(promptCount).toBe(3)
        expect(calls).toEqual([
          'new',
          'prompt:1:default',
          ...(modeKind === 'legacy' ? ['legacy:plan'] : ['config:plan']),
          'prompt:2:plan',
          'retire',
          'load',
          ...(modeKind === 'legacy' ? ['legacy:review'] : ['config:review']),
          'prompt:3:review',
        ])
      } else if (scenario === 'restore-retry' || scenario === 'new-choice') {
        failNextModeWrite = true
        await expect(drain(adapter.stream(requestFor(messages[2]!)))).rejects.toMatchObject({
          code: 'ACP_CONFIG_SYNC_FAILED',
        })
        expect(promptCount).toBe(2)
        if (scenario === 'new-choice') {
          await adapter.setAgentSessionOption(
            sessionId,
            modeKind === 'legacy' ? { kind: 'mode', id: 'review' } : { kind: 'config', id: 'mode', value: 'review' },
          )
        }
        await drain(adapter.stream(requestFor(messages[2]!)))
        expect(promptCount).toBe(3)
        expect(calls).toEqual([
          'new',
          'prompt:1:default',
          ...(modeKind === 'legacy' ? ['legacy:plan'] : ['config:plan']),
          'prompt:2:plan',
          'retire',
          'load',
          ...(modeKind === 'legacy'
            ? scenario === 'new-choice'
              ? ['legacy:plan']
              : ['legacy:plan', 'legacy:plan']
            : scenario === 'new-choice'
              ? ['config:plan']
              : ['config:plan', 'config:plan']),
          ...(scenario === 'new-choice'
            ? [modeKind === 'legacy' ? 'legacy:review' : 'config:review', 'prompt:3:review']
            : ['prompt:3:plan']),
        ])
      } else {
        await drain(adapter.stream(requestFor(messages[2]!)))
        expect(promptCount).toBe(3)
        expect(calls).toEqual([
          'new',
          'prompt:1:default',
          ...(modeKind === 'legacy' ? ['legacy:plan'] : ['config:plan']),
          'prompt:2:plan',
          'retire',
          'load',
          ...(modeKind === 'legacy' ? ['legacy:plan'] : ['config:plan']),
          'prompt:3:plan',
        ])
      }
    } finally {
      await adapter.close()
    }
  })

  it('keeps CodeBuddy controls after retiring a cancelled runtime and restores the same binding only on write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-codebuddy-controls-refresh-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'codebuddy-controls-refresh'
    const firstMessage = user('continue the existing CodeBuddy session')
    const nextMessage = user('continue after changing the mode')
    const finalMessage = user('continue after the second mode change')
    let events = [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: firstMessage },
    ]
    const live = withSessionFacts({
      header: { cwd: os.tmpdir() },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
      id: sessionId,
    })
    const calls: string[] = []
    let closed = false
    let refreshPending = false
    let promptCount = 0
    let mode = 'plan'
    let bindingId = 'agent-codebuddy-controls'
    const restoreEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const finishRestore = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let restoreCount = 0
    const runtimeFactory = (): AcpProfileRuntime => ({
      get acpSessionId() {
        return closed ? undefined : 'agent-codebuddy-controls'
      },
      get cancelledSessionRefreshPending() {
        return refreshPending
      },
      get cancelledSessionRefreshBindingId() {
        return bindingId
      },
      get isBusy() {
        return false
      },
      get modes() {
        return {
          currentModeId: mode,
          availableModes: [
            { id: 'plan', name: 'Plan' },
            { id: 'review', name: 'Review' },
          ],
        }
      },
      get currentModeId() {
        return mode
      },
      get configOptions() {
        return [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'model-a',
            options: [{ value: 'model-a', name: 'Model A' }],
          },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: mode,
            options: [
              { value: 'plan', name: 'Plan' },
              { value: 'review', name: 'Review' },
            ],
          },
        ] satisfies readonly acp.SessionConfigOption[]
      },
      start: async () => {
        calls.push('new')
        closed = false
      },
      restore: async (binding) => {
        if (!closed && !refreshPending) return 'reused'
        const index = restoreCount++
        calls.push(`restore:${binding.agentSessionId}`)
        restoreEntered[index]?.resolve()
        await finishRestore[index]?.promise
        closed = false
        refreshPending = false
        return 'loaded'
      },
      setMode: async (value) => {
        if (closed) throw new Error('cannot write to the retired CodeBuddy process')
        calls.push(`mode:${value}`)
        mode = value
      },
      setConfigOption: async (id, value) => {
        if (closed) throw new Error('cannot write to the retired CodeBuddy process')
        if (id !== 'mode') throw new Error(`unexpected option ${id}`)
        calls.push(`mode:${String(value)}`)
        mode = String(value)
      },
      prompt: async (_content, onUpdate) => {
        promptCount += 1
        calls.push(`prompt:${promptCount}`)
        if (promptCount <= 2) {
          refreshPending = true
          return { stopReason: 'cancelled' }
        }
        onUpdate({
          sessionId: 'agent-codebuddy-controls',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' } },
        })
        return { stopReason: 'end_turn' }
      },
      retireCancelledSession: async () => {
        calls.push('retire')
        closed = true
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'codebuddy-controls',
      () => ({ ...profile(), runtime: 'codebuddy' }),
      seam(),
      () => live,
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const requestFor = (message: ReturnType<typeof user>) =>
      markAgentLoopRequest({ ...request(sessionId, message), provider: 'acp-codebuddy-controls' })
    try {
      await drain(adapter.stream(requestFor(firstMessage)))
      expect(calls).toEqual(['new', 'prompt:1', 'retire'])

      const snapshot = await adapter.agentSessionSnapshot(sessionId)
      expect(snapshot).toMatchObject({
        currentModeId: 'plan',
        modes: [{ id: 'plan' }, { id: 'review' }],
        freshness: 'live',
        editable: true,
      })
      expect(calls).toEqual(['new', 'prompt:1', 'retire']) // A read neither reconnects nor sends input.

      bindingId = 'wrong-session'
      await expect(adapter.setAgentSessionOption(sessionId, { kind: 'mode', id: 'review' })).rejects.toMatchObject({
        code: 'ACP_BINDING_UNAVAILABLE',
      })
      expect(calls).toEqual(['new', 'prompt:1', 'retire'])
      bindingId = 'agent-codebuddy-controls'

      await sidecar.writeRecoveryState({
        dshSessionId: sessionId,
        kind: 'outcome-unknown',
        detail: 'test recovery gate',
        updatedAt: Date.now(),
      })
      await expect(adapter.setAgentSessionOption(sessionId, { kind: 'mode', id: 'review' })).rejects.toMatchObject({
        code: 'ACP_RECOVERY_REQUIRED',
      })
      expect(calls).toEqual(['new', 'prompt:1', 'retire'])
      await sidecar.writeRecoveryState({ dshSessionId: sessionId, kind: 'healthy', updatedAt: Date.now() + 1 })

      const changeMode = adapter.setTeamMemberMode(sessionId, 'review')
      await restoreEntered[0]!.promise
      const concurrentModeChange = adapter.setTeamMemberMode(sessionId, 'plan')
      finishRestore[0]!.resolve()
      await Promise.all([changeMode, concurrentModeChange])
      expect(calls).toEqual([
        'new',
        'prompt:1',
        'retire',
        'restore:agent-codebuddy-controls',
        'mode:review',
        'mode:plan',
      ])
      expect(promptCount).toBe(1)

      events = [
        ...events,
        { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 4, data: nextMessage },
      ]
      await drain(adapter.stream(requestFor(nextMessage)))
      expect(promptCount).toBe(2)
      expect(calls.at(-1)).toBe('retire')

      const secondModeChange = adapter.setTeamMemberMode(sessionId, 'review')
      await restoreEntered[1]!.promise
      events = [
        ...events,
        { type: 'step/start', seq: 5, data: { turn: 3, step: 0 } },
        { type: 'user/message', seq: 6, data: finalMessage },
      ]
      const finalPrompt = drain(adapter.stream(requestFor(finalMessage)))
      expect(promptCount).toBe(2)
      finishRestore[1]!.resolve()
      await secondModeChange
      await finalPrompt
      expect(calls).toEqual([
        'new',
        'prompt:1',
        'retire',
        'restore:agent-codebuddy-controls',
        'mode:review',
        'mode:plan',
        'prompt:2',
        'retire',
        'restore:agent-codebuddy-controls',
        'mode:review',
        'prompt:3',
      ])
      expect(promptCount).toBe(3)
    } finally {
      finishRestore[0]!.resolve()
      finishRestore[1]!.resolve()
      await adapter.close()
    }
  })

  it.each(['end_turn', 'refusal', 'max_tokens', 'max_turn_requests'] as const)(
    'keeps a tool without a reported terminal state unfinished after %s',
    async (stopReason) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-unfinished-tool-'))
      roots.push(root)
      const sidecar = testSidecar(root)
      const message = user('run a tool and report back')
      const sessionId = `unfinished-${stopReason}`
      const sessions = new Map<string, SessionLike>([[sessionId, session(message)]])
      let promptCount = 0
      let runtimeCount = 0
      const runtimeFactory = (): AcpProfileRuntime => {
        runtimeCount++
        return {
          acpSessionId: `agent-${sessionId}`,
          start: async () => undefined,
          prompt: async (_content, onUpdate) => {
            promptCount++
            onUpdate({
              sessionId: `agent-${sessionId}`,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'reported-only-start',
                title: 'Inspect fixture',
                kind: 'read',
                status: 'in_progress',
              },
            } as never)
            onUpdate({
              sessionId: `agent-${sessionId}`,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'response text' } },
            } as never)
            return { stopReason } as never
          },
          close: async () => undefined,
        }
      }
      const adapter = new AcpProfileAdapter(
        'unfinished-tool',
        profile,
        seam(),
        (id) => sessions.get(id),
        ledgerFor(sidecar),
        undefined,
        runtimeFactory,
        sidecar,
      )
      for await (const _chunk of adapter.stream(request(sessionId, message))) {
        /* drain the response and persist its activity state */
      }
      const activity = (await sidecar.activitySnapshot(sessionId as never)).find((row) =>
        row.activityId.endsWith(':tool:reported-only-start'),
      )
      expect(activity).toMatchObject({ status: 'unfinished', presentation: 'Inspect fixture' })
      expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })
      expect(promptCount).toBe(1)
      expect(runtimeCount).toBe(1)
      await adapter.close()
    },
  )

  it('allows a later request after an unfinished tool and preserves a reported terminal status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-unfinished-next-request-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'unfinished-next-request'
    const firstMessage = user('start the first tool')
    const sessions = new Map<string, SessionLike>([[sessionId, session(firstMessage)]])
    let promptCount = 0
    let runtimeCount = 0
    let sendLateUpdate: ((notification: never) => void) | undefined
    const runtimeFactory = (): AcpProfileRuntime => {
      runtimeCount++
      return {
        acpSessionId: 'agent-unfinished-next-request',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          promptCount++
          if (promptCount === 1) sendLateUpdate = onUpdate as (notification: never) => void
          onUpdate({
            sessionId: 'agent-unfinished-next-request',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: promptCount === 1 ? 'no-terminal' : 'has-terminal',
              title: promptCount === 1 ? 'No terminal update' : 'Completed tool',
              kind: 'read',
              status: 'in_progress',
            },
          } as never)
          if (promptCount === 2)
            onUpdate({
              sessionId: 'agent-unfinished-next-request',
              update: { sessionUpdate: 'tool_call_update', toolCallId: 'has-terminal', status: 'completed' },
            } as never)
          onUpdate({
            sessionId: 'agent-unfinished-next-request',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer-${promptCount}` } },
          } as never)
          return { stopReason: 'end_turn' } as never
        },
        restore: async () => 'reused' as const,
        close: async () => undefined,
      }
    }
    const adapter = new AcpProfileAdapter(
      'unfinished-next-request',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    for await (const _chunk of adapter.stream(request(sessionId, firstMessage))) {
      /* drain first response */
    }
    const firstActivity = (await sidecar.activitySnapshot(sessionId as never)).find((row) =>
      row.activityId.endsWith(':tool:no-terminal'),
    )
    expect(firstActivity).toMatchObject({ status: 'unfinished' })

    const nextMessage = user('continue with the next request')
    sessions.set(sessionId, session(nextMessage))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request(sessionId, nextMessage))) chunks.push(chunk)
    const activities = await sidecar.activitySnapshot(sessionId as never)
    expect(activities.find((row) => row.activityId.endsWith(':tool:no-terminal'))).toMatchObject({
      status: 'unfinished',
    })
    expect(activities.find((row) => row.activityId.endsWith(':tool:has-terminal'))).toMatchObject({
      status: 'completed',
    })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'answer-2' })

    sendLateUpdate?.({
      sessionId: 'agent-unfinished-next-request',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'no-terminal', status: 'completed' },
    } as never)
    let lateActivity = (await sidecar.activitySnapshot(sessionId as never)).find((row) =>
      row.activityId.endsWith(':tool:no-terminal'),
    )
    for (let attempt = 0; lateActivity?.status !== 'completed' && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      lateActivity = (await sidecar.activitySnapshot(sessionId as never)).find((row) =>
        row.activityId.endsWith(':tool:no-terminal'),
      )
    }
    expect(lateActivity).toMatchObject({ status: 'completed' })
    expect(promptCount).toBe(2)
    expect(runtimeCount).toBe(1)
    await adapter.close()
  })

  it('keeps a confirmed prompt settled and the runtime usable when response projection fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-response-projection-failure-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'response-projection-failure'
    const beginDispatch = vi.spyOn(sidecar, 'beginDispatch')
    const firstMessage = user('return an image and finish')
    let promptCount = 0
    let runtimeCount = 0
    let promptFinished = false
    let failProjectionOnce = true
    const sessionView = Object.assign(session(firstMessage), {
      publishPlan: () => {
        if (promptFinished && failProjectionOnce) {
          failProjectionOnce = false
          throw new Error('injected response presentation failure')
        }
      },
    }) as SessionLike
    const sessions = new Map<string, SessionLike>([[sessionId, sessionView]])
    const runtimeFactory = (): AcpProfileRuntime => {
      runtimeCount++
      return {
        acpSessionId: 'agent-response-projection-failure',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          promptCount++
          if (promptCount === 1) {
            onUpdate({
              sessionId: 'agent-response-projection-failure',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'still-running',
                title: 'Inspect fixture',
                kind: 'read',
                status: 'in_progress',
              },
            } as never)
            onUpdate({
              sessionId: 'agent-response-projection-failure',
              update: {
                sessionUpdate: 'plan',
                entries: [{ content: 'Inspect fixture', status: 'in_progress' }],
              },
            } as never)
            onUpdate({
              sessionId: 'agent-response-projection-failure',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'confirmed answer' },
              },
            } as never)
          } else {
            onUpdate({
              sessionId: 'agent-response-projection-failure',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'next request succeeded' },
              },
            } as never)
          }
          promptFinished = promptCount === 1
          return { stopReason: 'end_turn' } as never
        },
        restore: async () => 'reused' as const,
        close: async () => undefined,
      }
    }
    const adapter = new AcpProfileAdapter(
      'response-projection-failure',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    await expect(async () => {
      for await (const _chunk of adapter.stream(request(sessionId, firstMessage))) {
        /* drain the confirmed response */
      }
    }).rejects.toMatchObject({ code: 'ACP_RESPONSE_PROJECTION_FAILED' })
    const dispatchKey = beginDispatch.mock.calls[0]?.[0].key
    expect(dispatchKey).toBeDefined()
    expect(await sidecar.readDispatch(sessionId as never, dispatchKey!)).toMatchObject({ state: 'settled' })
    expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })
    expect(
      (await sidecar.activitySnapshot(sessionId as never)).find((row) =>
        row.activityId.endsWith(':tool:still-running'),
      ),
    ).toMatchObject({ status: 'unfinished' })

    const nextMessage = user('continue after the projection problem')
    sessions.set(sessionId, session(nextMessage))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request(sessionId, nextMessage))) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'next request succeeded' })
    expect(promptCount).toBe(2)
    expect(runtimeCount).toBe(1)
    await adapter.close()
  })

  it('retains local settlement when Stop races with a failed response projection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-projection-stop-settlement-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'projection-stop-settlement'
    const firstMessage = user('return a plan and finish')
    const secondMessage = user('continue after the saved result')
    const controller = new AbortController()
    const sessionWithFailedProjection = Object.assign(session(firstMessage), {
      publishPlan: () => {
        controller.abort(new DOMException('Stopped', 'AbortError'))
        throw new Error('injected response presentation failure')
      },
    }) as SessionLike
    const sessions = new Map<string, SessionLike>([[sessionId, sessionWithFailedProjection]])
    let promptCount = 0
    let settlementWrites = 0
    let storageAvailable = false
    let instance!: AcpProfileAdapter
    let resolveStorageError!: () => void
    const storageError = new Promise<void>((resolve) => (resolveStorageError = resolve))
    const durableLedger = ledgerFor(sidecar)
    const ledger = {
      ...durableLedger,
      settle: async (id: string, key: string) => {
        settlementWrites++
        if (!storageAvailable) throw new Error('injected local ledger failure')
        return durableLedger.settle(id, key)
      },
    }
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-projection-stop-settlement',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        promptCount++
        onUpdate({
          sessionId: 'agent-projection-stop-settlement',
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Complete the request', status: 'in_progress' }],
          },
        } as never)
        if (promptCount === 2)
          onUpdate({
            sessionId: 'agent-projection-stop-settlement',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'next request succeeded' },
            },
          } as never)
        return { stopReason: 'end_turn' } as never
      },
      restore: async () => 'reused' as const,
      close: async () => undefined,
    })
    instance = new AcpProfileAdapter(
      'projection-stop-settlement',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledger,
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
      (id) => {
        if (instance.localSettlementStatus(id) === 'storage-error') resolveStorageError()
      },
    )

    await expect(async () => {
      for await (const _chunk of instance.stream({ ...request(sessionId, firstMessage), signal: controller.signal })) {
        /* drain the stopped response */
      }
    }).rejects.toMatchObject({ name: 'AbortError' })
    await storageError
    expect(settlementWrites).toBeGreaterThanOrEqual(3)
    expect(instance.localSettlementStatus(sessionId)).toBe('storage-error')
    expect(promptCount).toBe(1)

    storageAvailable = true
    sessions.set(sessionId, session(secondMessage))
    const nextChunks: unknown[] = []
    for await (const chunk of instance.stream(request(sessionId, secondMessage))) nextChunks.push(chunk)
    expect(promptCount).toBe(2)
    expect(nextChunks).toContainEqual({ type: 'text-delta', index: 0, text: 'next request succeeded' })
    expect(instance.localSettlementStatus(sessionId)).toBeUndefined()
    await instance.close()
  })

  it('ignores ACP available commands instead of registering stock slash commands', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-command-wiring-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('discover commands')
    const sessions = new Map<string, SessionLike>([['command-session', session(message)]])
    const register = vi.fn(() => vi.fn())
    const followup = vi.fn()
    const stockAgent = {
      ctx: { commands: { register } },
      followup,
    }
    const runtimeFactory = (options: { onSessionUpdate?: (notification: unknown) => void }): AcpProfileRuntime => ({
      acpSessionId: 'agent-command-session',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        const notification = {
          sessionId: 'agent-command-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'path or scope' } }],
          },
        }
        options.onSessionUpdate?.(notification)
        onUpdate({
          sessionId: 'agent-command-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory as never,
      sidecar,
      undefined,
      () => ({ userQuestions: {} as never, getAgent: () => stockAgent }),
    )
    for await (const _chunk of adapter.stream(request('command-session', message))) {
      /* drain */
    }
    expect(register).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('stores ACP assistant images as native DSH blocks without reordering content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-native-image-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('show the image')
    const sessions = new Map<string, SessionLike>([['native-image-session', session(message)]])
    const imageRef = {
      attachmentId: 'sha256:test-image',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    } as never
    const saveImages = vi.fn(async (_inputs: readonly { mediaType: string; data: Uint8Array }[]) => [imageRef])
    const attachments = {
      imageLimits: {
        maxImageBytes: 1_000,
        maxImagesPerMessage: 10,
        maxMessageImageBytes: 10_000,
        maxImagePixels: 1_000,
        maxImageDimension: 100,
        mediaTypes: ['image/png'],
      },
      readImage: async () => {
        throw new Error('not used')
      },
      saveImages,
    }
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-native-image',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-native-image',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } },
        } as never)
        onUpdate({
          sessionId: 'agent-native-image',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: 'AQ==' },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-native-image',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'image-check',
            title: 'Inspect image',
            kind: 'read',
            status: 'in_progress',
          },
        } as never)
        onUpdate({
          sessionId: 'agent-native-image',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } },
        } as never)
        onUpdate({
          sessionId: 'agent-native-image',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'image-check', status: 'completed' },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'native-image',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
      attachments as never,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('native-image-session', message))) chunks.push(chunk)
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'text-delta', index: 0, text: 'before' },
        { type: 'block-start', index: 1, blockType: 'image' },
        { type: 'block-end', index: 1, block: { type: 'image', attachment: imageRef } },
        { type: 'text-delta', index: 2, text: 'after' },
      ]),
    )
    expect(chunks.map((chunk) => (chunk as { type?: string }).type).slice(0, 4)).toEqual([
      'text-delta',
      'block-start',
      'block-end',
      'text-delta',
    ])
    const saved = saveImages.mock.calls[0]?.[0]?.[0] as { mediaType?: string; data?: Uint8Array } | undefined
    const activities = await sidecar.activitySnapshot('native-image-session' as never, 20)
    expect(activities.find((row) => row.activityId.endsWith(':tool:image-check'))?.contentIndex).toBe(2)
    expect(saved?.mediaType).toBe('image/png')
    expect(Array.from(saved?.data ?? [])).toEqual([1])
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'finish') as
      { reason?: { kind?: string } } | undefined
    expect(finish?.reason?.kind).toBe('stop')
  })

  it('uses bounded visible fallbacks when non-text ACP output cannot be rendered', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-nontext-fallback-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('return resources')
    const sessions = new Map<string, SessionLike>([['nontext-session', session(message)]])
    const saveImages = vi.fn(async (_inputs: readonly { mediaType: string; data: Uint8Array }[]) => {
      throw new Error('image store unavailable')
    })
    const attachments = {
      imageLimits: {
        maxImageBytes: 1_000,
        maxImagesPerMessage: 10,
        maxMessageImageBytes: 10_000,
        maxImagePixels: 1_000,
        maxImageDimension: 100,
        mediaTypes: ['image/png'],
      },
      readImage: async () => {
        throw new Error('not used')
      },
      saveImages,
    }
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-nontext',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: 'AQ==', uri: 'memory://image' },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO_BYTES' },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: 'report',
              mimeType: 'application/pdf',
              uri: 'https://example.test/report?token=super-secret-value',
            },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource',
              resource: {
                uri: 'memory://notes',
                mimeType: 'text/markdown',
                text: 'Visible embedded body\nsecond line',
              },
            },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource',
              resource: { uri: 'memory://blob', mimeType: 'application/octet-stream', blob: 'SECRET_RESOURCE_BLOB' },
            },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'nontext',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
      attachments as never,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('nontext-session', message))) chunks.push(chunk)
    const visible = chunks
      .filter(
        (chunk): chunk is { type: 'text-delta'; text: string } => (chunk as { type?: string }).type === 'text-delta',
      )
      .map((chunk) => chunk.text)
      .join('')
    expect(visible).toContain('ACP image (image/png; memory://image)')
    expect(visible).toContain('ACP audio (audio/wav)')
    expect(visible).toContain('ACP resource: report (application/pdf)')
    expect(visible).toContain('ACP embedded text resource (text/markdown)')
    expect(visible).toContain('Visible embedded body\nsecond line')
    expect(visible).toContain('ACP embedded binary resource (application/octet-stream)')
    expect(visible).not.toContain('AQ==')
    expect(visible).not.toContain('SECRET_AUDIO_BYTES')
    expect(visible).not.toContain('super-secret-value')
    expect(visible).not.toContain('SECRET_RESOURCE_BLOB')
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'finish') as
      { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'stop' })
  })

  it('projects visible fallbacks for a non-text Claude native child without leaking them into the root answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-claude-child-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('delegate this work')
    const sessions = new Map<string, SessionLike>([['claude-root', session(message)]])
    const projected: unknown[] = []
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'claude-agent-root',
      agentInfo: { name: 'claude-agent-acp', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'claude-agent-root',
          update: {
            sessionUpdate: 'subagent_spawned',
            subagentSessionId: 'claude-agent-child',
            name: 'Research',
            task: 'Inspect source',
            capabilities: {},
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-child',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: 'AQ==' },
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-child',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO' },
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-child',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'resource_link', name: 'report', uri: 'https://example.test/child?token=secret' },
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-child',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource',
              resource: { uri: 'memory://notes', mimeType: 'text/plain', text: 'child embedded text' },
            },
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-root',
          update: {
            sessionUpdate: 'subagent_state_update',
            subagentSessionId: 'claude-agent-child',
            state: 'completed',
          },
        } as never)
        onUpdate({
          sessionId: 'claude-agent-root',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root-visible result' } },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'claude',
      claudeProfile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
      undefined,
      undefined,
      async (observation) => {
        projected.push(observation)
        return 'projected-child-session'
      },
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(
      markAgentLoopRequest({
        provider: 'acp-claude',
        model: 'claude-model',
        sessionId: 'claude-root' as never,
        messages: [message],
      }),
    ))
      chunks.push(chunk)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'root-visible result' })
    const rootText = chunks
      .flatMap((chunk) =>
        typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'text-delta'
          ? [String((chunk as { text?: unknown }).text ?? '')]
          : [],
      )
      .join('')
    expect(rootText).toBe('root-visible result')
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      vendorDelegationKey: 'claude-agent-child',
      task: { text: 'Inspect source' },
      result: { completeness: 'final-output' },
      projectionEligible: true,
    })
    const projectedText = (projected[0] as { result: { text: string } }).result.text
    expect(projectedText).toContain('ACP image (image/png)')
    expect(projectedText).toContain('ACP audio (audio/wav)')
    expect(projectedText).toContain('ACP resource: report')
    expect(projectedText).toContain('ACP embedded text resource (text/plain)')
    expect(projectedText).toContain('child embedded text')
    expect(projectedText).not.toContain('AQ==')
    expect(projectedText).not.toContain('SECRET_AUDIO')
    expect(projectedText).not.toContain('token=secret')
  })

  it('journals ACP tool/content updates without creating DSH tool chunks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-adapter-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('inspect the project')
    const sessions = new Map<string, SessionLike>([['session-1', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => {
      let sessionId = 'agent-session-1'
      return {
        get acpSessionId() {
          return sessionId
        },
        agentInfo: { name: 'activity-agent', version: '1' },
        agentCapabilities: {},
        protocolVersion: 1,
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          onUpdate({
            sessionId: sessionId as never,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'Read project',
              name: 'read_file',
              kind: 'read',
              status: 'in_progress',
              rawInput: { path: '/tmp/project', apiKey: 'secret-value' },
              locations: [{ path: '/tmp/project/app.ts', line: 1 }],
            },
          } as never)
          onUpdate({
            sessionId: sessionId as never,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'work' } },
          } as never)
          onUpdate({
            sessionId: sessionId as never,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              content: [{ type: 'diff', path: '/tmp/project/app.ts', oldText: 'a', newText: 'b' }],
            },
          } as never)
          onUpdate({
            sessionId: sessionId as never,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ing' } },
          } as never)
          // ACP tool_call_update is a sparse patch.  In particular name:null
          // leaves the existing name unchanged and omitted content/locations
          // must survive the terminal frame.
          onUpdate({
            sessionId: sessionId as never,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              name: null,
              status: 'completed',
              rawOutput: { result: 'ok' },
            },
          } as never)
          onUpdate({
            sessionId: sessionId as never,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
          } as never)
          sessionId = 'agent-session-1'
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }
    }
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-1', message))) chunks.push(chunk)
    const activities = await sidecar.activitySnapshot('session-1' as never)
    expect(
      activities.map((item) => [item.activityId.slice(item.activityId.indexOf(':') + 1), item.kind, item.status]),
    ).toEqual([
      ['tool:tool-1', 'tool', 'completed'],
      ['part:tool-1:0:diff', 'diff', 'completed'],
    ])
    expect(chunks.filter((chunk) => (chunk as { type: string }).type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: 'work' },
      { type: 'text-delta', index: 0, text: 'ing' },
      { type: 'text-delta', index: 0, text: 'done' },
    ])
    expect(activities.map((activity) => activity.contentIndex)).toEqual([0, 0])
    expect(activities[0]?.activitySeq).toBe(1)
    expect(activities[1]?.activitySeq).toBe(2)
    expect(activities[0]?.rawDetail).not.toContain('secret-value')
    expect(activities[0]?.rawDetail).toContain('"toolKind":"read"')
    expect(activities[0]?.rawDetail).toContain('"toolName":"read_file"')
    expect(activities[0]?.rawDetail).toContain('"rawInput"')
    expect(activities[0]?.rawDetail).toContain('"rawOutput":{"result":"ok"}')
    expect(activities[0]?.rawDetail).toContain('"locations"')
    expect(activities[0]?.rawDetail).toContain('"content"')
    expect(
      chunks.filter(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          (chunk as { type?: unknown }).type === 'tool-call',
      ).length,
    ).toBe(0)
    const finish = chunks.find(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'type' in chunk &&
        (chunk as { type?: unknown }).type === 'finish',
    ) as { replayState?: { response?: { committedActivitySeq?: number } } } | undefined
    expect(finish?.replayState?.response?.committedActivitySeq).toBe(5)
  })

  it.each([false, true])(
    'keeps tool IDs distinct from normalized content IDs when collision-first=%s',
    async (collisionFirst) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-content-identity-'))
      roots.push(root)
      const sidecar = testSidecar(root)
      const message = user('inspect tool output')
      const sessions = new Map<string, SessionLike>([['content-identity-session', session(message)]])
      const runtimeFactory = (): AcpProfileRuntime => ({
        acpSessionId: 'agent-content-identity',
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          const send = (update: unknown) => onUpdate({ sessionId: 'agent-content-identity', update } as never)
          const sourceTool = {
            sessionUpdate: 'tool_call',
            toolCallId: 'a',
            title: 'Source tool a',
            kind: 'other',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'source output' } }],
          }
          const collidingTool = {
            sessionUpdate: 'tool_call',
            toolCallId: 'a:0:content',
            title: 'Independent tool a:0:content',
            kind: 'other',
            status: 'completed',
          }
          if (collisionFirst) {
            send(collidingTool)
            send(sourceTool)
          } else {
            send(sourceTool)
            send(collidingTool)
          }
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      })
      const adapter = new AcpProfileAdapter(
        'activity',
        profile,
        seam(),
        (id) => sessions.get(id),
        ledgerFor(sidecar),
        undefined,
        runtimeFactory,
        sidecar,
      )
      try {
        await drain(adapter.stream(request('content-identity-session', message)))
        const activities = await sidecar.activitySnapshot('content-identity-session' as never)
        const anchor = activities[0]?.promptAnchorMessageId
        expect(anchor).toBeDefined()
        expect(activities.map((row) => row.activityId).sort()).toEqual(
          [`${anchor}:tool:a`, `${anchor}:part:a:0:content`, `${anchor}:tool:a:0:content`].sort(),
        )
        expect(activities).toHaveLength(3)
        expect(activities.find((row) => row.activityId === `${anchor}:tool:a`)).toMatchObject({
          kind: 'tool',
          presentation: 'Source tool a',
        })
        expect(activities.find((row) => row.activityId === `${anchor}:part:a:0:content`)).toMatchObject({
          kind: 'other',
          presentation: 'Tool output',
        })
        expect(activities.find((row) => row.activityId === `${anchor}:part:a:0:content`)?.rawDetail).toContain(
          'source output',
        )
        expect(activities.find((row) => row.activityId === `${anchor}:tool:a:0:content`)).toMatchObject({
          kind: 'tool',
          presentation: 'Independent tool a:0:content',
        })
      } finally {
        await adapter.close()
      }
    },
  )

  it('shows Devin external child identity on its source tool row while the child is held', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-live-external-child-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('delegate this work')
    const sessions = new Map<string, SessionLike>([['external-live-session', session(message)]])
    const childStarted = Promise.withResolvers<void>()
    const holdChild = Promise.withResolvers<void>()
    const projected = vi.fn(async () => 'must-not-be-created-while-running')
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'devin-agent-session',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'devin-agent-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'external-call-1',
            title: 'Inspect fixture',
            name: 'tool"\\\u0000'.repeat(1_000),
            kind: 'kind"\\\u0000'.repeat(1_000),
            status: 'in_progress',
            rawInput: { prompt: 'P'.repeat(4_096) },
            _meta: {
              'cognition.ai/subagent_started': {
                agentId: 'external-child-1',
                title: 'Research files',
                task: 'Inspect the fixture source',
              },
            },
          },
        } as never)
        for (let index = 2; index <= 64; index++) {
          onUpdate({
            sessionId: 'devin-agent-session',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'external-call-1',
              status: 'in_progress',
              _meta: {
                'cognition.ai/subagent_started': {
                  agentId: `external-child-${index}`,
                  title: '"\\\u0000'.repeat(400),
                  task: 'A duplicated task that should remain only in terminal projection data',
                },
              },
            },
          } as never)
        }
        childStarted.resolve()
        await holdChild.promise
        onUpdate({
          sessionId: 'devin-agent-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'external-call-1',
            status: 'completed',
            rawOutput: 'O'.repeat(4_096),
          },
        } as never)
        onUpdate({
          sessionId: 'devin-agent-session',
          update: {
            sessionUpdate: 'usage_update',
            toolCallId: 'external-call-1',
            _meta: {
              'cognition.ai/subagent_completed': {
                agentId: 'external-child-1',
                summary: 'Inspection complete',
                success: true,
              },
            },
          },
        } as never)
        onUpdate({
          sessionId: 'devin-agent-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'devin',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
      undefined,
      undefined,
      projected as never,
    )
    const drain = (async () => {
      for await (const _chunk of adapter.stream(request('external-live-session', message))) {
        /* drain until the held child is released */
      }
    })()
    await childStarted.promise
    let running = (await sidecar.activitySnapshot('external-live-session' as never)).find((activity) =>
      activity.activityId.endsWith(':tool:external-call-1'),
    )
    for (let attempt = 0; running === undefined && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      running = (await sidecar.activitySnapshot('external-live-session' as never)).find((activity) =>
        activity.activityId.endsWith(':tool:external-call-1'),
      )
    }
    expect(running).toMatchObject({
      status: 'running',
      presentation: 'Inspect fixture',
    })
    expect(running?.activityId).toContain(':tool:external-call-1')
    const runningDetail = JSON.parse(running!.rawDetail!) as { externalDelegations?: unknown[] }
    expect(runningDetail.externalDelegations).toHaveLength(64)
    expect(runningDetail.externalDelegations?.[0]).toMatchObject({ label: 'Research files', status: 'running' })
    expect(runningDetail).not.toHaveProperty('task')
    expect(runningDetail).toHaveProperty('detailsOmitted', true)
    expect(running!.rawDetail!.length).toBeLessThan(16_384)
    expect(
      runningDetail.externalDelegations?.every(
        (fact) =>
          Object.keys(fact as object)
            .sort()
            .join(',') === 'label,status',
      ),
    ).toBe(true)
    expect(projected).not.toHaveBeenCalled()

    holdChild.resolve()
    await drain
    const completed = (await sidecar.activitySnapshot('external-live-session' as never)).find((activity) =>
      activity.activityId.endsWith(':tool:external-call-1'),
    )
    expect(completed).toMatchObject({ status: 'completed' })
    expect(completed?.rawDetail?.length).toBeLessThan(16_384)
    const completedDetail = JSON.parse(completed!.rawDetail!) as {
      externalDelegations?: { status?: string }[]
      toolName?: string
      toolKind?: string
      detailsOmitted?: boolean
    }
    expect(completedDetail.externalDelegations).toHaveLength(64)
    expect(completedDetail.externalDelegations?.[0]?.status).toBe('completed')
    expect(completedDetail.externalDelegations?.slice(1).every((fact) => fact.status === 'unfinished')).toBe(true)
    expect(completedDetail).toHaveProperty('detailsOmitted', true)
    expect(completedDetail.toolName).toBeDefined()
    expect(completedDetail.toolName!.length).toBeLessThanOrEqual(96)
    expect(completedDetail.toolKind).toBeDefined()
    expect(completedDetail.toolKind!.length).toBeLessThanOrEqual(32)
    expect(completedDetail).not.toHaveProperty('rawInput')
    expect(completedDetail).not.toHaveProperty('rawOutput')
    expect(projected).toHaveBeenCalledOnce()
    await adapter.close()
  })

  it('settles replaced tool details after their queued first update', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-detail-order-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('inspect replacements')
    const sessions = new Map<string, SessionLike>([['session-details', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-details',
      agentInfo: { name: 'activity-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        const update = (value: unknown) => onUpdate({ sessionId: 'agent-details', update: value } as never)
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'replace',
          title: 'Edit then read',
          kind: 'edit',
          status: 'in_progress',
          content: [{ type: 'diff', path: 'file.txt', oldText: 'before', newText: 'after' }],
        })
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'replace', status: 'completed', content: [] })
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    for await (const _chunk of adapter.stream(request('session-details', message))) {
      /* consume */
    }
    const rows = await sidecar.activitySnapshot('session-details' as never)
    expect(rows.map((row) => [row.kind, row.status, row.contentIndex])).toEqual([
      ['tool', 'completed', 0],
      ['diff', 'completed', 0],
    ])
    expect(rows[0]!.activitySeq).toBeLessThan(rows[1]!.activitySeq)
    expect(rows[1]!.revisionSeq).toBeGreaterThan(rows[1]!.activitySeq)
  })

  it('uses a readable fallback for unknown ACP updates and does not block the turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-unknown-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('continue')
    const sessions = new Map<string, SessionLike>([['session-2', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-2',
      agentInfo: { name: 'activity-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-2' as never,
          update: { sessionUpdate: 'vendor_progress', detail: 'working' },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-2', message))) chunks.push(chunk)
    expect(
      chunks.some(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          (chunk as { type?: unknown }).type === 'finish',
      ),
    ).toBe(true)
    expect((await sidecar.activitySnapshot('session-2' as never))[0]?.presentation).toBe('Agent activity')
  })

  it('fails a successful ACP turn that emitted reasoning but no visible answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-reasoning-only-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Reply exactly RESPONSE_OK.')
    const sessions = new Map<string, SessionLike>([['session-reasoning-only', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-reasoning-only',
      agentInfo: { name: 'reasoning-only-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-reasoning-only' as never,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'private reasoning RESPONSE_OK.' },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'reasoning-only',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-reasoning-only', message))) chunks.push(chunk)
    expect(
      chunks.some(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          (chunk as { type?: unknown }).type === 'reasoning-delta',
      ),
    ).toBe(true)
    const finish = chunks.find(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'type' in chunk &&
        (chunk as { type?: unknown }).type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({
      kind: 'error',
      failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message: 'ACP agent completed without a visible response' },
    })
  })

  it('accepts a prompt-scoped successful terminal-tool callback as evidence for an empty end_turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-terminal-tool-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Return the requested structured result.')
    const sessions = new Map<string, SessionLike>([['session-terminal-tool', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-terminal-tool',
      agentInfo: { name: 'terminal-tool-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal, _onTeamReport, onTurnConcluded) => {
        onTurnConcluded?.()
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'terminal-tool',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-terminal-tool', message))) chunks.push(chunk)
    const finish = chunks.find(
      (chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'stop' })
  })

  it('accepts an empty end_turn after a successful prompt-scoped Host tool result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-successful-tool-only-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Create the requested teammate.')
    const sessions = new Map<string, SessionLike>([['session-successful-tool-only', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-successful-tool-only',
      agentInfo: { name: 'tool-only-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal, _onTeamReport, _onTurnConcluded, onSuccessfulToolResult) => {
        onSuccessfulToolResult?.()
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'successful-tool-only',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-successful-tool-only', message))) chunks.push(chunk)
    const finish = chunks.find(
      (chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'stop' })
  })

  it.each([
    ['refusal', 'error', 'ACP_REFUSAL'],
    ['max_tokens', 'max-tokens', undefined],
    ['max_turn_requests', 'error', 'ACP_MAX_TURN_REQUESTS'],
  ] as const)('preserves %s even when a Host tool result succeeded', async (stopReason, expectedKind, code) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-acp-tool-result-${stopReason}-`))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Use the requested tool.')
    const sessionId = `session-tool-result-${stopReason}`
    const sessions = new Map<string, SessionLike>([[sessionId, session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: `agent-${sessionId}`,
      agentInfo: { name: 'tool-result-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, _onUpdate, _signal, _onTeamReport, _onTurnConcluded, onSuccessfulToolResult) => {
        onSuccessfulToolResult?.()
        return { stopReason } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'tool-result-status',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request(sessionId, message))) chunks.push(chunk)
    const finish = chunks.find(
      (chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason?.kind).toBe(expectedKind)
    if (code === undefined) expect(finish?.reason).not.toHaveProperty('failure.code', 'ACP_NO_VISIBLE_RESPONSE')
    else expect(finish?.reason).toMatchObject({ failure: { code } })
  })

  it('keeps non-text ACP thought content as safe reasoning and audits the degradation without showing an answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-nontext-thought-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Continue safely')
    const sessions = new Map<string, SessionLike>([['session-nontext-thought', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-nontext-thought',
      agentInfo: { name: 'thought-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-nontext-thought' as never,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: {
              type: 'image',
              mimeType: 'image/png',
              data: 'private-image-bytes',
              uri: 'memory://?token=private',
            },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'nontext-thought',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-nontext-thought', message))) chunks.push(chunk)
    const reasoning = chunks.filter(
      (chunk): chunk is { type: string; text?: string } =>
        typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'reasoning-delta',
    )
    expect(reasoning.map((chunk) => chunk.text).join('')).toBe('[ACP image reasoning content omitted.]')
    const finish = chunks.find(
      (chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE' } })

    const entries = await sidecar.list('session-nontext-thought' as never)
    const degradation = entries.find((entry) => entry.kind === 'degradation')
    expect(degradation?.data).toMatchObject({
      code: 'unsupported-chunk-content',
      items: [
        {
          type: 'image',
          reason: 'non-text ACP thought content was omitted from the safe reasoning preview',
        },
      ],
    })
    expect(JSON.stringify(degradation)).not.toContain('private-image-bytes')
    expect(JSON.stringify(degradation)).not.toContain('token=private')
  })

  it('does not treat whitespace-only assistant chunks as a visible answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-whitespace-response-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Reply exactly RESPONSE_OK.')
    const sessions = new Map<string, SessionLike>([['session-whitespace', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-whitespace',
      agentInfo: { name: 'whitespace-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-whitespace' as never,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' \n\t ' } },
        } as never)
        onUpdate({
          sessionId: 'agent-session-whitespace' as never,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'private reasoning RESPONSE_OK.' },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'whitespace',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-whitespace', message))) chunks.push(chunk)
    const finish = chunks.find(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'type' in chunk &&
        (chunk as { type?: unknown }).type === 'finish',
    ) as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({
      kind: 'error',
      failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message: 'ACP agent completed without a visible response' },
    })
  })

  it('ignores standard control frames and closes known children when terminal update has no content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-controls-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('run')
    const sessions = new Map<string, SessionLike>([['session-3', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-3',
      agentInfo: { name: 'activity-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-3' as never,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-3',
            title: 'Run',
            status: 'in_progress',
            content: [{ type: 'terminal', terminalId: 'term-3' }],
          },
        } as never)
        onUpdate({ sessionId: 'agent-session-3' as never, update: { sessionUpdate: 'usage_update', used: 2 } } as never)
        onUpdate({
          sessionId: 'agent-session-3' as never,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-3', status: 'completed' },
        } as never)
        onUpdate({
          sessionId: 'agent-session-3' as never,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    for await (const _ of adapter.stream(request('session-3', message))) {
      /* drain */
    }
    const rows = await sidecar.activitySnapshot('session-3' as never)
    expect(rows.map((row) => [row.activityId.slice(row.activityId.indexOf(':') + 1), row.kind, row.status])).toEqual([
      ['tool:tool-3', 'tool', 'completed'],
      ['part:tool-3:0:terminal', 'terminal', 'completed'],
    ])
    expect(rows[0]?.presentation).toBe('Run')
    expect(rows.some((row) => row.presentation === 'Agent activity')).toBe(false)
  })

  it('does not turn an activity-head read failure into recovery or a missing finish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-head-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const failingSidecar = Object.create(sidecar) as AcpSidecar
    sidecars.push(failingSidecar)
    const append = vi.fn(sidecar.append.bind(sidecar))
    failingSidecar.append = append
    failingSidecar.activityHead = async () => {
      throw new Error('activity head unavailable')
    }
    const message = user('finish')
    const sessions = new Map<string, SessionLike>([['session-4', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-4',
      agentInfo: { name: 'activity-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async () => ({ stopReason: 'end_turn' }) as never,
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(failingSidecar),
      undefined,
      runtimeFactory,
      failingSidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-4', message))) chunks.push(chunk)
    expect(
      chunks.some(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          (chunk as { type?: unknown }).type === 'finish',
      ),
    ).toBe(true)
    expect((await sidecar.readRecoveryState('session-4' as never))?.kind).toBe('healthy')
    expect(append).toHaveBeenCalledWith(
      'session-4',
      expect.objectContaining({
        kind: 'degradation',
        data: expect.objectContaining({
          code: 'activity-head-unavailable',
          items: [{ type: 'activity-head', reason: 'activity cursor could not be read at turn finish' }],
        }),
      }),
    )
  })

  it('audits unsupported assistant content without persisting its payload or changing a successful finish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-answer-content-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('describe this')
    const sessions = new Map<string, SessionLike>([['answer-content', session(message)]])
    const secretBytes = 'base64-private-payload'
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'answer-agent',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'answer-agent',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'audio', data: secretBytes, mimeType: 'audio/wav' },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('answer-content', message))) chunks.push(chunk)
    const entries = await sidecar.list('answer-content' as never)
    const degradation = entries.find((entry) => entry.kind === 'degradation')
    expect(degradation?.data).toMatchObject({
      code: 'unsupported-chunk-content',
      items: [{ type: 'audio', reason: 'non-text ACP answer content was rendered with a safe text fallback' }],
    })
    expect(JSON.stringify(degradation)).not.toContain(secretBytes)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect((await sidecar.readRecoveryState('answer-content' as never))?.kind).toBe('healthy')
  })

  it('settles a definitely undispatched Host tool without creating a recovery gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-tool-not-dispatched-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'not-dispatched-session'
    const message = user('run the tool')
    const sessions = new Map<string, SessionLike>([[sessionId, session(message)]])
    const beginDispatch = vi.spyOn(sidecar, 'beginDispatch')
    let promptCount = 0
    let restoreCount = 0
    let closeCount = 0
    const instances: Array<{ active: boolean }> = []
    const runtimeFactory = vi.fn((): AcpProfileRuntime => {
      const instance = { active: false }
      instances.push(instance)
      return {
        acpSessionId: 'agent-not-dispatched',
        start: async () => {
          instance.active = true
        },
        restore: async (binding: { agentSessionId: string }) => {
          restoreCount++
          if (!instance.active) throw new Error('Agent does not advertise session restore')
          if (binding.agentSessionId !== 'agent-not-dispatched') throw new Error('binding mismatch')
          return 'reused' as const
        },
        prompt: async (_content, onUpdate) => {
          promptCount++
          if (promptCount === 1) throw new AcpHostSettlementError('ACP_HOST_TOOL_NOT_DISPATCHED')
          onUpdate({
            sessionId: 'agent-not-dispatched',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'next step succeeded' } },
          })
          return { stopReason: 'end_turn' } as never
        },
        close: async () => {
          closeCount++
          instance.active = false
        },
      }
    })
    const adapter = new AcpProfileAdapter(
      'not-dispatched',
      profile,
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    await expect(async () => {
      for await (const _chunk of adapter.stream(request(sessionId, message))) {
        // Drain the public stream so the adapter's settlement path completes.
      }
    }).rejects.toMatchObject({ code: 'ACP_HOST_TOOL_NOT_DISPATCHED' })
    const dispatchKey = beginDispatch.mock.calls[0]?.[0].key
    expect(dispatchKey).toBeDefined()
    expect(await sidecar.readDispatch(sessionId as never, dispatchKey!)).toMatchObject({ state: 'settled' })
    expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })
    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(instances[0]?.active).toBe(true)
    expect(closeCount).toBe(0)

    const nextMessage = user('a new step after confirmed non-dispatch')
    sessions.set(sessionId, session(nextMessage))
    const nextChunks: unknown[] = []
    for await (const chunk of adapter.stream(request(sessionId, nextMessage))) nextChunks.push(chunk)
    const nextDispatchKey = beginDispatch.mock.calls[1]?.[0].key
    expect(nextDispatchKey).toBeDefined()
    expect(nextDispatchKey).not.toBe(dispatchKey)
    expect(await sidecar.readDispatch(sessionId as never, nextDispatchKey!)).toMatchObject({ state: 'settled' })
    expect(promptCount).toBe(2)
    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(restoreCount).toBe(1)
    expect(closeCount).toBe(0)
    expect(instances[0]?.active).toBe(true)
    expect(nextChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await adapter.close()
    expect(closeCount).toBe(1)
    expect(instances[0]?.active).toBe(false)
  })

  it('retains an explicit CodeBuddy runtime for a later same-binding refresh after transient pre-dispatch failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-codebuddy-refresh-retry-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const sessionId = 'codebuddy-refresh-session'
    const firstMessage = user('continue the existing CodeBuddy session')
    const sessions = new Map<string, SessionLike>([[sessionId, session(firstMessage)]])
    let refreshPending = false
    let failRefreshOnce = true
    let promptCount = 0
    let restoreCount = 0
    let closeCount = 0
    let retirementCount = 0
    let refreshed = false
    const runtimeFactory = vi.fn((options: AcpSessionRuntimeOptions): AcpProfileRuntime => {
      expect(options.refreshSessionAfterCancelledPrompt).toBe(true)
      return {
        acpSessionId: 'agent-codebuddy-refresh',
        agentInfo: { name: 'codebuddy-code', version: '2.161.2' },
        agentCapabilities: { loadSession: true },
        protocolVersion: 1,
        start: async () => undefined,
        restore: async (binding) => {
          restoreCount += 1
          expect(binding.agentSessionId).toBe('agent-codebuddy-refresh')
          if (refreshPending && failRefreshOnce) {
            failRefreshOnce = false
            throw new AcpSessionRefreshRetryError(new Error('transient load transport failure'))
          }
          if (refreshPending) {
            refreshPending = false
            refreshed = true
          }
          return refreshed ? 'loaded' : 'reused'
        },
        get lastRestoreRefreshedCancelledSession() {
          return refreshed
        },
        get cancelledSessionRefreshPending() {
          return refreshPending
        },
        prompt: async (_content, onUpdate) => {
          promptCount += 1
          if (promptCount === 1) {
            refreshPending = true
            return { stopReason: 'cancelled' } as never
          }
          onUpdate({
            sessionId: 'agent-codebuddy-refresh',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' } },
          } as never)
          return { stopReason: 'end_turn' } as never
        },
        retireCancelledSession: async () => {
          retirementCount += 1
          closeCount += 1
        },
        close: async () => {
          closeCount += 1
        },
      }
    })
    const adapter = new AcpProfileAdapter(
      'codebuddy-code',
      () => ({ ...profile(), runtime: 'codebuddy' }),
      seam(),
      (id) => sessions.get(id),
      ledgerFor(sidecar),
      undefined,
      runtimeFactory,
      sidecar,
    )
    const requestFor = (message: ReturnType<typeof user>) =>
      markAgentLoopRequest({ ...request(sessionId, message), provider: 'acp-codebuddy-code' })
    try {
      const firstChunks: unknown[] = []
      for await (const chunk of adapter.stream(requestFor(firstMessage))) firstChunks.push(chunk)
      expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(retirementCount).toBe(1)
      expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })

      const failedRefreshMessage = user('continue after the cancellation')
      sessions.set(sessionId, session(failedRefreshMessage))
      await expect(async () => {
        for await (const _chunk of adapter.stream(requestFor(failedRefreshMessage))) {
          // Drain the failed pre-dispatch stream.
        }
      }).rejects.toMatchObject({ code: 'ACP_SESSION_REFRESH_FAILED' })
      expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })
      expect(runtimeFactory).toHaveBeenCalledOnce()
      expect(closeCount).toBe(1)
      expect(promptCount).toBe(1)

      const retryMessage = user('continue after the temporary refresh failure')
      sessions.set(sessionId, session(retryMessage))
      const nextChunks: unknown[] = []
      for await (const chunk of adapter.stream(requestFor(retryMessage))) nextChunks.push(chunk)
      expect(nextChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(runtimeFactory).toHaveBeenCalledOnce()
      expect(restoreCount).toBe(2)
      expect(promptCount).toBe(2)
      expect(closeCount).toBe(1)
      expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({ kind: 'healthy' })
    } finally {
      await adapter.close()
      expect(closeCount).toBe(2)
    }
  })

  it('shares quarantined Host owners and WAL fallback across adapter replacement until explicit recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-host-owner-adapter-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const hostRoot = new Context()
    const sessionId = 'host-owner-session'
    const message = user('continue after tool recovery')
    const sessions = new Map<string, SessionLike>([[sessionId, session(message)]])
    const callSettled = Promise.withResolvers<void>()
    let pending = true
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-host-owner',
      start: async () => undefined,
      prompt: async () => {
        throw new AcpHostSettlementError('ACP_HOST_CALL_DRAIN_TIMEOUT')
      },
      close: async () => undefined,
      hasPendingHostCalls: () => pending,
      waitForHostCallsSettled: () => callSettled.promise,
    })
    const writeRecovery = sidecar.writeRecoveryState.bind(sidecar)
    const beginDispatch = vi.spyOn(sidecar, 'beginDispatch')
    vi.spyOn(sidecar, 'writeRecoveryState').mockImplementation(async (state, options) => {
      if (state.kind === 'outcome-unknown') throw new Error('injected recovery WAL failure')
      await writeRecovery(state, options)
    })
    const makeAdapter = (id: string) =>
      new AcpProfileAdapter(
        id,
        profile,
        seam(),
        (key) => sessions.get(key),
        ledgerFor(sidecar),
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
        undefined,
        hostRoot,
      )
    const first = makeAdapter('first-profile')
    await expect(async () => {
      for await (const _chunk of first.stream(request(sessionId, message))) {
        // Drain the public stream so the adapter's settlement path completes.
      }
    }).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    const fallbackAdapter = makeAdapter('replacement-profile')
    expect(fallbackAdapter.recoveryStateFallback(sessionId)).toMatchObject({
      kind: 'outcome-unknown',
      detail: 'ACP prompt ended while a DSH Host tool was still active and its outcome could not be confirmed.',
    })
    await expect(fallbackAdapter.rebindBlank(sessionId)).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
    const blockedChunks: unknown[] = []
    await expect(async () => {
      for await (const chunk of fallbackAdapter.stream(request(sessionId, message))) blockedChunks.push(chunk)
    }).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })

    pending = false
    callSettled.resolve()
    await fallbackAdapter.rebindBlank(sessionId)
    const dispatchKey = beginDispatch.mock.calls[0]?.[0].key
    expect(dispatchKey).toBeDefined()
    expect(await sidecar.readRecoveryState(sessionId as never)).toMatchObject({
      kind: 'healthy',
      lastUserAction: 'rebind-blank',
    })
    expect(await sidecar.readDispatch(sessionId as never, dispatchKey!)).toBeUndefined()
    expect(fallbackAdapter.recoveryStateFallback(sessionId)).toBeUndefined()
  })
})
