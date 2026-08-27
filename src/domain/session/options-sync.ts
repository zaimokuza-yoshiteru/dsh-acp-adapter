/**
 * Model / thought-level / mode hot switching, one write path per class:
 *
 * 1. In-session live switching (mode / thought_level / other): the enhanced
 *    selector renders live `configOptions` sections (thought_level / mode /
 *    model_config / other — NOT model) for ACP sessions; writes arrive through
 * the dshAcp Remote `setOption` method, which calls
 *    {@link AcpOptionsSync.applyLiveChange} after locating the live AcpAgent.
 *    Agent-pushed `config_option_update` / `current_mode_update` notifications
 * refresh the in-memory snapshot on their own (translator state slots, ).
 * 2. Model hot switching is NOT here (model switch coordinator): the single write
 *    entry is the ModelSwitchCoordinator (client model-switch-controller.ts +
 *    dshAcp Remote `beginModelSwitch`/`commitModelSwitch`/`rollbackModelSwitch`
 *    + sidecar `model_switches` recoverable transaction). `setOption` refuses
 *    model-class options, and the old native-path model re-assertion in
 *    {@link AcpOptionsSync.syncBeforeTurn} is deleted.
 * 3. Native-path compatibility: {@link AcpOptionsSync.syncBeforeTurn} runs the
 *    agent-scoped `system-prompt/assemble` + `agent/request` waterfalls before
 *    each turn, so edits made through the native `selectModel` surface become
 *    visible. The waterfall mechanics come from the web model-selection
 *    listener (reference .../core/agent/src/model-selection.ts:39-75):
 *    `system-prompt/assemble` snapshots `current` → `assembled` (invoked via
 *    the REAL `systemPrompt` service), then `agent/request` applies
 *    `assembled` on top of the seed. The seed is the ACP current value, so an
 *    untouched selector reads back as a no-op. A selected provider other than
 *    this session's `acp-<id>` route is REFUSED with an {@link AcpBackendImmutableError}
 * (: backend is immutable — the turn fails loudly instead of silently
 *    ignoring the selection); an explicitly selected
 *    reasoning effort maps onto the `thought_level` option. A DSH-side model
 *    value differing from the ACP current model is NO LONGER re-asserted onto
 *    the agent (that was the second write path): the initial application of
 *    the DSH session's selected model happens exactly once at session
 * establish (./agent.ts `convergeModelAtEstablishment`, — after the
 *    binding is durable, before the first prompt, yielding to the
 *    pending-switch guard whenever a `model_switches` row exists); a
 *    divergence observed here afterwards means that convergence was declined
 *    or failed, so it only feeds a warn-once defensive note (or the
 *    pending-switch guard below when a row exists).
 *
 * Pending-switch guard ( crash recovery, turn-time enforcement):
 * `syncBeforeTurn` reads the sidecar `model_switches` row (via the injected
 * {@link AcpModelSwitchGuard}) after the waterfalls, while the agent is live
 * and idle-within-the-window. With both current values known it converges only
 * to provable states: equal values → clear; DSH==previous/Agent==target →
 * roll the agent back; DSH==target/Agent==previous → re-apply the agent write;
 * `rollback-required` rows and undecidable combinations sink the turn loudly
 * with {@link AcpModelSwitchLockedError} (no prompt in an inconsistent state;
 * NEVER last-writer-wins). The interactive counterpart (completing DSH-side
 * writes, user-chosen rollback) lives in the client coordinator — the client
 * alone can call `session.selectModel`.
 *
 * Snapshot semantics (session option synchronization contract): after every successful
 * `session/set_config_option`, the authoritative snapshot is the RESPONSE's
 * complete `configOptions` — switching an option may cascade-change other
 * options. The seam performs the replacement (./agent.ts `setConfigOption`);
 * this module never predicts outcomes and always re-reads
 * `agent.configOptions` after a set.
 *
 * Mode routing （协议规则）: a `category: "mode"` config option writes
 * through `session/set_config_option` like every other advertised option —
 * Session Config Options supersede the legacy Session Modes API
 * (session-config-options.mdx). The dedicated `session/set_mode` RPC remains
 * exactly one place: the agent mirrors NO mode config option but exposes legacy
 * modes state (`currentModeId` known) — then `applyLiveChange('mode', …)`
 * falls back to `set_mode`. With neither present the capability is unavailable
 * and the selector block stays hidden (graceful-degradation matrix, ).
 *
 * All writes are idle-only (session option synchronization contract MVP): the seam re-checks at the
 * execution point; `applyLiveChange` pre-checks for a stable error code, and
 * `syncBeforeTurn` must be wired pre-driver, while the agent is still idle.
 *
 * Pure module: wiring into the AcpAgent turn driver and the dshAcp
 * Remote service belongs to the integration layer (host/factory + remote).
 * @module @zaimokuza/dsh-acp-adapter/domain/session/options-sync
 */

import type { Context, Logger } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import { ACP_STEP } from '../../protocol/v1/translate.ts'
import type { AcpPendingModelSwitch } from '../../persistence/sidecar.ts'

/**
 * Conventional config-option id of the model selector, used as fallback when
 * `category` is absent (same rule as ./agent.ts `modelOfConfigOptions`).
 */
export const ACP_MODEL_OPTION_ID = 'model'

// `ACP_MODE_OPTION_ID` lives in ./agent-config.ts (zero-import leaf) so the
// remote service shares it without pulling this module's import chain
// into the typert analysis closure; re-exported here to keep the import
// surface of ./agent.ts unchanged.
import { ACP_MODE_OPTION_ID } from './agent-config.ts'
export { ACP_MODE_OPTION_ID } from './agent-config.ts'

/** Stable failure codes of {@link AcpOptionsSyncError} (the endpoint maps them onto HTTP statuses). */
export type AcpOptionsSyncErrorCode =
  | 'busy'
  | 'unavailable'
  | 'unknown-option'
  | 'invalid-value'
  | 'unsupported-type'

/** Structured options-sync failure; `code` is the stable discriminator. */
export class AcpOptionsSyncError extends Error {
  constructor(
    readonly code: AcpOptionsSyncErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AcpOptionsSyncError'
  }
}

/**
 * 「backend 不可变」的 turn 时兜底：原生选择器指向的 provider 不是本 ACP
 * 会话的路由 → 跨 backend 热切换一律拒绝（响亮 throw，不再 warn 后静默忽略——
 * 旧行为下 UI 已采纳 selection 而 backend 没变，是静默分叉本体）。turn driver
 * （./agent.ts `syncOptions`）据此类把失败击沉 turn，而非按普通同步失败
 * warn 继续。
 */
export class AcpBackendImmutableError extends AcpClientError {
  constructor(message: string) {
    super('protocol-error', message, { category: 'config' })
    this.name = 'AcpBackendImmutableError'
  }
}

/** 模型切换锁定的稳定分类（turn 失败错误与恢复 UI 分流共用）。 */
export type AcpModelSwitchLockedCause = 'rollback-failed' | 'undecidable'

/**
 * 待定模型切换的 turn 时兜底（与 {@link AcpBackendImmutableError} 同款
 * 响亮击沉语义）：sidecar `model_switches` 行证明上一条切换未收束且当前
 * 双侧值无法自证一致（或回滚臂已失败）——不一致状态禁止 prompt。出路由
 * 消息如实陈述：打开模型选择器（client 恢复器/回滚按钮）、放弃 ACP 上下文
 * 重开（rebindBlank）、或新建会话。
 */
export class AcpModelSwitchLockedError extends AcpClientError {
  constructor(
    override readonly cause: AcpModelSwitchLockedCause,
    message: string,
  ) {
    super('protocol-error', message, { category: 'config' })
    this.name = 'AcpModelSwitchLockedError'
  }
}

/**
 * 待定切换守卫的 seam（./agent.ts 以 sidecar `model_switches` 表 +
 * `setConfigOption` seam 组装注入；缺席 = sidecar 未接线的裸单测环境，
 * 守卫整体停用）。restore/reapply 在 options-sync 窗口内执行（seam 的 idle
 * 守卫已由 agent.ts 放开）；restore/reapply/clear 的失败原样传播，
 * markRollbackRequired 的失败由调用方吞掉（锁定语义不因落盘失败而放行）。
 */
export interface AcpModelSwitchGuard {
  /** 读待定切换行；畸形行（corrupt）按「无法自证」抛出 {@link AcpModelSwitchLockedError}。 */
  read(): Promise<AcpPendingModelSwitch | undefined>
  /** 回滚臂：把 Agent 的 model option 写回 `previousModel`。 */
  restorePrevious(pending: AcpPendingModelSwitch): Promise<void>
  /** 重放臂：把 Agent 的 model option 写到 `targetModel`（started 崩溃/响应丢失的补完）。 */
  reapplyTarget(pending: AcpPendingModelSwitch): Promise<void>
  /** 回滚臂失败：持久化 `rollback-required`（下次恢复/每个 turn 都响亮阻断）。 */
  markRollbackRequired(pending: AcpPendingModelSwitch): Promise<void>
  /** 收敛确认后清除待定行（幂等）。 */
  clear(): Promise<void>
}

/**
 * The agent seam this module consumes — the structural subset of `AcpAgent`
 * under ./agent.ts "配置 seam". `configOptions` / `currentModeId` are the live
 * snapshot slots; the set methods are the idle-guarded RPC pass-throughs that
 * replace the snapshot from the agent's response.
 */
export interface AcpOptionsSyncAgent extends Agent {
  /** Latest configOptions snapshot (translator slot, or the pre-start push seed). */
  readonly configOptions: readonly acp.SessionConfigOption[] | undefined
  /** Latest mode id (`current_mode_update` push or session-response seed); unknown before that. */
  readonly currentModeId: string | undefined
 /** `session/set_config_option` pass-through; idle-only; snapshot replaced from the response. Booleans stay booleans ( type fidelity). : optional `signal` aborts the in-flight RPC (abandoned + connection poisoned); the connection-level default write deadline always applies. */
  setConfigOption(configId: string, value: string | boolean, options?: { signal?: AbortSignal }): Promise<void>
 /** `session/set_mode` pass-through; idle-only; legacy modes-only agents only. : same options surface as setConfigOption. */
  setMode(modeId: string, options?: { signal?: AbortSignal }): Promise<void>
}

/** Optional coordinates for one {@link AcpOptionsSync.syncBeforeTurn} call. */
export interface AcpSyncCoords {
  /** Upcoming turn number (payload field of the `agent/request` waterfall; informational for listeners). */
  turn?: number
  /** Step for the same payload; defaults to {@link ACP_STEP} (ACP turns are not subdivided). */
  step?: number
  /** Explicit control signal; defaults to a fresh never-aborted signal. */
  signal?: AbortSignal
}

/** Dependencies of {@link createAcpOptionsSync} — everything is injected; the module constructs nothing itself. */
export interface AcpOptionsSyncDeps {
  /**
   * Context the two waterfalls dispatch through, with the real `systemPrompt`
   * service reachable on it. The native selector's model-selection listeners
   * are registered in the agent's scope; the fused dispatcher / assemble
   * context carry this agent as the scope key so scope filtering matches.
   */
  readonly ctx: Context
  /** The live ACP agent seam ({@link AcpOptionsSyncAgent}). */
  readonly agent: AcpOptionsSyncAgent
  /** This session's provider route (`acp-<id>`, registry convention §5.1). */
  readonly providerRoute: string
  readonly logger: Pick<Logger, 'info' | 'warn'>
  /**
 * 待定模型切换守卫（崩溃恢复的 turn 时 enforcement）：sidecar
   * `model_switches` 行的读/收敛/锁定 seam。缺席 = sidecar 未接线（裸单测），
 * 守卫停用——生产接线恒在场（起 sidecar 是 ACP 会话的强制前提）。
   */
  readonly modelSwitchGuard?: AcpModelSwitchGuard | undefined
}

/** The options-sync bridge. */
export interface AcpOptionsSync {
  /**
   * Native-path sync before one turn: trigger `system-prompt/assemble` (real
   * service) + `agent/request` (seed = ACP current value), then apply what the
   * user changed through the native selector — an explicitly selected
   * reasoning effort maps onto the `thought_level` option. Before the first
   * request/header, a same-profile model choice is applied once as draft
   * initialization because DSH exposes no create-time selection seam. After
   * that boundary, ModelSwitchCoordinator is the single model write entry;
   * the construction selection's initial application is the establish-time
 * convergence in ./agent.ts, and a later divergence means
   * that convergence was declined/failed — it only feeds the pending-switch
   * guard / a warn-once note). A foreign
 * provider throws {@link AcpBackendImmutableError} ( loud refusal).
   * An unreconciled pending model switch throws {@link AcpModelSwitchLockedError}
   * （无法对账时明确拒绝；可证明的组合会先自动收敛）。
   *
   * MUST be called while the agent is idle (pre-driver wiring): the seam
   * rejects writes during execution. Concurrent calls share one in-flight run.
   * Failures of the waterfalls / RPCs propagate to the caller.
   */
  syncBeforeTurn(coords?: AcpSyncCoords): Promise<void>
  /**
   * Live-switch entry for the dshAcp Remote `setOption` method: idle guard, option
   * existence, and value validation, then forward to the seam. EVERY advertised
   * config option writes through `set_config_option` — mode-class included
   *；`set_mode` 只用于旧式 fallback（`configId` 为 `mode`
   * with no mirrored mode option but known `currentModeId`). Snapshot
   * replacement is owned by the seam (response-authoritative).
   * @throws {AcpOptionsSyncError} `busy` while running, `unavailable` when the
   * agent exposes no config options at all, `unknown-option`,
   * `invalid-value`, or `unsupported-type`.
   */
  applyLiveChange(configId: string, value: string | boolean): Promise<void>
}

/**
 * Model-class option of a snapshot: `category: 'model'` first, the
 * conventional id as fallback (category is a UX hint and may be absent).
 */
function modelOptionOf(options: readonly acp.SessionConfigOption[] | undefined): acp.SessionConfigOption | undefined {
  return options?.find((candidate) => candidate.category === 'model' || candidate.id === ACP_MODEL_OPTION_ID)
}

/** Thought-level option of a snapshot (`category: 'thought_level'`; no conventional id exists). */
function thoughtLevelOptionOf(options: readonly acp.SessionConfigOption[] | undefined): acp.SessionConfigOption | undefined {
  return options?.find((candidate) => candidate.category === 'thought_level')
}

/** Flattened selectable values of a select option (values may be nested in groups). */
export function selectValuesOf(option: acp.SessionConfigSelect): string[] {
  const values: string[] = []
  for (const entry of option.options) {
    if ('value' in entry) values.push(entry.value)
    else for (const nested of entry.options) values.push(nested.value)
  }
  return values
}

/** Create the options-sync bridge for one live ACP agent session. */
export function createAcpOptionsSync(deps: AcpOptionsSyncDeps): AcpOptionsSync {
  const { ctx, agent, providerRoute, logger } = deps
  // Fused dispatcher built once (agentEvents contract): couples the agent
  // subject to its scope carrier so scope-filtered listeners match.
  const dispatch = agentEvents(ctx, agent)
  /** One-time-notice latches: native-path hints must not spam every turn. */
  const hinted = new Set<string>()
  /** In-flight sync shared by concurrent `syncBeforeTurn` callers (dedupe). */
  let inFlight: Promise<void> | undefined

  function warnOnce(key: string, message: string): void {
    if (hinted.has(key)) return
    hinted.add(key)
    logger.warn(message)
  }

  function infoOnce(key: string, message: string): void {
    if (hinted.has(key)) return
    hinted.add(key)
    logger.info(message)
  }

  /** ACP current model: model-class select option's currentValue, falling back to construction selection. */
  function currentAcpModel(): string {
    const option = modelOptionOf(agent.configOptions)
    return option?.type === 'select' ? option.currentValue : agent.options.model ?? ''
  }

  async function doSync(coords: AcpSyncCoords): Promise<void> {
    const signal = coords.signal ?? new AbortController().signal
    const turn = coords.turn ?? 0
    const step = coords.step ?? ACP_STEP

    // 1. Real-service assemble: the native selector's listener snapshots
    //    current→assembled here (the assembly product itself is unused). A
    //    context without the system-prompt service has no native selector to
    //    read either — skip silently. An assembly failure must not sink the
    //    ACP turn: treat as no selection.
    const systemPrompt = ctx.systemPrompt
    if (systemPrompt !== undefined) {
      try {
        await systemPrompt.assemble(assembleContextFor(agent, signal))
      } catch (error: unknown) {
        logger.warn(`dsh-acp: pre-turn system-prompt assembly failed; treating as no native selection (${errorChain(error)})`)
      }
    }

    // 2. agent/request waterfall seeded with the ACP current value; the
    //    selector's listener applies the assembled selection on top
    //    (model-selection.ts:54-70). No selection ⇒ the seed passes through.
    const seed: LlmCallConfig = { provider: providerRoute, model: currentAcpModel() }
    let merged = await dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))

    // DSH 的空白会话没有 session-local selection：每次读取都会投影当前全局
    // 默认。ACP wrapper 却已在创建时固定 provider。首条 request/header 之前的
    // foreign provider 因此只是默认影子，不是一次可执行的跨 backend 热切换。
    // 采用 wrapper 真值；首轮落下 request/header 后，DSH 自己也会稳定到同一路由。
    const hasDurableRoute = agent.session.requestHeader() !== undefined
    if (!hasDurableRoute && merged.provider !== providerRoute) {
      infoOnce(
        'blank-default-shadow',
        `dsh-acp: ignored the blank session's live default shadow "${merged.provider}"; the actual wrapper is "${providerRoute}"`,
      )
      merged = seed
    }

    if (merged.provider !== providerRoute) {
 // 「backend 不可变」：原生选择器指向别的 provider（native 或另一个
      // ACP profile）= 跨 backend 热切换，一律响亮拒绝（turn 因此失败），不再
      // warn-once 后静默忽略——静默忽略会让 UI 已采纳的 selection 与实际
      // backend 分叉。消息明说两端 backend 与出路（同 profile 模型 / 新会话）。
      throw new AcpBackendImmutableError(
        `dsh-acp: this session's execution backend is "${providerRoute}" and cannot be switched to "${merged.provider}" mid-life; ` +
        'pick a model of the same provider, or start a new session for the other backend',
      )
    }

    // 同 profile 在首条消息前的模型选择属于 draft 初始化，不是热切换。
    // DSH 没有 create-time selection seam，故在首个 request/header 前把该选择
    // 一次性应用到 Agent；建立后仍只有 ModelSwitchCoordinator 可以改模型。
    if (!hasDurableRoute && merged.model !== currentAcpModel()) {
      const option = modelOptionOf(agent.configOptions)
      if (option?.type === 'select' && selectValuesOf(option).includes(merged.model)) {
        await agent.setConfigOption(option.id, merged.model, { signal })
      }
    }

 // 3. 待定模型切换守卫（崩溃恢复的 turn 时 enforcement）：sidecar
    //    `model_switches` 行在场 = 上一条切换未收束。只收敛到可证明的状态
    //    （双侧现值 × previous/target 比对），绝不 last-writer-wins 静默覆盖；
    //    无法自证 / 回滚臂已失败 → AcpModelSwitchLockedError 响亮击沉 turn。
    const guard = deps.modelSwitchGuard
    if (guard !== undefined) {
      const pending = await guard.read()
      if (pending !== undefined) {
        const dshModel = merged.model
        const agentModel = currentAcpModel()
        const appliedModel = pending.appliedModel ?? pending.targetModel
        if (pending.state === 'rollback-required') {
          throw new AcpModelSwitchLockedError(
            'rollback-failed',
            `dsh-acp: the previous model switch (${pending.previousModel} → ${pending.targetModel}) could not be rolled back; ` +
            'the session is locked because the Agent and DSH selections cannot be proven consistent — ' +
            'open the model picker to resolve it, discard the ACP context and reopen it, or start a new session',
          )
        }
        if (pending.state === 'agent-rolled-back' && (dshModel !== pending.previousModel || agentModel !== pending.previousModel)) {
          throw new AcpModelSwitchLockedError(
            'undecidable',
            `dsh-acp: the Agent rolled back the interrupted model switch to "${pending.previousModel}", but DSH selects ` +
            `"${dshModel}"; the persisted rollback must be finalized from the model picker before this turn can continue`,
          )
        } else if (dshModel === agentModel) {
          // 双侧一致 = 已收敛（含崩溃残留的 committed 行）：清行收束
          await guard.clear()
        } else if (dshModel === pending.previousModel && agentModel === appliedModel) {
          // Agent 已应用、DSH 未跟进：回滚 Agent 侧到 previous（可证明的锚点）
          try {
            await guard.restorePrevious(pending)
            await guard.clear()
          } catch (rollbackError: unknown) {
            await guard.markRollbackRequired(pending).catch(() => undefined)
            throw new AcpModelSwitchLockedError(
              'rollback-failed',
              `dsh-acp: recovering the interrupted model switch failed to restore the Agent to "${pending.previousModel}" ` +
              `(${errorChain(rollbackError)}); the session is locked — open the model picker to resolve it, ` +
              'discard the ACP context and reopen it, or start a new session',
            )
          }
        } else if (dshModel === appliedModel && agentModel === pending.previousModel) {
          // DSH 已跟进、Agent 未应用（started 崩溃/响应丢失）：重放 Agent 写
          try {
            await guard.reapplyTarget(pending)
            await guard.clear()
          } catch (reapplyError: unknown) {
            await guard.markRollbackRequired(pending).catch(() => undefined)
            throw new AcpModelSwitchLockedError(
              'rollback-failed',
              `dsh-acp: recovering the interrupted model switch failed to apply "${appliedModel}" on the Agent ` +
              `(${errorChain(reapplyError)}); the session is locked — open the model picker to resolve it, ` +
              'discard the ACP context and reopen it, or start a new session',
            )
          }
        } else {
          // 值集合越出 {previous, target} 或 started 行双侧都动过：无法自证
          throw new AcpModelSwitchLockedError(
            'undecidable',
            `dsh-acp: the interrupted model switch (${pending.previousModel} → ${pending.targetModel}) cannot be reconciled ` +
            `(DSH selects "${dshModel}", the Agent reports "${agentModel}"); the session is locked — ` +
            'open the model picker to choose a recovery, discard the ACP context and reopen it, or start a new session',
          )
        }
      }
    }

 // 3b. 持久 route 建立后模型写不再经原生路径重申（coordinator 是唯一热切换入口）。无待定
 // 行而双侧值仍不同：会话建立时已做过一次性模型收敛
    //     （./agent.ts convergeModelAtEstablishment——建立后、首个 prompt 前把
    //     DSH 选定值单向应用到 Agent），此处仍分叉即那次收敛被拒/失败
    //     （Agent 未暴露可写模型项、目标值不在允许集或写入未获确认；分叉说明
    //     已在建立时落盘）——一次性如实提示，不写 Agent（写了就是第二写路径复活）。
    if (merged.model !== currentAcpModel()) {
      warnOnce(
        'model-diverged',
        `dsh-acp: the native selection points at model "${merged.model}" but the ACP session is on "${currentAcpModel()}"; ` +
        'the establish-time model convergence was declined or failed (the agent did not accept the selected model), and ' +
        'model switches for ACP sessions only go through the model picker (ModelSwitchCoordinator) — the divergence was left as-is',
      )
    }

    // 4. Reasoning effort ⇒ thought_level. `merged.reasoningEffort` is defined
    //    exactly when the user explicitly selected an effort (the listener
    //    strips inherited effort otherwise), so undefined means "leave the ACP
    //    side as-is". The snapshot is RE-READ here: a model switch above may
    //    have cascade-changed the thought_level option (response-authoritative
    //    replacement, session option synchronization contract).
    const effort = merged.reasoningEffort
    if (effort !== undefined) {
      const option = thoughtLevelOptionOf(agent.configOptions)
      if (option === undefined) {
        infoOnce(
          'no-thought-level',
          `dsh-acp: native reasoning effort "${effort}" cannot apply; the agent exposes no thought_level config option`,
        )
      } else if (option.type !== 'select') {
        warnOnce('thought-level-non-select', 'dsh-acp: the thought_level config option is not a select; native reasoning effort was ignored')
      } else if (!selectValuesOf(option).includes(effort)) {
        warnOnce(
          'effort-unlisted',
          `dsh-acp: native reasoning effort "${effort}" is not among the agent's thought_level values and was ignored`,
        )
      } else if (option.currentValue !== effort) {
        await agent.setConfigOption(option.id, effort, { signal })
      }
    }
  }

  return {
    syncBeforeTurn(coords: AcpSyncCoords = {}): Promise<void> {
      inFlight ??= doSync(coords).finally(() => {
        inFlight = undefined
      })
      return inFlight
    },

    async applyLiveChange(configId: string, value: string | boolean): Promise<void> {
      // Idle-only (session option synchronization contract MVP); the seam re-checks at the execution point.
      if (agent.status !== 'idle') {
        throw new AcpOptionsSyncError(
          'busy',
          `dsh-acp: configuration changes are only allowed while idle (agent "${agent.id}" is ${agent.status})`,
        )
      }
      const options = agent.configOptions
      const option = options?.find((candidate) => candidate.id === configId)
      if (option === undefined) {
 // Legacy fallback: no mirrored mode config option, but the agent
        // exposes legacy modes state ⇒ the dedicated set_mode RPC still works
        // (degradation matrix). This is the ONLY set_mode path — an advertised
        // mode-class config option writes through set_config_option below.
        if (configId === ACP_MODE_OPTION_ID && agent.currentModeId !== undefined) {
          if (typeof value !== 'string') {
            throw new AcpOptionsSyncError(
              'invalid-value',
              `dsh-acp: legacy session/set_mode takes a string mode id; got ${JSON.stringify(value)}`,
            )
          }
          await agent.setMode(value)
          return
        }
        if (options === undefined) {
          throw new AcpOptionsSyncError(
            'unavailable',
            `dsh-acp: agent "${agent.id}" exposes no session config options; the ACP selector block stays hidden (degradation matrix)`,
          )
        }
        throw new AcpOptionsSyncError(
          'unknown-option',
          `dsh-acp: unknown config option "${configId}"; available: ${options.map((candidate) => candidate.id).join(', ')}`,
        )
      }
 // Value validation by option type ( type fidelity: booleans arrive and
      // leave as booleans, never 'true'/'false' strings). Unknown/future types
      // are refused on the write path (session option synchronization contract: unknown types are ignored,
      // the agent default stands — there is nothing meaningful to set). The
      // const alias keeps the SDK's closed union narrowable while the else
      // branch stays runtime-defensive for types a newer agent may send.
      const optionType = option.type
      if (optionType === 'select') {
        const values = selectValuesOf(option)
        if (typeof value !== 'string' || !values.includes(value)) {
          throw new AcpOptionsSyncError(
            'invalid-value',
            `dsh-acp: invalid value ${JSON.stringify(value)} for config option "${configId}"; allowed: ${values.join(', ')}`,
          )
        }
      } else if (optionType === 'boolean') {
        if (typeof value !== 'boolean') {
          throw new AcpOptionsSyncError(
            'invalid-value',
            `dsh-acp: invalid value ${JSON.stringify(value)} for boolean config option "${configId}"; allowed: true, false`,
          )
        }
      } else {
        throw new AcpOptionsSyncError(
          'unsupported-type',
          `dsh-acp: config option "${configId}" has unsupported type "${String(optionType)}"; only select/boolean writes are defined`,
        )
      }
      // Every advertised config option writes through set_config_option —
 // mode-class included (: config options supersede session/set_mode;
      // the value was validated against the option's own select list above).
      await agent.setConfigOption(configId, value)
    },
  }
}
