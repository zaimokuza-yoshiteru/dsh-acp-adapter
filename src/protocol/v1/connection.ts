/**
 * ACP 协议连接（自 acp-client.ts 切出的协议半；进程半——spawn、stdio 泵、
 * stderr 环、拆除梯子、pid 管理——见 src/runtime/process/agent-process.ts）：
 * `client()` app、v1 initialize 协商、typed 会话方法 RPC、能力记录、probe、
 * 错误六分类。
 *
 * - 传输：`@agentclientprotocol/sdk` 1.3.0 的 `client()` API + `ndJsonStream`
 * （自 @deprecated 的 `ClientSideConnection` 迁入：handler 按方法名经
 *   `onRequest`/`onNotification` 注册，`connect(stream)` 拿长连接，向外 RPC 走
 * `conn.agent.request('<method>', params)`）。 契约实测结论不变——两 API 共用
 *   同一 Connection/jsonrpc 核心（test/contracts/sdk-contract.spec.ts 已同步迁移复验）：
 *   容忍未知 `_vendor` 通知、garbage 行跳行、崩溃时挂起请求以
 *   `Error('ACP connection closed')` reject 且已流出 chunk 不丢。
 * - 结构化 spawn 规格（{@link AcpConnectionSpec}）：`spawnPlan` 承载已校验的
 *   原生访问启动参数，`wrapArgv` 是宿主进程层的可选包装插口；两者互斥，
 *   解析出的最终 argv/env 交给 `AcpAgentProcess`。
 * spec 必填 `subprocess`（`ctx.subprocess` 的窄化 seam）：spawn 与
 *   终止全经宿主服务（跨平台树级回收），无 seam 即构造即抛 spawn-failure
 *   （fail closed，不自制 child_process 回退）。
 * - 客户端能力固定最小化：只有 read/write 两个 FS handler 均已接线时才广告 fs；terminal
 *   只有完整 terminal host 接线时广告；MCP 与 form/url elicitation 在 host/client seam 完整接线时按协商事实广告。未知 `_meta` 与未知 sessionUpdate 变体由 SDK
 *   校验层丢弃（通知验证失败仅 console.error，连接不断），translate.ts 对未知
 *   sessionUpdate 另有 default 分支兜底——会话绝不因扩展流量失败。
 * - 全 RPC deadline：initialize/new/load/resume/list/set_config_option/
 * set_mode 各带预算常量（下方 `DEFAULT_*_TIMEOUT_MS`）， 增 close/delete
 *   清理类预算（`DEFAULT_SESSION_CLEANUP_TIMEOUT_MS` 10s），且全部接受
 *   {@link AcpRpcOptions}（`signal` + 单笔 `timeoutMs` 覆盖）；`session/prompt`
 *   无默认预算（turn 时长合法无界，由 agent.ts 的取消升级梯子治理），只在显式
 *   传入时加闸。超预算/在飞中止 = **放弃该 RPC**（被弃 promise 挂 noop catch，
 *   迟到响应安全落地）并把连接标记 **poisoned**（{@link AcpClientConnection.poisonedBy}）：
 *   被弃 RPC 的迟到响应可能与后续帧交错，协议状态从此不可证——后台发起
 *   close()，此后所有 RPC 立即以 protocol-error 拒绝复用。prompt 的正常取消
 *   梯子（cancel 后 prompt 正常 settle）不 poison——只有 promise 被放弃才 poison。
 * - 拆除梯子由进程半持有：stdin EOF → `eofGraceMs`（默认 500ms）→ seam 的
 *   `terminate()`（SIGTERM → `termGraceMs`（默认 2s）→ SIGKILL 树级升级；
 *   Windows 为 taskkill /T /F）→ **有界** `waitForExit()`（`exitWaitMs`，默认
 *   10s——SIGKILL 后仍不退出是内核级异常，响亮告警后 resolve，不挂死 shutdown）。
 * Devin 不响应 stdin EOF，EOF 仅作礼貌窗口。
 * - 错误分类（{@link AcpErrorKind}）：spawn-failure / auth_required / timeout /
 * protocol-error / crash。spawn-failure
 * 的判定来源：seam spawn 同步抛错 / handle `pid === -1` 后 `done`
 * reject（ENOENT 等）。每个错误另携带 taxonomy 分类
 *   （`AcpErrorCategory`，本构造点的 spec/seam 类失败覆盖为 `config`）与
 *   correlation id，见 ./errors.ts 模块头注释。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；本文件是 host 侧协议/子进程
 * 接缝模块，经下方 triple-slash reference 显式引入 @types/node，不改动共享 tsconfig。
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/connection
 */

/// <reference types="node" />

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { clearTimeout, setTimeout } from 'node:timers'
import * as acp from '@agentclientprotocol/sdk'
import { AcpAgentProcess } from '../../runtime/process/agent-process.ts'
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE } from '../../runtime/process/subprocess.ts'
import type { AcpConnectionSpec, AcpProcessExit } from '../../runtime/process/types.ts'
import { AcpClientError } from './errors.ts'
import type {
  AcpConnectionOptions,
  AcpProbeCleanup,
  AcpProbeOptions,
  AcpProbePhase,
  AcpProbeResult,
  AcpRpcOptions,
  ElicitationRequestHandler,
  PermissionRequestHandler,
  SessionUpdateListener,
} from './types.ts'

export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000
const DEFAULT_PROBE_TIMEOUT_MS = 15_000
/**
 * 会话建立类 RPC 的默认预算（session/new、session/load、session/resume、session/list）：
 * load 要回放历史，给足 30s；其余沿用同一建立预算，调用方可经
 * {@link AcpRpcOptions.timeoutMs} 覆盖。
 */
export const DEFAULT_SESSION_SETUP_TIMEOUT_MS = 30_000
/** 会话写类 RPC 的默认预算（session/set_config_option、session/set_mode）。 */
export const DEFAULT_SESSION_WRITE_TIMEOUT_MS = 15_000
/**
 * 会话清理类 RPC 的默认预算（session/close、session/delete）：probe 收尾
 * 的礼貌窗口——清理失败不阻塞进程强杀与临时目录删除，预算给得比建立类更紧。
 */
export const DEFAULT_SESSION_CLEANUP_TIMEOUT_MS = 10_000

/** ACP `auth_required` 的 JSON-RPC code（SDK `RequestError.authRequired()`，jsonrpc.js）。 */
const ACP_ERROR_CODE_AUTH_REQUIRED = -32000
/** SDK 连接关闭时拒绝挂起请求的文案（实测）。 */
const CONNECTION_CLOSED_MESSAGE = 'ACP connection closed'

function isConnectionClosedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CONNECTION_CLOSED_MESSAGE)
}

/**
 * probe 会话清理：按 initialize 广告的 sessionCapabilities
 * 决定发不发帧——广告了 close 先 `session/close`，广告了 delete 再
 * `session/delete`（次序固定：close 是「释放资源」，delete 是「移出列表」；
 * Devin 3000.4.25 只广告 delete）。各自独立 try/catch：单步失败/超时只把该步
 * 记为 'failed' 并继续下一步，绝不抛出——清理失败不翻转 probe 成败，也不阻塞
 * 调用方 finally 的进程强杀与临时目录删除。每步 RPC 走 门卫与
 * `DEFAULT_SESSION_CLEANUP_TIMEOUT_MS` 预算（超预算 poison 的是这条将被拆除的
 * 短连接，无副作用外溢）。
 */
async function probeSessionCleanup(conn: AcpClientConnection, capabilities: acp.AgentCapabilities | undefined, sessionId: string): Promise<AcpProbeCleanup> {
  const sessionCaps = capabilities?.sessionCapabilities
  let closeStep: AcpProbeCleanup['close'] = sessionCaps?.close != null ? 'done' : 'not-advertised'
  let deleteStep: AcpProbeCleanup['delete'] = sessionCaps?.delete != null ? 'done' : 'not-advertised'
  const failures: string[] = []
  if (sessionCaps?.close != null) {
    try {
      await conn.closeSession(sessionId)
    } catch (error: unknown) {
      closeStep = 'failed'
      failures.push(`session/close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (sessionCaps?.delete != null) {
    try {
      await conn.deleteSession(sessionId)
    } catch (error: unknown) {
      deleteStep = 'failed'
      failures.push(`session/delete failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { close: closeStep, delete: deleteStep, ...(failures.length === 0 ? {} : { message: failures.join('; ') }) }
}

/**
 * 给 probe 失败打上阶段标记：已是 AcpClientError 的重建一个同 kind、
 * 同 message、同 correlation id（对账链不断）、同分类/退出事实的副本并附
 * `probePhase`；外来错误（probe 编排层的意外，如临时目录创建失败）包成
 * protocol-error 并附阶段。用户可见文案一律不变。
 */
function markProbePhase(error: unknown, probePhase: AcpProbePhase): AcpClientError {
  if (error instanceof AcpClientError) {
    return new AcpClientError(error.kind, error.message, {
      ...(error.cause === undefined ? {} : { cause: error.cause }),
      correlationId: error.correlationId,
      category: error.category,
      ...(error.exit === undefined ? {} : { exit: error.exit }),
      ...(error.stderrTail === undefined ? {} : { stderrTail: error.stderrTail }),
      probePhase,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new AcpClientError('protocol-error', `ACP probe ${probePhase} failed: ${message}`, { cause: error, probePhase })
}

/**
 * 一条到 ACP agent 子进程的连接：组合 {@link AcpAgentProcess}（进程生命周期）
 * 与 v1 initialize 协商、typed 会话方法及 probe；构造即 spawn（错误经
 * initialize 分类暴露）；用毕必须 {@link close}（幂等），否则子进程残留。
 */
export class AcpClientConnection {
  private readonly spec: AcpConnectionSpec
  private readonly command: string
  private readonly process: AcpAgentProcess
  private readonly conn: acp.ClientConnection
  private readonly clientInfo: acp.Implementation
  private readonly initializeTimeoutMs: number
  private readonly onPermissionRequest: PermissionRequestHandler | undefined
  private readonly onElicitationRequest: ElicitationRequestHandler | undefined
  private readonly fileSystemHandlers: AcpConnectionOptions['fileSystemHandlers']
  private readonly terminalHandlers: AcpConnectionOptions['terminalHandlers']
  private readonly activeSessionIds = new Set<string>()
  private readonly updateListeners = new Set<SessionUpdateListener>()
  private initializePromise: Promise<acp.InitializeResponse> | undefined
  private connectionClosePromise: Promise<void> | undefined
  private negotiated: acp.InitializeResponse | undefined
  /**
 * connection poison：触发放弃的 RPC 操作名（未 poison 为 undefined）。
   * 一次性不信任声明——被弃 RPC 的迟到响应可能与后续帧交错，连接协议状态从此
   * 不可证；置位时已后台发起 close()，此后所有 RPC 立即拒绝（见 {@link rpc}）。
   */
  private poisonedByOp: string | undefined

  constructor(spec: AcpConnectionSpec, options: AcpConnectionOptions = {}) {
    if (spec.argv.length === 0) {
 // 配置类失败（taxonomy category='config'）：spec 组装错误，非「命令未安装」
      throw new AcpClientError('spawn-failure', 'ACP connection spec requires a non-empty argv (argv[0] is the executable)', { category: 'config' })
    }
    if (spec.spawnPlan !== undefined && spec.wrapArgv !== undefined) {
      throw new AcpClientError('spawn-failure', 'AcpConnectionSpec.spawnPlan and wrapArgv are mutually exclusive: a spawn plan carries the final argv (already confined)', { category: 'config' })
    }
 // fail closed：subprocess seam 必填（宿主 ctx.subprocess 的窄化产物）；
    // 缺席 = 宿主 composition 缺 subprocess-local provider（部署/配置问题，category='config'），
    // 绝不回退自制 spawn。
    if (spec.subprocess === undefined || spec.subprocess === null) {
      throw new AcpClientError('spawn-failure', ACP_SUBPROCESS_UNAVAILABLE_MESSAGE, { category: 'config' })
    }
    const argv = spec.spawnPlan !== undefined
      ? [...spec.spawnPlan.argv]
      : spec.wrapArgv !== undefined
        ? spec.wrapArgv([...spec.argv])
        : spec.argv
    const command = argv[0]
    if (command === undefined || command === '') {
      throw new AcpClientError('spawn-failure', 'wrapArgv/spawnPlan must yield a non-empty argv (argv[0] is the executable)', { category: 'config' })
    }
    this.spec = spec
    this.command = command
    this.clientInfo = options.clientInfo ?? { name: '@zaimokuza/dsh-acp-adapter', version: '0.0.0' }
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    this.onPermissionRequest = options.onPermissionRequest
    this.onElicitationRequest = options.onElicitationRequest
    this.fileSystemHandlers = options.fileSystemHandlers
    this.terminalHandlers = options.terminalHandlers
    if (options.onSessionUpdate !== undefined) this.updateListeners.add(options.onSessionUpdate)

 // 结构化 spawn：argv 直达 seam，不经 shell（堵注入面； 经 spawnPlan/wrapArgv 包
    // confine）。spawnPlan 存在时其 env 整体替换 spec.env（计划在组装期已含全量 env）。
    // 进程旋钮是 AcpConnectionOptions 的进程半（AcpProcessOptions），原样透传。
    this.process = new AcpAgentProcess(
      { argv, cwd: spec.cwd, env: spec.spawnPlan !== undefined ? spec.spawnPlan.env : spec.env, subprocess: spec.subprocess },
      options,
    )

    // Node 的 toWeb 与 SDK 期望的 lib.dom 流类型在 BYOB reader 签名上有结构性出入，
    // 仅在接缝处做一次显式收窄（运行时是同一套 Node web stream 实现；sdk-contract 先例）。
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.process.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as unknown as ReadableStream<Uint8Array>,
    )
    this.conn = this.buildClientApp().connect(stream)
  }

  /** 子进程 pid；spawn 失败（ENOENT 等）时为 undefined。 */
  get pid(): number | undefined {
    return this.process.pid
  }

  /** 退出事实；进程仍在运行（或 spawn 失败从未存在）时为 null。 */
  get exited(): AcpProcessExit | null {
    return this.process.exited
  }

  /** close 是否已发起。 */
  get isClosed(): boolean {
    return this.process.isClosed
  }

 /** poison 事实：触发放弃的 RPC 操作名；未 poison 为 undefined。 */
  get poisonedBy(): string | undefined {
    return this.poisonedByOp
  }

  /** initialize 协商记录的 agentInfo（未协商时为 undefined）。 */
  get agentInfo(): acp.Implementation | null | undefined {
    return this.negotiated?.agentInfo
  }

  /** initialize 协商记录的 agent capabilities（未协商时为 undefined）。 */
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.negotiated?.agentCapabilities
  }

  /** initialize 协商出的 ACP 协议版本（未协商时为 undefined；binding 预检比对用）。 */
  get protocolVersion(): number | undefined {
    return this.negotiated?.protocolVersion
  }

  /** initialize 协商记录的 authMethods（未协商或 agent 未提供时为空数组）。 */
  get authMethods(): acp.AuthMethod[] {
    return this.negotiated?.authMethods ?? []
  }

  /** 脱敏后的 stderr 环形缓冲快照（供健康/诊断端点）。 */
  stderrLines(): string[] {
    return this.process.stderrLines()
  }

  /**
   * ACP v1 initialize 握手：按实际接线生成最小 client capabilities（fs 只有 read/write
   * handler 同时存在时广告；terminal 只有完整 handler 接线时广告），
   * 记录 agentInfo/capabilities/authMethods。并发/重复调用共享同一次握手（幂等）；
   * `options` 只对真正发起握手的那次调用生效（后续共享调用忽略）。
   * 失败按 {@link AcpErrorKind} 分类，且拒绝前先把未公开的子进程拆除（无孤儿）。
   */
  initialize(options: AcpRpcOptions = {}): Promise<acp.InitializeResponse> {
    this.initializePromise ??= this.runInitialize(options)
    return this.initializePromise
  }

  /** 建 ACP 会话；Agent 使用自己的 MCP 配置，插件不注入宿主 MCP 定义。 */
  async newSession(params: { cwd?: string } = {}, options: AcpRpcOptions = {}): Promise<acp.NewSessionResponse> {
    const response = await this.rpc<acp.NewSessionResponse>('session/new', async (agent) => await agent.request('session/new', { cwd: params.cwd ?? this.spec.cwd, mcpServers: [] }) as acp.NewSessionResponse, options, DEFAULT_SESSION_SETUP_TIMEOUT_MS)
    this.activeSessionIds.add(response.sessionId)
    return response
  }

  /** 恢复 ACP 会话（agent 须广告 loadSession；回放更新走 session/update 通知）。 */
  async loadSession(sessionId: string, params: { cwd?: string } = {}, options: AcpRpcOptions = {}): Promise<acp.LoadSessionResponse> {
    const response = await this.rpc<acp.LoadSessionResponse>('session/load', async (agent) => await agent.request('session/load', { sessionId, cwd: params.cwd ?? this.spec.cwd, mcpServers: [] }) as acp.LoadSessionResponse, options, DEFAULT_SESSION_SETUP_TIMEOUT_MS)
    this.activeSessionIds.add(sessionId)
    return response
  }

  /**
   * 无回放地恢复 ACP 会话。调用方必须先确认 Agent 广告
   * `sessionCapabilities.resume`；成功响应表示 Agent 已恢复原语义上下文，历史展示
   * 继续以 DSH 日志为准。
   */
  async resumeSession(sessionId: string, params: { cwd?: string } = {}, options: AcpRpcOptions = {}): Promise<acp.ResumeSessionResponse> {
    const response = await this.rpc<acp.ResumeSessionResponse>('session/resume', async (agent) => await agent.request('session/resume', { sessionId, cwd: params.cwd ?? this.spec.cwd, mcpServers: [] }) as acp.ResumeSessionResponse, options, DEFAULT_SESSION_SETUP_TIMEOUT_MS)
    this.activeSessionIds.add(sessionId)
    return response
  }

  /** 列 ACP 会话（agent 须广告 sessionCapabilities.list）。 */
  async listSessions(params: { cwd?: string; cursor?: string } = {}, options: AcpRpcOptions = {}): Promise<acp.ListSessionsResponse> {
    return await this.rpc('session/list', (agent) => agent.request('session/list', { cwd: params.cwd ?? null, cursor: params.cursor ?? null }), options, DEFAULT_SESSION_SETUP_TIMEOUT_MS)
  }

 /** 关闭 ACP 会话（agent 须广告 sessionCapabilities.close； probe 清理用）。 */
  async closeSession(sessionId: string, options: AcpRpcOptions = {}): Promise<acp.CloseSessionResponse> {
    await this.terminalHandlers?.releaseSession?.(sessionId)
    try {
      return await this.rpc('session/close', (agent) => agent.request('session/close', { sessionId }), options, DEFAULT_SESSION_CLEANUP_TIMEOUT_MS)
    } finally {
      this.activeSessionIds.delete(sessionId)
      await this.terminalHandlers?.releaseSession?.(sessionId)
    }
  }

  /** 删除 ACP 会话（agent 须广告 sessionCapabilities.delete；删除后不再出现在 session/list）。 */
  async deleteSession(sessionId: string, options: AcpRpcOptions = {}): Promise<acp.DeleteSessionResponse> {
    await this.terminalHandlers?.releaseSession?.(sessionId)
    try {
      return await this.rpc('session/delete', (agent) => agent.request('session/delete', { sessionId }), options, DEFAULT_SESSION_CLEANUP_TIMEOUT_MS)
    } finally {
      this.activeSessionIds.delete(sessionId)
      await this.terminalHandlers?.releaseSession?.(sessionId)
    }
  }

  /**
   * 配置项热切换（模型/模式/思考强度走这里）；响应为完整 configOptions 快照。
 * 类型保真：select 传 string 值 id；boolean 传原生 boolean（协议要求
   * 请求携带 `type: "boolean"` 判别字段），不把 boolean 编码成字符串。
   */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean, options: AcpRpcOptions = {}): Promise<acp.SetSessionConfigOptionResponse> {
    const params: acp.SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, value }
    return await this.rpc('session/set_config_option', (agent) => agent.request('session/set_config_option', params), options, DEFAULT_SESSION_WRITE_TIMEOUT_MS)
  }

  /** 会话模式切换。 */
  async setMode(sessionId: string, modeId: string, options: AcpRpcOptions = {}): Promise<acp.SetSessionModeResponse> {
    return await this.rpc('session/set_mode', (agent) => agent.request('session/set_mode', { sessionId, modeId }), options, DEFAULT_SESSION_WRITE_TIMEOUT_MS)
  }

  /**
   * 发起一个 prompt turn。`onUpdate` 在本次调用期间注册为额外 session/update
   * 监听器（turn 结束自动摘除）；崩溃时已流出的 chunk 不丢（监听器先收，
   * 挂起的 prompt 后以 crash 分类 reject）。
   *
 * 无默认预算：turn 时长合法无界，正常取消由 agent.ts 的取消升级梯子
   * 治理（cancel 帧 → 限时停稳 → terminate），那条路径 prompt 正常 settle、
   * 不 poison；只有调用方经 `options` 显式给 `timeoutMs`/`signal` 且竞速胜出
   * 时才按放弃处理（poison）。
   */
  async prompt(sessionId: string, prompt: acp.ContentBlock[], onUpdate?: SessionUpdateListener, options: AcpRpcOptions = {}): Promise<acp.PromptResponse> {
    if (onUpdate !== undefined) this.updateListeners.add(onUpdate)
    try {
      return await this.rpc('session/prompt', (agent) => agent.request('session/prompt', { sessionId, prompt }), options)
    } finally {
      if (onUpdate !== undefined) this.updateListeners.delete(onUpdate)
    }
  }

  /** 发送 `session/cancel` 通知。 */
  async cancel(sessionId: string): Promise<void> {
    this.terminalHandlers?.cancelSession?.(sessionId)
    try {
      await this.rpc('session/cancel', (agent) => agent.notify('session/cancel', { sessionId }))
    } finally {
      this.terminalHandlers?.cancelSession?.(sessionId)
    }
  }

  /**
   * 拆除梯子（进程半持有：stdin EOF → `eofGraceMs` → seam `terminate()`（SIGTERM →
   * `termGraceMs` → SIGKILL 树级升级；Windows taskkill /T /F）→ **有界**
   * `waitForExit()`（`exitWaitMs`，默认 10s；超时响亮告警后 resolve——SIGKILL 后
   * 仍不退出是内核级异常，不能为此挂死 DSH shutdown））。幂等：重复调用返回同一
   * Promise。spawn 失败/已退出时立即返回。
   */
  close(): Promise<void> {
    // Stop host-side FS work before tearing down stdio. Otherwise a slow disk
    // operation could outlive the ACP connection and resolve against a future
    // session/process generation.
    this.fileSystemHandlers?.dispose?.()
    return this.connectionClosePromise ??= (async () => {
      try {
        await this.terminalHandlers?.dispose?.()
      } finally {
        // Terminal cleanup is an auxiliary capability. A broken terminal
        // handle must never prevent the owner process from entering the
        // bounded termination ladder.
        await this.process.close()
      }
    })()
  }

  /**
   * 独立短生命周期 probe：spawn → initialize → `session/new`（临时 cwd）→
 * 收集 configOptions → capability-aware 会话清理→
   * 拆除（finally 保证）。清理次序 close 先 delete 后，各自独立 try/catch：
   * 失败记进结果的 `cleanup` 事实，**不翻转** probe 成败，也不阻塞 finally 的
 * 进程强杀与临时目录删除。失败携带 probe 阶段标记（
   * `AcpClientError.probePhase`，健康卡 initialize/session 分层的判据；到达
   * session 阶段即证明 initialize 已通过）。
   */
  static async probe(spec: AcpConnectionSpec, options: AcpProbeOptions = {}): Promise<AcpProbeResult> {
    const { cwd, timeoutMs, ...connectionOptions } = options
    const timeout = timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const probeCwd = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-probe-'))
    const ownsCwd = cwd === undefined
    // devin 实测在 session/new 响应前推送 config_option_update 快照；响应缺字段时以推送兜底
    let pushedConfigOptions: acp.SessionConfigOption[] | undefined
    const callerOnUpdate = connectionOptions.onSessionUpdate
    connectionOptions.onSessionUpdate = (notification) => {
      if (notification.update.sessionUpdate === 'config_option_update') {
        pushedConfigOptions = notification.update.configOptions
      }
      callerOnUpdate?.(notification)
    }
    const conn = new AcpClientConnection(spec, { initializeTimeoutMs: timeout, ...connectionOptions })
    try {
      let init: acp.InitializeResponse
      try {
        init = await conn.initialize()
      } catch (error: unknown) {
        throw markProbePhase(error, 'initialize')
      }
      let session: acp.NewSessionResponse
      try {
 // session/new 的预算并入连接层单笔 deadline（同一套 RPC 定时器，
        // 不再自卷第二套 withTimeout）；超时错误经 markProbePhase 归 session 阶段
        session = await conn.newSession({ cwd: probeCwd }, { timeoutMs: timeout })
      } catch (error: unknown) {
        throw markProbePhase(error, 'session')
      }
      const cleanup = await probeSessionCleanup(conn, init.agentCapabilities, session.sessionId)
      return {
        sessionId: session.sessionId,
        cleanup,
        agentInfo: init.agentInfo,
        agentCapabilities: init.agentCapabilities,
 // readiness：协商出的协议版本随 probe 结果上缓存（健康行展示）
        protocolVersion: init.protocolVersion,
        authMethods: init.authMethods ?? [],
        modes: session.modes,
        configOptions: session.configOptions ?? pushedConfigOptions,
        stderrTail: conn.stderrLines(),
      }
    } finally {
      await conn.close()
      if (ownsCwd) fs.rmSync(probeCwd, { recursive: true, force: true })
    }
  }

  private async runInitialize(options: AcpRpcOptions): Promise<acp.InitializeResponse> {
    this.assertOpen('initialize')
    this.assertNotAborted('initialize', options.signal)
    const timeoutMs = options.timeoutMs ?? this.initializeTimeoutMs
    try {
      // 竞速：握手 vs spawn 失败 vs 预算/中止（raceBudget）；对端立即退出则由 SDK 的
      // connection-closed rejection 进 catch 分类为 crash。
      const response = await this.raceBudget(
        'initialize',
        Promise.race([
          this.conn.agent.request('initialize', {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              ...(this.onElicitationRequest === undefined ? {} : { elicitation: { form: {}, url: {} } }),
              ...(this.fileSystemHandlers === undefined ? {} : { fs: { readTextFile: true, writeTextFile: true } }),
              ...(this.terminalHandlers === undefined ? {} : { terminal: true }),
            },
            clientInfo: this.clientInfo,
          }),
          this.process.spawnFailureArm,
        ]),
        options.signal,
        timeoutMs,
      )
      this.negotiated = response
      return response
    } catch (error: unknown) {
      const classified = await this.classify(error, 'initialize')
      // 启动失败拥有尚未公开的进程：拒绝前先拆除（照搬 subagent-acp 的启动回滚语义；
      // raceBudget 放弃臂已 poison 并后台发起 close，这里是同一幂等梯子）
      await this.close()
      throw classified
    }
  }

  private buildClientApp(): acp.ClientApp {
    return acp
      .client()
      .onNotification('session/update', ({ params }) => {
        for (const listener of this.updateListeners) {
          try {
            listener(params)
          } catch {
            // 监听器错误不得污染协议流（SDK 对通知 handler 抛错仅记日志，这里主动吞掉）
          }
        }
      })
      .onRequest('session/request_permission', ({ params }) => {
        const handler = this.onPermissionRequest
        if (handler === undefined) {
 // 审批桥接入前 fail closed（对齐 sdk-contract 先例）
          return { outcome: { outcome: 'cancelled' } }
        }
        return handler(params)
      })
      // Elicitation is handled only when the full host broker + Remote + UI seam
      // is present; otherwise the standard decline response remains fail-closed.
      .onRequest('elicitation/create', ({ params }) => {
        // ACP v1 requests are session-scoped when a sessionId is present. Do
        // not let a peer use this connection's broker to cross that boundary;
        // request-scoped variants (requestId only) remain eligible for the
        // currently bound connection.
        const sessionId = 'sessionId' in params && typeof params.sessionId === 'string' ? params.sessionId : undefined
        if (sessionId !== undefined && !this.activeSessionIds.has(sessionId)) return { action: 'decline' }
        const handler = this.onElicitationRequest
        if (handler === undefined) return { action: 'decline' }
        return handler(params)
      })
      .onRequest('fs/read_text_file', ({ params }) => {
        const handler = this.fileSystemHandlers?.readTextFile
        if (handler === undefined) throw new Error('ACP fs/read_text_file is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP fs/read_text_file rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('fs/write_text_file', ({ params }) => {
        const handler = this.fileSystemHandlers?.writeTextFile
        if (handler === undefined) throw new Error('ACP fs/write_text_file is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP fs/write_text_file rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('terminal/create', ({ params }) => {
        const handler = this.terminalHandlers?.createTerminal
        if (handler === undefined) throw new Error('ACP terminal/create is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP terminal/create rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('terminal/output', ({ params }) => {
        const handler = this.terminalHandlers?.terminalOutput
        if (handler === undefined) throw new Error('ACP terminal/output is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP terminal/output rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('terminal/wait_for_exit', ({ params }) => {
        const handler = this.terminalHandlers?.waitForExit
        if (handler === undefined) throw new Error('ACP terminal/wait_for_exit is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP terminal/wait_for_exit rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('terminal/kill', ({ params }) => {
        const handler = this.terminalHandlers?.killTerminal
        if (handler === undefined) throw new Error('ACP terminal/kill is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP terminal/kill rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
      .onRequest('terminal/release', ({ params }) => {
        const handler = this.terminalHandlers?.releaseTerminal
        if (handler === undefined) throw new Error('ACP terminal/release is not available')
        if (!this.activeSessionIds.has(params.sessionId)) throw new Error(`ACP terminal/release rejected: session ${params.sessionId} is not owned by this connection`)
        return handler(params)
      })
  }

  private async rpc<T>(operation: string, call: (agent: acp.ClientContext) => Promise<T>, options: AcpRpcOptions = {}, defaultTimeoutMs?: number): Promise<T> {
    this.assertNotPoisoned(operation)
    this.assertOpen(operation)
    this.assertInitialized(operation)
    this.assertNotAborted(operation, options.signal)
    try {
      return await this.raceBudget(operation, call(this.conn.agent), options.signal, options.timeoutMs ?? defaultTimeoutMs)
    } catch (error: unknown) {
      // raceBudget 的放弃臂产物（AcpClientError）由 classify 原样透传
      throw await this.classify(error, operation)
    }
  }

  /**
 * RPC 预算竞速：底层 RPC promise vs 超时臂 vs 中止臂。超时/中止竞速胜出
   * 而底层 promise 未 settle = **放弃该 RPC** 被弃 promise 挂 noop catch（迟到
   * rejection 安全落地，不泄漏 unhandled），连接置 poison 并后台发起 close    * （不等它）。无预算且无 signal 时零开销直通。
   */
  private async raceBudget<T>(operation: string, attempt: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<T> {
    if (timeoutMs === undefined && signal === undefined) return await attempt
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const arms: Promise<never>[] = []
    if (timeoutMs !== undefined) {
      arms.push(new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AcpClientError('timeout', `ACP agent "${this.command}" did not answer ${operation} within ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }))
    }
    if (signal !== undefined) {
      arms.push(new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new AcpClientError('aborted', `ACP ${operation} aborted by the caller; the in-flight RPC was abandoned and the connection is being torn down`))
        }
        // 已中止的信号不回放 abort 事件——手动补触发（调用点 assertNotAborted 之后
        // 到本臂注册之间中止的竞态由这里兜住）
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }))
    }
    try {
      return await Promise.race([attempt, ...arms])
    } catch (error: unknown) {
      if (error instanceof AcpClientError) {
        // 本层放弃臂产物（底层 SDK 只产 RequestError/connection-closed，不产
        // AcpClientError）：放弃在飞 RPC —— noop catch 落地迟到 settle + poison
        void attempt.catch(() => {})
        this.poison(operation)
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
 * connection poison：任何 RPC 因 timeout/abort 被放弃后，记录触发 op
   * 并后台发起拆除。一次性闩锁；crash（进程消亡后 RPC 本就 reject）不需要
   * poison 概念，close 已发起时也不重复置位。
   */
  private poison(operation: string): void {
    if (this.poisonedByOp !== undefined || this.isClosed) return
    this.poisonedByOp = operation
    // 后台拆除（不等）：被弃 RPC 的迟到响应可能与后续帧交错，协议状态不可证。
    // 梯子自身不抛（有界 waitForExit 兜底）；拆除告警由进程半的 onProcessWarn 承担
    void this.close().catch(() => {})
  }

  private assertNotPoisoned(operation: string): void {
    if (this.poisonedByOp !== undefined) {
      throw new AcpClientError(
        'protocol-error',
        `ACP connection to "${this.command}" is poisoned after an abandoned RPC (${this.poisonedByOp}); tearing down — retry on a fresh connection (refused ${operation})`,
      )
    }
  }

  /** 进场前已中止：不发帧直接拒（无 RPC 在飞，连接未污染、不 poison）。 */
  private assertNotAborted(operation: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new AcpClientError('aborted', `ACP ${operation} not dispatched: the caller signal is already aborted`)
    }
  }

  private assertOpen(operation: string): void {
    if (this.process.isClosed) {
      throw new Error(`AcpClientConnection.${operation}: connection is closed`)
    }
  }

  private assertInitialized(operation: string): void {
    if (this.negotiated === undefined) {
      throw new Error(`AcpClientConnection.${operation}: call initialize() first`)
    }
  }

  /** 把任意 thrown 值分类为结构化错误；已是 AcpClientError 的原样透传。 */
  private async classify(error: unknown, operation: string): Promise<Error> {
    if (error instanceof AcpClientError) return error
    if (this.process.spawnFailure !== undefined) {
      return new AcpClientError('spawn-failure', this.spawnFailureMessage(), { cause: this.process.spawnFailure })
    }
    if (error instanceof acp.RequestError) {
      if (error.code === ACP_ERROR_CODE_AUTH_REQUIRED) {
        return new AcpClientError(
          'auth_required',
          `ACP agent "${this.command}" requires authentication (${operation}); sign in with the agent's own tooling (see the provider login hint)`,
          { cause: error },
        )
      }
      return new AcpClientError(
        'protocol-error',
        `ACP agent "${this.command}" rejected ${operation}: ${error.message} (JSON-RPC code ${String(error.code)})`,
        { cause: error },
      )
    }
    if (!this.process.isClosing && (this.process.exited !== null || isConnectionClosedError(error))) {
      const exit = await this.process.harvestExit()
      const stderrTail = this.process.stderrLines().slice(-5)
      return new AcpClientError('crash', this.crashMessage(operation, exit, stderrTail), { exit, stderrTail, cause: error })
    }
    const message = error instanceof Error ? error.message : String(error)
    return new AcpClientError('protocol-error', `ACP ${operation} failed: ${message}`, { cause: error })
  }

  private spawnFailureMessage(): string {
    const code = (this.process.spawnFailure as { code?: unknown } | undefined)?.code
    if (code === 'ENOENT') {
      return `ACP agent command not found: "${this.command}" (spawn ENOENT); check the provider command/args setting`
    }
    return `failed to spawn ACP agent "${this.command}": ${this.process.spawnFailure?.message ?? 'unknown error'}`
  }

  private crashMessage(operation: string, exit: AcpProcessExit | undefined, stderrTail: string[]): string {
    const fact = exit === undefined ? 'exit status unknown' : `exit code ${String(exit.code ?? 'none')}, signal ${exit.signal ?? 'none'}`
    const base = `ACP agent "${this.command}" died during ${operation} (${fact}); updates streamed so far were preserved`
    return stderrTail.length === 0 ? base : `${base}\nagent stderr (last ${String(stderrTail.length)} lines):\n${stderrTail.join('\n')}`
  }
}
