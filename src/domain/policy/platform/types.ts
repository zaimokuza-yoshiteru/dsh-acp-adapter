/**
 * sandbox 平台 adapter 的类型面：业务层不散落
 * `process.platform` 分支，平台差异收进本目录）。
 *
 * sandbox 策略层（../sandbox.ts）只做纯策略：三档映射、confine 编排、
 * fail closed；**平台相关的路径解析**——状态目录 env 布局（macOS 的
 * XDG 三件套 + TMPDIR / Windows 的 APPDATA 系）、per-session 临时状态
 * 目录、authPathRefs 落点规则——全部经 {@link AcpSandboxPlatform} 供给。
 * 生产默认实例由 ./index.ts 的 `createDefaultSandboxPlatform` 按
 * `process.platform` 一次选定（本目录是 domain/policy 层该值的唯一读取点）。
 *
 * 实现成员：
 * - ./macos.ts   XDG/POSIX adapter——v1 认证平台（darwin；Linux 同 XDG 语义
 *   复用本 adapter，但不在当前支持声明内）；承载 XDG state/authPathRefs
 *   staging 规则。
 * - ./windows.ts Windows adapter——接口 + 已知公开规则先行（%APPDATA% /
 *   %LOCALAPPDATA%；enforcement 恒为 partial）；Devin 凭据落点等仍未完成
 *   Windows 真机验证，因此当前不宣称 Windows 支持。
 * - ./staging.ts 平台无关的 authPathRefs 物化机制（symlink staging + 安全口径），
 *   规则数据来自 adapter——安全收紧只写一次，不在各 adapter 重复实现。
 *
 * 纯类型模块：不 import 任何包内模块（types 叶子的既有纪律，见
 * src/runtime/process/types.ts 头注释先例）。
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/platform/types
 */

/// <reference types="node" />

import type * as path from 'node:path'

/**
 * authPathRefs 前缀规则：声明条目（`~` 展开 + normalize 后）必须命中本表其一
 * 才有 symlink 落点，否则 fail loud——绝不猜映射位置（胡乱映射会把宿主文件
 * 铺到 agent 找不着的地方，且放宽面不可审）。三个规则互不含摄，首个命中即唯一
 * 答案。
 */
export interface AcpAuthPathRefRule {
  /** home 相对前缀（书写用 `/` 分隔，匹配前经平台 paths 归一；macOS 三件套 `.local/share`/`.config`/`.cache`）。 */
  readonly homeRelativePrefix: string
  /** symlink 落点在状态目录下的子目录名（macOS：`xdg-data`/`xdg-config`/`xdg-cache`）。 */
  readonly mirrorSubdir: string
}

/**
 * sandbox spawn 计划的平台 adapter：策略层（../sandbox.ts
 * `buildAcpSpawnPlan`）经它解析一切平台路径，自身不拼任何平台路径。
 * 实现是纯数据 + 一个建目录原语，测试可直接注入假 adapter。
 */
export interface AcpSandboxPlatform {
  /**
   * 平台标识（= 解析时的 `process.platform` 值；darwin/win32/…）。随
   * `AcpSpawnPlan.platformId` 落 permission-scope 审计与诊断——enforcement
   * 事实的平台归属据此可读（win32 恒 partial）。
   */
  readonly platformId: string
  /**
   * 状态目录的 env 注入布局：`[env 键, stateDir 下子目录名]` 有序对。注入时
   * 逐键建目录并覆盖 env（./staging.ts `injectStateDir` 执行）；**键集本身
   * 就是平台事实**——macOS 注 XDG 三件套 + TMPDIR；Windows 注 APPDATA 系、
   * 不注 TMP/TEMP（windows-acl runner 以 SetEnvironmentVariableW 重写它们到
   * per-session 私有目录，以 runner 为准，本层不铺第二层真源）。
   */
  readonly stateDirEnvLayout: ReadonlyArray<readonly [envKey: string, subdir: string]>
  /** authPathRefs 前缀规则表（见 {@link AcpAuthPathRefRule}）。 */
  readonly authPathRefRules: readonly AcpAuthPathRefRule[]
  /**
   * 前缀不命中时错误文案的平台位描述（**不含具体声明路径**——auth 路径永不
   * 进日志的纪律适用于此）；macOS 为 `XDG home equivalents (~/.local/share, …)`。
   */
  readonly authPathRefHomeDescription: string
  /**
   * 前缀匹配是否大小写不敏感。win32 = true（NTFS 默认语义，公开知识）；
   * POSIX = false（逐字节）。win32 匹配行为尚未在真机验证。
   */
  readonly pathsCaseInsensitive: boolean
  /**
   * 路径运算模块：macOS = `path.posix`（darwin/linux 上即原生 `path`），
   * Windows = `path.win32`（真实 Windows 上即原生）。映射因此是纯字符串运算、
   * 与运行平台解耦——win32 规则可在非 Windows 机器上单测；fs 副作用（建目录/
   * 复制/realpath 校验）只在真实目标平台上发生。
   */
  readonly paths: Pick<typeof path.posix, 'join' | 'normalize' | 'relative' | 'dirname' | 'sep'>
  /**
   * confined 档在本平台的 enforcement 预期：透传宿主 sandbox 后端的静态声明
   * （dsh sandbox-local 的 STATIC_ENFORCEMENT 表：seatbelt/bwrap = full，
   * windows-acl 恒 partial——reference/deepseek-harness/packages/sandbox/
   * sandbox-local/src/index.ts，钉版对拍口径）。health 端点与设置面板据此
   * 如实标注；实际每次 spawn 的 confine 返回值仍以 `AcpConfinedArgv.enforcement`
   * 为准落审计（本字段是预期标注，不替代逐次事实）。
   */
  readonly enforcementExpectation: 'full' | 'partial'
  /** partial 档的已知残余风险文案（随 health 事实透传给设置面板；full 时为 null）。 */
  readonly enforcementNote: string | null
  /**
   * per-session volatile 状态目录（workspace-write 档）：创建并 canonicalize
   * 后返回（`os.tmpdir()` 下 mkdtemp；OS 清理后走 恢复连续性规则 恢复降级）。
   */
  createSessionStateDir(): string
}
