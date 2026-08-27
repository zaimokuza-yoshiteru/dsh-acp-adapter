/**
 * Pure logic for the ACP settings panel (release contract , ).
 *
 * No DOM, fetch, or React imports: every export here is directly
 * vitest-testable without jsdom ( drives this module). The wire and
 * settings shapes are CLIENT-SIDE COPIES of the host-half contracts
 * (src/host/composition/installed-profile-registry.ts, src/contract/remote.ts, and ACP schema v1 for AuthMethod) — the
 * client bundle must not import host modules: they target Node, and a value
 * import would be inlined into the browser bundle.
 * @module @zaimokuza/dsh-acp-adapter/client/logic
 */

// ---------- settings shape（镜像 src/host/composition/installed-profile-registry.ts；禁止 import host src） ----------

/** One ACP agent's stored configuration (the `dsh-acp` settings per-id value). */
export interface AcpAgentConfig {
  /** Display name. */
  name: string
  /** Executable probed per catalog refresh. */
  command: string
  /** Structured argv tail. */
  args: readonly string[]
 /** Env entries (literal values only; 不再有 `$credential:` 引用语法). */
  env: Record<string, string>
  /** Login guidance shown with the agent's auth row. */
  loginHint?: string
  /**
 * 显式 runtime descriptor 绑定（边界；真源 src/domain/session/agent-config.ts
   * 的 `runtime` 字段）。面板编辑器不暴露本字段（高级设置，经 settings 文档
   * 手写）；解码收下它、编辑存量 agent 时原样过站（见 {@link AgentDraft.runtime}），
   * 避免面板保存静默解除绑定。
   */
  runtime?: AcpAgentRuntimeId
}

/** runtime descriptor 绑定词表（镜像 host 侧 `AcpAgentId`；边界）。 */
export type AcpAgentRuntimeId = 'devin' | 'codex' | 'kimi' | 'claude'

/** 全部合法 runtime 绑定值（decode 校验用；与 host 侧 `ACP_AGENT_IDS` 同序）。 */
export const ACP_AGENT_RUNTIME_IDS: readonly AcpAgentRuntimeId[] = ['devin', 'codex', 'kimi', 'claude']

/** Resolved `dsh-acp` settings section. */
export interface AcpSettings {
  agents: Record<string, AcpAgentConfig>
}

/** Settings namespace storing the ACP agent list. */
export const ACP_SETTINGS_NS = 'dsh-acp'

/**
 * Agent ids double as settings path segments, health-endpoint URL segments,
 * and route id suffixes — kept to the settings-namespace alphabet on purpose.
 */
export const ACP_AGENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Env var name: POSIX shell identifier. */
export const ACP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 疑似 secret 的 env 键名 pattern（client 侧镜像 host
 * src/runtime/process/subprocess.ts 的 `ACP_SENSITIVE_ENV_PATTERN`——client
 * 半禁 import host 模块，口径注释同步）。命中的键在编辑器里**不回显值**，只按
 * 键名 + 「已配置」状态展示；原值经草稿的 `maskedEnv` 携带过站（保存时原样
 * 挂回，除非用户在文本框里同名重填或在掩码行上点移除）。
 */
export const ACP_SECRET_ENV_KEY_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * One-click template for the "添加 Devin" button. Client-side copy of the host
 * template's SETTINGS portion（真源 src/domain/session/agent-config.ts
 * DEVIN_ACP_TEMPLATE；client 半禁止 import host 模块）。认证数据面
 * （opaque/env refs）收进 host 侧 runtime descriptor（内置受信数据，按
 * `runtime`/agent id 绑定、不进 settings 文档），本副本不携带。
 */
export const DEVIN_ACP_TEMPLATE: AcpAgentConfig & { id: string } = {
  id: 'devin',
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  env: {},
  loginHint: 'devin auth login',
 // （内置 runtime 唯一性）：显式 runtime 绑定（与其余三个内置模板同形态，不再靠 id 回退）
  runtime: 'devin',
}

/**
 * 通用 Claude 预设的 client 侧副本（真源 host 侧 CLAUDE_ACP_TEMPLATE）。
 * 不假设推理提供方（下游路由不属于本插件的模型身份范围），env 不预填。
 */
export const CLAUDE_ACP_TEMPLATE: AcpAgentConfig & { id: string } = {
  id: 'claude',
  name: 'Claude',
  command: 'claude-agent-acp',
  args: [],
  env: {},
  loginHint: 'claude',
  runtime: 'claude',
}

/**
 * Codex 预设的 client 侧副本（真源 host 侧 CODEX_ACP_TEMPLATE，逐字段
 * 钉版见 client-logic.spec.ts）。env 空；认证由 Codex CLI 自己管理。
 * `runtime: 'codex'` 显式绑定 descriptor。
 */
export const CODEX_ACP_TEMPLATE: AcpAgentConfig & { id: string } = {
  id: 'codex',
  name: 'Codex',
  command: 'codex-acp',
  args: [],
  env: {},
  loginHint: 'codex login',
  runtime: 'codex',
}

/**
 * Kimi 预设的 client 侧副本（真源 host 侧 KIMI_ACP_TEMPLATE，逐字段
 * 钉版见 client-logic.spec.ts）。env 空；认证由 Kimi CLI 自己管理。
 * `runtime: 'kimi'` 显式绑定 descriptor。
 */
export const KIMI_ACP_TEMPLATE: AcpAgentConfig & { id: string } = {
  id: 'kimi',
  name: 'Kimi',
  command: 'kimi',
  args: ['acp'],
  env: {},
  loginHint: 'kimi login',
  runtime: 'kimi',
}

/**
 * 面板 one-click 区的模板列表（现状：devin + claude 预设 + codex 预设 +
 * kimi 预设；client 侧副本，真源 host 侧 ACP_BUILTIN_AGENT_TEMPLATES）。AcpSection
 * 按此列表渲染模板按钮，每个按钮以模板 id 调 {@link draftFromTemplate} 播种编辑器。
 */
export const ACP_BUILTIN_AGENT_TEMPLATES: readonly (AcpAgentConfig & { id: string })[] = [
  DEVIN_ACP_TEMPLATE,
  CLAUDE_ACP_TEMPLATE,
  CODEX_ACP_TEMPLATE,
  KIMI_ACP_TEMPLATE,
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Validating decoder for the settings scope's `decode` hook, mirroring the
 * host schema's strip semantics (src/host/composition/installed-profile-registry.ts `acpSettingsSchema`): an
 * absent section resolves to zero agents; anything invalid resolves the whole
 * section to undefined, which the panel renders as the invalid-config state
 * rather than silently editing a partial view.
 * @param value - the raw namespace value riding the settings wire.
 * @returns the decoded section, or undefined when it fails validation.
 */
export function decodeAcpSettings(value: unknown): AcpSettings | undefined {
  if (value === undefined) return { agents: {} }
  if (!isPlainObject(value)) return undefined
  const rawAgents = value['agents'] ?? {}
  if (!isPlainObject(rawAgents)) return undefined
  const agents: Record<string, AcpAgentConfig> = {}
  for (const [id, raw] of Object.entries(rawAgents)) {
    const config = decodeAgentConfig(id, raw)
    if (config === undefined) return undefined
    agents[id] = config
  }
 // singleton 镜像（host schema 的跨条目拒绝同款口径）：同一内置 runtime
  // 被两个 profile 生效绑定（显式 runtime 或 id 回退）= 整 section 非法，
  // 面板按 invalid 拒绝编辑（不静默编辑宿主会拒写的文档）。
  const bound = new Set<string>()
  for (const [id, config] of Object.entries(agents)) {
    const runtime = effectiveRuntimeOf(id, config)
    if (runtime === undefined) continue
    if (bound.has(runtime)) return undefined
    bound.add(runtime)
  }
  return { agents }
}

/** Strict per-entry decode behind {@link decodeAcpSettings}; undefined on any violation. */
function decodeAgentConfig(id: string, raw: unknown): AcpAgentConfig | undefined {
  if (!ACP_AGENT_ID_PATTERN.test(id)) return undefined
  if (!isPlainObject(raw)) return undefined
  const name = raw['name']
  if (typeof name !== 'string' || name.length === 0) return undefined
  const command = raw['command']
  if (typeof command !== 'string' || command.length === 0) return undefined
  const args = raw['args'] ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  const env = raw['env'] ?? {}
  if (!isPlainObject(env) || !Object.values(env).every((value) => typeof value === 'string')) return undefined
  const loginHint = raw['loginHint']
  if (loginHint !== undefined && typeof loginHint !== 'string') return undefined
 // 边界：runtime 绑定只收四个合法值，其余整体拒绝（镜像 host schema 的 reject 语义）
  const runtime = raw['runtime']
  if (runtime !== undefined && !ACP_AGENT_RUNTIME_IDS.includes(runtime as AcpAgentRuntimeId)) return undefined
  return {
    name,
    command,
    args: [...args] as string[],
    env: { ...env } as Record<string, string>,
    ...(loginHint === undefined ? {} : { loginHint }),
    ...(runtime === undefined ? {} : { runtime: runtime as AcpAgentRuntimeId }),
  }
}

// ---------- 编辑器草稿（staged text，保存时才解析成配置；card-form.ts 先例） ----------

/** The agent editor's staged text: what is on screen is exactly what a save parses. */
export interface AgentDraft {
  id: string
  name: string
  command: string
  /** One argument per line. */
  argsText: string
  /** One `KEY=VALUE` per line（疑似 secret 的键不进文本框——见 `maskedEnv`）。 */
  envText: string
  loginHint: string
  /**
   * 疑似 secret（键名命中 {@link ACP_SECRET_ENV_KEY_PATTERN}）的存量 env 值
 * **不回显**——文本框只放非疑似键，疑似键由 UI 以「键名 + 已配置」
   * 行展示；原值在此携带过站，保存时与用户显式重填的同名行合并（显式行优先，
   * 即同名重填 = 轮换值；UI 移除行 = 删除该键）。仅「编辑存量 agent」路径会
   * 带上本字段。
   */
  maskedEnv?: Record<string, string>
  /**
 * 存量 agent 的 runtime descriptor 绑定（边界）原样过站：编辑器不暴露本
   * 字段，但保存时必须挂回——否则面板保存会静默解除 descriptor 绑定。
   * 仅「编辑存量 agent 且其配置带 runtime」路径携带本字段。
   */
  runtime?: AcpAgentRuntimeId
}

/** A blank draft for the manual-add flow. */
export function emptyDraft(): AgentDraft {
  return { id: '', name: '', command: '', argsText: '', envText: '', loginHint: '' }
}

/**
 * Seed the editor from a one-click template by id（按模板 id：
 * one-click 区对 {@link ACP_BUILTIN_AGENT_TEMPLATES} 逐模板渲染按钮）。未知 id
 * 返回 undefined——模板按钮只从列表渲染，正常不可达；调用方据此不打开编辑器。
 */
export function draftFromTemplate(templateId: string): AgentDraft | undefined {
  const template = ACP_BUILTIN_AGENT_TEMPLATES.find((candidate) => candidate.id === templateId)
  if (template === undefined) return undefined
  return draftFromAgent(template.id, template)
}

/** Seed the editor from a stored agent (the row's 编辑 button)。 */
export function draftFromAgent(id: string, config: AcpAgentConfig): AgentDraft {
 // 疑似 secret 的 env 键不进文本框（不回显值），原值进 maskedEnv 过站
  const visibleEnv: Record<string, string> = {}
  const maskedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.env)) {
    if (ACP_SECRET_ENV_KEY_PATTERN.test(key)) maskedEnv[key] = value
    else visibleEnv[key] = value
  }
  return {
    id,
    name: config.name,
    command: config.command,
    argsText: formatArgsText(config.args),
    envText: formatEnvText(visibleEnv),
    loginHint: config.loginHint ?? '',
    ...(Object.keys(maskedEnv).length === 0 ? {} : { maskedEnv }),
 // 边界：runtime 绑定不暴露编辑，原样过站（保存时挂回，见 validateAgentDraft）
    ...(config.runtime === undefined ? {} : { runtime: config.runtime }),
  }
}

/**
 * 移除草稿里一条掩码 env 键（UI 的「移除」按钮；）。返回新草稿对象；
 * 移除最后一个键时 `maskedEnv` 字段整体缺席（保持「无掩码 = 字段不在」的
 * 单一形态，validate/序列化两侧都不用特判空对象）。
 */
export function dropMaskedEnvKey(draft: AgentDraft, key: string): AgentDraft {
  if (draft.maskedEnv === undefined || !(key in draft.maskedEnv)) return draft
  const next = { ...draft.maskedEnv }
  delete next[key]
  const { maskedEnv: _dropped, ...rest } = draft
  return Object.keys(next).length === 0 ? rest : { ...rest, maskedEnv: next }
}

/**
 * Parse the args textarea: one argument per line, each line trimmed, blank
 * lines dropped. A line's interior whitespace is the user's to keep.
 */
export function parseArgsText(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Render stored args as the editor's one-per-line text. */
export function formatArgsText(args: readonly string[]): string {
  return args.join('\n')
}

/** Why one env line failed to parse. */
export type EnvParseFailure =
  | { readonly line: number; readonly reason: 'key' }
  | { readonly line: number; readonly reason: 'duplicate' }

/**
 * Parse the env textarea: one `KEY=VALUE` per line (split on the FIRST `=`),
 * blank lines ignored, key trimmed and required to be a shell identifier,
 * value kept verbatim after the line trim（起值为纯字面——
 * `$credential:` 引用语法已随 host 侧一同移除）。
 * @param text - the staged env text.
 * @returns the env map, or the first offending line (1-based).
 */
export function parseEnvText(text: string): { ok: true; env: Record<string, string> } | { ok: false; failure: EnvParseFailure } {
  const env: Record<string, string> = {}
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim()
    if (line === '') continue
    const eq = line.indexOf('=')
    const key = (eq < 0 ? line : line.slice(0, eq)).trim()
    if (!ACP_ENV_KEY_PATTERN.test(key)) return { ok: false, failure: { line: index + 1, reason: 'key' } }
    if (Object.hasOwn(env, key)) return { ok: false, failure: { line: index + 1, reason: 'duplicate' } }
    env[key] = eq < 0 ? '' : line.slice(eq + 1)
  }
  return { ok: true, env }
}

/** Render a stored env map as the editor's `KEY=VALUE` text (insertion order). */
export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

/** Locale key of one validation failure (the component maps it through `t`). */
export type DraftErrorKey =
  | 'errorIdRequired'
  | 'errorIdInvalid'
  | 'errorIdTaken'
  | 'errorNameRequired'
  | 'errorCommandRequired'
  | 'errorEnvKey'
  | 'errorEnvDuplicate'
  | 'errorRuntimeTaken'

/** One validation failure: locale key plus template params (e.g. the env line number). */
export interface DraftError {
  readonly key: DraftErrorKey
  readonly params?: Record<string, string | number>
}

/** Per-field validation outcome; `config` is present exactly when nothing failed. */
export interface DraftValidation {
  readonly id?: DraftError
  readonly name?: DraftError
  readonly command?: DraftError
  readonly env?: DraftError
  /**
 * （内置 runtime 唯一性）内置 runtime singleton 冲突：草稿的生效 runtime 已被另一个
   * 存量 profile 绑定。params 携带 `{runtime, id, name}` 点名已有 profile——
   * UI 据此展示「打开已有配置」出口，不自动覆盖/删除。
   */
  readonly runtime?: DraftError
  /** The parsed, storage-ready config; undefined while any error stands. */
  readonly config?: AcpAgentConfig
}

/**
 * profile 的生效 runtime 绑定（镜像 host 侧 descriptorOf 的口径——显式
 * `runtime` 字段优先，缺席时 agent id 恰为内置 runtime id 则按 id 回退命中；
 * 两者都不命中 = generic profile，无 runtime 身份、多实例不受 singleton 约束）。
 */
export function effectiveRuntimeOf(id: string, config: { readonly runtime?: AcpAgentRuntimeId }): AcpAgentRuntimeId | undefined {
  return config.runtime ?? (ACP_AGENT_RUNTIME_IDS.includes(id as AcpAgentRuntimeId) ? (id as AcpAgentRuntimeId) : undefined)
}

/**
 * Validate a staged draft against the host schema's rules plus id uniqueness
 * and the built-in runtime singleton (：同一内置 runtime 至多一个 profile，
 * client 侧先检——host schema 的同款跨条目拒绝兜底绕过 UI 的直写）。
 * The row being edited keeps its own id/runtime (`editingId`) without tripping
 * the taken checks.
 * @param draft - the staged text.
 * @param agents - the stored agents map（id 唯一性与 runtime 冲突的共同事实源）.
 * @param editingId - the id whose row is being edited, undefined while adding.
 * @returns per-field errors and, when clean, the parsed config.
 */
export function validateAgentDraft(
  draft: AgentDraft,
  agents: Record<string, AcpAgentConfig>,
  editingId: string | undefined,
): DraftValidation {
  const id = draft.id.trim()
  const name = draft.name.trim()
  const command = draft.command.trim()
  const loginHint = draft.loginHint.trim()
  const validation: {
    id?: DraftError
    name?: DraftError
    command?: DraftError
    env?: DraftError
    runtime?: DraftError
  } = {}
  if (id === '') validation.id = { key: 'errorIdRequired' }
  else if (!ACP_AGENT_ID_PATTERN.test(id)) validation.id = { key: 'errorIdInvalid' }
  else if (id !== editingId && Object.hasOwn(agents, id)) validation.id = { key: 'errorIdTaken' }
  if (name === '') validation.name = { key: 'errorNameRequired' }
  if (command === '') validation.command = { key: 'errorCommandRequired' }
  const parsedEnv = parseEnvText(draft.envText)
  if (!parsedEnv.ok) {
    const key: DraftErrorKey = parsedEnv.failure.reason === 'key' ? 'errorEnvKey' : 'errorEnvDuplicate'
    validation.env = { key, params: { line: parsedEnv.failure.line } }
  }
 // singleton：草稿的生效 runtime（显式 runtime 优先、内置 id 回退）与任一
  // 其他存量 profile 的生效 runtime 相撞即拒绝，错误点名已有 profile。
  const draftRuntime = draft.runtime ?? (ACP_AGENT_RUNTIME_IDS.includes(id as AcpAgentRuntimeId) ? (id as AcpAgentRuntimeId) : undefined)
  if (draftRuntime !== undefined) {
    for (const [existingId, existing] of Object.entries(agents)) {
      if (existingId === editingId) continue
      if (effectiveRuntimeOf(existingId, existing) !== draftRuntime) continue
      validation.runtime = { key: 'errorRuntimeTaken', params: { runtime: draftRuntime, id: existingId, name: existing.name } }
      break
    }
  }
  if (validation.id !== undefined || validation.name !== undefined
    || validation.command !== undefined || validation.env !== undefined
    || validation.runtime !== undefined || !parsedEnv.ok) {
    return validation
  }
  return {
    ...validation,
    config: {
      name,
      command,
      args: parseArgsText(draft.argsText),
 // 掩码键原样合回（用户同名重填的显式行优先 = 轮换值）
      env: { ...draft.maskedEnv, ...parsedEnv.env },
      ...(loginHint === '' ? {} : { loginHint }),
 // 边界：存量 agent 的 runtime 绑定原样挂回（编辑器不暴露，保存不得静默解除）
      ...(draft.runtime === undefined ? {} : { runtime: draft.runtime }),
    },
  }
}

// ---------- agents map 的 CRUD 纯操作（写路径在 controller，经 settings.mutate 落盘） ----------

/** Agent ids in the registry's canonical display order. */
export function sortedAgentIds(agents: Record<string, AcpAgentConfig>): string[] {
  return Object.keys(agents).sort((left, right) => left.localeCompare(right))
}

/** The stored agents map with one entry written (add or replace). */
export function withAgent(
  agents: Record<string, AcpAgentConfig>,
  id: string,
  config: AcpAgentConfig,
): Record<string, AcpAgentConfig> {
  return { ...agents, [id]: config }
}

/** The stored agents map with one entry removed. */
export function withoutAgent(agents: Record<string, AcpAgentConfig>, id: string): Record<string, AcpAgentConfig> {
  const next = { ...agents }
  delete next[id]
  return next
}

/** The spawn command line as the card shows it: `command args…`. */
export function commandLineOf(config: { command: string; args: readonly string[] }): string {
  return [config.command, ...config.args].join(' ')
}

// ---------- settings scope 快照投影（controller 订阅的面片状态） ----------

/** Structural face of the client settings scope's snapshot (dsh-client-runtime SettingsScopeSnapshot). */
export interface AcpScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: AcpSettings | undefined
  revision: number | undefined
  writable: boolean
}

/** The panel's view of its settings scope. */
export interface PanelSettingsState {
  /**
   * `invalid` covers a section the scope served but the decoder refused: the
   * scope leaves `status` at 'loading' on a decode miss while `revision`
   * proves a read landed — that pair is the invalid state, not a slow load.
   */
  status: 'loading' | 'invalid' | 'unavailable' | 'ready'
  writable: boolean
  agents: Record<string, AcpAgentConfig>
  revision: number | undefined
}

/** Project one scope snapshot into the panel's settings state. */
export function panelSettingsOf(snapshot: AcpScopeSnapshot): PanelSettingsState {
  const status = snapshot.status === 'ready'
    ? 'ready'
    : snapshot.status === 'unavailable'
      ? 'unavailable'
      : snapshot.revision === undefined
        ? 'loading'
        : 'invalid'
  return {
    status,
    writable: snapshot.writable,
    agents: snapshot.value?.agents ?? {},
    revision: snapshot.revision,
  }
}

// ---------- Remote wire 解码（窄化 contract 见 src/contract/remote.ts） ----------

/** ACP schema v1 AuthMethod (the initialize response's advertised methods; every variant carries id + name). */
export interface AcpAuthMethod {
  id: string
  name: string
  description?: string | null
}

/** initialize 握手能力的展示事实（镜像 src/contract/remote.ts `AcpCapabilityFacts`）。 */
export interface AcpCapabilityFacts {
  loadSession: boolean
  sessionList: boolean
 /** `session/close`（清理事实展示用）。 */
  sessionClose: boolean
 /** `session/delete`（清理事实展示用）。 */
  sessionDelete: boolean
  promptImage: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean
  mcpHttp: boolean
  mcpSse: boolean
}

/** probe 会话清理事实（镜像 src/contract/remote.ts `AcpProbeCleanupView`）。 */
export interface AcpProbeCleanup {
  close: 'done' | 'not-advertised' | 'failed'
  delete: 'done' | 'not-advertised' | 'failed'
  message: string | null
}

/** 端到端能力矩阵一行的三值状态（镜像 src/contract/remote.ts `AcpCapabilityMatrixStatus`）。 */
export type AcpCapabilityMatrixStatus = 'supported' | 'degraded' | 'unsupported'

/**
 * 端到端能力矩阵的一行（镜像 src/contract/remote.ts
 * `AcpCapabilityMatrixRow`）：advertised/adapterPath/hostSeam 三列事实 +
 * 派生 status + 可选 note（host 侧事实陈述原文，次级展示不过 locale）。
 */
export interface AcpCapabilityMatrixRow {
  id: string
  advertised: boolean | null
  adapterPath: string
  hostSeam: string | null
  status: AcpCapabilityMatrixStatus
  note?: string
}

/** probe 失败阶段（四层分层判据；镜像 src/protocol/v1/types.ts `AcpProbePhase`）。 */
export type AcpProbePhase = 'initialize' | 'session'

/**
 * ACP agent 配置的五态词表（client 侧字面量副本——真源
 * src/domain/session/agent-state.ts / wire 面 src/contract/remote.ts）。
 */
export type AcpAgentConfigState = 'saved-unverified' | 'ready' | 'auth-required' | 'unavailable' | 'incompatible'

/** One provider row of the dshAcp Remote `health` view (src/contract/remote.ts). */
export interface AcpProviderHealth {
  id: string
  name: string
  command: string
  args: string[]
  loginHint: string | null
  executable: boolean
  version: string | null
 /** 五态状态（host 侧 deriveAcpAgentState 派生）。 */
  state: AcpAgentConfigState
  probe:
    | { status: 'never'; at: null }
    | {
      status: 'ok'
      at: number
      modelCount: number
      authMethods: readonly AcpAuthMethod[] | null
      agentInfo: { name: string; version: string } | null
      capabilities: AcpCapabilityFacts | null
 /** probe 会话清理事实（delete 未广告/失败 = 降级，面板须如实展示）。 */
      cleanup: AcpProbeCleanup | null
 /** initialize 握手能力的 sha256-16 指纹（旧条目缺席归 null）。 */
      capabilityHash: string | null
 /** 协商的 ACP 协议版本（readiness；旧缓存条目/握手未给出归 null）。 */
      protocolVersion: number | null
 /** 绑定 descriptor 的钉版（边界；无 descriptor 的普通 profile 归 null）。 */
      versionPolicy: { adapter: string | null; wrappedCli: string | null } | null
 /** 兼容状态（边界；无 descriptor/握手无版本归 null，无钉版 'unpinned'）。 */
      versionCompatibility: 'pinned' | 'drifted' | 'unpinned' | null
 /** 端到端能力矩阵（host 计算的交集结论，UI 只展示它，不直译 capabilities 布尔）。 */
      matrix: readonly AcpCapabilityMatrixRow[]
    }
    | { status: 'error'; at: number; failureKind: string; message: string; phase: AcpProbePhase | null }
}

/** The probe failure kind that means "log in first" (src/protocol/v1/types.ts AcpErrorKind). */
export const ACP_FAILURE_AUTH_REQUIRED = 'auth_required'

/**
 * Validate a dshAcp Remote `health` view payload. Wire boundary: the whole
 * payload is refused (undefined) rather than partially shown when any row
 * violates the contract.
 */
export function decodeHealthResponse(body: unknown): readonly AcpProviderHealth[] | undefined {
  if (!isPlainObject(body)) return undefined
  const providers = body['providers']
  if (!Array.isArray(providers)) return undefined
  const rows: AcpProviderHealth[] = []
  for (const raw of providers) {
    const row = decodeHealthRow(raw)
    if (row === undefined) return undefined
    rows.push(row)
  }
  return rows
}

const ACP_AGENT_STATES: readonly AcpAgentConfigState[] = ['saved-unverified', 'ready', 'auth-required', 'unavailable', 'incompatible']

function decodeHealthRow(raw: unknown): AcpProviderHealth | undefined {
  if (!isPlainObject(raw)) return undefined
  const { id, name, command, args, loginHint, executable, version, state, probe } = raw as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || typeof command !== 'string') return undefined
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  if (!(typeof loginHint === 'string' || loginHint === null)) return undefined
  if (typeof executable !== 'boolean') return undefined
  if (!(typeof version === 'string' || version === null)) return undefined
 // 五态：词表外一律整行拒绝（health 响应整体失格，与 decodeHealthResponse 口径一致）
  if (typeof state !== 'string' || !ACP_AGENT_STATES.includes(state as AcpAgentConfigState)) return undefined
  const probeRow = decodeProbeRow(probe)
  if (probeRow === undefined) return undefined
  return { id, name, command, args: args as string[], loginHint, executable, version, state: state as AcpAgentConfigState, probe: probeRow }
}

function decodeProbeRow(raw: unknown): AcpProviderHealth['probe'] | undefined {
  if (!isPlainObject(raw)) return undefined
  const status = raw['status']
  if (status === 'never') return raw['at'] === null ? { status: 'never', at: null } : undefined
  if (typeof raw['at'] !== 'number') return undefined
  if (status === 'ok') {
    const modelCount = raw['modelCount']
    const authMethods = raw['authMethods']
    if (typeof modelCount !== 'number') return undefined
    if (!(authMethods === null || (Array.isArray(authMethods) && authMethods.every(isAuthMethod)))) return undefined
    const agentInfo = decodeAgentInfo(raw['agentInfo'])
    if (agentInfo === undefined) return undefined
    const capabilities = decodeCapabilityFacts(raw['capabilities'])
    if (capabilities === undefined) return undefined
    const cleanup = decodeProbeCleanup(raw['cleanup'])
    if (cleanup === undefined) return undefined
    const capabilityHash = raw['capabilityHash']
    if (!(capabilityHash === null || typeof capabilityHash === 'string')) return undefined
 // readiness 三键（probe-ok 必填；null 词表/词表外值整行拒绝）
    const protocolVersion = raw['protocolVersion']
    if (!(protocolVersion === null || typeof protocolVersion === 'number')) return undefined
    const versionPolicy = decodeVersionPolicy(raw['versionPolicy'])
    if (versionPolicy === undefined) return undefined
    const versionCompatibility = raw['versionCompatibility']
    if (!(versionCompatibility === null || versionCompatibility === 'pinned' || versionCompatibility === 'drifted' || versionCompatibility === 'unpinned')) return undefined
    const matrix = decodeCapabilityMatrix(raw['matrix'])
    if (matrix === undefined) return undefined
    return {
      status: 'ok',
      at: raw['at'],
      modelCount,
      authMethods: authMethods as readonly AcpAuthMethod[] | null,
      agentInfo,
      capabilities,
      cleanup,
      capabilityHash,
      protocolVersion,
      versionPolicy,
      versionCompatibility,
      matrix,
    }
  }
  if (status === 'error') {
    const failureKind = raw['failureKind']
    const message = raw['message']
    const phase = raw['phase']
    if (typeof failureKind !== 'string' || typeof message !== 'string') return undefined
    if (!(phase === null || phase === 'initialize' || phase === 'session')) return undefined
    return { status: 'error', at: raw['at'], failureKind, message, phase }
  }
  return undefined
}

/** agentInfo 字段：null 或 {name, version}（其余键剥离）。 */
function decodeAgentInfo(raw: unknown): { name: string; version: string } | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const { name, version } = raw as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string') return undefined
  return { name, version }
}

/** versionPolicy 字段（边界）：null 或 adapter/wrappedCli 双 null 词表成员齐备；其余形态整行拒绝。 */
function decodeVersionPolicy(raw: unknown): { adapter: string | null; wrappedCli: string | null } | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const adapter = raw['adapter']
  const wrappedCli = raw['wrappedCli']
  if (!(adapter === null || typeof adapter === 'string')) return undefined
  if (!(wrappedCli === null || typeof wrappedCli === 'string')) return undefined
  return { adapter, wrappedCli }
}

/** capabilities 字段：null 或九键全 boolean 的事实对象（其余键剥离）。 */
function decodeCapabilityFacts(raw: unknown): AcpCapabilityFacts | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const keys = ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete', 'promptImage', 'promptAudio', 'promptEmbeddedContext', 'mcpHttp', 'mcpSse'] as const
  const facts = {} as Record<(typeof keys)[number], boolean>
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== 'boolean') return undefined
    facts[key] = value
  }
  return facts
}

const CLEANUP_STEPS = ['done', 'not-advertised', 'failed'] as const

/** cleanup 字段：null 词表或三态齐全的事实对象；其余形态整行拒绝。 */
function decodeProbeCleanup(raw: unknown): AcpProbeCleanup | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const close = CLEANUP_STEPS.find((step) => step === raw['close'])
  const del = CLEANUP_STEPS.find((step) => step === raw['delete'])
  if (close === undefined || del === undefined) return undefined
  const message = raw['message']
  if (!(message === null || typeof message === 'string')) return undefined
  return { close, delete: del, message }
}

function isAuthMethod(raw: unknown): boolean {
  return isPlainObject(raw) && typeof raw['id'] === 'string' && typeof raw['name'] === 'string'
}

const MATRIX_STATUSES: readonly AcpCapabilityMatrixStatus[] = ['supported', 'degraded', 'unsupported']

/**
 * matrix 字段：probe-ok 的必填键，行数组逐行严检（id/adapterPath
 * string、advertised boolean|null、hostSeam string|null、status 词表内、
 * note 缺席或 string）；任一畸形整行拒绝 → health 响应整体失格
 * （decodeHealthResponse 同款口径）。
 */
function decodeCapabilityMatrix(raw: unknown): readonly AcpCapabilityMatrixRow[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: AcpCapabilityMatrixRow[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) return undefined
    const { id, advertised, adapterPath, hostSeam, status, note } = item
    if (typeof id !== 'string') return undefined
    if (!(advertised === null || typeof advertised === 'boolean')) return undefined
    if (typeof adapterPath !== 'string') return undefined
    if (!(hostSeam === null || typeof hostSeam === 'string')) return undefined
    if (typeof status !== 'string' || !MATRIX_STATUSES.includes(status as AcpCapabilityMatrixStatus)) return undefined
    if (note !== undefined && typeof note !== 'string') return undefined
    rows.push({
      id,
      advertised,
      adapterPath,
      hostSeam,
      status: status as AcpCapabilityMatrixStatus,
      ...(typeof note === 'string' ? { note } : {}),
    })
  }
  return rows
}

/** `boundSessions(agentId)` 的应答（删除确认提示；client 侧镜像 src/contract/remote.ts `AcpBoundSessionsView`）。 */
export interface AcpBoundSessionsView {
  readonly agentId: string
  readonly count: number
}

/**
 * boundSessions 应答的严格解码（wire 边界纪律与 decodeHealthResponse 同款：
 * 畸形/错型整体拒绝归 undefined——计数是删除确认的增强提示，缺失时面板退回
 * 无计数的基础文案，绝不拿解码失败冒充 0）。
 */
export function decodeBoundSessions(body: unknown): AcpBoundSessionsView | undefined {
  if (!isPlainObject(body)) return undefined
  const { agentId, count } = body as Record<string, unknown>
  if (typeof agentId !== 'string' || !ACP_AGENT_ID_PATTERN.test(agentId)) return undefined
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined
  return { agentId, count }
}

/** Match one health row to a settings agent id (undefined when the response does not cover it). */
export function healthRowOf(rows: readonly AcpProviderHealth[], id: string): AcpProviderHealth | undefined {
  return rows.find((row) => row.id === id)
}

// ---------- 错误文本整形 ----------

/** Any thrown value → a displayable message. */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
