import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-query'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpNativeForkSource } from '../../persistence/native-fork-source.ts'
import { AcpNativeForkError } from '../../domain/session/native-fork-error.ts'

/** Optional query ownership must not make every headless adapter depend on it. */
export function createNativeForkRegistrar(ctx: Context, sidecar: AcpSidecar) {
  let owner: Context | undefined
  let closed = false
  const pending = new Set<Promise<void>>()
  const queryOwner = ctx.inject(['sessionQuery', 'sessions'], (scope) => {
    owner = scope
    scope.effect(() => async () => {
      if (owner === scope) owner = undefined
      await Promise.allSettled(pending)
    })
  })
  return {
    register(source: AcpNativeForkSource): Promise<void> {
      if (closed || owner === undefined)
        return Promise.reject(new AcpNativeForkError('unavailable', 'Native ACP fork verification is unavailable'))
      const operation = registerNativeFork(owner, sidecar, source)
      pending.add(operation)
      const settled = () => {
        pending.delete(operation)
      }
      void operation.then(settled, settled)
      return operation
    },
    /** Yield this exact disposer after Sidecar cleanup and before the drain. */
    releaseQuery: queryOwner.dispose,
    async drain(): Promise<void> {
      closed = true
      await Promise.allSettled(pending)
    },
  }
}

/** Compare against the public native seed builder, including its tagged cut. */
export function assertNativeForkSeed(source: SessionLogSnapshot, child: SessionLogSnapshot, atSeq: number): void {
  if (
    source.session.id === child.session.id ||
    !child.session.isSeeded ||
    child.session.parentSession !== undefined ||
    child.session.origin === 'subagent' ||
    child.inheritedEventCount !== atSeq + 1 ||
    source.events[atSeq]?.seq !== atSeq
  )
    throw new AcpNativeForkError('invalid-seed', 'ACP fork source does not match an ordinary native fork')
  const expected = buildForkSeed(source.events, SessionSeq(atSeq))
  if (!isDeepStrictEqual(child.events.slice(0, expected.length), expected))
    throw new AcpNativeForkError('invalid-seed', 'ACP fork history differs from the selected source prefix')
  // Native creation and increasedForkTitle may append these metadata events.
  // Any other child-owned activity needs its own admission, not retrospective adoption.
  if (
    child.events
      .slice(expected.length)
      .some((event) => event.type !== 'model/selection' && event.type !== 'session/title')
  )
    throw new AcpNativeForkError('child-changed', 'ACP fork child already has non-inherited activity')
}

/** Bind an already-created native child without replacing Session creation or titles. */
export async function registerNativeFork(
  ctx: Context,
  sidecar: AcpSidecar,
  source: AcpNativeForkSource,
): Promise<void> {
  const childId = SessionId(source.dshSessionId)
  const sourceId = SessionId(source.sourceSessionId)
  const previous = await sidecar.readNativeFork(childId)
  if (previous !== undefined) {
    if (!isDeepStrictEqual(previous, source))
      throw new AcpNativeForkError('source-conflict', 'ACP native fork already has a different source or cut')
    return
  }
  if ((await sidecar.readLatestBinding(childId)) !== undefined)
    throw new AcpNativeForkError('child-bound', 'ACP fork child is already bound')
  const binding = await sidecar.readLatestBinding(sourceId)
  if (binding?.status !== 'ok')
    throw new AcpNativeForkError('source-unavailable', 'ACP fork source has no usable binding')
  const [parent, child] = await Promise.all([
    ctx.sessionQuery.readSession(sourceId),
    ctx.sessionQuery.readSession(childId),
  ])
  assertNativeForkSeed(parent, child, source.atSeq)
  // The source/cut is explicit; the copied replay payload remains the later
  // provider's authority for the exact remote generation and committed head.
  const current = ctx.sessions.get(childId)
  if (current !== undefined && current.seq !== child.events.length)
    throw new AcpNativeForkError('child-changed', 'ACP fork child changed while its source was being verified')
  await sidecar.recordNativeFork(source)
}
