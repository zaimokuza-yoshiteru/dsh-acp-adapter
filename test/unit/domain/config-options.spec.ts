// config-options.spec.ts — 验收测试：ACP v1 Session Config Options 四形态集成。
//
// 四形态（mock scenario 对齐协议 §Session Config Options 的过渡矩阵）：
//   both（happy）            modes + configOptions 双发（Devin 3000.4.25 历史实测形态）——
//                            mode 类 option 一律走 session/set_config_option（不经 set_mode）
//   config-options-only      只有 configOptions 无 modes——set_config_option 照常，无 legacy 面
//   legacy-modes-only        只有 modes 无 configOptions（no-config-options scenario）——
//                            mode 回退 session/set_mode；其余 option → unavailable
//   exotic-options           双发 + boolean（category model_config）+ 未知 category 的 select
//                            + 未知 type（slider）——实测 SDK 1.3.0 把未知 type 项原样保留
//                            （不丢弃；会话建立不受影响），写路径由 options-sync 以
//                            unsupported-type 拒写；boolean 以原生 JSON boolean 上线
//                            （类型保真）
//
// 组装层见 test/agent-test-helpers.ts（与 agent.spec.ts 同款骨架）。optionsSync 在
// AcpAgent 内是 private，本文件按生产同款参数自建桥接（真 seam = AcpAgent 本体）。
// mock 的 MOCK_LOG 承担 RPC 路由断言（`set_config_option`/`set_mode` 行）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  AcpOptionsSyncError,
  createAcpOptionsSync,
  type AcpOptionsSync,
} from '../../../src/domain/session/options-sync.ts';
import {
  createHarness,
  mockProfile,
  readLog,
  registerAcpAgents,
  routeOf,
  userText,
  waitFor,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, {});
  harnesses.push(harness);
  return harness;
}

interface LiveCase {
  agent: AcpAgent;
  profile: MockProfile;
  sync: AcpOptionsSync;
}

/** 注册 profile、建 agent、跑一个 turn 建立 ACP 会话，返回活体三元组。 */
async function bootLive(scenario: string, caseId: string): Promise<LiveCase> {
  const harness = await boot();
  const profile = mockProfile(harness.logDir, scenario);
  await registerAcpAgents(harness, [profile]);
  const handle = await harness.loop.createAgent(harness.ctx, {
    sessionId: SessionId(caseId),
    meta: { cwd: harness.logDir },
    agentOptions: { provider: routeOf(profile) },
  });
  harness.handles.push(handle);
  const agent = handle.agent as AcpAgent;
  agent.followup(userText('x'));
  await agent.whenIdle();
  const sync = createAcpOptionsSync({
    ctx: harness.ctx,
    agent,
    providerRoute: routeOf(profile),
    logger: harness.ctx.logger,
  });
  return { agent, profile, sync };
}

/** 断言拒绝为指定 code 的 AcpOptionsSyncError。 */
async function expectSyncError(promise: Promise<void>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected AcpOptionsSyncError(${code}), got fulfillment`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AcpOptionsSyncError);
  expect((error as AcpOptionsSyncError).code).toBe(code);
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-config-options-spec-'));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
});

afterAll(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('both（happy：modes + configOptions 双发，真机形态）', () => {
  it('mode 类 config option 走 set_config_option（不经 set_mode），双发补推收敛 currentModeId', async () => {
    const { agent, profile, sync } = await bootLive('happy', 'both-mode');
    expect(agent.currentModeId).toBe('accept-edits');

    await sync.applyLiveChange('mode', 'plan');

    const log = readLog(profile.logPath);
    expect(log).toContain('set_config_option configId=mode value="plan"');
    expect(log).not.toContain('set_mode');
    // mock 按「双发保持一致」补推 current_mode_update → 状态槽收敛
    await waitFor(() => agent.currentModeId === 'plan');
    // 响应快照整体替换（seam 契约）：mode option 的 currentValue 已收敛
    const mode = agent.configOptions?.find((option) => option.id === 'mode');
    expect(mode).toMatchObject({ type: 'select', currentValue: 'plan' });
  });

  it('model 切换走 set_config_option；configOptions 以响应完整快照整体替换（非合并）', async () => {
    const { agent, profile, sync } = await bootLive('happy', 'both-model');
    expect(agent.configOptions?.map((option) => option.id)).toEqual(['mode', 'model']);

    await sync.applyLiveChange('model', 'mock-model-b');

    expect(readLog(profile.logPath)).toContain('set_config_option configId=model value="mock-model-b"');
    // 响应快照整体替换：仍是恰两项（mode 原值保留、model 收敛），无遗留/重复
    expect(agent.configOptions?.map((option) => [option.id, option.currentValue])).toEqual([
      ['mode', 'accept-edits'],
      ['model', 'mock-model-b'],
    ]);
  });
});

describe('config-options-only（无 modes 面）', () => {
  it('mode 写仍走 set_config_option（错走 set_mode 会被 mock -32602 拒）；无 legacy 面可同步', async () => {
    const { agent, profile, sync } = await bootLive('config-options-only', 'coo-mode');
    // 无 modes：session/new 不种子 currentModeId
    expect(agent.currentModeId).toBeUndefined();
    expect(agent.configOptions?.map((option) => option.id)).toEqual(['mode', 'model']);

    await sync.applyLiveChange('mode', 'plan');

    const log = readLog(profile.logPath);
    expect(log).toContain('set_config_option configId=mode value="plan"');
    expect(log).not.toContain('set_mode');
    // 无 legacy modes 面，也没有 current_mode_update 推送：状态槽保持未知
    expect(agent.currentModeId).toBeUndefined();
    expect(agent.configOptions?.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'plan' });
  });
});

describe('legacy-modes-only（no-config-options：仅 modes）', () => {
  it('mode 回退 session/set_mode；其余 option → unavailable', async () => {
    const { agent, profile, sync } = await bootLive('no-config-options', 'legacy-mode');
    expect(agent.configOptions).toBeUndefined();
    expect(agent.currentModeId).toBe('accept-edits');

    await sync.applyLiveChange('mode', 'plan');

    const log = readLog(profile.logPath);
    expect(log).toContain('set_mode modeId=plan');
    expect(log).not.toContain('set_config_option');
    await waitFor(() => agent.currentModeId === 'plan');

    // configOptions 全无 → 非 mode 的写不可用（降级矩阵：选择器 ACP 区块隐藏）
    await expectSyncError(sync.applyLiveChange('model', 'mock-model-b'), 'unavailable');
  });
});

describe('exotic-options（boolean + 未知 category + 未知 type）', () => {
  it('未知 type 项经 SDK 原样保留（不丢弃），会话建立与 turn 不受影响', async () => {
    const { agent } = await bootLive('exotic-options', 'exotic-decode');
    // 实测 SDK 1.3.0：slider 项存活（反序列化不丢弃未知 type）
    expect(agent.configOptions?.map((option) => option.id)).toEqual(['mode', 'model', 'auto_compact', 'telemetry', 'temperature']);
    expect(agent.configOptions?.find((option) => option.id === 'auto_compact')).toMatchObject({
      type: 'boolean',
      category: 'model_config',
      currentValue: false,
    });
    expect(agent.configOptions?.find((option) => option.id === 'telemetry')).toMatchObject({
      type: 'select',
      category: 'telemetry',
      currentValue: 'off',
    });
  });

  it('未知 category 的 select 正常走 set_config_option', async () => {
    const { agent, profile, sync } = await bootLive('exotic-options', 'exotic-telemetry');
    await sync.applyLiveChange('telemetry', 'on');
    expect(readLog(profile.logPath)).toContain('set_config_option configId=telemetry value="on"');
    expect(agent.configOptions?.find((option) => option.id === 'telemetry')).toMatchObject({ currentValue: 'on' });
  });

  it('boolean 以原生 JSON boolean 上线（不是 "true" 字符串）', async () => {
    const { agent, profile, sync } = await bootLive('exotic-options', 'exotic-bool');
    await sync.applyLiveChange('auto_compact', true);
    // mock log 的 value 是 JSON.stringify 产物：原生 boolean → `true`，字符串会是 `"true"`
    expect(readLog(profile.logPath)).toContain('set_config_option configId=auto_compact value=true');
    expect(agent.configOptions?.find((option) => option.id === 'auto_compact')).toMatchObject({ currentValue: true });
  });

  it('未知 type 项的写入 → unsupported-type（协议：未知类型忽略，agent 默认值照旧）', async () => {
    const { profile, sync } = await bootLive('exotic-options', 'exotic-slider');
    await expectSyncError(sync.applyLiveChange('temperature', 'low'), 'unsupported-type');
    expect(readLog(profile.logPath)).not.toContain('set_config_option configId=temperature');
  });
});
