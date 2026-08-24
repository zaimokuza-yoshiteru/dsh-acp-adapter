/**
 * Live options slice of the picker seat store: state migrated verbatim
 * from the former selector-controller.ts `LiveOptionsState`, transitions
 * extracted as pure draft mutators. The optimistic switch vocabulary mirrors
 * the glue's flow: switchStarted (optimistic value + busy latch) →
 * switchSettled (adopt the response snapshot) | switchFailed (roll back to the
 * pre-switch baseline) → switchFinished (latch off). 起删除
 * syncWarning——模型切换不再经本 slice（唯一入口是 ModelSwitchCoordinator，
 * DSH 侧 selectModel 是事务的一步，不再有「切换成功但同步失败」的半成品态）。
 * @module @zaimokuza/dsh-acp-adapter/client/stores/live-options-store
 */

import { withLiveOptionValue } from '../selector-logic.ts'
import type { LiveOptionsSnapshot } from '../selector-logic.ts'

/** Live options slice state (unchanged shape from the pre-store controller). */
export interface LiveOptionsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: LiveOptionsSnapshot | null
  error: string | null
 /** error 的来源（UI 文案分流：加载失败 vs 切换被拒—— idle-only 的 409 busy 原因要如实显示；rebind = 重开失败， 收尾）。 */
  errorSource: 'load' | 'switch' | 'rebind' | null
  /** 正在切换的 configId（切换期间对应行禁用）。 */
  switching: string | null
 /** rebindBlank 在飞（收尾：连续性逃生按钮的在飞闩锁，期间按钮禁用）。 */
  rebinding: boolean
}

/** Fresh pre-first-load slice value (a lambda: per-instance freshness). */
export const initialLiveOptionsState = (): LiveOptionsState => ({
  status: 'idle',
  snapshot: null,
  error: null,
  errorSource: null,
  switching: null,
  rebinding: false,
})

/** The live slice's complete write set (draft mutators over the slice). */
export const liveTransitions = {
  /** A dshAcp Remote load started (concurrent loads fold in the glue). */
  loadStarted(draft: LiveOptionsState): void {
    draft.status = 'loading'
    draft.error = null
    draft.errorSource = null
  },
  /** A load landed: adopt the decoded snapshot wholesale. */
  loaded(draft: LiveOptionsState, snapshot: LiveOptionsSnapshot): void {
    draft.status = 'ready'
    draft.snapshot = snapshot
    draft.error = null
    draft.errorSource = null
  },
  /** A load failed: surface the message, tagged for the load-failure copy. */
  loadFailed(draft: LiveOptionsState, message: string): void {
    draft.status = 'error'
    draft.error = message
    draft.errorSource = 'load'
  },
  /**
   * A switch started: optimistic value application (withLiveOptionValue keeps
   * the POST vocabulary — string value ids for select rows, real booleans for
   * boolean rows), busy latch on, stale diagnostics cleared.
   */
  switchStarted(draft: LiveOptionsState, configId: string, value: string | boolean): void {
    if (draft.snapshot !== null) {
      draft.snapshot = withLiveOptionValue(draft.snapshot, configId, value)
    }
    draft.switching = configId
    draft.error = null
    draft.errorSource = null
  },
  /** The POST landed: adopt the response snapshot (agent side-effects included). */
  switchSettled(draft: LiveOptionsState, snapshot: LiveOptionsSnapshot): void {
    draft.snapshot = snapshot
  },
  /** The POST failed: roll back to the pre-switch baseline, tagged for the switch-refused copy. */
  switchFailed(draft: LiveOptionsState, baseline: LiveOptionsSnapshot, message: string): void {
    draft.snapshot = baseline
    draft.switching = null
    draft.error = message
    draft.errorSource = 'switch'
  },
  /** The switch flow ended: busy latch off. */
  switchFinished(draft: LiveOptionsState): void {
    draft.switching = null
  },
 /** rebindBlank started（收尾：在飞闩锁 + 清掉过期诊断）。 */
  rebindStarted(draft: LiveOptionsState): void {
    draft.rebinding = true
    draft.error = null
    draft.errorSource = null
  },
  /** rebindBlank landed: adopt the reset snapshot wholesale（continuity 应已归 ok）。 */
  rebindSettled(draft: LiveOptionsState, snapshot: LiveOptionsSnapshot): void {
    draft.status = 'ready'
    draft.snapshot = snapshot
    draft.rebinding = false
    draft.error = null
    draft.errorSource = null
  },
  /** rebindBlank failed: 快照不动（闩锁状态如实保留），错误落 rebind 文案位。 */
  rebindFailed(draft: LiveOptionsState, message: string): void {
    draft.rebinding = false
    draft.error = message
    draft.errorSource = 'rebind'
  },
  /** Connection reset: drop the previous host generation's projection. */
  reset(draft: LiveOptionsState): void {
    Object.assign(draft, initialLiveOptionsState())
  },
}
