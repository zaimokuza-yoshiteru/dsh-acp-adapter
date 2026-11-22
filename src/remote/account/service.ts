import {
  accountUsageProvider,
  type AcpAccountProvider,
  type AcpAccountUsageView,
} from '../../contract/account-usage.ts'
import { acpProbeConfigKey, acpRouteId, type AcpAgentConfig } from '../../contract/agent-config.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import { readAccountCli } from './cli.ts'
import { readAntigravityAccount } from './antigravity.ts'
import { hasAccountFields } from './fields.ts'

const EMPTY = { checkedAt: null, plan: null, credits: null, windows: [] } as const
const UNSUPPORTED: AcpAccountUsageView = { ...EMPTY, provider: null, status: 'unsupported' }

interface AccountEntry {
  key: string
  value?: AcpAccountUsageView
  pending?: Promise<AcpAccountUsageView>
  stop: AbortController
}

/** One Host owner; account evidence stays in memory and is invalidated with its profile. */
export class AccountUsageService {
  private readonly entries = new Map<string, AccountEntry>()
  private closed = false
  private readonly inFlight = new Set<Promise<AcpAccountUsageView>>()
  constructor(
    private readonly subprocess: SubprocessSeamResolution,
    private readonly profiles: () => ReadonlyMap<string, AcpAgentConfig>,
    private readonly platform: string = process.platform,
    private readonly generations?: () => Readonly<Record<string, string>>,
  ) {}

  async read(id: string, refresh: boolean): Promise<AcpAccountUsageView> {
    const profiles = this.profiles()
    const generations = this.generations?.()
    const key = (agent: string, profile: AcpAgentConfig, versions = generations) =>
      versions?.[acpRouteId(agent)] ?? acpProbeConfigKey(profile)
    for (const [other, entry] of this.entries) {
      const config = profiles.get(other)
      if (!config || key(other, config) !== entry.key) {
        entry.stop.abort()
        this.entries.delete(other)
      }
    }
    const profile = profiles.get(id)
    if (!profile || this.closed) return UNSUPPORTED
    const provider = accountUsageProvider(id, profile, this.platform, process.env)
    if (!provider) return UNSUPPORTED
    if (!this.subprocess.ok || this.subprocess.seam.localExecution !== true) return { ...UNSUPPORTED, provider }
    const seam = this.subprocess.seam
    if (provider === 'antigravity' && (this.platform !== 'darwin' || !seam.spawnTerminal))
      return { ...UNSUPPORTED, provider }
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { key: key(id, profile), stop: new AbortController() }
      this.entries.set(id, entry)
    }
    if (entry.pending) return await entry.pending
    if (!refresh) {
      if (entry.value && Date.now() - (entry.value.checkedAt ?? 0) < 60_000) return entry.value
      if (provider === 'antigravity') return entry.value ?? { ...EMPTY, status: 'available', provider }
    }
    const settled = entry
    const operation = this.query(profile, provider, entry.stop.signal)
      .then((value) => {
        const current = this.profiles().get(id)
        if (settled.stop.signal.aborted || !current || key(id, current, this.generations?.()) !== settled.key)
          return UNSUPPORTED
        settled.value = value
        return value
      })
      .finally(() => {
        this.inFlight.delete(operation)
        delete settled.pending
      })
    this.inFlight.add(operation)
    entry.pending = operation
    return await operation
  }

  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) entry.stop.abort()
    await Promise.allSettled(this.inFlight)
  }

  private async query(
    profile: AcpAgentConfig,
    provider: AcpAccountProvider,
    lifetime: AbortSignal,
  ): Promise<AcpAccountUsageView> {
    if (!this.subprocess.ok) return UNSUPPORTED
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(provider === 'antigravity' ? 25_000 : 10_000)])
    try {
      const fields =
        provider === 'antigravity'
          ? await readAntigravityAccount(this.subprocess.seam, profile, signal)
          : await readAccountCli(this.subprocess.seam, profile, provider, signal)
      lifetime.throwIfAborted()
      if (fields.signInRequired) return { ...EMPTY, provider, status: 'signin-required', checkedAt: Date.now() }
      if (hasAccountFields(fields)) return { ...fields, provider, status: 'ready', checkedAt: Date.now() }
    } catch {
      // CLI diagnostics may include account identities or credentials. Return only the stable state.
    }
    return { ...EMPTY, provider, status: 'unavailable', checkedAt: Date.now() }
  }
}
