/**
 * ACP 子进程规格与退出事实的类型面（自 acp-client.ts 切出的共享类型）。
 * 纯类型模块：协议连接层（src/protocol/v1/connection.ts）与原生访问
 * （src/domain/policy/sandbox.ts）共享此处的结构定义；本模块不 import 任何
 * 包内模块（./subprocess.ts 的 seam 类型除外，同层叶子），从根本上杜绝环。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/types
 */

import type { SubprocessSeam } from './subprocess.ts'

/**
 * 连接层消费的 spawn 计划结构面（`src/domain/policy/sandbox.ts` 的
 * The native spawn planner satisfies it; this module remains independent from
 * domain policy to avoid a dependency cycle.
 */
export interface AcpSpawnPlanView {
  /** Final argv; the process layer does not add a shell or wrapper. */
  readonly argv: readonly string[]
  /** Profile 显式环境覆盖；宿主会把它合并到已清理的父环境。 */
  readonly env: Record<string, string>
}

/** 一条 ACP agent 子进程的结构化 spawn 规格。 */
export interface AcpConnectionSpec {
  /**
   * 完整 argv（`argv[0]` 为可执行文件）。经 {@link subprocess} 缝 spawn，
   * 绝不拼成 shell 字符串。
   */
  argv: string[]
  /** 子进程工作目录，兼作 `session/new`/`session/load` 的默认 cwd。 */
  cwd: string
  /**
   * profile 显式环境条目。宿主 subprocess service 负责合并 scrubbed parent env，
   * 因此 PATH/HOME/代理/SSH_AUTH_SOCK 与 CLI 登录 data home 保持原生语义。
   */
  env: Record<string, string>
  /**
 * 子进程 spawn/终止的宿主 seam：`ctx.subprocess` 的结构化窄化产物。
   * 必填——无 seam 即无 ACP 子进程（fail closed，不自制 child_process 回退）。
   */
  subprocess: SubprocessSeam
  /** Legacy argv transform seam; ACP native sessions normally leave this unset. */
  wrapArgv?: (argv: string[]) => string[]
  /** Native spawn plan (argv/env) supplied by the domain session layer. */
  spawnPlan?: AcpSpawnPlanView
}

/** 子进程退出事实。`signal` 用 `string` 以免依赖 @types/node 全局命名空间。 */
export interface AcpProcessExit {
  code: number | null
  signal: string | null
}

/**
 * 子进程生命周期旋钮（原 AcpConnectionOptions 的进程半， 切分；
 * 协议面选项 src/protocol/v1/types.ts 的 `AcpConnectionOptions` 在其上 extends）。
 */
export interface AcpProcessOptions {
  /** 拆除梯子第 1 级：stdin EOF 后的等待窗口（默认见 ./agent-process.ts 的 DEFAULT_EOF_GRACE_MS）。 */
  eofGraceMs?: number
  /** 拆除梯子第 2 级：terminate 的 SIGTERM → SIGKILL 升级间隔，即 spawn spec 的 graceMs（默认见 ./agent-process.ts 的 DEFAULT_TERM_GRACE_MS）。 */
  termGraceMs?: number
  /**
 * 拆除梯子末级：terminate 之后等待整树退出证明的上限（默认见
   * ./agent-process.ts 的 DEFAULT_EXIT_WAIT_MS）。超时 = 内核级异常：经
   * {@link onProcessWarn} 响亮告警后 resolve，不为退出证明挂死 shutdown。
   */
  exitWaitMs?: number
  /**
 * 进程半的告警通道（waitForExit 超预算等内核级异常）；缺省落
   * console.error。宿主侧（AcpAgent/probe）应接结构化 logger。
   */
  onProcessWarn?: (message: string) => void
  /** stderr 环形缓冲行数上限（默认见 ./stderr.ts 的 DEFAULT_STDERR_MAX_LINES）。 */
  stderrMaxLines?: number
  /** stderr 环形缓冲总字节上限（默认见 ./stderr.ts 的 DEFAULT_STDERR_MAX_BYTES）。 */
  stderrMaxBytes?: number
  /** stderr 逐行脱敏钩子（默认见 ./stderr.ts 的 defaultRedactStderrLine）。写入缓冲前应用。 */
  redactStderrLine?: (line: string) => string
}
