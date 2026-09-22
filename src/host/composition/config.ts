/** Validated Agent configuration shared by Loader and the ACP settings editor. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { posix, win32 } from 'node:path'
import { ACP_AGENT_IDS, ACP_AGENT_ID_PATTERN, acpRouteId, effectiveRuntimeOf } from '../../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentId } from '../../domain/session/agent-config.ts'

export interface AcpSettings { agents: Record<string, AcpAgentConfig> }
export interface Config { agents: Volatile<Record<string, AcpAgentConfig>> }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Paths are passed literally as argv[0], including spaces and shell punctuation.
 * Recognize both platforms because the client and Agent host may differ.
 * Bare commands still reject likely pasted command lines; arguments belong in args.
 */
function validExecutableCommand(command: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(command)) return false
  if (posix.isAbsolute(command) || win32.isAbsolute(command) || /^\.{1,2}[\\/]/.test(command)) return true
  return !/[\s|&;<>()$`"']/.test(command)
}

/** Validate one agent entry; unknown keys are dropped (schemastery strip semantics). */
function agentConfigOf(id: string, raw: unknown): AcpAgentConfig {
  if (!ACP_AGENT_ID_PATTERN.test(id)) {
    throw new TypeError(
      `dsh-acp settings: agent id "${id}" must match ${String(ACP_AGENT_ID_PATTERN)} (it becomes LLM route "${acpRouteId(id)}")`,
    )
  }
  if (!isPlainObject(raw)) throw new TypeError(`dsh-acp settings: agents.${id} must be an object`)
  const name = raw['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`dsh-acp settings: agents.${id}.name must be a non-empty string`)
  }
  const command = raw['command']
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError(`dsh-acp settings: agents.${id}.command must be a non-empty string`)
  }
  if (!validExecutableCommand(command)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.command must be an executable name or path without control characters; enter paths directly without surrounding quotes and put arguments in "args"`,
    )
  }
  const args = raw['args'] ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new TypeError(`dsh-acp settings: agents.${id}.args must be an array of strings`)
  }
  const env = raw['env'] ?? {}
  if (!isPlainObject(env) || !Object.values(env).every((value) => typeof value === 'string')) {
    throw new TypeError(`dsh-acp settings: agents.${id}.env must be a map of string values`)
  }
  const loginHint = raw['loginHint']
  if (loginHint !== undefined && typeof loginHint !== 'string') {
    throw new TypeError(`dsh-acp settings: agents.${id}.loginHint must be a string`)
  }
 // 边界：runtime 是专有行为绑定，只收四个合法值——非法值拒绝写入
  // （普通 profile 不允许拼出宿主 path/env ref，也不允许指定未知的 runtime）
  const catalogId = raw['catalogId']
  if (catalogId !== undefined && (typeof catalogId !== 'string' || !ACP_AGENT_ID_PATTERN.test(catalogId))) {
    throw new TypeError(`dsh-acp settings: agents.${id}.catalogId must be a registry identifier`)
  }
  const runtime = raw['runtime']
  if (runtime !== undefined && !ACP_AGENT_IDS.includes(runtime as AcpAgentId)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.runtime must be one of ${ACP_AGENT_IDS.map((value) => JSON.stringify(value)).join(', ')} (it binds the profile to a specialized runtime)`,
    )
  }
  return {
    name,
    command,
    args: [...args] as string[],
    env: { ...env } as Record<string, string>,
    ...(loginHint === undefined ? {} : { loginHint }),
    ...(runtime === undefined ? {} : { runtime: runtime as AcpAgentId }),
    ...(catalogId === undefined ? {} : { catalogId }),
  }
}

/**
 * （ 内置 runtime 唯一性）内置 runtime singleton 的跨条目校验：每个内置 runtime
 * （devin/codex/kimi/claude）至多一个 profile。生效绑定 = 显式 `runtime`
 * 字段优先，缺席时按 agent id 回退（与 effectiveRuntimeOf 同口径）。重复的
 * 内置 runtime 会让安装检查、模型目录与会话恢复无法稳定指向唯一配置，
 * 因此必须拒绝。
 * 无 runtime 身份的 generic profile 不受限（多实例靠稳定 profile id 区分）。
 * 错误点名已有 profile（id + 显示名），不自动覆盖/删除——绕过 UI 直写
 * settings 同样被本闸拒绝。
 */
function assertSingletonRuntimes(agents: Record<string, AcpAgentConfig>): void {
  const bound = new Map<AcpAgentId, string>()
  for (const [id, config] of Object.entries(agents)) {
    const runtime = effectiveRuntimeOf(id, config)
    if (runtime === undefined) continue
    const existing = bound.get(runtime)
    if (existing !== undefined) {
      throw new TypeError(
        `dsh-acp settings: agents.${id} duplicates the built-in runtime "${runtime}" already bound by agents.${existing} ("${agents[existing]?.name ?? existing}"); a built-in runtime is a singleton — edit the existing profile instead`,
      )
    }
    bound.set(runtime, id)
  }
}

/**
 * Validating resolver for the `dsh-acp` namespace: an absent section resolves
 * to zero agents; an invalid one throws, which is how the settings service
 * refuses the write (or keeps the last good value on an external edit).
 */
export const acpSettingsSchema: ((value: unknown) => AcpSettings) & { toJSON(): unknown } = Object.assign(
  (value: unknown): AcpSettings => {
    if (value === undefined) return { agents: {} }
    if (!isPlainObject(value)) throw new TypeError('dsh-acp settings: the section must be an object with an "agents" map')
    const rawAgents = value['agents'] ?? {}
    if (!isPlainObject(rawAgents)) throw new TypeError('dsh-acp settings: "agents" must be a map of agent id → config')
    const agents: Record<string, AcpAgentConfig> = {}
    for (const [id, raw] of Object.entries(rawAgents)) agents[id] = agentConfigOf(id, raw)
    assertSingletonRuntimes(agents)
    return { agents }
  },
  { toJSON: () => SettingsSchema.toJSON() },
)

const AgentSchema = z.object({
  name: z.string().required(), command: z.string().required(),
  args: z.array(z.string()).default([]), env: z.dict(z.string()).default({}),
  loginHint: z.string(), catalogId: z.string(), runtime: z.union([...ACP_AGENT_IDS]),
})
const AgentsSchema = z.dict(AgentSchema)
const SettingsSchema = z.object({ agents: AgentsSchema.default({}) })
/** Native volatile field; Loader validates before publishing an atomic live update. */
const NativeConfig = z.object({ agents: AgentsSchema.default({}).volatile() })
// Business validation belongs to Loader, not to a serialized browser callback.
// Keep the native schema/prototype intact so forms can rehydrate its plain JSON.
export const Config = new Proxy(NativeConfig, {
  get(target, key, receiver) {
    if (key !== '~standard') return Reflect.get(target, key, receiver)
    return { ...target['~standard'], validate(value: unknown) {
      return target['~standard'].validate(acpSettingsSchema(value))
    } }
  },
  apply(target, thisArg, args: Parameters<typeof NativeConfig>) {
    const validated = acpSettingsSchema(args[0])
    return Reflect.apply(target, thisArg, [validated, args[1]])
  },
}) as unknown as z<unknown, Config>
export type AcpSettingsSchema = typeof acpSettingsSchema
