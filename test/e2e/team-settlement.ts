import { expect, vi } from 'vitest'
import type { ObservedEvent } from './types.ts'

export interface TeamSettlementPhase {
  readonly parentId: string
  readonly childId: string
  /** Snapshot immediately before approving or sending this phase's child task. */
  readonly after: number
}

/** A fixture phase completes after the native parent consumes its settlement, not an intermediate idle gap. */
export function observedTeamSettlement(events: readonly ObservedEvent[], phase: TeamSettlementPhase) {
  const childEndIndex = events.findIndex(
    (event, index) => index >= phase.after && event.sessionId === phase.childId && event.type === 'turn/end',
  )
  const childEnd = events[childEndIndex]
  if (childEnd?.type !== 'turn/end' || childEnd.data.reason.kind !== 'completed') return
  // Initial approval can happen long after the child turn started.
  const childStart = events
    .slice(0, childEndIndex)
    .findLast(
      (event) =>
        event.sessionId === phase.childId && event.type === 'turn/start' && event.data.turn === childEnd.data.turn,
    )
  if (!childStart) return
  const noticeIndex = events.findIndex(
    (event, index) =>
      index > childEndIndex &&
      event.sessionId === phase.parentId &&
      event.type === 'user/message' &&
      event.data.source.kind === 'subagent-settled' &&
      event.data.source.form === 'notice' &&
      event.data.source.senderSessionId === phase.childId,
  )
  const notice = events[noticeIndex]
  if (notice?.type !== 'user/message') return
  const parentStep = events
    .slice(0, noticeIndex)
    .findLast((event) => event.sessionId === phase.parentId && event.type === 'step/start')
  if (parentStep?.type !== 'step/start') return
  const stepEndIndex = events.findIndex(
    (event, index) =>
      index > noticeIndex &&
      event.sessionId === phase.parentId &&
      event.type === 'step/end' &&
      event.data.turn === parentStep.data.turn &&
      event.data.step === parentStep.data.step,
  )
  if (stepEndIndex < 0) return
  const parentEnd = events.find(
    (event, index) =>
      index > stepEndIndex &&
      event.sessionId === phase.parentId &&
      event.type === 'turn/end' &&
      event.data.turn === parentStep.data.turn,
  )
  if (parentEnd?.type !== 'turn/end' || parentEnd.data.reason.kind !== 'completed') return
  return {
    childTurn: childEnd.data.turn,
    noticeId: notice.data.id,
    parentTurn: parentStep.data.turn,
    parentStep: parentStep.data.step,
  }
}

/** Only observes this exact parent/child phase; never supplies approval or cancels execution. */
export async function waitForTeamSettlement(events: readonly ObservedEvent[], phase: TeamSettlementPhase) {
  await vi.waitFor(
    () => {
      expect(
        observedTeamSettlement(events, phase),
        'native child settlement must finish in its owning parent phase',
      ).toBeDefined()
    },
    { timeout: 30_000 },
  )
  return observedTeamSettlement(events, phase)!
}
