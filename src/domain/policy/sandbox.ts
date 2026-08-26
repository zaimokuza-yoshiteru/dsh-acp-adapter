/**
 * ACP 子进程沙箱接入：把 DSH 三档权限映射为平台化 spawn 计划。
 *
 * 输入会话权限模式（dsh SandboxMode 三档）+ 项目工作区 + profile 级持久
 * stateRoot，输出 spawn 计划（{@link AcpSpawnPlan}）：包装后的 argv + 完整
 * 子进程 env。权限映射（DSH 权限语义）：
 *
 * | 档位 | confine policy | env 注入 |
 * |---|---|---|
 * | `read-only` | `{mode:'workspace-write', workspaceRoot:<canonical stateRoot>}` | 状态目录 env 布局指入 stateRoot（项目实质只读、状态持久可续接； 实证 enforcement=full） |
 * | `workspace-write` | `{mode:'workspace-write', workspaceRoot:<canonical 项目>}` | 状态目录 env 布局指入 per-session 目录（默认 `os.tmpdir()` 下 volatile mkdtemp，OS 清理后走 恢复连续性规则 恢复降级；descriptor `sessionStateDir: 'deterministic'` 的 agent——devin——用 tmp 下确定性 per-session-generation 目录，跨重启复用并记入 binding） |
 * | `danger-full-access` | 不 confine | 不注入（agent 用其默认状态位置）；agent.ts 一次性 warn + permission-scope 审计 |
 *
 * 平台化拆分（执行原则 6）：**本模块只描述策略**——三档映射、confine
 * 编排、fail closed、env 白名单透传；一切平台相关路径
 * 解析（macOS 的 XDG 映射位/TMPDIR、Windows 的 APPDATA 系、per-session
 * 临时目录、authPathRefs 落点与安全口径）收进 ./platform/ adapter 目录
 * （类型面 ./platform/types.ts；macOS 与 Windows adapter；staging 机制
 * ./platform/staging.ts），经 {@link AcpSpawnPlanOptions.platform} 注入，
 * 缺省 `createDefaultSandboxPlatform()`（domain/policy 层 process.platform
 * 唯一读取点）。拆分前行为由 test/unit/policy/sandbox.spec.ts 钉死，拆分后逐字节不变。
 *
 * 认证状态注入 auth 路径注入（ 发现， 修复为字节复制；** 改为
 * symlink staging**）：confined 两档的 XDG 重定向使 agent 在**进程启动期**
 * 读不到真实 home 的凭证（devin 的 `~/.local/share/devin/credentials.toml`
 * 随 XDG_DATA_HOME 走， 实证），表现为 probe 模型目录为空、prompt 抛
 * ACP_AUTH_REQUIRED。机制：profile 绑定的 runtime descriptor（边界，
 * src/domain/session/agent-config.ts）声明 XDG 镜像 opaque refs，其 source 清单经
 * {@link AcpSpawnPlanOptions.authPathRefs} 传入（用户配置 schema 不收该字段——
 * 普通 profile 不能构造宿主 path ref，只能绑定内置 descriptor），
 * spawn 前由**宿主进程**（宿主不 confined）把声明文件 **symlink** 进状态
 * 目录的平台映射位（`~/.local/share/X` → `<stateDir>/xdg-data/X`，
 * `.config`/`.cache` 同理；机制与安全口径见 ./platform/staging.ts 模块头
 * 注释）。v1 口径：声明式**单文件** symlink——拒绝目录、symlink/junction
 * 源（lstat 判定）、状态树逃逸（落点父链 realpath 必须留在 canonical 状态
 * 目录内）；同目标链接幂等保留，其余既有落点（普通文件、异目标链接或目录）先
 * 解除再重建；建链失败 fail closed，绝不退回复制（凭证字节绝不落第二处，
 * 登录/登出/token 轮换即时反映）。
 *
 * 安全口径（README 同步）：dsh seatbelt profile 是 allow-default +
 * deny file-write*（reference sandbox-local profiles.ts）——**confine 从不
 * 限制读**，认证状态注入 的机制纯粹是 XDG 重定向让 agent 去重定向后的目录找凭证，
 * 不是 seatbelt 拦读；adapter 无法也不许改 seatbelt profile。写侧钉死：
 * seatbelt 的 deny 落在 symlink 解析后的真实路径上，confined agent 经落点
 * 链接**写**真实凭证被拒（test/unit/policy/sandbox.spec.ts「认证状态注入 写向钉」以真实
 * sandbox-exec 实证，真文件字节不变）——暴露面只有读，而读 expose 与声明
 * 该路径同属 descriptor 登记时的信任决策（这是 authPathRefs 只来自内置
 * runtime descriptor（边界）、不进用户 schema 的原因）。**凭证路径与内容
 * 永不进日志**（错误/warn 只携带声明条目序号与 errno code）。
 *
 * 已知残余偏差（mode 固有语义，面板/文档须如实标注）：confined 两档下
 * `/tmp` 与 `os.tmpdir()` 仍可写（dsh `writableRoots` 的 workspace-write 语义，
 * 不可剔除）；严格"仅状态目录"的自有 SandboxProvider 子类在 backlog（缝 2）。
 * Windows（win32）的 confined 档 enforcement 恒为 `partial`（windows-acl
 * 后端实证事实）——随 `AcpSpawnPlan.platformId` 与 confine 返回值如实透传
 * 审计与 health/设置面板（./platform/windows.ts 模块头注释）。
 *
 * fail closed：confined 两档在 sandbox 能力缺失或 `confine` 抛错时抛出
 * {@link AcpClientError}（kind `sandbox-unavailable`，承载 dsh `SANDBOX_UNAVAILABLE`
 * 语义），绝不静默放行未 confine 的 agent；`danger-full-access` 本就不 confine，
 * 不涉及此路径。
 *
 * 本模块不 import dsh 沙箱包：`ctx.sandbox` 经 {@link AcpSandboxProviderLike}
 * 结构化窄化注入（src/host/composition/registry.ts 对 dsh-settings 的同款手法），包依赖零新增。
 * 接线点见 {@link buildAcpSpawnPlan} 的文档尾注。
 *
 * 本包 tsconfig 用 `types: []`；本文件需要 node fs/path，经 triple-slash
 * reference 显式引入 @types/node（src/protocol/v1/connection.ts 同款先例）。
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/sandbox
 */

/// <reference types="node" />

import fs from 'node:fs'
import path from 'node:path'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import { AcpSpawnPlanError } from './errors.ts'
import { createDefaultSandboxPlatform } from './platform/index.ts'
import { injectStateDir, stageAuthPathRefsOn, stageOpaqueRefsOn } from './platform/staging.ts'
import type { AcpAuthPathRefOptions, AcpOpaqueStagingOptions } from './platform/staging.ts'
import type { AcpSandboxPlatform } from './platform/types.ts'

// 拆分后的兼容 re-export：错误类型与 authPathRefs staging 入口的旧 import
// 路径不变（test/ 与 src/domain/session/agent.ts、src/host/composition/registry.ts 消费）。
// 的确定性会话状态目录选址/复用/清理原语同口径 re-export（agent.ts 消费）。
export { AcpSpawnPlanError } from './errors.ts'
export type { AcpSpawnPlanErrorCode } from './errors.ts'
export { createDeterministicSessionStateDir, ensureDeterministicSessionStateDir, removeDeterministicSessionStateDir } from './platform/staging.ts'
export type { AcpAuthPathRefOptions, AcpOpaqueStagingOptions, AcpOpaqueStagingRef } from './platform/staging.ts'
export type { AcpAuthPathRefRule, AcpSandboxPlatform } from './platform/types.ts'

/** dsh `SandboxMode` 三档的结构镜像（@deepseek-ai/dsh-sandbox 非本包依赖，按分层依赖规则窄化）。 */
export type AcpSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 需要 confine 的两档（dsh `ConfinedSandboxMode` 镜像：排除 `danger-full-access`）。 */
export type AcpConfinedSandboxMode = Exclude<AcpSandboxMode, 'danger-full-access'>

/** dsh `RunnerFailureRule` 的结构镜像：runner 自身失败的 stderr 识别规则。 */
export interface AcpRunnerFailureRule {
  readonly allowedExitCodes?: readonly number[]
  readonly fatalSignatures: readonly string[]
  readonly informationalLines?: readonly string[]
}

/** dsh `ConfinedArgv` 的结构镜像：confine 产物 = 包装 argv + enforcement 事实 + denial/runner-failure 识别方言。 */
export interface AcpConfinedArgv {
  readonly argv: readonly string[]
  readonly enforcement: 'full' | 'partial'
  readonly denialSignatures: readonly string[]
  readonly runnerFailureRules: readonly AcpRunnerFailureRule[]
}

/** dsh `SandboxPolicy` 的结构镜像（`sessionId` 透传；dsh 侧为 branded SessionId，运行时即 string）。 */
export interface AcpSandboxPolicyLike {
  readonly mode: AcpConfinedSandboxMode
  readonly workspaceRoot: string
  readonly sessionId?: string
}

/**
 * `ctx.sandbox` 的消费面（dsh `SandboxProvider` 仅 `confine` 一个抽象方法）。
 * 以 `ctx.get('sandbox')`（或 `static inject = ['sandbox']`）取得活体
 * `LocalSandboxProvider` 后窄化传入；方法参数双变使真实 provider 直接可赋。
 */
export interface AcpSandboxProviderLike {
  confine(argv: readonly string[], policy: AcpSandboxPolicyLike): AcpConfinedArgv
}

/** spawn 计划：spawn 处应用的最终 argv/env + 供诊断与 UI 如实标注的 confine 事实。 */
export interface AcpSpawnPlan {
  /** 最终 argv（confined 档 = `confine` 产物；`danger-full-access` = 原始 argv 拷贝）。 */
  readonly argv: string[]
  /** 完整子进程环境（输入 env + 档位注入；`danger-full-access` = 输入 env 原样拷贝）。 */
  readonly env: Record<string, string>
  /** 生效档位（回显输入）。 */
  readonly mode: AcpSandboxMode
  /** confined 档的 confine 事实（enforcement/denialSignatures/runnerFailureRules 透传）；`danger-full-access` 为 null。 */
  readonly confined: AcpConfinedArgv | null
 /** 实际 confine 的可写 root（canonical 后；`danger-full-access` 为 null）。 用于分轴审计（permission-scope）如实落条。 */
  readonly confinedRoot: string | null
  /**
   * 档位注入的 agent 状态目录：`read-only` = canonical 持久 stateRoot；
 * `workspace-write` = `os.tmpdir()` 下 per-session 目录（边界：descriptor
   * 声明 deterministic 时为跨重启复用的固定名目录，否则 volatile mkdtemp）；
   * `danger-full-access` = null。
   */
  readonly stateDir: string | null
  /**
 * 产出本计划的平台标识（= 解析 adapter 的 `process.platform` 值）。
   * permission-scope 审计随条目落盘——enforcement 事实的平台归属据此可读
   * （win32 恒 partial）。
   */
  readonly platformId: string
}

/**
 * authPathRefs 物化（认证状态注入； 实现下沉 ./platform/staging.ts，本包装仅补
 * 平台缺省值保持旧调用面）：confined 两档 spawn 前由宿主进程把声明的 auth
 * 文件 symlink 进状态目录的平台映射位。安全口径（单文件、拒目录/symlink 源、
 * 防状态树逃逸、零字节复制、路径永不进日志）见 ./platform/staging.ts 模块头注释。
 */
export function stageAuthPathRefs(options: AcpAuthPathRefOptions): void {
  stageAuthPathRefsOn({
    ...options,
    platform: options.platform ?? createDefaultSandboxPlatform(),
  })
}

/**
 * descriptor opaqueRefs 物化（确定性 data home；实现与安全口径见
 * ./platform/staging.ts `stageOpaqueRefsOn`，本包装仅补平台缺省值）：
 * 本地状态 agent（codex/kimi/claude）的凭证/配置 symlink 进确定性 data home。
 */
export function stageOpaqueRefs(options: AcpOpaqueStagingOptions): void {
  stageOpaqueRefsOn({
    ...options,
    platform: options.platform ?? createDefaultSandboxPlatform(),
  })
}

/**
 * 默认宿主环境继承白名单（显式列名，绝不整体继承 dsh 进程环境； 是
 * 全包唯一清单——src/domain/session/agent.ts 原 `MINIMAL_ENV_KEYS` 已并入本常量）：
 * 无证凭的通用键保证 CLI 可定位运行时与配置目录；代理变量（HTTP_PROXY 等）、
 * `SSH_AUTH_SOCK` 等部署相关键不进默认集，由 agent 配置的 inherit 显式放行。
 */
export const ACP_ENV_INHERIT_DEFAULT: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  // Windows 最小集（Node 在 Windows 上归一化环境键大小写）
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
  'USERPROFILE',
]

/**
 * Environment names whose values belong to an Agent's native installation.
 * Native/full-access sessions preserve these values when the user has set
 * them; protected sessions deliberately construct their own redirected values.
 * Only the standard XDG directory homes are included; unrelated XDG flags are
 * not widened into the child environment.
 */
export const ACP_NATIVE_DATA_HOME_ENV_KEYS: readonly string[] = [
  'CODEX_HOME',
  'KIMI_CODE_HOME',
  'CLAUDE_CONFIG_DIR',
]

/** XDG directory homes that are part of an Agent's native configuration. */
export const ACP_NATIVE_XDG_ENV_KEYS: readonly string[] = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
]

export function nativeAgentEnvironmentKeys(source: Readonly<Record<string, string | undefined>>): string[] {
  const keys = new Set<string>(ACP_NATIVE_DATA_HOME_ENV_KEYS)
  for (const key of ACP_NATIVE_XDG_ENV_KEYS) if (source[key] !== undefined) keys.add(key)
  return [...keys]
}

/** {@link buildAcpAgentEnv} 的输入。 */
export interface AcpAgentEnvOptions {
  /** 显式放行的宿主变量名（默认 {@link ACP_ENV_INHERIT_DEFAULT}）。 */
  readonly inherit?: readonly string[]
  /**
   * agent 配置 env（settings `dsh-acp.agents.<id>.env`）：字面值直接通过并可
 * 覆盖继承键（subagent-dsh-sdk 的 explicit-layer-wins 先例）。 本实现
   * 不再有引用语法——值一律按字面透传。
   */
  readonly entries?: Record<string, string>
  /** 宿主环境源（默认 `process.env`；测试注入）。 */
  readonly source?: Record<string, string | undefined>
}

/**
 * 组装子进程环境：显式白名单继承 + 配置条目字面值透传。不整体继承 dsh 进程
 * 环境（凭证引用边界）；本模块不日志、不回显任何值。
 */
export async function buildAcpAgentEnv(options: AcpAgentEnvOptions = {}): Promise<Record<string, string>> {
  const source = options.source ?? process.env
  const env: Record<string, string> = {}
  for (const key of options.inherit ?? ACP_ENV_INHERIT_DEFAULT) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, raw] of Object.entries(options.entries ?? {})) {
    env[key] = raw
  }
  return env
}

/** {@link buildAcpSpawnPlan} 的输入。 */
export interface AcpSpawnPlanOptions {
  /** 会话权限模式（dsh SandboxMode 三档）。 */
  readonly mode: AcpSandboxMode
  /** 项目工作区根（`workspace-write` 档的可写 root；须为已存在的绝对路径，本模块绝不隐式创建项目目录）。 */
  readonly workspaceRoot: string
  /**
   * profile 级持久 stateRoot（`read-only` 档的唯一可写 root，**该档必需**——缺
   * 席即 {@link AcpSpawnPlanError}；其余两档不消费）。不存在时由本模块创建。
   */
  readonly stateRoot?: string
  /** 原始 argv（command + args，结构化，绝无 shell 拼接）。 */
  readonly argv: readonly string[]
  /** 基础子进程环境（{@link buildAcpAgentEnv} 的产物）；本模块按档位叠加状态目录注入。 */
  readonly env: Record<string, string>
  /** 会话 id，透传 `SandboxPolicy.sessionId`（windows-acl 后端的 per-session 授权键；seatbelt 不消费）。 */
  readonly sessionId?: string
  /**
 * 边界：workspace-write 档的确定性 per-session 状态目录（descriptor
   * `sessionStateDir: 'deterministic'` 的 agent 由 ./../session/agent.ts 选址：
   * `os.tmpdir()` 下固定名、0700、canonical）。在场时代替
   * `platform.createSessionStateDir()` 的 volatile mkdtemp——同一 ACP 代际跨
   * 宿主重启复用同一路径（agent 本地会话注册可续接）；缺席 = 旧行为逐字节
   * 不变。仅 workspace-write 档消费；目录必须落在 confine 可写面内
   * （workspaceRoot / 平台 tmp 区），本模块不校验选址正确性（选址纪律在调用方
   * 与 descriptor 注释）。
   */
  readonly sessionStateDir?: string
  /** sandbox 能力（`ctx.sandbox` 窄化）；confined 两档必需，缺失即 fail closed。 */
  readonly sandbox?: AcpSandboxProviderLike | undefined
  /**
 * 认证状态注入 auth 路径注入（数据源为 profile 绑定的 runtime
   * descriptor 的 XDG 镜像 opaque refs）：声明的 auth 文件清单（`~` 展开；
   * 用户配置 schema 不收本字段）。confined 两档在 spawn 前由宿主
   * 物化为状态目录平台映射位的 **symlink**（./platform/staging.ts，机制与
   * 安全口径见其模块头注释）；`danger-full-access` **不消费**（该档 agent 用
   * 默认状态位置，本就可见真实凭证，行为零变化）。未声明/空数组 = 与引入
   * 本字段前逐字节一致。
   */
  readonly authPathRefs?: readonly string[]
  /** 宿主 home：`~` 展开与前缀判定的基准（默认 `os.homedir()`；测试注入）。 */
  readonly homeDir?: string
  /**
   * authPathRefs 源缺失跳过的 warn 通道（默认写 `process.stderr`；cordis logger 由
   * 接线方经此回调接入）。纪律：消息只携带声明条目序号与原因，永不含 auth
   * 路径/内容。
   */
  readonly onWarn?: (message: string) => void
  /**
 * 平台 adapter：状态目录 env 布局、authPathRefs 映射规则、per-session 临时
   * 目录的唯一来源；缺省 `createDefaultSandboxPlatform()`（按 process.platform
   * 解析）。测试注入假 adapter 可离台演练 win32 规则。
   */
  readonly platform?: AcpSandboxPlatform
}

function requireAbsolute(dir: string, what: string): string {
  if (!path.isAbsolute(dir)) {
    throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', `${what} "${dir}" must be an absolute path (session header、sandbox root 与 session/new cwd 共用同一 canonical identity)`)
  }
  return dir
}

/**
 * 创建（幂等）并 canonicalize 目录。dsh `canonicalPath` 语义：enforcement 层
 * 比对 realpath 后的路径，未 canonicalize 的授予会落空（macOS 上 `/tmp` 即
 * `/private/tmp`）；realpath 要求路径已存在，故先 mkdir。
 */
function ensureCanonicalDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync.native(dir)
}

/** 项目工作区必须预先存在：不存在即配置错误（绝不隐式创建用户的项目目录）。 */
function requireExistingCanonicalDir(dir: string, what: string): string {
  requireAbsolute(dir, what)
  if (!fs.existsSync(dir)) {
    throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', `${what} "${dir}" does not exist; refusing to confine against a root whose grant would match nothing`)
  }
  return fs.realpathSync.native(dir)
}

/** confined 档的 fail-closed 判官：能力缺失或 confine 抛错都以 sandbox-unavailable 拒绝，不静默放行。 */
function confineOrThrow(
  sandbox: AcpSandboxProviderLike | undefined,
  argv: readonly string[],
  policy: AcpSandboxPolicyLike,
): AcpConfinedArgv {
  if (sandbox === undefined) {
    throw new AcpClientError(
      'sandbox-unavailable',
      `session permission mode requires process confinement (${policy.mode}), but no sandbox capability (ctx.sandbox) is available on this host; `
      + 'refusing to spawn the ACP agent unconfined — fix the sandbox backend or switch the session to Full Access explicitly',
    )
  }
  try {
    return sandbox.confine(argv, policy)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpClientError(
      'sandbox-unavailable',
      `sandbox confine refused mode "${policy.mode}" (workspaceRoot "${policy.workspaceRoot}"): ${detail}; `
      + 'refusing to spawn the ACP agent unconfined — fix the sandbox backend or switch the session to Full Access explicitly',
      { cause: error },
    )
  }
}

/**
 * 权限映射 三档映射：会话权限模式 → spawn 计划。纯决策 + 目录准备 + 一次 confine，
 * 不 spawn（spawn 是 src/runtime/process/agent-process.ts 的职责，计划经
 * `AcpConnectionSpec.spawnPlan` 传入）。confined 两档 fail closed；各档位的
 * 目录副作用（stateRoot 创建、per-session tmp 目录）先于 confine 完成，
 * 保证授予不落空。平台相关路径解析一律委托平台 adapter
 * （{@link AcpSpawnPlanOptions.platform}；），本函数不拼任何平台路径。
 *
 * 接线落点（本模块被消费的位点，均已接上）：
 * 1. src/domain/session/agent.ts 懒启动处：`ctx.sandboxPolicy` 窄化（{@link AcpSandboxProviderLike}
 *    同款手法）取会话权限模式，`ctx.sandbox`/`dshHomePath`
 *    slot 窄化后喂 {@link buildAcpAgentEnv} + {@link buildAcpSpawnPlan}，spec 携
 *    `spawnPlan`；会话档 stateRoot = `dshHomePath('dsh-acp','state',<agentId>)`；
 *    profile 绑定的 descriptor 声明的 XDG 镜像 opaque refs 随计划传入
 * （认证状态注入 auth 路径 symlink staging，descriptor 驱动）。
 * 2. src/host/composition/registry.ts probe 同档 confine（read-only；probeRoot =
 *    `dshHomePath('dsh-acp','probe',<agentId>)`），经 llm-stub 的 `confineProbe`
 *    插口；同一份 descriptor refs 同档注入（probe 也读登录态——否则模型目录为空）。
 * 3. （模式展示）后 danger 档不再产出任何确认标记位：Full Access 确认只剩
 *    DSH 宿主原生一层；host 侧保留一次性 spawn warn（agent.ts）与每次 spawn
 *    重新解析本模块的钉（permission-mode-matrix.spec.ts）。
 */
export function buildAcpSpawnPlan(options: AcpSpawnPlanOptions): AcpSpawnPlan {
  if (options.argv.length === 0) {
    throw new AcpSpawnPlanError('ACP_SPAWN_CONFIG', 'spawn plan requires a non-empty argv (argv[0] is the executable)')
  }
  const platform = options.platform ?? createDefaultSandboxPlatform()
  const sessionPolicy = options.sessionId === undefined ? {} : { sessionId: options.sessionId }
  // 认证状态注入 auth 路径 staging：confined 两档 spawn 前 symlink 进状态目录（状态
  // 准备与状态目录 env 注入同段完成，先于 confine）；未声明/空数组 = 零行为
  // 变化；danger-full-access 不消费本字段。
  const stageRefs = (stateDir: string): void => {
    if (options.authPathRefs === undefined || options.authPathRefs.length === 0) return
    stageAuthPathRefsOn({
      paths: options.authPathRefs,
      stateDir,
      platform,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    })
  }
  switch (options.mode) {
    case 'danger-full-access':
 // 不 confine、不注入状态目录（agent 用其默认位置）；（模式展示）不再产出确认标记位
      return {
        argv: [...options.argv],
        env: { ...options.env },
        mode: options.mode,
        confined: null,
        confinedRoot: null,
        stateDir: null,
        platformId: platform.platformId,
      }
    case 'read-only': {
 // 缝 1（实证）：workspaceRoot 重指 profile 级持久 stateRoot →
      // 项目实质只读 + agent 状态可写持久。残余偏差：/tmp 与 os.tmpdir 仍可写。
      if (options.stateRoot === undefined) {
        throw new AcpSpawnPlanError(
          'ACP_SPAWN_CONFIG',
          'read-only mode requires a persistent stateRoot (the dshHomePath slot is absent, so none could be resolved); refusing to spawn the ACP agent without a writable state home',
        )
      }
      const stateRoot = ensureCanonicalDir(requireAbsolute(options.stateRoot, 'stateRoot'))
      const env = injectStateDir(platform, options.env, stateRoot)
      stageRefs(stateRoot)
      const confined = confineOrThrow(options.sandbox, options.argv, { mode: 'workspace-write', workspaceRoot: stateRoot, ...sessionPolicy })
      return {
        argv: [...confined.argv],
        env,
        mode: options.mode,
        confined,
        confinedRoot: stateRoot,
        stateDir: stateRoot,
        platformId: platform.platformId,
      }
    }
    case 'workspace-write': {
      const workspaceRoot = requireExistingCanonicalDir(options.workspaceRoot, 'workspaceRoot')
 // 边界：descriptor 声明确定性会话状态目录的 agent 用调用方选址（跨重启
      // 复用，binding 记录）；否则 volatile mkdtemp（恢复连续性规则 恢复降级语义不变）。
      const stateDir = options.sessionStateDir === undefined
        ? platform.createSessionStateDir()
        : ensureCanonicalDir(requireAbsolute(options.sessionStateDir, 'sessionStateDir'))
      const env = injectStateDir(platform, options.env, stateDir)
      stageRefs(stateDir)
      const confined = confineOrThrow(options.sandbox, options.argv, { mode: 'workspace-write', workspaceRoot, ...sessionPolicy })
      return {
        argv: [...confined.argv],
        env,
        mode: options.mode,
        confined,
        confinedRoot: workspaceRoot,
        stateDir,
        platformId: platform.platformId,
      }
    }
  }
}
