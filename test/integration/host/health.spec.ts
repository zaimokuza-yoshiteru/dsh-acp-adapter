// health.spec.ts — 重写：dshAcp Remote service（src/remote/service.ts）直驱测试。
//
// 时代本文件经假 webServer 直调 handler； HTTP 旁路端点删除，
// 被测对象即 Remote service 本体：`new AcpRemoteService(new Context , deps)`
// 直接调方法。HTTP 层概念（405/404 路由/坏 JSON body）的继任者是 strict
// boundary：参数/返回值的形状校验由生成物（lib/typert.host.js）的 zod codec
// 在 gateway 层承担——「strict codec 边界」describe 用真实产物钉住这点
// （含服务返回值的 round-trip parse，等价于旧契约校验）。
//
// 主矩阵的 executable/version 注入假实现；末尾「seam 版缺省实现」
// describe不注入假实现，改用共享的真实 subprocess-local 服务覆盖默认
// 实现（真 resolveExecutable / 真 `--version` spawn / seam 缺席 fail closed）。
//
// 覆盖：
//   - 注册：构造即注册 cordis 服务 dshAcp；生成物恰好承载六条 invocation
//   - health()：全绿（executable+version+probe ok 含 modelCount/authMethods/loginHint）/
//     缺命令（executable=false → version=null 且 --version 不发起）/probe 超时态
// （failureKind+message 透传）/从未 probe（status 'never'）；：
// health 视图只暴露 Agent probe 与可观测性事实；不会宣称宿主隔离能力。
//     metricsSnapshot 接线时视图顶层 metrics 为快照原值、缺省归 null；
// 密钥边界钉——agent 配置的 env 键名与值（含疑似密钥）绝不出现在视图里；
// 每行携带五态 state（deriveAcpAgentState），Remote 面不再暴露 authenticate
//   - liveOptions(sessionId)：活体快照（configOptions 收窄：select/boolean 保真、
//     未知 type 丢弃）/configOptions 缺席 → null/无活体 throw
// - setOption(sessionId, write)：成功（setConfigOption + 返回最新快照）/
//     mode 类 config option 也走 setConfigOption（setMode 仅无 mode option 的
//     legacy 降级）/boolean 原生 boolean 通过、字符串拒绝/未知 option type 拒绝/
//     忙预检（seam 不调）/seam 竞态错误 message 原样传播/未知 option/非法 value/
//     无活体 throw
// - 五态 state：ready/auth-required/saved-unverified/unavailable/incompatible
//     全分支（probe 新鲜度 = snapshot.key === acpProbeConfigKey(config)）
//   - 错误纪律：业务失败一律 throw Error，message 与用户可见文案逐字一致
//     （gateway 折叠成 RemoteResult 错误分支，client 只消费 message）
//   - strict codec 边界（生成物）：参数 codec 拒绝缺字段/错类型；服务真实输出
//     恒通过 result codec 的 round-trip parse

import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type * as acp from '@agentclientprotocol/sdk';
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE } from '../../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';
import {
  AcpRemoteService,
  type AcpHealthRegistryLike,
  type AcpLiveAgentFace,
  type AcpProbeSnapshotLike,
  type AcpRemoteServiceDeps,
} from '../../../src/remote/service.ts';
import { acpProbeConfigKey, ACP_PROBE_CACHE_ERROR_TTL_MS, ACP_PROBE_CACHE_OK_TTL_MS, type AcpAgentConfig } from '../../../src/domain/session/agent-config.ts';
import { acpCapabilityMatrix } from '../../../src/domain/policy/capability-matrix.ts';
import type { AcpContextUsageView } from '../../../src/contract/remote.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
// 生成物（strict descriptor + zod codec）：codec 边界用例的数据源（d.ts 桩
// 把 TYPERT 标为 unknown，运行时取真值）。
import { TYPERT } from '../../../lib/typert.host.js';

// ---------- 假 registry / 活体 agent / 其余 deps ----------

function createFakeRegistry(agents: Record<string, AcpAgentConfig>, snapshots: Record<string, AcpProbeSnapshotLike | undefined>) {
  const invalidated: string[] = [];
  const reprobed: string[] = [];
  const registry: AcpHealthRegistryLike = {
    agents: () => new Map(Object.entries(agents)),
    probeCache: {
      probeSnapshot: (routeId) => snapshots[routeId],
      invalidateProbe: (routeId) => {
        invalidated.push(routeId);
      },
 // 「重新检查」的重探调用（收尾）：fake 只记录不 spawn。
      listModels: (routeId) => {
        reprobed.push(routeId);
        return Promise.resolve([]);
      },
    },
  };
  return { registry, invalidated, reprobed };
}

const MODEL_OPTION: acp.SessionConfigOption = {
  id: 'model',
  type: 'select',
  category: 'model',
  name: 'Model',
  currentValue: 'devin-fast',
  options: [
    { value: 'devin-fast', name: 'Fast' },
    { value: 'devin-max', name: 'Max' },
  ],
};

const MODE_OPTION: acp.SessionConfigOption = {
  id: 'mode',
  type: 'select',
  category: 'mode',
  name: 'Mode',
  currentValue: 'code',
  options: [
    { value: 'code', name: 'Code' },
    { value: 'plan', name: 'Plan' },
  ],
};

/** boolean 选项（不进默认 configOptions，供 类型保真用例显式启用）。 */
const FAST_OPTION: acp.SessionConfigOption = { id: 'fast', type: 'boolean', name: 'Fast', currentValue: false };

/** 必填键的 live 恒值（freshness 'live' / editable / 指纹未漂移 / 无待定切换）。 */
const LIVE_FIXED = { freshness: 'live', editable: true, fingerprintChanged: false, modelSwitch: { status: 'idle' }, recovery: { dshSessionId: 'sess-1', kind: 'healthy', cause: null, detail: null, provider: null, acpSessionId: null, generation: null, interruptedTurnId: null, lastAttemptAt: null, lastUserAction: null, updatedAt: 0 } } as const;

/** 未知 type 选项（协议：未知类型忽略；写入必须被拒；出栈收窄时丢弃）。 */
const EXOTIC_OPTION = { id: 'temperature', type: 'slider', name: 'Temperature', currentValue: 'low' } as unknown as acp.SessionConfigOption;

interface FakeLiveAgentOverrides {
  status?: 'idle' | 'running';
  /** null = agent 未提供 configOptions（优雅降级矩阵）。 */
  configOptions?: acp.SessionConfigOption[] | null;
  /** null = 模式未知（无推送也无会话响应种子）。 */
  currentModeId?: string | null;
  /** 本会话 initialize 握手的 agent capabilities（缺席 = 未懒启动/未握手）。 */
  agentCapabilities?: acp.AgentCapabilities;
 /** 最新已知上下文占用（缺省 null = 未收到过 usage_update）。 */
  contextUsage?: AcpContextUsageView | null;
  /** seam 注入失败（竞态忙 / 未启动）。 */
  setConfigOptionError?: Error;
  setModeError?: Error;
}

function createFakeLiveAgent(overrides: FakeLiveAgentOverrides = {}) {
  const state = {
    status: overrides.status ?? ('idle' as 'idle' | 'running'),
    configOptions:
      overrides.configOptions === null
        ? undefined
        : (overrides.configOptions ?? [structuredClone(MODEL_OPTION), structuredClone(MODE_OPTION)]),
    currentModeId: overrides.currentModeId === null ? undefined : (overrides.currentModeId ?? ('code' as string | undefined)),
  };
  const calls = { prepare: 0, setConfigOption: [] as Array<[string, string | boolean]>, setMode: [] as string[], rebindBlank: 0, reconnectOriginal: 0, recordRecoveryAction: [] as string[] };
  const face: AcpLiveAgentFace = {
    providerRoute: 'acp-test',
    get status() {
      return state.status;
    },
    get configOptions() {
      return state.configOptions;
    },
    get currentModeId() {
      return state.currentModeId;
    },
    get agentCapabilities() {
      return overrides.agentCapabilities;
    },
    get contextUsage() {
      return overrides.contextUsage ?? null;
    },
    get continuityState() {
      return { status: 'ok' as const, cause: null, detail: null };
    },
    prepare() {
      calls.prepare += 1;
      return Promise.resolve();
    },
    rebindBlank() {
      calls.rebindBlank += 1;
      return Promise.resolve();
    },
    reconnectOriginal() {
      calls.reconnectOriginal += 1;
      return Promise.resolve();
    },
    recordRecoveryAction(action) {
      calls.recordRecoveryAction.push(action);
      return Promise.resolve();
    },
    setConfigOption(configId, value) {
      calls.setConfigOption.push([configId, value]);
      if (overrides.setConfigOptionError !== undefined) return Promise.reject(overrides.setConfigOptionError);
      const option = state.configOptions?.find((candidate) => candidate.id === configId);
      if (option?.type === 'select' && typeof value === 'string') option.currentValue = value;
      if (option?.type === 'boolean' && typeof value === 'boolean') option.currentValue = value;
      return Promise.resolve();
    },
    setMode(modeId) {
      calls.setMode.push(modeId);
      if (overrides.setModeError !== undefined) return Promise.reject(overrides.setModeError);
      state.currentModeId = modeId;
      return Promise.resolve();
    },
  };
  return { face, calls, state };
}

interface DepsParts {
  registry: AcpHealthRegistryLike;
  liveAgents?: Map<string, AcpLiveAgentFace>;
  executable?: Record<string, boolean>;
  versions?: Record<string, string | null>;
 /** 宿主兼容性判定（缺省 = 兼容）。 */
  hostCompatible?: AcpRemoteServiceDeps['hostCompatible'];
 /** true = 不注入 executable/version 假实现（测 seam 版缺省实现）。 */
  useDefaults?: boolean;
 /** seam 解析产物（useDefaults 时决定缺省实现形态）。 */
  subprocess?: AcpRemoteServiceDeps['subprocess'];
 /** 内存指标快照导出（不注入 = 视图 metrics 字段为 null）。 */
  metricsSnapshot?: AcpRemoteServiceDeps['metricsSnapshot'];
 /** backendOf 的事实源假件（不注入 = backendOf 响亮拒绝「未接线」）。 */
  backendFacts?: AcpRemoteServiceDeps['backendFacts'];
 /** boundSessions 的 binding 计数源假件（不注入 = boundSessions 响亮拒绝「未接线」）。 */
  bindingFacts?: AcpRemoteServiceDeps['bindingFacts'];
  imageInputAvailable?: boolean;
}

function buildService(parts: DepsParts) {
  const liveAgents = parts.liveAgents ?? new Map<string, AcpLiveAgentFace>();
  const versionCalls: string[] = [];
  const deps: AcpRemoteServiceDeps = {
    registry: parts.registry,
    resolveLiveAgent: (sessionId) => liveAgents.get(sessionId),
    ...(parts.useDefaults === true
      ? {}
      : {
          checkExecutable: (command) => Promise.resolve(parts.executable?.[command] ?? true),
          queryVersion: (command) => {
            versionCalls.push(command);
            const versions = parts.versions ?? {};
            return Promise.resolve(Object.hasOwn(versions, command) ? (versions[command] ?? null) : `${command} 1.2.3`);
          },
        }),
    ...(parts.hostCompatible === undefined ? {} : { hostCompatible: parts.hostCompatible }),
    ...(parts.subprocess === undefined ? {} : { subprocess: parts.subprocess }),
    ...(parts.metricsSnapshot === undefined ? {} : { metricsSnapshot: parts.metricsSnapshot }),
    ...(parts.backendFacts === undefined ? {} : { backendFacts: parts.backendFacts }),
    ...(parts.bindingFacts === undefined ? {} : { bindingFacts: parts.bindingFacts }),
    ...(parts.imageInputAvailable === undefined ? {} : { imageInputAvailable: parts.imageInputAvailable }),
  };
  const ctx = new Context();
  const service = new AcpRemoteService(ctx, deps);
  return { service, ctx, versionCalls };
}

const DEVIN: AcpAgentConfig = { name: 'Devin', command: 'devin', args: ['acp'], env: {}, loginHint: 'devin auth login' };
const BROKEN: AcpAgentConfig = { name: 'Broken Agent', command: 'no-such-agent-binary', args: [], env: {} };

/** probe 缓存 ok 分支的 initialize 握手原值夹具（随缓存保留并收窄透传到 health 行）。 */
const PROBE_AGENT_INFO = { name: 'devin-acp', version: '1.2.3' };
const PROBE_AGENT_CAPABILITIES: acp.AgentCapabilities = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },
  sessionCapabilities: { list: {} },
};
/** capabilityFactsOf(PROBE_AGENT_CAPABILITIES) 的期望事实（health 行/options 快照共用，共九键）。 */
const PROBE_CAPABILITY_FACTS = {
  loadSession: true,
  sessionList: true,
  sessionClose: false,
  sessionDelete: false,
  promptImage: true,
  promptAudio: false,
  promptEmbeddedContext: true,
  mcpHttp: false,
  mcpSse: false,
};

// probe 缓存有 TTL（ok 10min / error 30s，agent-config.ts acpProbeFresh），
// 夹具 at 取加载时刻（真实 Date.now 的秒级邻居），期望一律引用夹具原值。
const NOW = Date.now();

const OK_SNAPSHOT: AcpProbeSnapshotLike = {
  at: NOW,
 // state 新鲜度判定按 acpProbeFresh（key 相等 + 未过 TTL），夹具 key 与 DEVIN 对齐。
  key: acpProbeConfigKey(DEVIN),
  result: {
    kind: 'ok',
    models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    authMethods: [{ id: 'devin-browser', name: 'Browser login', description: null }],
    agentInfo: PROBE_AGENT_INFO,
    agentCapabilities: PROBE_AGENT_CAPABILITIES,
 // 清理事实与 capability hash 随 ok 条目透传到 health 行
    cleanup: { close: 'not-advertised', delete: 'done' },
    capabilityHash: 'abcdef0123456789',
  },
};

const TIMEOUT_SNAPSHOT: AcpProbeSnapshotLike = {
  at: NOW + 1,
  key: acpProbeConfigKey(DEVIN),
  result: {
    kind: 'error',
    failureKind: 'timeout',
    error: { message: '探测 ACP agent "devin" 超时（agent 未在时限内应答 initialize/session/new）' },
    probePhase: 'session',
  },
};

const SPAWN_FAILURE_SNAPSHOT: AcpProbeSnapshotLike = {
  at: NOW + 2,
  key: acpProbeConfigKey(BROKEN),
  result: {
    kind: 'error',
    failureKind: 'spawn-failure',
    error: { message: '无法启动 ACP agent 命令 "no-such-agent-binary"（命令不存在或不可执行）' },
    probePhase: 'initialize',
  },
};

/** fake 活体的默认连续性快照（ok，全 null 词表）。 */
const OK_CONTINUITY = { status: 'ok' as const, cause: null, detail: null };

/** 取 ok 分支结果（夹具变体展开用）。 */
function okResultOf(snapshot: AcpProbeSnapshotLike) {
  if (snapshot.result.kind !== 'ok') throw new Error('expected an ok probe snapshot fixture');
  return snapshot.result;
}

// ---------- 注册 ----------

describe('AcpRemoteService 注册', () => {
  it('构造即注册 cordis 服务 dshAcp（gateway 经 strict descriptor 按名取实例）', async () => {
    const { registry } = createFakeRegistry({}, {});
    const { service, ctx } = buildService({ registry });
    // cordis ctx.get 返回 traceable proxy（包调用方上下文的 tracing 包装），身份
    // 不等于原实例——能钉的是：注册存在、原型即本类、经 proxy 调用落到同一行为。
    const resolved = ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
    expect(resolved).toBeInstanceOf(AcpRemoteService);
    await expect(resolved.health()).resolves.toEqual(await service.health());
    // gateway source-mode 发现的真凭据：TypertRemoteService 暴露的冻结绑定。
    expect(service.typertRemote.serviceKey).toBe('dshAcp');
    expect(service.typertRemote.namespace).toBe('dshAcp');
    expect(service.typertRemote.service).toBe(service);
  });

 it('生成物恰好承载十六条 invocation（模型/会话、ACP 权限与 elicitation；authenticate 移出 Remote 面）', () => {
    const manifest = TYPERT as {
      package: string;
      invocations: Array<{ id: string; parameters: Array<{ name: string }>; cancellation?: { parameter: string } }>;
    };
    expect(manifest.package).toBe('@zaimokuza/dsh-acp-adapter');
    expect(manifest.invocations.map((invocation) => invocation.id)).toEqual([
      '@zaimokuza/dsh-acp-adapter#dshAcp/answerElicitation',
      '@zaimokuza/dsh-acp-adapter#dshAcp/answerPermission',
      '@zaimokuza/dsh-acp-adapter#dshAcp/backendOf',
      '@zaimokuza/dsh-acp-adapter#dshAcp/beginModelSwitch',
      '@zaimokuza/dsh-acp-adapter#dshAcp/boundSessions',
      '@zaimokuza/dsh-acp-adapter#dshAcp/cancelElicitation',
      '@zaimokuza/dsh-acp-adapter#dshAcp/cancelPermission',
      '@zaimokuza/dsh-acp-adapter#dshAcp/commitModelSwitch',
      '@zaimokuza/dsh-acp-adapter#dshAcp/health',
      '@zaimokuza/dsh-acp-adapter#dshAcp/options',
      '@zaimokuza/dsh-acp-adapter#dshAcp/pendingElicitations',
      '@zaimokuza/dsh-acp-adapter#dshAcp/pendingPermissions',
      '@zaimokuza/dsh-acp-adapter#dshAcp/rebindBlank',
      '@zaimokuza/dsh-acp-adapter#dshAcp/reconnectOriginal',
      '@zaimokuza/dsh-acp-adapter#dshAcp/recordRecoveryAction',
      '@zaimokuza/dsh-acp-adapter#dshAcp/rollbackModelSwitch',
      '@zaimokuza/dsh-acp-adapter#dshAcp/setOption',
    ]);
  });
});

describe('dshAcp/reconnectOriginal', () => {
  it('调用原 ACP 会话重连动作并返回 recovery 快照', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.reconnectOriginal('sess-1');
    expect(agent.calls.reconnectOriginal).toBe(1);
    expect(snapshot.recovery.kind).toBe('healthy');
  });
});

describe('dshAcp/recordRecoveryAction', () => {
  it('records an explicit recovery decision without changing the execution route', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.recordRecoveryAction('sess-1', 'new-session');
    expect(agent.calls.recordRecoveryAction).toEqual(['new-session']);
    expect(snapshot.recovery.kind).toBe('healthy');
  });
});

// ---------- health ----------

describe('dshAcp/health', () => {
  it('全绿：executable/version/probe ok（modelCount + authMethods）/loginHint 全量上报', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry });
    await expect(service.health()).resolves.toEqual({
      providers: [
        {
          id: 'devin',
          name: 'Devin',
          command: 'devin',
          args: ['acp'],
          loginHint: 'devin auth login',
          executable: true,
          version: 'devin 1.2.3',
 // 边界：devin 按 id 回退命中 descriptor（声明 opaqueRefs）+ 新鲜 ok probe 且有模型 → ready
          state: 'ready',
          probe: {
            status: 'ok',
            at: OK_SNAPSHOT.at,
            modelCount: 3,
            authMethods: [{ id: 'devin-browser', name: 'Browser login', description: null }],
            agentInfo: PROBE_AGENT_INFO,
            capabilities: PROBE_CAPABILITY_FACTS,
 // 清理事实（三态 + message 收窄为 null）与 capability hash 透传
            cleanup: { close: 'not-advertised', delete: 'done', message: null },
            capabilityHash: 'abcdef0123456789',
 // 端到端能力矩阵（probe-ok 必填键；直接用被测纯函数计算，避免复述）
            matrix: acpCapabilityMatrix(PROBE_CAPABILITY_FACTS),
 // 边界：fake probe 快照未带 protocolVersion → null 词表；devin
            // descriptor 无版本 pin → versionPolicy 双 null、compatibility 'unpinned'
            protocolVersion: null,
            versionPolicy: { adapter: null, wrappedCli: null },
            versionCompatibility: 'unpinned',
          },
        },
      ],
 // 未接线 metricsSnapshot 时如实归 null
      metrics: null,
 // 未注入 listLiveSessions 时如实归 null（区分「未接线」与「无活体会话」）
      liveSessions: null,
    });
  });

 it('readiness：钉版比对——握手版本等于钉版 → pinned（protocolVersion 透传），不等 → drifted', async () => {
    const CODEX: AcpAgentConfig = { name: 'Codex', command: 'codex-acp', args: [], env: {}, runtime: 'codex' };
    const codexSnapshot = (version: string): AcpProbeSnapshotLike => ({
      at: NOW,
      key: acpProbeConfigKey(CODEX),
      result: {
        kind: 'ok',
        models: [{ id: 'm1' }],
        authMethods: [],
        agentInfo: { name: 'codex-acp', version },
        agentCapabilities: PROBE_AGENT_CAPABILITIES,
        cleanup: { close: 'not-advertised', delete: 'done' },
        capabilityHash: 'abcdef0123456789',
        protocolVersion: 1,
      },
    });
    const pinned = buildService({ registry: createFakeRegistry({ codex: CODEX }, { 'acp-codex': codexSnapshot('1.6.2') }).registry });
    const pinnedRow = (await pinned.service.health()).providers[0];
    if (pinnedRow?.probe.status !== 'ok') throw new Error('expected an ok probe row');
    expect(pinnedRow.probe.protocolVersion).toBe(1);
    expect(pinnedRow.probe.versionPolicy).toEqual({ adapter: '1.6.2', wrappedCli: null });
    expect(pinnedRow.probe.versionCompatibility).toBe('pinned');

    const drifted = buildService({ registry: createFakeRegistry({ codex: CODEX }, { 'acp-codex': codexSnapshot('1.6.9') }).registry });
    const driftedRow = (await drifted.service.health()).providers[0];
    if (driftedRow?.probe.status !== 'ok') throw new Error('expected an ok probe row');
    expect(driftedRow.probe.versionCompatibility).toBe('drifted');
  });

  it('缺命令：executable=false → version=null 且不发起 --version；spawn-failure probe 透传；无 loginHint 归 null', async () => {
    const { registry } = createFakeRegistry({ broken: BROKEN }, { 'acp-broken': SPAWN_FAILURE_SNAPSHOT });
    const { service, versionCalls } = buildService({ registry, executable: { 'no-such-agent-binary': false } });
    await expect(service.health()).resolves.toEqual({
      providers: [
        {
          id: 'broken',
          name: 'Broken Agent',
          command: 'no-such-agent-binary',
          args: [],
          loginHint: null,
          executable: false,
          version: null,
 // 边界：broken 无 descriptor（未声明 auth refs）+ 新鲜 error probe → unavailable
          state: 'unavailable',
          probe: {
            status: 'error',
            at: SPAWN_FAILURE_SNAPSHOT.at,
            failureKind: 'spawn-failure',
            message: '无法启动 ACP agent 命令 "no-such-agent-binary"（命令不存在或不可执行）',
            phase: 'initialize',
          },
        },
      ],
      metrics: null,
 // 未注入 listLiveSessions 时如实归 null（区分「未接线」与「无活体会话」）
      liveSessions: null,
    });
    expect(versionCalls).toEqual([]);
  });

  it('超时态：--version 超时归 null（尽力而为）；probe timeout 的 failureKind/message 透传', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': TIMEOUT_SNAPSHOT });
    const { service, versionCalls } = buildService({ registry, versions: { devin: null } });
    await expect(service.health()).resolves.toEqual({
      providers: [
        {
          id: 'devin',
          name: 'Devin',
          command: 'devin',
          args: ['acp'],
          loginHint: 'devin auth login',
          executable: true,
          version: null,
 // 新鲜 error probe（timeout）→ unavailable
          state: 'unavailable',
          probe: {
            status: 'error',
            at: TIMEOUT_SNAPSHOT.at,
            failureKind: 'timeout',
            message: '探测 ACP agent "devin" 超时（agent 未在时限内应答 initialize/session/new）',
            phase: 'session',
          },
        },
      ],
      metrics: null,
 // 未注入 listLiveSessions 时如实归 null（区分「未接线」与「无活体会话」）
      liveSessions: null,
    });
    expect(versionCalls).toEqual(['devin']);
  });

 it(' metrics 接线：视图顶层 metrics 为注册表快照原值（计数/延迟聚合透传）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const snapshot = {
      startedAt: 1_756_000_000_000,
      counters: [{ name: 'acp.cancel', labels: { cause: 'user' }, value: 2 }],
      timers: [{ name: 'acp.probe', labels: { provider: 'acp-devin', result: 'ok' }, count: 1, totalMs: 42, minMs: 42, maxMs: 42 }],
    } as const;
    const { service } = buildService({ registry, metricsSnapshot: () => snapshot });
    const view = await service.health();
    expect(view.metrics).toEqual(snapshot);
  });

 it(' 密钥边界钉：agent 配置的 env 键名与值（含疑似密钥）绝不出现在 health 视图里', async () => {
    const withSecrets: AcpAgentConfig = {
      ...DEVIN,
      env: { DEVIN_API_KEY: 'sk-live-secret-value-9f8e7d', PLAIN_FLAG: '1' },
    };
    const { registry } = createFakeRegistry({ devin: withSecrets }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry });
    const wire = JSON.stringify(await service.health());
    expect(wire).not.toContain('sk-live-secret-value-9f8e7d');
    expect(wire).not.toContain('DEVIN_API_KEY');
    expect(wire).not.toContain('PLAIN_FLAG');
  });

  it('probe 失败未标记阶段（旧缓存/未分类错误）：phase 如实归 null，不猜测到达点', async () => {
    const unmarked: AcpProbeSnapshotLike = {
      at: NOW + 3,
      key: acpProbeConfigKey(DEVIN),
      result: { kind: 'error', failureKind: 'protocol-error', error: { message: 'unexpected response' } },
    };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': unmarked });
    const { service } = buildService({ registry });
    const view = await service.health();
    expect(view.providers[0]?.probe).toEqual({
      status: 'error',
      at: NOW + 3,
      failureKind: 'protocol-error',
      message: 'unexpected response',
      phase: null,
    });
  });

 it('从未 probe：status never、at null； state 归 saved-unverified', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    const view = await service.health();
    expect(view.providers[0]?.probe).toEqual({ status: 'never', at: null });
    expect(view.providers[0]?.state).toBe('saved-unverified');
  });

 it('能力矩阵随 probe-ok 行下发：图片需 Agent 广告与 attachment seam 同时满足', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry, imageInputAvailable: true });
    const view = await service.health();
    const probe = view.providers[0]?.probe;
    if (probe?.status !== 'ok') throw new Error('expected an ok probe row');
    expect(probe.matrix).toEqual(acpCapabilityMatrix(PROBE_CAPABILITY_FACTS, { imageInput: true }));
    const imageRow = probe.matrix.find((row) => row.id === 'promptImage');
    expect(imageRow).toMatchObject({ advertised: true, status: 'supported', adapterPath: 'durable-attachment-to-inline-image', hostSeam: 'attachments' });
  });

 it(' 钉：Remote 面不再暴露 authenticate（登录只在 agent 自己的 CLI 完成）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    // 读取路径照常工作，但 service 上不存在任何 authenticate 入口。
    await service.health();
    await service.liveOptions('sess-1');
    expect((service as unknown as Record<string, unknown>)['authenticate']).toBeUndefined();
  });
});

// ---------- liveOptions(sessionId) ----------

describe('dshAcp/options', () => {
  it('活体：返回 configOptions/currentModeId 快照（select/boolean 收窄保真）；未握手/未接线时 capabilities/sandbox 归 null', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    expect(await service.liveOptions('sess-1')).toEqual({
      sessionId: 'sess-1',
      configOptions: [MODEL_OPTION, MODE_OPTION],
      currentModeId: 'code',
      capabilities: null,
      continuity: OK_CONTINUITY,
      contextUsage: null,
      ...LIVE_FIXED,
    });
    expect(agent.calls.prepare).toBe(1);
  });

  it('收窄钉：未知 type 的 config option 出栈即丢弃（client 解码器 SHOULD-ignore 同效）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(MODEL_OPTION), structuredClone(EXOTIC_OPTION)] });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.liveOptions('sess-1');
    expect(snapshot.configOptions?.map((option) => option.id)).toEqual(['model']);
  });

 it(' 能力披露：已握手活体带 capabilities 事实', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ agentCapabilities: PROBE_AGENT_CAPABILITIES });
    const { service } = buildService({
      registry,
      liveAgents: new Map([['sess-1', agent.face]]),
    });
    expect(await service.liveOptions('sess-1')).toEqual({
      sessionId: 'sess-1',
      configOptions: [MODEL_OPTION, MODE_OPTION],
      currentModeId: 'code',
      capabilities: PROBE_CAPABILITY_FACTS,
      continuity: OK_CONTINUITY,
      contextUsage: null,
      ...LIVE_FIXED,
    });
  });

  it('活体但 agent 未提供 configOptions：null 归一', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: null, currentModeId: null });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    expect(await service.liveOptions('sess-1')).toEqual({ sessionId: 'sess-1', configOptions: null, currentModeId: null, capabilities: null, continuity: OK_CONTINUITY, contextUsage: null, ...LIVE_FIXED });
  });

 it('：contextUsage 三态——未收到 usage_update 归 null；有快照直通（含 cost 透传）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    // 无快照：诚实 null（不虚构零值）
    const empty = createFakeLiveAgent();
    const withUsage = createFakeLiveAgent({
      contextUsage: { used: 200, size: 1000, percent: 20, cost: { amount: 0.5, currency: 'USD' } },
    });
    const noCost = createFakeLiveAgent({
      contextUsage: { used: 1, size: 10, percent: 10, cost: null },
    });
    const { service } = buildService({
      registry,
      liveAgents: new Map([['s-empty', empty.face], ['s-used', withUsage.face], ['s-nocost', noCost.face]]),
    });
    expect((await service.liveOptions('s-empty')).contextUsage).toBeNull();
    expect((await service.liveOptions('s-used')).contextUsage).toEqual({
      used: 200, size: 1000, percent: 20, cost: { amount: 0.5, currency: 'USD' },
    });
    expect((await service.liveOptions('s-nocost')).contextUsage).toEqual({ used: 1, size: 10, percent: 10, cost: null });
  });

  it('无活体且无 last-known 快照：throw（message 逐字；HTTP 时代 404 not-found 的继任）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    await expect(service.liveOptions('ghost')).rejects.toThrow(
      'no live ACP agent for session "ghost" (not an ACP session, or already disposed)',
    );
  });
});

// ---------- rebindBlank(sessionId) ----------

describe('dshAcp/rebindBlank', () => {
  it('成功：调用活体 rebindBlank 并返回复位后的最新快照（continuity 归 ok）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.rebindBlank('sess-1');
    expect(agent.calls.rebindBlank).toBe(1);
    expect(snapshot).toEqual({
      sessionId: 'sess-1',
      configOptions: [MODEL_OPTION, MODE_OPTION],
      currentModeId: 'code',
      capabilities: null,
      continuity: OK_CONTINUITY,
      contextUsage: null,
      ...LIVE_FIXED,
    });
  });

  it('无活体：throw（与 options 同款 404 继任文案）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    await expect(service.rebindBlank('ghost')).rejects.toThrow(
      'no live ACP agent for session "ghost" (not an ACP session, or already disposed)',
    );
  });

  it('活体拒绝（忙/settling/拆除失败）：错误原样传播', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const boom = new Error('agent "sess-1": rebindBlank is only allowed while idle');
    agent.face.rebindBlank = () => Promise.reject(boom);
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.rebindBlank('sess-1')).rejects.toBe(boom);
  });
});

// ---------- backendOf(sessionId) ----------

describe('dshAcp/backendOf', () => {
  /** 四路事实源的旋钮假件（缺省：全部无事实、会话存在但无 header）。 */
  function fakeFacts(overrides: {
    binding?: string;
    header?: string;
    peekThrows?: boolean;
    live?: boolean;
  } = {}): NonNullable<AcpRemoteServiceDeps['backendFacts']> {
    return {
      readBindingProvider: () => Promise.resolve(overrides.binding),
      peekHeaderProvider: () =>
        overrides.peekThrows === true
          ? Promise.reject(new Error('no such session'))
          : Promise.resolve(overrides.header),
      hasLiveAgent: () => overrides.live ?? false,
    };
  }

  it('活体 AcpAgent 不能越过持久化真源：binding 在场才 established', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({
      registry,
      liveAgents: new Map([['sess-1', agent.face]]),
      backendFacts: fakeFacts({ binding: 'acp-test', header: 'deepseek' }),
    });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'established', provider: 'acp-test' });
  });

  it('尚未 session/new 但已有 AcpAgent → established（避免空白会话误建第二个会话）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({
      registry,
      liveAgents: new Map([['sess-1', agent.face]]),
      backendFacts: fakeFacts({ live: true }),
    });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'established', provider: 'acp-test' });
  });

  it('无活体、sidecar binding 在场 → established（覆盖 header 空洞：ACP 会话创建即有 binding）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry, backendFacts: fakeFacts({ binding: 'acp-devin' }) });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'established', provider: 'acp-devin' });
  });

  it('无活体无 binding、日志 request/header 在场 → established（native 路由如实回报）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry, backendFacts: fakeFacts({ header: 'deepseek' }) });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'established', provider: 'deepseek' });
  });

  it('三路皆无 → blank（blank 会话的 current.provider 只是实时默认的影子，不算定 backend）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry, backendFacts: fakeFacts() });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'blank' });
  });

  it('日志不可读但有任意 backend 的活体 agent → blank（活体即存在性证据；无 header 即未定）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry, backendFacts: fakeFacts({ peekThrows: true, live: true }) });
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'blank' });
  });

  it('会话不存在（无任何在场证据且日志不可读）→ 响亮 protocol-error，不冒充 blank', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry, backendFacts: fakeFacts({ peekThrows: true }) });
    const error = await service.backendOf('ghost').then(
      () => { throw new Error('expected backendOf to reject'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('protocol-error');
    expect((error as Error).message).toContain('"ghost"');
  });

  it('backendFacts 未接线 → 响亮 protocol-error（未接线不冒充 blank）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    await expect(service.backendOf('sess-1')).rejects.toThrow('not wired');
  });
});

// ---------- boundSessions(agentId)（删除确认提示的 binding 计数） ----------

describe('dshAcp/boundSessions', () => {
  it('bindingFacts 计数原样透传（provider 按 acp-<agentId> 路由换算）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const seen: string[] = [];
    const { service } = buildService({
      registry,
      bindingFacts: {
        countBoundSessions: (provider) => {
          seen.push(provider);
          return Promise.resolve(3);
        },
      },
    });
    await expect(service.boundSessions('devin')).resolves.toEqual({ agentId: 'devin', count: 3 });
    expect(seen).toEqual(['acp-devin']);
  });

  it('agent id 非法 → 响亮 protocol-error（不进 bindingFacts）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    let called = false;
    const { service } = buildService({
      registry,
      bindingFacts: {
        countBoundSessions: () => {
          called = true;
          return Promise.resolve(0);
        },
      },
    });
    const error = await service.boundSessions('Devin Agent').then(
      () => { throw new Error('expected boundSessions to reject'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('protocol-error');
    expect(called).toBe(false);
  });

  it('bindingFacts 未接线 → 响亮 protocol-error（未接线不冒充 0）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    await expect(service.boundSessions('devin')).rejects.toThrow('not wired');
  });
});

// ---------- setOption(sessionId, write) ----------

describe('dshAcp/setOption', () => {
  it('成功：setConfigOption 收到 (configId, value)，返回最新完整快照', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.setOption('sess-1', { configId: 'mode', value: 'plan' });
    expect(agent.calls.setConfigOption).toEqual([['mode', 'plan']]);
    expect(agent.calls.setMode).toEqual([]);
    expect(snapshot).toEqual({
      sessionId: 'sess-1',
      configOptions: [MODEL_OPTION, { ...MODE_OPTION, currentValue: 'plan' }],
      currentModeId: 'code',
      capabilities: null,
      continuity: OK_CONTINUITY,
      contextUsage: null,
      ...LIVE_FIXED,
    });
  });

  it('model 类拒发：beginModelSwitch 是唯一模型写路径（seam 不调用，含 id 直名与 category 两种识别）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'model', value: 'devin-max' })).rejects.toThrow(
      'config option "model" is a model-class option',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('legacy 降级：无 mode config option 但 currentModeId 已知 → setMode，快照 currentModeId 已更新', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(MODEL_OPTION)] });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.setOption('sess-1', { configId: 'mode', value: 'plan' });
    expect(agent.calls.setMode).toEqual(['plan']);
    expect(agent.calls.setConfigOption).toEqual([]);
    expect(snapshot.currentModeId).toBe('plan');
  });

  it('legacy 降级只收 string：boolean value → throw（set_mode 协议无 boolean）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(MODEL_OPTION)] });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: true })).rejects.toThrow(
      'legacy session/set_mode takes a string mode id; got true',
    );
    expect(agent.calls.setMode).toEqual([]);
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('mode 能力全无（无 option 且 currentModeId 未知）→ throw（无此 config option）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(MODEL_OPTION)], currentModeId: null });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: 'plan' })).rejects.toThrow(
      'session "sess-1" exposes no config option "mode"',
    );
    expect(agent.calls.setMode).toEqual([]);
  });

  it('boolean option：原生 boolean 通过（seam 收到原生 boolean），字符串 "true" → throw', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(FAST_OPTION)] });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    const snapshot = await service.setOption('sess-1', { configId: 'fast', value: true });
    expect(agent.calls.setConfigOption).toEqual([['fast', true]]);
    expect(snapshot.configOptions?.[0]?.currentValue).toBe(true);
    await expect(service.setOption('sess-1', { configId: 'fast', value: 'true' })).rejects.toThrow(
      'config option "fast" is boolean; the value must be a JSON boolean, got "true"',
    );
    expect(agent.calls.setConfigOption).toHaveLength(1);
  });

  it('select option 收到 boolean value → throw，seam 不调用', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: true })).rejects.toThrow(
      'true is not a selectable value of config option "mode"',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('未知 option type → throw（协议：未知类型忽略，写入被拒）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ configOptions: [structuredClone(EXOTIC_OPTION)] });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'temperature', value: 'high' })).rejects.toThrow(
      'config option "temperature" has unsupported type "slider"; only select/boolean writes are defined',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('忙（非 idle）：throw busy 文案，两个 seam 均不调用', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({ status: 'running' });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'model', value: 'devin-max' })).rejects.toThrow(
      'agent for session "sess-1" is running a turn; retry when idle',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
    expect(agent.calls.setMode).toEqual([]);
  });

  it('竞态忙（预检后 seam 抛 only allowed while idle）：message 原样传播', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({
      setConfigOptionError: new Error('agent "sess-1": setConfigOption is only allowed while idle'),
    });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: 'plan' })).rejects.toThrow(
      'agent "sess-1": setConfigOption is only allowed while idle',
    );
  });

  it('ACP 会话未懒启动（seam 抛 not started yet）：message 原样传播', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent({
      setConfigOptionError: new Error('agent "sess-1": ACP session is not started yet (no turn has run)'),
    });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: 'plan' })).rejects.toThrow(
      'agent "sess-1": ACP session is not started yet (no turn has run)',
    );
  });

  it('未知 option：throw，seam 不调用', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'nope', value: 'x' })).rejects.toThrow(
      'session "sess-1" exposes no config option "nope"',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('select 非法 value：throw，seam 不调用', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const agent = createFakeLiveAgent();
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });
    await expect(service.setOption('sess-1', { configId: 'mode', value: 'nonexistent-mode' })).rejects.toThrow(
      '"nonexistent-mode" is not a selectable value of config option "mode"',
    );
    expect(agent.calls.setConfigOption).toEqual([]);
  });

  it('无活体：throw（message 逐字）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({ registry });
    await expect(service.setOption('ghost', { configId: 'model', value: 'devin-max' })).rejects.toThrow(
      'no live ACP agent for session "ghost" (not an ACP session, or already disposed)',
    );
  });
});

// ----------：五态 state 矩阵 ----------

describe('dshAcp/health 五态 state', () => {
  it('ok probe 但零模型仍只表示协议可用，不能据此推断未登录', async () => {
    const zeroModels: AcpProbeSnapshotLike = {
      at: NOW + 4,
      key: acpProbeConfigKey(DEVIN),
      result: {
        kind: 'ok',
        models: [],
        authMethods: [{ id: 'devin-browser', name: 'Browser login', description: null }],
        agentInfo: PROBE_AGENT_INFO,
        agentCapabilities: PROBE_AGENT_CAPABILITIES,
      },
    };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': zeroModels });
    const { service } = buildService({ registry });
    const row = (await service.health()).providers[0];
    expect(row?.state).toBe('ready');
  });

  it(' 目录口径：ok probe 零模型但 configOptions 含 category=model 项 → ready（kimi 形态，不再是 auth-required 误判）', async () => {
    const kimiShape: AcpProbeSnapshotLike = {
      at: NOW + 4,
      key: acpProbeConfigKey(DEVIN),
      result: {
        kind: 'ok',
        models: [],
        hasModelConfigOption: true,
        authMethods: [{ id: 'login', name: 'Login with Kimi account', description: null }],
        agentInfo: PROBE_AGENT_INFO,
        agentCapabilities: PROBE_AGENT_CAPABILITIES,
      },
    };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': kimiShape });
    const { service } = buildService({ registry });
    expect((await service.health()).providers[0]?.state).toBe('ready');
  });

  it('error probe failureKind=auth_required → auth-required（与模型数无关）', async () => {
    const authRequired: AcpProbeSnapshotLike = {
      at: NOW + 5,
      key: acpProbeConfigKey(DEVIN),
      result: { kind: 'error', failureKind: 'auth_required', error: { message: 'ACP agent "devin" reported auth_required' } },
    };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': authRequired });
    const { service } = buildService({ registry });
    expect((await service.health()).providers[0]?.state).toBe('auth-required');
  });

  it('probe 快照 key 与当前 config 不匹配（陈旧缓存）→ saved-unverified', async () => {
    const stale: AcpProbeSnapshotLike = { ...OK_SNAPSHOT, key: 'stale-key-from-older-config' };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': stale });
    const { service } = buildService({ registry });
    const row = (await service.health()).providers[0];
    // probe 行照常展示快照内容，但 state 不采信陈旧结果
    expect(row?.probe.status).toBe('ok');
    expect(row?.state).toBe('saved-unverified');
  });

 it(' TTL：ok 条目过 10 分钟过期 → saved-unverified（probe 行仍如实展示上次探测事实）', async () => {
    const expired: AcpProbeSnapshotLike = { ...OK_SNAPSHOT, at: Date.now() - ACP_PROBE_CACHE_OK_TTL_MS - 1 };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': expired });
    const { service } = buildService({ registry });
    const row = (await service.health()).providers[0];
    expect(row?.probe.status).toBe('ok');
    expect(row?.state).toBe('saved-unverified');
  });

 it(' TTL：error 条目过 30 秒过期 → saved-unverified（负缓存短窗口兜底新鲜度）', async () => {
    const expired: AcpProbeSnapshotLike = { ...TIMEOUT_SNAPSHOT, at: Date.now() - ACP_PROBE_CACHE_ERROR_TTL_MS - 1 };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': expired });
    const { service } = buildService({ registry });
    const row = (await service.health()).providers[0];
    expect(row?.probe.status).toBe('error');
    expect(row?.state).toBe('saved-unverified');
  });

 it(' 清理降级透出：delete 未广告/失败的 cleanup 事实原样过线（message 收窄为 string）', async () => {
    const notAdvertised: AcpProbeSnapshotLike = {
      ...OK_SNAPSHOT,
      result: { ...okResultOf(OK_SNAPSHOT), cleanup: { close: 'not-advertised', delete: 'not-advertised' } },
    };
    const failed: AcpProbeSnapshotLike = {
      ...OK_SNAPSHOT,
      result: { ...okResultOf(OK_SNAPSHOT), cleanup: { close: 'not-advertised', delete: 'failed', message: 'session/delete failed: boom' } },
    };
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': notAdvertised });
    const { service } = buildService({ registry });
    const row = (await service.health()).providers[0];
    expect(row?.probe.status).toBe('ok');
    if (row?.probe.status === 'ok') {
      expect(row.probe.cleanup).toEqual({ close: 'not-advertised', delete: 'not-advertised', message: null });
    }
    const { registry: registry2 } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': failed });
    const { service: service2 } = buildService({ registry: registry2 });
    const row2 = (await service2.health()).providers[0];
    if (row2?.probe.status === 'ok') {
      expect(row2.probe.cleanup).toEqual({ close: 'not-advertised', delete: 'failed', message: 'session/delete failed: boom' });
    }
  });

  it('宿主不兼容 → incompatible（其余字段照常展示）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry, hostCompatible: () => false });
    const row = (await service.health()).providers[0];
    expect(row?.state).toBe('incompatible');
    expect(row?.probe.status).toBe('ok');
  });

  it('ok probe 且无 descriptor（普通 profile，未声明 auth refs）→ ready（不看模型数）', async () => {
    const zeroModels: AcpProbeSnapshotLike = {
      at: NOW + 6,
      key: acpProbeConfigKey(BROKEN),
      result: { kind: 'ok', models: [], authMethods: [], agentInfo: PROBE_AGENT_INFO, agentCapabilities: PROBE_AGENT_CAPABILITIES },
    };
    const { registry } = createFakeRegistry({ broken: BROKEN }, { 'acp-broken': zeroModels });
    const { service } = buildService({ registry });
    expect((await service.health()).providers[0]?.state).toBe('ready');
  });
});

// ---------- 收尾：「重新检查」（recheck）接线 ----------

describe(' 收尾：health recheck（面板「重新检查」按钮）', () => {
  it('recheck=true：每个 provider 先 invalidateProbe 再 listModels 重探，健康行照常产出', async () => {
    const { registry, invalidated, reprobed } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry });
    const row = (await service.health({ recheck: true })).providers[0];
    expect(invalidated).toEqual(['acp-devin']);
    expect(reprobed).toEqual(['acp-devin']);
    // fake 重探后快照仍是 OK_SNAPSHOT：行按（重探后的）快照照常产出
    expect(row?.state).toBe('ready');
    expect(row?.probe.status).toBe('ok');
  });

  it('recheck 缺省/false：只读缓存视图，invalidateProbe/listModels 均不调（面板打开不 spawn probe）', async () => {
    const { registry, invalidated, reprobed } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry });
    await service.health();
    await service.health({});
    await service.health({ recheck: false });
    expect(invalidated).toEqual([]);
    expect(reprobed).toEqual([]);
  });

  it('recheck=true 且重探失败：失败不抛出（失败条目落缓存即失败事实），行按缓存照常产出', async () => {
    const { registry, invalidated, reprobed } = createFakeRegistry({ devin: DEVIN }, {});
    registry.probeCache.listModels = (routeId) => {
      reprobed.push(routeId);
      return Promise.reject(new Error('spawn failed'));
    };
    const { service } = buildService({ registry });
    const row = (await service.health({ recheck: true })).providers[0];
    expect(invalidated).toEqual(['acp-devin']);
    expect(reprobed).toEqual(['acp-devin']);
    // fake 缓存无条目 → saved-unverified（重探失败的真实服务会把失败条目落缓存）
    expect(row?.state).toBe('saved-unverified');
  });

  it('recheck=true + agentId：只检查并返回目标 provider', async () => {
    const agents = { devin: DEVIN, broken: BROKEN };
    const { registry, invalidated, reprobed } = createFakeRegistry(agents, {
      'acp-devin': OK_SNAPSHOT,
      'acp-broken': undefined,
    });
    const { service, versionCalls } = buildService({ registry });
    const view = await service.health({ recheck: true, agentId: 'devin' });
    expect(view.providers.map((row) => row.id)).toEqual(['devin']);
    expect(invalidated).toEqual(['acp-devin']);
    expect(reprobed).toEqual(['acp-devin']);
    expect(versionCalls).toEqual(['devin']);
  });

  it('agentId 不允许脱离 recheck，未知 agent 也会 fail closed', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const { service } = buildService({ registry });
    await expect(service.health({ agentId: 'devin' })).rejects.toThrow('requires recheck=true');
    await expect(service.health({ recheck: true, agentId: 'missing' })).rejects.toThrow('unknown ACP agent');
  });
});

// ---------- 错误纪律 ----------

describe('错误纪律', () => {
  it('业务失败一律 throw Error（message 即用户可见文案；kind/HTTP status 不再过线）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const busyAgent = createFakeLiveAgent({ status: 'running' });
    const { service } = buildService({
      registry,
      liveAgents: new Map([['busy-sess', busyAgent.face]]),
    });
    const failures: unknown[] = await Promise.all([
      Promise.resolve().then(() => service.liveOptions('ghost')).catch((error: unknown) => error),
      service.setOption('busy-sess', { configId: 'model', value: 'devin-max' }).catch((error: unknown) => error),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(typeof (failure as Error).message).toBe('string');
      expect((failure as Error).message.length).toBeGreaterThan(0);
    }
  });
});

// ---------- strict codec 边界（生成物 lib/typert.host.js） ----------

describe('strict codec 边界（生成物）', () => {
  // 生成物形状：parameter 的 codec 嵌套在 `codec` 键下，result 是扁平 codec
  // （{mode, typeSymbol, schema}——无 `.codec` 层）。
  interface InvocationView {
    id: string;
    parameters: Array<{ name: string; codec: { mode: string; schema: { parse(value: unknown): unknown } } }>;
    result: { mode: string; schema: { parse(value: unknown): unknown } };
  }
  const invocations = (TYPERT as { invocations: InvocationView[] }).invocations;
  const byId = (id: string): InvocationView => {
    const found = invocations.find((invocation) => invocation.id === id);
    if (found === undefined) throw new Error(`invocation missing: ${id}`);
    return found;
  };

  it('全部参数/返回值 codec 均为 strict 模式（SRC 弱解析不兜底）', () => {
    for (const invocation of invocations) {
      for (const parameter of invocation.parameters) expect(parameter.codec.mode).toBe('strict');
      expect(invocation.result.mode).toBe('strict');
    }
  });

  it('setOption 的 request codec：缺 value / 错类型拒绝（HTTP 时代 400 bad-request 的继任）', () => {
    const request = byId('@zaimokuza/dsh-acp-adapter#dshAcp/setOption').parameters[1]!;
    expect(request.name).toBe('request');
    expect(() => request.codec.schema.parse({ configId: 'model' })).toThrow();
    expect(() => request.codec.schema.parse({ configId: 'model', value: 42 })).toThrow();
    expect(() => request.codec.schema.parse({ configId: 'model', value: 'devin-max' })).not.toThrow();
    expect(() => request.codec.schema.parse({ configId: 'fast', value: true })).not.toThrow();
  });

  it('round-trip：服务真实输出恒通过 result codec（health/options/setOption）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, { 'acp-devin': OK_SNAPSHOT });
    const agent = createFakeLiveAgent({ agentCapabilities: PROBE_AGENT_CAPABILITIES });
    const { service } = buildService({ registry, liveAgents: new Map([['sess-1', agent.face]]) });

    const health = await service.health();
    expect(() => byId('@zaimokuza/dsh-acp-adapter#dshAcp/health').result.schema.parse(health)).not.toThrow();

    const options = await service.liveOptions('sess-1');
    expect(() => byId('@zaimokuza/dsh-acp-adapter#dshAcp/options').result.schema.parse(options)).not.toThrow();

    const updated = await service.setOption('sess-1', { configId: 'mode', value: 'plan' });
    expect(() => byId('@zaimokuza/dsh-acp-adapter#dshAcp/setOption').result.schema.parse(updated)).not.toThrow();
  });
});

// ----------：seam 版缺省实现（真实 subprocess-local 服务；不注入假实现） ----------

describe('seam 版缺省实现', () => {
  it('seam ok：真 resolveExecutable 对绝对路径（process.execPath）→ executable=true，version 为 `<cmd> --version` 首行', async () => {
    const seam = (await sharedTestSubprocess()).seam;
    const { registry } = createFakeRegistry(
      { node: { name: 'Node', command: process.execPath, args: [], env: {} } },
      {},
    );
    const { service } = buildService({ registry, useDefaults: true, subprocess: { ok: true, seam } });
    const view = await service.health();
    const row = view.providers[0];
    expect(row?.executable).toBe(true);
    expect(row?.version).toMatch(/^v\d+\./);
  });

  it('seam ok：不存在命令 → executable=false、version=null（--version 不发起）', async () => {
    const seam = (await sharedTestSubprocess()).seam;
    const { registry } = createFakeRegistry({ broken: BROKEN }, {});
    const { service } = buildService({ registry, useDefaults: true, subprocess: { ok: true, seam } });
    const view = await service.health();
    const row = view.providers[0];
    expect(row?.executable).toBe(false);
    expect(row?.version).toBeNull();
  });

  it('seam 缺席：executable=false / version=null（fail closed，不发起任何 spawn）', async () => {
    const { registry } = createFakeRegistry({ devin: DEVIN }, {});
    const { service } = buildService({
      registry,
      useDefaults: true,
      subprocess: { ok: false, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE },
    });

    const view = await service.health();
    const row = view.providers[0];
    expect(row?.executable).toBe(false);
    expect(row?.version).toBeNull();
  });
});
