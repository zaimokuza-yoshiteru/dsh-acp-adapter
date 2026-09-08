/** Bounded cleanup of the host provider's managed range, independent of command outcome. */
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { AcpSubprocessHandle } from './subprocess.ts'
import { waitWithin } from './timeout.ts'

export async function stopSubprocess(handle: AcpSubprocessHandle, options: {
  eofGraceMs: number
  exitWaitMs: number
  signal?: AbortSignal | undefined
  warn?: ((message: string) => void) | undefined
}): Promise<boolean> {
  const warn = options.warn ?? ((message: string) => { console.warn(message) })
  const observe = async (ms: number): Promise<boolean> => {
    // Zero means the next timer tick in ACP; zero disables the host deadline.
    using budget = deadline(options.signal, Math.max(1, ms), 'ACP_PROCESS_EXIT_TIMEOUT')
    return await waitWithin(handle.waitForExit(budget.signal), Math.max(1, ms)) === true
  }
  try { handle.stdin?.end() } catch { /* Continue cleanup after a broken pipe. */ }
  try {
    if (await observe(options.eofGraceMs)) return true
  } catch {
    warn('dsh-acp: subprocess exit observation failed; attempting managed-range termination')
  }
  try { handle.terminate() } catch {
    warn('dsh-acp: subprocess termination request failed; checking managed-range exit')
  }
  try {
    if (await observe(options.exitWaitMs)) return true
  } catch {
    warn('dsh-acp: subprocess provider could not observe managed-range exit')
  }
  warn('dsh-acp: managed-range exit was not confirmed within the cleanup budget; host cleanup remains responsible')
  return false
}
