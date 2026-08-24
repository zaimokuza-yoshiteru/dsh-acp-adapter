// teardown.spec.ts — 强制拆除的两道有界闸（fake seam / fake machine 驱动，
// 不真对抗 SIGKILL）：
//   1. AcpAgentProcess 拆除梯子末级：terminate 后的 waitForExit 有界
//      （exitWaitMs）——窗口耗尽（假进程永不退出）时 onProcessWarn 响亮告警并
//      resolve，close 不被挂死、保持幂等；
//   2. host-compat/agent-loop.ts 的 dispose idle 闸（差异 4）：machine.whenIdle //      永不收敛时 dispose 在 idleTimeoutMs 预算内完成——告警回调触发、
//      scope.dispose 照常执行；正常收敛路径不告警。

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentOptions } from '@deepseek-ai/dsh-agent';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import {
  AcpFactoryOwnership,
  DISPOSE_IDLE_TIMEOUT_MS,
  prepareAcpLifecycle,
} from '../../../src/host-compat/agent-loop.ts';
import type { AcpLifecycleMachine, AcpLoopInternals } from '../../../src/host-compat/agent-loop.ts';
import { AcpAgentProcess, DEFAULT_EXIT_WAIT_MS } from '../../../src/runtime/process/agent-process.ts';
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('拆除梯子末级：有界 waitForExit（exitWaitMs）', () => {
  /** 永不退出的假进程：done/waitForExit 永不 settle（waitForExit 带 signal 时响应 abort，模拟真实 seam 的限时臂）。 */
  function fakeNeverExitingSeam(): { seam: SubprocessSeam; handle: AcpSubprocessHandle } {
    const handle: AcpSubprocessHandle = {
      pid: 987654,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: new Promise(() => {}),
      terminate: vi.fn(),
      waitForExit: (signal?: AbortSignal) => signal === undefined
        ? new Promise<boolean>(() => {})
        : new Promise<boolean>((resolve) => {
          if (signal.aborted) {
            resolve(false);
            return;
          }
          signal.addEventListener('abort', () => { resolve(false); }, { once: true });
        }),
    };
    const seam: SubprocessSeam = {
      spawn: () => handle,
      resolveExecutable: () => Promise.resolve('/fake/agent'),
    };
    return { seam, handle };
  }

  it('预算常量钉版：exitWaitMs 默认 10s', () => {
    expect(DEFAULT_EXIT_WAIT_MS).toBe(10_000);
  });

  it('SIGKILL 后仍不退出（内核级异常模拟）：有界 waitForExit 超时 → 响亮告警 → close resolve 且幂等', async () => {
    const { seam, handle } = fakeNeverExitingSeam();
    const warnings: string[] = [];
    const proc = new AcpAgentProcess(
      { argv: ['fake-agent'], cwd: '/tmp', env: {}, subprocess: seam },
      { eofGraceMs: 20, exitWaitMs: 60, onProcessWarn: (message) => { warnings.push(message); } },
    );
    const t0 = Date.now();
    const first = proc.close();
    const second = proc.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    const elapsed = Date.now() - t0;
    // 总预算 = eofGrace(20) + exitWait(60) + 退出事实兜底窗(500)；绝不挂死
    expect(elapsed).toBeLessThan(2_000);
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('did not exit within 60ms');
    expect(warnings[0]).toContain('fake-agent');
    expect(warnings[0]).toContain('987654');
    // 未拿到退出事实：exited 仍 null（如实，不伪造）
    expect(proc.exited).toBeNull();
  });

  it('waitForExit 在窗口内返回 true：不告警，等退出事实就位后 resolve', async () => {
    const { handle } = fakeNeverExitingSeam();
    // 窗口内退出：waitForExit 10ms 返 true、done 15ms 以退出事实 settle
    const exitedHandle: AcpSubprocessHandle = {
      ...handle,
      terminate: vi.fn(),
      // 带 signal（第 1 级 EOF 窗口）时响应 abort 返 false；裸调用（terminate 后）10ms 返 true
      waitForExit: (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal !== undefined) {
          if (signal.aborted) { resolve(false); return; }
          signal.addEventListener('abort', () => { resolve(false); }, { once: true });
          return;
        }
        setTimeout(() => { resolve(true); }, 10);
      }),
      done: new Promise((resolve) => {
        setTimeout(() => { resolve({ exitCode: null, signal: 'SIGKILL' }); }, 15);
      }),
    };
    const quickSeam: SubprocessSeam = { spawn: () => exitedHandle, resolveExecutable: () => Promise.resolve('/fake/agent') };
    const warnings: string[] = [];
    const proc = new AcpAgentProcess(
      { argv: ['fake-agent'], cwd: '/tmp', env: {}, subprocess: quickSeam },
      { eofGraceMs: 5, exitWaitMs: 500, onProcessWarn: (message) => { warnings.push(message); } },
    );
    await proc.close();
    expect(exitedHandle.terminate).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
    expect(proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });
});

describe('dispose 的 whenIdle 有界闸（host-compat 差异 4）', () => {
  it('预算常量钉版：DISPOSE_IDLE_TIMEOUT_MS 默认 10s', () => {
    expect(DISPOSE_IDLE_TIMEOUT_MS).toBe(10_000);
  });

  interface FakeMachine {
    cancel: ReturnType<typeof vi.fn>;
    whenIdle: () => Promise<void>;
    scope: { dispose: ReturnType<typeof vi.fn> };
  }

  function fakeInternals(): { internals: AcpLoopInternals; ownerCtx: Context } {
    const ownership = new AcpFactoryOwnership({ state: 1 } as Context['fiber']);
    const loopCtx = {} as Context;
    const ownerCtx = {
      fiber: { assertActive: () => {} },
      effect: () => () => {},
    } as unknown as Context;
    return { internals: { loopCtx, ownership }, ownerCtx };
  }

  function prepareWith(machine: FakeMachine, gate?: { idleTimeoutMs?: number; onIdleTimeout?: (message: string) => void }) {
    const { internals, ownerCtx } = fakeInternals();
    return prepareAcpLifecycle(
      internals,
      ownerCtx,
      'fake-session' as SessionId,
      {} as AgentOptions,
      {} as Session,
      undefined,
      () => machine as unknown as AcpLifecycleMachine,
      gate,
    );
  }

  it('whenIdle 永不收敛（失控 agent）：dispose 在闸预算内完成——告警 + scope.dispose 照常 + cancel(disposed) 已发', async () => {
    const machine: FakeMachine = {
      cancel: vi.fn(),
      whenIdle: () => new Promise<void>(() => {}),
      scope: { dispose: vi.fn(() => Promise.resolve()) },
    };
    const stalls: string[] = [];
    const prepared = prepareWith(machine, { idleTimeoutMs: 60, onIdleTimeout: (message) => { stalls.push(message); } });
    const t0 = Date.now();
    await prepared.dispose();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(machine.cancel).toHaveBeenCalledWith({ kind: 'disposed' });
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain('did not become idle within 60ms');
    expect(stalls[0]).toContain('fake-session');
    // 闸超时后拆卸继续：scope.dispose 照常执行
    expect(machine.scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('whenIdle 正常收敛：不告警，dispose 按原次序完成', async () => {
    const machine: FakeMachine = {
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      scope: { dispose: vi.fn(() => Promise.resolve()) },
    };
    const stalls: string[] = [];
    const prepared = prepareWith(machine, { idleTimeoutMs: 500, onIdleTimeout: (message) => { stalls.push(message); } });
    await prepared.dispose();
    expect(machine.cancel).toHaveBeenCalledWith({ kind: 'disposed' });
    expect(stalls).toEqual([]);
    expect(machine.scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose 幂等：两次调用共享同一份完成，闸只触发一次', async () => {
    const machine: FakeMachine = {
      cancel: vi.fn(),
      whenIdle: () => new Promise<void>(() => {}),
      scope: { dispose: vi.fn(() => Promise.resolve()) },
    };
    const stalls: string[] = [];
    const prepared = prepareWith(machine, { idleTimeoutMs: 60, onIdleTimeout: (message) => { stalls.push(message); } });
    const first = prepared.dispose();
    const second = prepared.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await sleep(20);
    expect(stalls).toHaveLength(1);
    expect(machine.scope.dispose).toHaveBeenCalledTimes(1);
  });
});
