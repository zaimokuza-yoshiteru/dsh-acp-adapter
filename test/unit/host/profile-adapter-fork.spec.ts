import { withSessionFacts } from '../../support/session-facts.ts'
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { AcpForkPreDispatchError } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { SessionLike, SessionEventLike } from '../../../src/domain/session/current-step-admission.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts'

type FixtureSession = SessionLike & { snapshotEvents(): readonly SessionEventLike[] }

const profile = (): AcpAgentConfig => ({ name: 'Fork test', command: 'agent', args: ['acp'], env: {} })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const makeSession = (
  message: ReturnType<typeof user>,
  extra: { parentSession?: string; inheritedEventCount?: number } = {},
) =>
  withSessionFacts({
    header: { cwd: os.tmpdir(), ...(extra.parentSession === undefined ? {} : { parentSession: extra.parentSession }) },
    inheritedEventCount: extra.inheritedEventCount ?? 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 2, data: message },
    ],
  })
const request = (id: string, message: ReturnType<typeof user>): GenerateOptions =>
  markAgentLoopRequest({
    provider: 'acp-test',
    model: 'model-a',
    sessionId: id as never,
    messages: [message],
  })
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })

function ledgerFor(sidecar: AcpSidecar) {
  return {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: (sessionId: string, key: string) => sidecar.settleDispatch(sessionId as never, key),
    read: (sessionId: string, key: string) => sidecar.readDispatch(sessionId as never, key),
  }
}

function runtimeFactory(
  counts: { starts: number; forks: number; prompts: number },
  fork?: (parent: string) => Promise<void>,
  startError?: Error,
  preDispatchError?: AcpForkPreDispatchError,
): (options: unknown) => AcpProfileRuntime {
  return () => {
    let acpSessionId = 'agent-parent'
    const runtime: AcpProfileRuntime = {
      get acpSessionId() {
        return acpSessionId
      },
      agentInfo: { name: 'fork-agent', version: '1' },
      agentCapabilities: { sessionCapabilities: { resume: {}, ...(fork === undefined ? {} : { fork: {} }) } },
      protocolVersion: 1,
      start: async () => {
        counts.starts += 1
        if (startError !== undefined) throw startError
      },
      restore: async () => 'resumed',
      prompt: async () => {
        counts.prompts += 1
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    }
    if (fork !== undefined) {
      runtime.fork = async (parent, _signal, _expected, beforeDispatch, validateBeforeDispatch) => {
        if (preDispatchError !== undefined) throw preDispatchError
        try {
          await beforeDispatch?.()
        } catch (error) {
          if (error instanceof AcpForkPreDispatchError) throw error
          throw new AcpForkPreDispatchError('ACP_FORK_INTENT_FAILED', error)
        }
        validateBeforeDispatch?.()
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
  for await (const _ of iterable) {
    /* consume */
  }
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-fork-'))
  const sidecar = createAcpSidecar({ root })
  return { root, sidecar }
}

async function parentWithReplay(
  sidecar: AcpSidecar,
  parentId: string,
  parent: FixtureSession,
): Promise<FixtureSession> {
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
  return withSessionFacts({
    ...parent,
    snapshotEvents: () => [
      ...parent.snapshotEvents(),
      {
        type: 'assistant/message',
        seq: 3,
        data: {
          message: {
            id: `assistant-${parentId}`,
            role: 'assistant',
            source: { kind: 'model', provider: binding.provider, model: 'model-a', replayState: { response: payload } },
            content: [{ type: 'text', text: 'parent answer' }],
          },
        },
      },
    ],
  })
}

function childFromParent(
  parent: FixtureSession,
  parentId: string,
  message: ReturnType<typeof user>,
  inheritedEventCount = 3,
): FixtureSession {
  return withSessionFacts({
    header: { cwd: os.tmpdir(), parentSession: parentId, isSeeded: inheritedEventCount > 0 },
    inheritedEventCount,
    snapshotEvents: () => [
      ...parent.snapshotEvents(),
      { type: 'step/start', seq: 4, data: { turn: 2, step: 0 } },
      { type: 'user/message', seq: 5, data: message },
    ],
  })
}

function sidecarProxy(
  sidecar: AcpSidecar,
  overrides: {
    append?: AcpSidecar['append']
    writeRecoveryState?: AcpSidecar['writeRecoveryState']
  },
): AcpSidecar {
  return {
    append: overrides.append ?? sidecar.append.bind(sidecar),
    readLatestBinding: sidecar.readLatestBinding.bind(sidecar),
    readModeIntent: async () => undefined,
    readRecoveryState: sidecar.readRecoveryState.bind(sidecar),
    writeRecoveryState: overrides.writeRecoveryState ?? sidecar.writeRecoveryState.bind(sidecar),
  } as unknown as AcpSidecar
}

describe('provider adapter ACP fork boundary', () => {
  it.each([
    ['ACP_FORK_UNSUPPORTED', 'agent-does-not-advertise-fork'],
    ['ACP_FORK_PRECONDITION_FAILED', 'parent-binding-mismatch'],
  ] as const)('uses a typed %s failure to reject a seeded fork', async (code, _reason) => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(counts, async () => undefined, undefined, new AcpForkPreDispatchError(code)),
            sidecar,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
      expect(await sidecar.readRecoveryState('child' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['ACP_FORK_UNSUPPORTED', 'ACP_FORK_PRECONDITION_FAILED', 'ACP_FORK_INTENT_FAILED: remote rejection'])(
    'keeps a dispatched fork outcome unknown when its error text is %s',
    async (message) => {
      const { root, sidecar } = await harness()
      try {
        const sessions = new Map<string, FixtureSession>()
        const parentMessage = user('parent')
        const parent = makeSession(parentMessage)
        sessions.set('parent', parent)
        await drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
            sidecar,
          ).stream(request('parent', parentMessage)),
        )
        const markedParent = await parentWithReplay(sidecar, 'parent', parent)
        sessions.set('parent', markedParent)
        const childMessage = user('child')
        sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
        const counts = { starts: 0, forks: 0, prompts: 0 }
        await expect(
          drain(
            new AcpProfileAdapter(
              'test',
              profile,
              seam(),
              (id) => sessions.get(id),
              ledgerFor(sidecar),
              undefined,
              runtimeFactory(counts, async () => {
                throw new Error(message)
              }),
              sidecar,
            ).stream(request('child', childMessage)),
          ),
        ).rejects.toMatchObject({ code: 'ACP_FORK_FAILED' })
        expect(counts).toEqual({ starts: 0, forks: 1, prompts: 0 })
        expect((await sidecar.readRecoveryState('child' as never))?.kind).toBe('outcome-unknown')
        expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
      } finally {
        await sidecar.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.each([false, true])(
    'uses ACP fork only at first dispatch and gives the child an independent binding (legacy registry references: %s)',
    async (legacy) => {
      const { root, sidecar } = await harness()
      try {
        const sessions = new Map<string, FixtureSession>()
        const parentMessage = user('parent')
        const parent = makeSession(parentMessage)
        sessions.set('parent', parent)
        const parentCounts = { starts: 0, forks: 0, prompts: 0 }
        const parentAdapter = new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(parentCounts),
          sidecar,
        )
        const parentChunks: unknown[] = []
        for await (const chunk of parentAdapter.stream(request('parent', parentMessage))) parentChunks.push(chunk)
        expect(
          parentChunks.some(
            (chunk) =>
              typeof chunk === 'object' &&
              chunk !== null &&
              'type' in chunk &&
              chunk.type === 'finish' &&
              'replayState' in chunk,
          ),
        ).toBe(true)
        if (legacy) {
          const saved = await sidecar.readLatestBinding('parent' as never)
          if (saved?.status !== 'ok') throw new Error('missing binding')
          await sidecar.append('parent' as never, {
            kind: 'binding',
            data: {
              ...saved.binding,
              launchFingerprint: { ...saved.binding.launchFingerprint, adapterVersion: '1.6.2' },
            },
          })
        }
        const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
        sessions.set('parent', parentWithMarker)

        const childMessage = user('child')
        const child = childFromParent(parentWithMarker, 'parent', childMessage)
        sessions.set('child', child)
        const childCounts = { starts: 0, forks: 0, prompts: 0 }
        const childAdapter = new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(childCounts, async (parentId) => {
            expect(parentId).toBe('agent-parent')
          }),
          sidecar,
        )
        await drain(childAdapter.stream(request('child', childMessage)))

        expect(childCounts).toEqual({ starts: 0, forks: 1, prompts: 1 })
        expect(
          (await sidecar.readLatestBinding('child' as never))?.status === 'ok'
            ? (
                (await sidecar.readLatestBinding('child' as never)) as {
                  status: 'ok'
                  binding: { agentSessionId: string }
                }
              ).binding.agentSessionId
            : undefined,
        ).toBe('agent-child')
        expect(
          (await sidecar.list('child' as never)).some(
            (entry) => entry.kind === 'session-fork' && entry.data.outcome === 'inherited',
          ),
        ).toBe(true)
      } finally {
        await sidecar.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('rejects a seeded fork when the capability is unavailable', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      sessions.set('parent', makeSession(parentMessage))
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      const parent = sessions.get('parent')!
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(parentCounts),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)
      const childMessage = user('child')
      sessions.set('child', childFromParent(parentWithMarker, 'parent', childMessage))
      const childCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(childCounts),
            sidecar,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(childCounts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an old cut and blocks an uncertain fork RPC', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(parentCounts),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)
      const oldCut = user('child')
      const oldChild = childFromParent(parentWithMarker, 'parent', oldCut, 2)
      const oldChildWithTail: FixtureSession = withSessionFacts({
        ...oldChild,
        snapshotEvents: () => [
          ...oldChild.snapshotEvents(),
          { type: 'user/message', seq: 6, data: user('uncommitted') },
        ],
      })
      sessions.set('old-child', oldChildWithTail)
      const oldCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(oldCounts, async () => undefined),
            sidecar,
          ).stream(request('old-child', oldCut)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(oldCounts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('old-child' as never)).toBeUndefined()

      const unknownMessage = user('unknown')
      sessions.set('unknown-child', childFromParent(parentWithMarker, 'parent', unknownMessage))
      const unknownCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(unknownCounts, async () => {
              throw new Error('transport closed')
            }),
            sidecar,
          ).stream(request('unknown-child', unknownMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_FAILED' })
      expect(unknownCounts).toEqual({ starts: 0, forks: 1, prompts: 0 })
      expect((await sidecar.readRecoveryState('unknown-child' as never))?.kind).toBe('outcome-unknown')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a seeded fork when the parent is busy or already requires recovery', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      const parentCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(parentCounts),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const parentWithMarker = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', parentWithMarker)

      const busyMessage = user('busy child')
      const busyBase = childFromParent(parentWithMarker, 'parent', busyMessage)
      const busy: FixtureSession = withSessionFacts({
        ...busyBase,
        snapshotEvents: () => [...busyBase.snapshotEvents(), { type: 'turn/start', seq: 6, data: { turn: 2 } }],
      })
      sessions.set(
        'parent',
        withSessionFacts({
          ...parentWithMarker,
          snapshotEvents: () => [
            ...parentWithMarker.snapshotEvents(),
            { type: 'turn/start', seq: 6, data: { turn: 2 } },
          ],
        }),
      )
      sessions.set('busy', busy)
      const busyCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(busyCounts, async () => undefined),
            sidecar,
          ).stream(request('busy', busyMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(busyCounts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('busy' as never)).toBeUndefined()

      sessions.set('parent', parentWithMarker)
      await sidecar.writeRecoveryState({
        dshSessionId: 'parent' as never,
        kind: 'outcome-unknown',
        provider: 'acp-test',
        acpSessionId: 'agent-parent',
        updatedAt: Date.now(),
      })
      const recoveryMessage = user('recovery child')
      sessions.set('recovery', childFromParent(parentWithMarker, 'parent', recoveryMessage))
      const recoveryCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(recoveryCounts, async () => undefined),
            sidecar,
          ).stream(request('recovery', recoveryMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(recoveryCounts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('recovery' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not start blank or leave a recovery gate when a seeded fork is unavailable', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(counts, undefined, new Error('blank start failed')),
            sidecar,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readRecoveryState('child' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not issue fork RPC when durable fork intent cannot be persisted', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const intentError = new Error('intent write failed')
      const broken = sidecarProxy(sidecar, {
        writeRecoveryState: async (state) => {
          if (state.cause === 'fork-intent') throw intentError
          await sidecar.writeRecoveryState(state)
        },
      })
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(counts, async () => undefined),
            broken,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({
        code: 'ACP_FORK_INTENT_FAILED',
        cause: { code: 'ACP_FORK_INTENT_FAILED', cause: intentError },
      })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps outcome-unknown after remote fork succeeds but child binding persistence fails', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const markedParent = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', markedParent)
      const childMessage = user('child')
      sessions.set('child', childFromParent(markedParent, 'parent', childMessage))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const broken = sidecarProxy(sidecar, {
        append: async (sessionId, entry) => {
          if (String(sessionId) === 'child' && entry.kind === 'binding') throw new Error('child binding write failed')
          await sidecar.append(sessionId, entry)
        },
      })
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(counts, async () => undefined),
            broken,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_BINDING_PERSIST_FAILED' })
      expect(counts).toEqual({ starts: 0, forks: 1, prompts: 0 })
      expect((await sidecar.readRecoveryState('child' as never))?.kind).toBe('outcome-unknown')
      const retryCounts = { starts: 0, forks: 0, prompts: 0 }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(retryCounts, async () => undefined),
            sidecar,
          ).stream(request('child', childMessage)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
      expect(retryCounts.forks).toBe(0)
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('delegated fork history contract', () => {
  it.each([false, true])(
    'honors explicit blank recovery of an established seeded child, parent retired=%s',
    async (retired) => {
      const { root, sidecar } = await harness()
      try {
        const sessions = new Map<string, FixtureSession>()
        const parentMessage = user('PARENT_HISTORY_RETAINED')
        const parent = makeSession(parentMessage)
        sessions.set('parent', parent)
        const counts = { starts: 0, forks: 0, prompts: 0 }
        const adapter = new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(counts, async () => undefined),
          sidecar,
        )
        await drain(adapter.stream(request('parent', parentMessage)))
        const marked = await parentWithReplay(sidecar, 'parent', parent)
        sessions.set('parent', marked)
        const initial = user('seeded child initial task')
        const child = childFromParent(marked, 'parent', initial)
        const seeded = withSessionFacts({ ...child, header: { ...child.header, origin: 'subagent', isSeeded: true } })
        sessions.set('child', seeded)
        await drain(adapter.stream(request('child', initial)))
        const previous = await sidecar.readLatestBinding('child' as never)
        expect(previous?.status === 'ok' ? previous.binding.agentSessionId : undefined).toBe('agent-child')
        const message = user('continue after explicit blank recovery')
        const history: SessionEventLike[] = [
          ...seeded.snapshotEvents(),
          {
            type: 'assistant/message',
            seq: 6,
            data: {
              message: {
                id: 'child-answer',
                role: 'assistant',
                source: { kind: 'model', provider: 'acp-test', model: 'model-a' },
                content: [{ type: 'text', text: 'CHILD_HISTORY_RETAINED' }],
              },
            },
          },
          { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } },
          { type: 'step/start', seq: 8, data: { turn: 3, step: 0 } },
          { type: 'user/message', seq: 9, data: message },
        ]
        const established = withSessionFacts({ ...seeded, snapshotEvents: () => history })
        sessions.set('child', established)
        if (retired) sessions.delete('parent')
        const retained = structuredClone(history)
        await adapter.rebindBlank('child')
        counts.starts = 0
        counts.forks = 0
        counts.prompts = 0
        await drain(adapter.stream(request('child', message)))
        expect(counts).toEqual({ starts: 1, forks: 0, prompts: 1 })
        expect(established.snapshotEvents()).toEqual(retained)
        expect(JSON.stringify(established.snapshotEvents())).toContain('CHILD_HISTORY_RETAINED')
        expect(JSON.stringify(established.snapshotEvents())).toContain('PARENT_HISTORY_RETAINED')
        const rebound = await sidecar.readLatestBinding('child' as never)
        expect(rebound?.status === 'ok' ? rebound.binding : undefined).toMatchObject({
          agentSessionId: 'agent-parent',
          generation: 2,
        })
      } finally {
        await sidecar.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    'busy-parent',
    'unsupported',
    'different-seed',
    'missing-parent-binding',
    'pre-dispatch-unsupported',
    'pre-dispatch-mismatch',
  ] as const)('rejects %s before silently creating a blank delegated ACP session', async (scenario) => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('retain this parent context')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      if (scenario !== 'missing-parent-binding') {
        await drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
            sidecar,
          ).stream(request('parent', parentMessage)),
        )
      }
      const marked = scenario === 'missing-parent-binding' ? parent : await parentWithReplay(sidecar, 'parent', parent)
      sessions.set(
        'parent',
        scenario === 'busy-parent'
          ? withSessionFacts({
              ...marked,
              snapshotEvents: () => [...marked.snapshotEvents(), { type: 'turn/start', seq: 4, data: { turn: 2 } }],
            })
          : marked,
      )
      const message = user('use the inherited context')
      const child = childFromParent(marked, 'parent', message, scenario === 'different-seed' ? 2 : 3)
      sessions.set(
        'child',
        withSessionFacts({ ...child, header: { ...child.header, origin: 'subagent', isSeeded: true } }),
      )
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const adapter = new AcpProfileAdapter(
        'test',
        profile,
        seam(),
        (id) => sessions.get(id),
        ledgerFor(sidecar),
        undefined,
        runtimeFactory(
          counts,
          scenario === 'unsupported' ? undefined : async () => undefined,
          undefined,
          scenario === 'pre-dispatch-unsupported'
            ? new AcpForkPreDispatchError('ACP_FORK_UNSUPPORTED')
            : scenario === 'pre-dispatch-mismatch'
              ? new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
              : undefined,
        ),
        sidecar,
      )
      await expect(drain(adapter.stream(request('child', message)))).rejects.toMatchObject({
        code: 'ACP_DELEGATED_FORK_UNAVAILABLE',
      })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains a proven seeded delegated fork and permits a child with no inherited turns to start fresh', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('completed parent context')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const marked = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', marked)
      const message = user('child prompt')
      const child = childFromParent(marked, 'parent', message)
      sessions.set(
        'seeded',
        withSessionFacts({ ...child, header: { ...child.header, origin: 'subagent', isSeeded: true } }),
      )
      const seededCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(seededCounts, async () => undefined),
          sidecar,
        ).stream(request('seeded', message)),
      )
      expect(seededCounts).toEqual({ starts: 0, forks: 1, prompts: 1 })
      const fresh = makeSession(message, { parentSession: 'parent' })
      sessions.set(
        'fresh',
        withSessionFacts({ ...fresh, header: { ...fresh.header, origin: 'subagent', isSeeded: false } }),
      )
      const freshCounts = { starts: 0, forks: 0, prompts: 0 }
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory(freshCounts),
          sidecar,
        ).stream(request('fresh', message)),
      )
      expect(freshCounts).toEqual({ starts: 1, forks: 0, prompts: 1 })
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ordinary seeded fork admission', () => {
  it.each(['unsupported', 'busy-parent', 'missing-parent', 'old-cut'] as const)(
    'rejects %s without dispatching an empty replacement conversation',
    async (scenario) => {
      const { root, sidecar } = await harness()
      try {
        const sessions = new Map<string, FixtureSession>()
        const parentMessage = user('parent private context')
        const parent = makeSession(parentMessage)
        sessions.set('parent', parent)
        await drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
            sidecar,
          ).stream(request('parent', parentMessage)),
        )
        const marked = await parentWithReplay(sidecar, 'parent', parent)
        sessions.set(
          'parent',
          scenario === 'busy-parent'
            ? withSessionFacts({
                ...marked,
                snapshotEvents: () => [...marked.snapshotEvents(), { type: 'turn/start', seq: 6, data: { turn: 2 } }],
              })
            : marked,
        )
        if (scenario === 'missing-parent') sessions.delete('parent')
        const message = user('continue with the inherited history')
        sessions.set('child', childFromParent(marked, 'parent', message, scenario === 'old-cut' ? 2 : 3))
        const counts = { starts: 0, forks: 0, prompts: 0 }
        await expect(
          drain(
            new AcpProfileAdapter(
              'test',
              profile,
              seam(),
              (id) => sessions.get(id),
              ledgerFor(sidecar),
              undefined,
              runtimeFactory(counts, scenario === 'unsupported' ? undefined : async () => undefined),
              sidecar,
            ).stream(request('child', message)),
          ),
        ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
        expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
        expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
        expect(await sidecar.readRecoveryState('child' as never)).toBeUndefined()
      } finally {
        await sidecar.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('rechecks the parent after the durable intent yields, before dispatch', async () => {
    const { root, sidecar } = await harness()
    try {
      const sessions = new Map<string, FixtureSession>()
      const parentMessage = user('parent private context')
      const parent = makeSession(parentMessage)
      sessions.set('parent', parent)
      await drain(
        new AcpProfileAdapter(
          'test',
          profile,
          seam(),
          (id) => sessions.get(id),
          ledgerFor(sidecar),
          undefined,
          runtimeFactory({ starts: 0, forks: 0, prompts: 0 }),
          sidecar,
        ).stream(request('parent', parentMessage)),
      )
      const marked = await parentWithReplay(sidecar, 'parent', parent)
      sessions.set('parent', marked)
      const message = user('fork exactly the completed context')
      sessions.set('child', childFromParent(marked, 'parent', message))
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const changing = sidecar
      const persistRecovery = sidecar.writeRecoveryState.bind(sidecar)
      changing.writeRecoveryState = async (state) => {
        await persistRecovery(state)
        if (state.cause === 'fork-intent')
          sessions.set(
            'parent',
            withSessionFacts({
              ...marked,
              snapshotEvents: () => [...marked.snapshotEvents(), { type: 'turn/start', seq: 6, data: { turn: 2 } }],
            }),
          )
      }
      await expect(
        drain(
          new AcpProfileAdapter(
            'test',
            profile,
            seam(),
            (id) => sessions.get(id),
            ledgerFor(sidecar),
            undefined,
            runtimeFactory(counts, async () => undefined),
            changing,
          ).stream(request('child', message)),
        ),
      ).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
      expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
      expect(await sidecar.readLatestBinding('child' as never)).toBeUndefined()
      expect((await sidecar.readRecoveryState('child' as never))?.kind).toBe('healthy')
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('empty native fork seed admission', () => {
  it.each([0, undefined])('only starts fresh for an exact inherited event count of zero (%s)', async (count) => {
    const { root, sidecar } = await harness()
    try {
      const message = user('first child request')
      const source = makeSession(message)
      // SessionStore.fork(empty) is still seeded; do not rewrite its native header to false.
      const session = withSessionFacts({
        header: { cwd: os.tmpdir(), parentSession: 'empty-source', isSeeded: true },
        ...(count === undefined ? {} : { inheritedEventCount: count }),
        snapshotEvents: source.snapshotEvents,
      })
      const counts = { starts: 0, forks: 0, prompts: 0 }
      const adapter = new AcpProfileAdapter(
        'test',
        profile,
        seam(),
        (id) => (id === 'empty-child' ? session : undefined),
        ledgerFor(sidecar),
        undefined,
        runtimeFactory(counts),
        sidecar,
      )
      const result = drain(adapter.stream(request('empty-child', message)))
      if (count === 0) {
        await expect(result).resolves.toBeUndefined()
        expect(counts).toEqual({ starts: 1, forks: 0, prompts: 1 })
        expect((await sidecar.readLatestBinding('empty-child' as never))?.status).toBe('ok')
      } else {
        await expect(result).rejects.toMatchObject({ code: 'ACP_FORK_UNAVAILABLE' })
        expect(counts).toEqual({ starts: 0, forks: 0, prompts: 0 })
        expect(await sidecar.readLatestBinding('empty-child' as never)).toBeUndefined()
      }
    } finally {
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
