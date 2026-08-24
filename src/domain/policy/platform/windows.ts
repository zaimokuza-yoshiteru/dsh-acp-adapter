/**
 * Windows sandbox 平台 adapter。路径规则和 DSH windows-acl 的公开行为已编码，
 * 但尚未完成 Windows 真机验收，因此当前不宣称 Windows 支持。
 *
 * 来自 DSH rc.2 的稳定约束：
 * - dsh sandbox-local 的 win32 链唯一后端是 windows-acl，STATIC_ENFORCEMENT
 *   恒报 `partial`（WRITE_RESTRICTED 须保留 Everyone 于 restricting list、
 *   NTFS 硬链接可跨路径别名同一文件对象）——
 *   reference/deepseek-harness/packages/sandbox/sandbox-local/src/index.ts；
 * - windows-acl runner 以 SetEnvironmentVariableW 把 TMP/TEMP 重写到
 *   per-session 私有目录（runner 自身 env，子进程继承）——
 *   reference/deepseek-harness/packages/sandbox/sandbox-windows-acl/src/runner.ts。
 *   故本 adapter **不注入 TMP/TEMP**（以 runner 为准，不铺第二层真源）。
 *
 * 另：confined 档孙进程的 pipe stdio 在 windows-acl 下可能触发 EPERM。ACP
 * 使用 stdio，因此该限制必须在未来的 Windows 真机验收中确认。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/platform/windows
 */

/// <reference types="node" />

import path from 'node:path'
import { createSessionStateDir } from './staging.ts'
import type { AcpAuthPathRefRule, AcpSandboxPlatform } from './types.ts'

/**
 * 状态目录 env 布局按 Windows 公开惯例取
 * %APPDATA%（roaming）/ %LOCALAPPDATA%（local）两键；Devin on Windows
 * 进程启动期实际读哪个状态变量（以及是否仍读 XDG 变量）尚未真机验证，
 * authPathRefs 是否能让 confined agent 读到登录态未知。TMP/TEMP 有意缺席
 * （runner 重写为准，见模块头）。
 */
const WIN32_STATE_DIR_ENV_LAYOUT: ReadonlyArray<readonly [envKey: string, subdir: string]> = [
  ['APPDATA', 'appdata-roaming'],
  ['LOCALAPPDATA', 'appdata-local'],
]

/**
 * authPathRefs 前缀按公开惯例假定在 %APPDATA% / %LOCALAPPDATA% 之下；
 * Devin 的 Windows 凭据目录尚未真机验证，因此不宣称登录态注入支持。真实落点
 * 确认后再修订本表与内置模板
 * （src/domain/session/agent-config.ts 的 DEVIN_ACP_TEMPLATE 当前只声明
 * macOS XDG 路径）。
 */
const WIN32_AUTH_PATH_REF_RULES: readonly AcpAuthPathRefRule[] = [
  { homeRelativePrefix: 'AppData/Roaming', mirrorSubdir: 'appdata-roaming' },
  { homeRelativePrefix: 'AppData/Local', mirrorSubdir: 'appdata-local' },
]

/**
 * partial enforcement 的已知残余风险文案（随 health 事实透传设置面板；
 * 依据为 reference 源码钉版事实 + 调研结论，README「平台支持矩阵」/
 * 「限制」节同口径）。
 */
const WIN32_ENFORCEMENT_NOTE =
  'windows-acl 后端恒为 partial enforcement：WRITE_RESTRICTED 须保留 Everyone' +
  '（外部 Everyone-可写对象仍可写），NTFS 硬链接可别名越界；另 confined 档孙进程的' +
  ' pipe stdio 已知 EPERM 受限。authPathRefs 落点仍未在 Windows 真机验证。'

/**
 * Windows 平台 adapter。规则来自公开路径语义与 DSH rc.2 的 windows-acl 行为；
 * 当前仅保证纯映射测试，不代表 Windows 产品验收。
 */
export function createWindowsSandboxPlatform(): AcpSandboxPlatform {
  return {
    platformId: 'win32',
    stateDirEnvLayout: WIN32_STATE_DIR_ENV_LAYOUT,
    authPathRefRules: WIN32_AUTH_PATH_REF_RULES,
    authPathRefHomeDescription: 'Windows per-user application data roots (%APPDATA%, %LOCALAPPDATA%)',
    // NTFS 通常大小写不敏感；该匹配行为尚未在真机验证。
    pathsCaseInsensitive: true,
    // 真实 Windows 上 path.win32 === 原生 path；显式 win32 使纯映射可在 macOS 上单测。
    paths: path.win32,
    enforcementExpectation: 'partial',
    enforcementNote: WIN32_ENFORCEMENT_NOTE,
    // os.tmpdir 在 Windows 上解析 %TEMP%/%TMP%；
    // 与 windows-acl runner 的 --temp 私有目录（含 per-session SID 授权）叠加
    // 后的实际可见性未实测（runner 重写 TMP/TEMP 为准，见模块头）。
    createSessionStateDir: () => createSessionStateDir('dsh-acp-'),
  }
}
