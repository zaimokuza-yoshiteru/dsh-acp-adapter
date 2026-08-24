/**
 * ModelSwitchController：同 profile 模型热切换的
 * client 侧协调器——**唯一**驱动模型切换的入口（旧两条写路径已删除：
 * LiveOptionsController.switchOption 的 model 分支 + SessionModelDirectory.select
 * 的 ACP 直通 + options-sync 的 model 重申）。
 *
 * 事务流程（host 侧持久状态机见 src/remote/service.ts 与
 * src/persistence/sidecar.ts `model_switches` 表）：
 * 1. 预检：live 快照在场且 freshness 'live' + editable（stale 快照绝不授权
 *    热切换）；model 类 select option 在场；target ∈ 目录目录组 ∩ option
 *    allowed values（交集判定在 client，host 侧仍强制 allowed-values 校验）；
 * 2. `dshAcp/beginModelSwitch`（uuid operationId，重复投递幂等）——host 落
 *    `started` → ACP set_config_option → 读 actualModel → 落 `agent-applied`；
 * 3. DSH 侧 `session.selectModel(actualModel)`（必须用 host 回报的 actualModel，
 *    不得用请求值——Agent 可能归一化/改写）；**DSH 拒绝 →
 *    `rollbackModelSwitch` 补偿臂**；
 * 4. `dshAcp/commitModelSwitch` 收束（写 committed 后清行）；commit 响应丢失
 *    不翻转结局——DSH 已接受，遗留行由 {@link ModelSwitchController.recover}
 *    或下个 turn 的 options-sync 守卫收敛。
 *
 * 崩溃恢复（{@link recover}）：live 快照的 `modelSwitch` 视图为 pending 时，
 * 按纯函数 `decideModelSwitchRecovery`（selector-logic.ts）的决策收敛——只
 * 收敛到可证明的状态；undecidable/wait-resume 不做任何写（live 时 composer
 * 已由 publishBlock 阻断，用户可选择回滚或 rebind）。
 *
 * @module @zaimokuza/dsh-acp-adapter/client/model-switch-controller
 */

import { errorMessageOf } from './logic.ts'
import {
  decideModelSwitchRecovery,
  decodeLiveOptionsSnapshot,
  flattenLiveValues,
  isModelClassLiveOption,
} from './selector-logic.ts'
import type { LiveConfigOption, LiveOptionsSnapshot, PickerModelSelection } from './selector-logic.ts'
import type { AcpRemoteLike } from './acp-remote.ts'
import { wireFailure } from './picker-wire.ts'
import type { SessionsWireLike } from './picker-wire.ts'
import type { LiveOptionsController } from './live-controller.ts'
import type { SessionModelDirectory } from './directory-controller.ts'

export interface ModelSwitchControllerDeps {
  sessionId: string
  remote: AcpRemoteLike
  sessions: SessionsWireLike
  directory: SessionModelDirectory
  live: LiveOptionsController
}

/** live 快照里的 model 类 select option（无 → undefined；快照无 options 亦 undefined）。 */
function liveModelOptionOf(snapshot: LiveOptionsSnapshot): (LiveConfigOption & { type: 'select' }) | undefined {
  const option = snapshot.configOptions?.find((candidate) => isModelClassLiveOption(candidate))
  return option?.type === 'select' ? option : undefined
}

export class ModelSwitchController {
  /** 在飞闩锁（client 侧第一道闸；host 侧另有进程内闩锁 + 持久行兜底）。 */
  private inflight = false

  constructor(private readonly deps: ModelSwitchControllerDeps) {}

  /**
   * 同 profile 模型热切换（picker 行点击的唯一入口）。返回是否成功落地
   * （失败已把诚实文案落进目录的 select 错误位，并尽力恢复两侧一致性）。
   */
  async switchModel(selection: PickerModelSelection): Promise<boolean> {
    if (this.inflight) return false // 并发点击拒绝（幂等键在 host；client 不并发发起）
    const snapshot = this.deps.live.getSnapshot().snapshot
    // ---- 预检（stale 绝不授权热切换）----
    if (snapshot === null || snapshot.freshness !== 'live' || !snapshot.editable) {
      this.deps.directory.failSelection(
        'the options snapshot is a read-only last-known copy; resume the agent (send a message) before switching models',
      )
      return false
    }
    if (snapshot.modelSwitch.status === 'pending' || snapshot.modelSwitch.status === 'rollback-required' || snapshot.modelSwitch.status === 'corrupt') {
      this.deps.directory.failSelection(
        'an earlier model switch is still unresolved; resolve or roll it back before switching again',
      )
      return false
    }
    const option = liveModelOptionOf(snapshot)
    if (option === undefined) {
      this.deps.directory.failSelection('the agent exposes no model-class config option; hot model switching is not available')
      return false
    }
    const allowed = new Set(flattenLiveValues(option).map((row) => row.value))
    // target ∈ 目录组 ∩ allowed values（目录组存在性是同 provider 路由的前提）
    const group = this.deps.directory.getSnapshot().groups.find((candidate) => candidate.id === selection.provider)
    if (group === undefined || !group.models.some((model) => model.id === selection.model) || !allowed.has(selection.model)) {
      this.deps.directory.failSelection(`"${selection.model}" is not switchable for this session (not in the catalog ∩ the agent's selectable values)`)
      return false
    }
    if (option.currentValue === selection.model) return true // 无操作

    this.inflight = true
    this.deps.directory.beginSelection()
    const operationId = globalThis.crypto.randomUUID()
    try {
      // ---- ① host 事务：persist started → set_config_option → actualModel → agent-applied ----
      let begun: Awaited<ReturnType<AcpRemoteLike['beginModelSwitch']>>
      try {
        begun = await this.deps.remote.beginModelSwitch(this.deps.sessionId, {
          operationId,
          targetModel: selection.model,
        })
      } catch (error) {
        // A transport exception is not a business rejection: the host may have
        // persisted started/agent-applied after the response was lost. Keep the
        // journal for reconciliation and make the directory leave `selecting`.
        this.deps.directory.failSelection(`model switch outcome could not be confirmed: ${errorMessageOf(error)}`)
        await this.refreshLive()
        return false
      }
      if (!begun.ok) {
        this.deps.directory.failSelection(begun.error.message)
        await this.refreshLive()
        return false
      }
      const beginSnapshot = decodeLiveOptionsSnapshot(begun.value.snapshot)
      if (beginSnapshot === undefined) {
        this.deps.directory.failSelection('invalid options payload')
        await this.refreshLive()
        return false
      }
      this.deps.live.applySnapshot(beginSnapshot)
      const actualModel = begun.value.actualModel

      // ---- ② DSH 侧采纳（actualModel，不是请求值）；拒绝 → 补偿回滚 ----
      let selected: PickerModelSelection
      let dshResponse: Awaited<ReturnType<SessionsWireLike['selectModel']>>
      try {
        dshResponse = await this.deps.sessions.selectModel({
          sessionId: this.deps.sessionId,
          provider: selection.provider,
          model: actualModel,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        })
      } catch (error) {
        // A thrown Promise is an ambiguous transport outcome. DSH may already
        // have accepted the selection, so compensating the Agent here would
        // manufacture a split-brain state. Leave agent-applied pending and
        // keep the composer blocked until recover can read both sides.
        this.deps.directory.failSelection(`model switch outcome could not be confirmed: ${errorMessageOf(error)}`)
        await this.refreshLive()
        return false
      }
      if (!dshResponse.result.ok) {
        // Only an explicit host rejection proves that DSH stayed on previous.
        // DSH 拒绝：Agent 已在 target。先把 Agent 推进到 agent-rolled-back；
        // DSH 本次采纳失败意味着它仍在 previous，故可立即 finalize。任一步
        // 失败都保留 pending/rollback-required，绝不提前解锁。
        const rolledBack = await this.deps.remote
          .rollbackModelSwitch(this.deps.sessionId, { operationId })
          .catch(() => undefined)
        if (rolledBack?.ok === true) {
          await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId }).catch(() => undefined)
        }
        this.deps.directory.failSelection(dshResponse.result.error.message)
        await this.refreshLive()
        return false
      }
      selected = dshResponse.result.value.selected

      // ---- ③ 收束：commit（响应丢失不翻转结局——恢复路径会收敛遗留行） ----
      let committed: Awaited<ReturnType<AcpRemoteLike['commitModelSwitch']>>
      try {
        committed = await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId })
      } catch {
        // DSH and Agent have both completed their main action. Adopt DSH's
        // selected value but retain the host journal for a later finalize.
        this.deps.directory.applySyncedSelection(selected)
        await this.refreshLive()
        return true
      }
      if (!committed.ok) {
        this.deps.directory.applySyncedSelection(selected)
        await this.refreshLive()
        return true
      }
      const commitSnapshot = decodeLiveOptionsSnapshot(committed.value)
      if (commitSnapshot !== undefined) this.deps.live.applySnapshot(commitSnapshot)
      this.deps.directory.applySyncedSelection(selected)
      return true
    } finally {
      this.inflight = false
    }
  }

  /**
   * 崩溃恢复（prime 时 live.load 成功后调用）：pending 行按
   * `decideModelSwitchRecovery` 收敛；rollback-required/corrupt 不做自动动作
   * （composer 已阻断，出路是用户回滚/rebind）。任何远程失败即停——遗留行
   * 会在下次 recover / turn 守卫处再次浮现，绝不猜测。
   */
  async recover(): Promise<void> {
    const snapshot = this.deps.live.getSnapshot().snapshot
    if (snapshot === null) return
    const view = snapshot.modelSwitch
    if (view.status !== 'pending') return
    const current = this.deps.directory.getSnapshot().current
    const dshModel = current !== null && current.provider === view.provider ? current.model : null
    const liveOption = snapshot.freshness === 'live' ? liveModelOptionOf(snapshot) : undefined
    const appliedModel = view.appliedModel ?? view.targetModel
    const decision = decideModelSwitchRecovery({
      previousModel: view.previousModel,
      targetModel: appliedModel,
      dshModel,
      agentModel: liveOption?.currentValue ?? null,
    })
    if (decision === 'wait-resume' || decision === 'undecidable') return
    if (decision === 'clear') {
      const result = await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId: view.operationId })
      if (result.ok) await this.refreshLive()
      return
    }
    if (decision === 'rollback-agent') {
      const result = await this.deps.remote.rollbackModelSwitch(this.deps.sessionId, { operationId: view.operationId })
      if (result.ok) {
        // Finalize is a second durable boundary; a lost response must leave
        // the agent-rolled-back row for the next recovery pass.
        await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId: view.operationId }).catch(() => undefined)
        await this.refreshLive()
      }
      return
    }
    // complete-dsh / rollback-dsh：先补 DSH 侧 selectModel，再 commit 清行
    const model = decision === 'complete-dsh' ? appliedModel : view.previousModel
    try {
      const { result } = await this.deps.sessions.selectModel({
        sessionId: this.deps.sessionId,
        provider: view.provider,
        model,
      })
      if (!result.ok) throw new Error(wireFailure(result))
      const committed = await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId: view.operationId })
      if (!committed.ok) {
        // DSH 已补齐但 finalize 失败——pending 保留，下个 recover 继续收敛。
        this.deps.directory.applySyncedSelection(result.value.selected)
        await this.refreshLive()
        return
      }
      this.deps.directory.applySyncedSelection(result.value.selected)
      await this.refreshLive()
    } catch {
      // DSH 侧补齐失败：停手（遗留行由 UI 展示 / turn 守卫兜底）
      await this.refreshLive()
    }
  }

  /**
   * 用户选择的回滚出路（rollback-required / live-undecidable 的行按钮）：
   * Agent 侧写回 previousModel 并持久化 agent-rolled-back；DSH 侧收敛成功后
   * 再 finalize 清行。DSH 失败时 pending 保留、composer 继续锁定。
   */
  async rollback(): Promise<void> {
    const snapshot = this.deps.live.getSnapshot().snapshot
    if (snapshot === null) return
    const view = snapshot.modelSwitch
    if (view.status !== 'rollback-required' && view.status !== 'pending') return
    const result = await this.deps.remote.rollbackModelSwitch(this.deps.sessionId, { operationId: view.operationId })
    if (!result.ok) {
      await this.refreshLive()
      return
    }
    const decoded = decodeLiveOptionsSnapshot(result.value)
    if (decoded !== undefined) this.deps.live.applySnapshot(decoded)
    // DSH 侧收敛到 previous；provider 始终来自持久事务行。
    const current = this.deps.directory.getSnapshot().current
    if (current === null) {
      await this.refreshLive()
      return
    }
    if (current.model !== view.previousModel || current.provider !== view.provider) {
      try {
        const adopted = await this.deps.sessions.selectModel({
          sessionId: this.deps.sessionId,
          provider: view.provider,
          model: view.previousModel,
        })
        if (!adopted.result.ok) {
          await this.refreshLive()
          return
        }
        this.deps.directory.applySyncedSelection(adopted.result.value.selected)
      } catch {
        // DSH 侧收敛失败：保留 agent-rolled-back 行，等待下次恢复。
        await this.refreshLive()
        return
      }
    }
    await this.deps.remote.commitModelSwitch(this.deps.sessionId, { operationId: view.operationId }).catch(() => undefined)
    await this.refreshLive()
  }

  /** 重新拉取 live 快照（recover/rollback 后刷新 modelSwitch 视图与 banner）。 */
  private async refreshLive(): Promise<void> {
    await this.deps.live.load().catch(() => undefined)
  }
}
