/**
 * `ctx.subprocess` 公共 seam 的结构化窄化与 spawn 规格组装。
 *
 * dsh 通过宿主服务 `ctx.subprocess` 管理子进程（Service Definition
 * `@deepseek-ai/dsh-subprocess`，本地实现 `@deepseek-ai/dsh-subprocess-local`，
 * dsh-base 默认装配）：spawn 全显式 spec、terminate 是唯一的终止动词
 * （POSIX detached 进程组负 pgid 信号 / Windows taskkill /T /F，SIGTERM →
 * graceMs → SIGKILL 树级升级）、waitForExit 给整树退出证明、服务 dispose 兜底
 * 强杀全部托管进程。本模块定义本包消费的最小结构面（{@link SubprocessSeam}），
 * 采用**纯结构镜像、零 dsh 值级 import**（宿主模块实例一致性纪律：值级 import
 * dsh 包会让产物解析到第二实例）。
 *
 * env 纪律：provider 的 spawn 底座是 `scrubbedParentEnv()`——去 credential
 * 形名与 DSH_*，PATH/HOME/代理变量等保留。本包
 * 现行语义是 profile 显式条目，宿主 subprocess service 将其合并到 scrubbed
 * parent env；本包不再自制 tombstone 或第二套 allowlist。
 *
 * 本包 tsconfig 用 `types: []`；本文件需要 node stream 类型，经 triple-slash
 * reference 显式引入 @types/node（同层 agent-process.ts 同款先例）。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/subprocess
 */

/// <reference types="node" />

import type { Readable, Writable } from 'node:stream'

/**
 * 本包消费的 spawn 规格（上游 `SubprocessSpawnSpec` 的消费侧子集）。stdio 不在
 * 列：本包全部 spawn 都是 pipe/pipe/pipe（stdin 协议写、stdout 协议读、stderr
 * 逐行脱敏环），由 {@link narrowSubprocessSeam} 的适配器在调用点固定填入。
 */
export interface AcpSubprocessSpawnSpec {
  /** 完整 argv（`argv[0]` 为可执行文件）；绝不拼 shell 字符串。 */
  readonly argv: readonly string[]
  /** 子进程工作目录。 */
  readonly cwd: string
  /**
   * 显式环境条目（合并于 provider scrub 底座之后）：string = 放行/覆盖
   * （credential 形名也可经此显式穿透）；`undefined` = tombstone 删除一个
   * 底座残留键；调用方只需传 profile 显式条目。
   */
  readonly env?: Record<string, string | undefined>
  /**
   * terminate 的升级间隔（毫秒）：SIGTERM 后等待该时长再 SIGKILL（Windows
   * 由 taskkill /T /F 立即强杀）。必须是正有限值（上游校验，违规同步抛错）。
   */
  readonly graceMs: number
  /** abort 信号：触发即对该进程树启动 terminate 升级（调用方持有 deadline 与分类）。 */
  readonly signal?: AbortSignal
}

/** 子进程退出事实（上游 `SubprocessOutcome` 的结构镜像；`signal` 用 string 以免依赖 node 全局词表）。 */
export interface AcpSubprocessExitFact {
  /** 退出码；被信号杀死时为 null。 */
  readonly exitCode: number | null
  /** 致死信号（如 'SIGTERM'）；正常退出为 null。 */
  readonly signal: string | null
}

/**
 * 一条活体子进程句柄（上游 `SubprocessHandle` 的消费侧子集）。terminate 树级
 * 作用且幂等（树已死 = no-op）；waitForExit 观察整树存活（SIGTERM 陷阱的孙进程
 * 也不会漏网）；服务 dispose 对全部托管进程 terminate + await，并在 Node exit
 * 阶段同步强杀残留——「不留孤儿」的宿主级兜底。
 */
export interface AcpSubprocessHandle {
  /** 进程 pid（树根）；spawn 级失败为 -1。 */
  readonly pid: number
  /** 子进程 stdin（pipe 模式恒在场；缺场即实现违约，按 spawn 失败处理）。 */
  readonly stdin: Writable | undefined
  /** 子进程 stdout（pipe 模式恒在场）。 */
  readonly stdout: Readable | undefined
  /** 子进程 stderr（pipe 模式恒在场）。 */
  readonly stderr: Readable | undefined
  /** 进程 close 时以退出事实 resolve；仅 spawn 级失败 reject。 */
  readonly done: Promise<AcpSubprocessExitFact>
  /** 启动 SIGTERM → graceMs → SIGKILL 树级升级（唯一的终止动词；幂等）。 */
  terminate(): void
  /** 等待整树退出；signal 先断则返回 false。树退出返回 true。 */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * `ctx.subprocess` 的最小消费面：spawn + resolveExecutable（PATH 解析预检，
 * Windows 下含 PATHEXT 语义）。插件加载期经
 * src/host/composition/subprocess.ts 的 `resolveSubprocessSeam` 解析一次后注入。
 */
export interface SubprocessSeam {
  spawn(spec: AcpSubprocessSpawnSpec): AcpSubprocessHandle
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
}

/**
 * 结构化窄化：候选值必须具备 spawn/resolveExecutable 两个方法（其余上游成员
 * ——spawnTerminal/collected 等——本包不消费，不参与窄化）。返回的 seam 在
 * spawn 调用点固定填入 pipe/pipe/pipe stdio（本包唯一 stdio 形态）；候选缺
 * 方法面时返回 undefined（调用方 fail closed）。
 */
export function narrowSubprocessSeam(candidate: unknown): SubprocessSeam | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const face = candidate as { spawn?: unknown; resolveExecutable?: unknown }
  if (typeof face.spawn !== 'function' || typeof face.resolveExecutable !== 'function') return undefined
  const service = candidate as {
    spawn(spec: AcpSubprocessSpawnSpec & {
      stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe' }
    }): AcpSubprocessHandle
    resolveExecutable(
      command: string,
      env?: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<string>
  }
  return {
    spawn: (spec) =>
      service.spawn({ ...spec, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }),
    resolveExecutable: (command, env, signal) => service.resolveExecutable(command, env, signal),
  }
}

/**
 * seam 解析结果（fail closed 载体）：ok = 活体 seam；not-ok = 宿主未提供
 * subprocess 服务（message 是面向用户的完整诊断文案，由各 spawn 点包装成
 * `AcpClientError('spawn-failure', message)`——六分类不新增词表项）。
 */
export type SubprocessSeamResolution =
  | { readonly ok: true; readonly seam: SubprocessSeam }
  | { readonly ok: false; readonly message: string }

/**
 * seam 缺席的统一文案（解析失败与「未接线」共用同一诊断）：宿主 composition
 * 缺 subprocess-local provider 是部署错误，ACP 路由 fail closed，native 路由不受影响。
 */
export const ACP_SUBPROCESS_UNAVAILABLE_MESSAGE =
  'the host provides no subprocess service (ctx.subprocess): the ACP adapter requires the dsh-base subprocess-local provider; '
  + 'refusing to spawn ACP agents on this host (native dsh routes are unaffected)'
