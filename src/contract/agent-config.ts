/** Browser-safe profile contract and identity rules. */
/**
 * Settings namespace storing the ACP agent list.
 * 数据命名空间，**不随 npm 包名改**（改名 @zaimokuza/dsh-acp-adapter 时有意保持
 * 'dsh-acp'）：改名会让既有用户的 settings 文档静默失联。sidecar 根目录同理
 * （src/persistence/sidecar.ts 的 dshHomePath('dsh-acp')）。
 */
export const ACP_SETTINGS_NS = 'dsh-acp-adapter'

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
  /** Login guidance shown when a probe fails with auth_required. */
  loginHint?: string
  /** Explicit specialized runtime; legacy built-in profile IDs remain a fallback.
   * Catalog metadata never grants runtime behavior. Unknown profiles use generic ACP.
   */
  runtime?: AcpAgentId
  /** Registry identity for display metadata only; never grants runtime behavior. */
  catalogId?: string
}

/** One ACP agent's stored configuration (the `dsh-acp` settings per-id value). */
export type AcpAgentConfig = AcpStubAgentConfig

// Runtime identities are shared; their trusted execution behavior stays host-side.

/** 正式产品范围的四个 ACP backend id。 */
export type AcpAgentId = 'devin' | 'codex' | 'kimi' | 'claude'

/** 全部合法 runtime 绑定值（settings schema 校验与身份解析共用同一词表）。 */
export const ACP_AGENT_IDS: readonly AcpAgentId[] = ['devin', 'codex', 'kimi', 'claude']


export const RUNTIME_REGISTRY_IDS: Readonly<Record<AcpAgentId, string>> = {
  devin: 'devin',
  codex: 'codex-acp',
  kimi: 'kimi',
  claude: 'claude-acp',
}

/** Explicit runtime binding wins; legacy built-in profile IDs remain supported. */
export function effectiveRuntimeOf(id: string, config?: { readonly runtime?: AcpAgentId }): AcpAgentId | undefined {
  return config?.runtime ?? (ACP_AGENT_IDS.includes(id as AcpAgentId) ? id as AcpAgentId : undefined)
}

/** Catalog metadata does not participate in execution identity. */
export function catalogIdOf(id: string, config: { readonly runtime?: AcpAgentId; readonly catalogId?: string }): string {
  const runtime = effectiveRuntimeOf(id, config)
  return config.catalogId ?? (runtime === undefined ? id : RUNTIME_REGISTRY_IDS[runtime])
}

/** Used only when creating a catalog preset; never infer runtime from saved catalogId. */
export function runtimeForCatalogId(id: string): AcpAgentId | undefined {
  return ACP_AGENT_IDS.find(runtime => RUNTIME_REGISTRY_IDS[runtime] === id)
}
