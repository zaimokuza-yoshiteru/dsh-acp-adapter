import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpHandoffs } from '../../../src/host/handoff/service.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpHandoffTarget } from '../../../src/contract/handoff.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function conversation(id: string, selected: AcpHandoffTarget, established: boolean) {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  function append(type: string, data: unknown) {
    events.push({ type, data, seq: events.length })
  }
  if (established) {
    append('turn/start', { turn: 1 })
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const inbox: UserMessage[] = []
  const agent = {
    id,
    status: 'idle',
    session: {
      header: { id, cwd: '/project' },
      get seq() {
        return events.length
      },
      requestHeader: () => (established ? { config: selected } : undefined),
    },
    model: {
      current: () => selected,
      select: vi.fn((value: AcpHandoffTarget) => {
        selected = value
      }),
    },
    inbox: {
      nextTurn: inbox,
      nextStep: [],
      remove: (id: string) =>
        inbox.splice(
          inbox.findIndex((m) => m.id === id),
          1,
        ),
    },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    cancel: vi.fn(),
    followup: vi.fn((m: UserMessage) => {
      inbox.push(m)
      append('agent/inbox/spliced', { inserted: [m] })
    }),
  }
  function finish(text: string, completed = true) {
    const turn = established ? 2 : 1
    append('turn/start', { turn })
    append('user/message', inbox.shift())
    append('assistant/message', {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text }] },
      ...(!completed && { interrupted: true }),
    })
    append('turn/end', { turn, reason: { kind: completed ? 'completed' : 'aborted' } })
  }
  return { agent, append, finish, events }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-handoff-'))
  const source = conversation('original', { provider: 'native', model: 'default' }, true)
  const sessions = new Map([[source.agent.id, source]])
  const target = { provider: 'acp-other', model: 'requested' }
  const profiles = new Map([['acp-other', 'verified-cli']])
  const workspaces: { id: string; path: string; sessionIds: string[] }[] = []
  const create = vi.fn((request: { sessionId: string }) => {
    sessions.set(request.sessionId, conversation(request.sessionId, { provider: 'native', model: 'default' }, false))
    return Promise.resolve({ sessionId: request.sessionId })
  })
  const defaultSelection = vi.fn()
  const roots: Context[] = []
  const stores: ReturnType<typeof createAcpSidecar>[] = []
  function mount() {
    const root = new Context()
    roots.push(root)
    const store = createAcpSidecar({ root: dir })
    stores.push(store)
    const services = {
      agents: { get: (id: string) => sessions.get(id)?.agent },
      sessions: { get: (id: string) => sessions.get(id)?.agent.session, flush: vi.fn(async () => true) },
      workspaceRegistry: { list: () => workspaces, archivedSessionIds: [] },
      sessionQuery: {
        observeSession: (id: string) => ({
          header: sessions.get(id)!.agent.session.header,
          events: sessions.get(id)!.events.slice(),
          [Symbol.dispose]() {},
        }),
      },
      sessionPersistence: { stat: async () => undefined },
      agentDefaultModel: { saveSelection: defaultSelection },
      sessionController: { create, resolveAgent: (id: string) => ({ agent: sessions.get(id)!.agent }) },
      llm: { listModels: () => [{ id: 'requested' }], resolveCallConfig: async () => ({}) },
    }
    for (const [key, value] of Object.entries(services)) root.provide(key, value)
    return new AcpHandoffs(root, store, (p) => profiles.get(p) ?? null)
  }
  cleanups.push(async () => {
    await Promise.all(roots.map((root) => root.fiber.dispose()))
    for (const store of stores) store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const service = mount()
  const id = randomUUID()
  const allow = vi.fn()
  const begin = () => service.action('original', { kind: 'begin', id, target, locale: 'en' }, allow)
  return { id, source, sessions, service, mount, create, defaultSelection, begin, allow, target, profiles, workspaces }
}

it('recovers one editable draft and delivers only its edited text to the selected destination once', async () => {
  const f = fixture()
  await Promise.all([f.begin(), f.begin()])
  expect(f.source.agent.followup).toHaveBeenCalledTimes(1)
  f.source.finish('original summary with private detail')
  const recovered = f.mount()
  const draft = await recovered.action('original', { kind: 'status', id: f.id }, f.allow)
  expect(draft).toMatchObject({ phase: 'draft', document: 'original summary with private detail' })
  const id = draft!.destinationSessionId!
  const destination = f.sessions.get(id)!
  expect(destination.agent.model.select).toHaveBeenCalledWith(f.target)
  const edits = { id: f.id, document: 'reviewed text dsh-session:opaque', instruction: 'continue', allowHistory: true }
  const saved = await recovered.action(id, { kind: 'save', revision: draft!.revision, ...edits }, f.allow)
  await expect(
    recovered.action(id, { kind: 'save', revision: draft!.revision, ...edits, document: 'stale edit' }, f.allow),
  ).rejects.toThrow()
  expect(await recovered.historyFor(id)).toBeUndefined()
  await Promise.all(
    [1, 2].map(() => recovered.action(id, { kind: 'send', revision: saved!.revision, ...edits }, f.allow)),
  )
  const delivered = destination.agent.followup.mock.calls[0]![0]
  expect(delivered.source.kind).toBe('acp-handoff')
  expect(delivered.content[0]).toMatchObject({ text: expect.stringContaining('reviewed text') })
  expect(JSON.stringify(delivered)).not.toContain('private detail')
  expect(await recovered.historyFor(id)).toEqual({ sourceSessionId: 'original', sourceCwd: '/project', throughSeq: 1 })
  destination.finish('received')
  expect(await f.mount().action(id, { kind: 'status', id: f.id }, f.allow)).toMatchObject({ phase: 'completed' })
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(destination.agent.followup).toHaveBeenCalledTimes(1)
  expect(f.defaultSelection).not.toHaveBeenCalled()
  f.profiles.set('acp-other', 'replacement-cli')
  expect(await recovered.historyFor(id)).toBeUndefined()
})

it('keeps the completed document private when a source or destination CLI is replaced under the same ID', async () => {
  const interrupted = fixture()
  await interrupted.begin()
  interrupted.source.finish('complete summary')
  interrupted.profiles.set('acp-other', 'replacement-cli')
  expect(await interrupted.service.action('original', { kind: 'status' }, interrupted.allow)).toMatchObject({
    phase: 'interrupted',
    document: 'complete summary',
    destinationSessionId: null,
  })
  expect(interrupted.create).not.toHaveBeenCalled()

  const f = fixture()
  f.profiles.set('native', 'source-cli')
  await f.begin()
  f.source.finish('completed document')
  const draft = (await f.service.action('original', { kind: 'status' }, f.allow))!
  const id = draft.destinationSessionId!
  f.profiles.set('native', 'new-source-cli')
  await expect(
    f.mount().action(
      id,
      {
        kind: 'send',
        id: f.id,
        revision: draft.revision,
        document: draft.document,
        instruction: '',
        allowHistory: true,
      },
      f.allow,
    ),
  ).rejects.toMatchObject({ code: 'session/model-unavailable' })
  expect(f.sessions.get(id)!.agent.followup).not.toHaveBeenCalled()
  expect(await f.mount().action(id, { kind: 'status' }, f.allow)).toMatchObject({
    phase: 'draft',
    document: draft.document,
  })
})

it('discards interrupted source output and never creates a target on cancel', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('half a sentence', false)
  expect(await f.service.action('original', { kind: 'status' }, f.allow)).toMatchObject({
    phase: 'interrupted',
    document: '',
  })
  const next = randomUUID()
  await f.service.action('original', { kind: 'begin', id: next, locale: 'zh', target: f.target }, f.allow)
  await f.service.action('original', { kind: 'cancel', id: next }, f.allow)
  expect(f.source.agent.inbox.nextTurn).toEqual([])
  expect(await f.mount().action('original', { kind: 'status', id: next }, f.allow)).toMatchObject({
    phase: 'cancelled',
  })
  expect(f.create).not.toHaveBeenCalled()
})

it('retains the summary without transferring it if the source moved during generation', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('completed at the original location')
  f.workspaces.push({ id: 'another-workspace', path: '/another', sessionIds: ['original'] })
  expect(await f.service.action('original', { kind: 'status' }, f.allow)).toMatchObject({
    phase: 'interrupted',
    destinationSessionId: null,
    document: 'completed at the original location',
  })
  expect(f.create).not.toHaveBeenCalled()
})

it('refuses a changed target and never grants history from a document-only transfer', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('summary')
  const draft = (await f.service.action('original', { kind: 'status' }, f.allow))!
  const id = draft.destinationSessionId!
  const send = () =>
    f.service.action(
      id,
      { id: f.id, revision: draft.revision, kind: 'send', document: 'shared', instruction: '', allowHistory: false },
      f.allow,
    )
  const destination = f.sessions.get(id)!
  destination.agent.model.select({ provider: 'acp-other', model: 'replacement' })
  await expect(send()).rejects.toThrow()
  expect(destination.agent.followup).not.toHaveBeenCalled()
  destination.agent.model.select(f.target)
  await send()
  expect(await f.service.historyFor(id)).toBeUndefined()
  expect(await f.service.historyFor('unrelated')).toBeUndefined()
})
