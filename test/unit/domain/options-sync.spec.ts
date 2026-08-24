// options-sync.spec.ts — 随附测试：原生路径 waterfall 同步 + 活体切换纯逻辑校验。
//
// 测试基建：真 cordis Context + 真 installModelSelection 监听器（@deepseek-ai/dsh-agent，
// 即 web 原生选择器的 waterfall 机制本体）+ 假 systemPrompt 服务（ctx.provide 注入，
// 内部照真实现跑 system-prompt/assemble waterfall；裸 ctx 无 dsh-scope 过滤，监听器
// 全局生效）+ 假 agent seam（结构子集，as unknown as 一次收窄；setConfigOption 模拟
// 「响应完整快照替换」契约）。
//
// 覆盖：
//   syncBeforeTurn（原生路径）
//   - 无选择 no-op：两个 waterfall 均被触发、seed = ACP 当前值、seam 零调用零提示
// - 模型分叉不再重申（coordinator 是唯一模型写入口）：零 setConfigOption，
//     一次性 warn 提示；分叉 + effort 时 effort 仍写 thought_level
//   - 未命中：model 相同 → 零调用
// - provider 非本 ACP → 响亮 throw（AcpBackendImmutableError，kind
//     protocol-error，消息含两端 backend）；不再 warn 后静默忽略
//   - 显式 reasoningEffort → thought_level setConfigOption；值不在选项内 → 跳过+提示；
//     无 thought_level option → info 一次
//   - 无 model 类 option → 一次性提示；无 configOptions 时 seed 用 options.model 兜底
//   - systemPrompt 服务缺席 → 静默 no-op；assemble 失败 → warn 后按无选择继续
//   - 并发 syncBeforeTurn 去重（共享同一次 waterfall 运行）
//   applyLiveChange（活体切换校验）
//   - select 命中（含分组值扁平化）→ setConfigOption；非法值 → invalid-value
// - 路由：mode 类 config option → setConfigOption（不经 setMode）；
//     仅无 mode config option 但有 legacy modes 状态时回退 setMode；全无 → unknown-option；
//     configOptions 全无 → unavailable
//   - boolean 原生 boolean 通过（类型保真，不收 'true'/'false' 字符串）；
//     未知 type → unsupported-type；执行中 → busy 且 seam 零调用

import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Events } from '@deepseek-ai/cordis';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type * as acp from '@agentclientprotocol/sdk';
import {
  AcpBackendImmutableError,
  AcpModelSwitchLockedError,
  AcpOptionsSyncError,
  createAcpOptionsSync,
  type AcpModelSwitchGuard,
  type AcpOptionsSyncAgent,
  type AcpOptionsSyncErrorCode,
} from '../../../src/domain/session/options-sync.ts';
import type { AcpPendingModelSwitch } from '../../../src/persistence/sidecar.ts';

type AssembleEventArgs = Parameters<Events['system-prompt/assemble']>;

const ROUTE = 'acp-test';

// ---------- 假 agent seam ----------

interface FakeAgentSpec {
  status?: 'idle' | 'running';
  /** options.model 兜底（无 configOptions 时的 ACP 当前模型）。 */
  fallbackModel?: string;
  configOptions?: acp.SessionConfigOption[];
  currentModeId?: string;
  /**
   * setConfigOption 成功后应用的响应快照（模拟 agent 连带改动）；缺省只把目标
   * option 的 currentValue 改写为新值（select 收 string、boolean 收原生 boolean）。
   */
  onSet?: (configId: string, value: string | boolean, current: readonly acp.SessionConfigOption[]) => acp.SessionConfigOption[];
}

interface SeamCall {
  method: 'setConfigOption' | 'setMode';
  args: (string | boolean)[];
}

function makeAgent(spec: FakeAgentSpec = {}) {
  const calls: SeamCall[] = [];
  const state: {
    status: 'idle' | 'running';
    configOptions: readonly acp.SessionConfigOption[] | undefined;
    currentModeId: string | undefined;
  } = {
    status: spec.status ?? 'idle',
    configOptions: spec.configOptions,
    currentModeId: spec.currentModeId,
  };
  // seam 结构子集：dispatcher 把 agent 当不透明 scope key/事件主体，其余 Agent 成员不被消费
  const seam = {
    id: 'session-1',
    options: { model: spec.fallbackModel ?? '' },
    get status() {
      return state.status;
    },
    get configOptions() {
      return state.configOptions;
    },
    get currentModeId() {
      return state.currentModeId;
    },
    async setConfigOption(configId: string, value: string | boolean): Promise<void> {
      calls.push({ method: 'setConfigOption', args: [configId, value] });
      // seam 契约（agent.ts）：成功后以响应的完整 configOptions 替换本地快照
      const current = state.configOptions ?? [];
      state.configOptions =
        spec.onSet?.(configId, value, current) ??
        current.map((option) => {
          if (option.id !== configId) return option;
          if (option.type === 'select' && typeof value === 'string') return { ...option, currentValue: value };
          if (option.type === 'boolean' && typeof value === 'boolean') return { ...option, currentValue: value };
          return option;
        });
    },
    async setMode(modeId: string): Promise<void> {
      calls.push({ method: 'setMode', args: [modeId] });
      state.currentModeId = modeId;
    },
  } as unknown as AcpOptionsSyncAgent;
  return { seam, calls, state };
}

// ---------- waterfall 基建（真 Context + 真 model-selection 监听器 + 假 systemPrompt 服务） ----------

function freshAssembly(): AssembleEventArgs[0] {
  return { sections: [], contexts: [], tools: [], variables: {} };
}

interface HarnessOptions {
  /** false = 裸 ctx 无 system-prompt 服务（原生选择器同样缺席）。 */
  withSystemPrompt?: boolean;
  /** 让假 assemble 抛出（组装失败不得击沉 ACP turn）。 */
  assembleError?: unknown;
 /** 待定切换守卫 seam（缺席 = 守卫停用）。 */
  guard?: AcpModelSwitchGuard;
}

function makeHarness(agentSpec: FakeAgentSpec = {}, options: HarnessOptions = {}) {
  const ctx = new Context();
  // web 原生选择器的 waterfall 机制本体（reference model-selection.ts:39-75）
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined };
  installModelSelection(ctx, selection);

  const assembleContexts: AssembleEventArgs[1][] = [];
  if (options.withSystemPrompt !== false) {
    ctx.provide('systemPrompt', {
      assemble: async (context: AssembleEventArgs[1]) => {
        if (options.assembleError !== undefined) throw options.assembleError;
        assembleContexts.push(context);
        return await ctx.waterfall('system-prompt/assemble', freshAssembly(), context, () => Promise.resolve(freshAssembly()));
      },
    });
  }

  // seed 记录器：注册在 model-selection 之后（内层），next 即模块给出的 seed
  const seeds: LlmCallConfig[] = [];
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    seeds.push(resolved);
    return resolved;
  });

  const { seam, calls, state } = makeAgent(agentSpec);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sync = createAcpOptionsSync({ ctx, agent: seam, providerRoute: ROUTE, logger, modelSwitchGuard: options.guard });
  return { ctx, selection, calls, state, logger, sync, assembleContexts, seeds };
}

// ---------- 配置项 fixtures ----------

function modelOption(currentValue: string, values: string[]): acp.SessionConfigOption {
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function effortOption(currentValue: string, values: string[]): acp.SessionConfigOption {
  return {
    type: 'select',
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function modeOption(currentValue: string, values: string[]): acp.SessionConfigOption {
  return {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

/** 断言拒绝为指定 code 的 AcpOptionsSyncError。 */
async function expectSyncError(promise: Promise<void>, code: AcpOptionsSyncErrorCode): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected AcpOptionsSyncError(${code}), got fulfillment`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AcpOptionsSyncError);
  expect((error as AcpOptionsSyncError).code).toBe(code);
}

// ---------- syncBeforeTurn（原生路径） ----------

describe('syncBeforeTurn', () => {
  it('无原生选择：两个 waterfall 均触发、seed = ACP 当前值、seam 零调用零提示', async () => {
    const { sync, calls, logger, assembleContexts, seeds } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    await sync.syncBeforeTurn({ turn: 3 });
    expect(assembleContexts).toHaveLength(1);
    expect(seeds).toEqual([{ provider: ROUTE, model: 'm1' }]);
    expect(calls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

 it('模型分叉不再重申：零 setConfigOption，一次性 warn 指向 coordinator；快照不动', async () => {
    const { sync, selection, calls, state, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    selection.current = { provider: ROUTE, model: 'm2' };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
 // 一次性提示（第二 turn 不再重复），内容含双侧模型值；文案如实归因：
    // 无待定行的建立后分叉 = 建立时模型收敛被拒/失败
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('m2');
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('m1');
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('establish-time model convergence');
    expect(state.configOptions?.[0]).toMatchObject({ currentValue: 'm1' });
    await sync.syncBeforeTurn();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('未命中：原生选择的 model 与 ACP 当前相同 → 零调用', async () => {
    const { sync, selection, calls, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    selection.current = { provider: ROUTE, model: 'm1' };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

 it('provider 非本 ACP 路由： 响亮 throw（AcpBackendImmutableError，消息含两端 backend），seam 零调用', async () => {
    const { sync, selection, calls, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    selection.current = { provider: 'native-anthropic', model: 'claude-x' };
    const error = await sync.syncBeforeTurn().then(
      () => { throw new Error('expected syncBeforeTurn to reject'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AcpBackendImmutableError);
    expect((error as AcpBackendImmutableError).kind).toBe('protocol-error');
    expect((error as Error).message).toContain('acp-test');
    expect((error as Error).message).toContain('native-anthropic');
    expect(calls).toEqual([]);
 // 响亮失败不走 warn 通道（旧行为的一次性提示已随 删除）
    expect(logger.warn).not.toHaveBeenCalled();
    // 每次 sync 都 throw（无一次性闩锁）
    await expect(sync.syncBeforeTurn()).rejects.toBeInstanceOf(AcpBackendImmutableError);
  });

  it('模型分叉 + 显式 effort：effort 照常写 thought_level（响应权威替换快照），模型分叉仅一次性提示', async () => {
    // 响应快照里 thought_level 已按 'high' 落定；若模块读旧快照（currentValue
    // 'low'）之外的陈旧状态会误发第二次 setConfigOption——此处钉响应替换语义
    const responseSnapshot = [modelOption('m1', ['m1', 'm2']), effortOption('high', ['low', 'high'])];
    const { sync, selection, calls, state, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2']), effortOption('low', ['low', 'high'])],
      onSet: () => responseSnapshot,
    });
    selection.current = { provider: ROUTE, model: 'm2', reasoningEffort: ReasoningEffortId('high') };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['effort', 'high'] }]);
    expect(state.configOptions).toBe(responseSnapshot);
    expect(logger.warn).toHaveBeenCalledTimes(1); // 模型分叉 warn-once
  });

  it('显式 reasoningEffort（model 未变）→ thought_level setConfigOption', async () => {
    const { sync, selection, calls } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2']), effortOption('low', ['low', 'high'])],
    });
    selection.current = { provider: ROUTE, model: 'm1', reasoningEffort: ReasoningEffortId('high') };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['effort', 'high'] }]);
  });

  it('effort 不在 thought_level 选项值内：跳过并一次性提示，零调用', async () => {
    const { sync, selection, calls, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2']), effortOption('low', ['low'])],
    });
    selection.current = { provider: ROUTE, model: 'm1', reasoningEffort: ReasoningEffortId('x-high') };
    await sync.syncBeforeTurn();
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('x-high');
  });

  it('无 thought_level option：info 一次，零调用', async () => {
    const { sync, selection, calls, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    selection.current = { provider: ROUTE, model: 'm1', reasoningEffort: ReasoningEffortId('high') };
    await sync.syncBeforeTurn();
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('原生选择切了 model 但 agent 无 model 类 option：一次性提示，零调用', async () => {
    const { sync, selection, calls, logger } = makeHarness({
      configOptions: [effortOption('low', ['low', 'high'])],
    });
    selection.current = { provider: ROUTE, model: 'm9' };
    await sync.syncBeforeTurn();
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('m9');
  });

  it('无 configOptions：seed 用 options.model 兜底', async () => {
    const { sync, seeds, calls } = makeHarness({ fallbackModel: 'm0' });
    await sync.syncBeforeTurn();
    expect(seeds).toEqual([{ provider: ROUTE, model: 'm0' }]);
    expect(calls).toEqual([]);
  });

  it('systemPrompt 服务缺席（裸 ctx）：静默 no-op，读不到原生选择', async () => {
    const { sync, selection, calls, logger, seeds } = makeHarness(
      { configOptions: [modelOption('m1', ['m1', 'm2'])] },
      { withSystemPrompt: false },
    );
    selection.current = { provider: ROUTE, model: 'm2' };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(seeds).toEqual([{ provider: ROUTE, model: 'm1' }]);
  });

  it('assemble 失败：warn 后按无选择继续，不抛出', async () => {
    const { sync, calls, logger, seeds } = makeHarness(
      { configOptions: [modelOption('m1', ['m1', 'm2'])] },
      { assembleError: new Error('assembly boom') },
    );
    await sync.syncBeforeTurn();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain('assembly failed');
    // agent/request waterfall 照常运行，seed 透出即无改动
    expect(seeds).toEqual([{ provider: ROUTE, model: 'm1' }]);
    expect(calls).toEqual([]);
  });

  it('并发 syncBeforeTurn 去重：共享同一次 waterfall 运行', async () => {
    const { sync, selection, assembleContexts, seeds, calls, logger } = makeHarness({
      configOptions: [modelOption('m1', ['m1', 'm2']), effortOption('low', ['low', 'high'])],
    });
    selection.current = { provider: ROUTE, model: 'm1', reasoningEffort: ReasoningEffortId('high') };
    await Promise.all([sync.syncBeforeTurn(), sync.syncBeforeTurn(), sync.syncBeforeTurn()]);
    expect(assembleContexts).toHaveLength(1);
    expect(seeds).toHaveLength(1);
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['effort', 'high'] }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ---------- 待定模型切换守卫（turn 时崩溃恢复 enforcement） ----------

describe('syncBeforeTurn 待定切换守卫', () => {
  function pendingSwitch(overrides: Partial<AcpPendingModelSwitch> = {}): AcpPendingModelSwitch {
    return {
      operationId: 'op-1',
      dshSessionId: 'session-1',
      provider: ROUTE,
      optionId: 'model',
      previousModel: 'm1',
      targetModel: 'm2',
      state: 'started',
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  interface GuardLog {
    restored: AcpPendingModelSwitch[];
    reapplied: AcpPendingModelSwitch[];
    marked: AcpPendingModelSwitch[];
    cleared: number;
  }

  function makeGuard(row: AcpPendingModelSwitch | undefined, faults: { restore?: Error; reapply?: Error } = {}) {
    const log: GuardLog = { restored: [], reapplied: [], marked: [], cleared: 0 };
    const guard: AcpModelSwitchGuard = {
      read: () => Promise.resolve(row),
      restorePrevious: (pending) => {
        log.restored.push(pending);
        return faults.restore === undefined ? Promise.resolve() : Promise.reject(faults.restore);
      },
      reapplyTarget: (pending) => {
        log.reapplied.push(pending);
        return faults.reapply === undefined ? Promise.resolve() : Promise.reject(faults.reapply);
      },
      markRollbackRequired: (pending) => {
        log.marked.push(pending);
        return Promise.resolve();
      },
      clear: () => {
        log.cleared += 1;
        return Promise.resolve();
      },
    };
    return { guard, log };
  }

  async function expectLocked(promise: Promise<void>, cause: 'rollback-failed' | 'undecidable'): Promise<void> {
    const error: unknown = await promise.then(
      () => { throw new Error('expected AcpModelSwitchLockedError, got fulfillment'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AcpModelSwitchLockedError);
    expect((error as AcpModelSwitchLockedError).cause).toBe(cause);
  }

  it('无待定行：守卫 read 一次后照常同步（零收敛动作）', async () => {
    const { guard, log } = makeGuard(undefined);
    const { sync, selection, calls } = makeHarness(
      { configOptions: [modelOption('m1', ['m1', 'm2']), effortOption('low', ['low', 'high'])] },
      { guard },
    );
    selection.current = { provider: ROUTE, model: 'm1', reasoningEffort: ReasoningEffortId('high') };
    await sync.syncBeforeTurn();
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['effort', 'high'] }]);
    expect(log).toEqual({ restored: [], reapplied: [], marked: [], cleared: 0 });
  });

  it('双侧现值一致（含 committed 残留）→ 清行收束，turn 继续', async () => {
    const { guard, log } = makeGuard(pendingSwitch({ state: 'committed' }));
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m2', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm2' };
    await sync.syncBeforeTurn();
    expect(log.cleared).toBe(1);
    expect(log.restored).toEqual([]);
    expect(log.reapplied).toEqual([]);
  });

  it('agent-rolled-back：双侧 previous 才能清行；DSH 仍在 target 时锁定', async () => {
    const settled = makeGuard(pendingSwitch({ state: 'agent-rolled-back' }));
    const ok = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard: settled.guard });
    ok.selection.current = { provider: ROUTE, model: 'm1' };
    await ok.sync.syncBeforeTurn();
    expect(settled.log.cleared).toBe(1);

    const pending = makeGuard(pendingSwitch({ state: 'agent-rolled-back' }));
    const locked = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard: pending.guard });
    locked.selection.current = { provider: ROUTE, model: 'm2' };
    await expectLocked(locked.sync.syncBeforeTurn(), 'undecidable');
    expect(pending.log.cleared).toBe(0);
  });

  it('rollback-required 行：响亮击沉 turn（rollback-failed），零收敛动作', async () => {
    const { guard, log } = makeGuard(pendingSwitch({ state: 'rollback-required' }));
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm1' };
    await expectLocked(sync.syncBeforeTurn(), 'rollback-failed');
    expect(log).toEqual({ restored: [], reapplied: [], marked: [], cleared: 0 });
  });

  it('DSH=previous / Agent=target → 回滚 Agent 侧（restorePrevious）后清行', async () => {
    const { guard, log } = makeGuard(pendingSwitch({ state: 'agent-applied' }));
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m2', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm1' };
    await sync.syncBeforeTurn();
    expect(log.restored).toEqual([pendingSwitch({ state: 'agent-applied' })]);
    expect(log.cleared).toBe(1);
  });

  it('回滚臂失败 → markRollbackRequired + 响亮击沉（rollback-failed），不清行', async () => {
    const { guard, log } = makeGuard(pendingSwitch({ state: 'agent-applied' }), { restore: new Error('agent refused') });
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m2', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm1' };
    await expectLocked(sync.syncBeforeTurn(), 'rollback-failed');
    expect(log.restored).toHaveLength(1);
    expect(log.marked).toEqual([pendingSwitch({ state: 'agent-applied' })]);
    expect(log.cleared).toBe(0);
  });

  it('DSH=target / Agent=previous → 重放 Agent 写（reapplyTarget）后清行', async () => {
    const { guard, log } = makeGuard(pendingSwitch());
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm2' };
    await sync.syncBeforeTurn();
    expect(log.reapplied).toEqual([pendingSwitch()]);
    expect(log.cleared).toBe(1);
  });

  it('重放臂失败 → markRollbackRequired + 响亮击沉（rollback-failed）', async () => {
    const { guard, log } = makeGuard(pendingSwitch(), { reapply: new Error('agent refused') });
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm2' };
    await expectLocked(sync.syncBeforeTurn(), 'rollback-failed');
    expect(log.reapplied).toHaveLength(1);
    expect(log.marked).toEqual([pendingSwitch()]);
    expect(log.cleared).toBe(0);
  });

  it('值集合越出 {previous,target}（双侧都动过）→ 无法自证，响亮击沉（undecidable）', async () => {
    const { guard, log } = makeGuard(pendingSwitch());
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2', 'm3'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm3' };
    await expectLocked(sync.syncBeforeTurn(), 'undecidable');
    expect(log).toEqual({ restored: [], reapplied: [], marked: [], cleared: 0 });
  });

  it('guard.read 抛错（畸形行按 corrupt 上抛）→ 原样传播，turn 击沉', async () => {
    const { guard } = makeGuard(undefined);
    guard.read = () => Promise.reject(new AcpModelSwitchLockedError('undecidable', 'corrupt row'));
    const { sync, selection } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] }, { guard });
    selection.current = { provider: ROUTE, model: 'm1' };
    await expectLocked(sync.syncBeforeTurn(), 'undecidable');
  });
});

// ---------- applyLiveChange（活体切换纯逻辑校验） ----------

describe('applyLiveChange', () => {
  it('select option 命中 → setConfigOption', async () => {
    const { sync, calls } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] });
    await sync.applyLiveChange('model', 'm2');
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['model', 'm2'] }]);
  });

  it('select 分组值扁平化后命中', async () => {
    const grouped: acp.SessionConfigOption = {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'm1',
      options: [{ group: 'g1', name: 'G1', options: [{ value: 'm2', name: 'M2' }] }],
    };
    const { sync, calls } = makeHarness({ configOptions: [grouped] });
    await sync.applyLiveChange('model', 'm2');
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['model', 'm2'] }]);
  });

  it('select 非法值 → invalid-value（消息含允许值）', async () => {
    const { sync, calls } = makeHarness({ configOptions: [modelOption('m1', ['m1', 'm2'])] });
    await expectSyncError(sync.applyLiveChange('model', 'm9'), 'invalid-value');
    expect(calls).toEqual([]);
  });

 it('：mode 类 config option → setConfigOption（不经 setMode）', async () => {
    const { sync, calls, state } = makeHarness({ configOptions: [modeOption('code', ['code', 'plan'])] });
    await sync.applyLiveChange('mode', 'plan');
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['mode', 'plan'] }]);
    // seam 假实现按响应快照改写 mode option 的 currentValue；legacy modes 面不动
    expect(state.configOptions?.[0]).toMatchObject({ currentValue: 'plan' });
    expect(state.currentModeId).toBeUndefined();
  });

  it('mode 类 option 的非法值 → invalid-value', async () => {
    const { sync, calls } = makeHarness({ configOptions: [modeOption('code', ['code', 'plan'])] });
    await expectSyncError(sync.applyLiveChange('mode', 'turbo'), 'invalid-value');
    expect(calls).toEqual([]);
  });

  it('legacy 降级：无 mode config option 但 currentModeId 已知 → setMode', async () => {
    const { sync, calls, state } = makeHarness({
      configOptions: [modelOption('m1', ['m1'])],
      currentModeId: 'code',
    });
    await sync.applyLiveChange('mode', 'plan');
    expect(calls).toEqual([{ method: 'setMode', args: ['plan'] }]);
    expect(state.currentModeId).toBe('plan');
  });

  it('legacy 降级只收 string：boolean 值 → invalid-value（set_mode 协议无 boolean）', async () => {
    const { sync, calls } = makeHarness({
      configOptions: [modelOption('m1', ['m1'])],
      currentModeId: 'code',
    });
    await expectSyncError(sync.applyLiveChange('mode', true), 'invalid-value');
    expect(calls).toEqual([]);
  });

  it('mode 能力全无（无 option 且无 modes 状态）→ unknown-option', async () => {
    const { sync, calls } = makeHarness({ configOptions: [modelOption('m1', ['m1'])] });
    await expectSyncError(sync.applyLiveChange('mode', 'plan'), 'unknown-option');
    expect(calls).toEqual([]);
  });

  it('configOptions 全无 → unavailable（降级矩阵：选择器 ACP 区块隐藏）', async () => {
    const { sync, calls } = makeHarness();
    await expectSyncError(sync.applyLiveChange('model', 'm2'), 'unavailable');
    expect(calls).toEqual([]);
  });

  it('configOptions 存在但 id 未知 → unknown-option', async () => {
    const { sync, calls } = makeHarness({ configOptions: [modelOption('m1', ['m1'])] });
    await expectSyncError(sync.applyLiveChange('temperature', '0.5'), 'unknown-option');
    expect(calls).toEqual([]);
  });

  it('boolean option：原生 boolean 通过（类型保真），字符串 true/false → invalid-value', async () => {
    const boolOption: acp.SessionConfigOption = { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false };
    const { sync, calls, state } = makeHarness({ configOptions: [boolOption] });
    await sync.applyLiveChange('fast', true);
    expect(calls).toEqual([{ method: 'setConfigOption', args: ['fast', true] }]);
    expect(state.configOptions?.[0]).toMatchObject({ currentValue: true });
    await expectSyncError(sync.applyLiveChange('fast', 'true'), 'invalid-value');
    expect(calls).toHaveLength(1);
  });

  it('未知 option type → unsupported-type（协议：未知类型按忽略处理，写入被拒）', async () => {
    const exotic = { type: 'multi-select', id: 'flags', name: 'Flags' } as unknown as acp.SessionConfigOption;
    const { sync, calls } = makeHarness({ configOptions: [exotic] });
    await expectSyncError(sync.applyLiveChange('flags', 'a'), 'unsupported-type');
    expect(calls).toEqual([]);
  });

  it('执行中（status running）→ busy，seam 零调用', async () => {
    const { sync, calls } = makeHarness({
      status: 'running',
      configOptions: [modelOption('m1', ['m1', 'm2'])],
    });
    await expectSyncError(sync.applyLiveChange('model', 'm2'), 'busy');
    expect(calls).toEqual([]);
  });
});
