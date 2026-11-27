import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { AcpClientError, AcpDisconnectedError } from '../../protocol/v1/errors.ts'
import { waitForReconnect } from '../../runtime/session/session-runtime.ts'

// The native failed-step hook retries a model request, which could duplicate
// an ACP tool call. Use its normal backoff defaults only for pre-prompt setup.
const policy = resolveRetryPolicy({ mode: 'normal' }, 'ACP original session')

export function isTemporaryDisconnect(error: unknown): boolean {
  return error instanceof AcpDisconnectedError || (error instanceof AcpClientError && error.kind === 'timeout')
}

/** Share one budget across initialize and restore for a single admitted user input. */
export function originalSessionSetup(
  requestSignal: AbortSignal | undefined,
  retrySignal: () => AbortSignal,
  closeTransport: () => Promise<void>,
) {
  let retries = 0
  return async (
    operation: (signal?: AbortSignal) => Promise<void>,
    canReconnect: () => boolean | Promise<boolean>,
  ): Promise<void> => {
    for (;;) {
      const signal = retries ? retrySignal() : requestSignal
      signal?.throwIfAborted()
      try {
        await operation(signal)
        return
      } catch (error) {
        signal?.throwIfAborted()
        if (
          !isTemporaryDisconnect(error) ||
          policy.mode !== 'normal' ||
          retries >= policy.maxRetries ||
          !(await canReconnect())
        )
          throw error
        const life = retrySignal()
        life.throwIfAborted()
        const delay = Math.min(policy.initialDelayMs * 2 ** retries, policy.maxDelayMs)
        retries++
        await closeTransport()
        await waitForReconnect(life, delay)
      }
    }
  }
}
