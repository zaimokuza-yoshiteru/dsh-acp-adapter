/**
 * ACP provider registry。
 *
 * The `dsh-acp` settings namespace owns the agent list; every agent gets an LLM
 * route `acp-<id>` backed by one shared stub adapter so the prompt gate
 * (`turnAgentFor`) accepts ACP selections. Settings changes
 * re-`replace` routes in place; rc.7 emits `llm/adapters-updated` from inside
 * the commit point, so the selector refreshes with no manual emit.
 *
 * 不向 DSH configurable provider directory 注册 ACP 管理项：Settings → Models
 * 页不显示 ACP 配置，profile 的
 * create/edit/delete 只在 ACP 面板（`settings.section` entry）进行；adapter
 * route 注册保留（全局模型 picker 经它发现 ACP 模型）。
 *
 * Layering: the pure core (route id derivation, registration facts,
 * probe config hash, settings schema) is exported for unit tests;
 * every `ctx`/`ctx.llm` side effect lives in {@link installAcpRegistry}.
 *
 * Settings access follows the `installSettingsSection` precedent
 * (`packages/core/agent-default-model`, `packages/llm/llm-pi-ai`) but inlines
 * it: this package must not take a runtime dependency on dsh-settings
 * (execution-plan dependency rule), so the scope is narrowed structurally via
 * `ctx.get('settings')` and the schema is a plain callable with `toJSON`
 * (the two members `SettingsProvider.register` actually invokes).
 *
 * 分层：路由 id 约定与 per-agent 配置 datum 下沉到
 * src/domain/session/agent-config.ts（零 import 叶子），本模块只做 host 侧
 * 组合——settings ns 注册、路由同步与 probe confiner 编排。
 * @module @zaimokuza/dsh-acp-adapter/host/composition/registry
 */
/// <reference types="node" />

import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { AcpProbeOptions } from '../../protocol/v1/types.ts'
import { FIBER_DISPOSED, FIBER_UNLOADING } from '../../host-compat/fiber-state.ts'
import {
  ACP_AGENT_IDS,
  ACP_AGENT_ID_PATTERN,
  ACP_SETTINGS_NS,
  acpAgentIdFromRoute,
  acpRouteId,
  descriptorEnvRefValues,
  descriptorOf,
  descriptorStagingSourcesOf,
  diffAcpAgentConfigs,
} from '../../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentConfigChange, AcpAgentId, AcpBuiltinAgentTemplate, AcpResolvedAgent } from '../../domain/session/agent-config.ts'
import { createAcpLogger } from '../../domain/observability/logging.ts'
import type { AcpMetricsLike } from '../../domain/observability/metrics.ts'
import { AcpStubAdapter, acpProbeConfigKey } from './llm-stub.ts'
import type { AcpProbeConfiner } from './llm-stub.ts'
import { AcpSpawnPlanError, buildAcpAgentEnv, buildAcpSpawnPlan, stageOpaqueRefs } from '../../domain/policy/sandbox.ts'
import type { AcpSandboxProviderLike } from '../../domain/policy/sandbox.ts'
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE } from '../../runtime/process/subprocess.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'

export { acpProbeConfigKey }

/** Agent id → config template, e.g. the panel's "添加 Devin" button. */
export type AcpAgentTemplate = AcpBuiltinAgentTemplate

// 边界：内置模板与 runtime descriptor 的真源下沉到零 import 叶子
// src/domain/session/agent-config.ts（spawn/probe/health/创建门多处消费）；
// 本 re-export 保持旧 import 路径（test/ 与面板文档先例）不变。
export { ACP_BUILTIN_AGENT_TEMPLATES, CLAUDE_ACP_TEMPLATE, CODEX_ACP_TEMPLATE, DEVIN_ACP_TEMPLATE, KIMI_ACP_TEMPLATE } from '../../domain/session/agent-config.ts'

/** Resolved `dsh-acp` settings section. */
export interface AcpSettings {
  agents: Record<string, AcpAgentConfig>
}

/**
 * The shape `SettingsProvider.register` is invoked with. dsh-settings types its
 * schema as schemastery `z<T>`, but at runtime it only calls the schema as a
 * function (validation + defaults) and reads `toJSON()` for descriptors — both
 * supplied here without a schemastery dependency.
 */
export interface AcpSettingsSchema {
  (value: unknown): AcpSettings
  toJSON(): unknown
}

/** Structural face of dsh-settings' `SettingsScope<AcpSettings>` (see module doc). */
interface AcpSettingsScopeLike {
  get(): AcpSettings
  watch(callback: (next: AcpSettings, prev: AcpSettings) => void | Promise<void>): () => void
}

/** Structural face of dsh-settings' `SettingsProvider` limited to what the registry uses. */
interface AcpSettingsProviderLike {
  register(ns: string, schema: AcpSettingsSchema): AcpSettingsScopeLike
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * command 校验（「profile 可使用绝对 command 路径，不允许 shell
 * 字符串」）：拒一切空白与 shell 元字符（| & ; < > $ ` " ' \）——spawn 是
 * argv 数组无 shell，这些字符只会制造注定失败的怪命令名。绝对路径（含 `/`）
 * 合法。
 */
const ACP_COMMAND_FORBIDDEN_PATTERN = /[\s|&;<>()$`"'\\]/

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
 // 边界：command 是 **单个可执行名或绝对路径**，不是 shell 字符串——spawn 全链
  // argv 数组直达 subprocess seam（不经 shell，注入面在协议连接层钉死），空格/
  // shell 元字符不会产生分词或展开，只会变成一个注定 ENOENT 的怪文件名；这里
  // 响亮拒绝，把配置错误暴露在写入时而不是首 turn。
  if (ACP_COMMAND_FORBIDDEN_PATTERN.test(command)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.command must be a single executable name or an absolute path (no whitespace or shell metacharacters — spawn is an argv array without a shell); put arguments in "args"`,
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
 // 边界：runtime 是 descriptor 绑定，只收四个合法值——非法值拒绝写入
  // （普通 profile 不允许拼出宿主 path/env ref，也不允许指向不存在的 descriptor）
  const runtime = raw['runtime']
  if (runtime !== undefined && !ACP_AGENT_IDS.includes(runtime as AcpAgentId)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.runtime must be one of ${ACP_AGENT_IDS.map((value) => JSON.stringify(value)).join(', ')} (it binds the profile to a built-in runtime descriptor)`,
    )
  }
  return {
    name,
    command,
    args: [...args] as string[],
    env: { ...env } as Record<string, string>,
    ...(loginHint === undefined ? {} : { loginHint }),
    ...(runtime === undefined ? {} : { runtime: runtime as AcpAgentId }),
  }
}

/**
 * （ 内置 runtime 唯一性）内置 runtime singleton 的跨条目校验：每个内置 runtime
 * （devin/codex/kimi/claude）至多一个 profile。生效绑定 = 显式 `runtime`
 * 字段优先，缺席时按 agent id 回退（与 descriptorOf 同口径——共享同一
 * descriptor 数据面的两个 profile 必然撞 staging/data home，必须拒绝）。
 * 无 runtime 身份的 generic profile 不受限（多实例靠稳定 profile id 区分）。
 * 错误点名已有 profile（id + 显示名），不自动覆盖/删除——绕过 UI 直写
 * settings 同样被本闸拒绝。
 */
function assertSingletonRuntimes(agents: Record<string, AcpAgentConfig>): void {
  const bound = new Map<AcpAgentId, string>()
  for (const [id, config] of Object.entries(agents)) {
    const runtime = config.runtime ?? (ACP_AGENT_IDS.includes(id as AcpAgentId) ? (id as AcpAgentId) : undefined)
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
export const acpSettingsSchema: AcpSettingsSchema = Object.assign(
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
  {
    // Schemastery's toJSON is its own uid/refs format; this descriptor speaks
 // plain JSON Schema instead. The ACP panel is a custom
    // settings.section and never renders a schema-driven form, so the
    // descriptor is informational for generic settings surfaces only.
    toJSON: (): unknown => ({
      type: 'object',
      properties: {
        agents: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              command: {
                type: 'string',
                minLength: 1,
                description: '单个可执行名或绝对路径；拒绝空白与 shell 元字符（spawn 为 argv 数组，不经 shell；参数放 args）',
              },
              args: { type: 'array', items: { type: 'string' }, default: [] },
              env: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
              loginHint: { type: 'string' },
              runtime: { enum: [...ACP_AGENT_IDS] },
            },
            required: ['name', 'command'],
          },
          default: {},
        },
      },
    }),
  },
)

/** What the registry hands to `registerAdapter`/`replace`: route id plus the display name the selector shows. */
export interface AcpRegistrationFact {
  provider: string
  displayName: string
}

/**
 * Route facts captured by the LLM registry at registration time, sorted by
 * provider so a settings document that merely reorders its keys is not
 * mistaken for a route change (llm-pi-ai precedent). `displayName` rides along
 * because the registry snapshots `providerInfo().name` per route: a rename
 * that did not re-register would leave the old label showing.
 */
export function acpRegistrationFacts(agents: Record<string, AcpAgentConfig>): AcpRegistrationFact[] {
  return Object.entries(agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, config]) => ({ provider: acpRouteId(id), displayName: config.name }))
}

/** Live face of the installed registry. */
export interface AcpRegistry {
  /**
   * The shared stub adapter. Route registration/replacement keeps this one
 * instance (rc.7 `replace` semantics), and the health endpoint reads
   * probe snapshots / triggers refreshes through it.
   */
  readonly adapter: AcpStubAdapter
  /**
   * Current agents, keyed by agent id (detached snapshot). Writes go through
   * the settings service (`settings.update/mutate/replace` on `dsh-acp`); this
   * registry is the read + watch + route-registration side.
   */
  agents(): ReadonlyMap<string, AcpAgentConfig>
  /** Resolve an LLM route id (`acp-<id>`) to its agent; undefined for foreign/unknown routes. */
  resolveRoute(provider: string): AcpResolvedAgent | undefined
}

export interface AcpRegistryOptions {
  /** Connection knobs forwarded to every probe (tests shorten the teardown ladder). */
  probeOptions?: AcpProbeOptions
  /**
 * 加载期解析的 subprocess seam（host/factory/agent-loop.ts 经
   * ./subprocess.ts 的 `resolveSubprocessSeam` 解析一次后传入；probe 经它
   * spawn）。缺席 = 未接线，probe 以 spawn-failure fail closed。
   */
  subprocess?: SubprocessSeamResolution
 /** 指标 sink：透传给 probe（acp.probe 延迟/失败）。缺席 = 不记录。 */
  metrics?: AcpMetricsLike
  /**
 * agent 配置改动审计摘要出口：settings watch 的每次实改动（跳过加载
   * 首帧与卸载期）产出 added/removed/changed 清单交给本回调；生产接线把它落进
   * sidecar 的 `agent-config` 专档。回调抛错/拒绝只 warn——审计失败不得阻断
   * 设置同步。env 只携带键名级 diff（值永不出现）。
   */
  auditConfigChange?: (changes: readonly AcpAgentConfigChange[]) => void
}

/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Probe confiner 的组装（裁决：probe 同档 confine，固定 read-only；
 * disposable 数据根）。流程：`dshHomePath('dsh-acp','probe',<agentId>)`
 * 作持久 probeBase（仅是 run 目录的容器）→ 清扫全部旧 run 子目录（上次 probe
 * 的崩溃残留；删除失败仅 warn 不阻断）→ `mkdtemp(probeBase/run-*)` 出本次的
 * disposable 根并 canonicalize → read-only spawn 计划（workspaceRoot/stateRoot
 * 同为该 run 目录）→ 返回 confinement（`cleanup` 整棵删除 run 目录，由
 * llm-stub 的 finally 调用，不依赖 agent 侧 delete 成功）。
 *
 * slot 在 probe 发起时现取（服务后挂载也生效）：`dshHomePath` 缺席 →
 * AcpSpawnPlanError 响亮进缓存；`sandbox` 缺席 → `buildAcpSpawnPlan` 的
 * sandbox-unavailable fail closed 进缓存。profile 绑定的 descriptor（边界，
 * `runtime` 字段或 id 回退）声明的 XDG 镜像 opaque refs 同档注入（认证状态注入：
 * probe 也要读登录态，否则模型目录为空）；本地状态 Agent 使用确定性 data home
 * （dataHomeEnv descriptor）改为：envRefs 按声明键名从 DSH 进程环境取值注入、
 * dataHomeEnv 指向 disposable 根、opaqueRefs symlink 物化进 disposable 根。
 * 源缺失的 warn 走 `ctx.logger.warn`。
 */
function createProbeConfiner(ctx: Context): AcpProbeConfiner {
  const log = createAcpLogger(ctx.logger)
  return async ({ provider, config, argv }) => {
    const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
    const dshHomePath = holder.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const agentId = acpAgentIdFromRoute(provider) ?? provider
    if (dshHomePath === undefined) {
      throw new AcpSpawnPlanError(
        'ACP_SPAWN_CONFIG',
        `dsh-acp: cannot confine the probe for "${provider}": the dshHomePath slot is absent, so the probe state root is unresolvable`,
      )
    }
    const onWarn = (message: string): void => { log.warn(`dsh-acp: ${message}`, { acpProvider: provider, operation: 'spawn-plan' }) }
    const probeBase = dshHomePath('dsh-acp', 'probe', agentId)
    fs.mkdirSync(probeBase, { recursive: true })
    try {
      fs.chmodSync(probeBase, 0o700)
    } catch {
      /* 并发回收等竞态：权限收紧失败不阻断 probe */
    }
 // 崩溃残留清扫（边界）：上一轮的 disposable run 目录若没被 cleanup 删掉
    // （进程崩溃/kill），当前发布 probe 前整棵移除；删不动仅 warn，不阻断当前发布 probe。
    for (const entry of fs.readdirSync(probeBase)) {
      try {
        fs.rmSync(path.join(probeBase, entry), { recursive: true, force: true })
      } catch (error: unknown) {
        onWarn(`failed to sweep a stale probe run directory (${error instanceof Error ? error.message : String(error)}); continuing`)
      }
    }
    const probeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(probeBase, 'run-')))
    const descriptor = descriptorOf(agentId, config)
    const env = await buildAcpAgentEnv({ entries: config.env })
    let authPathRefs = descriptorStagingSourcesOf(descriptor)
    if (descriptor !== undefined) {
 // 边界：白名单 env 引用按声明键名取值注入（值绝不进日志/指纹）。
      Object.assign(env, descriptorEnvRefValues(descriptor, process.env))
 // 边界：高级 CLI override env（如 CLAUDE_CODE_EXECUTABLE）同纪律注入
      // probe 子进程——probe 必须在与会话一致的可执行事实下运行，否则指纹的
      // executableOverride.present 与健康行各说各话（ 缺口，当前实现）。
      const overrideEnv = descriptor.executableOverrideEnv
      if (overrideEnv !== undefined) {
        const overrideValue = process.env[overrideEnv]
        if (overrideValue !== undefined && overrideValue !== '') env[overrideEnv] = overrideValue
      }
      if (descriptor.dataHomeEnv !== undefined) {
 // disposable data home：本地状态 agent 的数据根 = disposable run 目录本身；opaque
        // refs symlink 物化进该根（机制同 authPathRefs staging），probe 结束整删。
        env[descriptor.dataHomeEnv] = probeRoot
        stageOpaqueRefs({ refs: descriptor.opaqueRefs, dataHome: probeRoot, onWarn })
        // dataHomeEnv descriptor 的 opaqueRefs 不经 XDG 镜像位（stagingSources
        // 对其恒返回 undefined，此处仅作显式不变量记录）。
        authPathRefs = undefined
      }
    }
    const sandbox = holder.get('sandbox') as AcpSandboxProviderLike | undefined
    const plan = buildAcpSpawnPlan({
      mode: 'read-only',
      workspaceRoot: probeRoot,
      stateRoot: probeRoot,
      argv,
      env,
      sandbox,
      ...(authPathRefs === undefined ? {} : { authPathRefs }),
      onWarn,
    })
    return {
      plan,
      cwd: probeRoot,
      cleanup: () => {
        fs.rmSync(probeRoot, { recursive: true, force: true })
      },
    }
  }
}

/**
 * Install the ACP registry: register the `dsh-acp` settings namespace and keep
 * `acp-<id>` routes in sync with it (：不再有 configurable-provider
 * directory 同步——ACP 不进 Settings → Models 管理页）. Route effects bind
 * to the OUTER `ctx` fiber (llm-pi-ai precedent): the settings service
 * detaching (provider reload) falls back to zero agents via `replace([])`
 * instead of withdrawing the registration, and plugin unload disposes both.
 *
 * Without a settings service the plugin stays dormant (nothing registers);
 * with one, an empty agents map is likewise dormant until the panel adds one.
 */
export function installAcpRegistry(ctx: Context, options: AcpRegistryOptions = {}): AcpRegistry {
  const log = createAcpLogger(ctx.logger)
  let agents: Record<string, AcpAgentConfig> = {}
  const adapter = new AcpStubAdapter({
    agents: () => new Map(Object.entries(agents).map(([id, config]) => [acpRouteId(id), config])),
    ...(options.probeOptions === undefined ? {} : { probeOptions: options.probeOptions }),
 // probe 的 spawn 也走宿主 subprocess seam；未接线 = fail closed（不自制回退）
    subprocess: options.subprocess ?? { ok: false, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE },
 // 裁决：probe 同档 confine（read-only；probe 无会话档位，取最严档）
    confineProbe: createProbeConfiner(ctx),
 // 边界：confinement cleanup 失败走结构化 warn（不翻转 probe 结果）
    onWarn: (message) => { log.warn(`dsh-acp: ${message}`, { operation: 'probe', result: 'cleanup-error' }) },
 // probe 指标透传
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  })

  let registration: AdapterRegistrationHandle | undefined
  // Facts are constructed by the sorted builder above, so their JSON is
  // canonical; a string compare replaces a deep-equal helper.
  let registeredKey = ''

  const ensureRegistration = (): void => {
    const facts = acpRegistrationFacts(agents)
    const key = JSON.stringify(facts)
    if (key === registeredKey) return
    const routes = facts.map((fact) => fact.provider)
    if (registration === undefined) {
      // Dormant posture: an empty agents map registers nothing (rc.7 forbids an
      // empty INITIAL registration; `replace([])` is the legal empty form).
      if (routes.length === 0) {
        registeredKey = key
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredKey = key
  }

  const onSettingsChange = (): void => {
    // llm-pi-ai precedent: a refused swap (route owned by another adapter
    // family) keeps the previous routes serving and advances no facts, so
    // returning to a working configuration re-applies.
    try {
      ensureRegistration()
    } catch (error: unknown) {
      log.error('dsh-acp: keeping the previously registered routes after a refused update', { operation: 'registry-sync', result: 'error' })
      log.error(error)
    }
  }

  /**
 * 配置改动审计：watch 回调的 prev/next 实 diff（跳过加载首帧与卸载期），
   * 逐条目包成 `agent-config` payload 交给接线回调。diff/组装是纯函数
   * （agent-config.ts/events.ts），审计出口抛错只 warn（不阻断设置同步）。
   */
  const auditConfigChanges = (prev: Record<string, AcpAgentConfig>, next: Record<string, AcpAgentConfig>): void => {
    if (options.auditConfigChange === undefined) return
    const changes = diffAcpAgentConfigs(prev, next)
    if (changes.length === 0) return
    try {
      options.auditConfigChange(changes)
    } catch (error: unknown) {
      log.warn(`dsh-acp: agent config change audit failed (${error instanceof Error ? error.message : String(error)})`, { operation: 'audit', result: 'error' })
    }
  }

  ctx.inject(['settings', 'llm'], (sctx) => {
    const settings = sctx.get('settings') as AcpSettingsProviderLike
    // The namespace registration rides this inject fiber: the settings service
    // detaching withdraws it (and its watchers) automatically.
    const scope = settings.register(ACP_SETTINGS_NS, acpSettingsSchema)
    agents = scope.get().agents
    onSettingsChange()
    scope.watch((next) => {
      // A stored change landing while the plugin unloads must not re-register
      // routes against a fiber whose resources are being released.
      if (isUnloading(ctx)) return
      const prev = agents
      agents = next.agents
      auditConfigChanges(prev, next.agents)
      onSettingsChange()
    })
  })

  return {
    adapter,
    agents: () => new Map(Object.entries(agents)),
    resolveRoute(provider: string): AcpResolvedAgent | undefined {
      const id = acpAgentIdFromRoute(provider)
      if (id === undefined) return undefined
      const config = agents[id]
      if (config === undefined) return undefined
 // 边界：descriptor 是内置受信数据，消费方经 descriptorOf(id, config) 现取
      // （runtime 字段优先、id 回退），不随解析结果复制一份
      return { id, config }
    },
  }
}
