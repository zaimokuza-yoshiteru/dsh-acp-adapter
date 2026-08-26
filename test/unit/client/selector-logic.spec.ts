// selector-logic.spec.ts —  随附测试：增强模型选择器纯逻辑
// （src/client/data/selector-logic.ts， 新建）黑盒契约测试。
//
// 被测模块零 import（无 DOM/fetch/React/host 模块），直接 vitest 可测。契约值交叉
// 核对自：dsh-api-remotes sessions.ts 的 wire 形状（reference/deepseek-harness
// packages/host/apiproxy/src/api/sessions.schema.ts：session.models 响应值字段
// current/routable/groups/failures）、src/contract/remote.ts（AcpLiveOptionsSnapshot）、
// src/domain/session/options-sync.ts（model/thought_level/mode
// 分类口径）、core/agent-default-model（ns + {provider, model, reasoningEffort?}）。
// 此处以字面值钉死，测试只 import 被测模块。
//
// 覆盖：
//   - 常量与路由分类：ACP_ROUTE_PREFIX / PROVIDER_KIND_LABELS / INITIAL_DIRECTORY_STATE /
//     providerKindOf / isAcpProvider（null-safe）
//   - filterGroups（档位过滤 + 文本命中 group.name/model.name/description，组内无幸存
//     模型整组丢弃，空白搜索全保留）/ filterFailures（只吃档位不吃文本）
//   - rowId / optionsOf（[Model]/[ACP] 标签 + active 行 + failure 行不可选）/
//     selectionOf（同路由保留 effort，否则落模型 defaultEffort，未知行 undefined）
//   - decodeLiveOptionsSnapshot（整包拒绝制、null description/category 归一、
//     configOptions:null 归一为"agent 未提供"、未知 type 字符串的选项逐项跳过不传染、
// capabilities 的 null 词表与畸形拒绝；路径构造
//     acpSessionOptionsPath 已随 dshAcp Remote 迁移删除）
//   - pickerDegradationsOf（披露面板可用性提示逐条命中、顺序固定、全绿空列表）
//   - liveOptionSectionOf（mode 先于 model；category model_config 入模型配置；category 缺席
//     或未知 → other）/ partitionLiveOptions 五分区 / flattenLiveValues（group/flat 拍平带
//     groupName）/ withLiveOptionValue（原生类型保真：select 收 string、boolean 收原生
//     boolean；mode 类连带 currentModeId 仅限 string 值；未知 id 原引用返回）/ liveValueNameOf
//   - decodeAgentDefaultModel / defaultModelOps（effort 缺席且有旧值才 unset）/
//     isDefaultSelection（只比 provider/model）
//   - presetOfPermissionsProjection（权限范围只读展示的数据源：currentValue 透传，
// 非 plain object / 非 string → undefined； ack 清单与 gate 判定已删除）
// - native-only 降级面：filterBucketsOf / nativeOnlyFilterOf /
//     acpUnavailableMessageOf（AcpBackendProbe 三值派生）
//
// rowId/optionsOf/selectionOf 随兼容岛迁至
// src/client/host-compat/model-picker/popup.ts（本文件直接 import 岛模块钉其行为）。

import { describe, expect, it } from 'vitest';
import {
  ACP_MODEL_OPTION_ID,
  ACP_MODE_OPTION_ID,
  ACP_ROUTE_PREFIX,
  AGENT_DEFAULT_MODEL_NS,
  INITIAL_DIRECTORY_STATE,
  PROVIDER_KIND_LABELS,
  acpAgentDisplayName,
  acpContextUsageLine,
  backendOfProvider,
  currentRouteFactsOf,
  currentTabAvailable,
  currentValueNotInCatalog,
  decodeAgentDefaultModel,
  decodeBackendState,
  decodeLiveOptionsSnapshot,
  decideModelSwitchRecovery,
  defaultFilterOf,
  defaultModelOps,
  filterFailures,
  failClosedGroupsForUnavailableProbe,
  filterGroups,
  flattenLiveValues,
  formatCompactTokens,
  isAcpProvider,
  isDefaultSelection,
  isModelClassLiveOption,
  isSameBackendSelection,
  isNativeToNativeSelection,
  liveOptionSectionOf,
  liveValueNameOf,
  partitionLiveOptions,
  pickerDegradationsOf,
  presetOfPermissionsProjection,
  providerKindOf,
  showsAcpCatalogScopeNote,
  filterBucketsOf,
  nativeOnlyFilterOf,
  acpUnavailableMessageOf,
  withLiveOptionValue,
  type AcpBackendProbe,
  type CurrentRouteFacts,
  type LiveConfigOption,
  type LiveOptionsSnapshot,
  type ModelDirectoryState,
  type PickerBackendState,
  type PickerCatalogFailure,
  type PickerProviderGroup,
  type PickerTranslate,
  type SessionModelsView,
} from '../../../src/client/data/selector-logic.ts';
// /model popup 行的 verbatim/修改型 fork 收进 client 侧兼容岛。
import {
  optionsOf,
  rowId,
  selectionOf,
} from '../../../src/client/host-compat/model-picker/popup.ts';

// ---------- 夹具：原生目录（wire 形状对齐 sessions.schema.ts） ----------

const apiGroup: PickerProviderGroup = {
  id: 'deepseek',
  name: 'DeepSeek',
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    },
  ],
};

const acpGroup: PickerProviderGroup = {
  id: 'acp-devin',
  name: 'Devin',
  models: [
    { id: 'devin-latest', name: 'Devin Latest', description: '云端智能体' },
    { id: 'devin-sonnet', name: 'Devin Sonnet' },
  ],
};

const apiFailure: PickerCatalogFailure = { id: 'deepseek', name: 'DeepSeek', message: 'HTTP 401' };
const acpFailure: PickerCatalogFailure = { id: 'acp-foo', name: 'Foo', message: 'spawn failed' };

const directory: SessionModelsView = {
  current: { provider: 'deepseek', model: 'deepseek-chat' },
  routable: true,
  groups: [apiGroup, acpGroup],
  failures: [apiFailure, acpFailure],
};

// ---------- 夹具：活体选项（wire 形状对齐 src/contract/remote.ts AcpLiveOptionsSnapshot） ----------

const modeOption: LiveConfigOption = {
  type: 'select',
  id: 'mode',
  name: '模式',
  category: 'mode',
  currentValue: 'code',
  options: [
    { value: 'code', name: 'Code' },
    { group: 'experimental', name: '实验', options: [{ value: 'plan', name: 'Plan', description: '只读规划' }] },
  ],
};

const modelOption: LiveConfigOption = {
  type: 'select',
  id: 'model',
  name: '模型',
  currentValue: 'devin-latest',
  options: [
    { value: 'devin-latest', name: 'Devin Latest' },
    { value: 'devin-sonnet', name: 'Devin Sonnet' },
  ],
};

const thoughtOption: LiveConfigOption = {
  type: 'select',
  id: 'effort',
  name: '思考强度',
  category: 'thought_level',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};

const boolOption: LiveConfigOption = { type: 'boolean', id: 'telemetry', name: '遥测', currentValue: false };

const modelConfigOption: LiveConfigOption = {
  type: 'boolean',
  id: 'auto_compact',
  name: '自动压缩',
  category: 'model_config',
  currentValue: true,
};

const otherOption: LiveConfigOption = {
  type: 'select',
  id: 'theme',
  name: '主题',
  category: 'appearance',
  currentValue: 'dark',
  options: [{ value: 'dark', name: 'Dark' }],
};

const liveOptions: LiveConfigOption[] = [modeOption, modelOption, thoughtOption, boolOption, modelConfigOption, otherOption];

/** 快照夹具共享的 ok 连续性闩锁（wire 形状；宿主恒发）。 */
const CONTINUITY_OK = { status: 'ok', cause: null, detail: null } as const;

/** 必填键的 live 恒值（活体快照夹具共享）。 */
const LIVE_FIXED = {
  freshness: 'live',
  editable: true,
  fingerprintChanged: false,
  modelSwitch: { status: 'idle' },
} as const;

const liveSnapshot: LiveOptionsSnapshot = {
  sessionId: 's1',
  configOptions: liveOptions,
  currentModeId: 'code',
  capabilities: null,
  continuity: CONTINUITY_OK,
  contextUsage: null,
  ...LIVE_FIXED,
};

// ---------- 常量与路由分类 ----------

describe('常量与路由分类', () => {
  it('路由前缀 / 提供方标签 / 选项约定 id / 设置命名空间', () => {
    expect(ACP_ROUTE_PREFIX).toBe('acp-');
    expect(PROVIDER_KIND_LABELS).toEqual({ api: 'Model', acp: 'ACP' });
    expect(ACP_MODEL_OPTION_ID).toBe('model');
    expect(ACP_MODE_OPTION_ID).toBe('mode');
    expect(AGENT_DEFAULT_MODEL_NS).toBe('agent-default-model');
  });

  it('INITIAL_DIRECTORY_STATE 即内置目录的首载前值（null 不等于 blocked）', () => {
    expect(INITIAL_DIRECTORY_STATE).toEqual({
      current: null,
      routable: null,
      groups: [],
      failures: [],
      status: 'idle',
      error: null,
    });
  });

  it('providerKindOf：命中 acp- 前缀 → acp，其余 → api', () => {
    expect(providerKindOf('acp-devin')).toBe('acp');
    expect(providerKindOf('acp-')).toBe('acp'); // 裸前缀同样命中 startsWith
    expect(providerKindOf('deepseek')).toBe('api');
    expect(providerKindOf('')).toBe('api');
    expect(providerKindOf('acp')).toBe('api'); // 无连字符不算
  });

  it('isAcpProvider：null/undefined 安全（首载前状态）', () => {
    expect(isAcpProvider('acp-devin')).toBe(true);
    expect(isAcpProvider('deepseek')).toBe(false);
    expect(isAcpProvider(null)).toBe(false);
    expect(isAcpProvider(undefined)).toBe(false);
  });
});

// ---------- 目录过滤 ----------

describe('filterGroups / filterFailures', () => {
  it('档位过滤：all 全留，api/acp 各留各的整组', () => {
    expect(filterGroups([apiGroup, acpGroup], 'all', '')).toEqual([apiGroup, acpGroup]);
    expect(filterGroups([apiGroup, acpGroup], 'api', '')).toEqual([apiGroup]);
    expect(filterGroups([apiGroup, acpGroup], 'acp', '')).toEqual([acpGroup]);
    expect(filterGroups([], 'all', '')).toEqual([]);
  });

  it('文本命中 model.name / description（大小写不敏感、首尾空白忽略），未命中模型被剔除', () => {
    expect(filterGroups([apiGroup, acpGroup], 'all', 'chat')).toEqual([
      { ...apiGroup, models: [apiGroup.models[0]] },
    ]);
    expect(filterGroups([apiGroup, acpGroup], 'all', '  CHAT  ')).toEqual([
      { ...apiGroup, models: [apiGroup.models[0]] },
    ]);
    // description 命中
    expect(filterGroups([apiGroup, acpGroup], 'all', '云端')).toEqual([
      { ...acpGroup, models: [acpGroup.models[0]] },
    ]);
    // 通用描述命中另一组
    expect(filterGroups([apiGroup, acpGroup], 'all', '通用')).toEqual([
      { ...apiGroup, models: [apiGroup.models[0]] },
    ]);
  });

  it('文本命中 group.name → 该组全部模型幸存；组内无幸存模型整组丢弃', () => {
    expect(filterGroups([apiGroup, acpGroup], 'all', 'devin')).toEqual([acpGroup]);
    expect(filterGroups([apiGroup, acpGroup], 'all', 'deepseek')).toEqual([apiGroup]);
    // model id 不是搜索面（只有 name/description/group.name）
    expect(filterGroups([apiGroup, acpGroup], 'all', 'devin-sonnet')).toEqual([]);
    expect(filterGroups([apiGroup, acpGroup], 'all', '不存在的词')).toEqual([]);
  });

  it('档位与文本叠加：先档位后文本', () => {
    expect(filterGroups([apiGroup, acpGroup], 'acp', 'devin')).toEqual([acpGroup]);
    expect(filterGroups([apiGroup, acpGroup], 'api', 'devin')).toEqual([]);
    expect(filterGroups([apiGroup, acpGroup], 'acp', 'chat')).toEqual([]);
  });

  it('filterFailures 只吃档位不吃文本（失败是健康信号，不随搜索消失）', () => {
    expect(filterFailures([apiFailure, acpFailure], 'all')).toEqual([apiFailure, acpFailure]);
    expect(filterFailures([apiFailure, acpFailure], 'api')).toEqual([apiFailure]);
    expect(filterFailures([apiFailure, acpFailure], 'acp')).toEqual([acpFailure]);
    expect(filterFailures([], 'all')).toEqual([]);
  });
});

// ---------- /model popup 行 ----------

describe('rowId / optionsOf / selectionOf', () => {
  it('rowId 是不透明行键：provider/model 单斜杠拼接', () => {
    expect(rowId('deepseek', 'deepseek-chat')).toBe('deepseek/deepseek-chat');
    expect(rowId('acp-devin', 'devin-latest')).toBe('acp-devin/devin-latest');
  });

  it('optionsOf：拍平分组 + [Model]/[ACP] 标签 detail + 当前行 active + failure 行尾随不可选', () => {
    const t: PickerTranslate = (key, params) => `${key}:${params?.['message'] ?? ''}`;
    const rows = optionsOf(directory, t);
    expect(rows).toEqual([
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', detail: '[Model] DeepSeek · 通用对话', active: true },
      { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner', detail: '[Model] DeepSeek' },
      { id: 'acp-devin/devin-latest', label: 'Devin Latest', detail: '[ACP] Devin · 云端智能体' },
      { id: 'acp-devin/devin-sonnet', label: 'Devin Sonnet', detail: '[ACP] Devin' },
      { id: 'failure/deepseek', label: 'DeepSeek', detail: 'option.loadError:HTTP 401' },
      { id: 'failure/acp-foo', label: 'Foo', detail: 'option.loadError:spawn failed' },
    ]);
    // failure 行永不携带 active（内置语义：可见但不可选）
    expect(rows[4]).not.toHaveProperty('active');
    expect(rows[5]).not.toHaveProperty('active');
  });

  it('optionsOf 空目录 → 空行集', () => {
    const t: PickerTranslate = (key) => key;
    expect(optionsOf({ current: { provider: 'p', model: 'm' }, routable: false, groups: [], failures: [] }, t)).toEqual([]);
  });

  const readyState: ModelDirectoryState = {
    current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    routable: true,
    groups: [apiGroup, acpGroup],
    failures: [apiFailure],
    status: 'ready',
    error: null,
  };

  it('selectionOf：命中行回解析为选择；未知行/failure 行 → undefined', () => {
    expect(selectionOf(readyState, 'acp-devin/devin-sonnet')).toEqual({ provider: 'acp-devin', model: 'devin-sonnet' });
    expect(selectionOf(readyState, 'ghost/m')).toBeUndefined();
    expect(selectionOf(readyState, 'failure/deepseek')).toBeUndefined();
  });

  it('selectionOf：同路由保留当前 effort；异路由落模型 defaultEffort', () => {
    // 同路由：current.reasoningEffort 优先
    expect(selectionOf(readyState, 'deepseek/deepseek-reasoner')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    // 异路由：模型自带 defaultEffort
    expect(selectionOf(directoryToState({ provider: 'deepseek', model: 'deepseek-chat' }), 'deepseek/deepseek-reasoner')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    });
    // 同路由但当前无 effort：回退模型 defaultEffort
    expect(selectionOf(directoryToState({ provider: 'deepseek', model: 'deepseek-reasoner' }), 'deepseek/deepseek-reasoner')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    });
    // 模型无 reasoning：不出 effort 键
    expect(selectionOf(readyState, 'deepseek/deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    // 首载前（current null）：按异路由处理
    expect(selectionOf({ ...INITIAL_DIRECTORY_STATE, groups: [apiGroup], status: 'ready' }, 'deepseek/deepseek-reasoner')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    });
  });

  function directoryToState(current: SessionModelsView['current']): ModelDirectoryState {
    return { current, routable: true, groups: [apiGroup, acpGroup], failures: [], status: 'ready', error: null };
  }
});

// ---------- backend 兼容矩阵 ----------

describe('backend 兼容矩阵（backendOfProvider / isSameBackendSelection / decodeBackendState）', () => {
  it('decodeBackendState：blank / established 两形态；畸形整体 undefined', () => {
    expect(decodeBackendState({ state: 'blank' })).toEqual({ state: 'blank' });
    expect(decodeBackendState({ state: 'established', provider: 'acp-devin' })).toEqual({ state: 'established', provider: 'acp-devin' });
    expect(decodeBackendState({ state: 'established' })).toBeUndefined();
    expect(decodeBackendState({ state: 'established', provider: '' })).toBeUndefined();
    expect(decodeBackendState({ state: 'unknown' })).toBeUndefined();
    expect(decodeBackendState(null)).toBeUndefined();
    expect(decodeBackendState('blank')).toBeUndefined();
  });

  it('backendOfProvider：backend 身份即路由 id 本身（命名语义点，非变换）', () => {
    expect(backendOfProvider('acp-devin')).toBe('acp-devin');
    expect(backendOfProvider('deepseek')).toBe('deepseek');
  });

  it('blank backend：没有执行 backend，native 或任意 ACP profile 都在原会话首次采用', () => {
    const blank: PickerBackendState = { state: 'blank' };
    expect(isSameBackendSelection({ provider: 'deepseek' }, blank)).toBe(true);
    expect(isSameBackendSelection({ provider: 'acp-devin' }, blank)).toBe(true);
    expect(isSameBackendSelection({ provider: 'acp-devin' }, blank, 'deepseek')).toBe(true);
    expect(isSameBackendSelection({ provider: 'anthropic' }, blank, 'deepseek')).toBe(true);
    expect(isSameBackendSelection({ provider: 'acp-devin' }, blank, 'acp-devin')).toBe(true);
    expect(isSameBackendSelection({ provider: 'acp-other' }, blank, 'acp-devin')).toBe(true);
  });

  it('/model 与 composer 共享 native fail-soft 路由：Remote 不可用时只放行已知 native→native', () => {
    expect(isNativeToNativeSelection('deepseek', 'anthropic')).toBe(true);
    expect(isNativeToNativeSelection('deepseek', 'acp-devin')).toBe(false);
    expect(isNativeToNativeSelection('acp-devin', 'deepseek')).toBe(false);
    expect(isNativeToNativeSelection(undefined, 'deepseek')).toBe(false);
  });

  it('established native backend：所有 acp-* 行与其他 native 行 = 跨 backend，仅同路由可选', () => {
    const native: PickerBackendState = { state: 'established', provider: 'deepseek' };
    expect(isSameBackendSelection({ provider: 'deepseek' }, native)).toBe(true);
    expect(isSameBackendSelection({ provider: 'acp-devin' }, native)).toBe(false);
    expect(isSameBackendSelection({ provider: 'acp-foo' }, native)).toBe(false);
    expect(isSameBackendSelection({ provider: 'anthropic' }, native)).toBe(false);
  });

  it('established acp-<P> backend：native 行与其他 acp profile 行 = 跨 backend，同 profile 行可选', () => {
    const acp: PickerBackendState = { state: 'established', provider: 'acp-devin' };
    expect(isSameBackendSelection({ provider: 'acp-devin' }, acp)).toBe(true);
    expect(isSameBackendSelection({ provider: 'deepseek' }, acp)).toBe(false);
    expect(isSameBackendSelection({ provider: 'acp-foo' }, acp)).toBe(false);
  });

 it('optionsOf 带 backend：跨 backend 行携带 crossBackend 标记 + detail 前缀披露 + 壳内确认框；同 backend 行不变', () => {
    const t: PickerTranslate = (key, params) =>
      key === 'option.crossBackend' ? `需新会话:${params?.['detail'] ?? ''}` : `${key}:${params?.['message'] ?? ''}`;
    const backend: PickerBackendState = { state: 'established', provider: 'deepseek' };
    const rows = optionsOf(directory, t, backend);
 // 跨 backend 行附壳内确认框文案（t 透传键名；取消即不触发 onSelect）
    const confirmation = {
      title: 'cross.popup.title:',
      description: 'cross.popup.description:',
      acknowledgeLabel: 'cross.popup.acknowledge:',
      cancelLabel: 'cross.popup.cancel:',
      confirmLabel: 'cross.popup.confirm:',
    };
    expect(rows).toEqual([
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', detail: '[Model] DeepSeek · 通用对话', active: true },
      { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner', detail: '[Model] DeepSeek' },
      { id: 'acp-devin/devin-latest', label: 'Devin Latest', detail: '需新会话:[ACP] Devin · 云端智能体', crossBackend: true, confirmation },
      { id: 'acp-devin/devin-sonnet', label: 'Devin Sonnet', detail: '需新会话:[ACP] Devin', crossBackend: true, confirmation },
      { id: 'failure/deepseek', label: 'DeepSeek', detail: 'option.loadError:HTTP 401' },
      { id: 'failure/acp-foo', label: 'Foo', detail: 'option.loadError:spawn failed' },
    ]);
    // failure 行不受 backend 标记影响
    expect(rows[4]).not.toHaveProperty('crossBackend');
    expect(rows[4]).not.toHaveProperty('confirmation');
    // 同 backend 行无确认框
    expect(rows[0]).not.toHaveProperty('confirmation');
  });

  it('optionsOf 带 blank backend：ACP 与 native 均为原会话首次采用', () => {
    const t: PickerTranslate = (key, params) => `${key}:${params?.['message'] ?? params?.['detail'] ?? ''}`;
    const rows = optionsOf(directory, t, { state: 'blank' });
    expect(rows.filter((row) => row.id.startsWith('deepseek/')).every((row) => row.crossBackend !== true)).toBe(true);
    expect(rows.filter((row) => row.id.startsWith('acp-devin/')).every((row) => row.crossBackend !== true)).toBe(true);
  });
});

// ----------：「当前」Tab（可见性 / 默认档 / 精确路由过滤 / 不在目录 / popup 置顶与确认） ----------

describe(' 当前 Tab（currentTabAvailable / defaultFilterOf / currentRouteFactsOf / 路由精确过滤）', () => {
  const acpGroupB: PickerProviderGroup = {
    id: 'acp-kimi',
    name: 'Kimi',
    models: [{ id: 'kimi-k2', name: 'Kimi K2' }],
  };

  it('Tab 可见性与默认档：仅 established ACP binding 可见且默认 current；native established/blank/null 一律原生默认 all', () => {
    expect(currentTabAvailable({ state: 'established', provider: 'acp-devin' })).toBe(true);
    expect(defaultFilterOf({ state: 'established', provider: 'acp-devin' })).toBe('current');
    // native established：Tab 不存在，保持原生默认（绝不由 state.current/全局默认推断）
    expect(currentTabAvailable({ state: 'established', provider: 'deepseek' })).toBe(false);
    expect(defaultFilterOf({ state: 'established', provider: 'deepseek' })).toBe('all');
    // blank / backendOf 失败（null）
    expect(currentTabAvailable({ state: 'blank' })).toBe(false);
    expect(defaultFilterOf({ state: 'blank' })).toBe('all');
    expect(currentTabAvailable(null)).toBe(false);
    expect(defaultFilterOf(null)).toBe('all');
  });

  it('currentRouteFactsOf：model 类 select option → allowedValues/currentValue；无快照/无该选项/boolean 归 null 事实', () => {
    expect(currentRouteFactsOf('acp-devin', liveSnapshot)).toEqual({
      provider: 'acp-devin',
      allowedValues: ['devin-latest', 'devin-sonnet'],
      currentValue: 'devin-latest',
    });
    expect(currentRouteFactsOf('acp-devin', null)).toEqual({ provider: 'acp-devin', allowedValues: null, currentValue: null });
    expect(currentRouteFactsOf('acp-devin', undefined)).toEqual({ provider: 'acp-devin', allowedValues: null, currentValue: null });
    // 无 model 类选项的快照
    expect(currentRouteFactsOf('acp-devin', { ...liveSnapshot, configOptions: [modeOption] }))
      .toEqual({ provider: 'acp-devin', allowedValues: null, currentValue: null });
    // boolean 选项即便撞约定 id 也不是 select，无交集依据
    expect(currentRouteFactsOf('acp-devin', { ...liveSnapshot, configOptions: [{ type: 'boolean', id: 'model', name: 'M', currentValue: true }] }))
      .toEqual({ provider: 'acp-devin', allowedValues: null, currentValue: null });
  });

  it('filterGroups current：按精确 provider/profile 路由过滤（不是 bucket——其余 acp 组一并剔除），再做 allowed-values 交集', () => {
    const facts: CurrentRouteFacts = { provider: 'acp-devin', allowedValues: ['devin-sonnet'], currentValue: 'devin-sonnet' };
    // 精确路由：apiGroup 与另一 acp 组都出局；交集只留 devin-sonnet
    expect(filterGroups([apiGroup, acpGroup, acpGroupB], 'current', '', facts)).toEqual([
      { ...acpGroup, models: [acpGroup.models[1]] },
    ]);
    // allowedValues null（无快照依据）→ 路由组全量，不做交集
    expect(filterGroups([apiGroup, acpGroup, acpGroupB], 'current', '', { provider: 'acp-devin', allowedValues: null, currentValue: null }))
      .toEqual([acpGroup]);
    // 文本搜索在交集之上叠加
    expect(filterGroups([apiGroup, acpGroup, acpGroupB], 'current', 'sonnet', { provider: 'acp-devin', allowedValues: null, currentValue: null }))
      .toEqual([{ ...acpGroup, models: [acpGroup.models[1]] }]);
    // facts 缺席（Tab 本不该存在）→ 空集；路由组缺席 → 空集
    expect(filterGroups([apiGroup, acpGroup], 'current', '')).toEqual([]);
    expect(filterGroups([apiGroup], 'current', '', { provider: 'acp-devin', allowedValues: null, currentValue: null })).toEqual([]);
  });

  it('filterFailures current：只保留精确路由的失败行（健康信号不随档位消失，也不跨路由串扰）', () => {
    expect(filterFailures([apiFailure, acpFailure], 'current', 'acp-foo')).toEqual([acpFailure]);
    expect(filterFailures([apiFailure, acpFailure], 'current', 'acp-devin')).toEqual([]);
    expect(filterFailures([apiFailure, acpFailure], 'current')).toEqual([]);
  });

  it('currentValueNotInCatalog：当前值缺席目录（含整组缺席）→ true；在场/null → false（不注入未知模型的判定源）', () => {
    expect(currentValueNotInCatalog([apiGroup, acpGroup], { provider: 'acp-devin', allowedValues: null, currentValue: 'devin-latest' })).toBe(false);
    expect(currentValueNotInCatalog([apiGroup, acpGroup], { provider: 'acp-devin', allowedValues: null, currentValue: 'ghost-model' })).toBe(true);
    expect(currentValueNotInCatalog([apiGroup], { provider: 'acp-devin', allowedValues: null, currentValue: 'devin-latest' })).toBe(true);
    expect(currentValueNotInCatalog([], { provider: 'acp-devin', allowedValues: null, currentValue: null })).toBe(false);
  });

  it('optionsOf 置顶：established ACP backend 的当前 profile 组排最前（稳定排序）；native established/blank 不动序', () => {
    const t: PickerTranslate = (key, params) => `${key}:${params?.['detail'] ?? params?.['message'] ?? params?.['model'] ?? ''}`;
    const rows = optionsOf(directory, t, { state: 'established', provider: 'acp-devin' });
    expect(rows.map((row) => row.id)).toEqual([
      'acp-devin/devin-latest',
      'acp-devin/devin-sonnet',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
      'failure/deepseek',
      'failure/acp-foo',
    ]);
    // native established / blank：目录原序不变
    expect(optionsOf(directory, t, { state: 'established', provider: 'deepseek' }).map((row) => row.id))
      .toEqual(optionsOf(directory, t).map((row) => row.id));
    expect(optionsOf(directory, t, { state: 'blank' }).map((row) => row.id))
      .toEqual(optionsOf(directory, t).map((row) => row.id));
  });

  it('optionsOf：跨 backend 行携带壳内确认框五键文案（取消即不触发 onSelect）；同 backend 行无确认', () => {
    const t: PickerTranslate = (key, params) => `${key}${params?.['model'] !== undefined ? `:${params['model']}` : ''}`;
    const rows = optionsOf(directory, t, { state: 'established', provider: 'acp-devin' });
    const cross = rows.find((row) => row.id === 'deepseek/deepseek-chat');
    expect(cross).toMatchObject({
      crossBackend: true,
      confirmation: {
        title: 'cross.popup.title',
        description: 'cross.popup.description:DeepSeek Chat',
        acknowledgeLabel: 'cross.popup.acknowledge',
        cancelLabel: 'cross.popup.cancel',
        confirmLabel: 'cross.popup.confirm',
      },
    });
    const sameBackend = rows.find((row) => row.id === 'acp-devin/devin-latest');
    expect(sameBackend).not.toHaveProperty('confirmation');
    expect(sameBackend).not.toHaveProperty('crossBackend');
    // failure 行永不携带确认
    expect(rows.find((row) => row.id === 'failure/deepseek')).not.toHaveProperty('confirmation');
  });
});


describe('decodeLiveOptionsSnapshot', () => {
  // capabilities/continuity/contextUsage 的“未握手/ok 闩锁/未收到 usage_update”词表。
 // freshness/editable/fingerprintChanged/modelSwitch 同为必填键（live 恒值形态）。
  const NO_FACTS = {
    capabilities: null,
    continuity: CONTINUITY_OK,
    contextUsage: null,
    freshness: 'live',
    editable: true,
    fingerprintChanged: false,
    modelSwitch: { status: 'idle' },
  } as const;

  it('合法快照：select（flat+group）/boolean 全量解出；null description/category 归一为缺席；杂键剥离', () => {
    const wire = {
      sessionId: 's1',
      configOptions: [
        {
          type: 'select',
          id: 'mode',
          name: '模式',
          description: null,
          category: 'mode',
          currentValue: 'code',
          options: [
            { value: 'code', name: 'Code', description: null },
            { group: 'experimental', name: '实验', options: [{ value: 'plan', name: 'Plan', description: '只读规划' }] },
          ],
        },
        { type: 'select', id: 'model', name: '模型', currentValue: 'devin-latest', options: [{ value: 'devin-latest', name: 'Devin Latest' }], stray: 1 },
        { type: 'boolean', id: 'telemetry', name: '遥测', description: '上报匿名统计', category: null, currentValue: false },
      ],
      currentModeId: 'code',
      ...NO_FACTS,
    };
    expect(decodeLiveOptionsSnapshot(wire)).toEqual({
      sessionId: 's1',
      configOptions: [
        {
          type: 'select',
          id: 'mode',
          name: '模式',
          category: 'mode',
          currentValue: 'code',
          options: [
            { value: 'code', name: 'Code' },
            { group: 'experimental', name: '实验', options: [{ value: 'plan', name: 'Plan', description: '只读规划' }] },
          ],
        },
        { type: 'select', id: 'model', name: '模型', currentValue: 'devin-latest', options: [{ value: 'devin-latest', name: 'Devin Latest' }] },
        { type: 'boolean', id: 'telemetry', name: '遥测', description: '上报匿名统计', currentValue: false },
      ],
      currentModeId: 'code',
      ...NO_FACTS,
    });
  });

  it('configOptions:null 归一为"agent 未提供"；currentModeId null/string 均可；空 options 数组与空 group 合法', () => {
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, ...NO_FACTS })).toEqual({
      sessionId: 's1',
      configOptions: null,
      currentModeId: null,
      ...NO_FACTS,
    });
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: 'code', ...NO_FACTS })).toEqual({
      sessionId: 's1',
      configOptions: null,
      currentModeId: 'code',
      ...NO_FACTS,
    });
    expect(
      decodeLiveOptionsSnapshot({
        sessionId: 's1',
        configOptions: [{ type: 'select', id: 'model', name: 'M', currentValue: '', options: [{ group: 'g', name: 'G', options: [] }] }],
        currentModeId: null,
        ...NO_FACTS,
      }),
    ).toEqual({
      sessionId: 's1',
      configOptions: [{ type: 'select', id: 'model', name: 'M', currentValue: '', options: [{ group: 'g', name: 'G', options: [] }] }],
      currentModeId: null,
      ...NO_FACTS,
    });
  });

  it('畸形整体拒绝：body 非 object / 顶层字段缺失或非法', () => {
    for (const bad of [null, 'x', 42, []]) {
      expect(decodeLiveOptionsSnapshot(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(decodeLiveOptionsSnapshot({})).toBeUndefined(); // 缺 sessionId
    expect(decodeLiveOptionsSnapshot({ sessionId: 42, configOptions: null, currentModeId: null, ...NO_FACTS })).toBeUndefined();
    // configOptions 必须是 null 或数组（缺 key 也算违规：宿主恒发）
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', currentModeId: null, ...NO_FACTS })).toBeUndefined();
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: {}, currentModeId: null, ...NO_FACTS })).toBeUndefined();
    // currentModeId 必须是 null 或 string
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, ...NO_FACTS })).toBeUndefined();
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: 42, ...NO_FACTS })).toBeUndefined();
    // capabilities 是宿主恒发的必填键（null 词表或合法事实对象；缺 key 即违规）
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null })).toBeUndefined();
    // contextUsage 同为宿主恒发的必填键：缺 key / 畸形即整包拒绝
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, capabilities: null })).toBeUndefined();
  });

 it(' continuity 必填键：ok/blocked（cause/detail 原样）解出；缺席/畸形整包拒', () => {
    const base = { sessionId: 's1', configOptions: null, currentModeId: null, ...NO_FACTS };
    // blocked 闩锁：cause（sidecar 词表字面量）与 detail（有界摘要）原样过线
    const blocked = { status: 'blocked', cause: 'cwd-changed', detail: 'canonical cwd mismatch' };
    expect(decodeLiveOptionsSnapshot({ ...base, continuity: blocked })).toEqual({ ...base, continuity: blocked });
    expect(decodeLiveOptionsSnapshot({ ...base, continuity: CONTINUITY_OK })).toEqual({ ...base, continuity: CONTINUITY_OK });
    // 缺 key / 非对象 / status 词表外 / cause/detail 非 null|string：整包拒绝
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, capabilities: null, contextUsage: null })).toBeUndefined();
    for (const continuity of [
      null,
      42,
      'ok',
      {},
      { status: 'pending', cause: null, detail: null },
      { status: 'ok' },
      { status: 'ok', cause: 1, detail: null },
      { status: 'blocked', cause: null, detail: {} },
    ]) {
      expect(decodeLiveOptionsSnapshot({ ...base, continuity }), JSON.stringify(continuity)).toBeUndefined();
    }
  });

 it(' contextUsage 三态：null 词表 / 有快照（cost 透传或 null）；畸形整包拒', () => {
    const base = { sessionId: 's1', configOptions: null, currentModeId: null, ...NO_FACTS };
    // 有快照、cost 在场：原样解出
    expect(decodeLiveOptionsSnapshot({
      ...base,
      contextUsage: { used: 200, size: 1000, percent: 20, cost: { amount: 0.5, currency: 'USD' } },
    })).toEqual({
      ...base,
      contextUsage: { used: 200, size: 1000, percent: 20, cost: { amount: 0.5, currency: 'USD' } },
    });
    // 有快照、cost null（agent 未提供）
    expect(decodeLiveOptionsSnapshot({
      ...base,
      contextUsage: { used: 1, size: 10, percent: 10, cost: null },
    })).toEqual({ ...base, contextUsage: { used: 1, size: 10, percent: 10, cost: null } });
    // 畸形：used/size/percent 非 number、cost 非 null 亦非合法对象
    for (const contextUsage of [
      42,
      { size: 1000, percent: 20, cost: null },
      { used: '200', size: 1000, percent: 20, cost: null },
      { used: 200, size: 1000, percent: 20, cost: 0.5 },
      { used: 200, size: 1000, percent: 20, cost: { amount: 0.5 } },
      { used: 200, size: 1000, percent: 20, cost: { amount: '0.5', currency: 'USD' } },
    ]) {
      expect(decodeLiveOptionsSnapshot({ ...base, contextUsage }), JSON.stringify(contextUsage)).toBeUndefined();
    }
  });

  it('未知 type 字符串的选项逐项跳过（协议 §Graceful Degradation），不传染整个快照', () => {
    const good = { type: 'select', id: 'model', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 'A' }] };
    const exotic = { type: 'slider', id: 'temperature', name: 'T', currentValue: 'low' };
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: [exotic], currentModeId: null, ...NO_FACTS })).toEqual({
      sessionId: 's1',
      configOptions: [],
      currentModeId: null,
      ...NO_FACTS,
    });
    // 好选项存活、未知 type 项消失（而不是整包 undefined）
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: [good, exotic], currentModeId: null, ...NO_FACTS })).toEqual({
      sessionId: 's1',
      configOptions: [{ type: 'select', id: 'model', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }],
      currentModeId: null,
      ...NO_FACTS,
    });
    // type 缺席/非 string 仍是畸形 → 整包拒绝
    expect(
      decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: [{ id: 'm', name: 'M', currentValue: 'a' }], currentModeId: null, ...NO_FACTS }),
    ).toBeUndefined();
    expect(
      decodeLiveOptionsSnapshot({
        sessionId: 's1',
        configOptions: [{ type: 42, id: 'm', name: 'M', currentValue: 'a' }],
        currentModeId: null,
        ...NO_FACTS,
      }),
    ).toBeUndefined();
  });

  it('逐选项违规传染整个快照（任一非法 → undefined）', () => {
    const good = { type: 'select', id: 'model', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 'A' }] };
    const badOptions: Array<[string, unknown]> = [
      ['选项非 object', 'x'],
      ['缺 id', { type: 'select', name: 'M', currentValue: 'a', options: [] }],
      ['name 非 string', { type: 'select', id: 'm', name: 1, currentValue: 'a', options: [] }],
      ['缺 type', { id: 'm', name: 'M', currentValue: 'a' }],
      ['select currentValue 非 string', { type: 'select', id: 'm', name: 'M', currentValue: 1, options: [] }],
      ['select 缺 options', { type: 'select', id: 'm', name: 'M', currentValue: 'a' }],
      ['select options 非数组', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: {} }],
      ['flat 值缺 value', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ name: 'A' }] }],
      ['flat 值 name 非 string', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 1 }] }],
      ['值 description 非 string', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 'A', description: 1 }] }],
      ['group 缺 name', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ group: 'g', options: [] }] }],
      ['group 缺 group', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ name: 'G', options: [] }] }],
      ['group 内坏值', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ group: 'g', name: 'G', options: [{ value: 1, name: 'A' }] }] }],
      ['无 options 的"组"按 flat 值解码', { type: 'select', id: 'm', name: 'M', currentValue: 'a', options: [{ group: 'g', name: 'G' }] }],
      ['boolean currentValue 非 boolean', { type: 'boolean', id: 'b', name: 'B', currentValue: 'true' }],
      ['选项 description 非 string', { type: 'boolean', id: 'b', name: 'B', currentValue: true, description: 1 }],
      ['选项 category 非 string', { type: 'boolean', id: 'b', name: 'B', currentValue: true, category: 1 }],
    ];
    for (const [label, option] of badOptions) {
      expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: [option], currentModeId: null, ...NO_FACTS }), label).toBeUndefined();
      // 传染：好选项与坏选项并存同样整体拒绝
      expect(
        decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: [good, option], currentModeId: null, ...NO_FACTS }),
        `${label}（传染）`,
      ).toBeUndefined();
    }
  });

  it('capabilities 事实：null 词表与合法对象解出；畸形整包拒绝', () => {
    const capabilities = {
      loadSession: true,
      sessionList: false,
      sessionClose: false,
      sessionDelete: true,
      promptImage: true,
      promptAudio: false,
      promptEmbeddedContext: true,
      mcpHttp: false,
      mcpSse: false,
    };
    expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, capabilities, continuity: CONTINUITY_OK, contextUsage: null, ...LIVE_FIXED })).toEqual({
      sessionId: 's1',
      configOptions: null,
      currentModeId: null,
      capabilities,
      continuity: CONTINUITY_OK,
      contextUsage: null,
      ...LIVE_FIXED,
    });
    // 九键全 false（未广告任何能力）同样合法
    const noCaps = {
      loadSession: false,
      sessionList: false,
      sessionClose: false,
      sessionDelete: false,
      promptImage: false,
      promptAudio: false,
      promptEmbeddedContext: false,
      mcpHttp: false,
      mcpSse: false,
    };
    expect(
      decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, capabilities: noCaps, continuity: CONTINUITY_OK, contextUsage: null, ...LIVE_FIXED }),
    ).toEqual({ sessionId: 's1', configOptions: null, currentModeId: null, capabilities: noCaps, continuity: CONTINUITY_OK, contextUsage: null, ...LIVE_FIXED });
    const bads: Array<[string, Record<string, unknown>]> = [
      ['capabilities 非 object', { capabilities: 1 }],
      ['capabilities 缺键', { capabilities: { loadSession: true } }],
      ['capabilities 值非 boolean', { capabilities: { ...capabilities, loadSession: 'yes' } }],
    ];
    for (const [label, facts] of bads) {
      expect(decodeLiveOptionsSnapshot({ sessionId: 's1', configOptions: null, currentModeId: null, continuity: CONTINUITY_OK, contextUsage: null, ...LIVE_FIXED, ...facts }), label).toBeUndefined();
    }
  });
});

// ---------- 活体选项分区与值 ----------

describe('liveOptionSectionOf / partitionLiveOptions', () => {
 it('分区判定：category 优先、mode 有约定 id 兜底、thought_level/model_config 只看 category、其余入 other；model 类由 isModelClassLiveOption 另行识别（起不进面板）', () => {
    expect(liveOptionSectionOf(modeOption)).toBe('mode');
    expect(isModelClassLiveOption(modelOption)).toBe(true); // 约定 id 'model' 兜底
    expect(liveOptionSectionOf(modelOption)).toBe('other'); // 面板分区不再设 model 区：落入 other（分区时整体跳过）
    expect(liveOptionSectionOf(thoughtOption)).toBe('thought_level');
    expect(liveOptionSectionOf(modelConfigOption)).toBe('model_config');
    expect(liveOptionSectionOf(boolOption)).toBe('other'); // category 缺席且 id 非常约定
    expect(liveOptionSectionOf(otherOption)).toBe('other'); // 未知未来 category
    // id 兜底（category 缺席）
    expect(liveOptionSectionOf({ type: 'select', id: 'mode', name: 'M', currentValue: 'x', options: [] })).toBe('mode');
    // model 类判定：category 'model' 或约定 id 均命中（与 host modelOfConfigOptions 同口径）
    expect(isModelClassLiveOption({ ...modelOption, category: 'model' })).toBe(true);
    expect(isModelClassLiveOption(modeOption)).toBe(false);
  });

  it('mode 判定先于其余（对齐宿主写路径的 mode 类口径）', () => {
    expect(liveOptionSectionOf({ type: 'select', id: 'model', name: 'M', category: 'mode', currentValue: 'x', options: [] })).toBe('mode');
    expect(liveOptionSectionOf({ type: 'select', id: 'mode', name: 'M', category: 'model', currentValue: 'x', options: [] })).toBe('mode');
    expect(liveOptionSectionOf({ type: 'select', id: 'mode', name: 'M', category: 'thought_level', currentValue: 'x', options: [] })).toBe('mode');
  });

  it('partitionLiveOptions 四分区（model 类整体跳过），区内保持输入顺序', () => {
    const partitioned = partitionLiveOptions(liveOptions);
    expect(partitioned).toEqual({
      mode: [modeOption],
      thoughtLevel: [thoughtOption],
      modelConfig: [modelConfigOption],
      other: [boolOption, otherOption],
    });
    // model 类（含 category 'model' 变体）不进任何分区
    expect(partitionLiveOptions([modelOption, { ...modelOption, id: 'm2', category: 'model' }])).toEqual({
      mode: [], thoughtLevel: [], modelConfig: [], other: [],
    });
    expect(partitionLiveOptions([])).toEqual({ mode: [], thoughtLevel: [], modelConfig: [], other: [] });
  });
});

describe('flattenLiveValues / liveValueNameOf', () => {
  it('flattenLiveValues：group/flat 两种布局拍平，组内值带 groupName，flat 值不带', () => {
    expect(flattenLiveValues(modeOption)).toEqual([
      { value: 'code', name: 'Code' },
      { value: 'plan', name: 'Plan', description: '只读规划', groupName: '实验' },
    ]);
    expect(flattenLiveValues(modelOption)).toEqual([
      { value: 'devin-latest', name: 'Devin Latest' },
      { value: 'devin-sonnet', name: 'Devin Sonnet' },
    ]);
    expect(flattenLiveValues({ type: 'select', id: 'x', name: 'X', currentValue: '', options: [] })).toEqual([]);
  });

  it('liveValueNameOf：已广告值取 name（含组内嵌套），未广告值回退原文；boolean 恒回原文', () => {
    expect(liveValueNameOf(modeOption, 'code')).toBe('Code');
    expect(liveValueNameOf(modeOption, 'plan')).toBe('Plan'); // 组内嵌套
    expect(liveValueNameOf(modeOption, 'ghost')).toBe('ghost');
    expect(liveValueNameOf(boolOption, 'true')).toBe('true');
  });
});

describe('withLiveOptionValue', () => {
  it('select 选项替换 currentValue：新快照 + 新数组，原快照与原选项不动', () => {
    const next = withLiveOptionValue(liveSnapshot, 'model', 'devin-sonnet');
    expect(next).not.toBe(liveSnapshot);
    expect(next.configOptions).not.toBe(liveSnapshot.configOptions);
    expect(next.configOptions?.[1]).toEqual({ ...modelOption, currentValue: 'devin-sonnet' });
    // 非 mode 类不动 currentModeId；其余选项原引用保留
    expect(next.currentModeId).toBe('code');
    expect(next.configOptions?.[0]).toBe(modeOption);
    expect(liveSnapshot.configOptions?.[1]).toBe(modelOption);
  });

  it('boolean 选项收原生 boolean；非 boolean 值容错仅 "true" 置真（调用方 bug 路径）', () => {
    const turned = withLiveOptionValue(liveSnapshot, 'telemetry', true);
    expect(turned.configOptions?.[3]).toEqual({ ...boolOption, currentValue: true });
    expect(withLiveOptionValue(turned, 'telemetry', false).configOptions?.[3]).toEqual({ ...boolOption, currentValue: false });
    // 容错收敛：字符串 'true' 置真，其余一律 false（POST 会被端点 400 拒绝并回滚）
    expect(withLiveOptionValue(turned, 'telemetry', 'true').configOptions?.[3]).toEqual({ ...boolOption, currentValue: true });
    expect(withLiveOptionValue(turned, 'telemetry', 'yes').configOptions?.[3]).toEqual({ ...boolOption, currentValue: false });
  });

  it('mode 类选项连带 currentModeId 仅限 string 值（current_mode_update 的词汇是 string mode id）', () => {
    const next = withLiveOptionValue(liveSnapshot, 'mode', 'plan');
    expect(next.configOptions?.[0]).toEqual({ ...modeOption, currentValue: 'plan' });
    expect(next.currentModeId).toBe('plan');
    // 分区判定与选项 type 无关：boolean + category mode 也属 mode 类，但 boolean 值不连带
    const boolModeSnapshot: LiveOptionsSnapshot = {
      sessionId: 's1',
      configOptions: [{ type: 'boolean', id: 'safe', name: 'S', category: 'mode', currentValue: false }],
      currentModeId: null,
      capabilities: null,
      continuity: CONTINUITY_OK,
      contextUsage: null,
      ...LIVE_FIXED,
    };
    const boolTurned = withLiveOptionValue(boolModeSnapshot, 'safe', true);
    expect(boolTurned.configOptions?.[0]).toMatchObject({ currentValue: true });
    expect(boolTurned.currentModeId).toBeNull();
  });

  it('未知 configId / configOptions null → 原引用返回（无乐观更新）', () => {
    expect(withLiveOptionValue(liveSnapshot, 'ghost', 'x')).toBe(liveSnapshot);
    const nullSnapshot: LiveOptionsSnapshot = { sessionId: 's1', configOptions: null, currentModeId: null, capabilities: null, continuity: CONTINUITY_OK, contextUsage: null, ...LIVE_FIXED };
    expect(withLiveOptionValue(nullSnapshot, 'model', 'x')).toBe(nullSnapshot);
  });
});

// ---------- 设为默认（agent-default-model ns） ----------

describe('decodeAgentDefaultModel / defaultModelOps / isDefaultSelection', () => {
  it('decodeAgentDefaultModel：缺席/畸形 → undefined；合法解出且杂键剥离', () => {
    expect(decodeAgentDefaultModel(undefined)).toBeUndefined();
    expect(decodeAgentDefaultModel(null)).toBeUndefined();
    expect(decodeAgentDefaultModel('x')).toBeUndefined();
    expect(decodeAgentDefaultModel([])).toBeUndefined();
    expect(decodeAgentDefaultModel({})).toBeUndefined();
    expect(decodeAgentDefaultModel({ provider: '', model: 'm' })).toBeUndefined();
    expect(decodeAgentDefaultModel({ provider: 'p' })).toBeUndefined();
    expect(decodeAgentDefaultModel({ provider: 'p', model: '' })).toBeUndefined();
    expect(decodeAgentDefaultModel({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' });
    expect(decodeAgentDefaultModel({ provider: 'p', model: 'm', reasoningEffort: 'high', stray: 1 })).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    });
    // 可选 effort 非 string：剥离而非整包拒绝（required 字段畸形才 undefined）
    expect(decodeAgentDefaultModel({ provider: 'p', model: 'm', reasoningEffort: 42 })).toEqual({ provider: 'p', model: 'm' });
  });

  it('defaultModelOps：effort 在场三 set；effort 缺席且有旧值才补 unset', () => {
    expect(defaultModelOps({ provider: 'acp-devin', model: 'devin-latest', reasoningEffort: 'high' }, false)).toEqual([
      { op: 'set', path: ['provider'], value: 'acp-devin' },
      { op: 'set', path: ['model'], value: 'devin-latest' },
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
    ]);
    // effort 在场时 currentHasEffort 不影响形状
    expect(defaultModelOps({ provider: 'acp-devin', model: 'devin-latest', reasoningEffort: 'high' }, true)).toEqual([
      { op: 'set', path: ['provider'], value: 'acp-devin' },
      { op: 'set', path: ['model'], value: 'devin-latest' },
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
    ]);
    // 首写：纯 set 对
    expect(defaultModelOps({ provider: 'acp-devin', model: 'devin-latest' }, false)).toEqual([
      { op: 'set', path: ['provider'], value: 'acp-devin' },
      { op: 'set', path: ['model'], value: 'devin-latest' },
    ]);
    // 旧值带 effort：必须 unset 掉陈旧键（exactOptionalPropertyTypes 的 set/unset 不对称）
    expect(defaultModelOps({ provider: 'acp-devin', model: 'devin-latest' }, true)).toEqual([
      { op: 'set', path: ['provider'], value: 'acp-devin' },
      { op: 'set', path: ['model'], value: 'devin-latest' },
      { op: 'unset', path: ['reasoningEffort'] },
    ]);
  });

  it('isDefaultSelection：只比 provider/model（effort 差异不影响行标记）', () => {
    const stored = { provider: 'acp-devin', model: 'devin-latest', reasoningEffort: 'high' };
    expect(isDefaultSelection(stored, 'acp-devin', 'devin-latest')).toBe(true);
    expect(isDefaultSelection({ provider: 'acp-devin', model: 'devin-latest' }, 'acp-devin', 'devin-latest')).toBe(true);
    expect(isDefaultSelection(stored, 'acp-devin', 'devin-sonnet')).toBe(false);
    expect(isDefaultSelection(stored, 'deepseek', 'devin-latest')).toBe(false);
    expect(isDefaultSelection(undefined, 'acp-devin', 'devin-latest')).toBe(false);
  });
});

// ---------- 权限范围只读展示 ----------

describe('presetOfPermissionsProjection', () => {
  it('非 plain object / currentValue 非 string → undefined', () => {
    expect(presetOfPermissionsProjection({ currentValue: 'danger-full-access' })).toBe('danger-full-access');
    expect(presetOfPermissionsProjection({ currentValue: 'workspace-write' })).toBe('workspace-write');
    expect(presetOfPermissionsProjection({})).toBeUndefined();
    expect(presetOfPermissionsProjection({ currentValue: 42 })).toBeUndefined();
    expect(presetOfPermissionsProjection({ currentValue: null })).toBeUndefined();
    expect(presetOfPermissionsProjection(null)).toBeUndefined();
    expect(presetOfPermissionsProjection('danger-full-access')).toBeUndefined();
    expect(presetOfPermissionsProjection([])).toBeUndefined();
  });
});

// ---------- 披露面板：当前降级项 ----------

describe('pickerDegradationsOf', () => {
  const READY_SNAPSHOT: LiveOptionsSnapshot = {
    sessionId: 's1',
    configOptions: [],
    currentModeId: null,
    capabilities: {
      loadSession: true,
      sessionList: false,
      sessionClose: false,
      sessionDelete: true,
      promptImage: true,
      promptAudio: false,
      promptEmbeddedContext: true,
      mcpHttp: false,
      mcpSse: false,
    },
    continuity: CONTINUITY_OK,
    contextUsage: null,
    ...LIVE_FIXED,
  };

  it('全绿（preset 在场 + 握手完成 + 目录健康）→ 空列表', () => {
    expect(pickerDegradationsOf({ preset: 'workspace-write', snapshot: READY_SNAPSHOT, providerFailed: false })).toEqual([]);
  });

  it('可用性提示逐条命中且顺序固定（权限投影、会话能力、目录健康）', () => {
    expect(pickerDegradationsOf({ preset: undefined, snapshot: READY_SNAPSHOT, providerFailed: true })).toEqual([
      'presetUnknown',
      'probeFailed',
    ]);
    // configOptions/capabilities 同时未知时仍分别披露。
    const worst: LiveOptionsSnapshot = {
      sessionId: 's1',
      configOptions: null,
      currentModeId: null,
      capabilities: null,
      continuity: CONTINUITY_OK,
      contextUsage: null,
      ...LIVE_FIXED,
    };
    expect(pickerDegradationsOf({ preset: undefined, snapshot: worst, providerFailed: true })).toEqual([
      'presetUnknown',
      'noConfigOptions',
      'noHandshake',
      'probeFailed',
    ]);
  });

  it('快照未加载（null）：configOptions 与握手同时未知', () => {
    expect(pickerDegradationsOf({ preset: 'workspace-write', snapshot: null, providerFailed: false })).toEqual([
      'noConfigOptions',
      'noHandshake',
    ]);
  });

  it('configOptions null / capabilities null 各自独立命中', () => {
    const noOptions: LiveOptionsSnapshot = { ...READY_SNAPSHOT, configOptions: null };
    expect(pickerDegradationsOf({ preset: 'ws', snapshot: noOptions, providerFailed: false })).toEqual(['noConfigOptions']);
    const noHandshake: LiveOptionsSnapshot = { ...READY_SNAPSHOT, capabilities: null };
    expect(pickerDegradationsOf({ preset: 'ws', snapshot: noHandshake, providerFailed: false })).toEqual(['noHandshake']);
  });
});

// ---------- ACP context 统计行（dock 组件的渲染规则钉在这里） ----------

describe('formatCompactTokens / acpContextUsageLine', () => {
  /** 逐字文案的最小 t 假件（zh 词典口径）。 */
  const t = (key: string, params?: Record<string, string | number>): string =>
    Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), {
      'context.usage': '上下文 {used}/{size} · {percent}%',
      'context.cost': 'Agent 上报的会话累计成本 {amount}',
    }[key] ?? key);

  it('formatCompactTokens：517 / 12.2K / 517K / 1.2M（三位以内一位小数）', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(517)).toBe('517');
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(12_200)).toBe('12.2K');
    expect(formatCompactTokens(517_000)).toBe('517K');
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
  });

  it('非 ACP / 未知 backend / blank → null（不渲染）', () => {
    const usage = { used: 200, size: 1000, percent: 20, cost: null };
    expect(acpContextUsageLine(null, usage, t)).toBeNull(); // backendOf RPC 失败归 null
    expect(acpContextUsageLine({ state: 'blank' }, usage, t)).toBeNull();
    expect(acpContextUsageLine({ state: 'established', provider: 'deepseek' }, usage, t)).toBeNull();
  });

  it('ACP 会话无占用快照 → null（诚实空缺，不显示 0）', () => {
    expect(acpContextUsageLine({ state: 'established', provider: 'acp-devin' }, null, t)).toBeNull();
  });

  it('ACP 会话有快照：上下文文案；agent 提供 cost 时原样追加', () => {
    const backend = { state: 'established' as const, provider: 'acp-devin' };
    expect(acpContextUsageLine(backend, { used: 517_000, size: 1_000_000, percent: 51.7, cost: null }, t))
      .toBe('上下文 517K/1M · 51.7%');
    expect(acpContextUsageLine(backend, { used: 200, size: 1000, percent: 20, cost: { amount: 0.5, currency: 'USD' } }, t))
      .toBe('上下文 200/1K · 20% · Agent 上报的会话累计成本 $0.50');
  });
});

describe('showsAcpCatalogScopeNote', () => {
 // /模型目录作用域：目录作用域说明只对 ACP provider 现身；本地直连 provider 无该提示。
  it('is true only for acp-* providers', () => {
    expect(showsAcpCatalogScopeNote('acp-mock')).toBe(true);
    expect(showsAcpCatalogScopeNote('openai')).toBe(false);
    expect(showsAcpCatalogScopeNote(null)).toBe(false);
    expect(showsAcpCatalogScopeNote(undefined)).toBe(false);
  });
});

// ---------- 边界：ACP 区块分区题注的 agent 显示名 ----------

describe('acpAgentDisplayName（「Agent 模式（{agent}）」的参数源）', () => {
  it('组名剥 ` · ACP` 后缀；无后缀组名原样；组缺席兜底裸 agent id', () => {
    const groups: PickerProviderGroup[] = [
      { id: 'acp-devin', name: 'Devin · ACP', models: [] },
      { id: 'acp-foo', name: 'Foo Agent', models: [] },
    ];
    expect(acpAgentDisplayName(groups, 'acp-devin')).toBe('Devin');
    expect(acpAgentDisplayName(groups, 'acp-foo')).toBe('Foo Agent'); // 无后缀不剥
    // 组缺席（目录未加载/失败）：acp- 去前缀的裸 id
    expect(acpAgentDisplayName(groups, 'acp-kimi')).toBe('kimi');
    expect(acpAgentDisplayName([], 'acp-devin')).toBe('devin');
    // 组名恰好只剩后缀 → 空串不回退展示，落兜底裸 id
    expect(acpAgentDisplayName([{ id: 'acp-x', name: ' · ACP', models: [] }], 'acp-x')).toBe('x');
  });
});

// ---------- freshness/editable/fingerprintChanged/modelSwitch 必填键与恢复决策 ----------

describe('必填键（freshness/editable/fingerprintChanged/modelSwitch）', () => {
  const base = {
    sessionId: 's1',
    configOptions: null,
    currentModeId: null,
    capabilities: null,
    continuity: CONTINUITY_OK,
    contextUsage: null,
  } as const;

  it('缺任一键即整包拒（宿主恒发契约）', () => {
    expect(decodeLiveOptionsSnapshot(base)).toBeUndefined();
    for (const key of ['freshness', 'editable', 'fingerprintChanged', 'modelSwitch'] as const) {
      const wire: Record<string, unknown> = { ...base, ...LIVE_FIXED };
      delete wire[key];
      expect(decodeLiveOptionsSnapshot(wire), key).toBeUndefined();
    }
  });

  it('freshness/editable/fingerprintChanged 词表收窄：stale+editable:false 解出；词表外整包拒', () => {
    const stale = { ...base, freshness: 'stale', editable: false, fingerprintChanged: true, modelSwitch: { status: 'idle' } };
    expect(decodeLiveOptionsSnapshot(stale)).toEqual(stale);
    expect(decodeLiveOptionsSnapshot({ ...stale, freshness: 'warm' })).toBeUndefined();
    expect(decodeLiveOptionsSnapshot({ ...stale, editable: 'yes' })).toBeUndefined();
    expect(decodeLiveOptionsSnapshot({ ...stale, fingerprintChanged: 0 })).toBeUndefined();
  });

  it('modelSwitch 五态解出（busy/pending/rollback-required 载荷原样）；未知 status/畸形载荷整包拒', () => {
    const pending = {
      status: 'pending',
      operationId: 'op-1',
      state: 'agent-applied',
      provider: 'acp-devin',
      optionId: 'model',
      previousModel: 'm1',
      targetModel: 'm2',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    for (const modelSwitch of [
      { status: 'idle' },
      { status: 'busy', operationId: 'op-1', targetModel: 'm2' },
      pending,
      { status: 'rollback-required', operationId: 'op-1', provider: 'acp-devin', previousModel: 'm1', targetModel: 'm2' },
      { status: 'corrupt' },
    ]) {
      const wire = { ...base, ...LIVE_FIXED, modelSwitch };
      expect(decodeLiveOptionsSnapshot(wire), JSON.stringify(modelSwitch)).toEqual(wire);
    }
    for (const modelSwitch of [
      null,
      'idle',
      {},
      { status: 'unknown' },
      { status: 'busy' }, // 缺 operationId/targetModel
      { status: 'pending', operationId: 'op-1' }, // 载荷不全
      { ...pending, appliedModel: '' },
      { ...pending, appliedModel: 42 },
      { status: 'rollback-required', operationId: 'op-1' }, // 缺 provider/previous/target
    ]) {
      expect(decodeLiveOptionsSnapshot({ ...base, ...LIVE_FIXED, modelSwitch }), JSON.stringify(modelSwitch)).toBeUndefined();
    }
  });
});

describe('decideModelSwitchRecovery（崩溃恢复收敛：只收敛到可证明的状态）', () => {
  const P = { previousModel: 'm1', targetModel: 'm2' } as const;
  it.each([
    // 先等证据：任一侧现值未知 → 等重连/重载
    [{ ...P, dshModel: null, agentModel: 'm2' }, 'wait-resume'],
    [{ ...P, dshModel: 'm1', agentModel: null }, 'wait-resume'],
    // 双侧一致 = 已收敛（含崩溃残留的 committed 行）
    [{ ...P, dshModel: 'm1', agentModel: 'm1' }, 'clear'],
    [{ ...P, dshModel: 'm2', agentModel: 'm2' }, 'clear'],
    // Agent 已应用、DSH 未跟进：补完 DSH 侧（selectModel(target)）
    [{ ...P, dshModel: 'm1', agentModel: 'm2' }, 'complete-dsh'],
    // DSH=previous 且 Agent 也不可证在 target 之外 → 回滚 Agent
    [{ ...P, dshModel: 'm1', agentModel: 'm3' }, 'rollback-agent'],
    // DSH 已跟进、Agent 未应用：回滚 DSH 侧
    [{ ...P, dshModel: 'm2', agentModel: 'm1' }, 'rollback-dsh'],
    // 值集合越出 {previous,target}：绝不猜测
    [{ ...P, dshModel: 'm3', agentModel: 'm3' }, 'clear'], // 双侧一致优先于越界判定
    [{ ...P, dshModel: 'm3', agentModel: 'm2' }, 'undecidable'],
    [{ ...P, dshModel: 'm2', agentModel: 'm3' }, 'undecidable'],
  ] as const)('%j → %s', (args, decision) => {
    expect(decideModelSwitchRecovery(args)).toBe(decision);
  });
});

// ----------：native-only 降级（ACP 子系统不可用的 picker 输入面） ----------

describe(' AcpBackendProbe 派生（native-only 降级）', () => {
  const unavailable: AcpBackendProbe = { status: 'unavailable', message: 'connect ECONNREFUSED' };
  const okBlank: AcpBackendProbe = { status: 'ok', state: null };
  const okAcp: AcpBackendProbe = { status: 'ok', state: { state: 'established', provider: 'acp-devin' } };

  it('filterBucketsOf：unavailable 隐藏 Current/ACP 档；ok/未到达保持既有分档', () => {
    expect(filterBucketsOf(unavailable, true)).toEqual(['all', 'api']);
    expect(filterBucketsOf(unavailable, false)).toEqual(['all', 'api']);
    expect(filterBucketsOf(okAcp, true)).toEqual(['current', 'all', 'api', 'acp']);
    expect(filterBucketsOf(okBlank, false)).toEqual(['all', 'api', 'acp']);
    // probe 尚未到达（null）：保持到场前外观（原生三档），不误判故障
    expect(filterBucketsOf(null, false)).toEqual(['all', 'api', 'acp']);
    expect(filterBucketsOf(null, true)).toEqual(['current', 'all', 'api', 'acp']);
  });

  it('nativeOnlyFilterOf：unavailable 下 Current/ACP 档折叠回 all；其余原样', () => {
    expect(nativeOnlyFilterOf('current', unavailable)).toBe('all');
    expect(nativeOnlyFilterOf('acp', unavailable)).toBe('all');
    expect(nativeOnlyFilterOf('api', unavailable)).toBe('api');
    expect(nativeOnlyFilterOf('all', unavailable)).toBe('all');
    expect(nativeOnlyFilterOf('current', okAcp)).toBe('current');
    expect(nativeOnlyFilterOf('acp', null)).toBe('acp');
  });

  it('acpUnavailableMessageOf：unavailable 点名消息；ok/未到达不上屏', () => {
    expect(acpUnavailableMessageOf(unavailable)).toBe('connect ECONNREFUSED');
    expect(acpUnavailableMessageOf(okBlank)).toBeNull();
    expect(acpUnavailableMessageOf(null)).toBeNull();
  });

  it('Remote unavailable 目录 fail-closed：native 只留 native；ACP 只留当前模型', () => {
    expect(failClosedGroupsForUnavailableProbe([apiGroup, acpGroup], {
      provider: 'deepseek', model: 'deepseek-chat',
    }).map((group) => group.id)).toEqual(['deepseek']);
    expect(failClosedGroupsForUnavailableProbe([apiGroup, acpGroup], {
      provider: 'acp-devin', model: 'devin-latest',
    })).toEqual([{ ...acpGroup, models: [acpGroup.models[0]] }]);
  });
});
