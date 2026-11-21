import type { AcpAccountUsageView, AcpAccountWindow } from '../../contract/account-usage.ts'

export type AccountFields = Pick<AcpAccountUsageView, 'plan' | 'credits' | 'windows'> & {
  readonly signInRequired?: true
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function label(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return /^[\p{L}\p{N}][\p{L}\p{N} ._()+/-]{0,79}$/u.test(text) ? text : null
}

function percent(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
}

export function devinPlan(output: string): AccountFields {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const match = /^\s*Plan:\s*([^\r\n]+)$/im.exec(text)
  return { plan: label(match?.[1]), credits: null, windows: [] }
}

export function codexFields(accountResult: unknown, limitsResult: unknown): AccountFields {
  const result = record(accountResult)
  if (result.account === null && result.requiresOpenaiAuth === true)
    return { signInRequired: true, plan: null, credits: null, windows: [] }
  const account = record(result.account)
  if (account.type !== 'chatgpt') return { plan: null, credits: null, windows: [] }
  const response = record(limitsResult)
  const limits = record(response.rateLimits)
  const balance = record(limits.credits).balance
  const windows = codexWindows(limits)
  // The app server repeats its backward-compatible snapshot in the metered map,
  // under "codex" when the source did not specify a limit ID.
  const seen = new Set([typeof limits.limitId === 'string' ? limits.limitId : 'codex'])
  const additional = record(response.rateLimitsByLimitId)
  for (const id of Object.keys(additional).sort()) {
    const snapshot = record(additional[id])
    const meter = typeof snapshot.limitId === 'string' ? snapshot.limitId : id
    if (seen.has(id) || seen.has(meter)) continue
    seen.add(meter)
    windows.push(...codexWindows(snapshot, seen.size - 1))
  }
  return {
    plan: label(account.planType),
    credits: typeof balance === 'string' && /^\d{1,20}(?:\.\d{1,12})?$/.test(balance) ? balance : null,
    windows,
  }
}

function codexWindows(snapshot: Record<string, unknown>, index = 0): AcpAccountWindow[] {
  const windows: AcpAccountWindow[] = []
  const name = label(snapshot.limitName)
  for (const period of ['primary', 'secondary']) {
    const bucket = record(snapshot[period])
    if (!percent(bucket.usedPercent, 100)) continue
    const seconds = bucket.resetsAt
    const minutes = bucket.windowDurationMins
    windows.push({
      key: index === 0 ? period : `${period}:${index}`,
      ...(index > 0 || name !== null ? { bucketName: name } : {}),
      remainingPercent: 100 - bucket.usedPercent,
      minutes: typeof minutes === 'number' && Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null,
      resetsAt:
        typeof seconds === 'number' && seconds > 0 && Number.isSafeInteger(seconds * 1000) && seconds * 1000 <= 8.64e15
          ? seconds * 1000
          : null,
    })
  }
  return windows
}

export function agyFields(payload: unknown): AccountFields {
  const snapshot = record(payload)
  const windows: AcpAccountWindow[] = []
  for (const [key, entry] of Object.entries(record(snapshot.quota))) {
    const bucket = record(entry)
    if (windows.length >= 32 || !/^[\w.-]{1,80}$/.test(key) || !percent(bucket.remaining_fraction, 1)) continue
    const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
    windows.push({
      key,
      minutes: null,
      remainingPercent: Math.round(bucket.remaining_fraction * 10000) / 100,
      resetsAt: Number.isFinite(reset) ? reset : null,
    })
  }
  return { plan: label(snapshot.plan_tier), credits: null, windows }
}

export function hasAccountFields(fields: AccountFields): boolean {
  return fields.plan !== null || fields.credits !== null || fields.windows.length > 0
}
