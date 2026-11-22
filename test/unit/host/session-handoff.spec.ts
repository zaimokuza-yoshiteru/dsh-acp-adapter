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
      id,
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
  const archived: string[] = []
  const directories = new Map<string, string>()
  const stat = vi.fn(async (_id: string): Promise<object | undefined> => undefined)
  const listModels = vi.fn(async () => [{ id: 'requested' }])
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
      workspaceRegistry: { list: () => workspaces, archivedSessionIds: archived },
      workingDirectory: { get: (session: { id: string }) => directories.get(session.id) },
      sessionQuery: {
        observeSession: (id: string) => ({
          header: sessions.get(id)!.agent.session.header,
          events: sessions.get(id)!.events.slice(),
          [Symbol.dispose]() {},
        }),
      },
      sessionPersistence: { stat },
      agentDefaultModel: { saveSelection: defaultSelection },
      sessionController: { create, resolveAgent: (id: string) => ({ agent: sessions.get(id)!.agent }) },
      llm: { listModels, resolveCallConfig: async () => ({}) },
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
  return {
    store: stores[0]!,
    id,
    source,
    sessions,
    service,
    mount,
    create,
    defaultSelection,
    begin,
    allow,
    target,
    profiles,
    workspaces,
    archived,
    directories,
    stat,
    listModels,
  }
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

it.each(['workspace', 'cwd'])('keeps the document out of a destination with a changed %s', async (move) => {
  const f = fixture()
  await f.begin()
  f.source.finish('private source summary')
  const draft = (await f.service.action('original', { kind: 'status' }, f.allow))!
  const id = draft.destinationSessionId!
  const send = () =>
    f.service.action(
      id,
      {
        kind: 'send',
        id: f.id,
        revision: draft.revision,
        document: draft.document,
        allowHistory: true,
        instruction: '',
      },
      f.allow,
    )
  if (move === 'workspace') f.workspaces.push({ id: 'other', path: '/project', sessionIds: [id] })
  else f.directories.set(id, '/other')
  await expect(send()).rejects.toMatchObject({ code: 'session/agent-busy' })
  expect(f.sessions.get(id)!.agent.followup).not.toHaveBeenCalled()
  f.workspaces.length = 0
  f.directories.clear()
  const current = (await f.service.action(id, { kind: 'status' }, f.allow))!
  await f.service.action(
    id,
    {
      kind: 'send',
      id: f.id,
      revision: current.revision,
      document: current.document,
      allowHistory: true,
      instruction: '',
    },
    f.allow,
  )
  expect(f.sessions.get(id)!.agent.followup.mock.calls[0]![0].source).toMatchObject({
    launchScope: { workspaceId: null, cwd: '/project' },
  })
})

it('retries discovery errors but releases the source and keeps its document when the named model disappears', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('finished summary')
  const read = () => f.service.action('original', { kind: 'status' }, f.allow)
  f.listModels.mockRejectedValueOnce(new Error('Agent probe disconnected'))
  await expect(read()).rejects.toThrow('probe disconnected')
  expect(f.create).not.toHaveBeenCalled()
  f.listModels.mockResolvedValueOnce([])
  expect(await read()).toMatchObject({ phase: 'interrupted', destinationSessionId: null, document: 'finished summary' })
  expect(await f.mount().action('original', { kind: 'status' }, f.allow)).toMatchObject({ phase: 'interrupted' })
  expect(f.create).not.toHaveBeenCalled()
  expect(
    await f.service.action('original', { kind: 'begin', id: randomUUID(), locale: 'en', target: f.target }, f.allow),
  ).toMatchObject({ phase: 'summarizing' })
})

it.each(['archived', 'deleted'])('recovers the latest edited source document after its target is %s', async (state) => {
  const f = fixture()
  await f.begin()
  f.source.finish('generated')
  const draft = (await f.service.action('original', { kind: 'status' }, f.allow))!
  const id = draft.destinationSessionId!
  await f.service.action(
    id,
    {
      kind: 'save',
      id: f.id,
      revision: draft.revision,
      document: 'private edit',
      instruction: 'verify',
      allowHistory: true,
    },
    f.allow,
  )
  if (state === 'archived') f.archived.push(id)
  else {
    f.sessions.delete(id)
    f.stat.mockRejectedValueOnce(new Error('unavailable storage'))
    await expect(f.service.action('original', { kind: 'status' }, f.allow)).rejects.toThrow('unavailable storage')
    f.stat.mockResolvedValueOnce({})
    expect(await f.service.action('original', { kind: 'status' }, f.allow)).toMatchObject({
      phase: 'draft',
      destinationSessionId: id,
    })
  }
  const read = () => f.mount().action('original', { kind: 'status' }, f.allow)
  expect(await read()).toMatchObject({
    phase: 'interrupted',
    destinationSessionId: null,
    allowHistory: false,
    document: 'private edit',
    instruction: 'verify',
  })
  const restricted = (session: string) => {
    if (session === id) throw new Error('access revoked')
  }
  await expect(f.service.action('original', { kind: 'status' }, restricted)).rejects.toThrow('access revoked')
  expect(await read()).toMatchObject({ phase: 'interrupted', destinationSessionId: null })
  expect(
    await f.service.action('original', { kind: 'begin', id: randomUUID(), locale: 'en', target: f.target }, f.allow),
  ).toMatchObject({ phase: 'summarizing' })
  expect(f.create).toHaveBeenCalledTimes(1)
})

it('never recreates a destination deleted after creation was accepted but its reply was lost', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('complete')
  let accepted = ''
  f.create.mockImplementationOnce(({ sessionId }) => {
    accepted = sessionId
    f.sessions.set(sessionId, conversation(sessionId, f.target, false))
    return Promise.reject(new Error('lost create reply'))
  })
  await expect(f.service.action('original', { kind: 'status' }, f.allow)).rejects.toThrow('lost create reply')
  f.sessions.delete(accepted)
  expect(await f.mount().action('original', { kind: 'status' }, f.allow)).toMatchObject({
    phase: 'interrupted',
    destinationSessionId: null,
    document: 'complete',
  })
  expect(f.create).toHaveBeenCalledTimes(1)
})

it('requires the latest draft revision to discard from either session', async () => {
  const f = fixture()
  await f.begin()
  f.source.finish('written')
  const draft = (await f.service.action('original', { kind: 'status' }, f.allow))!
  const id = draft.destinationSessionId!
  const saved = (await f.service.action(
    id,
    {
      kind: 'save',
      id: f.id,
      revision: draft.revision,
      document: 'edited elsewhere',
      instruction: '',
      allowHistory: false,
    },
    f.allow,
  ))!
  for (const cancel of [
    { kind: 'cancel', id: f.id } as const,
    { kind: 'cancel', id: f.id, revision: draft.revision } as const,
  ])
    await expect(f.mount().action('original', cancel, f.allow)).rejects.toMatchObject({
      details: { reason: 'HANDOFF_STALE_DRAFT' },
    })
  expect(await f.service.action(id, { kind: 'status' }, f.allow)).toMatchObject({
    phase: 'draft',
    document: 'edited elsewhere',
  })
  expect(
    await f.service.action('original', { kind: 'cancel', id: f.id, revision: saved.revision }, f.allow),
  ).toMatchObject({ phase: 'cancelled', document: '' })
  expect(f.sessions.get(id)!.agent.followup).not.toHaveBeenCalled()
})

it('recovers an interrupted onward handoff on reload, then restores the link to the incoming conversation', async () => {
  const f = fixture()
  await f.begin()
  const previous = f.store.readHandoff('original', f.id)!
  await f.service.action('original', { kind: 'cancel', id: f.id }, f.allow)
  const incoming = f.store.writeHandoff({
    ...previous,
    revision: 0,
    id: randomUUID(),
    sourceSessionId: 'earlier',
    destinationSessionId: 'original',
    phase: 'completed',
  })
  const onward = randomUUID()
  const begin = (id: string) =>
    f.service.action('original', { kind: 'begin', id, locale: 'en', target: f.target }, f.allow)
  const read = () => f.mount().action('original', { kind: 'status' }, f.allow)
  await begin(onward)
  f.source.finish('keep the onward summary')
  f.listModels.mockResolvedValueOnce([])
  await f.service.action('original', { kind: 'status', id: onward }, f.allow)
  expect(await read()).toMatchObject({ id: onward, phase: 'interrupted', document: 'keep the onward summary' })
  const next = randomUUID()
  await begin(next)
  await f.service.action('original', { kind: 'cancel', id: next }, f.allow)
  expect(await read()).toMatchObject({ id: incoming.id, sourceSessionId: 'earlier', phase: 'completed' })
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
