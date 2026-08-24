/**
 * 生产默认 sandbox 平台 adapter 的选择点：`process.platform` 在
 * domain/policy 层的唯一读取点，避免业务层散落平台分支。win32 使用
 * ./windows.ts；darwin 及其余 POSIX 使用 ./macos.ts 的 XDG adapter。
 * Windows 规则已有离台单测，但尚未完成真机验收。
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/platform
 */

/// <reference types="node" />

import { createXdgSandboxPlatform } from './macos.ts'
import type { AcpSandboxPlatform } from './types.ts'
import { createWindowsSandboxPlatform } from './windows.ts'

/**
 * 按平台解析生产 adapter。
 * @param platformId - 默认取当前平台；测试可显式传 'win32' 观察画像选择
 *   （测试注入点）。
 * @returns 平台 adapter（规则数据 + 建目录原语）。
 */
export function createDefaultSandboxPlatform(platformId: NodeJS.Platform = process.platform): AcpSandboxPlatform {
  if (platformId === 'win32') return createWindowsSandboxPlatform()
  return createXdgSandboxPlatform(platformId)
}

export type { AcpAuthPathRefRule, AcpSandboxPlatform } from './types.ts'
