/**
 * ACP provider registry。
 *
 * The `dsh-acp` settings namespace owns the agent list; every agent gets an LLM
 * route `acp-<id>` backed by one independent ACP adapter per profile so the prompt gate
 * (`turnAgentFor`) accepts ACP selections. Settings changes
 * re-`replace` routes in place and emits `llm/adapters-updated` from the commit
 * point, so the selector refreshes without a manual event.
 *
 * 不向 DSH configurable provider directory 注册 ACP 管理项：Settings → Models
 * 页不显示 ACP 配置，profile 的
 * create/edit/delete 只在 ACP 面板（`settings.section` entry）进行；adapter
 * route 注册保留（全局模型 picker 经它发现 ACP 模型）。
 *
 * Layering: the pure core (route id derivation, registration facts,
 * probe config hash, settings schema) is exported for unit tests;
 * every `ctx`/`ctx.llm` side effect lives in {@link installInstalledProfileRegistry}.
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
 * 组合——settings ns 注册、路由同步与 probe runtime preparation 编排。
 * @module @zaimokuza/dsh-acp-adapter/host/composition/installed-profile-registry
 */
/// <reference types="node" />

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { AcpProbeOptions } from '../../protocol/v1/types.ts'
import {
  ACP_AGENT_IDS,
  ACP_AGENT_ID_PATTERN,
  ACP_SETTINGS_NS,
  acpAgentIdFromRoute,
  acpRouteId,
} from '../../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentId, AcpResolvedAgent } from '../../domain/session/agent-config.ts'
import { createAcpLogger } from '../../domain/observability/logging.ts'
import { acpProbeConfigKey } from './llm-stub.ts'
import { AcpProfileAdapter } from './profile-adapter.ts'
import { profileLaunchIdentityHash } from '../../domain/session/launch-fingerprint.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import { installAcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpNativeUserQuestionService } from '../../domain/policy/elicitation.ts'
import type { AcpNativeQuestionBinding } from './profile-adapter.ts'
import type { SessionLike } from '../../domain/session/current-step-admission.ts'
import type { DispatchLedgerStore } from '../../runtime/session/dispatch-ledger.ts'
import { resolveSubprocessSeam } from './subprocess.ts'
import { AcpRemoteService } from '../../remote/service.ts'
import { auditTimelineRowOf } from './audit-row.ts'
import { installAcpBackendGuard } from './backend-guard.ts'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ExternalSubagentProjector } from '../subagent/external-projector.ts'

export { acpProbeConfigKey }

// Built-in templates and runtime descriptors live in the zero-import profile
// data module and are re-exported here for the host composition surface.
export { ACP_BUILTIN_AGENT_TEMPLATES, CLAUDE_ACP_TEMPLATE, CODEX_ACP_TEMPLATE, DEVIN_ACP_TEMPLATE, KIMI_ACP_TEMPLATE } from '../../domain/session/agent-config.ts'

/** Resolved `dsh-acp` settings section. */
export interface AcpSettings {
  agents: Record<string, AcpAgentConfig>
  projectExternalSubagents?: boolean
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

function sessionHasOpenTurn(session: SessionLike): boolean {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const type = session.events[index]?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

async function flushClosedParent(
  store: { get(id: string): SessionLike | undefined; flush(session: SessionLike): Promise<boolean> },
  sessionId: string,
  expected: SessionLike,
): Promise<boolean> {
  // The adapter starts projection just before yielding the terminal chunk.
  // Give the stock AgentLoop a bounded window to append turn/end; publishing a
  // child against an open or replaced parent would assert lineage too early.
  const deadline = Date.now() + 10_000
  while (sessionHasOpenTurn(expected)) {
    if (store.get(sessionId) !== expected || Date.now() >= deadline) return false
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  }
  if (store.get(sessionId) !== expected) return false
  return await store.flush(expected)
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
 * 字段优先，缺席时按 agent id 回退（与 descriptorOf 同口径）。重复的
 * 内置 runtime 会让安装检查、模型目录与会话恢复无法稳定指向唯一配置，
 * 因此必须拒绝。
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
    const projection = value['projectExternalSubagents']
    if (projection !== undefined && typeof projection !== 'boolean') throw new TypeError('dsh-acp settings: "projectExternalSubagents" must be boolean')
    return { agents, ...(projection === true ? { projectExternalSubagents: true } : {}) }
  },
  {
    // Schemastery's toJSON is its own uid/refs format; this descriptor speaks
 // plain JSON Schema instead. The ACP panel is a custom
    // settings.section and never renders a schema-driven form, so the
    // descriptor is informational for generic settings surfaces only.
    toJSON: (): unknown => ({
      type: 'object',
      properties: {
        projectExternalSubagents: { type: 'boolean', default: false },
        agents: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              command: {
                type: 'string',
                minLength: 1,
                description: 'Executable name or absolute path. Shell metacharacters are rejected; put arguments in args.',
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

/** Live face of the installed-profile route registry.
 * This is deliberately not the official ACP Registry catalog. */
export interface InstalledProfileRegistry {
  /**
   * Resolves after the initial settings snapshot has been applied to the LLM
   * route registry.  Session creation can race Cordis' inject callback during
   * startup; callers must await this barrier before resolving an `acp-*` route,
   * otherwise a configured ACP default can be mistaken for an unknown native
   * provider and fall through to DSH's LLM stub.
   */
  readonly ready: Promise<void>
  /**
   * Current agents, keyed by agent id (detached snapshot). Writes go through
   * the settings service (`settings.update/mutate/replace` on `dsh-acp`); this
   * registry is the read + watch + route-registration side.
   */
  agents(): ReadonlyMap<string, AcpAgentConfig>
  /** Resolve an LLM route id (`acp-<id>`) to its agent; undefined for foreign/unknown routes. */
  resolveRoute(provider: string): AcpResolvedAgent | undefined
}

export interface InstalledProfileRegistryOptions {
  /** Mount the additive dshAcp activity Remote in the provider composition.
   * The additive provider composition mounts its own service when enabled. */
  installRemote?: boolean
  /** Connection knobs forwarded to every probe (tests shorten the teardown ladder). */
  probeOptions?: AcpProbeOptions
  /**
 * 加载期解析的 subprocess seam（host composition 经
   * ./subprocess.ts 的 `resolveSubprocessSeam` 解析一次后传入；probe 经它
   * spawn）。缺席 = 未接线，probe 以 spawn-failure fail closed。
   */
  subprocess?: SubprocessSeamResolution
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
export function installInstalledProfileRegistry(ctx: Context, options: InstalledProfileRegistryOptions = {}): InstalledProfileRegistry {
  let disposed = false
  const log = createAcpLogger(ctx.logger)
  const sidecar = installAcpSidecar(ctx)
  if (sidecar !== undefined) installAcpBackendGuard(ctx, { sidecar })
  // The additive composition has no AgentLoop constructor to hand this seam
  // down. Resolve the host-owned service at the composition boundary instead;
  // keeping the explicit option is useful for isolated tests and embedders.
  const subprocess = options.subprocess ?? resolveSubprocessSeam(ctx)
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  const sessionStore = typeof holder.get === 'function'
    ? holder.get('sessions') as { get(id: string): SessionLike | undefined; flush(session: SessionLike): Promise<boolean> } | undefined
    : undefined
  let externalSubagentProjector: ExternalSubagentProjector | undefined
  const persistenceFiber = sidecar === undefined ? undefined : ctx.inject(['sessionPersistence'], (childCtx: Context) => {
    const persistence = (childCtx as Context & { sessionPersistence: SessionPersistence }).sessionPersistence
    const projector = new ExternalSubagentProjector(persistence, sidecar)
    externalSubagentProjector = projector
    void projector.repairInterrupted().then((summary) => {
      if (summary.repaired > 0 || summary.conflicted > 0) {
        log.info(`dsh-acp: external subagent projection recovery completed (repaired=${summary.repaired}, conflicted=${summary.conflicted})`, {
          operation: 'subagent-projection-repair',
          result: summary.conflicted > 0 ? 'conflict' : 'ok',
        })
      }
    }).catch((error: unknown) => {
      log.warn(`dsh-acp: external subagent projection recovery failed: ${error instanceof Error ? error.message : String(error)}`, {
        operation: 'subagent-projection-repair', result: 'error',
      })
    })
    const effect = (childCtx as Context & { effect?: Context['effect'] }).effect
    effect?.call(childCtx, () => () => {
        if (externalSubagentProjector === projector) externalSubagentProjector = undefined
      }, 'dsh-acp: release external subagent projector')
  })
  if (persistenceFiber !== undefined) {
    ctx.effect(() => () => {
      persistenceFiber.dispose()
      externalSubagentProjector = undefined
    }, 'dsh-acp: dispose optional session persistence binding')
  }
  let attachments: Pick<AttachmentStore, 'readImage' | 'imageLimits' | 'saveImages'> | undefined
  try {
    attachments = holder.get('attachments') as Pick<AttachmentStore, 'readImage' | 'imageLimits' | 'saveImages'> | undefined
  } catch {
    attachments = undefined
  }
  // Resolve these host-owned services lazily. The provider composition can be
  // mounted before userQuestions/agents, and a live Agent must be looked up for
  // every interactive request so DSH remains the lifecycle and audit owner.
  const resolveNativeQuestions = (dshSessionId: string): AcpNativeQuestionBinding | undefined => {
    let userQuestions: AcpNativeUserQuestionService | undefined
    let approval: import('../../domain/policy/permissions.ts').AcpNativeApprovalService | undefined
    let agents: { get(id: string): unknown } | undefined
    try { userQuestions = (ctx as unknown as { userQuestions?: AcpNativeUserQuestionService }).userQuestions } catch { /* optional seam */ }
    try { agents = (ctx as unknown as { agents?: { get(id: string): unknown } }).agents } catch { /* optional seam */ }
    try { userQuestions ??= holder.get('userQuestions') as AcpNativeUserQuestionService | undefined } catch { /* optional seam */ }
    try { approval = holder.get('approval') as import('../../domain/policy/permissions.ts').AcpNativeApprovalService | undefined } catch { /* optional seam */ }
    try { agents ??= holder.get('agents') as { get(id: string): unknown } | undefined } catch { /* optional seam */ }
    if ((userQuestions === undefined && approval === undefined) || agents === undefined || agents.get(dshSessionId) === undefined) return undefined
    return {
      ...(userQuestions === undefined ? {} : { userQuestions }),
      ...(approval === undefined ? {} : { approval }),
      getAgent: () => agents?.get(dshSessionId),
    }
  }
  const ledgerStore: DispatchLedgerStore = sidecar === undefined
    ? {
        begin: async () => { throw new Error('ACP sidecar is unavailable; durable dispatch ledger is required') },
        settle: async () => { throw new Error('ACP sidecar is unavailable; durable dispatch ledger is required') },
        read: async () => undefined,
      }
    : {
        begin: (record) => sidecar.beginDispatch(record),
        settle: (sessionId, key) => sidecar.settleDispatch(sessionId as Parameters<AcpSidecar['settleDispatch']>[0], key),
        read: async (sessionId, key) => await sidecar.readDispatch(sessionId as Parameters<AcpSidecar['readDispatch']>[0], key),
      }
  let agents: Record<string, AcpAgentConfig> = {}
  let projectExternalSubagents = false
  // Desired settings and the last successfully installed snapshot are kept
  // separate. A partially failed registration must never make an old route's
  // closure observe `undefined` just because the settings watcher advanced.
  let activeAgents: Record<string, AcpAgentConfig> = {}
  // Adapters are also the owner of provider-composition recovery verbs. Keep
  // this map available before constructing the additive Remote service.
  const profileAdapters = new Map<string, AcpProfileAdapter>()
  const ownedSidecar = sidecar
  const ownedSessionReadGate = async (sessionId: string): Promise<boolean> => {
    // The sidecar is the authority for both audit and Activity ownership;
    // SessionStore liveness is intentionally not accepted as a grant.
    try { return await ownedSidecar?.hasDurableActivityOwner(sessionId as never) ?? false } catch { return false }
  }
  const canRegisterRemote = typeof (ctx as Context & { reflect?: { provide?: unknown } }).reflect?.provide === 'function'
  let existingRemote: unknown
  try { existingRemote = holder.get('dshAcp') } catch { existingRemote = undefined }
  if (options.installRemote === true && canRegisterRemote && sidecar !== undefined && existingRemote === undefined) {
    new AcpRemoteService(ctx, {
      registry: {
        // Remote health addresses a configured profile by its stable settings
        // id (`codex`), while the LLM registry addresses the execution route
        // as `acp-codex`. Keep those two namespaces separate; otherwise the
        // Settings panel's targeted check is always reported as unknown.
        agents: () => new Map(Object.entries(agents)),
        // Health delegates to the exact adapter registered for the profile;
        // this keeps Settings and the stock ModelPicker on one cache/key and
        // one in-flight probe. There is deliberately no detached fallback.
        probeCacheFor: (profileId) => profileAdapters.get(profileId),
      },
      // Health's executable/version facts must use the same host subprocess
      // seam as the ACP probe.  Omitting this made a successful probe coexist
      // with executable=false/version=null in the Settings panel.
      subprocess,
      // The provider composition has no Agent owner; activity methods are
      // intentionally read-only and describe provider-owned facts only.
      resolveLiveAgent: () => undefined,
      // Header/audit facts are read-only host facts.  Keeping them here makes
      // the additive provider composition useful to the stock header utility
      // without creating a second Agent lifecycle in the provider bridge.
      backendFacts: {
        readBindingProvider: async (sessionId) => {
          const lookup = await sidecar.readLatestBinding(sessionId as never).catch(() => undefined)
          return lookup?.status === 'ok' ? lookup.binding.provider : undefined
        },
        peekHeaderProvider: async (sessionId) => {
          const session = sessionStore?.get(sessionId)
          if (session === undefined) throw new Error('DSH session is not available')
          for (const event of [...session.events].reverse()) {
            if (event.type !== 'request/header' || typeof event.data !== 'object' || event.data === null) continue
            const header = (event.data as { header?: unknown }).header
            if (typeof header !== 'object' || header === null) continue
            const config = (header as { config?: unknown }).config
            if (typeof config !== 'object' || config === null) continue
            const provider = (config as { provider?: unknown }).provider
            if (typeof provider === 'string') return provider
          }
          return undefined
        },
        hasLiveAgent: (sessionId) => sessionStore?.get(sessionId) !== undefined,
      },
      bindingFacts: {
        countBoundSessions: async (provider) => {
          const bindings = await sidecar.listBindings()
          return bindings.filter((entry) => entry.binding.provider === provider).length
        },
        listBoundProviders: async () => {
          const bindings = await sidecar.listBindings()
          return [...new Set(bindings.map(entry => entry.binding.provider))]
        },
      },
      auditTimeline: {
        list: async (sessionId, afterSeq, limit) => {
          const rows = await sidecar.listPage(sessionId as never, afterSeq, limit)
          return rows.map(auditTimelineRowOf)
        },
        hasMore: async (sessionId, seq) => (await sidecar.listPage(sessionId as never, seq, 1)).length > 0,
      },
      activityTimeline: {
        snapshot: (sessionId, limit, filter) => sidecar.activitySnapshot(sessionId as never, limit, filter),
        page: (sessionId, afterRevision, limit, filter) => sidecar.activityPage(sessionId as never, afterRevision, limit, filter),
        head: (sessionId, filter) => sidecar.activityHead(sessionId as never, filter),
        subscribe: (sessionId, filter, subscriber) => sidecar.subscribeActivity(sessionId as never, filter ?? {}, subscriber),
      },
      ownedSessionReadGate,
      activityAccess: ownedSessionReadGate,
      projectedSubagentIds: () => sidecar.listProjectedSubagentIds(),
      imageInputAvailable: attachments !== undefined,
      recoveryStateStore: {
        read: async (sessionId) => {
          const state = await sidecar.readRecoveryState(sessionId as never).catch(() => undefined)
          if (state === undefined) return undefined
          return {
            dshSessionId: state.dshSessionId,
            kind: state.kind,
            cause: state.cause ?? null,
            detail: state.detail ?? null,
            provider: state.provider ?? null,
            acpSessionId: state.acpSessionId ?? null,
            generation: state.generation ?? null,
            interruptedTurnId: state.interruptedTurnId ?? null,
            lastAttemptAt: state.lastAttemptAt ?? null,
            lastUserAction: state.lastUserAction ?? null,
            updatedAt: state.updatedAt,
          }
        },
      },
      recoveryAdapter: (provider) => {
        const id = acpAgentIdFromRoute(provider)
        return id === undefined ? undefined : profileAdapters.get(id)
      },
      agentSessionControl: (provider) => {
        const id = acpAgentIdFromRoute(provider)
        return id === undefined ? undefined : profileAdapters.get(id)
      },
    })
  }

  // Each registered profile adapter owns both its model-catalog probe and the
  // Settings health view of that probe. There is no detached fallback cache.
  const registrations = new Map<string, AdapterRegistrationHandle>()
  const ready = Promise.withResolvers<void>()
  // A create/resume may already be waiting when the plugin is unloaded.  Do
  // not leave that caller suspended forever: resolving the barrier lets the
  // authoritative route lookup fail closed below.  `resolve` is idempotent,
  // so normal initialization and disposal may safely race.
  ctx.effect(() => () => ready.resolve(), '@zaimokuza/dsh-acp-adapter: release ACP route readiness waiters')
  // Facts are constructed by the sorted builder above, so their JSON is
  // canonical; a string compare replaces a deep-equal helper.
  let registeredKey = ''
  const ensureRegistration = (): void => {
    const facts = acpRegistrationFacts(agents)
    // Registration facts include the selector label, while the shared launch
    // identity additionally fences the model catalogue from command/args/env/
    // runtime edits. Values are hashed and never enter the registration key.
    const identities = Object.entries(agents).sort(([left], [right]) => left.localeCompare(right)).map(([id, config]) => [id, profileLaunchIdentityHash(id, config)])
    const key = JSON.stringify({ facts, identities })
    if (key === registeredKey) {
      // Registration facts intentionally ignore runtime settings such as env
      // and args. Still publish the new active snapshot so the route adapter
      // sees the next immutable generation on its next call.
      activeAgents = { ...agents }
      return
    }
    const previousActive = activeAgents
    const created: string[] = []
    const touched: string[] = []
    // Existing adapters resolve their config through this detached candidate
    // during replace/register; restore it if any registration fails.
    activeAgents = { ...agents }
    try {
      for (const id of Object.keys(agents)) {
        const config = agents[id]
        if (config === undefined) continue
        let routeAdapter = profileAdapters.get(id)
        if (routeAdapter === undefined) {
          routeAdapter = new AcpProfileAdapter(
            id,
            () => activeAgents[id],
            subprocess,
            sessionId => sessionStore?.get(sessionId),
            ledgerStore,
            undefined,
            undefined,
            sidecar,
            attachments,
            resolveNativeQuestions,
            sidecar === undefined ? undefined : async (observation, context) => {
              if (!projectExternalSubagents) return undefined
              const projector = externalSubagentProjector
              if (projector === undefined) throw new Error('ACP_SUBAGENT_PERSISTENCE_UNAVAILABLE')
              const store = sessionStore
              if (store === undefined) throw new Error('ACP_SUBAGENT_PARENT_UNAVAILABLE')
              const parent = store.get(context.parentDshSessionId)
              if (parent === undefined) throw new Error('ACP_SUBAGENT_PARENT_UNAVAILABLE')
              const result = await projector.project(observation, {
                ...context,
                flushParent: async () => await flushClosedParent(store, context.parentDshSessionId, parent),
              })
              return result?.childSessionId
            },
            message => log.warn(message, { operation: 'claude-draft-subagent-capability' }),
          )
          profileAdapters.set(id, routeAdapter)
        }
        const route = acpRouteId(id)
        const handle = registrations.get(id)
        if (handle === undefined) {
          registrations.set(id, ctx.llm.registerAdapter([route], routeAdapter))
          created.push(id)
        } else {
          touched.push(id)
          handle.replace([route])
        }
      }
    } catch (error) {
      for (const id of created) {
        try { registrations.get(id)?.() } catch { /* best effort rollback */ }
        registrations.delete(id)
        void profileAdapters.get(id)?.close().catch(() => undefined)
        profileAdapters.delete(id)
      }
      activeAgents = previousActive
      // A replace may have synchronously refreshed host metadata before a
      // later profile collided. Re-emit the old snapshot for those routes.
      for (const id of touched) {
        try { registrations.get(id)?.replace([acpRouteId(id)]) } catch { /* best effort */ }
      }
      throw error
    }
    for (const [id, handle] of registrations) {
      if (agents[id] !== undefined) continue
      handle()
      registrations.delete(id)
      void profileAdapters.get(id)?.close().catch(() => undefined)
      profileAdapters.delete(id)
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

  // The composition, not a removed AgentLoop subclass, now owns teardown.
  // Dispose routes first, then ACP runtimes, then the sidecar; each failure is
  // contained so one broken profile cannot strand the remaining processes.
  ctx.effect(() => async () => {
    disposed = true
    for (const handle of registrations.values()) {
      try { handle() } catch (error) { log.warn(`dsh-acp: route disposal failed: ${String(error)}`) }
    }
    registrations.clear()
    const results = await Promise.allSettled([...profileAdapters.values()].map(adapter => adapter.close()))
    for (const result of results) {
      if (result.status === 'rejected') log.warn(`dsh-acp: profile runtime disposal failed: ${String(result.reason)}`)
    }
    profileAdapters.clear()
    try { await sidecar?.dispose() } catch (error) { log.warn(`dsh-acp: sidecar disposal failed: ${String(error)}`) }
  }, '@zaimokuza/dsh-acp-adapter: dispose ACP profile routes and sidecar')

  // `settings` is a required dependency of the composition root. Register the
  // namespace synchronously in this plugin fiber instead of hiding the only
  // route-registration path in a nested dynamic inject: the latter can leave
  // a loaded ACP row with no watcher when the host loader composes services in
  // separate phases. The explicit disposer keeps the watch lifetime aligned
  // with this plugin even when the settings provider itself is replaced.
  const settings = holder.get('settings') as AcpSettingsProviderLike | undefined
  if (settings === undefined) {
    throw new Error('dsh-acp: settings service is required by the ACP composition')
  }
  const scope = settings.register(ACP_SETTINGS_NS, acpSettingsSchema)
  const initialSettings = scope.get()
  agents = initialSettings.agents
  projectExternalSubagents = initialSettings.projectExternalSubagents === true
  onSettingsChange()
  ready.resolve()
  const unwatch = scope.watch((next) => {
    // A stored change landing while the plugin unloads must not re-register
    // routes against a fiber whose resources are being released.
    if (disposed) return
    agents = next.agents
    projectExternalSubagents = next.projectExternalSubagents === true
    onSettingsChange()
  })
  ctx.effect(() => () => { unwatch() }, '@zaimokuza/dsh-acp-adapter: dispose settings watch')

  return {
    ready: ready.promise,
    agents: () => new Map(Object.entries(agents)),
    resolveRoute(provider: string): AcpResolvedAgent | undefined {
      const id = acpAgentIdFromRoute(provider)
      if (id === undefined) return undefined
      const config = activeAgents[id]
      if (config === undefined) return undefined
 // 边界：descriptor 是内置受信数据，消费方经 descriptorOf(id, config) 现取
      // （runtime 字段优先、id 回退），不随解析结果复制一份
      return { id, config }
    },
  }
}
