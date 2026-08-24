/**
 * ACP 协议连接的类型面（自 acp-client.ts 切出）：错误分类词表、监听器/
 * 处理器签名、连接与 probe 选项。纯类型模块；进程侧规格与退出事实见
 * src/runtime/process/types.ts。
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/types
 */

import type * as acp from '@agentclientprotocol/sdk'
import type { AcpProcessExit, AcpProcessOptions } from '../../runtime/process/types.ts'

/**
 * ACP 连接错误的结构化分类。
 * - `spawn-failure`：可执行不存在（ENOENT）/不可执行（EACCES）等 spawn 级失败
 * - `auth_required`：agent 返回 JSON-RPC -32000（ACP `auth_required`），需走 agent 自有登录
 * - `timeout`：initialize / probe 超时下限保护；所有带预算的 RPC
 *   超预算放弃（connection poison 的触发源之一）也归本类
 * - `protocol-error`：JSON-RPC 层错误（方法未实现、参数非法等）及其它未分类失败
 * - `crash`：agent 进程意外退出（含 exit code + signal；主动 close 触发的断开不算）
 * - `sandbox-unavailable`：预留给 ——confine 不可用时 fail closed，不静默放行
 * - `aborted`：调用方 AbortSignal 中止在飞 RPC，promise 被放弃
 *   （连接随之 poison 拆除）；taxonomy 默认映射 `user-rejected`
 */
export type AcpErrorKind =
  | 'spawn-failure'
  | 'auth_required'
  | 'timeout'
  | 'protocol-error'
  | 'crash'
  | 'sandbox-unavailable'
  | 'aborted'

/**
 * 统一错误 taxonomy（九分类；分类标签与 kind 映射的值表见 ./errors.ts）。
 * `AcpErrorKind` 是协议层的传输期分类（线上接口形状，remote/service 与 client
 * 面板消费，不变）；本词表是跨层统一的用户问题分类：
 * - `config`：配置/部署错误（agent 配置非法、spawn 计划组装失败、宿主缺 subprocess 能力）
 * - `not-installed`：agent 命令未安装/不可执行（spawn ENOENT/EACCES）
 * - `auth-required`：agent 未认证（ACP `auth_required`）
 * - `protocol-incompatible`：协议不兼容/对端 RPC 拒绝及其它未分类失败
 * - `timeout`：各握手/RPC 超预算
 * - `agent-crash`：agent 进程意外退出
 * - `sandbox-unavailable`：沙箱拒绝/不可用（confine fail closed）
 * - `user-rejected`：用户拒绝/取消（审批拒绝以 ACP outcome `reject_*`/`cancelled`
 * 表达，非 thrown error； 调用方中止在飞 RPC 的 `aborted` kind 归本类）
 * - `resume-conflict`：恢复冲突（预留：当前恢复冲突一律降级为说明性 assistant
 * 消息——src/domain/session/resume.ts，非 thrown error； 硬冲突错误归本类）
 */
export type AcpErrorCategory =
  | 'config'
  | 'not-installed'
  | 'auth-required'
  | 'protocol-incompatible'
  | 'timeout'
  | 'agent-crash'
  | 'sandbox-unavailable'
  | 'user-rejected'
  | 'resume-conflict'

/**
 * probe 的失败阶段（健康四层分层的依据）：`initialize` = 握手未完成；
 * `session` = 握手已过、`session/new` 失败。仅 probe 路径标记（见
 * ./connection.ts `AcpClientConnection.probe`）；非 probe 场景缺席。
 */
export type AcpProbePhase = 'initialize' | 'session'

/** {@link AcpClientError} 的可选附加事实。 */
export interface AcpClientErrorDetails {
  /** `crash` 类错误的退出事实（能收割到时）。 */
  exit?: AcpProcessExit | undefined
  /** 失败时的脱敏 stderr 尾（诊断用）。 */
  stderrTail?: readonly string[] | undefined
  /** 原始错误。 */
  cause?: unknown
  /** probe 失败阶段（仅 probe 路径；健康卡 initialize/session 分层用）。 */
  probePhase?: AcpProbePhase | undefined
  /**
 * taxonomy 分类覆盖；缺省按 kind 映射（./errors.ts
   * `ACP_ERROR_KIND_CATEGORY`）。同 kind 不同成因需分流时使用（如
   * spawn-failure 的「配置非法/宿主能力缺失」归 `config`，「命令不存在」归
   * 默认的 `not-installed`）。
   */
  category?: AcpErrorCategory | undefined
 /** correlation id 覆盖；缺省构造期生成（./errors.ts `newAcpCorrelationId`）。 */
  correlationId?: string | undefined
}

/** `session/update` 通知监听器。 */
export type SessionUpdateListener = (notification: acp.SessionNotification) => void

/**
 * 单次 RPC 的预算与取消面（./connection.ts 各 typed 方法的末参，全可选）：
 * - `signal`：宿主侧取消信号。在飞时中止 = 放弃该 RPC（'aborted' 分类 reject），
 *   连接随即 poison 拆除（迟到响应不再可信）；进场前已中止则不发帧直接拒
 *   （连接未污染，可继续用）。
 * - `timeoutMs`：本笔 RPC 的独立预算。超预算 = 放弃该 RPC（'timeout' 分类
 *   reject）+ poison。缺省按方法预算常量（./connection.ts 的
 *   `DEFAULT_SESSION_SETUP_TIMEOUT_MS` / `DEFAULT_SESSION_WRITE_TIMEOUT_MS`）；
 *   `session/prompt` 无默认预算（turn 时长合法无界，由 prompt 取消梯子治理），
 *   只在本字段显式给值时加闸。
 */
export interface AcpRpcOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** agent → client 权限请求处理器（审批桥经此接入；缺省 fail closed 回 cancelled）。 */
export type PermissionRequestHandler = (
  params: acp.RequestPermissionRequest,
) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>

/**
 * agent → client elicitation 请求观察器（边界）。SDK 1.3.0 的 elicitation 面仍是
 * unstable（`unstable_createElicitation`），本适配器不接 DSH interaction UI：
 * `elicitation/create` 一律以协议标准响应变体 `{ action: 'decline' }` 应答
 * （decline 是 zCreateElicitationResponse 的合法判别值，非错误）。本回调是
 * 纯观察口（同步 void；抛错由连接层吞掉，不污染协议流），供 domain 层生成
 * 可见降级事件（用户说明 + sidecar 审计）。
 */
export type ElicitationRequestObserver = (params: acp.CreateElicitationRequest) => void

export interface AcpConnectionOptions extends AcpProcessOptions {
  /** `initialize` 的 clientInfo。 */
  clientInfo?: acp.Implementation
  /** initialize 握手超时（默认见 ./connection.ts 的 DEFAULT_INITIALIZE_TIMEOUT_MS）。 */
  initializeTimeoutMs?: number
  /** 连接级 `session/update` 监听器（构造时注册，随连接整个生命周期）。 */
  onSessionUpdate?: SessionUpdateListener
  /** 权限请求处理器；缺省回 `cancelled`（fail closed）。 */
  onPermissionRequest?: PermissionRequestHandler
  /**
 * elicitation 请求观察器（边界）。应答恒为 `{ action: 'decline' }`（本适配器
   * 不广告 elicitation capability——`clientCapabilities: {}`——但主动注册 handler
   * 以产出可见降级事件；缺省观察器 = 静默 decline）。
   */
  onElicitationRequest?: ElicitationRequestObserver
}

/**
 * probe 会话清理的一步事实：`done` = 已发 RPC 且成功；
 * `not-advertised` = agent 未广告对应 sessionCapabilities（不发帧）；
 * `failed` = 已发 RPC 但失败/超时（清理失败不翻转 probe 成败——进程强杀与
 * 临时目录删除语义不变，见 ./connection.ts `AcpClientConnection.probe`）。
 */
export type AcpProbeCleanupStep = 'done' | 'not-advertised' | 'failed'

/** probe 会话清理事实：close 先、delete 后，各自独立判定。 */
export interface AcpProbeCleanup {
  readonly close: AcpProbeCleanupStep
  readonly delete: AcpProbeCleanupStep
  /** 任一步 failed 时的诊断摘要（脱敏错误 message）；全成功/未广告时缺席。 */
  readonly message?: string | undefined
}

/** probe 结果：供 llm-stub 的 listModels与健康端点消费。 */
export interface AcpProbeResult {
  /** probe 建出的临时会话 id（连接已拆除，仅作诊断信息）。 */
  sessionId: string
 /** 会话清理事实（session/new 成功后、拆除前执行）。 */
  cleanup: AcpProbeCleanup
  agentInfo: acp.Implementation | null | undefined
  agentCapabilities: acp.AgentCapabilities | undefined
  /**
 * initialize 协商出的 ACP 协议版本（readiness；握手成功恒在场，类型保持
   * 与连接层 getter 同形——未协商到的防御形态是 undefined）。
   */
  protocolVersion: number | undefined
  authMethods: acp.AuthMethod[]
  modes: acp.SessionModeState | null | undefined
  /**
   * 模型/模式/思考强度等配置项快照。`undefined` = agent 未提供（优雅降级矩阵：
   * 选择器 ACP 区块隐藏）。取自 `session/new` 响应，缺字段时以响应前的
   * `config_option_update` 推送兜底（devin 实测流量顺序）。
   */
  configOptions: acp.SessionConfigOption[] | undefined
  /** 拆除前抓取的脱敏 stderr 尾。 */
  stderrTail: string[]
}

export interface AcpProbeOptions extends AcpConnectionOptions {
  /** probe 会话的 cwd；缺省建 `os.tmpdir()` 下临时目录并在结束后清理。 */
  cwd?: string
  /** initialize 与 session/new 各自的超时预算（默认 15s，devin 冷启动实测约 3s）。 */
  timeoutMs?: number
}
