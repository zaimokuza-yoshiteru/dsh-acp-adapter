/**
 * ACP provider 使用的 stub LLM adapter。
 *
 * One adapter instance serves every `acp-<id>` route: `stream()` never runs —
 * ACP sessions are driven by AcpAgent, and this route exists so the
 * prompt gate (`turnAgentFor`) accepts the selection. `listModels`
 * is a probe: spawn the agent, read the `model` config option, tear down：
 * capability-aware session cleanup first — close then delete when advertised);
 * the result (success OR failure) is cached by config hash with a TTL (ok 10min /
 * error 30s, agent-config.ts `acpProbeFresh`) so the model selector
 * never re-spawns on reopen, and the panel refreshes via {@link AcpStubAdapter.invalidateProbe}.
 *
 * The adapter owns no registration: ./registry.ts registers/replaces routes and
 * directory entries. This module is deliberately free of cordis imports so the
 * cache and failure mapping stay unit-testable with plain fakes.
 *
 * 本包 tsconfig 用 `types: []`；本文件需要 `os.tmpdir()` 作为 probe 子进程
 * 的 cwd，经 triple-slash reference 引入 @types/node
 * （src/protocol/v1/connection.ts 同款先例）。
 * @module @zaimokuza/dsh-acp-adapter/host/composition/llm-stub
 */

/// <reference types="node" />

import os from 'node:os'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { acpProbeConfigKey, acpProbeFresh } from '../../domain/session/agent-config.ts'
import type { AcpStubAgentConfig } from '../../domain/session/agent-config.ts'
import { acpCanonicalHash16 } from '../../persistence/sidecar.ts'
import { AcpClientConnection } from '../../protocol/v1/connection.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import type { AcpErrorKind, AcpProbeCleanup, AcpProbeOptions, AcpProbePhase, AcpProbeResult } from '../../protocol/v1/types.ts'
import { ACP_METRIC } from '../../domain/observability/metrics.ts'
import type { AcpMetricsLike } from '../../domain/observability/metrics.ts'
import type { AcpSpawnPlanView } from '../../runtime/process/types.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'

// probe 缓存键的真源下沉到 domain/session/agent-config.ts（remote/创建门
// 消费）；本 re-export 保持旧 import 路径（registry.ts 与 test/ 先例）不变。
export { acpProbeConfigKey }

/**
 * Probe confiner（probe 与会话同档 confine，并固定为 read-only；
 * disposable 数据根）：./registry.ts 组装，读 `dshHomePath`/`sandbox` slot 产出
 * probe 的 {@link AcpProbeConfinement}（spawn 计划 + disposable run 目录 cwd +
 * 清理回调；机制见 registry.ts `createProbeConfiner`）。
 */
export interface AcpProbeConfineInput {
  /** 完整路由 id（`acp-<id>`）。 */
  readonly provider: string
  /** 该路由的当前配置。 */
  readonly config: AcpStubAgentConfig
  /** 原始 argv（command + args，结构化）。 */
  readonly argv: string[]
}

/**
 * Probe confinement 产物（disposable probe）：spawn 计划 + 可选的 probe
 * cwd（disposable 数据根——probe 的 session/new 落点，ownsCwd=false，probe 自身
 * 不删）+ 清理回调。`cleanup` 由 {@link AcpStubAdapter} 在 probe 结束后（成功、
 * 失败、清理失败一律）于 finally 调用；cleanup 自身失败仅 warn，不翻转 probe
 * 结果（协议清理尽力而为 + disposable 根必删的纪律见 与
 * src/domain/session/agent-config.ts descriptor `probeCleanup`）。
 */
export interface AcpProbeConfinement {
  /** probe 的 spawn 计划（env 整体由计划供给）。 */
  readonly plan: AcpSpawnPlanView
  /** disposable probe cwd；缺席时 probe 用系统临时目录（ownsCwd=true 自删，旧行为）。 */
  readonly cwd?: string
  /** probe 结束后的清理（删 disposable 根等）；同步或异步均可。 */
  readonly cleanup: () => Promise<void> | void
}

/** Probe confiner：返回 confinement；失败抛错（经 {@link AcpStubAdapter} 的失败映射进 probe 缓存）。 */
export type AcpProbeConfiner = (input: AcpProbeConfineInput) => Promise<AcpProbeConfinement>

export interface AcpStubAdapterOptions {
  /**
   * Current agent configs keyed by FULL route id (`acp-<id>`). Read on every
   * call so settings changes reach the adapter without re-instantiation.
   */
  agents: () => ReadonlyMap<string, AcpStubAgentConfig>
  /** Connection knobs forwarded to every probe (tests shorten the teardown ladder). */
  probeOptions?: AcpProbeOptions
  /**
 * 加载期解析的 subprocess seam：probe 的 spawn 经它走宿主服务。
   * `{ok:false}`（宿主无 subprocess 服务/未接线）时 probe 以 spawn-failure
   * fail closed 进缓存，绝不自制 child_process 回退。
   */
  subprocess: SubprocessSeamResolution
  /**
 * Probe 的 spawn 计划 confiner（裁决：probe 同档 confine，read-only）。
 * 存在时 probe 以 `spawnPlan` spawn（env 整体由计划供给）；缺席时保持
   * 逐字节旧行为（配置 env 原样透传、无 confine——纯模块单测路径）。
   */
  confineProbe?: AcpProbeConfiner
  /**
 * 结构性 warn 通道（边界：confinement cleanup 失败只 warn 不翻转 probe
   * 结果）。缺席时写 `process.stderr` 保底。
   */
  onWarn?: (message: string) => void
  /**
 * 指标 sink：每次实际 probe（缓存命中不计）记一笔 `acp.probe`
   * （labels: provider, result = ok / AcpErrorKind）；probe 内 crash 另计
   * `acp.crash`。缺席 = 不记录。
   */
  metrics?: AcpMetricsLike
}

/** One cached probe outcome; failures are cached too (see {@link AcpStubAdapter.listModels}). */
export interface AcpProbeCacheEntry {
  /** Config hash the entry was produced from. */
  readonly key: string
 /** `Date.now()` at write; the health endpoint displays it. */
  readonly at: number
  readonly result:
    | {
        readonly kind: 'ok'
        readonly models: readonly LlmModelInfo[]
 /** initialize 响应的 authMethods 原值（现在随缓存保留；health 端点透传）。 */
        readonly authMethods: readonly acp.AuthMethod[]
 /** initialize 握手的 agentInfo 原值（现在随缓存保留；health 端点透传）。 */
        readonly agentInfo: acp.Implementation | null | undefined
 /** initialize 握手的 agentCapabilities 实际值（能力披露的数据源）。 */
        readonly agentCapabilities: acp.AgentCapabilities | undefined
        /**
 * probe 会话清理事实（close/delete 三态如实三态）。
         * 清理失败不翻转 probe 成败——本分支仍是 ok，但 health 据此展示降级。
         */
        readonly cleanup: AcpProbeCleanup
        /**
 * initialize 握手的 capability hash（sha256-16 of canonical
         * capabilities，`null` 输入当未握手）。记录进条目供 health 展示；
         * **不进缓存键**——agent version 与 capability 是 probe 的**结果**而非
         * 输入（计划条文的合理解读），版本/能力漂移靠 TTL 与「重新检查」发现。
         */
        readonly capabilityHash: string
 /** initialize 协商的 ACP 协议版本（readiness；health 端点透传）。 */
        readonly protocolVersion: number | undefined
        /**
         * configOptions 是否含 `category=model` 项（ 五态目录口径的输入事实）：
         * kimi 的模型目录只经 configOptions 提供（实际 ACP 行为 legacy `models` 为空），
         * 此项在场即视为有目录。与 models 同为 probe 结果——进条目不进缓存键。
         */
        readonly hasModelConfigOption: boolean
      }
    | {
        readonly kind: 'error'
        readonly failureKind: AcpErrorKind
        readonly error: LlmError
 /** probe 失败阶段（健康四层分层判据；未标记时为 undefined → 端点归 null）。 */
        readonly probePhase: AcpProbePhase | undefined
      }
}

/** Extract the `category: 'model'` select options from a probe, flattening grouped options. */
function probeModels(provider: string, configOptions: AcpProbeResult['configOptions']): LlmModelInfo[] {
  const option = configOptions?.find((candidate) => candidate.category === 'model')
  if (option === undefined || option.type !== 'select') return []
  const seen = new Set<string>()
  const models: LlmModelInfo[] = []
  for (const entry of option.options) {
    // SessionConfigSelectOptions is a flat option list OR a group list; devin's
    // 40-variant catalog arrives grouped. Flatten without assuming either.
    const options = 'options' in entry ? entry.options : [entry]
    for (const item of options) {
      // LlmRuntime.listModels rejects duplicates with INVALID_CATALOG, which
      // would fail the whole provider row — dedupe at the source instead.
      if (seen.has(item.value)) continue
      seen.add(item.value)
      models.push({
        provider,
        id: item.value,
        name: item.name,
        ...(item.description === undefined || item.description === null ? {} : { description: item.description }),
      })
    }
  }
  return models
}

/** Map a probe failure to a user-facing selector message, classified by {@link AcpErrorKind}. */
function acpProbeFailure(error: unknown, config: AcpStubAgentConfig): { kind: AcpErrorKind; error: LlmError; phase: AcpProbePhase | undefined } {
 // probe 阶段标记原样透传（健康卡 initialize/session 分层判据；未标记归 undefined）
  const phase = error instanceof AcpClientError ? error.probePhase : undefined
  const wrap = (kind: AcpErrorKind, message: string): { kind: AcpErrorKind; error: LlmError; phase: AcpProbePhase | undefined } => ({
    kind,
    error: new LlmError(message, 'ACP_PROBE_FAILED', { cause: error }),
    phase,
  })
  if (error instanceof AcpClientError) {
 // 用户可见文案尾部带 correlation id，可与进程日志/sidecar 对账
    const ref = `（错误编号 ${error.correlationId}）`
    switch (error.kind) {
      case 'spawn-failure':
        return wrap(
          error.kind,
          `无法启动 ACP agent 命令 "${config.command}"（命令不存在或不可执行）；请在 ACP 设置面板检查该提供方的 command/args 配置${ref}`,
        )
      case 'auth_required': {
        const hint = config.loginHint === undefined ? '请按该 agent 的文档完成登录' : `请运行 \`${config.loginHint}\` 完成登录`
        return wrap(error.kind, `ACP agent "${config.command}" 需要登录：${hint}，然后在 ACP 面板点「重新检查」重探模型目录${ref}`)
      }
      case 'timeout':
        return wrap(
          error.kind,
          `探测 ACP agent "${config.command}" 超时（agent 未在时限内应答 initialize/session/new）；确认该命令能正常启动后，在 ACP 面板点「重新检查」重试${ref}`,
        )
      case 'aborted':
 // 调用方中止（连接层 aborted kind，taxonomy user-rejected）
        return wrap(error.kind, `探测 ACP agent "${config.command}" 已取消${ref}`)
      case 'crash': {
        const exit = error.exit
        const fact = exit === undefined ? '退出状态未知' : `exit code ${String(exit.code ?? 'none')}, signal ${exit.signal ?? 'none'}`
        return wrap(error.kind, `ACP agent "${config.command}" 在探测期间意外退出（${fact}）；修复后请在 ACP 面板点「重新检查」重试${ref}`)
      }
 // protocol-error / sandbox-unavailable( 预留)：协议层（connection
      // classify）的 message 已是完整的诊断事实，透传即可。
      case 'protocol-error':
      case 'sandbox-unavailable':
        return wrap(error.kind, `${error.message}${ref}`)
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return wrap('protocol-error', `探测 ACP agent "${config.command}" 失败：${message}`)
}

/**
 * One stub adapter for all ACP routes. `stream()` throws guidance (the route
 * exists for the prompt gate, not for model calls); `listModels` serves the
 * probe cache. Both success and failure are cached by config hash — a selector
 * reopen must never re-spawn the agent, and a cached failure is exactly what
 * renders the native failure row (`buildModelCatalog` catches per-provider
 * errors into `session.models.failures`).
 */
export class AcpStubAdapter extends LlmAdapter {
  private readonly options: AcpStubAdapterOptions
  private readonly probeOptions: AcpProbeOptions
  private readonly cache = new Map<string, AcpProbeCacheEntry>()
  /** In-flight probes, so concurrent catalog builds share one spawn per route. */
  private readonly inflight = new Map<string, { key: string; promise: Promise<readonly LlmModelInfo[]> }>()

  constructor(options: AcpStubAdapterOptions) {
    super()
    this.options = options
    this.probeOptions = options.probeOptions ?? {}
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const config = this.options.agents().get(provider)
    // Unknown route (a stale registration mid-swap) degrades to the bare id —
    // LlmRuntime refuses an empty name, and the registry's facts guard real swaps.
    return { id: provider, name: config === undefined ? provider : `${config.name} · ACP` }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.agents().get(provider)
    if (config === undefined) {
      throw new LlmError(`ACP 提供方 "${provider}" 已不在配置中（可能刚从设置移除）；请刷新模型目录`, 'ACP_UNKNOWN_PROVIDER')
    }
    const key = acpProbeConfigKey(config)
    const cached = this.cache.get(provider)
 // 新鲜度集中判定（agent-config.ts acpProbeFresh）：key 相等且未过期
    // （ok 10min / error 30s TTL）才算命中；过期条目按 miss 重 probe。
    if (cached !== undefined && acpProbeFresh(cached, key, Date.now())) {
      if (cached.result.kind === 'ok') return cached.result.models
      throw cached.result.error
    }
    const pending = this.inflight.get(provider)
    if (pending !== undefined && pending.key === key) return await pending.promise
    const promise = this.probeAndCache(provider, config, key)
    this.inflight.set(provider, { key, promise })
    try {
      return await promise
    } finally {
      if (this.inflight.get(provider)?.promise === promise) this.inflight.delete(provider)
    }
  }

  /**
   * This route never serves a model call. The error is what a session whose
   * selection points at an ACP route surfaces (: switching a blank
   * session to an ACP provider mid-life reports guidance, and the runtime
   * normalizes the throw into a terminal stream failure).
   */
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'ACP 提供方不直接执行模型调用：请将默认模型设为该 ACP 提供方的模型后新建会话（已有会话不能中途切换到 ACP 提供方）',
      'ACP_STUB_ROUTE',
    )
  }

  /** Drop one cached probe (or all), forcing the next `listModels` to re-probe. Panel 刷新按钮走这里。 */
  invalidateProbe(provider?: string): void {
    if (provider === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(provider)
  }

 /** Last cached probe outcome for the health endpoint; undefined when never probed. */
  probeSnapshot(provider: string): AcpProbeCacheEntry | undefined {
    return this.cache.get(provider)
  }

  private async probeAndCache(provider: string, config: AcpStubAgentConfig, key: string): Promise<readonly LlmModelInfo[]> {
 // 埋点：实际 probe 的延迟与结果（缓存命中/在飞合并不计）
    const started = Date.now()
 // 边界：confinement 的清理回调（disposable probe 根必删）——成功、失败、
    // probe 内清理失败一律经 finally 执行；cleanup 自身失败仅 warn，不翻转结果。
    let confinement: AcpProbeConfinement | undefined
    try {
 // fail closed：seam 缺席（宿主无 subprocess 服务）时 probe 以
      // spawn-failure 响亮进缓存——零 spawn、零目录副作用，不自制回退。
      const resolution = this.options.subprocess
      if (!resolution.ok) throw new AcpClientError('spawn-failure', resolution.message, { category: 'config' })
      // cwd 仅作 spawn/session/new 的落点：无 confiner 时 probe 用系统临时目录，
 // 与任何工作区无关。confiner 在场时（接线）probe 同档 confine
 // （read-only）；confinement 携带 disposable run 目录作 cwd
      // （ownsCwd=false，probe 不自删，由 finally 的 cleanup 删除），env 由
      // spawn 计划整体供给；缺省保持配置 env 原样透传的旧行为。
      const argv = [config.command, ...config.args]
      const confiner = this.options.confineProbe
      confinement = confiner === undefined ? undefined : await confiner({ provider, config, argv })
      const probe = await AcpClientConnection.probe(
        confinement === undefined
          ? { argv, cwd: os.tmpdir(), env: { ...config.env }, subprocess: resolution.seam }
          : {
              argv,
              cwd: confinement.cwd ?? os.tmpdir(),
              env: {},
              spawnPlan: confinement.plan,
              subprocess: resolution.seam,
            },
 // 边界：disposable run 目录同时作 session/new 落点（options.cwd 提供则
        // probe 不自删——由 finally 的 confinement.cleanup 删除）。
        confinement?.cwd === undefined
          ? this.probeOptions
          : { ...this.probeOptions, cwd: confinement.cwd },
      )
      const models = probeModels(provider, probe.configOptions)
      this.options.metrics?.observe(ACP_METRIC.probe, Date.now() - started, { provider, result: 'ok' })
      this.cache.set(provider, {
        key,
        at: Date.now(),
        result: {
          kind: 'ok',
          models,
          authMethods: probe.authMethods,
          agentInfo: probe.agentInfo,
          agentCapabilities: probe.agentCapabilities,
 // 清理事实（probe 清理）与 capability hash 随 ok 条目保留，供 health 展示；
          // 均不进缓存键（它们是 probe 的结果而非输入）
          cleanup: probe.cleanup,
          capabilityHash: acpCanonicalHash16(probe.agentCapabilities ?? null),
 // readiness：协商的协议版本随缓存保留（health 行展示）
          protocolVersion: probe.protocolVersion,
          // configOptions-only 目录事实（Kimi 形态），供五态派生放行。
          hasModelConfigOption: probe.configOptions?.some((option) => option.category === 'model') ?? false,
        },
      })
      return models
    } catch (error: unknown) {
      const failure = acpProbeFailure(error, config)
      this.options.metrics?.observe(ACP_METRIC.probe, Date.now() - started, { provider, result: failure.kind })
      if (failure.kind === 'crash') this.options.metrics?.increment(ACP_METRIC.crash, { provider })
      this.cache.set(provider, {
        key,
        at: Date.now(),
        result: { kind: 'error', failureKind: failure.kind, error: failure.error, probePhase: failure.phase },
      })
      throw failure.error
    } finally {
      if (confinement !== undefined) {
        try {
          await confinement.cleanup()
        } catch (error: unknown) {
          const warn = this.options.onWarn ?? ((message: string) => { process.stderr.write(`dsh-acp: ${message}\n`) })
          warn(`probe confinement cleanup failed for "${provider}" (${error instanceof Error ? error.message : String(error)}); the disposable probe root may linger until the next probe sweep`)
        }
      }
    }
  }
}
