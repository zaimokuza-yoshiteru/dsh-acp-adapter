/**
 * 超时/deadline 工具（自 acp-client.ts 切出； 扩为全包唯一原语集，
 * 统一超时约束）：各模块不再自卷 `Promise.race`/`setTimeout` 超时臂
 * （remote/service.ts 的私有 withTimeout 副本、agent-process 的限时 waitForExit
 * 均已收口到本模块）。 race 输家的 rejection 均已被 race 观察，不会泄漏为
 * unhandled。
 *
 * 原语：
 * - {@link abortAfter}：deadline(ms) + AbortSignal 组合——到点 abort，
 *   `cancel()` 清定时器（正常完成路径必须调，否则定时器滞留到触发为止）。
 * - {@link waitWithin}：限时 waitFor——窗口内 settle 回其值/其 rejection，
 *   窗口耗尽 resolve `undefined`（输家 promise 的迟到 rejection 已被 race 观察）。
 *
 * provider composition 的 raceAbort 与 dispose idle 闸语义不同于普通
 * deadline，仍由会话状态机就地持有；旧 persistence 退避 sleep 已删除。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；setTimeout/clearTimeout
 * 经 node:timers 显式导入，triple-slash reference 引入 @types/node
 * （src/protocol/v1/connection.ts 同款先例），不改动共享 tsconfig。
 * @module @zaimokuza/dsh-acp-adapter/runtime/process/timeout
 */

/// <reference types="node" />

import { clearTimeout, setTimeout } from 'node:timers'

/** {@link abortAfter} 的句柄：到点触发的 signal + 手动取消（清定时器）。 */
export interface AcpDeadline {
  readonly signal: AbortSignal
  /** 清掉未到点的定时器（幂等）；已触发后调用为 no-op。 */
  cancel(): void
}

/**
 * deadline(ms) + AbortSignal 组合：`ms` 后 `signal` 触发 abort（reason 为
 * DOMException 式 TimeoutError 之外的中性 `Error`——消费方（如 seam 的
 * waitForExit）只读 aborted 状态，不读 reason）。正常完成路径必须 `cancel()`。
 */
export function abortAfter(ms: number): AcpDeadline {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`deadline exceeded (${String(ms)}ms)`))
  }, ms)
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
    },
  }
}

/**
 * 限时 waitFor：窗口内 settle 则原样传递（值或 rejection）；窗口耗尽 resolve
 * `undefined`。输家 promise 的迟到 rejection 已被 race 订阅观察，不泄漏
 * unhandled（Promise.race 对全部输入立即挂监听）。
 */
export function waitWithin<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const window = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined)
    }, ms)
  })
  return Promise.race([operation, window]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
