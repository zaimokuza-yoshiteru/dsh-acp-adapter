/**
 * authPathRefs 物化（symlink staging）与状态目录注入的**平台无关机制**
 * （自 sandbox.ts 切出； 由「字节复制」改为「symlink」）。路径规则
 * （前缀表、env 布局、大小写语义、路径运算）全部来自
 * {@link AcpSandboxPlatform}（./types.ts），本模块把安全口径只写一次、只在
 * 一处：
 *
 * 声明式**单文件** symlink（的完整口径）：
 * 1. 源必须是常规文件本身——`lstat` 判定（**不跟随**）：symlink/junction
 *    一概 {@link AcpSpawnPlanError} fail loud（跟随链接会把映射语义穿透到
 *    链接目标）；目录（含前缀目录本身）同样 fail loud（v1 不做目录递归映
 *    射）。中间父目录是链接不在 v1 判定范围（读侧放宽与 seatbelt
 *    allow-default 读口径一致，声明审查面以 leaf 判定为准）。
 * 2. 源缺失（ENOENT）→ warn 后跳过该条、spawn 继续——登录缺失由
 *    probe/ACP_AUTH_REQUIRED 诚实暴露。
 * 3. **状态树防线**（落点不得指回 stateDir 之外的写入路径）：confined agent
 *    可写状态目录，若落点父链被种入指向 stateDir 之外的 symlink，落点本身
 *    会落到状态树外。staging 前先验父链 realpath 落在 canonical stateDir
 *    内，越界即 fail loud；已存在的落点若是同目标 symlink 则原样保留
 *    （幂等），其余既有落点（普通文件、异目标 symlink、目录）
 *    先整体解除再重建。解除—建链之间存在 TOCTOU 窗口（本地竞态，对手是已
 *    可读真实凭证的 confined agent），v1 接受预写检查并在此声明。
 * 4. 落点为 `<stateDir>/<mirrorSubdir>/<前缀下相对路径>` 的 symlink，
 *    **指向真实宿主源文件**——零字节复制：登录/登出/token 轮换即时反映到
 *    每个新 spawn（read-only 档持久 stateRoot 与 workspace-write 档
 *    per-session 目录同机制）。symlink 无独立权限位语义，源文件的权限位即
 *    事实；不铺 0600 副本那条防线。
 *
 * symlink 而非 copy（裁决）：复制会让登出/轮换后的会话继续读到陈旧
 * 凭证（「幽灵登录」），且凭证字节被铺进第二个位置。写侧安全钉：seatbelt
 * 的 deny file-write* 落在 symlink 解析后的真实路径上，confined agent 经落点
 * 链接写真实凭证被拒（test/unit/policy/sandbox.spec.ts「认证状态注入 写向钉」真实 sandbox-exec
 * 实证）；暴露面因此只有读——读 expose 与「把凭证路径声明进 descriptor」同属
 * descriptor 登记时的信任决策，authPathRefs 因此只能来自内置 runtime
 * descriptor（边界，按 `runtime` 字段或 agent id 绑定），用户配置 schema
 * 不收该字段。
 *
 * 纪律：auth 路径与内容永不进日志——抛错与 warn 只引用声明条目序号
 * （`authPathRefs entry #N`）与 errno code，不引用路径本身。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/platform/staging
 */

/// <reference types="node" />

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AcpSpawnPlanError } from '../errors.ts'
import type { AcpSandboxPlatform } from './types.ts'

/** {@link stageAuthPathRefsOn} 的输入（../sandbox.ts 经 re-export 保持旧面）。 */
export interface AcpAuthPathRefOptions {
  /** 内置模板声明的 auth 文件路径（`~`/`~/` 前缀展开为宿主 home；v1 限平台 adapter 映射规则下的文件）。 */
  readonly paths: readonly string[]
  /** 重定向后的状态根（落 `<stateDir>/<mirrorSubdir>/…`；不存在时由本机制补建）。 */
  readonly stateDir: string
  /** 宿主 home：`~` 展开与前缀判定的基准（默认 `os.homedir()`；测试注入）。 */
  readonly homeDir?: string
  /** 源缺失跳过的 warn 通道（默认写 `process.stderr`）；消息永不含 auth 路径/内容。 */
  readonly onWarn?: (message: string) => void
  /** 平台 adapter（缺省由调用方按 `process.platform` 解析——sandbox.ts 的 re-export 包装负责）。 */
  readonly platform?: AcpSandboxPlatform
}

/** 一条声明的映射解析产物（纯字符串运算，经平台 paths 模块——win32 规则可在非 Windows 上单测）。 */
export interface AcpAuthPathRefResolution {
  /** 展开 + normalize 后的宿主侧源路径（平台形式）。 */
  readonly source: string
  /** symlink 落点：`<stateDir>/<mirrorSubdir>/<前缀下相对路径>`。 */
  readonly target: string
}

/** 源缺失 warn 的默认通道：本层不持 cordis logger，写 stderr 保底（宿主模块实例一致性 的观测盲区教训：warn 必须落在可看之处）。 */
function defaultAuthPathRefWarn(message: string): void {
  process.stderr.write(`dsh-acp: ${message}\n`)
}

// 状态树目录统一收紧到 0700（目录级兜底）。chmod 失败
// （并发回收等导致目录已消失）不阻断 staging。Windows 的 mode 位语义尚未
// 真机验证；Node 在 win32 只识别只读位，0700 不会把目录收成只读。
function chmod0700(dir: string): void {
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* 目录可能刚被并发回收；权限收紧失败不阻断 staging */
  }
}

// 把 leaf 到 stopAt（含）的整条目录链收紧到 0700——recursive mkdir 的中间层吃
// umask，必须逐层补。调用方保证 leaf 位于 stopAt 之下；防御性前缀检查防失控上爬
// （绝不碰 stopAt 之上的用户目录）。
function chmodChain0700(leaf: string, stopAt: string): void {
  let dir = leaf
  for (;;) {
    chmod0700(dir)
    if (dir === stopAt) return
    const parent = path.dirname(dir)
    if (parent === dir || (parent !== stopAt && !parent.startsWith(stopAt + path.sep))) return
    dir = parent
  }
}

/**
 * 声明条目 → symlink 落点的纯解析（无 fs 副作用）：`~`/`~/` 展开为宿主 home
 * （`~user` 形式不支持——展开后必然落不进映射前缀，按前缀不命中 fail
 * loud），normalize 后须命中平台映射规则表其一，否则
 * {@link AcpSpawnPlanError}（ACP_SPAWN_CONFIG）fail loud。
 */
export function resolveAuthPathRefTarget(options: {
  readonly platform: AcpSandboxPlatform
  readonly declared: string
  /** 日志/错误的条目标签（`authPathRefs entry #N`；由调用方按序号构造）。 */
  readonly label: string
  readonly homeDir: string
  readonly stateDir: string
}): AcpAuthPathRefResolution {
  const { platform, declared, label, homeDir, stateDir } = options
  const paths = platform.paths
  const expanded = declared === '~' || declared.startsWith('~/') ? paths.join(homeDir, declared.slice(1)) : declared
  const source = paths.normalize(expanded)
  const fold = (value: string): string => (platform.pathsCaseInsensitive ? value.toLowerCase() : value)
  const match = platform.authPathRefRules
    .map((rule) => ({ prefix: paths.normalize(paths.join(homeDir, rule.homeRelativePrefix)), mirrorSubdir: rule.mirrorSubdir }))
    .find((candidate) => {
      const sourceKey = fold(source)
      const prefixKey = fold(candidate.prefix)
      return sourceKey === prefixKey || sourceKey.startsWith(prefixKey + paths.sep)
    })
  if (match === undefined) {
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      `${label} must resolve to a file under one of the ${platform.authPathRefHomeDescription} `
      + 'after ~ expansion; refusing to guess a staging location',
    )
  }
  return { source, target: paths.join(stateDir, match.mirrorSubdir, paths.relative(match.prefix, source)) }
}

/**
 * 单条 symlink 物化的共享段（authPathRefs 与 opaqueRefs 同机制、同防线）：
 * lstat 源校验（防线 1）→ 父链 mkdir + 0700 收紧 → 父链 realpath 防线（防线 3a）
 * → 既有落点处置（防线 3b：同目标幂等/异目标解除重建）→ 建链失败 fail closed。
 * 源缺失（ENOENT）按 `missing` 策略：warn = warn 后跳过（authPathRefs 既有行为 /
 * 非 optional opaque ref）；silent = 静默跳过（optional opaque ref——
 * descriptor 声明了「缺省可用」，不值得吵）。抛错/warn 只带条目标签与 errno
 * code，路径永不进日志（模块头纪律）。
 */
function stageSymlinkEntry(options: {
  readonly label: string
  readonly source: string
  readonly target: string
  /** 父链 0700 收紧的上界（chmodChain0700 的 stopAt）。 */
  readonly root: string
  /** 防线 3a 的 canonical 基准（root 的 realpath）。 */
  readonly canonicalRoot: string
  readonly paths: AcpSandboxPlatform['paths']
  readonly missing: 'warn' | 'silent'
  readonly warn: (message: string) => void
}): void {
  const { label, source, target, root, canonicalRoot, paths, warn } = options
  let stat: fs.Stats
  try {
    // lstat 而非 stat（防线 1）：声明的必须是常规文件本身，symlink/junction
    // 不跟随、一概拒绝。
    stat = fs.lstatSync(source)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.missing === 'warn') {
        warn(
          `${label} does not exist on this host; skipping its symlink — `
          + 'the agent will surface the missing login honestly (probe failure / ACP_AUTH_REQUIRED)',
        )
      }
      return
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      `${label} must name a regular file, not a symlink/junction; refusing to follow links while staging auth paths (declare the concrete file)`,
    )
  }
  if (!stat.isFile()) {
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      `${label} must name a regular file; v1 does not stage directories (declare the concrete file instead)`,
    )
  }
  const parent = paths.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
 // recursive mkdir 的中间层吃 umask，父链逐层补 0700（到 root 止）。
  chmodChain0700(parent, root)
  // 防线 3a：父链 realpath 必须留在 canonical root 内（状态树里的链接
  // 不得把落点指到真实 home / 任何 root 之外）。
  const realParent = fs.realpathSync.native(parent)
  if (realParent !== canonicalRoot && !realParent.startsWith(canonicalRoot + path.sep)) {
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      `${label} staging target escapes the session state directory (a link in the state tree would place it outside); refusing to stage the auth path ref`,
    )
  }
  // 防线 3b：既有落点处置——同目标 symlink 幂等保留；其余（普通文件、异目标
  // symlink、目录）整体解除后重建。
  let existing: fs.Stats | undefined
  try {
    existing = fs.lstatSync(target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(target) === source) return // 幂等：同目标链接在位
      } catch (error: unknown) {
        // 竞态：落点在 lstat 与 readlink 之间被拆除——落入下方解除重建路径
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    fs.rmSync(target, { recursive: true, force: true })
  }
  try {
    fs.symlinkSync(source, target)
  } catch (error: unknown) {
    // 建链失败（EPERM/EEXIST 竞态等）：fail closed，绝不退回复制——消息只带
    // 条目标签与 errno code，路径永不进日志。
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      `${label} could not be staged as a symlink (${code}); refusing to fall back to copying credential bytes`,
    )
  }
}

/**
 * authPathRefs 物化（机制与安全口径见模块头注释）：spawn 前由宿主进程把声明的
 * auth 文件逐一 symlink 进状态目录的平台映射位。fs 副作用只在真实目标平台上
 * 发生。Windows adapter 的物化路径尚未真机验证；机制与防线和 macOS 共用，
 * 但 Windows 的 symlink 特权仍属于平台限制。
 */
export function stageAuthPathRefsOn(options: AcpAuthPathRefOptions & { platform: AcpSandboxPlatform }): void {
  const { platform } = options
  const home = options.homeDir ?? os.homedir()
  const warn = options.onWarn ?? defaultAuthPathRefWarn
  // 状态根先建并 canonicalize：父链 realpath 校验（防线 3）的基准；幂等
  // mkdir 保持旧行为（旧实现经 mkdirSync(dirname(target)) 隐式创建）。
  fs.mkdirSync(options.stateDir, { recursive: true })
  chmod0700(options.stateDir)
  const canonicalStateDir = fs.realpathSync.native(options.stateDir)
  options.paths.forEach((declared, index) => {
    const label = `authPathRefs entry #${String(index + 1)}`
    const { source, target } = resolveAuthPathRefTarget({
      platform,
      declared,
      label,
      homeDir: home,
      stateDir: options.stateDir,
    })
    stageSymlinkEntry({
      label,
      source,
      target,
      root: options.stateDir,
      canonicalRoot: canonicalStateDir,
      paths: platform.paths,
      missing: 'warn',
      warn,
    })
  })
}

/**
 * 状态目录 env 注入：按平台布局逐键建目录并覆盖 env 值（返回新对象，不改
 * 输入）。macOS 布局 = XDG 三件套 + TMPDIR（实证形态）。
 */
export function injectStateDir(
  platform: AcpSandboxPlatform,
  env: Record<string, string>,
  stateDir: string,
): Record<string, string> {
  const next = { ...env }
  for (const [key, sub] of platform.stateDirEnvLayout) {
    const dir = platform.paths.join(stateDir, sub)
    fs.mkdirSync(dir, { recursive: true })
 // 同 staging 父链——recursive mkdir 中间层逐层补 0700（到 stateDir 止）。
    chmodChain0700(dir, stateDir)
    next[key] = dir
  }
  return next
}

/**
 * per-session volatile 状态目录（workspace-write 档）：`os.tmpdir()` 下
 * mkdtemp + canonicalize。dsh `canonicalPath` 语义：enforcement 层比对
 * realpath 后的路径（macOS 上 `/tmp` 即 `/private/tmp`）。
 */
export function createSessionStateDir(prefix: string): string {
 // mkdtemp 自建目录已是 0700；realpath 后显式 chmod 兜底（防平台差异）。
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  chmod0700(dir)
  return dir
}

/** 确定性会话状态目录的名字空间（`os.tmpdir()` 下的固定前缀；删除校验共用）。 */
const DETERMINISTIC_SESSION_STATE_PREFIX = 'dsh-acp-state-'

/**
 * 确定性 per-session 状态目录（workspace-write 档、descriptor
 * `sessionStateDir: 'deterministic'` 的 agent）：`os.tmpdir()` 下固定名
 * `dsh-acp-state-<sanitized identity>`（identity = `<profileId>-<sessionId>-<generation>`），
 * 同一会话同一代际跨宿主重启恒得同一路径——resume 经 binding 记录复用。
 * 幂等：目录在（resume）则复用并补 0700；被 OS 清掉则重建空目录（agent 侧的
 * 会话缺失由 list/load 的既有 fail-loud 对账诚实暴露）。返回 canonical 路径。
 * 仍在 tmp 而不在 dshHome 的原因见 agent-config.ts 的 `sessionStateDir` 注释
 * （confine 公开 policy 的可写面只有 workspaceRoot + 平台 tmp 区）。
 */
export function createDeterministicSessionStateDir(identity: string): string {
  // 目录名只留安全字符（session id 形态是 session-<uuid>，此处纵深防御）+ 有界长度
  const safe = identity.replaceAll(/[^a-zA-Z0-9-]/g, '_').slice(0, 120)
  const dir = path.join(os.tmpdir(), `${DETERMINISTIC_SESSION_STATE_PREFIX}${safe}`)
  fs.mkdirSync(dir, { recursive: true })
  chmod0700(dir)
  return fs.realpathSync.native(dir)
}

/**
 * resume 复用径：binding 记录的确定性会话状态目录在使用前先过形态校验
 * （必须是 `<canonical tmpdir>/dsh-acp-state-*` 的直系子目录——binding 损坏/篡改
 * 不得变成任意位置的 mkdir/chmod 原语），校验不过即 {@link AcpSpawnPlanError}
 * fail loud；通过则幂等建目录（被 OS 清掉时重建空目录，agent 侧的会话缺失由
 * list/load 的既有 fail-loud 对账诚实暴露）+ 0700 + canonicalize 返回。
 */
export function ensureDeterministicSessionStateDir(dir: string): string {
  const normalized = path.normalize(dir)
  let canonicalTmp: string
  try {
    canonicalTmp = fs.realpathSync.native(os.tmpdir())
  } catch {
    canonicalTmp = os.tmpdir()
  }
  if (path.dirname(normalized) !== canonicalTmp || !path.basename(normalized).startsWith(DETERMINISTIC_SESSION_STATE_PREFIX)) {
    throw new AcpSpawnPlanError(
      'ACP_SPAWN_CONFIG',
      'the bound session state directory is not under the deterministic session-state namespace; refusing to reuse it (binding record is suspect)',
    )
  }
  fs.mkdirSync(normalized, { recursive: true })
  chmod0700(normalized)
  return fs.realpathSync.native(normalized)
}

/**
 * 超龄代际清理（rebindBlank 显式放弃旧代际时调用）：整删确定性会话
 * 状态目录。**形态校验先于一切 fs 副作用** 只有 `<canonical tmpdir>/
 * dsh-acp-state-*` 形态的路径可删——binding 里的路径落 rm 之前必须证明它
 * 是本机制产出的目录（sidecar 损坏/篡改不得变成任意目录删除原语）。校验
 * 不过或删除失败都返回 false（调用方 warn），绝不抛出。
 */
export function removeDeterministicSessionStateDir(dir: string): boolean {
  try {
    const canonicalTmp = fs.realpathSync.native(os.tmpdir())
    const parent = fs.realpathSync.native(path.dirname(dir))
    if (parent !== canonicalTmp) return false
    if (!path.basename(dir).startsWith(DETERMINISTIC_SESSION_STATE_PREFIX)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// ---------- 确定性 data home：opaque refs → 确定性 data home 的 symlink 物化 ----------

/**
 * opaque staging 条目（descriptor opaqueRef 的本地镜像——结构与
 * src/domain/session/agent-config.ts `AcpAgentOpaqueRef` 的 staging 相关子集
 * 逐字段一致；本地定义是因为本模块（domain/policy/platform）不向上 import
 * domain/session，分层守卫禁止）。
 */
export interface AcpOpaqueStagingRef {
  /** 宿主侧源（`~`/`~/` 前缀展开为宿主 home；normalize 后使用）。 */
  readonly source: string
  /** 落进 data home 下的相对路径（normalize 后必须是相对路径且不逃逸）。 */
  readonly targetRelative: string
  /** true = 源缺失静默跳过；false = 源缺失 warn 后跳过（同 authPathRefs 口径）。 */
  readonly optional: boolean
}

/** {@link stageOpaqueRefsOn} 的输入。 */
export interface AcpOpaqueStagingOptions {
  readonly refs: readonly AcpOpaqueStagingRef[]
  /**
 * 确定性 data home（选址：<dshHome>/dsh-acp/agent-data/<profileId>/
   * <sessionId>/<generation>，或 resume 复用的既有路径；probe 场景 = disposable
   * run 目录）。落点为 `<dataHome>/<targetRelative>` 的 symlink。
   */
  readonly dataHome: string
  /** 宿主 home：`~` 展开的基准（默认 `os.homedir()`；测试注入）。 */
  readonly homeDir?: string
  /** 非 optional 源缺失的 warn 通道（默认写 `process.stderr`）；消息永不含路径/内容。 */
  readonly onWarn?: (message: string) => void
  /** 平台 adapter（缺省由调用方按 `process.platform` 解析——sandbox.ts 的包装负责）。 */
  readonly platform?: AcpSandboxPlatform
}

/**
 * descriptor opaqueRefs 物化（确定性 data home）：与 authPathRefs **同机制**（声明式
 * 单文件 symlink、lstat 防线、父链 realpath 防线、幂等/重建、fail closed 建链，
 * 全部经共享的 stageSymlinkEntry），差别只在落点解析：不经 XDG 前缀规则表，
 * 直接落 `<dataHome>/<targetRelative>`（本地状态 agent 的 `~/.codex` 等源路径
 * 不在 XDG 前缀表内）。`targetRelative` normalize 后必须仍是相对路径且不向
 * 上逃逸，否则 {@link AcpSpawnPlanError} fail loud——descriptor 是内置受信数据，
 * 这属于防线而非用户输入校验。
 */
export function stageOpaqueRefsOn(options: AcpOpaqueStagingOptions & { platform: AcpSandboxPlatform }): void {
  const { platform } = options
  const paths = platform.paths
  const home = options.homeDir ?? os.homedir()
  const warn = options.onWarn ?? defaultAuthPathRefWarn
  // data home 先建并 canonicalize：父链 realpath 防线的基准。
  fs.mkdirSync(options.dataHome, { recursive: true })
  chmod0700(options.dataHome)
  const canonicalDataHome = fs.realpathSync.native(options.dataHome)
  options.refs.forEach((ref, index) => {
    const label = `opaqueRefs entry #${String(index + 1)}`
    const expanded = ref.source === '~' || ref.source.startsWith('~/') ? paths.join(home, ref.source.slice(1)) : ref.source
    const source = paths.normalize(expanded)
    const targetRelative = paths.normalize(ref.targetRelative)
    // paths 模块无 isAbsolute（Pick 面见 platform/types.ts）——按平台形式判定：
    // 以 sep 开头（posix 绝对 / win32 根相对）、win32 驱动器绝对、UNC。
    const absolute =
      targetRelative.startsWith(paths.sep)
      || /^[A-Za-z]:[\\/]/.test(targetRelative)
      || targetRelative.startsWith('\\\\')
    if (absolute || targetRelative === '..' || targetRelative.startsWith(`..${paths.sep}`) || targetRelative.length === 0) {
      throw new AcpSpawnPlanError(
        'ACP_SPAWN_CONFIG',
        `${label} targetRelative must stay inside the agent data home; refusing to stage outside it`,
      )
    }
    stageSymlinkEntry({
      label,
      source,
      target: paths.join(options.dataHome, targetRelative),
      root: options.dataHome,
      canonicalRoot: canonicalDataHome,
      paths,
      missing: ref.optional ? 'silent' : 'warn',
      warn,
    })
  })
}
