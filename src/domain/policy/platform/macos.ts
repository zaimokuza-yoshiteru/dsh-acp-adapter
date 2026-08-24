/**
 * macOS（XDG/POSIX）sandbox 平台 adapter：原 sandbox.ts 的 XDG
 * state/authPathRefs staging 规则**原样迁入**，行为与拆分前逐字节一致
 * （test/unit/policy/sandbox.spec.ts 钉死）：
 *
 * - 状态目录 env 布局 = XDG 三件套（`xdg-data`/`xdg-config`/`xdg-cache`
 * 子目录）+ `TMPDIR`（`tmp` 子目录）， 实证形态；
 * - authPathRefs 前缀 = `~/.local/share` / `~/.config` / `~/.cache` → 对应
 *   xdg 子目录（v1 仅支持这三个前缀——auth 路径必须落在 XDG home
 *   等价位，才能被重定向后的 XDG 三件套语义覆盖）；
 * - per-session 状态目录前缀 `dsh-acp-`（`os.tmpdir()` 下，供 OS 清理与
 *   运维识别）。
 *
 * Linux 等其余 POSIX 平台同 XDG 语义复用本 adapter（`platformId` 如实携带
 * 实际平台值）——darwin 是 v1 认证平台，linux 未认证（dsh 侧后端为
 * bwrap/landlock，enforcement 预期仍按 full 标注——seatbelt/bwrap 在
 * STATIC_ENFORCEMENT 同为 full；landlock 的 per-ABI-partial 由宿主逐次
 * confine 返回值落审计，与本静态预期正交）。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/platform/macos
 */

/// <reference types="node" />

import path from 'node:path'
import { createSessionStateDir } from './staging.ts'
import type { AcpAuthPathRefRule, AcpSandboxPlatform } from './types.ts'

/** XDG 三件套 + TMPDIR 在状态目录下的注入布局（顺序即旧 injectStateDir 的建目录序）。 */
const XDG_STATE_DIR_ENV_LAYOUT: ReadonlyArray<readonly [envKey: string, subdir: string]> = [
  ['XDG_DATA_HOME', 'xdg-data'],
  ['XDG_CONFIG_HOME', 'xdg-config'],
  ['XDG_CACHE_HOME', 'xdg-cache'],
  ['TMPDIR', 'tmp'],
]

/** XDG home 等价前缀 → 状态目录子目录的映射规则（互不含摄，首个命中即唯一答案）。 */
const XDG_AUTH_PATH_REF_RULES: readonly AcpAuthPathRefRule[] = [
  { homeRelativePrefix: '.local/share', mirrorSubdir: 'xdg-data' },
  { homeRelativePrefix: '.config', mirrorSubdir: 'xdg-config' },
  { homeRelativePrefix: '.cache', mirrorSubdir: 'xdg-cache' },
]

/** workspace-write 档 per-session 状态目录的 mkdtemp 前缀（`os.tmpdir()` 下，供 OS 清理与运维识别）。 */
const SESSION_STATE_PREFIX = 'dsh-acp-'

/**
 * XDG/POSIX 平台 adapter。`platformId` 如实携带调用时的平台值（默认 darwin；
 * linux 复用时传 'linux'）——审计透传用，不改变规则。
 */
export function createXdgSandboxPlatform(platformId: string = 'darwin'): AcpSandboxPlatform {
  return {
    platformId,
    stateDirEnvLayout: XDG_STATE_DIR_ENV_LAYOUT,
    authPathRefRules: XDG_AUTH_PATH_REF_RULES,
    authPathRefHomeDescription: 'XDG home equivalents (~/.local/share, ~/.config, ~/.cache)',
    pathsCaseInsensitive: false,
    // darwin/linux 上 path.posix === 原生 path；显式 posix 使纯映射与运行平台解耦。
    paths: path.posix,
    // dsh sandbox-local STATIC_ENFORCEMENT：seatbelt/bwrap = full（profile 事实）。
    enforcementExpectation: 'full',
    enforcementNote: null,
    createSessionStateDir: () => createSessionStateDir(SESSION_STATE_PREFIX),
  }
}
