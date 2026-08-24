// timeout.spec.ts — 统一 deadline/abort 原语套件：
// src/runtime/process/timeout.ts 的 delay / withTimeout / abortAfter / waitWithin。
// 全量真实定时器（小毫秒值），不用 fake timers（本仓测试惯例）。

import { describe, expect, it } from 'vitest';
import { abortAfter, delay, waitWithin, withTimeout } from '../../../src/runtime/process/timeout.ts';

/** 永不适用的悬挂 promise（经 abort 信号收束，测试结束不留悬挂）。 */
function pendingUntil(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as unknown);
    }, { once: true });
  });
}

describe('delay', () => {
  it('到点 resolve', async () => {
    const started = Date.now();
    await delay(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe('withTimeout', () => {
  it('预算内完成：原样传递结果', async () => {
    const value = await withTimeout(delay(5).then(() => 'ok'), 100, () => new Error('boom'));
    expect(value).toBe('ok');
  });

  it('超预算：以调用方给的错误 reject', async () => {
    const controller = new AbortController();
    const attempt = withTimeout(pendingUntil(controller.signal), 20, () => new Error('too slow'));
    await expect(attempt).rejects.toThrow('too slow');
    controller.abort(); // 收束悬挂臂
  });

  it('预算内 reject：错误原样传播（不被超时臂吞掉）', async () => {
    await expect(withTimeout(Promise.reject(new Error('inner')), 100, () => new Error('boom'))).rejects.toThrow('inner');
  });
});

describe('abortAfter（deadline + AbortSignal 组合）', () => {
  it('到点触发 abort；cancel 后到点不再触发', async () => {
    const fired = abortAfter(20);
    expect(fired.signal.aborted).toBe(false);
    await delay(40);
    expect(fired.signal.aborted).toBe(true);

    const cancelled = abortAfter(20);
    cancelled.cancel();
    await delay(40);
    expect(cancelled.signal.aborted).toBe(false);
  });

  it('cancel 幂等', () => {
    const deadline = abortAfter(1000);
    deadline.cancel();
    expect(() => {
      deadline.cancel();
    }).not.toThrow();
  });
});

describe('waitWithin（限时 waitFor）', () => {
  it('窗口内 settle：传递值', async () => {
    await expect(waitWithin(delay(5).then(() => 42), 100)).resolves.toBe(42);
  });

  it('窗口内 reject：rejection 原样传播', async () => {
    await expect(waitWithin(delay(5).then(() => {
      throw new Error('inner');
    }), 100)).rejects.toThrow('inner');
  });

  it('窗口耗尽：resolve undefined（迟到 settle 被观察，不泄漏 unhandled）', async () => {
    const controller = new AbortController();
    const slow = pendingUntil(controller.signal);
    await expect(waitWithin(slow, 20)).resolves.toBeUndefined();
    controller.abort(); // 迟到 rejection：已由 race 的订阅观察
  });
});
