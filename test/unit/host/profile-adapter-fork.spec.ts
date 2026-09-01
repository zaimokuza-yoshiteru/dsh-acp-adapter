import { describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { snapshotSessionEvents, type SessionLike } from '../../../src/domain/session/current-step-admission.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts'

const profile = (): AcpAgentConfig => ({ name: 'Fork test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const makeSession = (message: ReturnType<typeof user>, extra: { parentSession?: string; inheritedEventCount?: number } = {}): SessionLike => ({
  header: { cwd: os.tmpdir(), ...(extra.parentSession === undefined ? {} : { parentSession: extra.parentSession }) },
  inheritedEventCount: extra.inheritedEventCount ?? 0,
  snapshotEvents: () => [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: message },
  ],
})
const request = (id: string, message: ReturnType<typeof user>): GenerateOptions => markAgentLoopRequest({
  provider: 'acp-test', model: 'model-a', sessionId: id as never, messages: [message],
})
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })

function ledgerFor(sidecar: AcpSidecar) {
  return {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: (sessionId: string, key: string) => sidecar.settleDispatch(sessionId as never, key),
    read: (sessionId: string, key: string) => sidecar.readDispatch(sessionId as never, key),
  }
}

function runtimeFactory(counts: { starts: number; forks: number; prompts: number }, fork?: (parent: string) => Promise<void>, startError?: Error): (options: unknown) => AcpProfileRuntime {
  return () => {
    let acpSessionId = 'agent-parent'
    const runtime: AcpProfileRuntime = {
      get acpSessionId() { return acpSessionId },
      agentInfo: { name: 'fork-agent', version: '1' },
      agentCapabilities: { sessionCapabilities: { resume: {}, ...(fork === undefined ? {} : { fork: {} }) } },
      protocolVersion: 1,
      start: async () => { counts.starts += 1; if (startError !== undefined) throw startError },
      restore: async () => 'resumed',
      prompt: async () => { counts.prompts += 1; return { stopReason: 'end_turn' } as never },
      close: async () => undefined,
    }
    if (fork !== undefined) {
      runtime.fork = async (parent, _signal, _expected, beforeDispatch) => {
        await beforeDispatch?.()
        counts.forks += 1
        await fork(parent)
        acpSessionId = 'agent-child'
        return { sessionId: acpSessionId } as never
      }
    }
    return runtime
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) { /* consume */ }
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-fork-'))
  const sidecar = createAcpSidecar({ root })
  return { root, sidecar }
}

async function parentWithReplay(sidecar: AcpSidecar, parentId: string, parent: SessionLike): Promise<SessionLike> {
  const lookup = await sidecar.readLatestBinding(parentId as never)
  if (lookup?.status !== 'ok') throw new Error('parent binding was not created')
  const binding = lookup.binding
  const payload = {
    kind: 'dsh-acp' as const,
    version: 1 as const,
    ownerDshSessionId: parentId,
    profileId: binding.profileId,
    profileGeneration: binding.generation,
    agentSessionId: binding.agentSessionId,
    bindingEpoch: binding.bindingEpoch ?? binding.generation,
    launchFingerprint: acpCanonicalHash16(binding.launchFingerprint),
    committedPromptOrdinal: binding.committedPromptOrdinal ?? 1,
    committedActivitySeq: 0,
  }
  return {
    ...parent,
    snapshotEvents: () => [...snapshotSessionEvents(parent), {
      type: 'assistant/message', seq: 3, data: {
        message: {
          id: `assistant-${parentId}`,
          role: 'assistant',
          source: { kind: 'model', provider: binding.provider, model: 'model-a', replayState: { response: payload } },
          content: [{ type: 'text', text: 'parent answer' }],
        },
      },
    }],
  }
}

function childFromParent(parent: SessionLike, parentId: string, message: ReturnType<typeof user>, inheritedEventCount = 3): SessionLike {
  return {
    header: { cwd: os.tmpdir(), parentSession: parentId },
    inheritedEventCount,
    snapshotEvents: () => [...snapshotSessionEvents(parent), { type: 'step/start', seq: 4, data: { turn: 2, step: 0 } }, { type: 'user/message', seq: 5, data: message }],
  }
}

function sidecarProxy(sidecar: AcpSidecar, overrides: {
  append?: AcpSidecar['append']
  writeRecoveryState?: AcpSidecar['writeRecoveryState']
}): AcpSidecar {
  return {
    append: overrides.append ?? sidecar.append.bind(sidecar),
    readLatestBinding: sidecar.readLatestBinding.bind(sidecar),
    readRecoveryState: sidecar.readRecoveryState.bind(sidecar),
    writeRecoveryState: overrides.writeRecoveryState ?? sidecar.writeRecoveryState.bind(sidecar),
  } as unknown as AcpSidecar
}

describe('provider adapter ACP fork boundary', () => {
  it('uses ACP fork only at first dispatch and gives the child an independent binding', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      const parentAdapter = new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(parentCounts), sidecar)
      const parentChunks: unknown[] = []
      for await (const chunk of parentAdapter.stream(request('parent', parentMessage))) parentChunks.push(chunk)
      expect(parentChunks.some(chunk => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish' && 'replayState' in chunk)).toBe(true)
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)

      const childMessage = user('child')
      const child = childFromParent(parentWithMarker, 'parent', childMessage)
      sessions.set('child', child)
      const childCounts = { starts: 0, forks: 0, prompts: 0 }
      const childAdapter = new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(childCounts, async parentId => {
        expect(parentId).toBe('agent-parent')
      }), sidecar)
      await drain(childAdapter.stream(request('child', childMessage)))

      expect(childCounts).toEqual({ starts: 0, forks: 1, prompts: 1 })
      expect((await sidecar.readLatestBinding('child' as never))?.status === 'ok' ? (await sidecar.readLatestBinding('child' as never) as { status: 'ok'; binding: { agentSessionId: string } }).binding.agentSessionId : undefined).toBe('agent-child')
      expect((await sidecar.list('child' as never)).some(entry => entry.kind === 'session-fork' && entry.data.outcome === 'inherited')).toBe(true)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a blank ACP session when fork capability is unavailable', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      sessions.set('parent', makeSession(parentMessage))
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      const parent = sessions.get('parent')!
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(parentCounts), sidecar).stream(request('parent', parentMessage)))
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)
      const childMessage = user('child')
      sessions.set('child', childFromParent(parentWithMarker, 'parent', childMessage))
      const childCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(childCounts), sidecar).stream(request('child', childMessage)))
      expect(childCounts).toEqual({ starts: 1, forks: 0, prompts: 1 })
      expect((await sidecar.list('child' as never)).map(entry => entry.kind === 'session-fork' ? entry.data.reason : undefined)).toContain('agent-does-not-advertise-fork')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses blank fallback for an old cut and blocks an uncertain fork RPC', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(parentCounts), sidecar).stream(request('parent', parentMessage)))
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)
      const oldCut = user('child')
      const oldChild = childFromParent(parentWithMarker, 'parent', oldCut, 2)
      const oldChildWithTail: SessionLike = {
        ...oldChild,
        snapshotEvents: () => [...snapshotSessionEvents(oldChild), { type: 'user/message', seq: 6, data: user('uncommitted') }],
      }
      sessions.set('old-child', oldChildWithTail)
      const oldCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(oldCounts, async () => undefined), sidecar).stream(request('old-child', oldCut)))
      expect(oldCounts).toEqual({ starts: 1, forks: 0, prompts: 1 })
      expect((await sidecar.list('old-child' as never)).map(entry => entry.kind === 'session-fork' ? entry.data.reason : undefined)).toContain('seed-not-latest-semantic-boundary')

      const unknownMessage = user('unknown')
      sessions.set('unknown-child', childFromParent(parentWithMarker, 'parent', unknownMessage))
      const unknownCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(unknownCounts, async () => { throw new Error('transport closed') }), sidecar).stream(request('unknown-child', unknownMessage)))).rejects.toMatchObject({ code: 'ACP_FORK_FAILED' })
      expect(unknownCounts).toEqual({ starts: 0, forks: 1, prompts: 0 })
      expect((await sidecar.readRecoveryState('unknown-child' as never))?.kind).toBe('outcome-unknown')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses blank fallback when the parent is busy or already requires recovery', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(parentCounts), sidecar).stream(request('parent', parentMessage)))
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)

      const busyMessage = user('busy child')
      const busyBase = childFromParent(parentWithMarker, 'parent', busyMessage)
      const busy: SessionLike = {
        ...busyBase,
        snapshotEvents: () => [...snapshotSessionEvents(busyBase), { type: 'turn/start', seq: 6, data: { turn: 2 } }],
      }
      sessions.set('parent', {
        ...parentWithMarker,
        snapshotEvents: () => [...snapshotSessionEvents(parentWithMarker), { type: 'turn/start', seq: 6, data: { turn: 2 } }],
      })
      sessions.set('busy', busy)
      const busyCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(busyCounts, async () => undefined), sidecar).stream(request('busy', busyMessage)))
      expect(busyCounts).toEqual({ starts: 1, forks: 0, prompts: 1 })
      expect((await sidecar.list('busy' as never)).map(entry => entry.kind === 'session-fork' ? entry.data.reason : undefined)).toContain('parent-not-idle')

      sessions.set('parent', parentWithMarker)
      await sidecar.writeRecoveryState({ dshSessionId: 'parent' as never, kind: 'outcome-unknown', provider: 'acp-test', acpSessionId: 'agent-parent', updatedAt: Date.now() })
      const recoveryMessage = user('recovery child')
      sessions.set('recovery', childFromParent(parentWithMarker, 'parent', recoveryMessage))
      const recoveryCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(recoveryCounts, async () => undefined), sidecar).stream(request('recovery', recoveryMessage)))
      expect(recoveryCounts).toEqual({ starts: 1, forks: 0, prompts: 1 })
      expect((await sidecar.list('recovery' as never)).map(entry => entry.kind === 'session-fork' ? entry.data.reason : undefined)).toContain('parent-recovery-required')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not leave a false recovery gate when capability fallback cannot start a blank session', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory({ starts: 0, forks: 0, prompts: 0 }), sidecar).stream(request('parent', parentMessage)))
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      await expect(drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(counts, undefined, new Error('blank start failed')), sidecar).stream(request('child', childMessage)))).rejects.toThrow('blank start failed')
      expect(await sidecar.readRecoveryState('child' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not issue fork RPC when durable fork intent cannot be persisted', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory({ starts: 0, forks: 0, prompts: 0 }), sidecar).stream(request('parent', parentMessage)))
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const broken = sidecarProxy(sidecar, { writeRecoveryState: async (state) => {
        if (state.cause === 'fork-intent') throw new Error('intent write failed')
        await sidecar.writeRecoveryState(state)
      } })
      await expect(drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(counts, async () => undefined), broken).stream(request('child', childMessage)))).rejects.toMatchObject({ code: 'ACP_FORK_INTENT_FAILED' })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps outcome-unknown after remote fork succeeds but child binding persistence fails', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, SessionLike>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory({ starts: 0, forks: 0, prompts: 0 }), sidecar).stream(request('parent', parentMessage)))
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const broken = sidecarProxy(sidecar, { append: async (sessionId, entry) => {
        if (String(sessionId) === 'child' && entry.kind === 'binding') throw new Error('child binding write failed')
        await sidecar.append(sessionId, entry)
      } })
      await expect(drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(counts, async () => undefined), broken).stream(request('child', childMessage)))).rejects.toMatchObject({ code: 'ACP_BINDING_PERSIST_FAILED' })
      expect(counts).toEqual({ starts: 0, forks: 1, prompts: 0 })
      expect((await sidecar.readRecoveryState('child' as never))?.kind).toBe('outcome-unknown')
      const retryCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(drain(new AcpProfileAdapter('test', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory(retryCounts, async () => undefined), sidecar).stream(request('child', childMessage)))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
      expect(retryCounts.forks).toBe(0)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
