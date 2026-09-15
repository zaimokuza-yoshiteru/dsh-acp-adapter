/**
 * Shared ACP profile data: settings shape, `acp-<id>` routes, built-in runtime
 * descriptors, and probe cache keys. This is a zero-import leaf so domain code
 * can consume profile facts without depending on host composition.
 * @module @zaimokuza/dsh-acp-adapter/domain/session/agent-config
 */

/**
 * Settings namespace storing the ACP agent list.
 * 数据命名空间，**不随 npm 包名改**（改名 @zaimokuza/dsh-acp-adapter 时有意保持
 * 'dsh-acp'）：改名会让既有用户的 settings 文档静默失联。sidecar 根目录同理
 * （src/persistence/sidecar.ts 的 dshHomePath('dsh-acp')）。
 */
export const ACP_SETTINGS_NS = 'dsh-acp'

/** LLM route id prefix; agent `<id>` routes as `acp-<id>`. */
export const ACP_ROUTE_PREFIX = 'acp-'

/**
 * Agent ids double as settings path segments, health-endpoint URL segments,
 * and route id suffixes — kept to the settings-namespace alphabet on purpose.
 */
export const ACP_AGENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Derive the LLM route id for one agent id. */
export function acpRouteId(agentId: string): string {
  return `${ACP_ROUTE_PREFIX}${agentId}`
}

/** Inverse of {@link acpRouteId}; undefined for non-ACP routes and the bare prefix. */
export function acpAgentIdFromRoute(provider: string): string | undefined {
  if (!provider.startsWith(ACP_ROUTE_PREFIX)) return undefined
  const id = provider.slice(ACP_ROUTE_PREFIX.length)
  return ACP_AGENT_ID_PATTERN.test(id) ? id : undefined
}

/**
 * Per-agent configuration the stub consumes. The registry
 * (src/host/composition/installed-profile-registry.ts) stores exactly this shape per agent id in
 * the `dsh-acp` settings namespace; declared in this leaf module so neither the
 * adapter nor its consumers import the registry for the datum.
 */
export interface AcpStubAgentConfig {
  /** Display name; the selector group label is `<name> · ACP`. */
  name: string
  /** Executable probed per catalog refresh. */
  command: string
  args: readonly string[]
  /** Agent environment from settings; native sessions preserve these values. */
  env: Record<string, string>
  /** Explicit native DSH tools exposed over MCP; absent means no additional tools. */
  hostTools?: readonly string[]
  /** Login guidance shown when a probe fails with auth_required. */
  loginHint?: string
  /**
 * 显式 runtime descriptor 绑定（边界）：值必须是 {@link AcpAgentId} 四者之一
   * （schema 强校验）。缺席时按 agent id 回退命中（id 恰好等于某 descriptor id）；
   * 两者都不命中 = 普通 profile，无 descriptor、无任何宿主 path/env ref——
   * descriptor 是内置受信数据，普通 profile 不能构造宿主 path/env ref。
   */
  runtime?: AcpAgentId
}

/** One ACP agent's stored configuration (the `dsh-acp` settings per-id value). */
export type AcpAgentConfig = AcpStubAgentConfig

// ---------- runtime descriptor（内置受信数据，host-only，不进 settings schema 自由面） ----------

/** 正式产品范围的四个 ACP backend id。 */
export type AcpAgentId = 'devin' | 'codex' | 'kimi' | 'claude'

/** 全部合法 runtime 绑定值（settings schema 校验与 descriptor 解析共用同一词表）。 */
export const ACP_AGENT_IDS: readonly AcpAgentId[] = ['devin', 'codex', 'kimi', 'claude']

/**
 * Agent runtime descriptor：一个 ACP backend 的完整数据面声明。
 * 内置受信数据——普通 profile 不能经 settings 构造宿主 path/env ref，只能经
 * `runtime` 字段或 id 回退**绑定**到这里的某一条。
 *
 * Native/full-access spawn and health probes use the Agent's existing home and
 * explicit env. Probes create only a temporary ACP session; they do not read,
 * copy, or stage credentials and clean up through protocol close/delete plus
 * connection teardown (best effort).
 * descriptor 的 command 必须是 PATH 上的
 * 已安装可执行名（用户自行安装明确版本），**绝不** `npx -y <pkg>@latest` 之类
 * 每次 spawn 下载代码的形态；上游版本参考已移交 registry 快照
 * （assets/registry，见 client/data/catalog.ts）。
 */
export interface AcpAgentRuntimeDescriptor {
  readonly id: AcpAgentId
  readonly command: string
  readonly args: readonly string[]
  /** 高级 CLI override env 键（边界：进 launch fingerprint 并跑独立兼容测试）。 */
  readonly executableOverrideEnv?: string
  /** probe 清理策略（边界）：临时 ACP session 尽力 close/delete，随后拆连接并清理临时 cwd。 */
  /** auth 失效时展示的登录指引（external-login-only：登录只发生在 agent 自家 CLI/env）。 */
  readonly loginHint?: string
}

/**
 * 四个内置 runtime descriptor。字段来自各 CLI 的本机探针，并由
 * test/unit/domain/installed-profile-registry.spec.ts 的契约测试逐字段锁定。
 */
export const ACP_AGENT_RUNTIME_DESCRIPTORS: readonly AcpAgentRuntimeDescriptor[] = [
  {
    id: 'devin',
    command: 'devin',
    args: ['acp'],
    loginHint: 'devin auth login',
  },
  {
    id: 'codex',
    command: 'codex-acp',
    args: [],
    loginHint: 'codex login',
  },
  {
    id: 'kimi',
    command: 'kimi',
    args: ['acp'],
    loginHint: 'kimi login',
  },
  {
    id: 'claude',
    command: 'claude-agent-acp',
    args: [],
    executableOverrideEnv: 'CLAUDE_CODE_EXECUTABLE',
    loginHint: 'claude',
  },
]

/**
 * profile → descriptor 解析（绑定规则）：`config.runtime` 显式绑定优先；
 * 缺席时 agent id 恰好等于某 descriptor id 则按 id 回退命中；普通 profile
 * （无 runtime 且 id 不匹配）→ undefined（无 descriptor、无任何 path/env ref）。
 */
export function descriptorOf(agentId: string, config?: { readonly runtime?: AcpAgentId }): AcpAgentRuntimeDescriptor | undefined {
  const bound = config?.runtime ?? (ACP_AGENT_IDS.includes(agentId as AcpAgentId) ? (agentId as AcpAgentId) : undefined)
  return ACP_AGENT_RUNTIME_DESCRIPTORS.find((descriptor) => descriptor.id === bound)
}

/**
 * 兼容状态词表（readiness 展示）：'current' = 握手版本与 registry 快照的
 * 上游版本一致；'outdated' = 不一致（不阻断，如实展示——registry 版本是
 * 目录参考，不是运行门）；'unknown' = 快照无该 agent 的版本事实。
 */
export type AcpVersionCompatibility = 'current' | 'outdated' | 'unknown'

/**
 * 内置 runtime 绑定 → registry agent id（descriptor id 与 registry id 不同名时
 * 的映射：codex → codex-acp、claude → claude-acp；devin/kimi 同名直查）。
 */
export const RUNTIME_REGISTRY_IDS: Readonly<Record<AcpAgentId, string>> = {
  devin: 'devin',
  codex: 'codex-acp',
  kimi: 'kimi',
  claude: 'claude-acp',
}

/**
 * 版本兼容状态派生（readiness 的纯函数核心；remote 层 probeRow 消费）：
 * 无版本参考（普通 profile，或快照无该 agent 的 version 事实）或对端握手
 * 未给出版本 → null / 'unknown'（无从判定，诚实空缺）；否则握手
 * `agentInfo.version`（trim 后）与 registry 参考版本精确比对：等 →
 * 'current'，不等 → 'outdated'。
 */
export function acpVersionCompatibility(
  referenceVersion: string | null | undefined,
  agentVersion: string | null | undefined,
): AcpVersionCompatibility | null {
  if (referenceVersion === undefined || referenceVersion === null || referenceVersion === '') return null
  if (agentVersion === undefined || agentVersion === null) return null
  return agentVersion.trim() === referenceVersion ? 'current' : 'outdated'
}

// ---------- probe 缓存键（launch 影响面） ----------
// （内置一键模板已随 catalog 化移除：add-menu 目录与预填由
// src/client/data/catalog.ts 从 registry 快照合成，runtime 绑定仍经
// ACP_AGENT_RUNTIME_DESCRIPTORS 受信闭集，见 descriptorOf。）

/**
 * Stable serialization of the probe-affecting config (command + args + env **键名
 * 集合** + `runtime` 绑定, env key-order normalized). The probe cache is keyed on it: a rename or a
 * loginHint edit must NOT re-probe, an env reorder must not either, and any real
 * change must. `runtime` 参与键：它决定 descriptor 绑定（边界），绑定变了
 * runtime 绑定变化会改变实际启动配置，probe 结果可能不同——必须重探。The hash is the
 * canonical JSON itself — no crypto needed for an in-memory cache key. Generic
 * parameter so a full {@link AcpStubAgentConfig} passes without tripping
 * excess-property checks.
 *
 * env 分量是 **secret-free 键名 + 值 hash**（排序固定）：env 值变化必须 bust
 * 缓存，避免凭证轮换后继续展示旧探测结果；明文值绝不进入 key。这函数同时服务 llm-stub
 * 缓存命中、五态新鲜度与创建门，三处消费同一口径。
 *
 * 自 src/host/composition/llm-stub.ts 下沉到本叶子：remote 层的 health
 * 新鲜度判定与 installed-profile registry 的会话创建门都要消费它，放 host
 * 组合层会造成不必要的跨层依赖。
 */
export function acpProbeConfigKey<C extends Pick<AcpStubAgentConfig, 'command' | 'args' | 'env'> & { readonly runtime?: AcpAgentId }>(config: C): string {
  const envKeys = Object.keys(config.env).sort()
  const envHashes = Object.entries(config.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, shortSecretHash(value)])
  return JSON.stringify({ command: config.command, args: config.args, envKeys, envHashes, runtime: config.runtime ?? null })
}

/** Deterministic short hash for cache identity; never returns the secret itself. */
function shortSecretHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * probe 缓存 TTL（固定策略）：成功条目 10 分钟、失败条目 30 秒
 * （负缓存短窗口——外部条件修复后无需等很久或重启；「重新检查」
 * （invalidateProbe）随时绕过 TTL）。
 */
export const ACP_PROBE_CACHE_OK_TTL_MS = 10 * 60_000
export const ACP_PROBE_CACHE_ERROR_TTL_MS = 30_000

/**
 * probe 缓存新鲜度判定（全仓唯一落点）：key 与当前配置的
 * {@link acpProbeConfigKey} 相等 **且** 未过期（按成功/失败取对应 TTL）。
 * llm-stub 的 listModels 命中过期条目按 miss 重 probe。设置页的最后一次
 * 明确检查状态不消费这个 TTL；它只在配置 key 改变时失效。
 * 结构参数化（只要 key/at/result.kind 三键），llm-stub 缓存条目与 remote 的
 * 结构面快照都直接适配。
 */
export function acpProbeFresh(
  entry: { readonly key: string; readonly at: number; readonly result: { readonly kind: 'ok' | 'error' } },
  key: string,
  now: number,
): boolean {
  if (entry.key !== key) return false
  const ttl = entry.result.kind === 'ok' ? ACP_PROBE_CACHE_OK_TTL_MS : ACP_PROBE_CACHE_ERROR_TTL_MS
  return now - entry.at < ttl
}

/** One agent resolved from an LLM route id ('s creation-time routing query). */
export interface AcpResolvedAgent {
  id: string
  config: AcpAgentConfig
}
