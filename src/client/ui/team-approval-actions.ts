import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionBase, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AcpTeamMemberView } from '../data/acp-remote.ts'

const memberReadRetryDelays = [500, 1_000, 2_000, 4_000, 8_000] as const
const stableMemberReadErrorCodes = new Set([
  'dsh-acp/config',
  'dsh-acp/not-installed',
  'dsh-acp/auth-required',
  'dsh-acp/protocol-incompatible',
  'dsh-acp/user-rejected',
  'gateway/bad-request',
])

export function isStableTeamMemberReadError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    stableMemberReadErrorCodes.has(error.code)
  )
}

async function waitForMemberReadRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}

/** Retry only the read while its captured session/request remains live. */
export async function readTeamMembersUntilAvailable(
  sessionId: SessionId,
  loadMembers: (sessionId: SessionId) => Promise<readonly AcpTeamMemberView[]>,
  active: () => boolean,
  options: {
    readonly signal?: AbortSignal
    readonly onAttempt?: () => void
    readonly onFailure?: () => void
  } = {},
): Promise<readonly AcpTeamMemberView[] | undefined> {
  let attempt = 0
  while (!options.signal?.aborted && active()) {
    options.onAttempt?.()
    try {
      const members = await loadMembers(sessionId)
      return !options.signal?.aborted && active() ? members : undefined
    } catch (error) {
      if (options.signal?.aborted || !active()) return undefined
      if (isStableTeamMemberReadError(error)) throw error
      options.onFailure?.()
      const delay = memberReadRetryDelays[Math.min(attempt, memberReadRetryDelays.length - 1)]!
      attempt++
      await waitForMemberReadRetry(delay, options.signal)
    }
  }
  return undefined
}

/** Structural subsets of the host's public pending carriers; no second approval broker. */
export interface TeamApproval extends SessionPendingInteractionBase {
  readonly kind: 'approval'
  readonly reason?: string
  readonly toolName: string
  answer(outcome: 'allowed-once' | 'rejected'): Promise<void>
}
export function teamApproval(value: SessionPendingInteractionBase): TeamApproval | undefined {
  return value.kind === 'approval' &&
    'answer' in value &&
    typeof value.answer === 'function' &&
    'toolName' in value &&
    typeof value.toolName === 'string'
    ? (value as TeamApproval)
    : undefined
}
/** Settle only the captured, still-current requests. New arrivals never join a batch. */
export async function answerTeamRequests(
  requests: readonly { pending: SessionPendingInteractionBase; answer: () => Promise<void> }[],
  current: () => SessionStatusSnapshot,
  allowedMembers: ReadonlySet<SessionId>,
  active: () => boolean,
  inFlight: Set<SessionPendingInteractionBase>,
): Promise<number> {
  const outcomes = await Promise.allSettled(
    requests.map(async (request) => {
      const pending = request.pending
      if (
        !active() ||
        !allowedMembers.has(pending.sessionId) ||
        current().get(pending.sessionId)?.pendingInteraction !== pending ||
        inFlight.has(pending)
      )
        return
      inFlight.add(pending)
      try {
        await request.answer()
      } finally {
        inFlight.delete(pending)
      }
    }),
  )
  return outcomes.filter((outcome) => outcome.status === 'rejected').length
}
