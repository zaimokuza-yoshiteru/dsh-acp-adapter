import type { Context } from '@deepseek-ai/cordis'
import { HostExecutionOwners } from './host-execution-owners.ts'
import { LocalSettlementOwner } from './local-settlement.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpHostContinuity: AcpHostContinuity
  }
}

export interface HostContinuityLease {
  close(): Promise<void>
}

/** Survives adapter replacement; the Host root owns its final shutdown. */
export class AcpHostContinuity {
  readonly executionOwners = new HostExecutionOwners()
  readonly settlements = new LocalSettlementOwner()
  private readonly leases = new Set<HostContinuityLease>()
  private closing: Promise<void> | undefined
  private accepting = true

  /** Retain the actual resource cleanup, including cleanup started outside Host shutdown. */
  borrow(closeRegistry: () => void | Promise<void>): HostContinuityLease {
    if (!this.accepting) throw new Error('ACP_HOST_CONTINUITY_CLOSED')
    let closing: Promise<void> | undefined
    const lease: HostContinuityLease = {
      close: () =>
        (closing ??= Promise.resolve()
          .then(closeRegistry)
          .finally(() => this.leases.delete(lease))),
    }
    this.leases.add(lease)
    return lease
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.accepting = false
    this.settlements.beginShutdown()
    return (this.closing = (async () => {
      const failures: unknown[] = []
      const registries = await Promise.allSettled([...this.leases].map((lease) => lease.close()))
      for (const result of registries) if (result.status === 'rejected') failures.push(result.reason)
      // Retired runtimes can publish their last settlement while calls finish.
      try {
        await this.executionOwners.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await this.settlements.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'ACP Host continuity cleanup failed')
    })())
  }
}

/** Use a named root service so Loader generations share the same explicit owner. */
export function ensureHostContinuity(ctx: Context): AcpHostContinuity {
  const root = ctx.root
  const existing = root.get('acpHostContinuity', false)
  if (existing !== undefined) return existing
  const owner = new AcpHostContinuity()
  root.effect(function* () {
    const withdraw = root.provide('acpHostContinuity', owner)
    yield withdraw
    yield root.effect(() => async () => {
      // Withdrawal can await consumers, so first drive and join their exact cleanup leases.
      // A failed cleanup must still withdraw the service; serial effects skip later work on rejection.
      try {
        await owner.close()
      } finally {
        await withdraw()
      }
    })
  })
  return owner
}
