import os from 'node:os'
import path from 'node:path'
import { AcpSpawnPlanError } from '../policy/errors.ts'
import { acpMcpFingerprint, acpMcpServersOf } from './mcp.ts'
import type { AcpMcpServerConfig } from './mcp.ts'

/**
 * ACP provider 的配置 datum 与路由约定（分层：原 registry.ts / llm-stub.ts
 * 的纯数据部分下沉至此）。零 import 叶子模块——settings 文档形状
 * （{@link AcpStubAgentConfig} / {@link AcpAgentConfig}）、路由 id 约定
 * （`acp-<id>`）、路由解析结果（{@link AcpResolvedAgent}）、内置一键模板
 * （{@link ACP_BUILTIN_AGENT_TEMPLATES}）、runtime descriptor
 * （{@link ACP_AGENT_RUNTIME_DESCRIPTORS}，内置受信的 agent 数据面声明——
 * host-only，不进 settings schema）与 probe 缓存键（{@link acpProbeConfigKey}）
 * 供 host 注册表（src/host/composition/）、Remote service（src/remote/service.ts）
 * 与 domain 会话层（./agent.ts）共享；放最低层是为了让 domain 不向上 import host。
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
 * Conventional config-option id of the mode selector (devin uses it). Also the
 * ONLY key on which options-sync `applyLiveChange` falls back to the legacy
 * `set_mode` RPC — when the agent mirrors no mode config option but exposes
 * legacy modes state ( routing rule). Lives in this zero-import leaf so the
 * remote service (src/remote/service.ts) can share it without pulling
 * options-sync.ts (and its dsh-agent import chain) into the typert analysis
 * closure.
 */
export const ACP_MODE_OPTION_ID = 'mode'

/**
 * Per-agent configuration the stub consumes. The registry
 * (src/host/composition/registry.ts) stores exactly this shape per agent id in
 * the `dsh-acp` settings namespace; declared in this leaf module so neither the
 * adapter nor its consumers import the registry for the datum.
 */
export interface AcpStubAgentConfig {
  /** Display name; the selector group label is `<name> · ACP`. */
  name: string
  /** Executable probed per catalog refresh. */
  command: string
  args: readonly string[]
  /**
   * Agent 配置 env（settings 原文）。会话 spawn 与（confiner 在场时的）probe 经
   * src/domain/policy/sandbox.ts `buildAcpAgentEnv` 组装（白名单继承 + 字面值透传）；
 * 无 confiner 的 probe 路径原样透传（旧行为，测试用）。
   */
  env: Record<string, string>
  /** Explicit profile-owned MCP servers passed unchanged to ACP session/new/load. */
  mcpServers?: readonly AcpMcpServerConfig[]
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
 * 固定白名单 env 引用（边界）：从当前 DSH 进程环境按 **键名** 取值传给子进程。
 * 值绝不进 settings/sidecar/日志/指纹——descriptor 只声明键名与 secret 事实；
 * `optional` = 缺席不算配置错误（GUI 启动不继承 shell env 时按「缺失」如实显示）。
 */
export interface AcpAgentEnvRef {
  readonly sourceName: string
  readonly targetName: string
  readonly secret: boolean
  readonly optional: boolean
}

/**
 * opaque path ref（边界）：Agent 私有状态/凭证在宿主上的位置声明。正式会话
 * 直接使用 Agent 原生目录；健康探测把必要的单文件引用以
 * **symlink** 物化（零字节复制；机制与安全口径见 src/domain/policy/platform/staging.ts
 * 模块头注释）。`targetRelative` 是健康探测临时数据根下的
 * 相对路径；`optional: false` = 实证上缺它 auth 必败（仍按「缺失即诚实暴露」处理，
 * 不是 staging 硬错误——当前 staging 对缺失源 warn + 跳过）。
 */
export interface AcpAgentOpaqueRef {
  readonly source: string
  readonly targetRelative: string
  readonly kind: 'credential' | 'config'
  readonly optional: boolean
}

/**
 * 版本策略（边界）：已实证验收的钉版。字段缺席 = 不钉（devin 是既有 agent，
 * 现状不校验版本；kimi 的 ACP 面由 kimi CLI 自身承载，`acp` 是其子命令，
 * 故钉在 `wrappedCli`）。
 */
export interface AcpAgentVersionPolicy {
  readonly adapter?: string
  readonly wrappedCli?: string
}

/**
 * Agent runtime descriptor：一个 ACP backend 的完整数据面声明。
 * 内置受信数据——普通 profile 不能经 settings 构造宿主 path/env ref，只能经
 * `runtime` 字段或 id 回退**绑定**到这里的某一条。
 *
 * Native/full-access spawn uses the Agent's existing home and explicit env.
 * Every health probe uses its own disposable root; descriptor refs only make
 * the minimum login/config files visible inside that disposable probe.
 * descriptor 的 command 必须是 PATH 上的
 * 已安装可执行名（用户自行安装明确版本），**绝不** `npx -y <pkg>@latest` 之类
 * 每次 spawn 下载代码的形态；钉版见各条 `versionPolicy`。
 */
export interface AcpAgentRuntimeDescriptor {
  readonly id: AcpAgentId
  readonly command: string
  readonly args: readonly string[]
 /** 健康探测使用的临时数据根 env 键；正式 Native 会话不重定向该变量。 */
  readonly dataHomeEnv?: 'CODEX_HOME' | 'KIMI_CODE_HOME' | 'CLAUDE_CONFIG_DIR'
  readonly envRefs: readonly AcpAgentEnvRef[]
  readonly opaqueRefs: readonly AcpAgentOpaqueRef[]
 /** 高级 CLI override env 键（边界：进 launch fingerprint 并跑独立兼容测试）。 */
  readonly executableOverrideEnv?: string
  readonly versionPolicy: AcpAgentVersionPolicy
 /** probe 清理策略（边界）：协议清理尽力而为 + disposable 数据根必删（不依赖 agent delete 成功）。 */
  readonly probeCleanup: 'protocol-and-disposable-root'
  /** auth 失效时展示的登录指引（external-login-only：登录只发生在 agent 自家 CLI/env）。 */
  readonly loginHint?: string
}

/**
 * 四个内置 runtime descriptor。字段来自各 CLI 的本机无 prompt 探针，并由
 * test/unit/domain/registry.spec.ts 的契约测试逐字段锁定。
 */
export const ACP_AGENT_RUNTIME_DESCRIPTORS: readonly AcpAgentRuntimeDescriptor[] = [
  {
    id: 'devin',
    command: 'devin',
    args: ['acp'],
    envRefs: [],
    // 健康探测需要读取 Devin 登录态；正式会话直接读取原生位置。
    opaqueRefs: [
      { source: '~/.local/share/devin/credentials.toml', targetRelative: 'devin/credentials.toml', kind: 'credential', optional: false },
    ],
    // devin 不钉版本（既有 agent，现状无版本校验面）。
    versionPolicy: {},
    probeCleanup: 'protocol-and-disposable-root',
    loginHint: 'devin auth login',
  },
  {
    id: 'codex',
    command: 'codex-acp',
    args: [],
    dataHomeEnv: 'CODEX_HOME',
    envRefs: [],
    // 本机探针显示：无 auth.json 则 session/new
    // `Authentication required`；config.toml 非必需（缺省可用）。
    opaqueRefs: [
      { source: '~/.codex/auth.json', targetRelative: 'auth.json', kind: 'credential', optional: false },
      { source: '~/.codex/config.toml', targetRelative: 'config.toml', kind: 'config', optional: true },
    ],
    versionPolicy: { adapter: '1.6.2' },
    probeCleanup: 'protocol-and-disposable-root',
    loginHint: 'codex-acp cli login（或 codex login）',
  },
  {
    id: 'kimi',
    command: 'kimi',
    args: ['acp'],
    dataHomeEnv: 'KIMI_CODE_HOME',
    envRefs: [],
    //  的通用映射（`~/.kimi-code/credentials` 下 regular files）落地为本机
    // 实证的三条显式条目（本机无 prompt 探针 README 与 kimi-024409.json：
    // 无 credentials 则 auth 失败；三条齐备的 disposable KIMI_CODE_HOME 探针成功）。
    // config.toml 可能含 provider API key，只能作为 opaque ref 由 kimi 自己读取。
    opaqueRefs: [
      { source: '~/.kimi-code/config.toml', targetRelative: 'config.toml', kind: 'config', optional: false },
      { source: '~/.kimi-code/credentials/kimi-code.json', targetRelative: 'credentials/kimi-code.json', kind: 'credential', optional: false },
      { source: '~/.kimi-code/oauth/kimi-code', targetRelative: 'oauth/kimi-code', kind: 'credential', optional: false },
    ],
    // kimi 的 ACP 面是 kimi CLI 的 `acp` 子命令，adapter 即 wrapped CLI 本身。
    versionPolicy: { wrappedCli: '0.36.1' },
    probeCleanup: 'protocol-and-disposable-root',
    loginHint: 'kimi 登录（见 kimi CLI）',
  },
  {
    id: 'claude',
    command: 'claude-agent-acp',
    args: [],
    dataHomeEnv: 'CLAUDE_CONFIG_DIR',
    executableOverrideEnv: 'CLAUDE_CODE_EXECUTABLE',
    //  的固定白名单九条（全 optional；值只经键名从 DSH 进程环境取值，
    // secret 标记的键名在任何展示面只报 present/missing）。
    envRefs: [
      { sourceName: 'ANTHROPIC_API_KEY', targetName: 'ANTHROPIC_API_KEY', secret: true, optional: true },
      { sourceName: 'ANTHROPIC_AUTH_TOKEN', targetName: 'ANTHROPIC_AUTH_TOKEN', secret: true, optional: true },
      { sourceName: 'ANTHROPIC_BASE_URL', targetName: 'ANTHROPIC_BASE_URL', secret: false, optional: true },
      { sourceName: 'ANTHROPIC_MODEL', targetName: 'ANTHROPIC_MODEL', secret: false, optional: true },
      { sourceName: 'ANTHROPIC_DEFAULT_OPUS_MODEL', targetName: 'ANTHROPIC_DEFAULT_OPUS_MODEL', secret: false, optional: true },
      { sourceName: 'ANTHROPIC_DEFAULT_SONNET_MODEL', targetName: 'ANTHROPIC_DEFAULT_SONNET_MODEL', secret: false, optional: true },
      { sourceName: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', targetName: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', secret: false, optional: true },
      { sourceName: 'CLAUDE_CODE_SUBAGENT_MODEL', targetName: 'CLAUDE_CODE_SUBAGENT_MODEL', secret: false, optional: true },
      { sourceName: 'CLAUDE_CODE_EFFORT_LEVEL', targetName: 'CLAUDE_CODE_EFFORT_LEVEL', secret: false, optional: true },
    ],
    // Claude 走 env/keychain 认证；keychain 路径未验收，不声明 opaqueRefs。
    opaqueRefs: [],
    versionPolicy: { adapter: '0.70.0' },
    probeCleanup: 'protocol-and-disposable-root',
    loginHint: 'claude（外部登录，或经 ANTHROPIC_* 环境变量提供路由）',
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
 * 健康探测兼容面使用的 opaque ref 源清单。仅无 `dataHomeEnv` 的 descriptor
 * （目前是 Devin）返回 XDG 语义下的源；Codex、Kimi、Claude 由探测器直接把
 * refs 物化到各自的 disposable data home。正式 Native 会话不消费本函数。
 */
export function descriptorStagingSourcesOf(
  descriptor: AcpAgentRuntimeDescriptor | undefined,
  environment?: Readonly<Record<string, string | undefined>>,
): readonly string[] | undefined {
  if (descriptor === undefined || descriptor.dataHomeEnv !== undefined || descriptor.opaqueRefs.length === 0) return undefined
  const refs = descriptorOpaqueRefsForEnvironment(descriptor, environment ?? {})
  return refs?.map((ref) => ref.source)
}

/**
 * 五态派生输入（./agent-state.ts 的 `declaresAuthRefs`）：该 profile 绑定的
 * descriptor 是否声明了非空 opaqueRefs/envRefs（口径；devin 经
 * opaqueRefs 命中，claude 经 envRefs 命中）。
 */
export function descriptorDeclaresAuthRefs(descriptor: AcpAgentRuntimeDescriptor | undefined): boolean {
  return descriptor !== undefined && (descriptor.opaqueRefs.length > 0 || descriptor.envRefs.length > 0)
}

/**
 * descriptor envRefs 的取值面（spawn/probe 注入与 指纹共用同一
 * 组装路径）：按声明的键名从 `source`（调用方传 `process.env`，参数化保证本模块
 * 零 import）取出在场的值，产出 `targetName → value` 映射。缺席/空值一律跳过
 * （`optional: false` 的缺席由 agent 自己 fail 或上层 warn——本函数只做取值）。
 * 值从此映射直接进入 spawn 计划的 env，绝不进 settings/sidecar/日志/指纹。
 */
export function descriptorEnvRefValues(
  descriptor: AcpAgentRuntimeDescriptor,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const ref of descriptor.envRefs) {
    const value = source[ref.sourceName]
    if (value !== undefined && value !== '') values[ref.targetName] = value
  }
  return values
}

const DESCRIPTOR_NATIVE_ROOT_ENV: Partial<Record<AcpAgentId, string>> = {
  devin: 'XDG_DATA_HOME',
  codex: 'CODEX_HOME',
  kimi: 'KIMI_CODE_HOME',
  claude: 'CLAUDE_CONFIG_DIR',
}

const DESCRIPTOR_DEFAULT_ROOT: Partial<Record<AcpAgentId, string>> = {
  devin: '~/.local/share',
  codex: '~/.codex',
  kimi: '~/.kimi-code',
  claude: '~/.claude',
}

/**
 * Resolve built-in opaque refs against an explicitly selected native Agent
 * state root. The returned refs still point at host paths and are only used
 * for path-only symlink staging; no file bytes are read by this adapter.
 * Missing selectors retain the descriptor's default `~` source. Explicit
 * selectors must be absolute so a typo cannot silently fall back to a user's
 * default home.
 */
export function descriptorOpaqueRefsForEnvironment(
  descriptor: AcpAgentRuntimeDescriptor | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  homeDir = os.homedir(),
): readonly AcpAgentOpaqueRef[] | undefined {
  if (descriptor === undefined || descriptor.opaqueRefs.length === 0) return descriptor?.opaqueRefs
  const envKey = DESCRIPTOR_NATIVE_ROOT_ENV[descriptor.id]
  const defaultRoot = DESCRIPTOR_DEFAULT_ROOT[descriptor.id]
  if (envKey === undefined || defaultRoot === undefined) return descriptor.opaqueRefs
  const configuredHome = environment.HOME
  const effectiveHome = configuredHome === undefined || configuredHome === '' ? homeDir : configuredHome
  if (!path.isAbsolute(effectiveHome)) {
    throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', 'HOME must be an absolute path when selecting an Agent native state root')
  }
  const selectedRoot = environment[envKey]
  if (selectedRoot !== undefined && selectedRoot !== '' && !path.isAbsolute(selectedRoot)) {
    throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', `${envKey} must be an absolute path when selecting an Agent state root`)
  }
  const resolveSources = (selectedRoot !== undefined && selectedRoot !== '') || effectiveHome !== path.normalize(homeDir)
  if (!resolveSources) return descriptor.opaqueRefs
  const expandedDefault = path.normalize(path.join(effectiveHome, defaultRoot.slice(2)))
  const normalizedSelected = path.normalize(selectedRoot === undefined || selectedRoot === '' ? expandedDefault : selectedRoot)
  return descriptor.opaqueRefs.map((ref) => {
    const expandedSource = ref.source === '~'
      ? effectiveHome
      : ref.source.startsWith('~/') ? path.join(effectiveHome, ref.source.slice(2)) : ref.source
    const normalizedSource = path.normalize(expandedSource)
    if (normalizedSource !== expandedDefault && !normalizedSource.startsWith(`${expandedDefault}${path.sep}`)) {
      throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', `${descriptor.id} opaque ref is outside its declared native state root`)
    }
    return {
      ...ref,
      source: path.join(normalizedSelected, path.relative(expandedDefault, normalizedSource)),
    }
  })
}

/**
 * 兼容状态词表（readiness 展示）：'pinned' = 握手版本等于 descriptor 钉版；
 * 'drifted' = 不等（不阻断，如实展示——钉版是验收事实，不是运行门）；'unpinned' =
 * descriptor 无钉版（devin：既有 agent，现状不校验版本）。
 */
export type AcpVersionCompatibility = 'pinned' | 'drifted' | 'unpinned'

/**
 * 版本兼容状态派生（readiness 的纯函数核心；remote 层 probeRow 消费）：
 * 无 descriptor（普通 profile）或对端握手未给出版本 → null（无从判定，诚实
 * 空缺）；descriptor 无钉版 → 'unpinned'；否则握手 `agentInfo.version`（trim 后）
 * 与钉版（adapter 优先——kimi 的 ACP 面由 wrapped CLI 自身承载，钉在
 * wrappedCli）精确比对：等 → 'pinned'，不等 → 'drifted'。
 */
export function acpVersionCompatibility(
  descriptor: AcpAgentRuntimeDescriptor | undefined,
  agentVersion: string | null | undefined,
): AcpVersionCompatibility | null {
  if (descriptor === undefined) return null
  if (agentVersion === undefined || agentVersion === null) return null
  const pin = descriptor.versionPolicy.adapter ?? descriptor.versionPolicy.wrappedCli
  if (pin === undefined) return 'unpinned'
  return agentVersion.trim() === pin ? 'pinned' : 'drifted'
}

// ---------- 内置一键模板（模板只留 settings 部分，数据面归 descriptor） ----------

/**
 * 内置一键模板的形状：完整 settings 配置 + 模板注册的 agent id。
 * host-only 的 auth 路径/环境声明不再挂在模板上——它们收进
 * {@link ACP_AGENT_RUNTIME_DESCRIPTORS}（内置受信数据，按 `runtime` 字段或
 * agent id 回退绑定，见 {@link descriptorOf}）；用户不可经 settings 声明任意
 * 路径映射（防「把任意宿主文件铺进沙箱」的自由面）。
 */
export interface AcpBuiltinAgentTemplate extends AcpStubAgentConfig {
  /** 模板注册的 agent id（一键添加预填值，用户可改；descriptor 按 `runtime`/最终 id 绑定）。 */
  readonly id: string
}

/**
 * Built-in one-click template for the ACP panel (consumes it)。
 * 认证数据面（实证：devin 在进程启动期经 XDG_DATA_HOME 读
 * `<data>/devin/credentials.toml`，凭证只读不写、无独立凭证路径 flag）由 id 同名
 * 的 devin descriptor 声明（见 {@link ACP_AGENT_RUNTIME_DESCRIPTORS}）；confined
 * 两档不引用该文件则 probe 模型目录为空、prompt 抛 ACP_AUTH_REQUIRED。机制与
 * 安全口径见 src/domain/policy/sandbox.ts 模块头注释。
 */
export const DEVIN_ACP_TEMPLATE: AcpBuiltinAgentTemplate = {
  id: 'devin',
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  env: {},
  loginHint: 'devin auth login',
 // （内置 runtime 唯一性）：四个内置模板全部显式声明稳定 runtime——devin 此前靠
  // descriptorOf 的 id 回退命中，现与其余三者同形态（id 可改、绑定不漂移）。
  runtime: 'devin',
}

/**
 * 通用 Claude 预设：不假设推理提供方——Claude CLI 实际路由到
 * Anthropic 订阅或其他 env-backed 网关属于下游配置，不是本插件的模型身份
 * 判断范围；env 不预填。backend 身份即 `acp-claude`（用户可改 id，
 * runtime 绑定不变）。
 */
export const CLAUDE_ACP_TEMPLATE: AcpBuiltinAgentTemplate = {
  id: 'claude',
  name: 'Claude',
  command: 'claude-agent-acp',
  args: [],
  env: {},
  loginHint: 'claude 外部登录，或经 ANTHROPIC_* 环境变量配置路由（external-login-only）',
  runtime: 'claude',
}

/**
 * Codex 预设：command 即 descriptor 钉版的 `codex-acp`（versionPolicy
 * adapter 1.6.2），env 不预填（认证走 descriptor opaqueRefs 的
 * `~/.codex/auth.json` symlink 物化，external-login-only）。
 */
export const CODEX_ACP_TEMPLATE: AcpBuiltinAgentTemplate = {
  id: 'codex',
  name: 'Codex',
  command: 'codex-acp',
  args: [],
  env: {},
  loginHint: 'codex-acp cli login（或 codex login）',
  runtime: 'codex',
}

/**
 * Kimi 预设：command 即 descriptor 钉版的 `kimi` + `acp` 子命令
 * （versionPolicy wrappedCli 0.36.1），env 不预填（认证走 descriptor opaqueRefs 的
 * `~/.kimi-code` config.toml/credentials/oauth 三件套 symlink 物化，
 * external-login-only）。loginHint 使用 Kimi CLI 自己的 `kimi login` 流程，
 * 插件不接管登录凭证。
 */
export const KIMI_ACP_TEMPLATE: AcpBuiltinAgentTemplate = {
  id: 'kimi',
  name: 'Kimi',
  command: 'kimi',
  args: ['acp'],
  env: {},
  loginHint: 'kimi login',
  runtime: 'kimi',
}

/**
 * 全部内置模板。模板只声明可执行文件、参数和受信 runtime descriptor；实际可用性
 * 仍由用户本机的 CLI 登录状态、版本和 ACP probe 决定。
 */
export const ACP_BUILTIN_AGENT_TEMPLATES: readonly AcpBuiltinAgentTemplate[] = [
  DEVIN_ACP_TEMPLATE,
  CLAUDE_ACP_TEMPLATE,
  CODEX_ACP_TEMPLATE,
  KIMI_ACP_TEMPLATE,
]

/**
 * Stable serialization of the probe-affecting config (command + args + env **键名
 * 集合** + `runtime` 绑定, env key-order normalized). The probe cache is keyed on it: a rename or a
 * loginHint edit must NOT re-probe, an env reorder must not either, and any real
 * change must. `runtime` 参与键：它决定 descriptor 绑定（边界），绑定变了
 * staging 的 opaque ref 集合就变，probe 结果可能不同——必须重探。The hash is the
 * canonical JSON itself — no crypto needed for an in-memory cache key. Generic
 * parameter so a full {@link AcpStubAgentConfig} passes without tripping
 * excess-property checks.
 *
 * env 分量是 **secret-free 键名集合**（排序后只带键名，不带值）：env 值
 * 变化不再 bust 缓存——新鲜度由 TTL 兜底（{@link acpProbeFresh}；面板「重新检查」
 * 随时可强制重探），换取键本身绝不含任何配置值（值可能是 token 类 secret，
 * 而键会进日志/诊断上下文）；env 键的增删仍然 bust。这函数同时服务 llm-stub
 * 缓存命中、五态新鲜度与创建门，三处消费同一口径。
 *
 * 自 src/host/composition/llm-stub.ts 下沉到本叶子：remote 层（health 的
 * 五态派生新鲜度判定）与 hostFactory 层（会话创建门）都要消费它，放 host
 * 组合层会把它们拖进 host import（分层守卫禁止）。
 */
export function acpProbeConfigKey<C extends Pick<AcpStubAgentConfig, 'command' | 'args' | 'env'> & { readonly runtime?: AcpAgentId; readonly mcpServers?: readonly AcpMcpServerConfig[] }>(config: C): string {
  const envKeys = Object.keys(config.env).sort()
  const mcpServers = acpMcpServersOf(config.mcpServers)
  return JSON.stringify({ command: config.command, args: config.args, envKeys, runtime: config.runtime ?? null, mcpFingerprint: acpMcpFingerprint(mcpServers) })
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
 * 过期条目按「从未探测」计——llm-stub 的 listModels 命中过期条目按 miss 重
 * probe；health 五态与创建门（src/remote/service.ts、
 * src/host/factory/agent-loop.ts）把过期条目折成 saved-unverified/补 probe。
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
 // 不再随解析结果携带 auth 引用清单：descriptor 是内置受信数据，
  // 各消费方（spawn/probe confiner/五态派生）经 descriptorOf(id, config) 现取。
}

// ---------- 配置改动 diff（审计摘要的纯函数核心） ----------

/**
 * 一个 agent 条目的配置改动描述（审计摘要的真源；src/host/composition/registry.ts
 * 在 settings watch 里计算，再经 src/domain/policy/events.ts 包成 sidecar
 * `agent-config` 条目）。**密钥纪律** env 只携带键名级 diff，值绝不出现在
 * 本结构里（`envChanged` 只回答「这个键的值变了」，不回答「变成了什么」）。
 */
export interface AcpAgentConfigChange {
  readonly change: 'added' | 'removed' | 'changed'
  readonly agentId: string
  /** 改动涉及的字段名（排序固定输出）。 */
  readonly changedFields: readonly string[]
  /** command 变更（或 added 时的初始值）。 */
  readonly command?: string
  /** args 变更（或 added 时的初始值）。 */
  readonly args?: readonly string[]
  /** env 键名级 diff（值永不出现）。 */
  readonly env?: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
}

function stringArrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** 两个 env 映射的键名级 diff（added/removed/changed 三桶，各自排序固定）。 */
function diffEnvKeys(
  prev: Record<string, string>,
  next: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const key of Object.keys(next)) {
    if (!(key in prev)) added.push(key)
    else if (prev[key] !== next[key]) changed.push(key)
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) removed.push(key)
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

/** 单条目 diff（added/removed/changed 三分）；无改动返回 undefined。 */
function diffOneAgentConfig(agentId: string, prev: AcpAgentConfig | undefined, next: AcpAgentConfig | undefined): AcpAgentConfigChange | undefined {
  if (prev === undefined && next === undefined) return undefined
  if (prev === undefined && next !== undefined) {
    const fields = ['name', 'command', 'args', ...(Object.keys(next.env).length > 0 ? ['env'] : []), ...(next.mcpServers !== undefined && next.mcpServers.length > 0 ? ['mcpServers'] : []),
      ...(next.loginHint === undefined ? [] : ['loginHint']), ...(next.runtime === undefined ? [] : ['runtime'])]
    const env = diffEnvKeys({}, next.env)
    return {
      change: 'added',
      agentId,
      changedFields: fields.sort(),
      command: next.command,
      args: [...next.args],
      ...(Object.keys(next.env).length > 0 ? { env: { added: env.added, removed: [], changed: [] } } : {}),
    }
  }
  if (next === undefined && prev !== undefined) {
    const fields = ['name', 'command', 'args', ...(Object.keys(prev.env).length > 0 ? ['env'] : []), ...(prev.mcpServers !== undefined && prev.mcpServers.length > 0 ? ['mcpServers'] : []),
      ...(prev.loginHint === undefined ? [] : ['loginHint']), ...(prev.runtime === undefined ? [] : ['runtime'])]
    const env = diffEnvKeys(prev.env, {})
    return {
      change: 'removed',
      agentId,
      changedFields: fields.sort(),
      ...(Object.keys(prev.env).length > 0 ? { env: { added: [], removed: env.removed, changed: [] } } : {}),
    }
  }
  const current = next as AcpAgentConfig
  const before = prev as AcpAgentConfig
  const fields = new Set<string>()
  let command: string | undefined
  let args: readonly string[] | undefined
  if (before.name !== current.name) fields.add('name')
  if (before.command !== current.command) {
    fields.add('command')
    command = current.command
  }
  if (!stringArrayEquals(before.args, current.args)) {
    fields.add('args')
    args = [...current.args]
  }
  if ((before.loginHint ?? undefined) !== (current.loginHint ?? undefined)) fields.add('loginHint')
  if ((before.runtime ?? undefined) !== (current.runtime ?? undefined)) fields.add('runtime')
  if (JSON.stringify(before.mcpServers ?? []) !== JSON.stringify(current.mcpServers ?? [])) fields.add('mcpServers')
  const env = diffEnvKeys(before.env, current.env)
  const envTouched = env.added.length > 0 || env.removed.length > 0 || env.changed.length > 0
  if (envTouched) fields.add('env')
  if (fields.size === 0) return undefined
  return {
    change: 'changed',
    agentId,
    changedFields: [...fields].sort(),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(envTouched ? { env } : {}),
  }
}

/**
 * 全量 agents 映射 diff（settings watch 的 prev/next → 逐条目改动清单）。
 * 输出按 agentId 排序固定（审计序列可复现）。初始加载（prev = 空映射的首次
 * watch）同样产出 added 条目——调用方（registry）自行决定是否跳过首帧。
 */
export function diffAcpAgentConfigs(
  prev: Record<string, AcpAgentConfig>,
  next: Record<string, AcpAgentConfig>,
): AcpAgentConfigChange[] {
  const ids = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort((left, right) => left.localeCompare(right))
  const changes: AcpAgentConfigChange[] = []
  for (const id of ids) {
    const change = diffOneAgentConfig(id, prev[id], next[id])
    if (change !== undefined) changes.push(change)
  }
  return changes
}
