/**
 * Pure logic for the enhanced model picker.
 *
 * Same discipline as logic.ts: no DOM, fetch, React, or host-module imports —
 * every export is directly vitest-testable. The wire
 * shapes below are CLIENT-SIDE COPIES of contracts owned elsewhere:
 * - the native model directory shapes mirror `@deepseek-ai/dsh-api-remotes`
 *   sessions.ts (`session.models` / `session.selectModel`), the data source of
 *   the built-in ui-model-selection package this picker is copied from (MIT);
 * - the live-options shapes mirror `src/contract/remote.ts` (`AcpLiveOptionsSnapshot`,
 * dshAcp Remote namespace 的 options/setOption wire contract);
 * - the option partition mirrors `src/domain/session/options-sync.ts` classification
 *   (thought_level / mode fallbacks) so the seat groups options exactly
 *   the way the host half routes their writes; model-class options are excluded
 * from the pane entirely (model switching goes through the model
 *   directory + ModelSwitchCoordinator, never a live control); options with an
 *   absent or unknown category land in the "其他设置" (`other`) bucket —
 *   categories are UX hints and never correctness gates (session-config-options.mdx);
 * - the default-model settings shape mirrors `packages/core/agent-default-model`
 *   (`agent-default-model` ns: `{provider, model, reasoningEffort?}`).
 *
 * Fork provenance (upstream dsh-v0.1.1-rc.2, commit b150a551b8): the upstream
 * package `packages/client/ui-model-selection/` is not published to any
 * registry, so per repo policy its pure functions are carried as a modified
 * fork. The copied surface lives in the client compatibility island
 * `src/client/host-compat/model-picker/`（边界说明见该目录模块头）：
 * - verbatim（本模块）：`ModelDirectoryState`, `INITIAL_DIRECTORY_STATE`
 *   （upstream`src/client/index.ts` / `src/client/directory.ts`）；
 * - verbatim/modified（岛上 popup.ts）：`rowId`/`selectionOf` 逐字节沿用，
 *   `optionsOf` 保留上游分组骨架并加 `[Model]`/`[ACP]` 标签前缀；
 * - the directory controller upstream (`directory.ts`) only resolves API-key
 *   providers — the adapter's `directory-controller.ts` adds ACP provider
 *   resolution and the live-options wire;
 * - fully adapter-owned (absent upstream): the filter/pinned/visibility/
 *   default-resolution family, `live-controller.ts`, and the live-options
 *   snapshot types + decoder below.
 * Host-side semantics parity (not verbatim): upstream`buildModelCatalog`
 * records a per-provider probe failure without sinking the whole catalog
 * (packages/host/apiproxy/src/api/sessions.ts); the adapter host composition
 * does the same. test/contracts/upstream-picker-diff.spec.ts pins all of the above —
 * an upstream bump turns it red and forces review.
 * @module @zaimokuza/dsh-acp-adapter/client/selector-logic
 */

import {
  isAcpProvider,
  providerKindOf,
} from './selector-catalog.ts'
import type {
  PickerBackendState,
  PickerModelSelection,
  PickerProviderGroup,
  ProviderFilter,
} from './selector-catalog.ts'

export * from './selector-catalog.ts'

// ---------- 原生目录 wire 形状（镜像 dsh-api-remotes sessions.ts；禁止 import） ----------

/** A provider whose catalog lookup failed (wire copy of `ModelCatalogFailure`). */
export interface PickerCatalogFailure {
  id: string
  name: string
  message: string
}

/** The `session.models` response value (wire copy of `SessionModels`). */
export interface SessionModelsView {
  current: PickerModelSelection
  routable: boolean
  groups: PickerProviderGroup[]
  failures: PickerCatalogFailure[]
}

/**
 * Directory snapshot both picker entries render from (copy of the built-in
 * `ModelDirectoryState`): `current`/`routable` are null before the first load,
 * and null routable is NOT the blocked state.
 */
export interface ModelDirectoryState {
  current: PickerModelSelection | null
  routable: boolean | null
  groups: readonly PickerProviderGroup[]
  failures: readonly PickerCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** The translate seat shape the pure helpers accept (the locale service's bound `t`). */
export type PickerTranslate = (key: string, params?: Record<string, string | number>) => string

/** The directory's pre-first-load value (built-in initial store value). */
export const INITIAL_DIRECTORY_STATE: ModelDirectoryState = {
  current: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

// ---------- 提供方标签与过滤（增强点） ----------

/**
 * 「当前」Tab 的可用性——仅当 host `backendOf(sessionId)` 报告该会话有
 * 已建立的 ACP binding（established 且路由是 acp-*）。RPC 失败（null）、blank、
 * native 已建立一律不展示，行为保持 DSH 原生。
 */
export function currentTabAvailable(backend: PickerBackendState | null): boolean {
  return backend !== null && backend.state === 'established' && isAcpProvider(backend.provider)
}

/** 打开 picker 的默认 filter——ACP 会话默认进「当前」Tab；其余保持原生默认 'all'。 */
export function defaultFilterOf(backend: PickerBackendState | null): ProviderFilter {
  return currentTabAvailable(backend) ? 'current' : 'all'
}

/**
 * 「当前」Tab 的路由事实。`provider` 是 backendOf established 的精确
 * provider/profile 路由 id；`allowedValues`/`currentValue` 取自会话
 * live/last-known 快照的 model 类 select option——**只**作 allowed-values
 * 交集与「不在目录」判定（capability hint），绝不构建第二份模型目录。
 */
export interface CurrentRouteFacts {
  readonly provider: string
  /** model 类 select option 的可选值；快照缺席/无该选项归 null（无交集依据，不过滤）。 */
  readonly allowedValues: readonly string[] | null
  /** Agent 当前模型值；快照缺席/无该选项归 null。 */
  readonly currentValue: string | null
}

/**
 * 从 live 快照提取「当前」Tab 事实（stale 快照同样可作参考交集——；
 * stale 绝不授权热切换的纪律由 ModelSwitchController 把守，与本读面无关）。
 */
export function currentRouteFactsOf(
  provider: string,
  snapshot: LiveOptionsSnapshot | null | undefined,
): CurrentRouteFacts {
  const option = snapshot?.configOptions?.find((candidate) => isModelClassLiveOption(candidate))
  if (option === undefined || option.type !== 'select') {
    return { provider, allowedValues: null, currentValue: null }
  }
  return {
    provider,
    allowedValues: flattenLiveValues(option).map((row) => row.value),
    currentValue: option.currentValue,
  }
}

/**
 * 「不在目录」只读状态判定——Agent 当前值已知，但该 profile 的 provider
 * 目录组缺席或不含该值（探测过期/目录漂移）。UI 据此显示只读「不在目录/请重新
 * 探测」行；**绝不**把未知模型注入目录。
 */
export function currentValueNotInCatalog(
  groups: readonly PickerProviderGroup[],
  facts: CurrentRouteFacts,
): boolean {
  if (facts.currentValue === null) return false
  const group = groups.find((candidate) => candidate.id === facts.provider)
  return group === undefined || !group.models.some((model) => model.id === facts.currentValue)
}

/**
 * Filter the catalog groups for the model pane: the provider bucket keeps or
 * drops whole groups; the search text (case-insensitive, trimmed) matches the
 * group name, model name, and model description. A group with no surviving
 * models drops out; blank search keeps every model.
 *
 * 当 filter === 'current' 时按 `current.provider` 精确路由过滤（不是
 * provider bucket），再对存活模型做 live allowed-values 交集（allowedValues
 * 为 null = 无快照依据，不过滤）；facts 缺席时为空集（Tab 本不该存在）。
 */
export function filterGroups(
  groups: readonly PickerProviderGroup[],
  filter: ProviderFilter,
  search: string,
  current?: CurrentRouteFacts,
): PickerProviderGroup[] {
  const query = search.trim().toLowerCase()
  const result: PickerProviderGroup[] = []
  for (const group of groups) {
    if (filter === 'current') {
      if (current === undefined || group.id !== current.provider) continue
    } else if (filter !== 'all' && providerKindOf(group.id) !== filter) continue
    const allowed = filter === 'current' ? (current?.allowedValues ?? null) : null
    const routed = allowed !== null
      ? group.models.filter((model) => allowed.includes(model.id))
      : group.models
    const models = query === ''
      ? routed
      : routed.filter((model) =>
        model.name.toLowerCase().includes(query)
        || (model.description?.toLowerCase().includes(query) ?? false)
        || group.name.toLowerCase().includes(query))
    if (models.length > 0) result.push({ ...group, models })
  }
  return result
}

/**
 * Failure rows follow the provider bucket but NOT the search text: a catalog
 * failure is a health signal and must not vanish because the user typed.
 * 当 filter 为 'current' 时只保留精确路由的失败行（路由缺席 = 无失败行）。
 */
export function filterFailures(
  failures: readonly PickerCatalogFailure[],
  filter: ProviderFilter,
  currentProvider?: string,
): PickerCatalogFailure[] {
  if (filter === 'current') {
    return failures.filter((failure) => failure.id === currentProvider)
  }
  return failures.filter((failure) => filter === 'all' || providerKindOf(failure.id) === filter)
}

// ---------- backend 兼容矩阵（「backend 不可变」的 picker 主防线） ----------

/**
 * 会话 backend 事实（wire copy of `AcpBackendState`，src/contract/remote.ts
 * `backendOf` 应答）：'blank' = 尚无 backend 承诺；此时 current.provider 仍是
 * 当前 AgentLoop/默认路由的必要安全事实，不能把 native→ACP 当成原地模型切换；
 */
export interface LiveSelectValue {
  value: string
  name: string
  description?: string
}

/** One value group of a live select option (ACP `SessionConfigSelectGroup`). */
export interface LiveSelectGroup {
  group: string
  name: string
  options: LiveSelectValue[]
}

/**
 * One live config option (wire copy of ACP `SessionConfigOption`, normalized:
 * `null` description/category arrive as absent after the decoder).
 */
export type LiveConfigOption =
  | {
    type: 'select'
    id: string
    name: string
    description?: string
    category?: string
    currentValue: string
    options: readonly (LiveSelectValue | LiveSelectGroup)[]
  }
  | {
    type: 'boolean'
    id: string
    name: string
    description?: string
    category?: string
    currentValue: boolean
  }

/**
 * initialize 握手能力的展示事实（wire copy of `AcpCapabilityFacts`,
 * src/contract/remote.ts；九键全 boolean，未广告的能力归 false）。
 */
export interface LiveCapabilityFacts {
  loadSession: boolean
  sessionList: boolean
  sessionClose: boolean
  sessionDelete: boolean
  promptImage: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean
  mcpHttp: boolean
  mcpSse: boolean
}

/**
 * 会话连续性闩锁事实（wire copy of `AcpSessionContinuity`, src/contract/remote.ts）：
 * 'ok' = 已对齐；'blocked' = reconciliation-required（cause 是 sidecar
 * `AcpReconciliationCause` 词表字面量，wire 面按 string 收窄；detail 是有界
 * 人类可读摘要）。picker 据此渲染阻断横幅与 rebindBlank 逃生按钮（收尾）。
 */
export interface LiveSessionContinuity {
  status: 'ok' | 'blocked'
  cause: string | null
  detail: string | null
}

/**
 * 待定模型切换事务的 wire 视图（client-side copy of `AcpModelSwitchView`,
 * src/contract/remote.ts）：idle/busy/pending/rollback-required/corrupt
 * 五态。pending 行由 client 恢复器（`decideModelSwitchRecovery`）按 DSH 当前值 ×
 * Agent 当前值 × previous/target 收敛；rollback-required/corrupt 期间 composer
 * 锁定，由用户选择出路（回滚或 rebind）。
 */
export type LiveModelSwitchView =
  | { status: 'idle' }
  | { status: 'busy'; operationId: string; targetModel: string }
  | {
    status: 'pending'
    operationId: string
    state: 'started' | 'agent-applied' | 'agent-rolled-back' | 'committed'
    provider: string
    optionId: string
    previousModel: string
    targetModel: string
    appliedModel?: string
    createdAt: string
  }
  | { status: 'rollback-required'; operationId: string; provider: string; previousModel: string; targetModel: string }
  | { status: 'corrupt' }

/** The live options snapshot (wire copy of `AcpLiveOptionsSnapshot`, src/contract/remote.ts). */
export interface LiveOptionsSnapshot {
  sessionId: string
  configOptions: readonly LiveConfigOption[] | null
  currentModeId: string | null
  /** 本会话握手的协议能力实际值（会话未懒启动/未握手时为 null——披露区如实显示，不拿 probe 缓存冒充）。 */
  capabilities: LiveCapabilityFacts | null
 /** 连续性闩锁状态（宿主恒发；rebindBlank 的响应也携带复位后的快照）。 */
  continuity: LiveSessionContinuity
 /** 最新已知上下文占用（未收到过 usage_update 为 null——诚实空缺，dock 组件不渲染）。 */
  contextUsage: LiveContextUsage | null
  /**
 * 必填键：'live' = 活体 Agent 权威快照；'stale' = sidecar last-known
   * 快照（冷启动只读展示面——UI 显示「上次快照」横幅，绝不授权热切换）。
   */
  freshness: 'live' | 'stale'
 /** 必填键：false（stale）时全部控件只读、任何写路径拒发。 */
  editable: boolean
 /** 必填键：stale 快照指纹与当前配置重组指纹不一致（只作诊断）；live 恒 false。 */
  fingerprintChanged: boolean
 /** 必填键：待定模型切换事务视图。 */
  modelSwitch: LiveModelSwitchView
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function decodeLiveSelectValue(raw: unknown): LiveSelectValue | undefined {
  if (!isPlainObject(raw)) return undefined
  if (typeof raw['value'] !== 'string' || typeof raw['name'] !== 'string') return undefined
  const description = raw['description']
  if (description !== undefined && description !== null && typeof description !== 'string') return undefined
  return {
    value: raw['value'],
    name: raw['name'],
    ...(typeof description === 'string' ? { description } : {}),
  }
}

function decodeLiveSelectEntry(raw: unknown): LiveSelectValue | LiveSelectGroup | undefined {
  if (!isPlainObject(raw)) return undefined
  if (Array.isArray(raw['options'])) {
    if (typeof raw['group'] !== 'string' || typeof raw['name'] !== 'string') return undefined
    const options: LiveSelectValue[] = []
    for (const item of raw['options']) {
      const decoded = decodeLiveSelectValue(item)
      if (decoded === undefined) return undefined
      options.push(decoded)
    }
    return { group: raw['group'], name: raw['name'], options }
  }
  return decodeLiveSelectValue(raw)
}

/** Well-formed option whose `type` string is unrecognized: the protocol says the client SHOULD ignore it (the agent default stands; no control rendered). */
const SKIP_OPTION: unique symbol = Symbol('dsh-acp.skip-live-option')

function decodeLiveConfigOption(raw: unknown): LiveConfigOption | typeof SKIP_OPTION | undefined {
  if (!isPlainObject(raw)) return undefined
  // 未知 type（字符串但非 select/boolean）→ 只忽略该选项（协议 §Default Values and
  // Graceful Degradation），不传染整个快照。type 缺席/非 string 属畸形，照常整包拒绝。
  const rawType = raw['type']
  if (typeof rawType === 'string' && rawType !== 'select' && rawType !== 'boolean') return SKIP_OPTION
  if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return undefined
  const description = raw['description']
  if (description !== undefined && description !== null && typeof description !== 'string') return undefined
  const category = raw['category']
  if (category !== undefined && category !== null && typeof category !== 'string') return undefined
  const base = {
    id: raw['id'],
    name: raw['name'],
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof category === 'string' ? { category } : {}),
  }
  if (raw['type'] === 'select') {
    if (typeof raw['currentValue'] !== 'string' || !Array.isArray(raw['options'])) return undefined
    const options: (LiveSelectValue | LiveSelectGroup)[] = []
    for (const entry of raw['options']) {
      const decoded = decodeLiveSelectEntry(entry)
      if (decoded === undefined) return undefined
      options.push(decoded)
    }
    return { ...base, type: 'select', currentValue: raw['currentValue'], options }
  }
  if (raw['type'] === 'boolean') {
    if (typeof raw['currentValue'] !== 'boolean') return undefined
    return { ...base, type: 'boolean', currentValue: raw['currentValue'] }
  }
  return undefined
}

const LIVE_CAPABILITY_KEYS = [
  'loadSession',
  'sessionList',
  'sessionClose',
  'sessionDelete',
  'promptImage',
  'promptAudio',
  'promptEmbeddedContext',
  'mcpHttp',
  'mcpSse',
] as const

/** 能力事实解码：null 词表（未握手）或九键全 boolean；其余形态整体拒绝。 */
function decodeLiveCapabilityFacts(raw: unknown): LiveCapabilityFacts | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const facts = {} as Record<(typeof LIVE_CAPABILITY_KEYS)[number], boolean>
  for (const key of LIVE_CAPABILITY_KEYS) {
    const value = raw[key]
    if (typeof value !== 'boolean') return undefined
    facts[key] = value
  }
  return facts
}

/** Agent 明确提供的累计成本事实（wire copy of `AcpContextUsageCostView`, src/contract/remote.ts）。 */
export interface LiveContextUsageCost {
  amount: number
  currency: string
}

/**
 * 最新已知 ACP 上下文占用（wire copy of `AcpContextUsageView`,
 * src/contract/remote.ts；）。used/size 是 agent 报告原值，percent 保留
 * 一位小数，cost 为 null = agent 未提供。绝不冒充 token 计费。
 */
export interface LiveContextUsage {
  used: number
  size: number
  percent: number
  cost: LiveContextUsageCost | null
}

/** 上下文占用解码：null 词表（未收到过 usage_update）或四键齐备；其余形态整体拒绝。 */
function decodeLiveContextUsage(raw: unknown): LiveContextUsage | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  if (typeof raw['used'] !== 'number' || typeof raw['size'] !== 'number' || typeof raw['percent'] !== 'number') {
    return undefined
  }
  const rawCost = raw['cost']
  let cost: LiveContextUsageCost | null = null
  if (rawCost !== null) {
    if (!isPlainObject(rawCost) || typeof rawCost['amount'] !== 'number' || typeof rawCost['currency'] !== 'string') {
      return undefined
    }
    cost = { amount: rawCost['amount'], currency: rawCost['currency'] }
  }
  return { used: raw['used'], size: raw['size'], percent: raw['percent'], cost }
}

/** 连续性闩锁解码（收尾：continuity 上 client 必填键）：status 二值 + cause/detail null 词表；其余形态整体拒绝。 */
function decodeLiveContinuity(raw: unknown): LiveSessionContinuity | undefined {
  if (!isPlainObject(raw)) return undefined
  const status = raw['status']
  if (status !== 'ok' && status !== 'blocked') return undefined
  const cause = raw['cause']
  const detail = raw['detail']
  if (!(cause === null || typeof cause === 'string')) return undefined
  if (!(detail === null || typeof detail === 'string')) return undefined
  return { status, cause, detail }
}

/**
 * 待定模型切换视图解码（必填键）：五态判别联合逐变体校验全部字段；
 * 未知 status/字段畸形 → undefined（整包拒绝，与 host 恒定下发的契约互锁）。
 */
function decodeLiveModelSwitch(raw: unknown): LiveModelSwitchView | undefined {
  if (!isPlainObject(raw)) return undefined
  const status = raw['status']
  if (status === 'idle') return { status: 'idle' }
  if (status === 'corrupt') return { status: 'corrupt' }
  if (status === 'busy') {
    if (typeof raw['operationId'] !== 'string' || typeof raw['targetModel'] !== 'string') return undefined
    return { status: 'busy', operationId: raw['operationId'], targetModel: raw['targetModel'] }
  }
  if (status === 'pending') {
    const state = raw['state']
    if (state !== 'started' && state !== 'agent-applied' && state !== 'agent-rolled-back' && state !== 'committed') return undefined
    for (const key of ['operationId', 'provider', 'optionId', 'previousModel', 'targetModel', 'createdAt'] as const) {
      if (typeof raw[key] !== 'string') return undefined
    }
    if ('appliedModel' in raw && (typeof raw['appliedModel'] !== 'string' || raw['appliedModel'] === '')) {
      return undefined
    }
    return {
      status: 'pending',
      operationId: raw['operationId'] as string,
      state,
      provider: raw['provider'] as string,
      optionId: raw['optionId'] as string,
      previousModel: raw['previousModel'] as string,
      targetModel: raw['targetModel'] as string,
      ...(typeof raw['appliedModel'] === 'string' && raw['appliedModel'] !== ''
        ? { appliedModel: raw['appliedModel'] }
        : {}),
      createdAt: raw['createdAt'] as string,
    }
  }
  if (status === 'rollback-required') {
    for (const key of ['operationId', 'provider', 'previousModel', 'targetModel'] as const) {
      if (typeof raw[key] !== 'string') return undefined
    }
    return {
      status: 'rollback-required',
      operationId: raw['operationId'] as string,
      provider: raw['provider'] as string,
      previousModel: raw['previousModel'] as string,
      targetModel: raw['targetModel'] as string,
    }
  }
  return undefined
}

/**
 * Validate a `GET`/`POST …/options` response body. Wire boundary: the whole
 * payload is refused (undefined) when any option is MALFORMED (logic.ts
 * `decodeHealthResponse` 同款口径); a well-formed option with an unrecognized
 * `type` string is skipped instead (protocol: the client SHOULD ignore it — the
 * agent default stands and no control is rendered for it). `capabilities` /
 * `continuity` / `contextUsage` 是必填键
 * （capabilities/contextUsage 是 null 词表——未握手/未收到过
 * usage_update 时如实归 null；continuity 恒有值）：缺席或畸形
 * 同样整包拒绝（与 host liveSnapshot 恒定下发七键的契约互锁）。
 * `freshness` / `editable` / `fingerprintChanged` / `modelSwitch`
 * 同为必填键，同一整包拒绝口径。
 */
export function decodeLiveOptionsSnapshot(body: unknown): LiveOptionsSnapshot | undefined {
  if (!isPlainObject(body)) return undefined
  if (typeof body['sessionId'] !== 'string') return undefined
  const rawOptions = body['configOptions']
  const rawMode = body['currentModeId']
  if (!(rawOptions === null || Array.isArray(rawOptions))) return undefined
  if (!(rawMode === null || typeof rawMode === 'string')) return undefined
  const capabilities = decodeLiveCapabilityFacts(body['capabilities'])
  if (capabilities === undefined) return undefined
  const continuity = decodeLiveContinuity(body['continuity'])
  if (continuity === undefined) return undefined
  const contextUsage = decodeLiveContextUsage(body['contextUsage'])
  if (contextUsage === undefined) return undefined
 // 必填键三件套（stale 快照只读纪律 + 指纹漂移诊断）
  const freshness = body['freshness']
  if (freshness !== 'live' && freshness !== 'stale') return undefined
  const editable = body['editable']
  if (typeof editable !== 'boolean') return undefined
  const fingerprintChanged = body['fingerprintChanged']
  if (typeof fingerprintChanged !== 'boolean') return undefined
 // 必填键：待定模型切换事务视图
  const modelSwitch = decodeLiveModelSwitch(body['modelSwitch'])
  if (modelSwitch === undefined) return undefined
  const fixed: Omit<LiveOptionsSnapshot, 'configOptions'> = {
    sessionId: body['sessionId'],
    currentModeId: rawMode,
    capabilities,
    continuity,
    contextUsage,
    freshness,
    editable,
    fingerprintChanged,
    modelSwitch,
  }
  if (rawOptions === null) {
    return { ...fixed, configOptions: null }
  }
  const configOptions: LiveConfigOption[] = []
  for (const raw of rawOptions) {
    const decoded = decodeLiveConfigOption(raw)
    if (decoded === undefined) return undefined
    if (decoded === SKIP_OPTION) continue
    configOptions.push(decoded)
  }
  return { ...fixed, configOptions }
}

// ---------- 活体选项分区（镜像 src/domain/session/options-sync.ts 分类口径） ----------

/** Conventional config-option id of the model selector (options-sync.ts `ACP_MODEL_OPTION_ID`). */
export const ACP_MODEL_OPTION_ID = 'model'
/** Conventional config-option id of the mode selector (options-sync.ts `ACP_MODE_OPTION_ID`). */
export const ACP_MODE_OPTION_ID = 'mode'

/**
 * model 类 live option 判定（category 'model' 或约定 id；与 host 侧
 * modelOfConfigOptions 同口径）。model 类选项**不再出现在活体控制
 * 面板**——模型热切换走模型目录 + ModelSwitchCoordinator（持久事务），面板
 * 分区时整体跳过。
 */
export function isModelClassLiveOption(option: LiveConfigOption): boolean {
  return option.category === 'model' || option.id === ACP_MODEL_OPTION_ID
}

/** The live-option sections of the ACP block（model 类不进面板，剩四类）。 */
export type LiveOptionSection = 'mode' | 'thought_level' | 'model_config' | 'other'

/**
 * Section of one live option. Mode mirrors options-sync's classification
 * (category first, conventional id as fallback — category is a UX hint and may
 * be absent); thought_level and model_config key on the category alone (no
 * conventional id exists); everything else — an absent category or an unknown
 * future category — lands in the `other` bucket (「其他设置」分组; categories are
 * UX hints only and MUST NOT be required for correctness). model 类选项不归任何
 * section——调用方先用 {@link isModelClassLiveOption} 剔除模型类选项。
 */
export function liveOptionSectionOf(option: LiveConfigOption): LiveOptionSection {
  if (option.category === 'mode' || option.id === ACP_MODE_OPTION_ID) return 'mode'
  if (option.category === 'thought_level') return 'thought_level'
  if (option.category === 'model_config') return 'model_config'
  return 'other'
}

/** The live options partitioned into display sections (input order preserved within each). */
export interface PartitionedLiveOptions {
  mode: LiveConfigOption[]
  thoughtLevel: LiveConfigOption[]
  modelConfig: LiveConfigOption[]
  other: LiveConfigOption[]
}

/**
 * Partition one snapshot's options into the four sections. model 类选项
 * 整体跳过（live 控制面板不再有模型区——模型切换的唯一入口是模型目录行的
 * ModelSwitchCoordinator）。
 */
export function partitionLiveOptions(options: readonly LiveConfigOption[]): PartitionedLiveOptions {
  const result: PartitionedLiveOptions = { mode: [], thoughtLevel: [], modelConfig: [], other: [] }
  for (const option of options) {
    if (isModelClassLiveOption(option)) continue
    const section = liveOptionSectionOf(option)
    if (section === 'mode') result.mode.push(option)
    else if (section === 'thought_level') result.thoughtLevel.push(option)
    else if (section === 'model_config') result.modelConfig.push(option)
    else result.other.push(option)
  }
  return result
}

// ---------- 崩溃恢复收敛判定（纯函数；ModelSwitchController.recover 的决策源） ----------

/**
 * 待定模型切换的恢复决策词表：
 * - `wait-resume`：DSH 目录未加载或 Agent 当前值不可读——无法自证，等 resume/
 *   目录加载后重试（本 turn 的 options-sync 守卫是最后防线）；
 * - `clear`：DSH 与 Agent 当前值一致（含 target/target 与 previous/previous
 *   两种已收敛形态）——清行收束；
 * - `complete-dsh`：Agent 已在 target、DSH 还在 previous（崩溃点②）——补
 *   selectModel(target) 后 commit；
 * - `rollback-agent`：DSH 在 previous、Agent 不在 previous 也不在 target
 *   （崩溃点① Agent 已动但 DSH 未动）——host 侧写回 previous 并落
 *   `agent-rolled-back`，随后 client finalize 清行；
 * - `rollback-dsh`：Agent 在 previous、DSH 在 target（DSH 拒绝后的中间态）——
 *   selectModel(previous) 后清行；
 * - `undecidable`：出现第三值——一致性无法自证，保留事务行由用户选择出路
 *   （UI 展示 + live 时 composer 阻断）。
 */
export type ModelSwitchRecoveryDecision =
  | 'wait-resume'
  | 'clear'
  | 'complete-dsh'
  | 'rollback-agent'
  | 'rollback-dsh'
  | 'undecidable'

/**
 * 崩溃恢复收敛判定（只收敛到可证明的状态）：输入持久行的 previous/target 与
 * 两侧当前值，输出唯一决策。规则有序——先等证据（null），再认已收敛（相等），
 * 然后两个可证明的半步形态，dsh===previous 兜底回滚 Agent，其余一律
 * undecidable（绝不猜测）。
 */
export function decideModelSwitchRecovery(args: {
  readonly previousModel: string
  readonly targetModel: string
  /** DSH 侧当前模型（同 provider 的目录 current；未加载归 null）。 */
  readonly dshModel: string | null
  /** Agent 侧当前模型（live 快照的 model 类 option 当前值；无活体/不可读归 null）。 */
  readonly agentModel: string | null
}): ModelSwitchRecoveryDecision {
  const { previousModel, targetModel, dshModel, agentModel } = args
  if (dshModel === null || agentModel === null) return 'wait-resume'
  if (dshModel === agentModel) return 'clear'
  if (agentModel === targetModel && dshModel === previousModel) return 'complete-dsh'
  if (dshModel === previousModel) return 'rollback-agent'
  if (agentModel === previousModel && dshModel === targetModel) return 'rollback-dsh'
  return 'undecidable'
}

/** One flattened selectable value row of a live select option (groups carry their name along). */
export interface LiveValueRow {
  value: string
  name: string
  description?: string
  /** Present when the value arrived nested in a group. */
  groupName?: string
}

/** Flatten a select option's values (group/flat 两种布局拍平，llm-stub probeModels 同款守卫). */
export function flattenLiveValues(option: LiveConfigOption & { type: 'select' }): LiveValueRow[] {
  const rows: LiveValueRow[] = []
  for (const entry of option.options) {
    if ('options' in entry) {
      for (const item of entry.options) {
        rows.push({
          value: item.value,
          name: item.name,
          ...(item.description === undefined ? {} : { description: item.description }),
          groupName: entry.name,
        })
      }
    } else {
      rows.push({
        value: entry.value,
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
      })
    }
  }
  return rows
}

/**
 * The snapshot with one option's current value replaced (optimistic refresh).
 * The write vocabulary is the POST body in protocol-native types ( type
 * fidelity): `value` is a string value id for select options and a real boolean
 * for boolean options — never a 'true'/'false' string. Switching a mode-class
 * option with a string value also moves `currentModeId` (the agent would push
 * `current_mode_update`). Unknown ids return the same snapshot reference.
 */
export function withLiveOptionValue(
  snapshot: LiveOptionsSnapshot,
  configId: string,
  value: string | boolean,
): LiveOptionsSnapshot {
  if (snapshot.configOptions === null) return snapshot
  const index = snapshot.configOptions.findIndex((candidate) => candidate.id === configId)
  const option = snapshot.configOptions[index]
  if (option === undefined) return snapshot
  let next: LiveConfigOption
  // 类型错配属调用方 bug（POST 会被端点 400 拒绝并回滚）；乐观更新容错收敛：
  // select 收到非 string 按 String 落字面值，boolean 收到非 boolean 仅 'true' 置真。
  if (option.type === 'select') next = { ...option, currentValue: typeof value === 'string' ? value : String(value) }
  else next = { ...option, currentValue: typeof value === 'boolean' ? value : value === 'true' }
  const configOptions = [...snapshot.configOptions]
  configOptions[index] = next
  return {
    ...snapshot,
    configOptions,
    // currentModeId 的词汇是 string mode id：boolean 写入不连带
    ...(liveOptionSectionOf(option) === 'mode' && typeof value === 'string' ? { currentModeId: value } : {}),
  }
}

/** Display name of one live value: the advertised name, or the raw value when unlisted. */
export function liveValueNameOf(option: LiveConfigOption, value: string): string {
  if (option.type !== 'select') return value
  return flattenLiveValues(option).find((row) => row.value === value)?.name ?? value
}

// ---------- “设为默认”（agent-default-model ns，core/agent-default-model 同款形状） ----------

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** The stored `agent-default-model` section (wire copy of `AgentDefaultModelSettings`). */
export interface AgentDefaultModelSettings {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Validating decoder for the default-model scope: absent → undefined section; malformed → undefined. */
export function decodeAgentDefaultModel(value: unknown): AgentDefaultModelSettings | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return undefined
  if (typeof value['provider'] !== 'string' || value['provider'] === '') return undefined
  if (typeof value['model'] !== 'string' || value['model'] === '') return undefined
  const reasoningEffort = stringOrUndefined(value['reasoningEffort'])
  return {
    provider: value['provider'],
    model: value['model'],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** One path-addressed settings op (same shape as controller.ts `AcpSettingsOp`). */
export type PickerSettingsOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/**
 * Build the mutate ops writing one selection as the default model.
 * `currentHasEffort` tells whether the stored section currently carries a
 * `reasoningEffort` key: an absent effort in the new selection must UNSET the
 * stale key (set/unset asymmetry of exactOptionalPropertyTypes configs), but
 * only when it exists, so a first-time write stays a pure set pair.
 */
export function defaultModelOps(selection: PickerModelSelection, currentHasEffort: boolean): PickerSettingsOp[] {
  const ops: PickerSettingsOp[] = [
    { op: 'set', path: ['provider'], value: selection.provider },
    { op: 'set', path: ['model'], value: selection.model },
  ]
  if (selection.reasoningEffort !== undefined) {
    ops.push({ op: 'set', path: ['reasoningEffort'], value: selection.reasoningEffort })
  } else if (currentHasEffort) {
    ops.push({ op: 'unset', path: ['reasoningEffort'] })
  }
  return ops
}

/** Whether the stored default points at the given provider/model pair (the row's “默认” marker). */
export function isDefaultSelection(
  stored: AgentDefaultModelSettings | undefined,
  provider: string,
  model: string,
): boolean {
  return stored?.provider === provider && stored?.model === model
}

// ---------- DSH 权限投影（仅用于 ACP 选择时请求宿主原生确认） ----------

/**
 * Decode the `permissions` session projection's current preset id (the host
 * `PermissionSelect.currentValue`; ui-permission-presets reads the same face).
 * Undefined when the capability is absent or the value is malformed.
 *
 * 口径：DSH 权限范围是安全边界（宿主 sandbox 强制的能力上限），与 ACP
 * agent mode（agent 侧行为配置）是两个独立维度。本插件只读该档位，
 * 并在选择 ACP 时复用 DSH 原生 Full Access 确认。
 */
export function presetOfPermissionsProjection(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  return typeof value['currentValue'] === 'string' ? value['currentValue'] : undefined
}

// ---------- ACP context 统计行（dock 组件的纯逻辑；渲染规则在此层钉测试） ----------

/**
 * Compact token count（上游 ui-conversation StatsLine `formatTokens` 的本地
 * 等效小 helper——上游包不可 import）：517 / 12.2K / 517K / 1.2M（三位以内一位小数）。
 */
export function formatCompactTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** ACP Agent 上报的会话累计成本；只做显示格式化，不进行定价或汇率计算。 */
export function formatAcpReportedCost(amount: number, currency: string): string {
  const code = currency.toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount)
  } catch {
    const rounded = String(Math.round(amount * 10_000) / 10_000)
    return `${rounded} ${currency}`
  }
}

/**
 * ACP context 统计行的渲染规则 + 文案：仅当会话 backend 已锁定且为
 * acp-* 路由、且已有上下文占用快照时返回一行文案；否则 null——诚实空缺
 * （不渲染、不显示 0；backendOf RPC 失败归 null 同样不渲染）。agent 明确
 * 提供 cost 时追加“Agent 上报的会话累计成本”（不做定价、汇率换算或聚合，
 * 也不写入 DSH 原生单轮模型成本统计）。
 * @param backend - host `backendOf` 的应答（null = 查询失败/未知）。
 * @param usage - live options 快照的 contextUsage（null = 未收到过 usage_update）。
 * @param t - dock entry 的 locale seat。
 * @returns 展示文案；不渲染为 null。
 */
export function acpContextUsageLine(
  backend: PickerBackendState | null,
  usage: LiveContextUsage | null,
  t: (key: 'context.usage' | 'context.cost', params?: Record<string, string | number>) => string,
): string | null {
  if (backend === null || backend.state !== 'established' || !isAcpProvider(backend.provider)) return null
  if (usage === null) return null
  const base = t('context.usage', {
    used: formatCompactTokens(usage.used),
    size: formatCompactTokens(usage.size),
    percent: usage.percent,
  })
  if (usage.cost === null) return base
  return `${base} · ${t('context.cost', {
    amount: formatAcpReportedCost(usage.cost.amount, usage.cost.currency),
    currency: usage.cost.currency,
  })}`
}
