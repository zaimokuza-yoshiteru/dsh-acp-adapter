import { singleActivityTerminalId } from '../../contract/terminal-outcome.ts'
import type { AcpHostTerminalOutcome } from '../../contract/terminal-outcome.ts'
import type { AcpTerminalAuditData } from '../../domain/policy/events.ts'

/** One runtime's bounded process facts, retained after terminal/release until
 * its explicit tool reference is projected. No command/time guessing or I/O. */
export class HostTerminalOutcomes {
  private readonly facts = new Map<string, AcpHostTerminalOutcome>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly dshSessionId: string,
    private readonly profileId: string,
    private readonly limit = 256,
  ) {}

  observe(event: AcpTerminalAuditData): void {
    if (
      event.dshSessionId !== this.dshSessionId ||
      event.profileId !== this.profileId ||
      event.operation !== 'exit' ||
      event.outcome !== 'exited' ||
      !event.acpSessionId ||
      !event.terminalId
    )
      return
    const exitCode = Number.isSafeInteger(event.exitCode) ? event.exitCode! : null
    const signal = typeof event.signal === 'string' && event.signal.length > 0 ? event.signal : null
    if (exitCode === null && signal === null) return
    const key = JSON.stringify([event.acpSessionId, event.terminalId])
    const previous = this.facts.get(key)
    if (previous?.exitCode === exitCode && previous.signal === signal) return
    // A process has one terminal result. Do not replace an accepted fact with
    // a later conflicting observation from a malformed lifecycle.
    if (previous !== undefined) return
    this.facts.set(key, {
      source: 'acp-client-terminal',
      dshSessionId: this.dshSessionId,
      acpSessionId: event.acpSessionId,
      terminalId: event.terminalId,
      exitCode,
      signal,
    })
    while (this.facts.size > this.limit) this.facts.delete(this.facts.keys().next().value!)
    for (const listener of this.listeners) listener()
  }

  resolve(acpSessionId: string | undefined, content: unknown): AcpHostTerminalOutcome | undefined {
    const id = singleActivityTerminalId(content)
    return acpSessionId === undefined || id === undefined
      ? undefined
      : this.facts.get(JSON.stringify([acpSessionId, id]))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
