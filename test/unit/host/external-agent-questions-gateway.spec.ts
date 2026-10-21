import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { externalAgentPermissionQuestions } from '../../../src/host/composition/external-agent-questions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

// Published services, no generated adapter files, HTTP Host or model process.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const load = (name: string) => import(pathToFileURL(requireDsh.resolve(name)).href)
const [Registry, Access, Gateway, Connection, Remotes, Questions] = await Promise.all([
  load('@deepseek-ai/dsh-typert-registry'),
  load('@deepseek-ai/dsh-api-remote-access'),
  load('@deepseek-ai/dsh-api-gateway'),
  load('@deepseek-ai/dsh-client-connection'),
  load('@deepseek-ai/dsh-api-remotes'),
  load('@deepseek-ai/dsh-user-questions'),
])

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'acp-question-viewer': { readonly kind: 'acp-question-viewer' }
  }
}

it('keeps child details owner-only and re-delivers the same native wait after a client reconnect', async () => {
  const ctx = new Context()
  const root = {
    id: SessionId('root'),
    ctx: ctx.extend({}),
    session: { id: 'root', header: {} },
    status: 'idle',
  } as unknown as Agent
  const child = {
    id: SessionId('child'),
    ctx: ctx.extend({}),
    status: 'running',
    session: { id: 'child', header: { origin: 'subagent' }, isOwnSeq: () => true },
  } as unknown as Agent
  ctx.provide('agents', {
    get: (id: string) => (id === 'root' ? root : id === 'child' ? child : undefined),
    roots: () => [root],
    list: () => [root, child],
    isOwnedBy: (id: string, owner: Agent) => id === 'child' && owner === root,
  } as never)
  ctx.provide('sessionProjections', {
    register: () => () => {},
    snapshot: () => ({ values: { subagent: { seq: 1, label: 'Private child' } } }),
  } as never)
  let rpc: ((endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<unknown>) | undefined
  ctx.provide('connection', {
    rpc: {
      intercept: (_channel: string, _match: unknown, handler: NonNullable<typeof rpc>) => {
        rpc = handler
        return () => {}
      },
    },
  } as never)
  const abort = new AbortController()
  const firstOwnerAbort = new AbortController()
  try {
    await ctx.plugin(Registry.default)
    await ctx.plugin(Access.default)
    await ctx.plugin(Gateway.default)
    await ctx.plugin(Questions.default)
    let dispatches = 0
    ctx.on('user-questions/request', ((_request: unknown, next: () => Promise<unknown>) => {
      dispatches++
      return next()
    }) as never)
    await ctx.plugin(Remotes)
    ctx.typert.resources.register('session', { field: 'sessionId' })
    ctx.remoteAccess.registerPolicy('acp-question-viewer', {
      bindings: () => [
        {
          role: { name: 'root-reader', resource: 'session', actions: ['event:api-session/error'] },
          resource: { kind: 'session', id: SessionId('root') },
        },
      ],
    })
    const guest: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'acp-question-viewer' } })
    const owner: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'owner' } })
    const open = async (peer: PeerScope, signal: AbortSignal) =>
      (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, signal))[
        Symbol.asyncIterator
      ]()
    const guestEvents = await open(guest, abort.signal)
    const guestReady = await guestEvents.next()
    expect(guestReady.value).toMatchObject({ type: 'ready' })
    const ownerEvents = await open(owner, firstOwnerAbort.signal)
    const ownerReady = await ownerEvents.next()
    const native = ctx.get('userQuestions') as unknown as AcpNativeUserQuestionService
    const pending = externalAgentPermissionQuestions(ctx, () => child, native).ask({
      agent: child,
      questions: [
        {
          id: 'scope',
          question: 'Sensitive child command',
          options: [{ label: 'Once' }, { label: 'Session' }],
        },
      ],
    })
    const first = (await ownerEvents.next()).value as { eventId: string; request: unknown }
    expect(first).toMatchObject({ type: 'waterfall', agentId: 'root', event: 'user-questions/request' })
    expect(JSON.stringify(first.request)).toContain('Private child')
    // Same source queue: a later permitted root notification proves the earlier
    // child question was not delivered to the root-only non-owner.
    ctx.emit('api-session/error', SessionId('root'), 'root-readable-sentinel')
    expect((await guestEvents.next()).value).toEqual({
      type: 'emit',
      event: 'api-session/error',
      args: ['root', 'root-readable-sentinel'],
    })
    const result = (clientId: string, value: unknown) => ({
      args: { clientId, eventId: first.eventId, outcome: { kind: 'result', value } },
    })
    const answer = { answers: [{ id: 'scope', selected: ['Session'] }] }
    expect(
      await rpc!(
        '$events/result',
        result((guestReady.value as { clientId: string }).clientId, answer),
        abort.signal,
        guest,
      ),
    ).toMatchObject({ ok: false, error: { code: 'gateway/invocation-unavailable' } })

    firstOwnerAbort.abort()
    await ownerEvents.return?.()
    const nextOwnerEvents = await open(owner, abort.signal)
    const nextReady = await nextOwnerEvents.next()
    const replay = (await nextOwnerEvents.next()).value
    expect(replay).toEqual(first)
    expect(dispatches).toBe(1)
    expect(
      await rpc!(
        '$events/result',
        result((ownerReady.value as { clientId: string }).clientId, answer),
        abort.signal,
        owner,
      ),
    ).toMatchObject({ ok: false })
    expect(
      await rpc!(
        '$events/result',
        result((nextReady.value as { clientId: string }).clientId, answer),
        abort.signal,
        owner,
      ),
    ).toMatchObject({ ok: true })
    expect(await pending).toEqual(answer)
    // A duplicate transport result cannot settle a second request.
    expect(
      await rpc!(
        '$events/result',
        result((nextReady.value as { clientId: string }).clientId, answer),
        abort.signal,
        owner,
      ),
    ).toMatchObject({ ok: true })
    abort.abort()
    await Promise.all([guestEvents.return?.(), nextOwnerEvents.return?.()])
  } finally {
    abort.abort()
    firstOwnerAbort.abort()
    await ctx.fiber.dispose()
  }
})
