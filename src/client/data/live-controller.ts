/**
 * Live options glue ( split from selector-controller.ts): the dshAcp
 * Remote namespace's optimistic refresh + rollback（replaced the
 * bypass-endpoint fetches；** 删除 model 类写分支**——模型热切换的唯一
 * 入口是 ModelSwitchCoordinator（./model-switch-controller.ts）的持久事务，
 * 旧「setOption + 原生 selection 同步 + syncWarning」半成品流已删除）。
 * State migrated into the picker store's live slice (stores/live-options-store.ts);
 * this class owns the authoritative private copy (the rollback baseline and
 * switch guards read it) and mirrors every transition through the baked
 * actions bound at `attach` time.
 * @module @zaimokuza/dsh-acp-adapter/client/live-controller
 */

import { errorMessageOf } from './logic.ts'
import {
  decodeLiveOptionsSnapshot,
  isModelClassLiveOption,
  withLiveOptionValue,
} from './selector-logic.ts'
import type { LiveOptionsSnapshot } from './selector-logic.ts'
import type { AcpRemoteLike } from './acp-remote.ts'
import { initialLiveOptionsState } from './stores/live-options-store.ts'
import type { LiveOptionsState } from './stores/live-options-store.ts'
import type { LiveStoreActions } from './stores/picker-store.ts'

export interface LiveOptionsControllerDeps {
  sessionId: string
 /** The mounted dshAcp remote namespace; see ./acp-remote.ts. */
  remote: AcpRemoteLike
}

export class LiveOptionsController {
  private state: LiveOptionsState = initialLiveOptionsState()
  private sink: LiveStoreActions | null = null
  private inflight: Promise<void> | null = null
  /**
 * 状态变更监听器（composer dock 的 ACP context 统计行是无 store seat
   * 的 list 槽组件，经本通道订阅快照变化；setState 每次发布同步通知）。
   */
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: LiveOptionsControllerDeps) {}

  /** Bind the framework-baked store actions and replay the authoritative slice (see directory-controller). */
  attach(actions: LiveStoreActions): void {
    this.sink = actions
    this.sink.liveReplaced(this.state)
  }

  /** @returns the authoritative snapshot (stable reference between transitions). */
  getSnapshot(): LiveOptionsState {
    return this.state
  }

  /**
 * 订阅状态变更（dock 组件的通道；读侧配 {@link LiveOptionsController.getSnapshot}）。
   * @param fn - change callback（同步通知）。
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  async load(): Promise<void> {
    if (this.inflight) return this.inflight
    this.setState({ ...this.state, status: 'loading', error: null, errorSource: null }, (sink) => { sink.liveLoadStarted() })
    this.inflight = (async () => {
      try {
        const result = await this.deps.remote.options(this.deps.sessionId)
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        const decoded = decodeLiveOptionsSnapshot(result.value)
        if (decoded === undefined) {
          throw new Error('invalid options payload')
        }
        this.setState({
          ...this.state,
          status: 'ready',
          snapshot: decoded,
          error: null,
          errorSource: null,
        }, (sink) => { sink.liveLoaded(decoded) })
      } catch (error) {
        const message = errorMessageOf(error)
        this.setState({
          ...this.state,
          status: 'error',
          error: message,
          errorSource: 'load',
        }, (sink) => { sink.liveLoadFailed(message) })
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  /**
   * 切换一个活体选项：乐观应用 → `dshAcp/setOption` → 失败回滚，成功后按响应
 * 快照收敛。写词汇与 contract `AcpOptionWrite` 一致（类型保真）：
   * select 选项收 string 值 id，boolean 选项收原生 boolean（不再是
   * 'true'/'false' 字符串）。
   *
   * 防御性守卫（正常 UI 已前置拦截，此处是纵深防线）：
 * - stale 快照（`editable === false`）一律拒发——stale 绝不授权热切换；
 * - model 类选项一律拒发——模型切换走 ModelSwitchCoordinator 的持久事务。
   */
  async switchOption(configId: string, value: string | boolean): Promise<void> {
    const baseline = this.state.snapshot
    if (!baseline?.configOptions || this.state.switching !== null) return
    const option = baseline.configOptions.find((candidate) => candidate.id === configId)
    if (!option) return
    if (baseline.editable === false || baseline.freshness === 'stale') {
      this.setState({
        ...this.state,
        error: 'the options snapshot is a read-only last-known copy; resume the agent (send a message) to edit',
        errorSource: 'switch',
      }, (sink) => { sink.liveSwitchFailed(baseline, 'read-only snapshot') })
      return
    }
    if (isModelClassLiveOption(option)) {
      this.setState({
        ...this.state,
        error: 'model-class options are switched via the model picker (journaled transaction), not the live control pane',
        errorSource: 'switch',
      }, (sink) => { sink.liveSwitchFailed(baseline, 'model-class refused') })
      return
    }

    this.setState({
      ...this.state,
      snapshot: withLiveOptionValue(baseline, configId, value),
      switching: configId,
      error: null,
      errorSource: null,
    }, (sink) => { sink.liveSwitchStarted(configId, value) })
    try {
      const result = await this.deps.remote.setOption(this.deps.sessionId, { configId, value })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      const decoded = decodeLiveOptionsSnapshot(result.value)
      if (decoded === undefined) {
        throw new Error('invalid options payload')
      }
      this.setState({ ...this.state, snapshot: decoded }, (sink) => { sink.liveSwitchSettled(decoded) })
    } catch (error) {
      // 失败回滚：恢复切换前快照并展示错误（errorSource='switch'——UI 文案与
 // 加载失败分流， idle-only 的 409 busy 原因在此如实显示）
      const message = errorMessageOf(error)
      this.setState({
        ...this.state,
        snapshot: baseline,
        switching: null,
        error: message,
        errorSource: 'switch',
      }, (sink) => { sink.liveSwitchFailed(baseline, message) })
      return
    }
    this.setState({ ...this.state, switching: null }, (sink) => { sink.liveSwitchFinished() })
  }

  /**
 * 采纳一份外部流程拿到的权威快照（ModelSwitchCoordinator 的
   * begin/commit 响应快照直通；不触发任何写）。与 load 成功同款收敛。
   */
  applySnapshot(snapshot: LiveOptionsSnapshot): void {
    this.setState({
      ...this.state,
      status: 'ready',
      snapshot,
      error: null,
      errorSource: null,
    }, (sink) => { sink.liveLoaded(snapshot) })
  }

  /**
 * rebindBlank 逃生门（收尾；reconciliation-required 的可执行出路）：仅在
   * 连续性闩锁 blocked 且不在飞时发起 `dshAcp/rebindBlank`；成功按响应快照收敛
   * （continuity 应已归 ok），失败快照不动、错误落 rebind 文案位（errorSource
   * = 'rebind'——与加载失败/切换被拒三分流）。
   */
  async rebind(): Promise<void> {
    if (this.state.snapshot?.continuity.status !== 'blocked' || this.state.rebinding) return
    this.setState({ ...this.state, rebinding: true, error: null, errorSource: null }, (sink) => { sink.liveRebindStarted() })
    try {
      const result = await this.deps.remote.rebindBlank(this.deps.sessionId)
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      const decoded = decodeLiveOptionsSnapshot(result.value)
      if (decoded === undefined) {
        throw new Error('invalid options payload')
      }
      this.setState({
        ...this.state,
        status: 'ready',
        snapshot: decoded,
        rebinding: false,
        error: null,
        errorSource: null,
      }, (sink) => { sink.liveRebindSettled(decoded) })
    } catch (error) {
      const message = errorMessageOf(error)
      this.setState({
        ...this.state,
        rebinding: false,
        error: message,
        errorSource: 'rebind',
      }, (sink) => { sink.liveRebindFailed(message) })
    }
  }

  /** host 重启/连接重置：丢弃上一 host 世代的投影。 */
  resetConnected(): void {
    this.setState(initialLiveOptionsState(), (sink) => { sink.liveReset() })
  }

  /** Authority first, mirror second (attach 与否都维护私有权威态——popup 路径无 store）。 */
  private setState(next: LiveOptionsState, mirror: (sink: LiveStoreActions) => void): void {
    this.state = next
    if (this.sink !== null) mirror(this.sink)
    for (const listener of this.listeners) listener()
  }
}
