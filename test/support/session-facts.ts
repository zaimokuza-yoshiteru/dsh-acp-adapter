import { applySessionFact, initialSessionFacts, type SessionLike } from '../../src/domain/session/session-facts.ts'

/** Legacy event fixtures exercise the same fold; production never scans snapshots. */
export function withSessionFacts<T extends { snapshotEvents(): readonly { type: string; seq?: number; data: unknown }[]; inheritedEventCount?: number }>(session: T): T & SessionLike {
  return Object.defineProperties(session, {
    facts: { get: () => session.snapshotEvents().reduce((state, event, index) => applySessionFact(state, { ...event, seq: event.seq ?? index }),
      initialSessionFacts(session.inheritedEventCount ?? 0)) },
    seq: { get: () => Math.max(-1, ...session.snapshotEvents().map((event, index) => event.seq ?? index)) + 1 },
    permissions: { get: () => {
      const latest = (type: string, key: string): string | null => {
        const data = session.snapshotEvents().findLast(event => event.type === type)?.data as Record<string, string> | undefined
        return data?.[key] ?? null
      }
      return { sandbox: latest('sandbox/mode', 'mode'), approval: latest('approval/policy', 'policy') }
    } },
  }) as T & SessionLike
}
