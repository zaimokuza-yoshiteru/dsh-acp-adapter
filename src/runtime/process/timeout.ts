/** Bounded waits retain ACP's timeout-as-undefined settlement semantics. */
/// <reference types="node" />
import { clearTimeout, setTimeout } from 'node:timers'

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
