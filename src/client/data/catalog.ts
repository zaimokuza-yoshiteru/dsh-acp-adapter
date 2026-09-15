/**
 * ACP agent catalog (client-side view of the committed registry snapshot).
 *
 * 数据源是 CI daily 同步进仓库的纯数据快照（assets/registry/*.json，见
 * scripts/enrich-registry-executables.mjs 与 .github/workflows/registry-sync.yml）：
 * registry.json 给目录与上游版本，executables.json sidecar 给「用户本机
 * PATH 可执行名 + 参数」的预填。构建期内嵌（resolveJsonModule 值导入），
 * 零运行时网络——这与 settings 面板的手写字面量副本（如 ACP_AGENT_RUNTIME_IDS）
 * 同形态：纯数据、无 host 代码依赖、browser 安全；边界 5（client 禁 import
 * host 模块）不受影响。快照新鲜度以发版为界（评审结论：在线新鲜度不重要）。
 * @module @zaimokuza/dsh-acp-adapter/client/catalog
 */

import registryJson from '../../../assets/registry/registry.json' with { type: 'json' }
import executablesJson from '../../../assets/registry/executables.json' with { type: 'json' }

// ---------- 快照形状（数据由 CI 生成并经 verify-registry-snapshot.mjs 校验后提交） ----------

interface RegistryAgent {
  readonly id: string
  readonly name: string
  readonly version?: string | undefined
  readonly description?: string | undefined
  readonly website?: string | undefined
  readonly distribution?: {
    readonly npx?: { readonly package?: string | undefined; readonly args?: readonly string[] | undefined } | undefined
    readonly uvx?: { readonly package?: string | undefined; readonly args?: readonly string[] | undefined } | undefined
    readonly binary?: { readonly [platform: string]: { readonly cmd?: string | undefined; readonly args?: readonly string[] | undefined } | undefined } | undefined
  } | undefined
}

interface ExecutableEntry {
  readonly version: string
  readonly command: string
  readonly args: readonly string[]
}

/** registry.json 的 agents 数组（CI 已校验；这里收窄为最小只读面）。 */
const registryAgents = (registryJson as { readonly agents: readonly RegistryAgent[] }).agents

/** executables.json sidecar 的 entries（agent id → PATH 可执行名预填）。 */
const executableEntries = (executablesJson as { readonly entries: { readonly [id: string]: ExecutableEntry } }).entries

// ---------- 内置 runtime 覆盖（受信闭集的字面量副本；真源 host 侧 ACP_AGENT_RUNTIME_DESCRIPTORS） ----------

/**
 * 四个内置 runtime 的 catalog 覆盖：registry 条目只有目录数据，runtime
 * 绑定（host 侧 executableOverrideEnv 等受信事实）不进 registry——这里
 * 按各 CLI 本机探针的字面量钉住 command/args/loginHint（键为 registry
 * agent id）。与 host 侧 descriptor 的逐字段一致性由
 * test/unit/client/client-logic.spec.ts 钉版（id+version 与 sidecar 对齐）。
 */
const RUNTIME_OVERRIDES: Readonly<Record<'devin' | 'codex-acp' | 'kimi' | 'claude-acp', {
  readonly command: string
  readonly args: readonly string[]
  readonly loginHint: string
  readonly runtime: 'devin' | 'codex' | 'kimi' | 'claude'
}>> = {
  devin: { command: 'devin', args: ['acp'], loginHint: 'devin auth login', runtime: 'devin' },
  'codex-acp': { command: 'codex-acp', args: [], loginHint: 'codex login', runtime: 'codex' },
  kimi: { command: 'kimi', args: ['acp'], loginHint: 'kimi login', runtime: 'kimi' },
  'claude-acp': { command: 'claude-agent-acp', args: [], loginHint: 'claude', runtime: 'claude' },
}

/** override 条目排在目录最前（一键区优先展示内置 runtime 四条）。 */
const OVERRIDE_ORDER: readonly ('devin' | 'codex-acp' | 'kimi' | 'claude-acp')[] = ['devin', 'codex-acp', 'kimi', 'claude-acp']

// ---------- catalog 合成 ----------

/** One add-menu catalog entry: directory facts plus the PATH prefill it carries. */
export interface AcpCatalogEntry {
  /** Registry agent id (doubles as the seeded draft id; user-editable). */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Registry-published upstream version (sidecar double-checked; undefined when neither has it). */
  readonly version: string | undefined
  /** One-line directory description (menu rows do not render it; kept for future detail views). */
  readonly description: string | undefined
  /** Install guidance derived from the registry distribution (npx/uvx/binary facts). */
  readonly installHint: string
  /** PATH executable name prefill; empty when the snapshot lacks this agent (manual entry remains). */
  readonly command: string
  /** Prepend argv prefill (empty when unknown). */
  readonly args: readonly string[]
  /**
   * Built-in runtime binding seeded into the draft (devin/codex/kimi/claude-acp
   * 四条 override；真源 host 侧 ACP_AGENT_RUNTIME_DESCRIPTORS——普通条目无
   * runtime，无任何宿主 path/env ref）。
   */
  readonly runtime?: 'devin' | 'codex' | 'kimi' | 'claude'
}

/** npx/uvx 分发的安装指引（spawn 姿态不变：只做展示，不自动安装）。 */
function installHintOf(agent: RegistryAgent): string {
  const distribution = agent.distribution
  if (distribution?.npx !== undefined) return `npm install -g ${distribution.npx.package ?? agent.id}`
  if (distribution?.uvx !== undefined) return `uv tool install ${distribution.uvx.package ?? agent.id}`
  const binary = distribution?.binary
  const anyPlatform = binary === undefined ? undefined : Object.values(binary).find((entry) => entry?.cmd !== undefined)
  if (anyPlatform?.cmd !== undefined) return anyPlatform.cmd
  return agent.website ?? agent.id
}

/**
 * 全量 catalog（41 条）：override 四条排前，其余按 registry 顺序。合成是
 * 纯数据变换，模块加载时执行一次。
 */
export const ACP_CATALOG_ENTRIES: readonly AcpCatalogEntry[] = synthesize()

function synthesize(): AcpCatalogEntry[] {
  const entries: AcpCatalogEntry[] = []
  for (const agent of registryAgents) {
    const executable = executableEntries[agent.id]
    const override = RUNTIME_OVERRIDES[agent.id as keyof typeof RUNTIME_OVERRIDES]
    const command = override?.command ?? executable?.command ?? ''
    const args = override?.args ?? executable?.args ?? []
    entries.push({
      id: agent.id,
      name: agent.name,
      version: executable?.version ?? agent.version,
      description: agent.description,
      installHint: installHintOf(agent),
      command,
      args: [...args],
      ...(override?.runtime === undefined ? {} : { runtime: override.runtime }),
    })
  }
  entries.sort((left, right) => {
    const leftRank = OVERRIDE_ORDER.indexOf(left.id as keyof typeof RUNTIME_OVERRIDES)
    const rightRank = OVERRIDE_ORDER.indexOf(right.id as keyof typeof RUNTIME_OVERRIDES)
    return (leftRank < 0 ? OVERRIDE_ORDER.length : leftRank) - (rightRank < 0 ? OVERRIDE_ORDER.length : rightRank)
  })
  return entries
}

/** Look up one catalog entry by registry agent id (the add-menu rows are rendered from the list). */
export function catalogEntryOf(id: string): AcpCatalogEntry | undefined {
  return ACP_CATALOG_ENTRIES.find((entry) => entry.id === id)
}
