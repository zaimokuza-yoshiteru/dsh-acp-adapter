/** Build-time registry catalog. No runtime network or host-platform assumptions. */

import { runtimeForCatalogId, type AcpAgentId } from '../../contract/agent-config.ts'
import registryJson from '../../../assets/registry/registry.json' with { type: 'json' }
import executablesJson from '../../../assets/registry/executables.json' with { type: 'json' }

// ---------- 快照形状（数据由 CI 生成并经 verify-registry-snapshot.mjs 校验后提交） ----------

interface RegistryAgent {
  readonly id: string
  readonly name: string
  readonly version?: string | undefined
  readonly website?: string | undefined
  readonly distribution?: {
    readonly npx?: { readonly package?: string | undefined; readonly args?: readonly string[] | undefined } | undefined
    readonly uvx?: { readonly package?: string | undefined; readonly args?: readonly string[] | undefined } | undefined
    readonly binary?: { readonly [platform: string]: { readonly archive?: string | undefined; readonly cmd?: string | undefined; readonly args?: readonly string[] | undefined } | undefined } | undefined
  } | undefined
}

interface ExecutableEntry {
  readonly kind: string
  readonly manualReason?: string
  readonly env: Readonly<Record<string, string>>
  readonly version: string
  readonly command: string
  readonly args: readonly string[]
}

/** registry.json 的 agents 数组（CI 已校验；这里收窄为最小只读面）。 */
const registryAgents = (registryJson as { readonly agents: readonly RegistryAgent[] }).agents

/** executables.json sidecar 的 entries（agent id → PATH 可执行名预填）。 */
const executableEntries = (executablesJson as { readonly entries: { readonly [id: string]: ExecutableEntry } }).entries

/** Display guidance absent from the registry, not launch configuration. */
const LOGIN_HINTS: Readonly<Record<AcpAgentId, string>> = {
  devin: 'devin auth login', codex: 'codex login', kimi: 'kimi login', claude: 'claude',
}

/** Known installed CLI names for binary distributions; never archive paths. */
const INSTALLED_BINARY_COMMANDS: Readonly<Record<string, string>> = { devin: 'devin', kimi: 'kimi' }

/** Curated adapter regression/live-smoke coverage, not certification of registry versions.
 * Keep this explicit: adding a runtime binding does not establish verification.
 */
const VERIFIED_ADAPTER_IDS: readonly string[] = ['devin', 'codex-acp', 'kimi', 'claude-acp']

// ---------- catalog 合成 ----------

/** One add-menu catalog entry: directory facts plus the PATH prefill it carries. */
export interface AcpCatalogEntry {
  /** Registry agent id (doubles as the seeded draft id; user-editable). */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Registry-published upstream version (sidecar double-checked; undefined when neither has it). */
  readonly version: string | undefined
  /** Install guidance derived from the registry distribution (npx/uvx/binary facts). */
  readonly installHint: string
  /** PATH executable name prefill; empty when the snapshot lacks this agent (manual entry remains). */
  readonly command: string
  /** Adapter verification scope is independent of the advertised registry version. */
  readonly verification: 'adapter-tested' | 'unverified'
  /** Prepend argv prefill (empty when unknown). */
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly requiresCommand: boolean
  /** Specialized runtime identity seeded only when adding this catalog entry. */
  readonly runtime?: AcpAgentId
  readonly loginHint?: string
}

/** npx/uvx 分发的安装指引（spawn 姿态不变：只做展示，不自动安装）。 */
function installHintOf(agent: RegistryAgent): string {
  const distribution = agent.distribution
  // Match the same distribution selected by the sidecar generator.
  if (distribution?.binary !== undefined) {
    return agent.website ?? Object.entries(distribution.binary)
      .map(([platform, entry]) => `${platform}: ${entry?.archive ?? ''}`).join('\n')
  }
  if (distribution?.npx !== undefined) return `npm install -g ${distribution.npx.package ?? agent.id}`
  if (distribution?.uvx !== undefined) return `uv tool install ${distribution.uvx.package ?? agent.id}`
  return agent.website ?? agent.id
}

/**
 * 全量 catalog：已验证适配条目排前，其余按 registry 顺序。合成是
 * 纯数据变换，模块加载时执行一次。
 */
export const ACP_CATALOG_ENTRIES: readonly AcpCatalogEntry[] = buildCatalogEntries(registryAgents, executableEntries)

export function buildCatalogEntries(registryAgents: readonly RegistryAgent[], executableEntries: Readonly<Record<string, ExecutableEntry>>): AcpCatalogEntry[] {
  const entries: AcpCatalogEntry[] = []
  for (const agent of registryAgents) {
    const executable = executableEntries[agent.id]
    const runtime = runtimeForCatalogId(agent.id)
    const command = executable?.kind === 'binary'
      ? INSTALLED_BINARY_COMMANDS[agent.id] ?? executable.command
      : executable?.command ?? ''
    const args = executable?.args ?? []
    entries.push({
      id: agent.id,
      name: agent.name,
      version: executable?.version ?? agent.version,
      installHint: installHintOf(agent),
      command,
      verification: VERIFIED_ADAPTER_IDS.includes(agent.id) ? 'adapter-tested' : 'unverified',
      args: [...args],
      env: { ...executable?.env },
      requiresCommand: command === '',
      ...(runtime === undefined ? {} : { runtime, loginHint: LOGIN_HINTS[runtime] }),
    })
  }
  entries.sort((left, right) => {
    const leftRank = VERIFIED_ADAPTER_IDS.indexOf(left.id)
    const rightRank = VERIFIED_ADAPTER_IDS.indexOf(right.id)
    return (leftRank < 0 ? VERIFIED_ADAPTER_IDS.length : leftRank) - (rightRank < 0 ? VERIFIED_ADAPTER_IDS.length : rightRank)
  })
  return entries
}

/** Look up one catalog entry by registry agent id (the add-menu rows are rendered from the list). */
export function catalogEntryOf(id: string): AcpCatalogEntry | undefined {
  return ACP_CATALOG_ENTRIES.find((entry) => entry.id === id)
}
