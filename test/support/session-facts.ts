import { applySessionFact, initialSessionFacts, type SessionLike } from '../../src/domain/session/session-facts.ts'

/** Legacy event fixtures exercise the same fold; production never scans snapshots. */
export function withSessionFacts<
  T extends {
    snapshotEvents(): readonly { type: string; seq?: number; data: unknown }[]
    inheritedEventCount?: number
  },
>(session: T): T & SessionLike {
  return Object.defineProperties(session, {
    ...(Object.hasOwn(session, 'workingDirectory')
      ? {}
      : {
          workingDirectory: { get: () => (session as { header?: { cwd?: string } }).header?.cwd },
        }),
    facts: {
      get: () =>
        session
          .snapshotEvents()
          .reduce(
            (state, event, index) => applySessionFact(state, { ...event, seq: event.seq ?? index }),
            initialSessionFacts(session.inheritedEventCount ?? 0),
          ),
    },
    seq: { get: () => Math.max(-1, ...session.snapshotEvents().map((event, index) => event.seq ?? index)) + 1 },
  }) as T & SessionLike
}
