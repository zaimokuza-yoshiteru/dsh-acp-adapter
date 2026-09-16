import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  acpExecutionProjection,
  acpSessionView,
  readSessionFacts,
} from '../../../src/host/composition/session-facts.ts'
import { sessionFactsSchema } from '../../../src/domain/session/session-facts.ts'
import type { AcpReplayPayloadV1 } from '../../../src/domain/session/acp-replay-payload.ts'

const replay = (owner: string, agent = `agent-${owner}`): AcpReplayPayloadV1 => ({
  kind: 'dsh-acp', version: 1, ownerDshSessionId: owner,
  profileId: 'codex', profileGeneration: 2, agentSessionId: agent,
  bindingEpoch: 2, launchFingerprint: 'fingerprint',
  committedPromptOrdinal: 3, committedActivitySeq: 8,
})

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(acpExecutionProjection)
  return ctx
}

function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function appendUserStep(session: Session, turn: number, step: number, text: string) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session.append('user/message', user(text), { surfaceOp: 'append' })
}

function appendReplay(session: Session, turn: number, step: number, payload: AcpReplayPayloadV1, extra: Record<string, unknown> = {}) {
  const message = createAssistantMessage({
    content: [{ type: 'text', text: 'answer must not enter the projection' }],
    source: {
      provider: 'acp', model: 'codex',
      replayState: { response: { ...payload, ...extra } } as never,
    },
  })
  return session.append('assistant/message', { turn, step, message, stream: [] }, { surfaceOp: 'append' })
}

function closeStep(session: Session, turn: number, step: number): void {
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function checkpointSeq(rows: ReturnType<Context['sessionProjections']['checkpoint']>): number {
  const row = rows.acpExecution
  if (row === undefined) throw new Error('missing acpExecution checkpoint')
  return row.seq
}

describe('ACP execution SessionProjection integration', () => {
  it('tracks live append facts without retaining message content', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('facts-live'))
    expect(acpSessionView(ctx, session)?.identity).toBe(session)

    const first = appendUserStep(session, 1, 0, 'first input')
    let facts = readSessionFacts(ctx, session)
    expect(facts).toMatchObject({
      turnOpen: true, turnSeen: true, hasSemanticHistory: true,
      priorSemanticHistory: false,
      openSteps: [{ turn: 1, step: 0, startSeq: first.seq - 1, messageIds: [first.data.id] }],
    })
    expect(JSON.stringify(facts)).not.toContain('first input')

    closeStep(session, 1, 0)
    session.append('turn/start', { turn: 2 })
    facts = readSessionFacts(ctx, session)
    expect(facts.turnOpen).toBe(true)
    expect(facts.priorSemanticHistory).toBe(true)
    expect(facts.openSteps).toEqual([])
  })

  it('checkpoints and cold-restores the same state over a suffix', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('facts-cold'))
    appendUserStep(session, 1, 0, 'first')
    closeStep(session, 1, 0)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const beforeSeq = checkpointSeq(checkpoint)

    appendUserStep(session, 2, 0, 'second')
    const floor = ctx.sessionProjections.restoreFloor(checkpoint)
    expect(floor).toBe(beforeSeq)
    if (floor === undefined) throw new Error('checkpoint restore floor is unavailable')
    const restored = ctx.sessionProjections.restore(
      checkpoint,
      session.snapshotEvents(floor),
      floor,
      session.header,
      session.inheritedEventCount,
    )

    expect(restored.snapshot.asOfSeq).toBe(session.seq - 1)
    expect(restored.checkpoint.acpExecution?.seq).toBe(session.seq - 1)
    expect(restored.checkpoint.acpExecution?.val).toEqual(readSessionFacts(ctx, session))
    expect(restored.snapshot.values).toEqual({})
  })

  it('keeps fork replay markers to the inherited prefix and admits only child step ids', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('facts-parent'))
    const parentUser = appendUserStep(parent, 1, 0, 'parent input')
    appendReplay(parent, 1, 0, replay('facts-parent'))
    closeStep(parent, 1, 0)
    const inheritedCount = parent.seq
    const child = ctx.sessions.fork(parent, undefined, SessionId('facts-child'))

    expect(child.inheritedEventCount).toBe(inheritedCount)
    expect(readSessionFacts(ctx, child).inheritedRemaining).toBe(0)
    expect(readSessionFacts(ctx, child).forkReplay).toEqual(replay('facts-parent'))

    const childUser = appendUserStep(child, 2, 0, 'child input')
    appendReplay(child, 2, 0, replay('facts-child'), { content: 'must not be persisted in facts' })
    let facts = readSessionFacts(ctx, child)
    expect(facts.forkReplay).toEqual(replay('facts-parent'))
    expect(facts.openSteps.at(-1)?.messageIds).toEqual([childUser.data.id])
    expect(facts.openSteps.at(-1)?.messageIds).not.toContain(parentUser.data.id)
    expect(JSON.stringify(facts)).not.toContain('parent input')
    expect(JSON.stringify(facts)).not.toContain('child input')
    expect(JSON.stringify(facts)).not.toContain('must not be persisted')
  })

  it('refolds from seq zero when a checkpoint watermark is beyond a truncated log', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('facts-truncate'))
    appendUserStep(session, 1, 0, 'input')
    closeStep(session, 1, 0)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const watermark = checkpointSeq(checkpoint)
    session.append('turn/start', { turn: 2 })

    expect(() => ctx.sessionProjections.restore(
      checkpoint, [], SessionLogOffset(watermark), session.header, SessionLogOffset(0),
    )).toThrow(/re-read from seq 0/)

    const truncated = session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(watermark - 1))
    const restored = ctx.sessionProjections.restore(
      checkpoint, truncated, SessionLogOffset(0), session.header, SessionLogOffset(0),
    )
    expect(restored.snapshot.asOfSeq).toBe(truncated.at(-1)?.seq)
    expect(restored.checkpoint.acpExecution?.seq).toBe(truncated.at(-1)?.seq)
    const state = sessionFactsSchema.parse(restored.checkpoint.acpExecution?.val)
    expect(state.openSteps).toHaveLength(1)
    expect(state.turnOpen).toBe(true)
  })

  it('uses only the compact replay marker shape in checkpoint state', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('facts-schema-parent'))
    appendUserStep(parent, 1, 0, 'input')
    appendReplay(parent, 1, 0, replay('facts-schema-parent'), { content: [{ type: 'text', text: 'full response' }] })
    closeStep(parent, 1, 0)
    const session = ctx.sessions.fork(parent, undefined, SessionId('facts-schema-child'))

    const facts = readSessionFacts(ctx, session)
    expect(Object.keys(facts.forkReplay ?? {}).sort()).toEqual(Object.keys(replay('facts-schema')).sort())
    expect(facts.forkReplay).toEqual(replay('facts-schema-parent'))
    expect(JSON.stringify(ctx.sessionProjections.checkpoint(session))).not.toContain('full response')
  })
})
