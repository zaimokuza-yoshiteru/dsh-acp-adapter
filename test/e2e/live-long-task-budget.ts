import { createHmac } from 'node:crypto'

export const LONG_TASK_BUDGET = {
  totalDispatches: 96,
  sceneDispatches: 48,
  totalMs: 20 * 60_000,
  sceneMs: 6 * 60_000,
  phaseMs: 90_000,
  spawnAttempts: 2,
  repeatedEffects: 2,
  approvalRequests: 24,
  sceneApprovalRequests: 16,
  providerToolCalls: 128,
} as const

export type LongTaskScene = 'A' | 'B' | 'C' | 'D'
export type LongTaskRole = 'lead' | 'member'

export type LongTaskBudget = {
  startedAt: number
  totalDispatches: number
  sceneDispatches: Record<LongTaskScene, number>
  spawnAttempts: number
  approvalRequests: number
  sceneApprovalRequests: Record<LongTaskScene, number>
  providerToolCallIds: Set<string>
  successfulEffectCounts: Map<string, number>
  pendingEffectCounts: Map<string, number>
  effectByCallId: Map<string, string>
  violation?: string
}

export function createLongTaskBudget(startedAt = Date.now()): LongTaskBudget {
  return {
    startedAt,
    totalDispatches: 0,
    sceneDispatches: { A: 0, B: 0, C: 0, D: 0 },
    spawnAttempts: 0,
    approvalRequests: 0,
    sceneApprovalRequests: { A: 0, B: 0, C: 0, D: 0 },
    providerToolCallIds: new Set(),
    successfulEffectCounts: new Map(),
    pendingEffectCounts: new Map(),
    effectByCallId: new Map(),
  }
}

function failClosed(budget: LongTaskBudget, reason: string): string {
  budget.violation ??= reason
  return budget.violation
}

/** Call only from the Host tool guard, which runs before the registered body. */
export function admitLongTaskTool(
  budget: LongTaskBudget,
  input: {
    scene: LongTaskScene
    toolName: string
    callId: string
    effectFingerprint?: string
    now?: number
  },
): string | undefined {
  const now = input.now ?? Date.now()
  if (budget.violation) return budget.violation
  if (now - budget.startedAt >= LONG_TASK_BUDGET.totalMs) return failClosed(budget, 'LONG_TASK_TOTAL_DEADLINE')
  if (budget.totalDispatches >= LONG_TASK_BUDGET.totalDispatches)
    return failClosed(budget, 'LONG_TASK_TOTAL_DISPATCH_BUDGET')
  if (budget.sceneDispatches[input.scene] >= LONG_TASK_BUDGET.sceneDispatches)
    return failClosed(budget, 'LONG_TASK_SCENE_DISPATCH_BUDGET')
  if (input.toolName === 'spawn_teammate') {
    if (budget.spawnAttempts >= LONG_TASK_BUDGET.spawnAttempts) return failClosed(budget, 'LONG_TASK_SPAWN_BUDGET')
    budget.spawnAttempts += 1
  }
  if (input.effectFingerprint !== undefined) {
    const count =
      (budget.successfulEffectCounts.get(input.effectFingerprint) ?? 0) +
      (budget.pendingEffectCounts.get(input.effectFingerprint) ?? 0)
    if (count >= LONG_TASK_BUDGET.repeatedEffects) return failClosed(budget, 'LONG_TASK_REPEAT_EFFECT_BUDGET')
    budget.effectByCallId.set(input.callId, input.effectFingerprint)
    budget.pendingEffectCounts.set(
      input.effectFingerprint,
      (budget.pendingEffectCounts.get(input.effectFingerprint) ?? 0) + 1,
    )
  }
  budget.totalDispatches += 1
  budget.sceneDispatches[input.scene] += 1
  return undefined
}

/** Record successful body completion; a failure does not consume the repeat-effect allowance. */
export function recordLongTaskToolResult(budget: LongTaskBudget, callId: string, isError: boolean): void {
  const fingerprint = budget.effectByCallId.get(callId)
  budget.effectByCallId.delete(callId)
  if (fingerprint !== undefined) {
    const pending = budget.pendingEffectCounts.get(fingerprint) ?? 0
    if (pending <= 1) budget.pendingEffectCounts.delete(fingerprint)
    else budget.pendingEffectCounts.set(fingerprint, pending - 1)
    if (!isError)
      budget.successfulEffectCounts.set(fingerprint, (budget.successfulEffectCounts.get(fingerprint) ?? 0) + 1)
  }
}

/** ACP permission requests bypass the Host tool guard, so count them independently. */
export function recordLongTaskApprovalRequest(budget: LongTaskBudget, scene: LongTaskScene): string | undefined {
  if (budget.violation) return budget.violation
  if (budget.approvalRequests >= LONG_TASK_BUDGET.approvalRequests)
    return failClosed(budget, 'LONG_TASK_APPROVAL_REQUEST_BUDGET')
  if (budget.sceneApprovalRequests[scene] >= LONG_TASK_BUDGET.sceneApprovalRequests)
    return failClosed(budget, 'LONG_TASK_SCENE_APPROVAL_REQUEST_BUDGET')
  budget.approvalRequests += 1
  budget.sceneApprovalRequests[scene] += 1
  return undefined
}

/** Provider-originated tool_call updates arrive after execution may have started: this is a soft stop signal. */
export function observeLongTaskProviderToolCall(budget: LongTaskBudget, providerToolCallId: string): boolean {
  if (budget.providerToolCallIds.has(providerToolCallId)) return false
  budget.providerToolCallIds.add(providerToolCallId)
  if (budget.providerToolCallIds.size > LONG_TASK_BUDGET.providerToolCalls)
    failClosed(budget, 'LONG_TASK_PROVIDER_TOOL_ACTIVITY_SOFT_BUDGET')
  return true
}

export function longTaskEffectFingerprint(secret: string, toolName: string, args: unknown): string {
  return createHmac('sha256', secret).update(toolName).update('\0').update(stableJson(args)).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}
