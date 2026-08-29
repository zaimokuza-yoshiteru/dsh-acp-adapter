/**
 * Pure catalog and backend compatibility logic for the model picker.
 *
 * The selector facade re-exports this module so existing imports remain
 * stable; this module has no UI, store, or host dependency.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Shared catalog shapes used by the facade and the catalog-only helpers. */
export interface PickerModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface PickerReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface PickerModelReasoning {
  efforts: PickerReasoningEffort[]
  defaultEffort?: string
}

export interface PickerCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: PickerModelReasoning
}

export interface PickerProviderGroup {
  id: string
  name: string
  models: PickerCatalogModel[]
}

/** 模型选择器触发按钮的三段展示；推理强度单独返回以复用 DSH 原生弱化样式。 */
export interface PickerTriggerPresentation {
  modelLabel: string
  triggerLabel: string
  reasoningEffort?: string
}


/** ACP route id convention (src/domain/session/agent-config.ts `acpRouteId`): every ACP provider route carries this prefix. */
export const ACP_ROUTE_PREFIX = 'acp-'

/** Normalized provider bucket of one route id: ACP routes vs. native API providers. */
export type ProviderKind = 'api' | 'acp'

/** Classify one provider route id: `acp-` means ACP; other routes are native API. */
export function providerKindOf(providerId: string): ProviderKind {
  return providerId.startsWith(ACP_ROUTE_PREFIX) ? 'acp' : 'api'
}

/** Whether a selection/provider route belongs to an ACP agent (null-safe for the pre-load state). */
export function isAcpProvider(provider: string | null | undefined): boolean {
  return provider !== null && provider !== undefined && provider.startsWith(ACP_ROUTE_PREFIX)
}

/** Display label of each provider bucket (the group name is adapter free text; the tag is not). */
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = { api: 'Model', acp: 'ACP' }

/** 注册表 displayName 的 ACP 组名后缀（`<name> · ACP`，）。 */
const ACP_GROUP_NAME_SUFFIX = ' · ACP'

/**
 * ACP 区块分区题注的 agent 显示名推导（「Agent 模式（{agent}）」的参数源——
 * 不再硬编码单个 agent 名）：目录 groups 中按路由 id 找到组名并剥掉
 * ` · ACP` 后缀（host 注册表的 displayName 形态）；目录未加载/组缺席时兜底
 * `acp-<id>` 去前缀的裸 agent id。调用方只在 ACP 面板渲染时调用（provider 是
 * 已知 acp 路由）。
 */
export function acpAgentDisplayName(groups: readonly PickerProviderGroup[], provider: string): string {
  const group = groups.find((candidate) => candidate.id === provider)
  if (group !== undefined) {
    const stripped = group.name.endsWith(ACP_GROUP_NAME_SUFFIX)
      ? group.name.slice(0, group.name.length - ACP_GROUP_NAME_SUFFIX.length)
      : group.name
    if (stripped !== '') return stripped
  }
  return provider.startsWith(ACP_ROUTE_PREFIX) ? provider.slice(ACP_ROUTE_PREFIX.length) : provider
}

/**
 * Devin 的模型名称已包含推理档位，因此只对规范的 `acp-devin` 路由省略第三段。
 * 用户可编辑的 Agent 显示名不是可靠身份；自定义 profile 仍使用通用三段展示。
 */
export function isDevinAcpAgent(provider: string): boolean {
  return provider === 'acp-devin'
}

/**
 * ACP 模型触发器的紧凑标签。仅在 Agent 的模型/配置广告提供真实推理强度时追加
 * 第三段；没有该事实时调用方传 `undefined`。原生 DSH 模型不使用此函数。
 */
export function acpModelTriggerLabel(input: {
  provider: string
  agentName: string
  modelName: string
  reasoningEffort?: string
}): string {
  const base = `${input.agentName} · ${input.modelName}`
  if (isDevinAcpAgent(input.provider)) return base
  const effort = input.reasoningEffort?.trim()
  return effort === undefined || effort === '' ? base : `${base} · ${effort}`
}

/**
 * 统一生成模型选择器触发按钮文案。
 *
 * 原生模型严格保留 DSH 的「模型 · 推理强度」语义；ACP 只增加 Agent 名称，
 * Devin 因模型名已包含档位而继续省略重复的第三段。
 */
export function modelTriggerPresentation(input: {
  provider: string
  modelName: string
  agentName?: string
  reasoningEffort?: string
}): PickerTriggerPresentation {
  const effort = input.reasoningEffort?.trim()
  const reasoningEffort = effort === undefined || effort === '' ? undefined : effort
  if (!isAcpProvider(input.provider)) {
    return {
      modelLabel: input.modelName,
      triggerLabel: reasoningEffort === undefined
        ? input.modelName
        : `${input.modelName} · ${reasoningEffort}`,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }
  const agentName = input.agentName?.trim() || input.provider.slice(ACP_ROUTE_PREFIX.length)
  const modelLabel = `${agentName} · ${input.modelName}`
  const visibleEffort = isDevinAcpAgent(input.provider) ? undefined : reasoningEffort
  return {
    modelLabel,
    triggerLabel: visibleEffort === undefined ? modelLabel : `${modelLabel} · ${visibleEffort}`,
    ...(visibleEffort === undefined ? {} : { reasoningEffort: visibleEffort }),
  }
}

/** DSH 原生的当前模型重选判定只比较路由，不把推理强度当成另一模型。 */
export function sameModelRoute(
  current: PickerModelSelection | null | undefined,
  selection: PickerModelSelection,
): boolean {
  return current?.provider === selection.provider && current.model === selection.model
}

/**
 * The provider filter of the picker's filter bar includes a 'current'
 * （「当前」Tab）——只按会话 backend 的精确 provider/profile 路由过滤现有 DSH
 * 模型目录；该 Tab 的存在性由 {@link currentTabAvailable} 决定（host
 * `backendOf` 权威），绝不从全局默认模型或 `state.current` 推断。
 */
export type ProviderFilter = 'current' | 'all' | ProviderKind

/** Backend state returned by the host; established means a provider route is locked. */
export type PickerBackendState =
  | { state: 'blank' }
  | { state: 'draft'; provider: string; model?: string }
  | { state: 'established'; provider: string }

/** Validating decoder for the `backendOf` wire reply; malformed → undefined. */
export function decodeBackendState(raw: unknown): PickerBackendState | undefined {
  if (!isPlainObject(raw)) return undefined
  if (raw['state'] === 'blank') return { state: 'blank' }
  if (raw['state'] === 'draft' && typeof raw['provider'] === 'string' && raw['provider'] !== '') {
    if (raw['model'] !== undefined && (typeof raw['model'] !== 'string' || raw['model'] === '')) return undefined
    return {
      state: 'draft',
      provider: raw['provider'],
      ...(typeof raw['model'] === 'string' ? { model: raw['model'] } : {}),
    }
  }
  if (raw['state'] === 'established' && typeof raw['provider'] === 'string' && raw['provider'] !== '') {
    return { state: 'established', provider: raw['provider'] }
  }
  return undefined
}

/**
 * 一条 provider 路由的 backend 身份。backend 的词表就是路由 id 本身
 * （`acp-<id>` 前缀 = ACP profile，其余 = native）——本函数是这个对应关系的
 * 命名语义点，不是变换。
 */
export function backendOfProvider(provider: string): string {
  return provider
}

/**
 * 兼容性判定：该 selection 是否与会话已锁定的 backend 同 backend。
 * blank 表示宿主没有 ACP wrapper/binding。Alpha 的空白 launcher 可能把全局默认
 * ACP 模型投影为 currentProvider，但其真实 AgentHandle 仍是 native，不能据此把
 * ACP 选择误判为可原地采用；ACP 必须创建真实的新 DSH session。
 * established →
 * 只有同一路由的行可选（同 ACP profile 的不同模型行走 set_config_option 既有
 * 路径）；其余 = 跨 backend，picker 标记并分流到「在新会话中使用」。
 */
export function isSameBackendSelection(
  selection: Pick<PickerModelSelection, 'provider'>,
  backend: PickerBackendState,
  _currentProvider?: string | null,
): boolean {
  // A blank DSH session owns no ACP wrapper. Its displayed current provider can
  // be the live global default rather than the immutable AgentHandle identity,
  // so it is evidence only for native-to-native selection. ACP always needs a
  // newly materialized session whose factory actually constructs AcpAgent.
  if (backend.state === 'blank') return !isAcpProvider(selection.provider)
  // A draft has a live ACP wrapper, but no committed semantic binding. Alpha
  // cannot replace that wrapper either: only the same ACP profile can switch
  // in place; another profile/native backend must open a new DSH session.
  if (backend.state === 'draft') return backend.provider === backendOfProvider(selection.provider)
  return backend.provider === backendOfProvider(selection.provider)
}

/** Native fail-soft predicate shared by the composer picker and `/model`.
 * Unknown/ACP current backends intentionally return false so command paths
 * cannot bypass the cross-backend confirmation gate. */
export function isNativeToNativeSelection(
  currentProvider: string | null | undefined,
  selectionProvider: string,
): boolean {
  return currentProvider !== undefined
    && currentProvider !== null
    && !isAcpProvider(currentProvider)
    && !isAcpProvider(selectionProvider)
}

/**
 * ACP Remote 不可用时的可见目录：无法取得权威 backend 就不能提供可能改变
 * execution backend 的行。native 当前会话仅保留 native 目录；ACP 当前会话只
 * 保留当前已选模型（可见但不可借故障窗口切换）。
 */
export function failClosedGroupsForUnavailableProbe(
  groups: readonly PickerProviderGroup[],
  current: PickerModelSelection | null,
): PickerProviderGroup[] {
  if (current !== null && isAcpProvider(current.provider)) {
    const group = groups.find((candidate) => candidate.id === current.provider)
    const model = group?.models.find((candidate) => candidate.id === current.model)
    return group === undefined || model === undefined ? [] : [{ ...group, models: [model] }]
  }
  return groups.filter((group) => !isAcpProvider(group.id))
}

// ---------- ACP 子系统可用性探测（native-only 降级的输入面） ----------

/**
 * `backendOf` 探测的三值结果。`ok` = RPC 与解码都成功（`state` 为
 * null 表示「未知」——合法的空答，照旧不标记）；`unavailable` = ACP Remote
 * 失败/超时/非法载荷——picker 进入 native-only 模式：Current/ACP 档隐藏，
 * 非阻塞诊断上屏，原生目录与选择不受影响（native 语义零 ACP side effects
 * 由 popup/目录路径自身保证）。
 */
export type AcpBackendProbe =
  | { status: 'ok'; state: PickerBackendState | null }
  | { status: 'unavailable'; message: string }

/**
 * filter bar 的分档。ACP 子系统不可用（probe unavailable）时
 * Current/ACP 档隐藏（native-only）；probe 尚未到达（null）保持到场前的
 * 原生三档外观。Current 档仍只由「已建立 ACP binding」事实（currentTab）
 * 开启，绝不从目录或默认模型推断。
 */
export function filterBucketsOf(probe: AcpBackendProbe | null, currentTab: boolean): readonly ProviderFilter[] {
  if (probe?.status === 'unavailable') return ['all', 'api']
  return currentTab ? ['current', 'all', 'api', 'acp'] : ['all', 'api', 'acp']
}

/** native-only 下落定前已选中 Current/ACP 档时折叠回 'all'（其余原样）。 */
export function nativeOnlyFilterOf(filter: ProviderFilter, probe: AcpBackendProbe | null): ProviderFilter {
  return probe?.status === 'unavailable' && (filter === 'current' || filter === 'acp') ? 'all' : filter
}

/** 非阻塞诊断的消息参数——unavailable 时给出失败消息，否则 null（不上屏）。 */
export function acpUnavailableMessageOf(probe: AcpBackendProbe | null): string | null {
  return probe?.status === 'unavailable' ? probe.message : null
}

// ---------- /model popup 行（收进兼容岛） ----------
//
// 内置 optionsOf/selectionOf 的复制（verbatim fork + [Model]/[ACP] 标签修改型
// fork）与 PickerSelectOption 行契约已移入 client 侧兼容岛：
// src/client/host-compat/model-picker/popup.ts（漂移钉版同随）。

// ---------- 活体选项（窄化 contract 见 src/contract/remote.ts + ACP schema v1） ----------

/** One flat select value of a live config option (ACP `SessionConfigSelectOption`). */
