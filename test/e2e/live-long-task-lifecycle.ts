import { createHash } from 'node:crypto'

export type LongTaskFailure = {
  readonly name: string
  readonly code?: string
  readonly message: string
  readonly messageSha256: string
  readonly phase: string
}

// Test exceptions can embed raw provider output. Persist stable fixture/system
// identifiers; the runner retains the original exception without copying it here.
export function longTaskFailure(error: unknown, phase: string): LongTaskFailure {
  const value = error instanceof Error ? error : undefined
  const message = value?.message ?? String(error)
  const fixtureCode = message.match(/\bLONG_TASK_[A-Z0-9_:-]+\b/)?.[0]
  const rawCode = value !== undefined && 'code' in value ? value.code : undefined
  const code =
    fixtureCode ?? (typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode) ? rawCode : undefined)
  return {
    name: value?.name ?? 'UnknownError',
    ...(code === undefined ? {} : { code }),
    message: fixtureCode ?? 'Unclassified failure; original exception is in the runner output',
    messageSha256: createHash('sha256').update(message).digest('hex'),
    phase,
  }
}

export type LongTaskSettlement = {
  readonly owner: string
  readonly status: 'fulfilled' | 'rejected' | 'not-created'
  readonly failure?: LongTaskFailure
}

export async function settleLongTaskAction(
  owner: string,
  action: (() => unknown | Promise<unknown>) | undefined,
  phase: string,
): Promise<LongTaskSettlement> {
  if (action === undefined) return { owner, status: 'not-created' }
  try {
    await action()
    return { owner, status: 'fulfilled' }
  } catch (error: unknown) {
    return { owner, status: 'rejected', failure: longTaskFailure(error, phase) }
  }
}

export function longTaskOutcome(
  primary: LongTaskFailure | undefined,
  cancellations: readonly LongTaskSettlement[],
  cleanup: readonly LongTaskSettlement[],
): {
  primary?: LongTaskFailure
  cancellations: readonly LongTaskSettlement[]
  cleanup: readonly LongTaskSettlement[]
  cancellationFailed: boolean
  cleanupFailed: boolean
  finalizationFailed: boolean
} {
  const cancellationFailed = cancellations.some((entry) => entry.status === 'rejected')
  const cleanupFailed = cleanup.some((entry) => entry.status === 'rejected')
  return {
    ...(primary === undefined ? {} : { primary }),
    cancellations,
    cleanup,
    cancellationFailed,
    cleanupFailed,
    finalizationFailed: cancellationFailed || cleanupFailed,
  }
}

/** Preserve the original throw even if saving evidence or closing resources fails. */
export function finalLongTaskFailure(
  primary: { readonly error: unknown } | undefined,
  evidence: { readonly error: unknown } | undefined,
  finalizationFailed: boolean,
): { readonly error: unknown } | undefined {
  return primary ?? evidence ?? (finalizationFailed ? { error: new Error('LONG_TASK_FINALIZATION_FAILED') } : undefined)
}
