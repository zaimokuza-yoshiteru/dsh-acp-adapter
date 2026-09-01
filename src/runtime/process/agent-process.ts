/**
 * ACP agent 子进程生命周期（自 acp-client.ts 切出的进程半；协议半见
 * src/protocol/v1/connection.ts）：spawn、stdio 泵、stderr 环形缓冲、退出事实
 * 收割与拆除梯子。 spawn 与终止全部改经宿主公共 seam `ctx.subprocess`
 * （宿主 SubprocessRuntime，结构面见 ./subprocess.ts 的
 * {@link SubprocessSeam}），本类不再直接触碰 `node:child_process`。
 *
 * - 结构化 spawn：`argv: string[]` 直达 seam（stdio 由窄化适配器固定
 *   pipe/pipe/pipe），禁止拼 shell 字符串；调用方（连接层）已在传入前解析
 *   `spawnPlan`/`wrapArgv` 插口为最终 argv/env。env 只包含 profile 显式覆盖，
 *   由宿主 subprocess service 合并 scrubbed parent env。
 * - 拆除梯子：stdin EOF → `eofGraceMs`（默认 500ms）→ `terminate()`（seam 的
 *   SIGTERM → `termGraceMs`（默认 2s，即 spawn spec 的 graceMs）→ SIGKILL 树级
 *   升级；Windows 为 taskkill /T /F）→ **有界** `waitForExit()`（`exitWaitMs`，
 * 默认 10s）：SIGKILL 后仍不退出是内核级异常——超时经 `onProcessWarn`
 *   响亮告警后 resolve，不能为此挂死 DSH shutdown。
 * Devin 不响应 stdin EOF，EOF 仅作礼貌
 * 窗口；自制 POSIX 信号（直发 SIGTERM/SIGKILL）已全部删除。
 * - stderr 环形缓冲见 ./stderr.ts（行数/字节双上限 + 写入即脱敏）；超时工具
 *   见 ./timeout.ts。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；本文件是 host 侧子进程模块，
 * 经下方 triple-slash reference 显式引入 @types/node，不改动共享 tsconfig。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/agent-process
 */

/// <reference types="node" />

import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import {
  DEFAULT_STDERR_MAX_BYTES,
  DEFAULT_STDERR_MAX_LINES,
  StderrRing,
  defaultRedactStderrLine,
} from './stderr.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from './subprocess.ts'
import { abortAfter, waitWithin } from './timeout.ts'
import type { AcpProcessExit, AcpProcessOptions } from './types.ts'

/** 拆除梯子第 1 级缺省：stdin EOF 后的等待窗口（毫秒）。 */
export const DEFAULT_EOF_GRACE_MS = 500
/** 拆除梯子第 2 级缺省：terminate 的 SIGTERM → SIGKILL 升级间隔（spawn spec 的 graceMs，毫秒）。 */
export const DEFAULT_TERM_GRACE_MS = 2_000
/**
 * 拆除梯子末级缺省：terminate 之后等待整树退出证明的上限（毫秒）。
 * SIGKILL 不可捕获、退出有保证；超时 = 内核级异常，响亮告警后 resolve，
 * 绝不为退出证明挂死 DSH shutdown。
 */
export const DEFAULT_EXIT_WAIT_MS = 10_000
/** 崩溃分类时等待退出事实收割的上限（对端 stdout EOF 后 close 通常紧随）。 */
const CRASH_EXIT_HARVEST_MS = 500
/** waitForExit 超时后给退出事实（done 结算）的兜底收割窗口（毫秒）。 */
const EXIT_FACT_GRACE_MS = 500

/** 把 seam 拒绝值归一成 Error（seam 契约的 reject 恒为 Error；非 Error 是防御兜底）。 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 一条 ACP agent 子进程：经 {@link SubprocessSeam} spawn，拥有 stdio/stderr 环/
 * 退出事实与拆除梯子。协议面（initialize 协商、typed RPC、错误分类、probe）由
 * src/protocol/v1/connection.ts 的 `AcpClientConnection` 在本类之上组合。
 * 用毕必须 {@link close}（幂等），否则子进程残留（宿主服务 dispose 另有兜底，
 * 但那不是本类放弃拆除的理由）。
 */
export class AcpAgentProcess {
  /** 最终 argv[0]（调用方解析 wrapArgv/spawnPlan 后的可执行文件）。 */
  readonly command: string
  /** seam 句柄；spawn 同步抛错/流违约时为 undefined（失败事实在 spawnFailureError）。 */
  private readonly handle: AcpSubprocessHandle | undefined
  /** 协议层接管的 stdin（spawn 失败路径上是 PassThrough 哑流：SDK 接线不炸，帧流入黑洞）。 */
  private readonly stdinStream: Writable
  /** 协议层接管的 stdout（同上失败路径为哑流）。 */
  private readonly stdoutStream: Readable
  private readonly eofGraceMs: number
  private readonly termGraceMs: number
  private readonly exitWaitMs: number
 /** 进程半的响亮告警通道（缺省落 console.error——无 hook 也要响亮）。 */
  private readonly onWarn: (message: string) => void
  private readonly stderrRing: StderrRing
  private stderrLeftover = ''
  private spawnFailureError: Error | undefined
  private exitInfo: AcpProcessExit | null = null
  private readonly exitPromise: Promise<AcpProcessExit>
  /**
   * spawn 失败臂（seam 同步抛错或 `done` reject 即 reject）：协议层的 initialize
   * 与之竞速。构造时已挂兜底 catch，未被竞速消费不触发 unhandledRejection。
   */
  readonly spawnFailureArm: Promise<never>
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(
    args: { argv: readonly string[]; cwd: string; env: Record<string, string>; subprocess: SubprocessSeam },
    options: AcpProcessOptions = {},
  ) {
    const command = args.argv[0]
    if (command === undefined || command === '') {
      throw new Error('AcpAgentProcess requires a non-empty argv (argv[0] is the executable)')
    }
    this.command = command
    this.eofGraceMs = options.eofGraceMs ?? DEFAULT_EOF_GRACE_MS
    this.termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS
    this.exitWaitMs = options.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS
    this.onWarn = options.onProcessWarn ?? ((message: string): void => { console.error(message) })
    this.stderrRing = new StderrRing(
      options.stderrMaxLines ?? DEFAULT_STDERR_MAX_LINES,
      options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
      options.redactStderrLine ?? defaultRedactStderrLine,
    )

 // 结构化 spawn：argv 直达 seam，不经 shell（堵注入面； 经 spawnPlan/wrapArgv
    // 包 confine——spawnPlan 存在时其 env 整体替换 spec.env，由连接层在传入前解析）。
    // graceMs = 拆除梯子第 2 级的升级间隔（terminate 的 SIGTERM→SIGKILL 定时由 seam 持有）。
    // env = profile 显式覆盖；subprocess service 负责 scrubbed parent env 底座。
    let handle: AcpSubprocessHandle | undefined
    let syncFailure: Error | undefined
    try {
      handle = args.subprocess.spawn({
        argv: args.argv,
        cwd: args.cwd,
        env: args.env,
        graceMs: this.termGraceMs,
      })
      // seam 契约：pipe/pipe/pipe 由窄化适配器固定，流恒在场；缺场 = 实现违约，
      // 按 spawn 级失败处理（先 terminate 收回已 spawn 的进程，再落入失败态）。
      if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
        handle.terminate()
        throw new Error('subprocess implementation dropped a piped protocol stream')
      }
    } catch (error: unknown) {
      syncFailure = toError(error)
      handle = undefined
    }
    this.handle = handle
    // spawn 失败路径的哑流：连接层构造即接线（Writable.toWeb 等），失败必须经
    // spawnFailureArm 延迟暴露给 initialize 分类，而非构造即炸穿。
    this.stdinStream = handle?.stdin ?? new PassThrough()
    this.stdoutStream = handle?.stdout ?? new PassThrough()

    this.exitPromise = new Promise<AcpProcessExit>((resolve) => {
      let settled = false
      const settle = (exit: AcpProcessExit): void => {
        if (settled) return
        settled = true
        resolve(exit)
      }
      if (handle === undefined) {
        settle({ code: null, signal: null })
        return
      }
      handle.done.then(
        (outcome) => {
          this.exitInfo = { code: outcome.exitCode, signal: outcome.signal }
          this.flushStderrLeftover()
          settle(this.exitInfo)
        },
        // spawn 级失败（ENOENT 等）：无退出事实可收割，以空事实收束让梯子立即返回
        () => {
          settle({ code: null, signal: null })
        },
      )
    })

    this.spawnFailureArm = new Promise<never>((_resolve, reject) => {
      if (syncFailure !== undefined) {
        this.spawnFailureError = syncFailure
        reject(syncFailure)
        return
      }
      handle?.done.catch((error: unknown) => {
        this.spawnFailureError = toError(error)
        reject(this.spawnFailureError)
      })
    })
    // 未被 initialize 竞速消费时（构造后从未 initialize）不触发 unhandledRejection
    void this.spawnFailureArm.catch(() => {})

    if (handle !== undefined) {
      // stdin 的 'error'（对端退出后写 EPIPE）必须吞掉，否则 Node 把未处理流错误抛成进程级异常
      this.stdinStream.on('error', () => {})
      handle.stderr?.setEncoding('utf8')
      handle.stderr?.on('data', (chunk: string) => {
        this.ingestStderr(chunk)
      })
      handle.stderr?.once('end', () => {
        this.flushStderrLeftover()
      })
    }
  }

  /** 协议层接管 stdio 的缝：子进程 stdin（SDK ndJsonStream 的可写端）。 */
  get stdin(): Writable {
    return this.stdinStream
  }

  /** 协议层接管 stdio 的缝：子进程 stdout（SDK ndJsonStream 的可读端）。 */
  get stdout(): Readable {
    return this.stdoutStream
  }

  /** 子进程 pid；spawn 失败（ENOENT 等，seam 报 -1）或未持有句柄时为 undefined。 */
  get pid(): number | undefined {
    const pid = this.handle?.pid
    return pid === undefined || pid < 0 ? undefined : pid
  }

  /** 退出事实；进程仍在运行（或 spawn 失败从未存在）时为 null。 */
  get exited(): AcpProcessExit | null {
    return this.exitInfo
  }

  /** close 是否已发起。 */
  get isClosed(): boolean {
    return this.closePromise !== undefined
  }

  /** 拆除梯子是否已进场（close 首段同步置位；crash 分类据此区分主动拆除）。 */
  get isClosing(): boolean {
    return this.closing
  }

  /** spawn 失败事实（seam 同步抛错或 `done` reject 收割；ENOENT 等）；未失败为 undefined。 */
  get spawnFailure(): Error | undefined {
    return this.spawnFailureError
  }

  /** 脱敏后的 stderr 环形缓冲快照（供健康/诊断端点与 crash 分类）。 */
  stderrLines(): string[] {
    return this.stderrRing.snapshot()
  }

  /**
   * 拆除梯子：stdin EOF → `eofGraceMs`（默认 500ms）内整树不退 → `terminate()`
   * （seam 的 SIGTERM → `termGraceMs`（默认 2s）→ SIGKILL 树级升级，Windows 为
 * taskkill /T /F）→ **有界** `waitForExit()`（`exitWaitMs`，默认 10s）：
   * 超时经 onProcessWarn 响亮告警后 resolve（SIGKILL 后仍不退出是内核级异常，
   * 不能为此挂死 DSH shutdown）。幂等：重复调用返回同一 Promise。
   * spawn 失败/已退出时立即返回。
   */
  close(): Promise<void> {
    this.closePromise ??= this.teardown()
    return this.closePromise
  }

  /** stdout EOF 后退出事实通常紧随；给上限等待收割 exit code + signal。 */
  async harvestExit(): Promise<AcpProcessExit | undefined> {
    if (this.exitInfo !== null) return this.exitInfo
    if (this.spawnFailureError !== undefined) return undefined
    return await waitWithin(this.exitPromise, CRASH_EXIT_HARVEST_MS)
  }

  private async teardown(): Promise<void> {
    this.closing = true
    const handle = this.handle
    // spawn 失败或已退出：无活进程可拆（exitPromise 的两条收束臂都已就位）
    if (handle === undefined || this.spawnFailureError !== undefined || this.exitInfo !== null) {
      await this.exitPromise
      return
    }
    // 第 1 级：stdin EOF（规范的协作退出通道；devin 实测不吃，仅作礼貌窗口）
    try {
      handle.stdin?.end()
    } catch {
      // stdin 已毁损（对端抢跑退出）时不阻塞后续终止级
    }
    if (await this.treeExitsWithin(handle, this.eofGraceMs)) {
      // 整树已消失 ⇒ 管道全闭 ⇒ done 的 close 结算紧随；await 它让 exitInfo 确定性就位
      await this.exitPromise
      return
    }
    // 第 2 级：terminate()（seam 唯一的终止动词：SIGTERM → graceMs → SIGKILL，
 // 树级、幂等）。其后的 waitForExit 有界（`exitWaitMs`）：SIGKILL 不可
    // 捕获、正常内核下退出有保证；窗口耗尽 = 内核级异常——响亮告警后 resolve，
    // 不为退出证明挂死 DSH shutdown。
    handle.terminate()
    const exited = await waitWithin(handle.waitForExit(), this.exitWaitMs)
    if (exited === undefined) {
      this.onWarn(
        `dsh-acp: ACP agent "${this.command}" (pid ${String(handle.pid)}) did not exit within ` +
        `${String(this.exitWaitMs)}ms after SIGKILL escalation; giving up the exit proof (kernel-level anomaly) — ` +
        'the process tree may be a zombie',
      )
      // 退出事实（done 结算）再给兜底窗口；不到货也 resolve（close 幂等语义不变）
      await waitWithin(this.exitPromise, EXIT_FACT_GRACE_MS)
      return
    }
    await this.exitPromise
  }

  /** 限时整树退出等待（subagent-acp run.ts 的 treeExitsWithin 模板）：窗口耗尽返回 false。 */
  private async treeExitsWithin(handle: AcpSubprocessHandle, ms: number): Promise<boolean> {
    const deadline = abortAfter(ms)
    try {
      return await handle.waitForExit(deadline.signal)
    } finally {
      deadline.cancel()
    }
  }

  private ingestStderr(chunk: string): void {
    const text = this.stderrLeftover + chunk
    const lines = text.split('\n')
    this.stderrLeftover = lines.pop() ?? ''
    for (const raw of lines) this.stderrRing.push(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
  }

  private flushStderrLeftover(): void {
    if (this.stderrLeftover === '') return
    this.stderrRing.push(this.stderrLeftover)
    this.stderrLeftover = ''
  }
}
