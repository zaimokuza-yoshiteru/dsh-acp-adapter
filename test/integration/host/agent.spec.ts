// agent.spec.ts — 黑盒 黑盒测试：AcpAgent（src/domain/session/agent.ts）与 AcpAgentLoop 路由（src/host/factory/agent-loop.ts）。
//
// 覆盖（对应任务覆盖要点）：
//   1. 路由：acp-<id> 命中 → AcpAgent；非 ACP provider / 未注册 acp- 前缀 → 父类
//      ReactLoopAgent（类型断言 + 完整 LLM turn 对照）；resume 的显式 provider 与
//      request/header 窥测命中/未命中三路；未配置 sessionPersistence 的拒绝。
//   2. turn 驱动：followup → 完整事件序列（turn/start → user/message{append} →
//      request/header{initial, acp-<id>} → assistant/chunk… → assistant/message
//      {sourceEventSeqs} → turn/end）；无 step/*；turn 从 1 递增。
//   3. 懒启动：create 后不 spawn；首个 turn 才 spawn；同会话两 turn 复用同一子进程。
//   4. cancel：turn 中途 → session/cancel 到达 mock + turn/end aborted{user} + 已流
//      chunk 保留；idle 时无副作用；排队中的 followup 被清理（discarded/canceled）。
//   5. followup 排队：running 时 followup → 当前 turn 结束后顺序开下一 turn。
//   6. request/header change：setConfigOption 换模型 → 下一 turn reason='change'。
//   7. 异常：crash-mid-turn → turn/end error ACP_CRASH + chunk 保留 + 全新连接重试；
//      auth_required（内联 fixture）→ ACP_AUTH_REQUIRED + login hint 面向用户可读。
//   8. dispose：EOF→SIGTERM 梯子、pid 死亡、幂等；未启动 dispose；mid-turn dispose；
// 失控 agent（cancel-stuck）下 dispose 有界完成（取消梯子 + whenIdle 闸）。
//   9. append 纪律抽样：user/message 与 assistant/message 的 surfaceOp/sourceEventSeqs
//      （随 turn 驱动套件断言）。
//
// 组装层见 test/agent-test-helpers.ts。孤儿进程防线：所有 spawn argv 带 SPEC_TAG，
// afterEach 兜底 dispose 全部 handle，afterAll `ps` 全量扫描 SPEC_TAG + 逐 pid 断言。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import { ACP_CORRELATION_ID_PATTERN, AcpClientError } from '../../../src/protocol/v1/errors.ts';
import { ACP_SIDECAR_DEFAULT_RETENTION_MS, createAcpSidecar } from '../../../src/persistence/sidecar.ts';
import { ACP_NOTE_STEP, ACP_STEP } from '../../../src/protocol/v1/translate.ts';
import { ACP_EMPTY_RESPONSE_NOTE } from '../../../src/domain/session/resume.ts';
import {
  MockLlmAdapter,
  SPEC_TAG,
  contractEventTypes,
  createHarness,
  eventsOf,
  inlineProfile,
  isDead,
  mockProfile,
  psLinesWithTag,
  readLog,
  registerAcpAgents,
  routeOf,
  seedLogWithHeader,
  seedLogWithoutHeader,
  spawnedPids,
  textResponse,
  userText,
  waitFor,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, CreateHarnessOptions, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(options?: CreateHarnessOptions): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, options ?? {});
  harnesses.push(harness);
  return harness;
}

/** 创建并登记一个 ACP agent（经 loop 路由），返回 handle 与其 mock profile。 */
async function createAcpAgent(
  harness: AgentHarness,
  profile: MockProfile,
  sessionId: SessionId,
): Promise<AgentHandle> {
  await registerAcpAgents(harness, [profile]);
  const handle = await harness.loop.createAgent(harness.ctx, {
    sessionId,
    meta: { cwd: harness.logDir },
    agentOptions: { provider: routeOf(profile) },
  });
  harness.handles.push(handle);
  return handle;
}

/** turn/end 事件的 reason 窄化断言助手。 */
function turnEndReasons(agent: Agent): { turn: number; reason: SessionEvent<'turn/end'>['data']['reason'] }[] {
  return eventsOf(agent, 'turn/end').map((event) => ({ turn: event.data.turn, reason: event.data.reason }));
}

/** 收集某 agent 的 agent/error 派发。 */
function trackErrors(harness: AgentHarness, agent: Agent): unknown[] {
  const errors: unknown[] = [];
  harness.ctx.on('agent/error', (payload) => {
    if (payload.agent === agent) errors.push(payload.error);
  });
  return errors;
}

/** 收集某 agent 的 agent/status 跃迁序列。 */
function trackStatuses(harness: AgentHarness, agent: Agent): string[] {
  const statuses: string[] = [];
  harness.ctx.on('agent/status', (payload) => {
    if (payload.agent === agent) statuses.push(payload.status);
  });
  return statuses;
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-agent-spec-'));
});

afterEach(async () => {
  // 兜底拆除：测试自身已 dispose 的 handle 靠幂等快速返回
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
});

afterAll(async () => {
  // 逐 pid 断言死亡（从各 mock 日志的 `started pid=` 行回收）
  const pidScan = psLinesWithTag(SPEC_TAG);
  expect(pidScan).toEqual([]);
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('路由：AcpAgentLoop.createAgent / resume', () => {
  it('createAgent：provider 命中 ACP 注册表（acp-<id>）→ AcpAgent 实例', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('route-hit'));

    expect(handle.agent).toBeInstanceOf(AcpAgent);
    expect(handle.agent.options.provider).toBe(routeOf(profile));
    expect(handle.agent.status).toBe('idle');
 // 懒启动：创建不起会话进程—— 创建门只起一次门内 probe（无 session/prompt），
    // ACP 侧会话 id 尚不存在
    expect((handle.agent as AcpAgent).agentSessionId).toBeUndefined();
    expect(spawnedPids(profile.logPath)).toHaveLength(1);
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
    expect(handle.agent.session.events).toEqual([]);
  });

  it('createAgent：acp- 前缀但未注册的路由（acp-ghost）→ 委派父类 ReactLoopAgent', async () => {
    const harness = await boot();
    // 注册表有一个别的 agent，但 acp-ghost 不在其中
    await registerAcpAgents(harness, [mockProfile(harness.logDir, 'happy')]);
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('route-ghost'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: 'acp-ghost' },
    });
    harness.handles.push(handle);

    expect(handle.agent).not.toBeInstanceOf(AcpAgent);
    expect(handle.agent.constructor.name).toBe('ReactLoopAgent');
  });

  it('createAgent：非 ACP provider → 父类 ReactLoopAgent 跑通完整 LLM turn，ACP 子进程零 spawn', async () => {
    const harness = await boot();
    // ACP agent 已注册但不应被路由命中
    const acp = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [acp]);
    harness.llm.registerAdapter(['mock'], new MockLlmAdapter([textResponse('native reply')]));

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('route-native'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    });
    harness.handles.push(handle);
    expect(handle.agent).not.toBeInstanceOf(AcpAgent);
    expect(handle.agent.constructor.name).toBe('ReactLoopAgent');

    handle.agent.followup(userText('hello native'));
    await handle.agent.whenIdle();

    // 原生 loop 完整跑通：step 事件存在（与 ACP 无 step 对照），turn 完成
    const types = contractEventTypes(handle.agent);
    expect(types).toContain('step/start');
    expect(types).toContain('step/end');
    expect(turnEndReasons(handle.agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }]);
    const assistant = eventsOf(handle.agent, 'assistant/message');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.data.message.content).toEqual([{ type: 'text', text: 'native reply' }]);
    const headers = eventsOf(handle.agent, 'request/header');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.data.header.config.provider).toBe('mock');
    expect(headers[0]?.data.reason).toBe('initial');
    // ACP 侧零 spawn
    expect(fs.existsSync(acp.logPath)).toBe(false);
  }, 15_000);

  it('resume：未配置 sessionPersistence → 明确抛错', async () => {
    const harness = await boot({ persistence: false });
    await expect(
      harness.loop.resume(harness.ctx, { resumeSessionId: SessionId('no-persistence') }),
    ).rejects.toThrow('session persistence is not configured');
  });

  it('resume：历史 provider 优先于瞬时 agentOptions.provider，不能把 native 会话改成 ACP', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    // 日志里存的是 native provider：恢复真源必须优先于 UI/默认值快照。
    harness.persistence.seed(SessionId('resume-explicit'), seedLogWithHeader('deepseek', 'deepseek-chat'));

    const handle = await harness.loop.resume(harness.ctx, {
      resumeSessionId: SessionId('resume-explicit'),
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);

    expect(handle.agent).not.toBeInstanceOf(AcpAgent);
    expect(handle.agent.options.provider).toBe('deepseek');
    expect(harness.persistence.inspectCalls).toEqual([SessionId('resume-explicit')]);
    expect(harness.persistence.prepareCalls).toEqual([SessionId('resume-explicit')]);
  });

 it('resume：窥测末个 request/header 命中 acp-<id> → AcpAgent；无 binding → binding-missing 闩锁（零 spawn）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    harness.persistence.seed(SessionId('resume-peek'), seedLogWithHeader(routeOf(profile), 'mock-model-a'));

    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: SessionId('resume-peek') });
    harness.handles.push(handle);

    expect(handle.agent).toBeInstanceOf(AcpAgent);
    expect(harness.persistence.inspectCalls).toEqual([SessionId('resume-peek')]);
    // 模型取自日志末个 request/header
    expect(handle.agent.options.model).toBe('mock-model-a');
    expect(handle.agent.options.provider).toBe(routeOf(profile));
    // 种子日志原样在位（含 end-seed 边界），尚无新事件
    expect(handle.agent.session.events.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'request/header',
      'assistant/chunk', 'assistant/chunk', 'assistant/chunk',
      'assistant/message', 'turn/end', 'session/end-seed',
    ]);
 // 日志有 ACP 史（header provider 命中本路由）但 sidecar 无 binding
    // → 构造期预置 binding-missing 闩锁（恢复无据不再沉默 session/new）
    expect((handle.agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'binding-missing', detail: null });

    handle.agent.followup(userText('continue after resume'));
    await handle.agent.whenIdle();

    // turn 从日志末个 turn/start 续号；user/message 如实落盘后闩锁拒启
    const starts = eventsOf(handle.agent, 'turn/start');
    expect(starts.map((event) => event.data.turn)).toEqual([1, 2]);
    const lastEnd = turnEndReasons(handle.agent).at(-1);
    expect(lastEnd?.turn).toBe(2);
    expect(lastEnd?.reason.kind).toBe('error');
    expect(lastEnd?.reason.kind === 'error' ? lastEnd.reason.error.code : undefined).toBe('ACP_RECONCILIATION_REQUIRED');
    // 闩锁在 ensureStarted 之前：零 spawn、无新 request/header
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expect(eventsOf(handle.agent, 'request/header')).toHaveLength(1);
    // reconciliation 记录落盘（cause 对账）
    const reconciliationEntries = ((await harness.loop.acpSidecar?.list(SessionId('resume-peek'))) ?? [])
      .filter((entry) => entry.kind === 'reconciliation');
    expect(reconciliationEntries.map((entry) => entry.data.cause)).toEqual(['binding-missing']);
  }, 15_000);

  it('resume：日志末 provider 非 ACP → 以历史 provider 委派父类', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    harness.llm.registerAdapter(['deepseek'], new MockLlmAdapter([textResponse('resumed natively')]));
    harness.persistence.seed(SessionId('resume-native'), seedLogWithHeader('deepseek', 'deepseek-chat'));

    // 不带 agentOptions.provider：强制走 request/header 窥测一路
    const handle = await harness.loop.resume(harness.ctx, {
      resumeSessionId: SessionId('resume-native'),
      agentOptions: { provider: routeOf(profile), model: 'transient-default-model' },
    });
    harness.handles.push(handle);

    expect(handle.agent).not.toBeInstanceOf(AcpAgent);
    expect(handle.agent.constructor.name).toBe('ReactLoopAgent');
    expect(harness.persistence.inspectCalls).toEqual([SessionId('resume-native')]);
    // 历史 provider 是恢复真源；回填后不依赖瞬时全局默认或 waterfall 才能续接。
    expect(handle.agent.options.provider).toBe('deepseek');
    expect(handle.agent.options.model).toBe('deepseek-chat');

    // 委派出的原生 agent 是活体：经 agent/request waterfall 供路由（dsh 既定扩展点）跑通 turn
    harness.ctx.on('agent/request', async (payload, next) => {
      if (payload.agent !== handle.agent) return next();
      return { ...(await next()), provider: 'deepseek', model: 'deepseek-chat' };
    });
    handle.agent.followup(userText('continue natively'));
    await handle.agent.whenIdle();
    expect(turnEndReasons(handle.agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });
    // 原生路 resume：既有 header 仍在，新 header 标 resume
    const headers = eventsOf(handle.agent, 'request/header');
    expect(headers.at(-1)?.data.reason).toBe('resume');
    expect(headers.at(-1)?.data.header.config.provider).toBe('deepseek');
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

  it('resume：日志无 request/header → 委派父类', async () => {
    const harness = await boot();
    await registerAcpAgents(harness, [mockProfile(harness.logDir, 'happy')]);
    harness.persistence.seed(SessionId('resume-noheader'), seedLogWithoutHeader());

    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: SessionId('resume-noheader') });
    harness.handles.push(handle);

    expect(handle.agent).not.toBeInstanceOf(AcpAgent);
    expect(handle.agent.constructor.name).toBe('ReactLoopAgent');
  });
});

describe('turn 驱动事件序列（happy）', () => {
  it('完整 turn：契约事件序列 + 无 step/* + turn=1 + append 纪律', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('turn-happy'));
    const agent = handle.agent;

    agent.followup(userText('Say hello to the mock world.'));
    await agent.whenIdle();

    // 契约序列（去掉 agent/inbox/spliced 簿记）：turn/start → user/message →
 // request/header → 翻译事件（tool/call 前先 flush 文本段为
    // assistant/message）→ 尾部 plan 段 message → turn/end；无 step/*
    expect(contractEventTypes(agent)).toEqual([
      'turn/start',
      'user/message',
      'request/header',
      'assistant/chunk', 'assistant/chunk', // thought：block-start + reasoning-delta
      'assistant/chunk', 'assistant/chunk', 'assistant/chunk', // block-end + text block-start + delta
      'assistant/chunk', 'assistant/chunk', // text-delta ×2
      'assistant/chunk', 'assistant/message', 'tool/call', // segment flush 先于 tool/call
      'tool/result',
      'assistant/chunk', 'assistant/chunk', 'assistant/chunk', // plan 三元组（新 segment）
      'request/context',
      'assistant/message',
      'turn/end',
    ]);

    // turn/start / turn/end 编号与结局
    const starts = eventsOf(agent, 'turn/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.data.turn).toBe(1);
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }]);

    // user/message：先于 request/header 落盘（持久化顺序），surfaceOp append
    const userMessages = eventsOf(agent, 'user/message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.surfaceOp).toBe('append');
    expect(userMessages[0]?.data.content).toEqual([{ type: 'text', text: 'Say hello to the mock world.' }]);
    expect(userMessages[0]?.data.source).toEqual({ kind: 'user' });

    // request/header：initial + acp-<id> 路由 + ACP 当前模型
    const headers = eventsOf(agent, 'request/header');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.data.reason).toBe('initial');
    expect(headers[0]?.data.header.config).toEqual({ provider: routeOf(profile), model: 'mock-model-a' });

 // 翻译事件挂在 turn 1；step 是 presentation step（segment 1 文本段 = 1，
    // plan 段 = 3——tool 段占了 2）；无 step/start|end
    const chunks = eventsOf(agent, 'assistant/chunk');
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks.slice(0, 8)) {
      expect(chunk.data.turn).toBe(1);
      expect(chunk.data.step).toBe(ACP_STEP);
    }
    for (const chunk of chunks.slice(8)) {
      expect(chunk.data.turn).toBe(1);
      expect(chunk.data.step).toBe(3);
    }
    expect(eventsOf(agent, 'step/start')).toEqual([]);
    expect(eventsOf(agent, 'step/end')).toEqual([]);

 // tool/result 引用其 tool/call（sourceEventSeqs）；：tool 段 step 2
    const toolCalls = eventsOf(agent, 'tool/call');
    const toolResults = eventsOf(agent, 'tool/result');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.data.step).toBe(2);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.surfaceOp).toBe('append');
    expect(toolResults[0]?.sourceEventSeqs).toEqual([toolCalls[0]?.seq]);
    expect(toolResults[0]?.data.error).toBeUndefined();

 // turn 内两条 assistant/message——segment 1（tool/call 前 flush，
    // sourceEventSeqs 恰为本段全部 chunk）与 plan 段（endTurn 收口）
    const assistant = eventsOf(agent, 'assistant/message');
    expect(assistant).toHaveLength(2);
    const message = assistant[0];
    expect(message?.surfaceOp).toBe('append');
    expect(message?.sourceEventSeqs).toEqual(chunks.slice(0, 8).map((event) => event.seq));
    expect(message?.data.turn).toBe(1);
    expect(message?.data.step).toBe(ACP_STEP);
    expect(message?.data.message.content).toEqual([
      { type: 'reasoning', text: 'Thinking about the mock request.' },
      { type: 'text', text: 'Hello, mock world.' },
    ]);
    const planMessage = assistant[1];
    expect(planMessage?.surfaceOp).toBe('append');
    expect(planMessage?.sourceEventSeqs).toEqual(chunks.slice(8).map((event) => event.seq));
    expect(planMessage?.data.turn).toBe(1);
    expect(planMessage?.data.step).toBe(3);
    expect(planMessage?.data.message.content).toEqual([
      {
        type: 'reasoning',
        text: 'Agent 计划：\n- [completed] Inspect the request\n- [completed] Produce a reply\n- [completed] Report usage',
      },
    ]);
    expect(message?.data.message.source).toMatchObject({ kind: 'model', provider: routeOf(profile), model: 'mock-model-a' });
 // usage_update 不落伪 TokenUsage——message 恒不带 usage；
    // 上下文占用经 agent.contextUsage（live state 通道）暴露
    expect(message?.data).not.toHaveProperty('usage');
    expect((agent as AcpAgent).contextUsage).toEqual({ used: 1234, size: 1048576, percent: 0.1, cost: null });
    // request/context 记录 contextWindow（usage_update 的 size）
    const contexts = eventsOf(agent, 'request/context');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.data).toEqual({ provider: routeOf(profile), model: 'mock-model-a', contextWindow: 1048576 });
  }, 15_000);

  it('第二 turn：turn 编号递增为 2；模型未变时不重复落 request/header', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('turn-second'));
    const agent = handle.agent;

    agent.followup(userText('first'));
    await agent.whenIdle();
    agent.followup(userText('second'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/start').map((event) => event.data.turn)).toEqual([1, 2]);
    expect(turnEndReasons(agent)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
    ]);
    expect(eventsOf(agent, 'user/message')).toHaveLength(2);
    expect(eventsOf(agent, 'request/header')).toHaveLength(1);
 // happy turn 每 turn 两条 assistant/message（文本段 + plan 段）
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(4);
  }, 15_000);
});

describe('ACP_EMPTY_RESPONSE（零可见输出的成功 turn 落说明消息）', () => {
  it('empty-turn scenario：turn 正常完成但零输出 → ACP_EMPTY_RESPONSE_NOTE（step 0 泳道、无 sourceEventSeqs、不进对账）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'empty-turn');
    const handle = await createAcpAgent(harness, profile, SessionId('empty-response'));
    const agent = handle.agent;

    agent.followup(userText('say nothing'));
    await agent.whenIdle();

    // turn 正常收束；无任何内容事件（无 chunk/工具/内容 message）
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }]);
    expect(eventsOf(agent, 'assistant/chunk')).toEqual([]);
    expect(eventsOf(agent, 'tool/call')).toEqual([]);
    const messages = eventsOf(agent, 'assistant/message');
    expect(messages).toHaveLength(1);
    const note = messages[0];
    expect(note?.data.turn).toBe(1);
    expect(note?.data.step).toBe(ACP_NOTE_STEP); // 说明消息专用泳道，不占内容 segment
    expect(note?.surfaceOp).toBe('append');
    expect(note?.sourceEventSeqs).toBeUndefined(); // 说明消息不进对账期望序列
    expect(note?.data.message.content).toEqual([{ type: 'text', text: ACP_EMPTY_RESPONSE_NOTE }]);
  }, 15_000);
});

describe('懒启动与进程复用', () => {
  it('create 不 spawn；首个 turn 才 spawn；同会话后续 turn 复用同一子进程', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('lazy-start'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);

 // 创建后、甚至 whenIdle 之后都不允许有会话子进程（门内 probe 已结算退出）
    await handle.agent.whenIdle();
    expect(spawnedPids(profile.logPath)).toHaveLength(1); // 门内 probe
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);

    handle.agent.followup(userText('first'));
    await handle.agent.whenIdle();
    expect(spawnedPids(profile.logPath)).toHaveLength(2); // probe + 首个 turn 懒启动的会话进程

    handle.agent.followup(userText('second'));
    await handle.agent.whenIdle();
    // 两 turn 复用同一进程（无每 turn respawn）
    expect(spawnedPids(profile.logPath)).toHaveLength(2);
    expect(readLog(profile.logPath).match(/--> session\/prompt/g)).toHaveLength(2);
  }, 15_000);
});

describe('cancel', () => {
  it('turn 中途 cancel：session/cancel 到达 mock + turn/end aborted{user} + 已流 chunk 保留 + 无 agent/error', async () => {
    const harness = await boot();
    // 拉宽 update 间隔，留出 cancel 插入窗口
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '80' });
    const handle = await createAcpAgent(harness, profile, SessionId('cancel-mid'));
    const agent = handle.agent;
    const errors = trackErrors(harness, agent);
    const statuses = trackStatuses(harness, agent);

    agent.followup(userText('cancel me mid turn'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 2);
    expect(agent.status).toBe('running');
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();

    // mock 侧确认收到 session/cancel（turn 仍活跃时到达）
    expect(readLog(profile.logPath)).toContain('session/cancel sessionId=mock-session-1 turnActive=true');
    // 本地 cause 优先于 agent 回报的 stopReason
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }]);
    // 已流出的部分输出保留：turn 末仍 flush 出 assistant/message
    const assistant = eventsOf(agent, 'assistant/message');
    expect(assistant).toHaveLength(1);
    const texts = assistant[0]?.data.message.content.map((block) => (block.type === 'text' || block.type === 'reasoning' ? block.text : ''));
    expect(texts?.join('')).toContain('Thinking about the mock request.');
    // 取消不是错误：无 agent/error；状态机收敛 idle
    expect(errors).toEqual([]);
    expect(agent.status).toBe('idle');
    expect(statuses).toEqual(['running', 'idle']);
  }, 15_000);

  it('idle 时 cancel 无副作用：无事件、无 spawn、保持 idle', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('cancel-idle'));
    const agent = handle.agent;

    agent.cancel({ kind: 'user' });
    await agent.whenIdle();

    expect(agent.session.events).toEqual([]);
    expect(agent.status).toBe('idle');
 // 除创建门的门内 probe 外无任何会话 spawn/请求
    expect(spawnedPids(profile.logPath)).toHaveLength(1);
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
  });

  it('cancel 清理排队中的 followup：inbox discarded + outcome canceled + 不再开第二 turn', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '80' });
    const handle = await createAcpAgent(harness, profile, SessionId('cancel-queue'));
    const agent = handle.agent;
    const discarded: string[] = [];
    harness.ctx.on('agent/inbox/discarded', (payload) => {
      if (payload.agent !== agent) return;
      const [block] = payload.message.content;
      discarded.push(block?.type === 'text' ? block.text : '<non-text>');
    });

    agent.followup(userText('turn one'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    agent.followup(userText('queued then canceled'));
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();

    // 排队消息被丢弃：live 通知 + 持久化 splice 的 canceled 结局
    expect(discarded).toEqual(['queued then canceled']);
    const splices = eventsOf(agent, 'agent/inbox/spliced');
    expect(splices.some((event) => event.data.outcome === 'canceled' && event.data.target === 'next-turn')).toBe(true);
    // 被清理的消息从不进入模型可见日志；只开了一个 turn
    const userMessages = eventsOf(agent, 'user/message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.data.content).toEqual([{ type: 'text', text: 'turn one' }]);
    expect(eventsOf(agent, 'turn/start')).toHaveLength(1);
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }]);
    expect(readLog(profile.logPath).match(/--> session\/prompt/g)).toHaveLength(1);
    expect(agent.inbox.hasPending).toBe(false);
  }, 15_000);

 it('cancel 后 agent 不停稳：限时等待 → 升级进程 terminate（升级阶梯），turn 以本地 cause 收束', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'cancel-stuck');
    const handle = await createAcpAgent(harness, profile, SessionId('cancel-escalate'));
    const agent = handle.agent;
    const errors = trackErrors(harness, agent);

    agent.followup(userText('stuck turn'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    expect(agent.status).toBe('running');
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();

    const log = readLog(profile.logPath);
    // cancel 帧照常送达（mock 故意记录但不停 turn）；等满停稳预算后升级 SIGTERM
    expect(log).toContain('session/cancel sessionId=mock-session-1 turnActive=true');
    expect(log).toContain('cancel-stuck: session/cancel received; turn intentionally NOT stopped');
    expect(log).toContain('SIGTERM received, exit(0)');
    // 本地 cause 优先：turn 以 aborted{user} 收束而非 error；取消不是错误
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }]);
    expect(errors).toEqual([]);
    expect(agent.status).toBe('idle');
    // 已流出 chunk 不丢（升级终止前收到的部分输出照常收口）
    const deltas = eventsOf(agent, 'assistant/chunk')
      .map((event) => event.data.chunk)
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []));
    expect(deltas).toEqual(['Stuck turn working']);

    // 升级后连接已死但不自动重建（与 crash-mid-turn 钉死的 v1 边界对称）：
    // 后续 turn 在已关闭连接上快速失败，不 spawn 新进程
    agent.followup(userText('after escalation'));
    await agent.whenIdle();
    const reasons = turnEndReasons(agent);
    expect(reasons.map((entry) => entry.turn)).toEqual([1, 2]);
    expect(reasons[1]?.reason.kind).toBe('error');
    const failure = reasons[1]?.reason.kind === 'error' ? reasons[1].reason.error : undefined;
    expect(failure?.message).toContain('connection is closed');
    expect(spawnedPids(profile.logPath)).toHaveLength(2); // 门内 probe + 会话进程（无新 spawn）
  }, 25_000);
});

describe(' 会话指标（loop.acpMetrics 快照）', () => {
  it('happy turn：acp.initialize(result=ok) 与 acp.prompt(result=end_turn) 各计一次', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('metrics-happy'));
    handle.agent.followup(userText('metrics please'));
    await handle.agent.whenIdle();

    const timers = harness.loop.acpMetrics.snapshot().timers;
    const initialize = timers.find((timer) => timer.name === 'acp.initialize');
    const prompt = timers.find((timer) => timer.name === 'acp.prompt');
    expect(initialize?.labels).toEqual({ result: 'ok' });
    expect(initialize?.count).toBe(1);
    expect(prompt?.labels).toEqual({ result: 'end_turn' });
    expect(prompt?.count).toBe(1);
  });

  it('turn 中途 cancel：acp.cancel(cause=user) 计数、acp.prompt 记 cancelled；顺利 turn 不计 cancel', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '80' });
    const handle = await createAcpAgent(harness, profile, SessionId('metrics-cancel'));
    const agent = handle.agent;

    agent.followup(userText('cancel me'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 2);
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();

    const snapshot = harness.loop.acpMetrics.snapshot();
    expect(snapshot.counters).toContainEqual({ name: 'acp.cancel', labels: { cause: 'user' }, value: 1 });
    const prompt = snapshot.timers.find((timer) => timer.name === 'acp.prompt');
    expect(prompt?.labels).toEqual({ result: 'cancelled' });
    expect(prompt?.count).toBe(1);
  }, 15_000);
});

describe('followup 排队', () => {
  it('running 时 followup → 当前 turn 结束后顺序开下一 turn', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '50' });
    const handle = await createAcpAgent(harness, profile, SessionId('followup-queue'));
    const agent = handle.agent;

    agent.followup(userText('first prompt'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    expect(agent.status).toBe('running');
    agent.followup(userText('second prompt'));
    await agent.whenIdle();

    // 两个顺序 turn：编号 1、2，各完成
    expect(eventsOf(agent, 'turn/start').map((event) => event.data.turn)).toEqual([1, 2]);
    expect(turnEndReasons(agent)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
    ]);
    // 两条 user/message 各归其 turn，且第二条在第一个 turn/end 之后落盘
    const contracted = contractEventTypes(agent);
    const firstEnd = contracted.indexOf('turn/end');
    const secondUser = contracted.lastIndexOf('user/message');
    expect(secondUser).toBeGreaterThan(firstEnd);
    const userMessages = eventsOf(agent, 'user/message');
    expect(userMessages.map((event) => event.data.content)).toEqual([
      [{ type: 'text', text: 'first prompt' }],
      [{ type: 'text', text: 'second prompt' }],
    ]);
    // mock 侧收到两次顺序 prompt（同一进程、同一会话；另有创建门的门内 probe 一条 started）
    expect(readLog(profile.logPath).match(/--> session\/prompt/g)).toHaveLength(2);
    expect(spawnedPids(profile.logPath)).toHaveLength(2);
  }, 15_000);
});

describe('request/header change（setConfigOption 热切换）', () => {
  it('setConfigOption 换模型 → 下一 turn request/header reason=change，assistant/message 跟随新模型', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('header-change'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('before switch'));
    await agent.whenIdle();
    expect(eventsOf(agent, 'request/header')).toHaveLength(1);

    await agent.setConfigOption('model', 'mock-model-b');
 // 状态槽同步（seam 读面）
    expect(agent.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('mock-model-b');

    agent.followup(userText('after switch'));
    await agent.whenIdle();

    const headers = eventsOf(agent, 'request/header');
    expect(headers).toHaveLength(2);
    expect(headers[1]?.data.reason).toBe('change');
    expect(headers[1]?.data.header.config).toEqual({ provider: routeOf(profile), model: 'mock-model-b' });
    const assistant = eventsOf(agent, 'assistant/message');
 // happy turn 每 turn 两条（文本段 + plan 段）；换模型后 turn 2 两条都跟随新模型
    expect(assistant).toHaveLength(4);
    expect(assistant[0]?.data.message.source).toMatchObject({ model: 'mock-model-a' });
    expect(assistant[1]?.data.message.source).toMatchObject({ model: 'mock-model-a' });
    expect(assistant[2]?.data.message.source).toMatchObject({ model: 'mock-model-b' });
    expect(assistant[3]?.data.message.source).toMatchObject({ model: 'mock-model-b' });
    expect(turnEndReasons(agent)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
    ]);
  }, 15_000);

 it('running 时 setConfigOption 拒绝（竞态拒绝策略在执行点强制）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '80' });
    const handle = await createAcpAgent(harness, profile, SessionId('header-busy'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('busy turn'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    expect(agent.status).toBe('running');
    await expect(agent.setConfigOption('model', 'mock-model-b')).rejects.toThrow('only allowed while idle');

    agent.cancel({ kind: 'user' });
    await agent.whenIdle();
    // 取消后空闲，允许切换
    await agent.setConfigOption('model', 'mock-model-b');
    expect(agent.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('mock-model-b');
  }, 15_000);

 it('并发两次 setConfigOption：迟到响应不覆盖更新的状态（generation 守卫）', async () => {
    const harness = await boot();
    // out-of-order-config：第一笔挂起不回应，第二笔先回（现状快照），再补第一笔的
    // 迟到响应（其当时快照）——无守卫时最终状态会回退到第一笔的值
    const profile = mockProfile(harness.logDir, 'out-of-order-config');
    const handle = await createAcpAgent(harness, profile, SessionId('config-generation'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('establish config snapshot'));
    await agent.whenIdle();
    expect(agent.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('mock-model-a');

    const stale = agent.setConfigOption('model', 'mock-model-x'); // 被 mock 挂起，快照携带 x
    await agent.setConfigOption('model', 'mock-model-b'); // 先应答并应用：currentValue=b
    await stale; // 迟到响应（快照携带 x）到达——generation 已易主，必须丢弃

    expect(agent.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('mock-model-b');
    // 两笔请求都真正上了线（乱序是对端应答侧的事，不是本地串行化）
    expect(readLog(profile.logPath).match(/--> session\/set_config_option/g)).toHaveLength(2);
  }, 15_000);
});

describe('异常', () => {
  it('crash-mid-turn：turn/end error ACP_CRASH + 已流 chunk 保留 + agent/error；下一 turn 全新连接重试', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'crash-mid-turn');
    const handle = await createAcpAgent(harness, profile, SessionId('crash-turn'));
    const agent = handle.agent;
    const errors = trackErrors(harness, agent);

    agent.followup(userText('crash on me'));
    await agent.whenIdle();

    // 错误结局：ACP_CRASH 分类
    expect(turnEndReasons(agent)).toEqual([
      { turn: 1, reason: { kind: 'error', error: { code: 'ACP_CRASH', message: expect.any(String) } } },
    ]);
    // 已流出的两个 chunk 不丢，且 turn 末 flush 成 assistant/message
    const deltas = eventsOf(agent, 'assistant/chunk')
      .map((event) => event.data.chunk)
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []));
    expect(deltas).toEqual(['Partial', ' output']);
    const assistant = eventsOf(agent, 'assistant/message');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.data.message.content).toEqual([{ type: 'text', text: 'Partial output' }]);
    // 失败在存活边界报告过一次
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AcpClientError);
    expect((errors[0] as AcpClientError).kind).toBe('crash');
    expect(agent.status).toBe('idle');

    // v1 边界（黑盒实测）：崩溃后连接不自动重建——后续 turn 在已死连接上快速失败，
 // 仍分类 ACP_CRASH，且不 spawn 新进程（恢复是 resume seam 的职责）。
    agent.followup(userText('retry after crash'));
    await agent.whenIdle();
    const reasons = turnEndReasons(agent);
    expect(reasons.map((entry) => entry.turn)).toEqual([1, 2]);
    expect(reasons[1]?.reason.kind).toBe('error');
    expect(reasons[1]?.reason.kind === 'error' && reasons[1].reason.error.code).toBe('ACP_CRASH');
    expect(spawnedPids(profile.logPath)).toHaveLength(2); // 门内 probe + 会话进程（崩溃后不自动重建）
    expect(errors).toHaveLength(2);
  }, 20_000);

  it('auth_required：session/prompt 回 -32000 → turn/end error ACP_AUTH_REQUIRED，错误信息含 login hint；probe 缓存失效', async () => {
    const harness = await boot();
    // 内联 fixture：initialize 正常（广告一个 authMethods）、session/new 正常；
 // initialize/session/new 阶段的 auth_required 由创建门拦截（wiring.spec
    // 生产接线 覆盖），本用例钉的是运行时（prompt 阶段）凭据失效路径
    const authAgent = `
// ${SPEC_TAG}-inline-auth
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: {}, auth: {} },
        authMethods: [{ id: 'mock-sso', name: 'Mock SSO' }],
        agentInfo: { name: 'auth-mock', title: 'Auth Mock', version: '1.0.0' },
      } }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'auth-session-1' } }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
    const profile = inlineProfile(harness.logDir, authAgent, 'mock auth login --sso');
    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('auth-required'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);
    const agent = handle.agent;
    const errors = trackErrors(harness, agent);

    agent.followup(userText('needs auth'));
    await agent.whenIdle();

    const reasons = turnEndReasons(agent);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.reason.kind).toBe('error');
    const failure = reasons[0]?.reason.kind === 'error' ? reasons[0].reason.error : undefined;
    expect(failure?.code).toBe('ACP_AUTH_REQUIRED');
    // 面向用户：说明需要认证 + 带 login hint 指引
    expect(failure?.message).toContain('requires authentication');
    expect(failure?.message).toContain('login hint: mock auth login --sso');
    expect(errors).toHaveLength(1);
    expect((errors[0] as AcpClientError).kind).toBe('auth_required');
    // 启动失败路径先拆进程再抛：无孤儿（afterAll 的 ps 扫描兜底）
    expect(eventsOf(agent, 'assistant/message')).toEqual([]);
    expect(agent.status).toBe('idle');
 // 运行时 auth_required 使 probe 缓存失效（agent.ts turn catch 接线）——
    // 下次过创建门会重新 probe，health 行回落 saved-unverified
    expect(harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile))).toBeUndefined();
  }, 15_000);

 it('启动失败不缓存（创建门口径）：未修复时 createAgent 即拒 ACP_AUTH_REQUIRED；修好外部条件 + 刷新 probe 后重建并成功', async () => {
    const harness = await boot();
    // 内联 flaky fixture：flag 文件不存在时 session/new 回 -32000；存在则正常建会话
    const flagPath = path.join(harness.logDir, 'flaky-fixed.flag');
    const spawnLog = path.join(harness.logDir, 'flaky-spawns.log');
    const flakyAgent = `
// ${SPEC_TAG}-inline-flaky
const fs = require('node:fs');
const FLAG = ${JSON.stringify(flagPath)};
fs.appendFileSync(${JSON.stringify(spawnLog)}, 'spawned pid=' + process.pid + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: {}, auth: {} },
        authMethods: [],
        agentInfo: { name: 'flaky-mock', title: 'Flaky Mock', version: '1.0.0' },
      } }) + '\\n');
    } else if (msg.method === 'session/new') {
      if (!fs.existsSync(FLAG)) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'flaky-session-1' } }) + '\\n');
      }
    } else if (msg.method === 'session/prompt') {
      const sid = msg.params.sessionId;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' }, messageId: 'm1' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
    const profile = inlineProfile(harness.logDir, flakyAgent);
    await registerAcpAgents(harness, [profile]);

 // session/new 阶段的 auth_required 由门内 probe 撞见 → createAgent 直接拒绝
    // （旧行为「会话建起、首 turn 才失败」的窗口已随创建门关闭）
    const rejected: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('start-retry'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(rejected).toBeInstanceOf(AcpClientError);
    expect((rejected as AcpClientError).code).toBe('ACP_AUTH_REQUIRED');
    expect(readLog(spawnLog).match(/spawned pid=/g)).toHaveLength(1); // 门内 probe 的一次 spawn

    // 外部条件修复（相当于用户完成登录）+ 面板刷新（invalidateProbe）→ 重过门
    fs.writeFileSync(flagPath, '');
    harness.loop.acpRegistry.adapter.invalidateProbe(routeOf(profile));
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('start-retry'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);
    const agent = handle.agent;
    // 缓存失败不黏住重建：门重 probe（第二次 spawn）
    expect(readLog(spawnLog).match(/spawned pid=/g)).toHaveLength(2);

    agent.followup(userText('second attempt succeeds'));
    await agent.whenIdle();

    const reasons = turnEndReasons(agent);
    expect(reasons.map((entry) => entry.turn)).toEqual([1]);
    expect(reasons[0]?.reason).toEqual({ kind: 'completed' });
    expect(readLog(spawnLog).match(/spawned pid=/g)).toHaveLength(3); // probe ×2 + 会话进程
    const assistant = eventsOf(agent, 'assistant/message');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.data.message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    // 首个成功 turn 的 request/header 仍是 initial
    const headers = eventsOf(agent, 'request/header');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.data.reason).toBe('initial');
  }, 20_000);
});

describe('图片输入（Agent 能力 ∩ DSH durable attachment seam）', () => {
  it('image-only prompt 通过 attachment store 读取并发送，原消息只保留 durable ref', async () => {
    const attachment = { attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 8, height: 8 };
    const readImage = vi.fn().mockResolvedValue({ ref: attachment, data: Uint8Array.of(1, 2, 3) });
    const harness = await boot({ attachments: { readImage } });
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('image-supported'));
    const agent = handle.agent;
    const errors = trackErrors(harness, agent);

    agent.followup(createUserMessage({
      content: [{ type: 'image', attachment }],
      source: { kind: 'user' },
    }));
    await agent.whenIdle();

    const reasons = turnEndReasons(agent);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.reason).toEqual({ kind: 'completed' });
    expect(errors).toEqual([]);
    expect(readImage).toHaveBeenCalledWith(attachment, expect.any(AbortSignal));
    expect(readLog(profile.logPath)).toContain('--> session/prompt');
    const userMessages = eventsOf(agent, 'user/message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.data.content).toEqual([{ type: 'image', attachment }]);
    expect(agent.status).toBe('idle');
  }, 15_000);

  it('缺少 attachment service 时在 session/prompt 前阻止并给出可操作错误', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('image-no-store'));
    const agent = handle.agent;
    agent.followup(createUserMessage({
      content: [{
        type: 'image',
        attachment: { attachmentId: 'att-missing' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
      }],
      source: { kind: 'user' },
    }));
    await agent.whenIdle();

    const reason = turnEndReasons(agent)[0]?.reason;
    expect(reason?.kind).toBe('error');
    if (reason?.kind === 'error') expect(reason.error.message).toContain('attachment storage is unavailable');
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
  }, 15_000);
});

describe('创建门 probe 缓存 TTL', () => {
  // 新鲜条目不重 probe；ok 条目过 TTL（10min）后创建门按「从未探测」补一次
  // probe（agent-loop.ts assertAcpProfileReady → acpProbeFresh）。只 fake Date
  // （不碰 setTimeout），避免把 probe 自身的超时计时器冻结。
  it('ok 条目新鲜时创建门不重复 spawn；过期后重过门补 probe（spawn +1）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

    const first = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('ttl-fresh'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(first);
    // 门内 probe 的一次 spawn（会话进程懒启动，此处不 spawn）
    expect(spawnedPids(profile.logPath)).toHaveLength(1);

    // 缓存新鲜：紧接着第二次过门不重复 probe
    const second = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('ttl-fresh-again'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(second);
    expect(spawnedPids(profile.logPath)).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000); // 越过 ACP_PROBE_CACHE_OK_TTL_MS
      const third = await harness.loop.createAgent(harness.ctx, {
        sessionId: SessionId('ttl-expired'),
        meta: { cwd: harness.logDir },
        agentOptions: { provider: routeOf(profile) },
      });
      harness.handles.push(third);
      // 过期条目按 miss 计：门内补一次 probe → 第二次 spawn
      expect(spawnedPids(profile.logPath)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('dispose', () => {
  it('跑过 turn 后 dispose：EOF→SIGTERM 梯子拆除子进程、pid 死亡、幂等', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-ladder'));
    handle.agent.followup(userText('run then dispose'));
    await handle.agent.whenIdle();
    const pids = spawnedPids(profile.logPath);
    expect(pids).toHaveLength(2); // 门内 probe + 会话进程

    const first = handle.dispose();
    const second = handle.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    // 梯子：mock 不吃 stdin EOF（devin 口径），等满 EOF 窗口后 SIGTERM 生效
    const log = readLog(profile.logPath);
    expect(log).toContain('stdin EOF; staying alive until SIGTERM');
    expect(log).toContain('SIGTERM received, exit(0)');
    for (const pid of pids) await waitFor(() => isDead(pid));
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
    // dispose 后 agent 离注册表
    expect(harness.ctx.agents.get(SessionId('dispose-ladder'))).toBeUndefined();
  }, 15_000);

  it('从未启动（无 turn）的 agent dispose：无会话进程产生，直接收束', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-virgin'));

    await handle.dispose();

 // 除门内 probe（已退出）外零会话 spawn、零 prompt
    expect(spawnedPids(profile.logPath)).toHaveLength(1);
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
    expect(handle.agent.session.events).toEqual([]);
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
  }, 15_000);

  it('turn 中途 dispose：disposed cause 取消 + mock 收到 cancel + turn/end aborted{disposed} + 无孤儿', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '80' });
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-mid'));

    handle.agent.followup(userText('dispose me mid turn'));
    await waitFor(() => eventsOf(handle.agent, 'assistant/chunk').length >= 1);
    await handle.dispose();

    expect(turnEndReasons(handle.agent)).toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }]);
    const log = readLog(profile.logPath);
    expect(log).toContain('session/cancel sessionId=mock-session-1 turnActive=true');
    expect(log).toContain('SIGTERM received, exit(0)');
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
    expect(handle.agent.status).toBe('idle');
  }, 15_000);

 it('失控 agent（永不响应 prompt 且无视 cancel）下 dispose 有界完成：取消梯子升级 terminate + whenIdle 收束 + 无孤儿', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'cancel-stuck');
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-stuck'));
    const agent = handle.agent;

    agent.followup(userText('stuck turn'));
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    expect(agent.status).toBe('running');

    const t0 = Date.now();
    await handle.dispose();
    // dispose = disposed cause 取消 → 取消梯子（cancelGraceMs 停稳预算）→ 升级
    // terminate；whenIdle 随 turn 收束而收敛。全程有限：远低于套件级超时
    expect(Date.now() - t0).toBeLessThan(12_000);
    const log = readLog(profile.logPath);
    expect(log).toContain('cancel-stuck: session/cancel received; turn intentionally NOT stopped');
    expect(log).toContain('SIGTERM received, exit(0)');
    expect(turnEndReasons(agent)).toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }]);
    expect(agent.status).toBe('idle');
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
  }, 25_000);

 it('卸载时新 turn 被拒（钉死）：已启动过 → turn/end error（连接已释放），不 spawn 新进程', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-no-new-turn'));
    handle.agent.followup(userText('run then dispose'));
    await handle.agent.whenIdle();
    await handle.dispose();

    // dispose 后的 followup 仍能进 turn 边界（注册表级拦截不在本层）——
    // 拒绝面在执行点：连接已随 closeConnection 释放，fail loud 而非静默重开
    handle.agent.followup(userText('post-dispose turn'));
    await handle.agent.whenIdle();

    const reasons = turnEndReasons(handle.agent);
    expect(reasons.map((entry) => entry.turn)).toEqual([1, 2]);
    expect(reasons[1]?.reason.kind).toBe('error');
    const failure = reasons[1]?.reason.kind === 'error' ? reasons[1].reason.error : undefined;
    expect(failure?.message).toContain('ACP session is not started');
    // 无新 spawn、无新 prompt 帧（计数含创建门的门内 probe）
    expect(spawnedPids(profile.logPath)).toHaveLength(2);
    expect(readLog(profile.logPath).match(/--> session\/prompt/g)).toHaveLength(1);
  }, 15_000);

 it('卸载时新 turn 被拒（钉死）：从未启动 → lifecycle 非法转换 fail loud', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('dispose-virgin-no-turn'));
    await handle.dispose();

    handle.agent.followup(userText('post-dispose turn'));
    await handle.agent.whenIdle();

    const reasons = turnEndReasons(handle.agent);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.reason.kind).toBe('error');
    const failure = reasons[0]?.reason.kind === 'error' ? reasons[0].reason.error : undefined;
    expect(failure?.message).toContain('illegal ACP session lifecycle transition: disposed -> starting');
    // 拒绝在会话 spawn 之前：除门内 probe 外零进程、零请求
    expect(spawnedPids(profile.logPath)).toHaveLength(1);
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
  }, 15_000);
});

describe('生命周期状态机：cold → starting → live → closing → disposed 的集成接线', () => {
  it('创建即 cold；首个 turn 懒启动后 live；dispose 后 disposed（幂等重入不漂移）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('lifecycle-happy'));
    const agent = handle.agent as AcpAgent;

    // 懒启动前：cold（不 spawn 由既有路由套件断言）
    expect(agent.lifecycleState).toBe('cold');

    agent.followup(userText('drive lifecycle'));
    await agent.whenIdle();
    expect(agent.lifecycleState).toBe('live');

    await handle.dispose();
    expect(agent.lifecycleState).toBe('disposed');
    // 幂等重入：再 dispose 不抛不漂移
    await handle.dispose();
    expect(agent.lifecycleState).toBe('disposed');
  }, 15_000);

  it('从未启动即 dispose：cold → disposed，无进程产生', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('lifecycle-virgin'));
    const agent = handle.agent as AcpAgent;

    expect(agent.lifecycleState).toBe('cold');
    await handle.dispose();

    expect(agent.lifecycleState).toBe('disposed');
 // 除门内 probe（已退出）外零会话 spawn
    expect(spawnedPids(profile.logPath)).toHaveLength(1);
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
    expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
  }, 15_000);

 it('：命令缺失在创建门即拒（spawn-failure 进缓存），不再留到懒启动；错误带稳定 code + correlation id', async () => {
    const harness = await boot();
    const gone: MockProfile = {
      id: 'gone1',
      logPath: path.join(harness.logDir, 'gone.log'),
      config: {
        name: 'Gone Agent',
        command: '/nonexistent/dsh-acp-lifecycle-missing-bin',
        args: [],
        env: {},
      },
    };
    await registerAcpAgents(harness, [gone]);

    // 门内 probe 以 spawn-failure 落缓存 → createAgent 直接拒绝（旧行为的
    // 「cold → starting → cold 可重试」turn 级窗口已随创建门关闭；运行时进程
    // 失败路径由 crash-mid-turn / cancel-stuck 用例继续钉）
    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('lifecycle-retry'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(gone) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    const thrown = error as AcpClientError;
    expect(thrown.kind).toBe('spawn-failure');
    expect(thrown.code).toBe('ACP_SPAWN_FAILURE');
    expect(thrown.category).toBe('config');
    expect(thrown.correlationId).toMatch(ACP_CORRELATION_ID_PATTERN);
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(gone));
    expect(snapshot?.result.kind === 'error' ? snapshot.result.failureKind : undefined).toBe('spawn-failure');
    expect(fs.existsSync(gone.logPath)).toBe(false);
  }, 15_000);
});

describe('状态机与维护提示', () => {
  it('一个完成的 turn 产生 running/idle 各一次跃迁；whenIdle 在静默后 resolve', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('status-flip'));
    const agent = handle.agent;
    const statuses = trackStatuses(harness, agent);

    let settled = false;
    agent.followup(userText('flip status'));
    const idle = agent.whenIdle().then(() => {
      settled = true;
    });
    await waitFor(() => eventsOf(agent, 'assistant/chunk').length >= 1);
    expect(agent.status).toBe('running');
    expect(settled).toBe(false);
    await idle;
    expect(settled).toBe(true);
    expect(agent.status).toBe('idle');
    expect(statuses).toEqual(['running', 'idle']);
  }, 15_000);

  it('runMaintenance：执行 job 并发 dsh-acp/maintenance 提示事件；维护期 status 仍 idle；running 时拒绝', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_STEP_DELAY_MS: '50' });
    const handle = await createAcpAgent(harness, profile, SessionId('maintenance'));
    const agent = handle.agent;
    const hints: Agent[] = [];
    harness.ctx.on('dsh-acp/maintenance', (payload) => hints.push(payload.agent));

    const result = await agent.runMaintenance((signal) => {
      expect(signal.aborted).toBe(false);
      expect(agent.status).toBe('idle'); // maintenance 不对外暴露 running
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(hints).toEqual([agent]);

    // running 时拒绝维护
    agent.followup(userText('busy'));
    await waitFor(() => agent.status === 'running');
    expect(() => agent.runMaintenance(() => Promise.resolve(0))).toThrow('already has active work');
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();
  }, 15_000);
});

describe(' sidecar retention 启动接线（agent-loop.ts 构造期一次性清扫）', () => {
  /** 轮询直到超龄行被启动清扫删除（sweep 是 fire-and-forget，轮询是确定性等待条件）。 */
  async function waitSwept(sidecar: NonNullable<AgentHarness['loop']['acpSidecar']>, sessionId: SessionId, expected: number): Promise<number> {
    const deadline = Date.now() + 5_000;
    let remaining = -1;
    for (;;) {
      remaining = (await sidecar.list(sessionId)).length;
      if (remaining === expected || Date.now() > deadline) return remaining;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function seedRow(root: string, time: number): Promise<void> {
    const seeder = createAcpSidecar({ root });
    return seeder
      .append(SessionId('sess-retention'), {
        kind: 'degradation',
        time,
        data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false },
      })
      .then(() => seeder.flush())
      .then(() => seeder.dispose());
  }

  it('插件挂载即一次性清扫：超龄 audit 行删除、新鲜行保留（不阻塞激活）', async () => {
    const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
    const sidecarRoot = path.join(logDir, 'dsh-home', 'dsh-acp');
    // 预置（显式 time 是 sidecar append 的契约面）：一超龄 + 一新鲜
    await seedRow(sidecarRoot, Date.now() - ACP_SIDECAR_DEFAULT_RETENTION_MS - 60_000);
    await seedRow(sidecarRoot, Date.now());

    const harness = await createHarness(logDir, {});
    harnesses.push(harness);
    const sidecar = harness.loop.acpSidecar;
    expect(sidecar).toBeDefined();
    expect(await waitSwept(sidecar!, SessionId('sess-retention'), 1)).toBe(1);
  }, 15_000);

  it('清扫失败（库损坏 fail loud）不阻断插件激活：仅 warn 继续，sidecar 照常接线', async () => {
    const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
    const sidecarRoot = path.join(logDir, 'dsh-home', 'dsh-acp');
    fs.mkdirSync(sidecarRoot, { recursive: true });
    // 垃圾字节充当损坏库：enforceRetention open 即 reject → 构造期 catch 仅 warn
    fs.writeFileSync(path.join(sidecarRoot, 'sidecar.sqlite'), Buffer.from('not a sqlite database'));

    const harness = await createHarness(logDir, {});
    harnesses.push(harness);
    expect(harness.loop.acpSidecar).toBeDefined();
    // fire-and-forget 的 catch 已挂：给清扫一拍时间结算，不应出现未处理拒绝导致进程/套件崩溃
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 15_000);
});
