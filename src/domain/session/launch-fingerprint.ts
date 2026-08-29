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
 * - `executableOverride`：高级 CLI override env 的 `{name,present}` 或 null。
 * - `nativeStateEnv`：Agent 原生状态目录相关环境键的存在性与路径 hash；
 *   HOME/CODEX_HOME/XDG 等变化会阻止把旧 Agent 上下文交给新运行环境。
 *
 * 显式**不进** blocking 指纹的分量（保持既有语义）：
 * - canonical cwd：由 binding.canonicalCwd 与预检①（'cwd-changed'）覆盖。
 * - capability/config hash：保持 advisory（capabilityHash/configHash 字段
 *   只记录不阻断），保住热切换与 devin 既有行为。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/session/launch-fingerprint
 */
/// <reference types="node" />

import { createHash } from 'node:crypto'
import { type AcpAgentRuntimeDescriptor, type AcpStubAgentConfig } from './agent-config.ts'
import { ACP_NATIVE_DATA_HOME_ENV_KEYS, ACP_NATIVE_XDG_ENV_KEYS, buildAcpAgentEnv } from '../policy/sandbox.ts'
import type { AcpLaunchFingerprint } from '../../persistence/sidecar.ts'

/** {@link acpLaunchFingerprint} 的输入。 */
export interface AcpLaunchFingerprintInput {
  /** 注册表 profile id（路由 `acp-<id>` 的 `<id>` 部分）。 */
  readonly profileId: string
  /** 该 profile 的当前配置。 */
  readonly config: AcpStubAgentConfig
  /** 解析出的 descriptor（普通 profile 为 undefined）。 */
  readonly descriptor: AcpAgentRuntimeDescriptor | undefined
  /** envRef/override 存在性判定的取值面；缺省 `process.env`（参数化供测试注入）。 */
  readonly env?: Record<string, string | undefined>
}

export interface AcpLaunchEnvironmentInput {
  readonly config: AcpStubAgentConfig
  readonly descriptor: AcpAgentRuntimeDescriptor | undefined
  readonly dataHomeStrategy: 'native' | 'protected'
  readonly source?: Record<string, string | undefined>
}

/**
 * Reconstruct the pre-spawn environment.
 *
 * Native Agent Access intentionally matches an ordinary child process: every
 * defined variable inherited by DSH is available to the trusted local Agent.
 * This is required for Agent-owned proxies, SSH sockets, native MCP servers,
 * skills and provider configuration. Profile values are the explicit final
 * override. Protected probe/test paths retain the narrow allowlist.
 */
export async function acpLaunchEnvironment(input: AcpLaunchEnvironmentInput): Promise<Record<string, string>> {
  const source = input.source ?? process.env
  const env = input.dataHomeStrategy === 'native'
    ? Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined))
    : await buildAcpAgentEnv({ source })
  // Native Agent Access inherits the already-resolved host environment verbatim;
  // the adapter does not copy credential values through a descriptor allowlist.
  // An explicit executable override remains a non-secret routing choice and is
  // inherited naturally (or supplied by the profile env below).
  // A profile entry is an explicit user choice and therefore wins over both
  // ambient inheritance and built-in descriptor aliases.
  Object.assign(env, input.config.env)
  return env
}

const NATIVE_STATE_ENV_KEYS = ['HOME', ...ACP_NATIVE_DATA_HOME_ENV_KEYS, ...ACP_NATIVE_XDG_ENV_KEYS]

function nativeStateEnvFingerprint(env: Readonly<Record<string, string | undefined>>): readonly { key: string; present: boolean; hash16?: string }[] {
  return NATIVE_STATE_ENV_KEYS.map((key) => {
    const value = env[key]
    return value === undefined
      ? { key, present: false }
      : { key, present: true, hash16: createHash('sha256').update(value).digest('hex').slice(0, 16) }
  })
}

/**
 * 组装完整 launch fingerprint（分量语义见模块头注释）。纯函数：相同输入恒等
 * 输出（所有列表排序固定），canonical 哈希因此稳定。
 */
export function acpLaunchFingerprint(input: AcpLaunchFingerprintInput): AcpLaunchFingerprint {
  const env = input.env ?? process.env
  const descriptor = input.descriptor
  // Credential/environment references are intentionally not modeled by the
  // adapter. Native Agent Access inherits the process snapshot; old bindings
  // may still carry the nullable field for migration compatibility.
  const envRefs = null
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
    executableOverride,
    nativeStateEnv: nativeStateEnvFingerprint(env),
    // DSH Alpha still does not expose a safe, serializable MCP registry to plugins.
    // Formal ACP sessions therefore inject no host-owned MCP definition.
    mcpFingerprint: null,
  }
}
