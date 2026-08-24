/**
 * dshAcp Remote service。
 *
 * 登录遵循 external-login-only：用户只在 Agent 自带 CLI 中登录，面板仅展示
 * 探针状态和 loginHint。模型热切换只允许通过
 * beginModelSwitch/commitModelSwitch/rollbackModelSwitch 事务执行；普通 setOption
 * 拒绝模型类写入。没有活体 Agent 时，options 返回 sidecar 中只读的 last-known
 * 快照（freshness 'stale' / editable false）。公开方法为：
 * health / options / setOption / rebindBlank / backendOf /
 * boundSessions / beginModelSwitch / commitModelSwitch / rollbackModelSwitch。
 * 所有调用都走宿主 typed Remote，不保留手写 HTTP 写旁路。
 *
 * 边界形态：
 * - `AcpRemoteService extends TypertRemoteService`（`super(ctx, 'dshAcp')`），方法
 *   以 `@Remote` 标注；strict descriptor/zod codec 由构建期
 *   `scripts/gen-typert.mjs` 生成（lib/typert.host.{js,d.ts} +
 *   lib/typert.remote-client.{js,d.ts}），host 侧经 typert-loader 自动注册进
 *   `ctx.typert`，client 侧 `ctx.remote.$mount(contribution)` 挂载。
 * - wire 类型全部来自 src/contract/remote.ts 的收窄 contract（SDK v1 类型的
 *   `_meta: Record<string, unknown>` 过不了 strict boundary，且 client 本就只
 *   消费收窄字段）；SDK → contract 的显式映射在本文件（数据最小化：auth 的
 *   vars/env 键名、config option 的 `_meta` 不过线）。
 * - 活体解析用 JSON `sessionId: string` 参数 + 方法体内 `resolveLiveAgent`：
 *   标准 agent lookup 的 wire 类型外部不可命名。写路径仍只服务
 * 活体会话（无活体即抛错）； `options` 读路径在无活体时回 sidecar
 *   last-known 快照（stale 只读），不再一律抛错。
 * - 错误纪律：业务失败一律 throw（message 即用户可见文案，与 HTTP 时代逐字
 *   一致）；gateway 把 throw 折叠成 `{code:'internal', message}` 的
 *   RemoteResult 错误分支（kind/HTTP status 不再过线，client 从来只消费
 *   message——parseHttpErrorMessage 同款口径）。
 *
 * Subprocess seam（不变）：两个缺省实现（可执行预检 / `<command> --version`）
 * 全经宿主公共 seam `ctx.subprocess` 的解析产物（deps.subprocess 注入）——
 * 本模块不触碰 `node:child_process`。seam 缺席时缺省实现 fail closed：
 * executable=false、version=null。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；本文件是 host 侧
 * 子进程模块，经下方 triple-slash reference 显式引入 @types/node
 * （src/protocol/v1/connection.ts 同款先例），不改动共享 tsconfig。
 * @module @zaimokuza/dsh-acp-adapter/remote/service
 */

/// <reference types="node" />

import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type * as acp from '@agentclientprotocol/sdk'
import { acpRouteId, acpAgentIdFromRoute, ACP_AGENT_ID_PATTERN } from '../domain/session/agent-config.ts'
import { acpProbeConfigKey, acpProbeFresh, acpVersionCompatibility, descriptorDeclaresAuthRefs, descriptorOf } from '../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentRuntimeDescriptor } from '../domain/session/agent-config.ts'
import { ACP_MODE_OPTION_ID } from '../domain/session/agent-config.ts'
import { deriveAcpAgentState } from '../domain/session/agent-state.ts'
import type { AcpAgentStateProbeView } from '../domain/session/agent-state.ts'
import { acpCapabilityMatrix } from '../domain/policy/capability-matrix.ts'
import type { AcpSessionContinuityState } from '../domain/session/agent.ts'
import type { AcpMetricsSnapshot } from '../domain/observability/metrics.ts'
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE } from '../runtime/process/subprocess.ts'
import { abortAfter } from '../runtime/process/timeout.ts'
import type { AcpSubprocessHandle, SubprocessSeam, SubprocessSeamResolution } from '../runtime/process/subprocess.ts'
import { AcpClientError } from '../protocol/v1/errors.ts'
import type {
  AcpAuthMethod,
  AcpBackendState,
  AcpBoundSessionsView,
  AcpCapabilityFacts,
  AcpConfigOption,
  AcpConfigSelectValue,
  AcpContextUsageView,
  AcpHealthView,
  AcpHealthRequest,
  AcpLiveOptionsSnapshot,
  AcpLiveSessionContinuity,
  AcpModelSwitchBeginRequest,
  AcpModelSwitchBeginResult,
  AcpModelSwitchResolveRequest,
  AcpModelSwitchView,
  AcpOptionWrite,
  AcpProbeCleanupView,
  AcpProviderHealth,
  AcpSandboxPosture,
  AcpSessionContinuity,
} from '../contract/remote.ts'

/** `<command> --version` 尽力而为的短超时（毫秒）。 */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 3_000

// ---------- SDK → contract 收窄映射（数据最小化； strict boundary 前提） ----------

/**
 * 把 initialize 响应的 `AgentCapabilities` 实际值归一化为展示事实；
 * 未握手/未广告（undefined/null）归 null（UI 显示「未知」，绝不编造）。
 */
export function capabilityFactsOf(caps: acp.AgentCapabilities | null | undefined): AcpCapabilityFacts | null {
  if (caps === undefined || caps === null) return null
  return {
    loadSession: caps.loadSession === true,
    sessionList: caps.sessionCapabilities?.list != null,
    sessionClose: caps.sessionCapabilities?.close != null,
    sessionDelete: caps.sessionCapabilities?.delete != null,
    promptImage: caps.promptCapabilities?.image === true,
    promptAudio: caps.promptCapabilities?.audio === true,
    promptEmbeddedContext: caps.promptCapabilities?.embeddedContext === true,
    mcpHttp: caps.mcpCapabilities?.http === true,
    mcpSse: caps.mcpCapabilities?.sse === true,
  }
}

/** AuthMethod → 收窄三键（每个变体都有 id/name/description；vars/args/env/_meta 不过线）。 */
function contractAuthMethodOf(method: acp.AuthMethod): AcpAuthMethod {
  return {
    id: method.id,
    name: method.name,
    ...(method.description === undefined ? {} : { description: method.description }),
  }
}

function contractSelectValueOf(value: acp.SessionConfigSelectOption): AcpConfigSelectValue {
  return {
    value: value.value,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
  }
}

/**
 * SessionConfigOption → 收窄判别联合（剔 `_meta`）。未知 type 归 null（协议
 * SHOULD-ignore：client 解码器本就跳过该项，host 映射丢弃同效，agent 默认值
 * 在位）——SDK 类型只承认 select/boolean，本分支兜运行时说谎的 agent。
 */
function contractConfigOptionOf(option: acp.SessionConfigOption): AcpConfigOption | null {
  const base = {
    id: option.id,
    name: option.name,
    ...(option.description === undefined ? {} : { description: option.description }),
    ...(option.category === undefined ? {} : { category: option.category }),
  }
  if (option.type === 'select') {
    return {
      ...base,
      type: 'select',
      currentValue: option.currentValue,
      options: option.options.map((entry) => 'options' in entry
        ? { group: entry.group, name: entry.name, options: entry.options.map(contractSelectValueOf) }
        : contractSelectValueOf(entry)),
    }
  }
  if (option.type === 'boolean') {
    return { ...base, type: 'boolean', currentValue: option.currentValue }
  }
  return null
}

/** configOptions 数组收窄；agent 未提供（undefined）归 null（与快照契约的 null 词表一致）。 */
function contractConfigOptionsOf(options: readonly acp.SessionConfigOption[] | undefined): readonly AcpConfigOption[] | null {
  if (options === undefined) return null
  const mapped: AcpConfigOption[] = []
  for (const option of options) {
    const narrowed = contractConfigOptionOf(option)
    if (narrowed !== null) mapped.push(narrowed)
  }
  return mapped
}

// ---------- 依赖注入面（接线；测试给假） ----------

/**
 * Probe-cache face the health method uses
 * （`AcpStubAdapter.probeSnapshot/invalidateProbe/listModels` 结构面；ok 分支的
 * authMethods 现在随缓存保留、过线前收窄）。`listModels` 是「重新检查」
 * （收尾）的重探触发器：失败同样落缓存（缓存的错误即失败事实），调用方
 * catch 后读新快照。
 */
export interface AcpProbeCacheLike {
  probeSnapshot(routeId: string): AcpProbeSnapshotLike | undefined
  invalidateProbe(routeId: string): void
  /** 触发一次重探（结果落缓存）；reject = 探测失败（失败条目已落缓存）。 */
  listModels(routeId: string): Promise<unknown>
}

/**
 * llm-stub 探针缓存条目的结构面（key 配置哈希 + at 时间戳 + 成功/失败分支；
 * SDK 原值，出栈前收窄）。新鲜度判定集中在 agent-config.ts
 * `acpProbeFresh`：key 与当前配置的 `acpProbeConfigKey` 相等且未过 TTL
 * （ok 10min / error 30s）才算新鲜；不新鲜/缺席按「从未探测」计入 state
 * （probe 行仍如实展示上次探测事实）。ok 分支的 cleanup/capabilityHash 是
 * 新增——旧条目（或测试夹具）缺席时 health 行如实归 null。
 */
export interface AcpProbeSnapshotLike {
  readonly key: string
  readonly at: number
  readonly result:
    | {
        readonly kind: 'ok'
        readonly models: readonly unknown[]
        readonly authMethods?: readonly acp.AuthMethod[]
 /** initialize 握手原值（现在随缓存保留；缺失时 health 行归 null）。 */
        readonly agentInfo?: acp.Implementation | null | undefined
        readonly agentCapabilities?: acp.AgentCapabilities | undefined
 /** probe 会话清理事实（缺席时 health 行归 null）。 */
        readonly cleanup?: { readonly close: string; readonly delete: string; readonly message?: string | undefined } | undefined
 /** initialize 握手能力的 sha256-16（缺席时 health 行归 null）。 */
        readonly capabilityHash?: string | undefined
 /** initialize 协商的协议版本（边界；缺席时 health 行归 null）。 */
        readonly protocolVersion?: number | undefined
        /**
         * configOptions 是否含 `category=model` 项（ 五态目录口径；
         * 旧条目/测试夹具缺席时按「无 model 类 configOption」计，与引入前逐字节一致）。
         */
        readonly hasModelConfigOption?: boolean | undefined
      }
    | {
        readonly kind: 'error'
        readonly failureKind: string
        readonly error: { readonly message: string }
 /** probe 失败阶段（未标记时 health 行归 null）。 */
        readonly probePhase?: 'initialize' | 'session' | undefined
      }
}

/** Registry face: agent 列表 + probe 缓存（快照/刷新）。 */
export interface AcpHealthRegistryLike {
  agents(): ReadonlyMap<string, AcpAgentConfig>
  readonly probeCache: AcpProbeCacheLike
}

/**
 * Live-agent seam consumed by the options methods。`AcpAgent`（src/domain/session/agent.ts
 * 的 status/configOptions/currentModeId/setConfigOption/setMode/continuityState/
 * rebindBlank 公开面）结构上满足本接口；集成任务提供 dsh sessionId → AcpAgent 的解析器。
 * 类型保真：setConfigOption 的 value 按协议原生类型（select=string 值 id /
 * boolean=原生 boolean）。
 */
export interface AcpLiveAgentFace {
  readonly status: 'idle' | 'running'
 /** 本会话的 provider 路由（`acp-<id>`； `backendOf` 的权威 backend 判定之一）。 */
  readonly providerRoute: string
  readonly configOptions: readonly acp.SessionConfigOption[] | undefined
  readonly currentModeId: string | undefined
  /** 本会话 initialize 握手的 agent capabilities 实际值（未懒启动时缺席 → 快照归 null）。 */
  readonly agentCapabilities?: acp.AgentCapabilities | undefined
  /**
 * 最新已知上下文占用（translator 快照直通，未收到过 usage_update 归
   * null——诚实空缺）。wire 形状与 contract `AcpContextUsageView` 结构一致。
   */
  readonly contextUsage: AcpContextUsageView | null
 /** 连续性闩锁状态（直通进快照的 `continuity` 字段）。 */
  readonly continuityState: AcpSessionContinuityState
  /**
 * workspace-write 沙箱档对本 profile 的可用性（边界；直通进快照的
   * `workspaceWrite` 必填键）。本地状态 agent 恒 'unsupported'。
   */
  readonly workspaceWriteSupport: 'supported' | 'unsupported'
  setConfigOption(configId: string, value: string | boolean): Promise<void>
  setMode(modeId: string): Promise<void>
 /** 显式放弃旧 ACP 上下文并重开全新 ACP 会话（仅 idle，错误原样传播）。 */
  rebindBlank(): Promise<void>
}

/** Resolve a dsh session id to its live ACP agent；undefined = 无活体（调用即抛错）。 */
export type AcpResolveLiveAgent = (sessionId: string) => AcpLiveAgentFace | undefined

// ---------- 持久 seam 的结构副本（remote 层不得 import persistence——test/contracts/architecture.spec.ts） ----------

/**
 * sidecar `AcpPendingModelSwitch` 的结构副本（真源与状态机注释见
 * src/persistence/sidecar.ts）。remote 层以结构面消费，生产接线 =
 * host/factory/agent-loop.ts 的 sidecar 闭包。
 */
export interface AcpPendingModelSwitchLike {
  readonly operationId: string
  readonly dshSessionId: string
  readonly provider: string
  readonly optionId: string
  readonly previousModel: string
  readonly targetModel: string
  readonly appliedModel?: string
  readonly state: 'started' | 'agent-applied' | 'agent-rolled-back' | 'committed' | 'rollback-required'
  readonly createdAt: string
}

/** sidecar `AcpPendingModelSwitchLookup` 的结构副本（corrupt = 行畸形，按 reconciliation-required 处理）。 */
export type AcpPendingModelSwitchLookupLike =
  | { readonly status: 'ok'; readonly record: AcpPendingModelSwitchLike }
  | { readonly status: 'corrupt' }

/** sidecar `AcpOptionsSnapshotRecord` 的结构副本（冷启动 last-known 快照）。 */
export interface AcpOptionsSnapshotLike {
  readonly options: readonly {
    readonly id: string
    readonly category: string | null
    readonly name: string
    readonly value: string | boolean
    readonly values: readonly string[] | null
  }[]
  readonly currentModeId: string | null
  readonly updatedAt: number
  readonly fingerprint: string
}

export interface AcpRemoteServiceDeps {
  /** Registry：agent 列表 + probe 缓存（快照/刷新）。 */
  registry: AcpHealthRegistryLike
 /** 活体 agent 解析器（接线提供真实实现）。 */
  resolveLiveAgent: AcpResolveLiveAgent
  /**
 * 宿主结构门事实（；缺省恒 true）：health 行的五态 `state` 字段在
   * 结构门未通过时归 `incompatible`。生产接线 = host/factory/agent-loop.ts 以
   * `assertHostCompatible` 的 try/catch 组装（remote 层不得 import host-compat
   * ——test/contracts/architecture.spec.ts 白名单）。
   */
  hostCompatible?: () => boolean
  /** 可执行存在性检查；缺省 `seam.resolveExecutable`（seam 缺席时恒 false）。 */
  checkExecutable?: (command: string) => Promise<boolean>
  /** 版本查询；缺省经 seam 的 `<command> --version` 尽力而为（seam 缺席时恒 null）。 */
  queryVersion?: (command: string) => Promise<string | null>
  /**
 * 加载期解析的 subprocess seam（host/factory/agent-loop.ts 注入）。
   * 仅驱动两个缺省实现：ok 时 checkExecutable=resolveExecutable 预检、
   * queryVersion=经 seam spawn `<command> --version`；缺席/未接线时缺省实现
   * fail closed（false / null）。显式注入的 checkExecutable/queryVersion 不受
   * 本字段影响。
   */
  subprocess?: SubprocessSeamResolution
  /**
 * 本平台沙箱强制级别事实（enforcement 透传；缺省时 health 视图的
   * `sandbox` 字段为 null）。生产接线 = host/factory/agent-loop.ts 以
   * `createDefaultSandboxPlatform()` 的 enforcementExpectation/enforcementNote
 * 组装；probe 路径与本字段无关（probe 绝不触发认证，登录只发生在
   * agent 自家 CLI，权限分离由 health.spec.ts / acp-client.spec.ts 钉死）。
   */
  sandboxPosture?: AcpSandboxPosture
  /**
 * 内存指标快照导出（缺省时 health 视图的顶层 `metrics` 字段为 null）。
   * 生产接线 = host/factory/agent-loop.ts 的共享 `AcpMetricsRegistry.snapshot`。
   * 快照只含计数/延迟聚合与低基标签（result/cause/provider），绝无
   * id/路径/内容——与 metrics registry 的标签纪律同源。
   */
  metricsSnapshot?: () => AcpMetricsSnapshot
  /**
 * 活体 ACP 会话的连续性清单（health 视图 `liveSessions` 字段的数据源）。
   * 缺省 → 该字段归 null（如实区分「未接线」与「无活体会话」的空数组）。生产
   * 接线 = host/factory/agent-loop.ts 以 `ctx.agents.list()` 过滤 AcpAgent。
   */
  listLiveSessions?: () => readonly { readonly sessionId: string; readonly continuity: AcpSessionContinuityState }[]
  /**
 * `backendOf` 的 backend 事实源（缺席时 backendOf 响亮拒绝——未接线
   * 不冒充 blank）。生产接线 = host/factory/agent-loop.ts：
   * - `readBindingProvider`：sidecar 最新 binding 的 provider（ok 且语义门槛
   *   通过）；无记录/读取失败/outdated 归 undefined（binding 读取失败非权威，
   *   与 resume 的 readBindingFor 同款容错）；
   * - `peekHeaderProvider`：日志末条 request/header 的 provider（只读
   *   inspect 窥测，resume 同款手法）；会话存在但无 header 归 undefined，
   *   会话不存在/日志不可读/无持久化后端则 throw；
   * - `hasLiveAgent`：任意 backend 的活体 agent 在场判定（session 存在性证据）。
   */
  backendFacts?: {
    readonly readBindingProvider: (sessionId: string) => Promise<string | undefined>
    readonly peekHeaderProvider: (sessionId: string) => Promise<string | undefined>
    readonly hasLiveAgent: (sessionId: string) => boolean
  }
  /**
 * `boundSessions` 的 binding 计数源（删除确认提示；缺席时 boundSessions
   * 响亮拒绝——未接线不冒充 0）。生产接线 = host/factory/agent-loop.ts 以
   * sidecar.listBindings 按 provider 过滤计数（只读）。
   */
  bindingFacts?: {
    readonly countBoundSessions: (provider: string) => Promise<number>
  }
  /**
 * 待定模型切换的持久 seam（sidecar `model_switches` 表闭包；缺席时
   * beginModelSwitch 响亮拒绝——无持久事务不授权切换，fail-closed）。生产接线 =
   * host/factory/agent-loop.ts 的 sidecar 读写闭包（write 的 record 自带
   * dshSessionId）。
   */
  modelSwitchStore?: {
    readonly read: (sessionId: string) => Promise<AcpPendingModelSwitchLookupLike | undefined>
    readonly write: (record: AcpPendingModelSwitchLike) => Promise<void>
    readonly clear: (sessionId: string) => Promise<void>
  }
  /**
 * last-known option 快照的只读 seam（sidecar `option_snapshots` 表闭包）：
   * 无活体 Agent 时 liveOptions 回 stale 快照；缺席或无快照时维持旧行为（抛
   * 「no live ACP agent」）。写路径在 domain 的 AcpAgent（权威快照到达即刷新），
   * 不经本服务。
   */
  optionSnapshotStore?: {
    readonly read: (sessionId: string) => Promise<AcpOptionsSnapshotLike | undefined>
  }
  /**
 * stale 快照的指纹比对源：以当前 profile 配置重组运行时指纹（与
   * AcpAgent.optionsSnapshotFingerprint 同公式）。返回 undefined（未接线/会话
   * 无 binding）→ fingerprintChanged 恒 false。生产接线 =
   * host/factory/agent-loop.ts。
   */
  snapshotFingerprint?: (sessionId: string) => Promise<string | undefined>
}

// ---------- 缺省实现：executable / version（全经宿主 subprocess seam） ----------

/**
 * `<command> --version` 尽力而为：首行 stdout（空则 stderr 首行），截 200 字符；
 * 超时（terminate 升级，SIGKILL 必杀，不留孤儿）/spawn 失败/无输出 → null。
 * env 不传：provider 的 scrub 底座（去 credential 形名 + DSH_*，PATH/代理穿透）
 * 已够版本探针用，比旧「全量继承 process.env」更安全。
 */
async function acpQueryVersion(
  seam: SubprocessSeam,
  command: string,
  timeoutMs: number = DEFAULT_VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  let handle: AcpSubprocessHandle
  try {
    handle = seam.spawn({
      argv: [command, '--version'],
      cwd: os.tmpdir(),
      // 超时后 terminate 的升级间隔：版本探针求快死，不铺 2s 的会话级礼貌窗口
      graceMs: VERSION_PROBE_TERM_GRACE_MS,
    })
  } catch {
    return null
  }
  const { stdin, stdout, stderr } = handle
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    // pipe/pipe/pipe 由窄化适配器固定；缺场 = 实现违约，收回进程按失败处理
    handle.terminate()
    return null
  }
  const done = handle.done.catch((): null => null)
  let out = ''
  let err = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => {
    out += chunk
  })
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => {
    err += chunk
  })
  try {
    stdin.end()
  } catch {
    // 对端抢跑退出不阻塞读取
  }
  const deadline = abortAfter(timeoutMs)
  try {
    // waitForExit（整树）与 done（close 结算，含 spawn 级失败）先到先赢
    const gone = await Promise.race([handle.waitForExit(deadline.signal), done.then(() => true)])
    if (!gone) {
      // 超时：terminate（SIGTERM → graceMs → SIGKILL；Windows taskkill /T /F）后无界等整树死绝
      handle.terminate()
      await handle.waitForExit()
      await done
      return null
    }
    await done
    return firstLine(out) ?? firstLine(err)
  } finally {
    deadline.cancel()
  }
}

/** 版本探针 terminate 的 SIGTERM → SIGKILL 升级间隔（毫秒）：探针求快死，不用会话级的 2s。 */
const VERSION_PROBE_TERM_GRACE_MS = 500

function firstLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line !== '') return line.length > 200 ? line.slice(0, 200) : line
  }
  return null
}

// ---------- Remote service ----------

interface ResolvedDeps {
  readonly registry: AcpHealthRegistryLike
  readonly resolveLiveAgent: AcpResolveLiveAgent
  readonly hostCompatible: () => boolean
  readonly checkExecutable: (command: string) => Promise<boolean>
  readonly queryVersion: (command: string) => Promise<string | null>
 /** 缺省 null（host 未接线时视图如实不带 sandbox 事实）。 */
  readonly sandboxPosture: AcpSandboxPosture | null
 /** 缺省 null（host 未接线时视图如实不带指标快照）。 */
  readonly metricsSnapshot: (() => AcpMetricsSnapshot) | null
 /** 缺省 null（host 未接线时视图如实不带活体会话连续性清单）。 */
  readonly listLiveSessions: (() => readonly { readonly sessionId: string; readonly continuity: AcpSessionContinuityState }[]) | null
 /** 缺省 null（backendOf 未接线时响亮拒绝，不冒充 blank）。 */
  readonly backendFacts: NonNullable<AcpRemoteServiceDeps['backendFacts']> | null
 /** 缺省 null（boundSessions 未接线时响亮拒绝，不冒充 0）。 */
  readonly bindingFacts: NonNullable<AcpRemoteServiceDeps['bindingFacts']> | null
 /** 缺省 null（beginModelSwitch 未接线时响亮拒绝，fail-closed）。 */
  readonly modelSwitchStore: NonNullable<AcpRemoteServiceDeps['modelSwitchStore']> | null
 /** 缺省 null（无活体时 liveOptions 维持旧抛错行为）。 */
  readonly optionSnapshotStore: NonNullable<AcpRemoteServiceDeps['optionSnapshotStore']> | null
 /** 缺省 null（fingerprintChanged 恒 false）。 */
  readonly snapshotFingerprint: ((sessionId: string) => Promise<string | undefined>) | null
}

/**
 * dshAcp namespace 的 Remote service（构造即注册 cordis service，gateway 经
 * strict descriptor 找到实例并调用）。方法清单（前三条对应旧旁路路由，
 * rebindBlank 是 新增，model-switch 三方法见）：
 * - `health()`                    ← GET /dsh-acp/health（provider 行 + 顶层
 *   sandbox 事实 + metrics 快照；**密钥边界** 只回显 command/args/loginHint，
 * env 永不在响应里——钉版见 test/integration/host/health.spec.ts；每行携带五态
 *   `state`，派生规则见 src/domain/session/agent-state.ts）
 * - `options(sessionId)` ← GET /dsh-acp/sessions/<id>/options（
 *   无活体时回 sidecar last-known 快照——freshness 'stale' / editable false）
 * - `setOption(sessionId, write)` ← POST …/options（路由不变：已广告的
 *   config option 一律走 setConfigOption——mode 类也不例外；setMode 只剩
 * legacy modes-only 降级），返回最新快照；** model 类选项拒收**（唯一
 *   写入口是 beginModelSwitch 的持久事务）
 * - `rebindBlank(sessionId)` ←：显式放弃旧 ACP 上下文、重开全新 ACP
 *   会话（reconciliation-required 的出路之一），返回复位后的选项快照
 * - `boundSessions(agentId)` ←：删除确认提示的 binding 计数（该
 *   profile 被多少个既有会话引用），纯读
 * - `beginModelSwitch(sessionId, request)` ←：模型热切换的持久事务
 *   （预检 → 落 `started` fail-closed → set_config_option → 读 actualModel →
 *   落 `agent-applied`；失败进回滚臂，回滚失败 → rollback-required 锁定）
 * - `commitModelSwitch(sessionId, request)` ←：DSH 侧接受后的收束
 *   （幂等；写 committed 后清行）
 * - `rollbackModelSwitch(sessionId, request)` ←：Agent 写回 previousModel
 *   并持久化 `agent-rolled-back`；client 证明 DSH 也回到 previous 后再 commit
 *   清行（幂等；无活体响亮拒绝并指明 resume/rebind 出路）
 *
 * 全部依赖注入（{@link AcpRemoteServiceDeps}）；测试直接 new 实例驱动方法，
 * 不再经过 HTTP req/res 假件。
 */
export class AcpRemoteService extends TypertRemoteService {
  private readonly resolved: ResolvedDeps

  constructor(ctx: Context, deps: AcpRemoteServiceDeps) {
    super(ctx, 'dshAcp')
 // seam 解析产物只驱动缺省实现；显式注入的 deps 原样优先（测试全注入假实现）。
    const subprocess = deps.subprocess ?? { ok: false as const, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE }
    this.resolved = {
      registry: deps.registry,
      resolveLiveAgent: deps.resolveLiveAgent,
 // host 未接线结构门事实时按兼容处理（纯模块单测路径；生产恒注入）
      hostCompatible: deps.hostCompatible ?? (() => true),
      checkExecutable: deps.checkExecutable ?? (subprocess.ok
        ? // `command -v` 等价物：宿主 seam 的 PATH 解析（Windows 含 PATHEXT 语义），零 spawn 副作用
          (command: string) => subprocess.seam.resolveExecutable(command).then(() => true, () => false)
        : () => Promise.resolve(false)),
      queryVersion: deps.queryVersion ?? (subprocess.ok
        ? (command: string) => acpQueryVersion(subprocess.seam, command)
        : () => Promise.resolve(null)),
      sandboxPosture: deps.sandboxPosture ?? null,
      metricsSnapshot: deps.metricsSnapshot ?? null,
      listLiveSessions: deps.listLiveSessions ?? null,
      backendFacts: deps.backendFacts ?? null,
      bindingFacts: deps.bindingFacts ?? null,
      modelSwitchStore: deps.modelSwitchStore ?? null,
      optionSnapshotStore: deps.optionSnapshotStore ?? null,
      snapshotFingerprint: deps.snapshotFingerprint ?? null,
    }
  }

 /** 在飞切换闩锁（sessionId → 在飞操作；并发点击/重复投递的进程内第一道闸）。 */
  private readonly modelSwitchInflight = new Map<string, { readonly operationId: string; readonly targetModel: string }>()

  /**
 * 全部 provider 的健康行（executable/version/probe 快照收窄透传 + 五态
   * `state`）+ 沙箱/指标/活体会话连续性事实。`request.recheck === true`（面板
 * 「重新检查」按钮， 收尾接线）时先丢弃该 provider 的 probe 缓存再触发一次
   * 重探（listModels——probe 自身有界，失败落负缓存即失败事实），健康行按新鲜
   * 快照产出；缺省只读缓存视图（面板打开不 spawn probe）。
   */
  @Remote
  async health(request?: AcpHealthRequest): Promise<AcpHealthView> {
    const entries = [...this.resolved.registry.agents().entries()].sort(([left], [right]) => left.localeCompare(right))
    // 五态派生的宿主结构门输入（每行共享同一事实；deps 缺省恒 true）
    const hostCompatible = this.resolved.hostCompatible()
    const recheck = request?.recheck === true
    const providers: AcpProviderHealth[] = await Promise.all(
      entries.map(async ([id, config]) => {
        if (recheck) {
 // 「重新检查」强制丢弃 probe cache 并重探（条文的接线路径）；重探
          // 失败不抛出——失败条目落缓存，下方照常按新鲜度产出 unavailable 行。
          const routeId = acpRouteId(id)
          this.resolved.registry.probeCache.invalidateProbe(routeId)
          await this.resolved.registry.probeCache.listModels(routeId).catch(() => undefined)
        }
        const executable = await this.resolved.checkExecutable(config.command)
        // 命令不存在时跳过 --version（必败），version 归 null
        const version = executable ? await this.resolved.queryVersion(config.command) : null
        const snapshot = this.resolved.registry.probeCache.probeSnapshot(acpRouteId(id))
 // 新鲜度集中判定（agent-config.ts acpProbeFresh）：key 相等且未过
        // TTL（ok 10min / error 30s）才算新鲜；不新鲜/缺席按「从未探测」计入
        // state（probe 行仍如实展示上次探测事实）。
        const fresh = snapshot !== undefined && acpProbeFresh(snapshot, acpProbeConfigKey(config), Date.now()) ? snapshot : undefined
 // readiness 派生：descriptor 一次解析，五态派生（declaresAuthRefs）与 readiness
        // 版本字段（versionPolicy/兼容状态）共用同一绑定事实。
        const descriptor = descriptorOf(id, config)
        return {
          id,
          name: config.name,
          command: config.command,
          args: [...config.args],
          loginHint: config.loginHint ?? null,
          executable,
          version,
          probe: probeRow(snapshot, this.resolved.sandboxPosture, descriptor),
          // registry 的 agents map 经 settings schema 校验（非法值根本写不进来），configValid 恒 true
          state: deriveAcpAgentState({
            hostCompatible,
            configValid: true,
            probe: fresh === undefined ? undefined : probeStateView(fresh),
            declaresAuthRefs: descriptorDeclaresAuthRefs(descriptor),
          }),
        }
      }),
    )
    const liveSessions: AcpLiveSessionContinuity[] | null = this.resolved.listLiveSessions === null
      ? null
      : this.resolved.listLiveSessions().map((entry) => ({ sessionId: entry.sessionId, continuity: entry.continuity }))
    return {
      providers,
      sandbox: this.resolved.sandboxPosture,
      metrics: this.resolved.metricsSnapshot === null ? null : this.resolved.metricsSnapshot(),
      liveSessions,
    }
  }

  /**
   * 活体会话的 configOptions/currentModeId 快照（收窄后）；capabilities/sandbox 是
 * null 词表必填键。：无活体 Agent 但 sidecar 存有界 last-known 快照时返回
   * stale 副本（freshness 'stale'、editable false、全部控件只读）；无活体且无
   * 快照维持旧抛错行为。
   */
  @Remote('options')
  async liveOptions(sessionId: string): Promise<AcpLiveOptionsSnapshot> {
    const agent = this.resolved.resolveLiveAgent(sessionId)
    if (agent !== undefined) return this.liveSnapshot(sessionId, agent)
    return this.staleSnapshot(sessionId)
  }

  /**
   * 写一个活体选项并返回最新快照。校验失败/忙/无活体一律 throw（message 与
   * HTTP 时代逐字一致；gateway 折叠成 RemoteResult 错误分支，client 只消费
   * message）。
   *
 * model 类选项（category 'model' 或约定 id 'model'）一律拒收——模型
   * 热切换的唯一写入口是 beginModelSwitch 的持久事务（setOption 旧 model 分支
   * 已删除）；stale 快照（无活体）天然在本方法之外（requireLiveAgent 先抛）。
   */
  @Remote('setOption')
  async setOption(sessionId: string, request: AcpOptionWrite): Promise<AcpLiveOptionsSnapshot> {
    const agent = this.requireLiveAgent(sessionId)
    const { configId, value } = request
    if (agent.status !== 'idle') {
      throw new Error(`agent for session "${sessionId}" is running a turn; retry when idle`)
    }
    const option = agent.configOptions?.find((candidate) => candidate.id === configId)
    if (configId === 'model' || option?.category === 'model') {
      throw new Error(
        `config option "${configId}" is a model-class option; switch models via the model picker ` +
        '(beginModelSwitch) so the change is journaled and rollback-safe — direct setOption writes are refused',
      )
    }
    if (option === undefined) {
 // legacy 降级：agent 未镜像 mode 类 config option 但 legacy modes 状态已知
      // ⇒ 唯一走 session/set_mode 的路径（set_mode 词汇是 string mode id）。
      if (configId === ACP_MODE_OPTION_ID && agent.currentModeId !== undefined) {
        if (typeof value !== 'string') {
          throw new Error(`legacy session/set_mode takes a string mode id; got ${JSON.stringify(value)}`)
        }
        await agent.setMode(value)
        return this.liveSnapshot(sessionId, agent)
      }
      throw new Error(`session "${sessionId}" exposes no config option "${configId}"`)
    }
 // 类型保真校验：select 收 string 值 id 且须在可选值内；boolean 收原生
    // boolean（不收 'true'/'false' 字符串）；未知 type 拒绝写入（协议：忽略该项，
    // agent 默认值在位）。
    if (option.type === 'select' && (typeof value !== 'string' || !selectValues(option).has(value))) {
      throw new Error(`${JSON.stringify(value)} is not a selectable value of config option "${configId}"`)
    }
    if (option.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`config option "${configId}" is boolean; the value must be a JSON boolean, got ${JSON.stringify(value)}`)
    }
    const optionType: string = option.type
    if (optionType !== 'select' && optionType !== 'boolean') {
      throw new Error(`config option "${configId}" has unsupported type "${optionType}"; only select/boolean writes are defined`)
    }
 // 路由：所有已广告的 config option 一律走 set_config_option——mode 类
    // 也不例外（config options 已取代 session/set_mode；set_mode 只剩上面的
    // legacy 降级）。快照整体替换由 seam 以响应为准完成。
    //
    // seam 竞态错误原样传播（message 保留）：预检后 turn 才开始
    // （"only allowed while idle"）/ 会话尚未懒启动（"not started yet"）。
    await agent.setConfigOption(configId, value)
    return this.liveSnapshot(sessionId, agent)
  }

  /**
 * rebindBlank：显式放弃该会话的旧 ACP 上下文并重开全新 ACP 会话
   * （下一个 turn 以 session/new 建立新代际；DSH 侧历史完整保留）。仅 idle
   * 可调；错误（忙/settling/拆除失败）原样 throw。返回复位后的最新快照
   * （continuity 应已归 ok）。
   */
  @Remote('rebindBlank')
  async rebindBlank(sessionId: string): Promise<AcpLiveOptionsSnapshot> {
    const agent = this.requireLiveAgent(sessionId)
    await agent.rebindBlank()
    return this.liveSnapshot(sessionId, agent)
  }

  /**
 * beginModelSwitch（ModelSwitchCoordinator 的 host 侧）：同 profile 模型
   * 热切换的唯一写入口。流程（失败语义先行）：
   * 1. 预检——活体 + idle + model 类 select option 在场且 target 在 allowed
   *    values 内；previous === target → 无操作直接返回（不落事务行）；
   * 2. 持久化 `started`（**fail-closed** 行落不下即拒发，绝不先写 Agent）；
   * 3. ACP `set_config_option`；任一失败进回滚臂：尽力写回 previousModel +
   *    清行后原样抛出；**回滚也失败 → 持久化 `rollback-required`（composer
   *    锁定，用户选择出路）**；
   * 4. 成功 → 从响应替换后的权威快照读 **actualModel**（Agent 可能归一化/改写
   *    目标值；DSH 侧 selectModel 必须用本值）→ 持久化 `agent-applied`（写失败
   *    同样进回滚臂）→ 返回 {actualModel, snapshot}。
   *
   * 幂等/并发纪律：operationId 由 client 生成（uuid）；重复投递同 operationId
   * 按行状态收敛（agent-applied/committed → 直接返回 ok；started → 读 Agent
   * 当前值判定已应用/未应用）；不同 operationId 的在飞或待定行 → 冲突拒绝。
   */
  @Remote('beginModelSwitch')
  async beginModelSwitch(sessionId: string, request: AcpModelSwitchBeginRequest): Promise<AcpModelSwitchBeginResult> {
    if (typeof request.operationId !== 'string' || request.operationId === '') {
      throw new Error('beginModelSwitch requires a non-empty operationId (client-generated uuid)')
    }
    if (typeof request.targetModel !== 'string' || request.targetModel === '') {
      throw new Error('beginModelSwitch requires a non-empty targetModel')
    }
    const agent = this.requireLiveAgent(sessionId)
    const store = this.requireModelSwitchStore()
    const inflight = this.modelSwitchInflight.get(sessionId)
    if (inflight !== undefined && inflight.operationId !== request.operationId) {
      throw new Error(
        `session "${sessionId}" already has a model switch in flight (operation ${inflight.operationId} → ` +
        `${JSON.stringify(inflight.targetModel)}); concurrent switches are rejected`,
      )
    }
    const existing = await store.read(sessionId)
    if (existing !== undefined) {
      if (existing.status === 'corrupt') {
        throw new Error(
          `session "${sessionId}" has a corrupt pending model switch record; consistency cannot be proven — ` +
          'resume the session (send a message) to reconcile, or rebind to a fresh ACP session',
        )
      }
      const record = existing.record
      if (record.operationId !== request.operationId) {
        throw new Error(
          `session "${sessionId}" has a pending model switch (operation ${record.operationId}, state ${record.state}); ` +
          'resolve or roll it back before starting another switch',
        )
      }
      // 重复投递：按持久行状态收敛
      if (record.state === 'rollback-required' || record.state === 'agent-rolled-back') {
        throw new Error(
          `session "${sessionId}" model switch ${record.operationId} is ${record.state}; ` +
          'finish or resolve that transaction before retrying the switch',
        )
      }
      if (record.state === 'agent-applied' || record.state === 'committed') {
        const actualModel = record.appliedModel ?? record.targetModel
        const live = this.currentLiveModel(agent)
        if (live !== actualModel) {
          throw new Error(
            `session "${sessionId}" model switch ${record.operationId} is ${record.state}, but the agent reports ` +
            `${JSON.stringify(live)} instead of the journaled applied model ${JSON.stringify(actualModel)}; ` +
            'the pending record is kept for reconciliation',
          )
        }
        return { actualModel, snapshot: await this.liveSnapshot(sessionId, agent) }
      }
      // state 'started'：Agent 是否已应用未知——以活体当前值自证
      const live = this.currentLiveModel(agent)
      if (live === record.targetModel) {
        await store.write({ ...record, appliedModel: live, state: 'agent-applied' })
        return { actualModel: record.targetModel, snapshot: await this.liveSnapshot(sessionId, agent) }
      }
      if (live === record.previousModel) {
        // 明确读到 previous 才能证明 Agent 没有应用；此时清行后按拒绝抛出。
        // 清理失败不能被描述成“已清理”：让持久层错误响亮返回并保留行。
        await store.clear(sessionId)
        throw new Error(
          `model switch ${record.operationId} was persisted but never applied by the agent; ` +
          'the pending record is cleared — retry the switch',
        )
      }
      if (live === undefined) {
        // Missing telemetry is not evidence of non-application. Preserve the
        // started row and fail closed so a later resume can reconcile it.
        throw new Error(
          `session "${sessionId}" model switch ${record.operationId} is undecidable (the agent model could not be read); ` +
          'the pending record is kept — resume the session to reconcile, or rebind',
        )
      }
      throw new Error(
        `session "${sessionId}" model switch ${record.operationId} is undecidable (agent reports ` +
        `${JSON.stringify(live)}, neither previous nor target); the pending record is kept — ` +
        'resume the session to reconcile, or rebind',
      )
    }
    // ---- 新切换：预检 ----
    if (agent.status !== 'idle') {
      throw new Error(`agent for session "${sessionId}" is running a turn; retry when idle`)
    }
    const option = modelOptionOf(agent.configOptions)
    if (option === undefined) {
      throw new Error(`session "${sessionId}" exposes no model-class config option; hot model switching is not available`)
    }
    if (!selectValues(option).has(request.targetModel)) {
      throw new Error(`${JSON.stringify(request.targetModel)} is not a selectable value of the model option "${option.id}"`)
    }
    const previousModel = option.currentValue
    if (previousModel === request.targetModel) {
      // 无操作：不落事务行，直接返回现状
      return { actualModel: previousModel, snapshot: await this.liveSnapshot(sessionId, agent) }
    }
    const record: AcpPendingModelSwitchLike = {
      operationId: request.operationId,
      dshSessionId: sessionId,
      provider: agent.providerRoute,
      optionId: option.id,
      previousModel,
      targetModel: request.targetModel,
      state: 'started',
      createdAt: new Date().toISOString(),
    }
    // fail-closed：事务行落不下即拒发（绝不先写 Agent 再补账）
    await store.write(record)
    this.modelSwitchInflight.set(sessionId, { operationId: record.operationId, targetModel: record.targetModel })
    try {
      await agent.setConfigOption(option.id, request.targetModel)
      // 读 Agent 响应替换后的权威快照里的实际模型值
      const actualModel = this.currentLiveModel(agent)
      if (actualModel === undefined) {
        throw new Error('the agent response did not carry a readable model option after the switch')
      }
      // agent-applied 落账失败同样进回滚臂（事务完整性优先于切换成功）
      await store.write({ ...record, appliedModel: actualModel, state: 'agent-applied' })
      // 先释闩再组快照：返回值如实携带 pending(agent-applied) 视图而非瞬态 busy
      this.modelSwitchInflight.delete(sessionId)
      return { actualModel, snapshot: await this.liveSnapshot(sessionId, agent) }
    } catch (error: unknown) {
      // 回滚臂：尽力把 Agent 写回 previousModel
      let rolledBack = false
      try {
        await agent.setConfigOption(option.id, previousModel)
        rolledBack = true
      } catch {
        rolledBack = false
      }
      if (rolledBack) {
        // Agent 已回到 previous，但 journal 清理仍是必要的 durable 边界。
        // 失败时让存储错误响亮返回；保留的 started 行会继续阻断并可恢复。
        await store.clear(sessionId)
        throw error
      }
      // 回滚也失败：双侧一致性无法自证 → rollback-required（composer 锁定）
      await store.write({ ...record, state: 'rollback-required' }).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `model switch to ${JSON.stringify(request.targetModel)} failed (${message}) and the rollback to ` +
        `${JSON.stringify(previousModel)} also failed; the session is locked (rollback-required) — ` +
        'roll back explicitly from the model picker or rebind to a fresh ACP session',
      )
    } finally {
      const held = this.modelSwitchInflight.get(sessionId)
      if (held?.operationId === record.operationId) this.modelSwitchInflight.delete(sessionId)
    }
  }

  /**
 * commitModelSwitch：DSH 侧 selectModel 已接受 actualModel 后的收束步。
   * 幂等：无行（响应丢失但清行已发生）→ 直接返回快照；operationId 不匹配 /
   * rollback-required → throw。写 `committed` 后清行（同一连贯窗口；崩溃留下的
   * committed 行由恢复路径按「已收敛」清理）。
   */
  @Remote('commitModelSwitch')
  async commitModelSwitch(sessionId: string, request: AcpModelSwitchResolveRequest): Promise<AcpLiveOptionsSnapshot> {
    const agent = this.requireLiveAgent(sessionId)
    const store = this.requireModelSwitchStore()
    const existing = await store.read(sessionId)
    if (existing === undefined) return this.liveSnapshot(sessionId, agent)
    if (existing.status === 'corrupt') {
      throw new Error(`session "${sessionId}" has a corrupt pending model switch record; reconciliation is required`)
    }
    const record = existing.record
    if (record.operationId !== request.operationId) {
      throw new Error(
        `session "${sessionId}" pending model switch is operation ${record.operationId}, not ${request.operationId}`,
      )
    }
    if (record.state === 'rollback-required') {
      throw new Error(
        `session "${sessionId}" model switch ${record.operationId} is rollback-required; commit is refused — ` +
        'roll back or rebind',
      )
    }
    const current = this.currentLiveModel(agent)
    const expected = record.state === 'agent-rolled-back'
      ? record.previousModel
      : record.appliedModel ?? record.targetModel
    if (current !== expected && !(record.state === 'started' && current === record.previousModel)) {
      throw new Error(
        `model switch ${record.operationId} cannot be finalized: the agent reports ${JSON.stringify(current)}, ` +
        `expected ${JSON.stringify(expected)}`,
      )
    }
    await store.write({ ...record, state: 'committed' })
    await store.clear(sessionId)
    return this.liveSnapshot(sessionId, agent)
  }

  /**
 * rollbackModelSwitch：把 Agent 侧写回 previousModel，并把事务推进到
   * agent-rolled-back。此时绝不清行：client 还必须证明 DSH 侧也已回到 previous，
   * 再调用 commitModelSwitch finalize。幂等：无行 → 直接返回快照。
   * 无活体（冷启动）响亮拒绝并指明出路（resume 或 rebind）；回滚写失败 →
   * 持久化 rollback-required 后抛出（composer 锁定）。
   */
  @Remote('rollbackModelSwitch')
  async rollbackModelSwitch(sessionId: string, request: AcpModelSwitchResolveRequest): Promise<AcpLiveOptionsSnapshot> {
    const agent = this.resolved.resolveLiveAgent(sessionId)
    if (agent === undefined) {
      throw new Error(
        `no live ACP agent for session "${sessionId}"; resume the session (send a message) so the rollback ` +
        'can be applied to the agent, or rebind to a fresh ACP session',
      )
    }
    const store = this.requireModelSwitchStore()
    const existing = await store.read(sessionId)
    if (existing === undefined) return this.liveSnapshot(sessionId, agent)
    if (existing.status === 'corrupt') {
      throw new Error(`session "${sessionId}" has a corrupt pending model switch record; reconciliation is required`)
    }
    const record = existing.record
    if (record.operationId !== request.operationId) {
      throw new Error(
        `session "${sessionId}" pending model switch is operation ${record.operationId}, not ${request.operationId}`,
      )
    }
    if (agent.status !== 'idle') {
      throw new Error(`agent for session "${sessionId}" is running a turn; retry the rollback when idle`)
    }
    if (record.state !== 'agent-rolled-back') {
      try {
        await agent.setConfigOption(record.optionId, record.previousModel)
      } catch (error: unknown) {
        await store.write({ ...record, state: 'rollback-required' }).catch(() => undefined)
        throw error
      }
    }
    const current = this.currentLiveModel(agent)
    if (current !== record.previousModel) {
      await store.write({ ...record, state: 'rollback-required' }).catch(() => undefined)
      throw new Error(
        `agent rollback for model switch ${record.operationId} was not confirmed: expected ` +
        `${JSON.stringify(record.previousModel)}, got ${JSON.stringify(current)}`,
      )
    }
    await store.write({ ...record, state: 'agent-rolled-back' })
    return this.liveSnapshot(sessionId, agent)
  }

  /**
 * backendOf（「backend 不可变」的 picker 主防线数据面）：host 权威的
   * 会话 backend 查询，纯读零副作用。判定优先级：活体 AcpAgent（host 注册表）→
   * sidecar binding（ACP 会话创建即有，覆盖 header 空洞）→ 日志末条
   * request/header 的 provider（只读 inspect 窥测）→ 都没有 = 'blank'（blank
   * 会话的 current.provider 只是实时默认的影子，不算定 backend）。
   * 会话不存在/日志不可读且无任何在场证据 → 响亮报错（protocol-error）：调用方
   * 手里应都是真实 session，冒充 blank 会让 picker 放行一个不可判定的会话。
   */
  @Remote('backendOf')
  async backendOf(sessionId: string): Promise<AcpBackendState> {
    const live = this.resolved.resolveLiveAgent(sessionId)
    if (live !== undefined) return { state: 'established', provider: live.providerRoute }
    const facts = this.resolved.backendFacts
    if (facts === null) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: backend facts are not wired on this host; cannot determine the backend of session "${sessionId}"`,
        { category: 'config' },
      )
    }
    const bound = await facts.readBindingProvider(sessionId)
    if (bound !== undefined) return { state: 'established', provider: bound }
    try {
      const header = await facts.peekHeaderProvider(sessionId)
      return header === undefined ? { state: 'blank' } : { state: 'established', provider: header }
    } catch (error: unknown) {
      // 无日志可读时活体（任意 backend，含尚未落 header 的新 native 会话）仍是
      // 存在性证据：无 header 即 blank。
      if (facts.hasLiveAgent(sessionId)) return { state: 'blank' }
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: cannot determine the execution backend of session "${sessionId}": the session does not exist or its log is unreadable (${error instanceof Error ? error.message : String(error)})`,
        { category: 'config' },
      )
    }
  }

  /**
 * boundSessions（删除确认提示）：该 profile（按 agent id）当前被多少个
   * 既有 DSH 会话的 sidecar binding 引用——删除 profile 后这些会话显示
   * backend-unavailable，面板在确认文案中如实预告。纯读零副作用；agent id
   * 非法或未接线一律 throw（不冒充 0）。
   */
  @Remote('boundSessions')
  async boundSessions(agentId: string): Promise<AcpBoundSessionsView> {
    if (!ACP_AGENT_ID_PATTERN.test(agentId)) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: invalid agent id ${JSON.stringify(agentId)} (must match ${String(ACP_AGENT_ID_PATTERN)})`,
        { category: 'config' },
      )
    }
    const facts = this.resolved.bindingFacts
    if (facts === null) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: binding facts are not wired on this host; cannot count sessions bound to "${agentId}"`,
        { category: 'config' },
      )
    }
    return { agentId, count: await facts.countBoundSessions(acpRouteId(agentId)) }
  }

  private requireLiveAgent(sessionId: string): AcpLiveAgentFace {
    const agent = this.resolved.resolveLiveAgent(sessionId)
    if (agent === undefined) {
      throw new Error(`no live ACP agent for session "${sessionId}" (not an ACP session, or already disposed)`)
    }
    return agent
  }

  private requireModelSwitchStore(): NonNullable<AcpRemoteServiceDeps['modelSwitchStore']> {
    const store = this.resolved.modelSwitchStore
    if (store === null) {
      throw new AcpClientError(
        'protocol-error',
        'dsh-acp: the pending model switch store is not wired on this host; hot model switching is refused (fail-closed)',
        { category: 'config' },
      )
    }
    return store
  }

  /**
 * 待定模型切换的 wire 视图：在飞闩锁（busy，瞬态）优先，其次持久行
   * （pending/rollback-required/corrupt），无行归 idle。
   */
  private async modelSwitchViewOf(sessionId: string): Promise<AcpModelSwitchView> {
    const inflight = this.modelSwitchInflight.get(sessionId)
    if (inflight !== undefined) {
      return { status: 'busy', operationId: inflight.operationId, targetModel: inflight.targetModel }
    }
    const store = this.resolved.modelSwitchStore
    if (store === null) return { status: 'idle' }
    const lookup = await store.read(sessionId)
    if (lookup === undefined) return { status: 'idle' }
    if (lookup.status === 'corrupt') return { status: 'corrupt' }
    const record = lookup.record
    if (record.state === 'rollback-required') {
      return {
        status: 'rollback-required',
        operationId: record.operationId,
        provider: record.provider,
        previousModel: record.previousModel,
        targetModel: record.targetModel,
      }
    }
    return {
      status: 'pending',
      operationId: record.operationId,
      state: record.state,
      provider: record.provider,
      optionId: record.optionId,
      previousModel: record.previousModel,
      targetModel: record.targetModel,
      ...(record.appliedModel === undefined ? {} : { appliedModel: record.appliedModel }),
      createdAt: record.createdAt,
    }
  }

  /** 活体权威快照里的当前模型值（category 'model' 优先、约定 id 兜底；不可读归 undefined）。 */
  private currentLiveModel(agent: AcpLiveAgentFace): string | undefined {
    const option = modelOptionOf(agent.configOptions)
    return option?.currentValue
  }

  private async liveSnapshot(sessionId: string, agent: AcpLiveAgentFace): Promise<AcpLiveOptionsSnapshot> {
    const continuity: AcpSessionContinuity = agent.continuityState
    return {
      sessionId,
      configOptions: contractConfigOptionsOf(agent.configOptions),
      currentModeId: agent.currentModeId ?? null,
      capabilities: capabilityFactsOf(agent.agentCapabilities),
      sandbox: this.resolved.sandboxPosture,
      continuity,
 // 边界：workspace-write 可用性直通（profile 绑定决定；创建门在 startSession）
      workspaceWrite: agent.workspaceWriteSupport,
 // 上下文占用直通（used/size/percent/cost 已是收窄形状，无映射）。
      contextUsage: agent.contextUsage,
      freshness: 'live',
      editable: true,
      // live 快照的指纹即当前事实，恒 false（stale 才可能漂移）
      fingerprintChanged: false,
      modelSwitch: await this.modelSwitchViewOf(sessionId),
    }
  }

  /**
 * 冷启动 stale 快照：sidecar last-known 快照的收窄副本。capabilities 归
   * null（无握手事实）；continuity 如实归 ok——连续性闩锁是活体对账概念，
   * 冷启动无活体可判，resume 路径自有对账门（不拿快照冒充）；workspaceWrite
   * 以 binding provider → descriptor 同判定源重组（与 AcpAgent.workspaceWriteSupport
   * 同口径），判不出时归 'supported'（与非本地 agent 的缺省一致）。
   */
  private async staleSnapshot(sessionId: string): Promise<AcpLiveOptionsSnapshot> {
    const store = this.resolved.optionSnapshotStore
    const snapshot = store === null ? undefined : await store.read(sessionId)
    if (snapshot === undefined) {
      throw new Error(`no live ACP agent for session "${sessionId}" (not an ACP session, or already disposed)`)
    }
    const fingerprintSeam = this.resolved.snapshotFingerprint
    const current = fingerprintSeam === null ? undefined : await fingerprintSeam(sessionId)
    return {
      sessionId,
      configOptions: contractConfigOptionsFromSnapshot(snapshot),
      currentModeId: snapshot.currentModeId,
      capabilities: null,
      sandbox: this.resolved.sandboxPosture,
      continuity: { status: 'ok', cause: null, detail: null },
      workspaceWrite: await this.staleWorkspaceWrite(sessionId),
      contextUsage: null,
      freshness: 'stale',
      editable: false,
      fingerprintChanged: current !== undefined && current !== snapshot.fingerprint,
      modelSwitch: await this.modelSwitchViewOf(sessionId),
    }
  }

  /** stale 快照的 workspace-write 判定（binding provider → descriptor semanticState；判不出归 'supported'）。 */
  private async staleWorkspaceWrite(sessionId: string): Promise<'supported' | 'unsupported'> {
    const facts = this.resolved.backendFacts
    const provider = facts === null ? undefined : await facts.readBindingProvider(sessionId).catch(() => undefined)
    const agentId = provider === undefined ? undefined : acpAgentIdFromRoute(provider)
    if (agentId === undefined) return 'supported'
    const config = this.resolved.registry.agents().get(agentId)
    if (config === undefined) return 'supported'
    return descriptorOf(agentId, config)?.semanticState === 'local' ? 'unsupported' : 'supported'
  }
}

/** 新鲜 probe 条目 → 五态派生的最小视图（ok 留目录事实，error 留分流 kind）。 */
function probeStateView(snapshot: AcpProbeSnapshotLike): AcpAgentStateProbeView {
  const { result } = snapshot
  return result.kind === 'ok'
    ? { result: { kind: 'ok', modelCount: result.models.length, hasModelConfigOption: result.hasModelConfigOption === true } }
    : { result: { kind: 'error', failureKind: result.failureKind } }
}

/** cleanup 三态词表收窄（结构面按 string 进；词表外值诚实归 null，不猜测）。 */
function contractCleanupOf(cleanup: { readonly close: string; readonly delete: string; readonly message?: string | undefined } | undefined): AcpProbeCleanupView | null {
  if (cleanup === undefined) return null
  const steps = ['done', 'not-advertised', 'failed'] as const
  const close = steps.find((step) => step === cleanup.close)
  const del = steps.find((step) => step === cleanup.delete)
  if (close === undefined || del === undefined) return null
  return { close, delete: del, message: cleanup.message ?? null }
}

function probeRow(snapshot: AcpProbeSnapshotLike | undefined, sandboxPosture: AcpSandboxPosture | null, descriptor: AcpAgentRuntimeDescriptor | undefined): AcpProviderHealth['probe'] {  if (snapshot === undefined) return { status: 'never', at: null }
  const { result, at } = snapshot
  if (result.kind === 'ok') {
    const capabilities = capabilityFactsOf(result.agentCapabilities)
    return {
      status: 'ok',
      at,
      modelCount: result.models.length,
      authMethods: result.authMethods === undefined ? null : result.authMethods.map(contractAuthMethodOf),
      agentInfo: result.agentInfo == null
        ? null
        : { name: result.agentInfo.name, version: result.agentInfo.version },
      capabilities,
      cleanup: contractCleanupOf(result.cleanup),
      capabilityHash: result.capabilityHash ?? null,
 // readiness：协议版本 / 钉版 / 兼容状态（兼容状态由 agent-config.ts
      // 纯函数派生，比对握手 agentInfo.version 与 descriptor versionPolicy）
      protocolVersion: result.protocolVersion ?? null,
      versionPolicy: descriptor === undefined
        ? null
        : { adapter: descriptor.versionPolicy.adapter ?? null, wrappedCli: descriptor.versionPolicy.wrappedCli ?? null },
      versionCompatibility: acpVersionCompatibility(descriptor, result.agentInfo?.version),
 // 端到端能力矩阵（广告 × adapter path × sandbox posture；纯函数
      // 直通，形状与 contract `AcpCapabilityMatrixRow` 结构一致，无映射）
      matrix: acpCapabilityMatrix(capabilities, sandboxPosture),
    }
  }
  return {
    status: 'error',
    at,
    failureKind: result.failureKind,
    message: result.error.message,
    phase: result.probePhase ?? null,
  }
}

/** select 选项的可选值集合（group/flat 两种布局拍平，llm-stub probeModels 同款守卫）。 */
function selectValues(option: acp.SessionConfigOption & { type: 'select' }): Set<string> {
  const values = new Set<string>()
  for (const entry of option.options) {
    const items = 'options' in entry ? entry.options : [entry]
    for (const item of items) values.add(item.value)
  }
  return values
}

/** model 类 config option 查找（category 'model' 优先、约定 id 'model' 兜底——与 agent.ts modelOfConfigOptions 同口径）。 */
function modelOptionOf(
  configOptions: readonly acp.SessionConfigOption[] | undefined,
): (acp.SessionConfigOption & { type: 'select' }) | undefined {
  const option = configOptions?.find((candidate) => candidate.category === 'model' || candidate.id === 'model')
  return option?.type === 'select' ? option : undefined
}

/**
 * last-known 快照的有界条目 → 收窄 wire 形状。select 的拍平 values 列表
 * 重组为扁平 options 数组（name 如实以值 id 充任——标准化快照不持久化展示名，
 * UI 在 stale 态只读展示当前值即可）；values 为 null 的条目按 boolean 重建
 * （快照只持久化 select/boolean 两型，见 sidecar 的 acpOptionsSnapshotOf）。
 */
function contractConfigOptionsFromSnapshot(snapshot: AcpOptionsSnapshotLike): readonly AcpConfigOption[] {
  return snapshot.options.map((option) => {
    const base = {
      id: option.id,
      name: option.name,
      ...(option.category === null ? {} : { category: option.category }),
    }
    if (option.values !== null && typeof option.value === 'string') {
      return {
        ...base,
        type: 'select' as const,
        currentValue: option.value,
        options: option.values.map((value) => ({ value, name: value })),
      }
    }
    return { ...base, type: 'boolean' as const, currentValue: option.value === true }
  })
}
