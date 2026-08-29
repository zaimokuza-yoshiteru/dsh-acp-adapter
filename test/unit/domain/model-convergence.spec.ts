// model-convergence.spec.ts — 建立时模型收敛（新会话模型收敛 收尾 / 验收
// 「新会话从目标模型启动」）的 mock-agent e2e 矩阵。
//
// 被测路径：src/domain/session/agent.ts `convergeModelAtEstablishment`——会话建立
// （new 或对账通过的 load）后、binding durable、首个 prompt 前，把 DSH 会话选定
// 模型（agentOptions.model）一次性单向应用到 Agent（agent←DSH，无 model_switches
// 事务、无 DSH 回写）。
//
// 矩阵：
//   1. 双侧相等 → 零 RPC no-op（无 set_config_option 流量）。
//   2. 不等 + 可写 + 值在允许集 → 首个 prompt 前应用（MOCK_LOG 行序钉版：
//      set_config_option 先于 session/prompt）；响应权威快照替换状态槽并刷新
//      sidecar last-known 快照；request/header 记录应用后的模型。
//   3. 不等 + 值不在允许集 → 零 RPC，落有界用户可见分叉说明
//      （acpModelDivergenceNote），turn 以 agent 实际模型照常完成，header 诚实。
//   4. 不等 + RPC 失败（config-write-fail scenario）→ 分叉说明 + turn 照常完成。
//   5. resume（session/load 对账通过）同款：load 之后、prompt 之前应用。
//   6. 待定切换行在场（rollback-required）→ 建立收敛让位 pending-switch 守卫：
//      零 set_config_option、零 prompt，turn 被守卫响亮锁定。
//
// 组装层见 test/agent-test-helpers.ts。afterEach 兜底 dispose 全部 handle；
// 共享 subprocess runtime 在文件结束时兜底回收。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
  bindingFixture,
  createHarness,
  eventsOf,
  mockProfile,
  readLog,
  registerAcpAgents,
  routeOf,
  seedLogMatchingLoadReplay,
  userText,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, MockProfile } from '../../fixtures/agent-test-helpers.ts';
import type { AcpAgent } from '../../../src/domain/session/agent.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir);
  harnesses.push(harness);
  return harness;
}

/** 创建并登记一个 ACP agent（经 loop 路由），可选 DSH 侧选定模型。 */
async function createAcpAgent(
  harness: AgentHarness,
  profile: MockProfile,
  sessionId: SessionId,
  model?: string,
): Promise<AgentHandle> {
  await registerAcpAgents(harness, [profile]);
  const handle = await harness.loop.createAgent(harness.ctx, {
    sessionId,
    meta: { cwd: harness.logDir },
    agentOptions: { provider: routeOf(profile), ...(model === undefined ? {} : { model }) },
  });
  harness.handles.push(handle);
  return handle;
}

/** 落盘的分叉说明消息文本（说明消息 = 无 sourceEventSeqs 的 assistant/message）。 */
function noteTexts(agent: AgentHandle['agent']): string[] {
  return eventsOf(agent, 'assistant/message')
    .filter((event) => event.sourceEventSeqs === undefined)
    .flatMap((event) => event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])));
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-model-convergence-spec-'));
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

describe('建立时模型收敛', () => {
  it('双侧相等 → 零 RPC no-op（无 set_config_option 流量），header 记当前模型', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('converge-equal'), 'mock-model-a');
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
    expect(readLog(profile.logPath)).not.toContain('set_config_option');
    expect(noteTexts(agent)).toEqual([]);
    const headers = eventsOf(agent, 'request/header');
    expect(headers.at(-1)?.data.header.config.model).toBe('mock-model-a');
  }, 20_000);

  it('不等 + 可写 + 值在允许集 → 首个 prompt 前应用；权威快照替换状态槽与 sidecar 快照；header 记应用后模型', async () => {
    const harness = await boot();
    const sessionId = SessionId('converge-applied');
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, sessionId, 'mock-model-b');
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
    // RPC 行序钉版：session/new → set_config_option（建立收敛）→ 首个 session/prompt
    const log = readLog(profile.logPath);
    const newIdx = log.indexOf('--> session/new');
    const setIdx = log.indexOf('--> session/set_config_option');
    const promptIdx = log.indexOf('--> session/prompt');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(newIdx);
    expect(promptIdx).toBeGreaterThan(setIdx);
    expect(log).toContain('set_config_option configId=model value="mock-model-b"');
    // 响应权威快照已替换状态槽；request/header 记录应用后的模型
    expect(noteTexts(agent)).toEqual([]);
    const headers = eventsOf(agent, 'request/header');
    expect(headers.at(-1)?.data.header.config.model).toBe('mock-model-b');
 // sidecar last-known 快照同步到收敛后的事实（刷新随 setConfigOption seam）
    const snapshot = await harness.loop.acpSidecar?.readOptionSnapshot(sessionId);
    expect(snapshot?.options.find((option) => option.id === 'model')?.value).toBe('mock-model-b');
  }, 20_000);

  it('不等 + 值不在允许集 → 零 RPC + 分叉说明落盘；turn 以 agent 实际模型照常完成，header 诚实', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('converge-not-allowed'), 'mock-model-z');
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
    expect(readLog(profile.logPath)).not.toContain('set_config_option');
    // 分叉说明：点名选定模型与实际模型，恰好一条
    const notes = noteTexts(agent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('mock-model-z');
    expect(notes[0]).toContain('mock-model-a');
    expect(notes[0]).toContain('could not be applied to the ACP Agent');
    // 诚实面：header 记 agent 实际模型（不是 DSH 选定值）；turn 未被锁定
    const headers = eventsOf(agent, 'request/header');
    expect(headers.at(-1)?.data.header.config.model).toBe('mock-model-a');
  }, 20_000);

  it('不等 + RPC 失败（config-write-fail）→ 分叉说明落盘；turn 照常完成', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'config-write-fail');
    const handle = await createAcpAgent(harness, profile, SessionId('converge-rpc-fail'), 'mock-model-b');
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
    // 收敛尝试真实发出并被拒（值未应用），随后 turn 照常 prompt
    const log = readLog(profile.logPath);
    expect(log).toContain('set_config_option configId=model value="mock-model-b" (refused by scenario)');
    expect(log).toContain('--> session/prompt');
    const notes = noteTexts(agent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('mock-model-b');
    expect(notes[0]).toContain('mock-model-a');
    expect(eventsOf(agent, 'request/header').at(-1)?.data.header.config.model).toBe('mock-model-a');
  }, 20_000);

  it('resume（对账通过的 session/load）同款：load 之后、首个 prompt 前应用 DSH 选定模型', async () => {
    const harness = await boot();
    const sessionId = SessionId('converge-resume');
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    });
    // 上次会话选定 mock-model-b（committed 热切换后宿主重启的形态：agent 的
    // load 回默认 mock-model-a，DSH 日志/header 记 b——收敛必须把它重新应用）
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-b'), { cwd: harness.logDir });
    await harness.loop.acpSidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-alpha',
        overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
      }),
    });

    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(handle);
    const agent = handle.agent;
    // 窥测一路：options.model 来自日志末个 request/header（mock-model-b）
    expect(agent.options.model).toBe('mock-model-b');

    agent.followup(userText('continue after restart'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
    // RPC 行序钉版：session/load → set_config_option（建立收敛）→ 首个 session/prompt
    const log = readLog(profile.logPath);
    const loadIdx = log.indexOf('--> session/load');
    const setIdx = log.indexOf('--> session/set_config_option');
    const promptIdx = log.indexOf('--> session/prompt');
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(loadIdx);
    expect(promptIdx).toBeGreaterThan(setIdx);
    expect(log).toContain('set_config_option configId=model value="mock-model-b"');
    expect(eventsOf(agent, 'request/header').at(-1)?.data.header.config.model).toBe('mock-model-b');
    const snapshot = await harness.loop.acpSidecar?.readOptionSnapshot(sessionId);
    expect(snapshot?.options.find((option) => option.id === 'model')?.value).toBe('mock-model-b');
  }, 20_000);

  it('resume 在首个 prompt 前恢复同一 Agent 的 mode、thinking 与其他兼容配置', async () => {
    const harness = await boot();
    const sessionId = SessionId('restore-agent-options');
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['mock-session-1']),
      MOCK_THOUGHT_LEVEL: '1',
    });
    const first = await createAcpAgent(harness, profile, sessionId, 'mock-model-a');
    first.agent.followup(userText('establish options'));
    await first.agent.whenIdle();
    const firstAgent = first.agent as AcpAgent;
    await firstAgent.setConfigOption('mode', 'plan');
    await firstAgent.setConfigOption('thought_level', 'low');
    expect((await harness.loop.acpSidecar?.readOptionSnapshot(sessionId))?.options)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'mode', value: 'plan' }),
        expect.objectContaining({ id: 'thought_level', value: 'low' }),
      ]));
    // The ACP's effective thought_level is part of the next request header,
    // so a DSH model-selection projection cannot silently fall back to an
    // unknown effort after the live option was changed.
    first.agent.followup(userText('check persisted effort'));
    await first.agent.whenIdle();
    expect((eventsOf(first.agent, 'request/header').at(-1)?.data.header.config as { reasoningEffort?: string }).reasoningEffort)
      .toBe('low');

    const persisted = [...first.agent.session.events];
    await first.dispose();
    harness.persistence.seed(sessionId, persisted, { cwd: harness.logDir });

    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);
    second.agent.followup(userText('continue with restored options'));
    await second.agent.whenIdle();

    const resumed = second.agent as AcpAgent;
    expect(resumed.configOptions?.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
    expect(resumed.configOptions?.find((option) => option.id === 'thought_level')?.currentValue).toBe('low');
    expect((eventsOf(second.agent, 'request/header').at(-1)?.data.header.config as { reasoningEffort?: string }).reasoningEffort)
      .toBe('low');
    const log = readLog(profile.logPath);
    const loadIndex = log.lastIndexOf('--> session/load');
    const modeIndex = log.indexOf('set_config_option configId=mode value="plan"', loadIndex);
    const thoughtIndex = log.indexOf('set_config_option configId=thought_level value="low"', loadIndex);
    const promptIndex = log.indexOf('--> session/prompt', loadIndex);
    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeGreaterThan(loadIndex);
    expect(thoughtIndex).toBeGreaterThan(modeIndex);
    expect(promptIndex).toBeGreaterThan(thoughtIndex);
    expect(eventsOf(second.agent, 'turn/end').at(-1)?.data.reason.kind).toBe('completed');
  }, 25_000);

  it('待定切换行在场（rollback-required）→ 建立收敛让位守卫：零 set_config_option、零 prompt，turn 响亮锁定', async () => {
    const harness = await boot();
    const sessionId = SessionId('converge-yields-to-guard');
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, sessionId, 'mock-model-b');
    const agent = handle.agent;
    // 崩溃残留的 rollback-required 行：守卫必须锁定，建立收敛不得抢跑
    await harness.loop.acpSidecar?.writePendingModelSwitch({
      operationId: 'op-stuck',
      dshSessionId: String(sessionId),
      provider: routeOf(profile),
      optionId: 'model',
      previousModel: 'mock-model-a',
      targetModel: 'mock-model-b',
      state: 'rollback-required',
      createdAt: new Date(0).toISOString(),
    });

    agent.followup(userText('hello'));
    await agent.whenIdle();

    const lastEnd = eventsOf(agent, 'turn/end').at(-1);
    expect(lastEnd?.data.reason.kind).toBe('error');
    const message = lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.message : '';
    expect(message).toContain('locked');
    // 让位证明：建立收敛零 RPC（守卫的 rollback-required 臂也不写 Agent）；
    // prompt 从未发出
    const log = readLog(profile.logPath);
    expect(log).not.toContain('set_config_option');
    expect(log).not.toContain('--> session/prompt');
    // 行未被建立路径清除（守卫拥有它）
    const lookup = await harness.loop.acpSidecar?.readPendingModelSwitch(sessionId);
    expect(lookup?.status).toBe('ok');
  }, 20_000);
});
