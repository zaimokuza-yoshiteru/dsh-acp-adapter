// subprocess-seam-testing.ts — 测试基础设施：真实 subprocess-local 服务的挂载与共享。
//
// 取舍：测试消费真实 @deepseek-ai/dsh-subprocess-local 服务（devDep），不是手写假
// seam——pid 死亡/整树停稳/SIGTERM→SIGKILL 升级等断言打的是生产同款实现，且装配
// 代价实测很低（new Context + ctx.plugin 一次；prebuilt 原生件无需 build script）。
//
// 共享单例：LocalSubprocessRuntime 挂进程级 'exit' 监听（宿主退出阶段同步强杀托管
// 树的兜底），每 spec 文件只挂载一次（模块级懒单例 + 本模块顶层 afterAll 一次性
// dispose）；harness 间经 ctx.provide('subprocess', raw) 共享同一实例，监听器数量
// 不随 harness 数增长。

import { afterAll } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { narrowSubprocessSeam } from '../../src/runtime/process/subprocess.ts';
import type { SubprocessSeam } from '../../src/runtime/process/subprocess.ts';

export interface TestSubprocess {
  /** 结构化窄化后的消费面（AcpConnectionSpec.subprocess / adapter options 传它）。 */
  readonly seam: SubprocessSeam;
  /** 原始服务实例（harness 的 `ctx.provide('subprocess', raw)` 用）。 */
  readonly raw: LocalSubprocessRuntime;
  /** 卸载服务（dispose 兜底强杀全部托管进程并 await 退出）。 */
  readonly dispose: () => Promise<void>;
}

/** 挂载一次真实 subprocess-local 服务（该 Context 仅作服务载体，不参与被测组装）。 */
export async function mountTestSubprocess(): Promise<TestSubprocess> {
  const ctx = new Context();
  await ctx.plugin(LocalSubprocessRuntime);
  const holder = ctx as Context & { get(name: string): unknown };
  const raw = holder.get('subprocess');
  const seam = narrowSubprocessSeam(raw);
  if (seam === undefined) throw new Error('test subprocess mount failed: ctx.subprocess failed structural narrowing');
  return { seam, raw: raw as LocalSubprocessRuntime, dispose: () => ctx.fiber.dispose() };
}

let shared: Promise<TestSubprocess> | undefined;

// 顶层 afterAll（注册时机安全）：仅在实际挂载过时卸载。
afterAll(async () => {
  if (shared !== undefined) await (await shared).dispose();
});

/**
 * 模块级共享单例（每 spec 文件一次挂载）：首个调用懒挂载，其后复用。
 * harness 组装的 `ctx.provide('subprocess', raw)` 与各 spec 直连构造共享同一实例。
 */
export function sharedTestSubprocess(): Promise<TestSubprocess> {
  shared ??= mountTestSubprocess();
  return shared;
}
