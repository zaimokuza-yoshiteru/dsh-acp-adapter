import { describe, expect, it } from 'vitest';
import { waitWithin } from '../../../src/runtime/process/timeout.ts';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 永不适用的悬挂 promise（经 abort 信号收束，测试结束不留悬挂）。 */
function pendingUntil(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as unknown);
    }, { once: true });
  });
}

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
