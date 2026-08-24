/**
 * Session model directory glue ( split from selector-controller.ts): the
 * built-in ModelDirectory port (generation fencing against stale responses,
 * three-state routable, select-then-adopt), narrowed to structural faces.
 *
 * store discipline: the glue owns the authoritative private state (the
 * /model popup reads it through getSnapshot — no store seat exists off the
 * React tree) and mirrors every transition through the baked store actions it
 * receives at `attach` time (the seat's inject factory hands them over).
 * Attach replays the full slice (`directoryReplaced`) so a re-created entry
 * store catches up in one publish; while unattached the glue still works
 * (popup path) and simply has no mirror. `onChange` replaces the former
 * store.subscribe fan-out: PickerService's recompute trigger.
 * @module @zaimokuza/dsh-acp-adapter/client/directory-controller
 */

import { errorMessageOf } from './logic.ts'
import { INITIAL_DIRECTORY_STATE } from './selector-logic.ts'
import type {
  ModelDirectoryState,
  PickerModelSelection,
} from './selector-logic.ts'
import { wireFailure } from './picker-wire.ts'
import type { SessionsWireLike } from './picker-wire.ts'
import type { DirectoryStoreActions } from './stores/picker-store.ts'

export interface SessionModelDirectoryDeps {
  sessions: SessionsWireLike
  sessionId: string
  /** PickerService 的 recompute 触发器：每次状态转换后调用（attach 与否都触发）。 */
  onChange?(): void
}

export class SessionModelDirectory {
  private state: ModelDirectoryState = { ...INITIAL_DIRECTORY_STATE }
  private generation = 0
  private sink: DirectoryStoreActions | null = null

  constructor(private readonly deps: SessionModelDirectoryDeps) {}

  /**
   * Bind the framework-baked store actions (seat inject factory) and replay
   * the authoritative slice into the fresh store. Re-attach replaces the sink
   * and resyncs again (entry reload path).
   * @param actions - the composite store's directory slice vocabulary.
   */
  attach(actions: DirectoryStoreActions): void {
    this.sink = actions
    this.sink.directoryReplaced(this.state)
  }

  /** @returns the authoritative snapshot (stable reference between transitions). */
  getSnapshot(): ModelDirectoryState {
    return this.state
  }

  /** 刷新 advisory 目录（两个入口都在打开时调用）；失败保留最近一次成功的分组与 current。 */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.publish({ ...this.state, status: 'loading', error: null }, (sink) => { sink.directoryLoadStarted() })
    try {
      const { result } = await this.deps.sessions.models({ sessionId: this.deps.sessionId })
      if (generation !== this.generation) return
      if (!result.ok) {
        this.publish(
          { ...this.state, status: 'error', error: wireFailure(result) },
          (sink) => { sink.directoryLoadFailed(wireFailure(result)) },
        )
        return
      }
      const view = result.value
      this.publish({
        current: view.current,
        routable: view.routable,
        groups: view.groups,
        failures: view.failures,
        status: 'ready',
        error: null,
      }, (sink) => { sink.directoryLoaded(view) })
    } catch (error) {
      if (generation !== this.generation) return
      const message = errorMessageOf(error)
      this.publish({ ...this.state, status: 'error', error: message }, (sink) => { sink.directoryLoadFailed(message) })
    }
  }

  async select(selection: PickerModelSelection): Promise<void> {
    const generation = ++this.generation
    this.publish({ ...this.state, status: 'selecting', error: null }, (sink) => { sink.directorySelectStarted() })
    try {
      const { result } = await this.deps.sessions.selectModel({
        sessionId: this.deps.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      })
      if (generation !== this.generation) return
      if (!result.ok) {
        const message = wireFailure(result)
        this.publish({ ...this.state, status: 'error', error: message }, (sink) => { sink.directorySelectFailed(message) })
        throw new Error(message)
      }
      // Host 在接受前已验证路由，落地的选择按构造就是它服务得了的（内置同款：
      // 采纳 result.value.selected，不重拉）。
      const selected = result.value.selected
      this.publish({
        ...this.state,
        current: selected,
        routable: true,
        status: 'ready',
        error: null,
      }, (sink) => { sink.directorySelected(selected) })
    } catch (error) {
      if (generation !== this.generation) return
      if (this.state.status !== 'error') {
        const message = errorMessageOf(error)
        this.publish({ ...this.state, status: 'error', error: message }, (sink) => { sink.directorySelectFailed(message) })
      }
      throw error
    }
  }

  /** 活体模型切换同步原生 selection 成功后，直接采纳新 current。 */
  applySyncedSelection(selection: PickerModelSelection): void {
    this.generation += 1
    this.publish({
      ...this.state,
      current: selection,
      routable: true,
      status: 'ready',
      error: null,
    }, (sink) => { sink.directorySelected(selection) })
  }

  /**
 * ModelSwitchCoordinator 的事务开始——目录进入 selecting 闩锁（复用
   * select 的状态词；generation +1 作废在飞 load/select 的迟到响应）。
   */
  beginSelection(): void {
    this.generation += 1
    this.publish({ ...this.state, status: 'selecting', error: null }, (sink) => { sink.directorySelectStarted() })
  }

 /** coordinator 事务失败——错误落目录的 select 文案位（与 select 失败同态展示）。 */
  failSelection(message: string): void {
    this.publish({ ...this.state, status: 'error', error: message }, (sink) => { sink.directorySelectFailed(message) })
  }

  /** host 重启/连接重置：丢弃上一 host 世代的投影（调用方随后重拉）。 */
  resetConnected(): void {
    this.generation += 1
    this.publish({ ...INITIAL_DIRECTORY_STATE }, (sink) => { sink.directoryReset() })
  }

  /** Authority first, mirror second, recompute last (block/disclosure read the new state). */
  private publish(next: ModelDirectoryState, mirror: (sink: DirectoryStoreActions) => void): void {
    this.state = next
    if (this.sink !== null) mirror(this.sink)
    this.deps.onChange?.()
  }
}
