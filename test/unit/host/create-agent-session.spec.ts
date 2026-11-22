import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { CreateSessionAuthority, createIndependentSession } from '../../../src/host/tools/create-agent-session.ts'
import { IndependentSessionRequests, independentSessionSchema } from '../../../src/persistence/independent-session.ts'

describe('independent Agent sessions', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(independentSessionSchema)
  })
  afterEach(() => db.close())
  const selected = { agent: 'devin', model: 'swe-2-high' }
  function setup() {
    const requests = new IndependentSessionRequests(() => db)
    const deps = {
      requests,
      profileIds: () => ['devin'],
      targetProfile: (id: string) => (id === 'devin' ? 'profile-generation-1' : undefined),
      models: vi.fn(async () => [{ id: 'swe-2-high' }]),
      create: vi.fn(
        async (_source: string, _target: unknown, id: string, check: () => void, _existingOnly: boolean) => {
          check()
          return id
        },
      ),
      submit: vi.fn(async () => {}),
      submitted: vi.fn(async () => false),
    }
    return { deps, requests }
  }
  it('creates one independent destination per owner input and task even when the bridge changes its call id', async () => {
    const { deps, requests } = setup()
    const create = (owner: string, args: typeof selected & { task?: string }) =>
      createIndependentSession(deps, 'source', owner, args, () => {})
    const first = await create('owner-input', selected)
    expect(first.status).toBe('created')
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.create).toHaveBeenCalledWith(
      'source',
      { provider: 'acp-devin', model: 'swe-2-high' },
      first.sessionId,
      expect.any(Function),
      false,
    )
    expect(await create('owner-input', selected)).toEqual(first)
    const second = await create('owner-input', { ...selected, task: 'Check the tests' })
    expect(second.status).toBe('task-queued')
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(await create('owner-input', { ...selected, task: 'Check the tests' })).toEqual(second)
    expect(deps.create).toHaveBeenCalledTimes(2)
    expect(deps.submit).toHaveBeenCalledTimes(1)
    expect(requests.list('source').map((row) => row.sessionId)).toEqual([second.sessionId, first.sessionId])
    expect(requests.list('unrelated')).toEqual([])
    expect((await create('next-owner-input', selected)).sessionId).not.toEqual(first.sessionId)
  })
  it('reopens the reserved destination after a lost create reply and forbids minting a replacement', async () => {
    const { deps } = setup()
    deps.create.mockRejectedValueOnce(new Error('lost reply'))
    await expect(createIndependentSession(deps, 'source', 'owner', selected, () => {})).rejects.toThrow('lost reply')
    const reserved = deps.create.mock.calls[0]![2]
    const restarted = { ...deps, requests: new IndependentSessionRequests(() => db) }
    expect(await createIndependentSession(restarted, 'source', 'owner', selected, () => {})).toEqual({
      sessionId: reserved,
      status: 'created',
    })
    expect(deps.create.mock.calls[1]!.slice(2)).toEqual([reserved, expect.any(Function), true])
  })
  it('refuses to repair a pending task through a replacement installation with the same Agent and model IDs', async () => {
    const { deps } = setup()
    const args = { ...selected, task: 'Review project files' }
    deps.create.mockRejectedValueOnce(new Error('lost create reply'))
    await expect(createIndependentSession(deps, 'source', 'owner', args, () => {})).rejects.toThrow('lost create reply')
    const restarted = {
      ...deps,
      targetProfile: () => 'replacement-profile',
      requests: new IndependentSessionRequests(() => db),
    }
    await expect(createIndependentSession(restarted, 'source', 'owner', args, () => {})).rejects.toThrow(
      'ACP_SESSION_AGENT_CHANGED',
    )
    expect(deps.create).toHaveBeenCalledTimes(1)
    expect(deps.submit).not.toHaveBeenCalled()
  })
  it('reconciles task admission after restart without sending twice, even when the receipt is unavailable', async () => {
    const { deps } = setup()
    deps.submit.mockRejectedValueOnce(new Error('receipt was lost'))
    const args = { ...selected, task: 'Review docs' }
    await expect(createIndependentSession(deps, 'source', 'owner', args, () => {})).rejects.toThrow('receipt was lost')
    const restarted = { ...deps, requests: new IndependentSessionRequests(() => db) }
    await expect(createIndependentSession(restarted, 'source', 'owner', args, () => {})).rejects.toThrow(
      'TASK_UNCONFIRMED',
    )
    deps.submitted.mockResolvedValue(true)
    expect((await createIndependentSession(restarted, 'source', 'owner', args, () => {})).status).toBe('task-queued')
    expect(deps.submit).toHaveBeenCalledTimes(1)
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it('requires a live named model and rechecks caller authority before creating', async () => {
    const { deps } = setup()
    await expect(
      createIndependentSession(deps, 'source', 'owner', { ...selected, agent: 'gone' }, () => {}),
    ).rejects.toThrow('UNKNOWN_AGENT')
    await expect(
      createIndependentSession(deps, 'source', 'owner', { ...selected, model: 'not-a-model' }, () => {}),
    ).rejects.toThrow('swe-2-high')
    const check = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('revoked')
      })
    await expect(createIndependentSession(deps, 'source', 'owner', selected, check)).rejects.toThrow('revoked')
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.requests.list('source')).toEqual([])
  })
})

it('binds authority to an admitted foreground owner input in a main Session, including mixed owner/reader turns', () => {
  const auth = new CreateSessionAuthority()
  const session = { header: {} } as Session
  const message = (source: object) => createUserMessage({ content: [], source: source as UserMessage['source'] })
  const owner = message({ kind: 'user', rpcId: 'owner-1' })
  auth.claimed(session, 1, owner)
  expect(auth.owner(session)).toBeUndefined()
  auth.committed(session, owner)
  expect(auth.owner(session)).toBe(owner.id)
  auth.claimed(session, 1, message({ kind: 'user', rpcId: 'reader-2', principal: { type: 'guest' } }))
  expect(auth.owner(session)).toBeUndefined()
  auth.end(session)
  const task = message({ kind: 'dsh-acp-adapter/agent-task', sourceSessionId: 'other', requestKey: 'k' })
  auth.claimed(session, 2, task)
  auth.committed(session, task)
  expect(auth.owner(session)).toBeUndefined()
  const child = { header: { origin: 'subagent', delegationDepth: 1 } } as Session
  auth.claimed(child, 1, owner)
  auth.committed(child, owner)
  expect(auth.owner(child)).toBeUndefined()
})
