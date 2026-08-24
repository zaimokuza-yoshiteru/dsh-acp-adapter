/**
 * launch fingerprint 的组装真源（resume 预检②的 blocking 指纹）。
 * 由 ./agent.ts 的 startSession 在每次会话建立/续接时计算一次，写入 binding
 * 并与既有 binding 做 canonical 哈希预检（`acpCanonicalHash16` 双侧不等即
 * 'profile-changed' 阻断——旧形状指纹的 binding 缺新键，哈希天然不等，
 * 无需第二套「版本过期」机制）。
 *
 * 分量清单（全部 secret-free）：
 * - `command`/`args`/`envKeys`： 既有分量（profile config 原文 + 排序键名）。
 * - `profileId`/`descriptorId`：profile 身份与 descriptor 绑定。
 * - `adapterVersion`/`wrappedCliVersion`：descriptor versionPolicy 的**声明值**
 * （钉版）；实际安装版本无可靠探测面，声明值变即指纹变。
 * - `envRefs`：descriptor 白名单 env 引用的**存在性**（`{key,present}`，按
 *   targetName 排序）——值绝不入指纹。
 * - `opaqueRefs`：opaque 引用的 `~` 展开 + normalize 后的 source 与
 *   targetRelative（排序固定）；凭证内容绝不入。
 * - `executableOverride`：高级 CLI override env 的 `{name,present}` 或 null。
 * - `dataHomeGeneration`：data home agent（descriptor 带 dataHomeEnv）或确定性
 *   会话状态目录 agent（descriptor `sessionStateDir: 'deterministic'`，如 Devin）
 *   记入建立代际；其余 agent 记 null。旧 Devin binding 缺少该分量，resume 预检
 *   沿用 `profile-changed` 阻断，不引入不可靠的隐式迁移。
 *
 * 显式**不进** blocking 指纹的分量（保持既有语义）：
 * - canonical cwd：由 binding.canonicalCwd 与预检①（'cwd-changed'）覆盖。
 * - capability/config hash：保持 advisory（capabilityHash/configHash 字段
 *   只记录不阻断），保住热切换与 devin 既有行为。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/session/launch-fingerprint
 */
/// <reference types="node" />

import os from 'node:os'
import path from 'node:path'
import type { AcpAgentRuntimeDescriptor, AcpStubAgentConfig } from './agent-config.ts'
import type { AcpLaunchFingerprint } from '../../persistence/sidecar.ts'

/** {@link acpLaunchFingerprint} 的输入。 */
export interface AcpLaunchFingerprintInput {
  /** 注册表 profile id（路由 `acp-<id>` 的 `<id>` 部分）。 */
  readonly profileId: string
  /** 该 profile 的当前配置。 */
  readonly config: AcpStubAgentConfig
  /** 解析出的 descriptor（普通 profile 为 undefined）。 */
  readonly descriptor: AcpAgentRuntimeDescriptor | undefined
  /** 本次建立的 ACP 代际（data home agent 记入指纹）。 */
  readonly generation: number
  /** envRef/override 存在性判定的取值面；缺省 `process.env`（参数化供测试注入）。 */
  readonly env?: Record<string, string | undefined>
  /** opaque ref `~` 展开的家目录；缺省 `os.homedir()`（参数化供测试注入）。 */
  readonly homeDir?: string
}

/** `~`/`~/...` 展开为绝对路径后 normalize（非 `~` 开头的源原样 normalize）。 */
function expandOpaqueSource(source: string, homeDir: string): string {
  const expanded = source === '~' ? homeDir : source.startsWith('~/') ? path.join(homeDir, source.slice(2)) : source
  return path.normalize(expanded)
}

/**
 * 组装完整 launch fingerprint（分量语义见模块头注释）。纯函数：相同输入恒等
 * 输出（所有列表排序固定），canonical 哈希因此稳定。
 */
export function acpLaunchFingerprint(input: AcpLaunchFingerprintInput): AcpLaunchFingerprint {
  const env = input.env ?? process.env
  const homeDir = input.homeDir ?? os.homedir()
  const descriptor = input.descriptor
  const envRefs =
    descriptor === undefined
      ? null
      : descriptor.envRefs
          .map((ref) => ({ key: ref.targetName, present: env[ref.sourceName] !== undefined && env[ref.sourceName] !== '' }))
          .sort((left, right) => left.key.localeCompare(right.key))
  const opaqueRefs =
    descriptor === undefined
      ? null
      : descriptor.opaqueRefs
          .map((ref) => ({ source: expandOpaqueSource(ref.source, homeDir), targetRelative: ref.targetRelative }))
          .sort((left, right) =>
            left.targetRelative === right.targetRelative
              ? left.source.localeCompare(right.source)
              : left.targetRelative.localeCompare(right.targetRelative),
          )
  const executableOverride =
    descriptor?.executableOverrideEnv === undefined
      ? null
      : {
          name: descriptor.executableOverrideEnv,
          present: env[descriptor.executableOverrideEnv] !== undefined && env[descriptor.executableOverrideEnv] !== '',
        }
  return {
    command: input.config.command,
    args: [...input.config.args],
    envKeys: Object.keys(input.config.env).sort(),
    profileId: input.profileId,
    descriptorId: descriptor?.id ?? null,
    adapterVersion: descriptor?.versionPolicy.adapter ?? null,
    wrappedCliVersion: descriptor?.versionPolicy.wrappedCli ?? null,
    envRefs,
    opaqueRefs,
    executableOverride,
    dataHomeGeneration: descriptor?.dataHomeEnv !== undefined || descriptor?.sessionStateDir === 'deterministic' ? input.generation : null,
  }
}
