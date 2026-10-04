export const MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS = 16

export type DevinLiveActorRole = 'lead' | 'teammate' | 'unknown'
export type DevinLivePhase = 'initial' | 'mailbox' | 'followup' | 'unknown'
export type DevinLiveToolKind = 'spawn_teammate' | 'send_message' | 'wait_agent' | 'bash' | 'other'

export interface DevinLiveToolBudget {
  dispatchAttempts: number
  allowedDispatches: number
  deniedDispatches: number
  readonly byRolePhaseTool: Map<string, number>
  readonly leadSpawnsBySession: Map<string, number>
  readonly teammateMessagesBySession: Map<string, number>
  violation: string | undefined
}

export function createDevinLiveToolBudget(): DevinLiveToolBudget {
  return {
    dispatchAttempts: 0,
    allowedDispatches: 0,
    deniedDispatches: 0,
    byRolePhaseTool: new Map(),
    leadSpawnsBySession: new Map(),
    teammateMessagesBySession: new Map(),
    violation: undefined,
  }
}

/** Record a fixed-label Host tool admission attempt and enforce this smoke test's guard. */
export function recordDevinLiveToolAttempt(
  budget: DevinLiveToolBudget,
  event: {
    readonly sessionKey: string
    readonly role: DevinLiveActorRole
    readonly phase: DevinLivePhase
    readonly tool: DevinLiveToolKind
  },
): string | undefined {
  budget.dispatchAttempts += 1
  const countKey = `${event.role}:${event.phase}:${event.tool}`
  budget.byRolePhaseTool.set(countKey, (budget.byRolePhaseTool.get(countKey) ?? 0) + 1)

  let violation: string | undefined
  if (budget.violation !== undefined) {
    violation = budget.violation
  } else if (budget.dispatchAttempts > MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS) {
    violation = 'LIVE_TOTAL_TOOL_BUDGET_EXCEEDED'
  } else if (event.role === 'unknown') {
    violation = 'LIVE_TOOL_ACTOR_UNCLASSIFIED'
  } else if (event.phase === 'unknown') {
    violation = 'LIVE_TOOL_PHASE_UNCLASSIFIED'
  } else if (event.phase === 'followup') {
    violation = 'LIVE_FOLLOWUP_TOOL_CALL_UNEXPECTED'
  } else if (event.role === 'lead' && event.tool === 'send_message') {
    violation = 'LIVE_LEAD_MESSAGE_UNEXPECTED'
  } else if (event.role === 'lead' && event.tool === 'spawn_teammate') {
    const count = (budget.leadSpawnsBySession.get(event.sessionKey) ?? 0) + 1
    budget.leadSpawnsBySession.set(event.sessionKey, count)
    if (count > 1) violation = 'LIVE_LEAD_SPAWN_BUDGET_EXCEEDED'
  } else if (event.role === 'teammate' && event.tool === 'send_message') {
    const count = (budget.teammateMessagesBySession.get(event.sessionKey) ?? 0) + 1
    budget.teammateMessagesBySession.set(event.sessionKey, count)
    if (count > 1) violation = 'LIVE_TEAMMATE_MESSAGE_BUDGET_EXCEEDED'
  }

  budget.violation ??= violation
  if (budget.violation === undefined) budget.allowedDispatches += 1
  else budget.deniedDispatches += 1
  return budget.violation
}

/** Check budget before accepting even an already-satisfied wait condition. */
export function devinLiveWaitCondition(condition: () => boolean, budgetViolation: string | undefined): boolean {
  if (budgetViolation !== undefined) throw new Error(budgetViolation)
  return condition()
}
