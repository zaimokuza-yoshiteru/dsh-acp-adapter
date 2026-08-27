// resume.spec.ts — 黑盒测试：会话恢复矩阵（resume / sidecar binding /
// reconciliation-required 阻断）。
// 按契约编写，与实现隔离：只断言公开契约——session 日志事件、mock 子进程收到的
// 请求序列（MOCK_LOG）、sidecar 文件内容（AcpSidecar 公开接口）、文案常量
// （src/domain/session/resume.ts 的 ACP_RESUME_* / ACP_RECONCILIATION_* 导出）、
// AcpAgent.continuityState。不断言任何私有实现面。
//
// 矩阵（「可证明的 binding 和恢复」）：
//   1. 正常恢复：sidecar 预置全字段 binding（agent-test-helpers.bindingFixture）
//      + 与 mock LOAD_REPLAY 逐条对应的种子日志（seedLogMatchingLoadReplay）→
//      resume 后首个 turn 走 session/load（预检 + staging 回放 + 对账全过）；
//      回放期更新零落盘（事件计数钉死）；回放后新 turn 正常落盘；binding 续代
//      重写（同 id 同 generation，dshCommittedSeq 推进到日志尖）。
//   2. 恢复失败一律**阻断**（不再降级 session/new）：capability-missing /
//      id-not-found / load-failed → turn 以 ACP_RECONCILIATION_REQUIRED 收束、
//      continuityState blocked、sidecar 落 reconciliation 记录、binding 不重写。
//      list 调用抛错不权威——照试 load（load 才是权威），恢复成功。
//   3. fork：最新语义边界且 Agent 广告 fork 时走 session/fork；不具备条件时
//      session/new 并明确记录空白降级。
//   4. 崩溃中途：seed 日志以 turn/end{interrupted} 结尾 → outcome-unknown 说明
//      （turn 号正确）、幂等闩锁、不自动重试（零 spawn）。
//   5. marker-first 路由：有 binding 时 binding 优先于日志窥测；显式 provider 与
//      binding 不匹配时 binding 不生效；无 binding 但日志有本路由 ACP 史 →
// binding-missing 阻断（不再沉默 session/new）。
// 6. 双绑守卫：同一 ACP session 不得同时绑定两个活动 dsh session——
// 双绑守卫拒绝 = binding-in-use 阻断（零 spawn），不再降级新开。
// 7. 重连残留警告：load 响应后迟到的内容类残留无损落盘 + 一次性警告
//      （load-late-replay 场景：staging 在 load 响应时关闭，迟到更新不进对账）。
//
// 组装层见 test/agent-test-helpers.ts。afterEach 兜底 dispose 全部 handle；
// 共享 subprocess runtime 在文件结束时兜底回收。

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  ACP_FORK_BLANK_NOTE,
  ACP_RECONCILIATION_GUIDANCE,
  ACP_RESUME_OUTCOME_UNKNOWN_NOTE,
  ACP_RESUME_RESIDUE_NOTE,
  isLatestSemanticForkSeed,
  stableToolInputProjection,
} from '../../../src/domain/session/resume.ts';
import type { AcpReconciliationCause, AcpSidecarEntry } from '../../../src/persistence/sidecar.ts';
import { ACP_NOTE_STEP } from '../../../src/protocol/v1/translate.ts';
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
  seedLogWithHeader,
  userText,
  waitFor,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

describe('fork seed semantic boundary', () => {
  it('allows only non-visible host metadata after the committed prefix', () => {
    const seed = [
      { type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/title', seq: 1, time: 2, data: { title: 'branch' } },
    ] as unknown as SessionEvent[];
    expect(isLatestSemanticForkSeed(seed, 1)).toBe(true);
    expect(isLatestSemanticForkSeed(seed, 0)).toBe(true);
    const olderCut = [...seed, { type: 'user/message', seq: 2, time: 3, data: { content: [], source: { kind: 'user' } } }] as unknown as SessionEvent[];
    expect(isLatestSemanticForkSeed(olderCut, 1)).toBe(false);
  });
});

describe('Devin multi-diff content projection', () => {
  it('finds an exact path/hash/length match after an unrelated first diff', () => {
    const content = 'target-content';
    const hash16 = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
    const input = { file_path: '/workspace/target.txt', content };
    const meta = { acpToolContent: { items: [
      { type: 'diff', path: '/workspace/other.txt', hash16, originalChars: content.length },
      { type: 'diff', path: '/workspace/target.txt', hash16, originalChars: content.length },
    ] } };
    expect(stableToolInputProjection(input, 'edit', meta, { runtime: 'devin' })).toEqual({ file_path: input.file_path });
  });

  it('accepts Devin path spelling while preserving the original key', () => {
    const content = 'target-content';
    const hash16 = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
    const input = { path: '/workspace/target.txt', content, overwrite: true };
    const meta = { acpToolContent: { items: [{ type: 'diff', path: input.path, hash16, originalChars: content.length }] } };
    expect(stableToolInputProjection(input, 'edit', meta, { runtime: 'devin' }))
      .toEqual({ path: input.path, overwrite: true });
  });

  it('stays fail-closed for near matches, wrong runtime, and missing diffs', () => {
    const content = 'target-content';
    const hash16 = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
    const input = { file_path: '/workspace/target.txt', content };
    const meta = { acpToolContent: { items: [{ type: 'diff', path: '/workspace/target.txt', hash16, originalChars: content.length + 1 }] } };
    expect(stableToolInputProjection(input, 'edit', meta, { runtime: 'devin' })).toEqual(input);
    expect(stableToolInputProjection(input, 'edit', { acpToolContent: { items: [] } }, { runtime: 'devin' })).toEqual(input);
    expect(stableToolInputProjection(input, 'edit', meta, { runtime: 'codex' })).toEqual(input);
    expect(stableToolInputProjection({ file_path: input.file_path, path: '/workspace/other.txt', content }, 'edit', meta, { runtime: 'devin' }))
      .toEqual({ file_path: input.file_path, path: '/workspace/other.txt', content });
  });
});

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, {});
  harnesses.push(harness);
  return harness;
}

/** 隐式 resume（无 agentOptions.provider：走 marker-first 路由）并登记 handle。 */
async function resumeImplicit(
  harness: AgentHarness,
  profile: MockProfile,
  sessionId: SessionId,
): Promise<AgentHandle> {
  await registerAcpAgents(harness, [profile]);
  const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
  harness.handles.push(handle);
  return handle;
}

/** sidecar 预置一条 全字段 binding（经 loop 安装的 AcpSidecar 公开接口，即生产选址）。 */
async function presetBinding(
  harness: AgentHarness,
  sessionId: SessionId,
  binding: ReturnType<typeof bindingFixture>,
): Promise<void> {
  const sidecar = harness.loop.acpSidecar;
  expect(sidecar).toBeDefined();
  await sidecar?.append(sessionId, { kind: 'binding', data: binding });
}

type BindingEntry = Extract<AcpSidecarEntry, { kind: 'binding' }>;
type ForkEntry = Extract<AcpSidecarEntry, { kind: 'session-fork' }>;

/** 该会话 sidecar 里的全部 binding entry（落盘顺序 = append 顺序）。 */
async function bindingEntries(harness: AgentHarness, sessionId: SessionId): Promise<BindingEntry[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry): entry is BindingEntry => entry.kind === 'binding');
}

async function forkEntries(harness: AgentHarness, sessionId: SessionId): Promise<ForkEntry[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry): entry is ForkEntry => entry.kind === 'session-fork');
}

/** 该会话 sidecar 里的全部 reconciliation 记录的 cause（落盘顺序）。 */
async function reconciliationCauses(harness: AgentHarness, sessionId: SessionId): Promise<AcpReconciliationCause[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry) => entry.kind === 'reconciliation').map((entry) => entry.data.cause);
}

/** MOCK_LOG 里 mock 子进程收到的请求方法序列（`--> <method> id=` 行）。 */
function mockRequests(logPath: string): string[] {
  return [...readLog(logPath).matchAll(/--> (\S+) id=/g)].map((match) => match[1] ?? '');
}

type AssistantMessageEvent = Extract<SessionEvent, { type: 'assistant/message' }>;

/** assistant/message 的全文本（text + reasoning 块拼接；说明消息为纯 text）。 */
function messageText(event: AssistantMessageEvent): string {
  return event.data.message.content
    .map((block) => (block.type === 'text' || block.type === 'reasoning' ? block.text : ''))
    .join('');
}

function assistantTexts(agent: Agent): string[] {
  return eventsOf(agent, 'assistant/message').map(messageText).filter((text) => text !== '');
}

/** turn/end 的 {turn, reason} 序列。 */
function turnEndReasons(agent: Agent): { turn: number; reason: SessionEvent<'turn/end'>['data']['reason'] }[] {
  return eventsOf(agent, 'turn/end').map((event) => ({ turn: event.data.turn, reason: event.data.reason }));
}

/** 阻断断言组：continuity 闩锁（status+cause）+ 末个 turn/end 的错误码 + 出路文案。 */
function expectBlocked(agent: Agent, cause: AcpReconciliationCause): void {
  const continuity = (agent as AcpAgent).continuityState;
  expect(continuity.status).toBe('blocked');
  expect(continuity.cause).toBe(cause);
  const lastEnd = turnEndReasons(agent).at(-1);
  expect(lastEnd?.reason.kind).toBe('error');
  expect(['ACP_RECOVERY_REQUIRED', 'ACP_RECONCILIATION_REQUIRED']).toContain(lastEnd?.reason.kind === 'error' ? lastEnd.reason.error.code : undefined);
  expect(lastEnd?.reason.kind === 'error' ? lastEnd.reason.error.message : '').toContain(ACP_RECONCILIATION_GUIDANCE);
}

/** 崩溃中途的持久化日志：turn 1 完整（含 request/header），turn 2 以 interrupted 收尾。
 *  不手加 session/end-seed——Session 构造（fromRestore）自动补种（移交注意②）。 */
function seedLogWithInterruptedTail(provider: string, model: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: userText('first question'), surfaceOp: 'append' },
    {
      type: 'request/header',
      seq: 2,
      time: 3,
      data: { header: { config: { provider, model } }, reason: 'initial' },
    },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 5, time: 6, data: userText('second question, crashed mid-turn'), surfaceOp: 'append' },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 2, reason: { kind: 'interrupted' } } },
  ] as unknown as SessionEvent[];
}

/** 只有 request/header、零可见事件的持久化日志（load-late-replay 对账用：期望可见历史为空）。 */
function seedLogHeaderOnly(provider: string, model: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'request/header',
      seq: 1,
      time: 2,
      data: { header: { config: { provider, model } }, reason: 'initial' },
    },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 3, time: 4, data: {} },
  ] as unknown as SessionEvent[];
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-resume-spec-'));
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

describe('正常恢复（binding + 预检 + 对账全过）', () => {
  it('后台连接重建：Agent 广告 session/resume 时首个新 turn 直接恢复原语义会话', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-background-resume']),
      MOCK_ADVERTISE_RESUME: '1',
      // session/load 若被误用会因回放缺失而失败，确保本用例真实钉住分流。
      MOCK_LOAD_REPLAY_VARIANT: 'omit-assistant-tail',
    });
    const sessionId = SessionId('resume-background-native');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-background-resume',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue after being idle'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/resume', 'session/prompt']);
    expect(readLog(profile.logPath)).toContain('session/resume preset-background-resume: no replay');
    expect(readLog(profile.logPath)).not.toContain('session/load preset-background-resume');
    expect((handle.agent as AcpAgent).continuityState).toEqual({ status: 'ok', cause: null, detail: null });
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect(turnEndReasons(handle.agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });
  }, 15_000);

  it('首 turn 走 session/load 而非 new；回放零落盘（事件计数钉死）；回放后新 turn 正常落盘；binding 续代重写同 id', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    });
    const sessionId = SessionId('resume-ok');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-alpha',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);

    // resume 本身不落任何新事件（懒启动：此刻连子进程都不存在）
 // 种子事件序 = live 真实落盘序：tool/call 到达前先把开放文本段
    // flush 成 block-end + assistant/message（先于 tool 事件落盘）
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'request/header',
      'assistant/chunk', 'assistant/chunk', 'assistant/chunk', 'assistant/message',
      'tool/call', 'tool/result', 'turn/end', 'session/end-seed',
    ]);
    expect(fs.existsSync(profile.logPath)).toBe(false);

    agent.followup(userText('continue after resume'));
    await agent.whenIdle();

    // mock 侧请求序列：initialize → list（命中）→ load → prompt；全程无 session/new
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load', 'session/prompt']);
    // 回放确实发生过（否则对账通过就是空验——mock 日志见证 6 条回放已发出）
    expect(readLog(profile.logPath)).toContain('session/load preset-alpha: replaying 6 updates (variant=full)');

    // 回放期更新零落盘：可见历史计数钉死（种子与回放内容逐条对应——若回放漏进
    // 翻译层落盘，user/assistant/tool 各类事件必然多出一份）
    expect(eventsOf(agent, 'user/message')).toHaveLength(2); // seed + 新 turn
 // 新 turn 两条 assistant/message（tool/call 前的文本段 flush + 尾部
    // plan 的 reasoning 段 flush），加 seed 一条共 3 条
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(4);
    expect(eventsOf(agent, 'tool/call').map((event) => ({ turn: event.data.turn, callId: event.data.callId })))
      .toEqual([
        { turn: 1, callId: 'mock-load-tool-1' }, // seed（与回放对账相符的那条）
        { turn: 2, callId: 'mock-tool-1' }, // 新 turn 的合法工具事件
      ]);
    expect(eventsOf(agent, 'tool/result').map((event) => event.data.turn)).toEqual([1, 2]);

    // 回放结束后的新 turn 正常落盘：turn 2 完整边界、completed 收尾
    expect(eventsOf(agent, 'turn/start').map((event) => event.data.turn)).toEqual([1, 2]);
    expect(turnEndReasons(agent)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
    ]);
    // load 响应的 configOptions 被正常消费：resume header 模型来自 ACP 侧快照
    const headers = eventsOf(agent, 'request/header');
    expect(headers).toHaveLength(2);
    expect(headers[1]?.data.reason).toBe('resume');
    expect(headers[1]?.data.header.config).toEqual({ provider: routeOf(profile), model: 'mock-model-a' });

    // 连续性全程 ok（对账通过，无 reconciliation 记录）
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'ok', cause: null, detail: null });
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);

    // binding 续代重写（同 ACP id、同 generation、同 establishedAt/historyBaseSeq）：
    // 3 行 = 预置 fixture + load 建立时重写 + turn 2 收束后的锚点刷新；
    // 最新一行的 dshCommittedSeq 推进到日志尖
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual(['preset-alpha', 'preset-alpha', 'preset-alpha']);
    const latest = bindings.at(-1)!.data;
    expect(latest.provider).toBe(routeOf(profile));
    expect(latest.generation).toBe(1);
    expect(latest.historyBaseSeq).toBe(0);
    expect(latest.establishedAt).toBe(1);
    expect(latest.dshCommittedSeq).toBe(agent.session.seq);
    expect(latest.dshCommittedSeq).toBeGreaterThan(LOAD_REPLAY_MATCHED_COMMITTED_SEQ);
 // configOptions/mode 的 last-known 快照改由 option_snapshots 表承载
    // （binding 不再携带一次性 configSnapshot）；快照内容钉在 sidecar.spec.ts
    // 与 model-switch 套件
    expect((await harness.loop.acpSidecar?.readOptionSnapshot(sessionId))?.currentModeId).toBe('accept-edits');
    // sidecar 落盘位置契约（此后单库）：<dshHome>/dsh-acp/sidecar.sqlite
    expect(fs.existsSync(path.join(harness.dshHome, 'dsh-acp', 'sidecar.sqlite'))).toBe(true);
  }, 15_000);

  it('真实闭环：live 混合 turn（文本+tool 交织）→ dispose → resume 走 recorded-replay，分段对账通过、会话可用', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'mixed-turn', {
      // resume 的 fresh spawn 要在 list 里看到旧会话：mock 首个 session/new 恒为
      // mock-session-1（确定性序号）；回放流由 recorded-replay 提供——该会话 live
      // 期实际收到的更新流经 recordings 文件跨进程找回，不再是手工对齐的固定夹具
      MOCK_PRESET_SESSIONS: JSON.stringify(['mock-session-1']),
    });
    await registerAcpAgents(harness, [profile]);
    const sessionId = SessionId('resume-mixed-live');
    const first = await harness.loop.createAgent(harness.ctx, {
      sessionId,
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(first);

    first.agent.followup(userText('read the notes file'));
    await first.agent.whenIdle();
    expect(turnEndReasons(first.agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }]);

 // live 混合 turn 的落盘序钉死：tool/call 到达前先把 msg-1 的开放
    // 文本段 flush 成 assistant/message（先于 tool 事件落盘——「正文在 tool 卡片
    // 上方」不再跳变）；msg-2 在 tool 之后开新 segment，turn 内共两条
    // assistant/message，各引本段 chunk
    const firstTypes = first.agent.session.events.map((event) => event.type);
    expect(firstTypes.indexOf('assistant/message')).toBeGreaterThan(-1);
    expect(firstTypes.indexOf('assistant/message')).toBeLessThan(firstTypes.indexOf('tool/call'));
    expect(firstTypes.indexOf('assistant/message')).toBeLessThan(firstTypes.indexOf('tool/result'));
    expect(eventsOf(first.agent, 'assistant/message')).toHaveLength(3);
    expect(assistantTexts(first.agent)).toEqual(['Let me read the file.', 'Done reading.']);

    // dispose + re-seed 模拟宿主重启（内存 fake 不回写 append；meta.cwd 一并带回）
    const persisted = [...first.agent.session.events];
    await first.dispose();
    harness.persistence.seed(sessionId, persisted, { cwd: harness.logDir });

    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);
    second.agent.followup(userText('continue after resume'));
    await second.agent.whenIdle();

    // 三段请求序列：门内 probe → live 会话（new+prompt）→ resume（list 命中 →
    // load 走 recorded-replay → prompt）；全程无第二次 session/new 建会话
    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/new', 'session/prompt',
      'initialize', 'session/list', 'session/load', 'session/prompt',
    ]);
    expect(readLog(profile.logPath)).toContain('session/load mock-session-1: replaying 5 updates (recorded-replay)');

    // 分段对账通过：无 reconciliation 记录、continuity 全程 ok、turn 2 正常完成
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect((second.agent as AcpAgent).continuityState).toEqual({ status: 'ok', cause: null, detail: null });
    expect(turnEndReasons(second.agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });

    // 回放零落盘 + 新 turn 正常落盘：user 两份（turn 1 种子 + turn 2）；
 // assistant 四份（混合 turn 每 turn 两条 segment message）；
    // tool/call 两个 turn 各一条
    expect(eventsOf(second.agent, 'user/message')).toHaveLength(2);
    expect(eventsOf(second.agent, 'assistant/message')).toHaveLength(6);
    expect(eventsOf(second.agent, 'tool/call').map((event) => ({ turn: event.data.turn, callId: event.data.callId })))
      .toEqual([
        { turn: 1, callId: 'mock-tool-mixed-1' },
        { turn: 2, callId: 'mock-tool-mixed-1' },
      ]);

    // binding 全程指同一 ACP 会话（live 建立 + 锚点刷新 + load 重写 + turn 2 刷新），
    // 最新一行锚点推进到日志尖
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual([
      'mock-session-1', 'mock-session-1', 'mock-session-1', 'mock-session-1',
    ]);
    expect(bindings.at(-1)?.data.dshCommittedSeq).toBe(second.agent.session.seq);
  }, 15_000);

 it('真实闭环（非对称工具回放）：live 占位首帧 + update 终态事实（claude 形态）→ dispose → resume 回放终态合并帧，对账判一致、会话可用', async () => {
    // claude-agent-acp 0.70.0 实证形态的管线级模拟（mock scenario
    // terminal-merge-replay，帧形状依据 Claude ACP 真机验收
    // evidence/21-replay-updates.jsonl）：live 的 tool_call 首帧是进行态占位
    // （rawInput/locations/content 缺席或空），终态事实经进行中 update 帧到达；
    // session/load 回放发终态合并的单条 tool_call 帧。修复前这类会话必判
    // replay-diverged（input/locations/result 发散）；修复后 DSH 侧以 tool/result
    // 的终态快照 meta 对账，判一致。
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'terminal-merge-replay', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['mock-session-1']),
    });
    await registerAcpAgents(harness, [profile]);
    const sessionId = SessionId('resume-terminal-merge');
    const first = await harness.loop.createAgent(harness.ctx, {
      sessionId,
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(first);

    first.agent.followup(userText('write the merged file'));
    await first.agent.whenIdle();
    expect(turnEndReasons(first.agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }]);

 // live 落盘形态钉死：tool/call 是占位首帧事实（name 恒稳定名，占位
    // 标题落 meta.acpToolCall.title；arguments='{}'），
    // 终态事实在配对 tool/result 的 meta.acpToolCall.terminal（title/kind/
    // locations/input 全是终态值）；content 取最新累积（进行中帧的 diff → 摘要块）
    const call = eventsOf(first.agent, 'tool/call')[0];
    expect(call?.data.name).toBe('dsh_acp_external_tool');
    expect((call?.data as { meta?: { acpToolCall?: { title?: string } } }).meta?.acpToolCall?.title).toBe('Preparing file…');
    expect(call?.data.arguments).toBe('{}');
    const result = eventsOf(first.agent, 'tool/result')[0];
    expect(result?.data.meta).toMatchObject({
      acpToolCall: {
        terminal: {
          title: `Write ${harness.logDir}/merged.txt`,
          kind: 'edit',
          locations: [{ path: `${harness.logDir}/merged.txt` }],
          input: { file_path: `${harness.logDir}/merged.txt`, content: 'merged-ok' },
        },
      },
    });
    const resultBlock = result?.data.message.content[0];
    expect(resultBlock?.type).toBe('tool-result');
    if (resultBlock?.type === 'tool-result') {
      expect(resultBlock.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
        .toContain(`[Diff summary] ${harness.logDir}/merged.txt (create)`);
    }

    // dispose + re-seed 模拟宿主重启
    const persisted = [...first.agent.session.events];
    await first.dispose();
    harness.persistence.seed(sessionId, persisted, { cwd: harness.logDir });

    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);
    second.agent.followup(userText('continue after resume'));
    await second.agent.whenIdle();

    // 回放确实走了终态合并形态（mock 日志见证），且对账判一致：continuity 全程
    // ok、零 reconciliation 记录、turn 2 正常完成
    expect(readLog(profile.logPath)).toContain('session/load mock-session-1: replaying 5 updates (recorded-replay(terminal-merge))');
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect((second.agent as AcpAgent).continuityState).toEqual({ status: 'ok', cause: null, detail: null });
    expect(turnEndReasons(second.agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });

 // 回放零落盘 + 新 turn 正常落盘（混合 turn 每 turn 两条 segment message）
    expect(eventsOf(second.agent, 'user/message')).toHaveLength(2);
    expect(eventsOf(second.agent, 'assistant/message')).toHaveLength(6);
    expect(eventsOf(second.agent, 'tool/call').map((event) => event.data.turn)).toEqual([1, 2]);

    // binding 全程指同一 ACP 会话，最新一行锚点推进到日志尖
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual([
      'mock-session-1', 'mock-session-1', 'mock-session-1', 'mock-session-1',
    ]);
    expect(bindings.at(-1)?.data.dshCommittedSeq).toBe(second.agent.session.seq);
  }, 15_000);

 it('主键纪律：dsh sessionId 从不出现在 ACP 协议流量；binding 以 dsh id 键控、ACP id 只是载荷', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    });
    const sessionId = SessionId('resume-key-discipline');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-alpha',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    // ACP 协议流量全文（mock 进程日志：所有收到的请求行）不含 dsh sessionId——
    // 宿主主键永不跨进程边界；ACP 侧会话寻址只用 preset-alpha
    expect(readLog(profile.logPath)).not.toContain('resume-key-discipline');
    // binding 归属：统一读取模型的 dshSessionId == 文件键 == 本 session；
    // ACP 侧 id 只在 acpSessionId/payload 载荷字段
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.dshSessionId)).toEqual(['resume-key-discipline', 'resume-key-discipline', 'resume-key-discipline']);
    expect(bindings.map((entry) => entry.acpSessionId)).toEqual(['preset-alpha', 'preset-alpha', 'preset-alpha']);
    // 全量索引（双绑守卫扫描面）的行项同样以文件键归属本 session
    const index = await harness.loop.acpSidecar?.listBindings();
    expect(index?.map((entry) => entry.dshSessionId)).toEqual(['resume-key-discipline']);
  }, 15_000);
});

describe('阻断：capability-missing（无 loadSession 能力）', () => {
  it('turn 以 ACP_RECONCILIATION_REQUIRED 收束；零 session/new；binding 不重写；reconciliation 记录落盘', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'minimal-caps'); // loadSession: false
    const sessionId = SessionId('resume-cap-missing');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'stale-session-x',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);
    // 懒启动前闩锁未置（能力要握手后才知道）
    expect((agent as AcpAgent).continuityState.status).toBe('ok');

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // 能力缺失在预检⑤短路：initialize 后既不查 list 也不试 load，更没有 session/new
    expect(mockRequests(profile.logPath)).toEqual(['initialize']);
    expectBlocked(agent, 'capability-missing');
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'capability-missing', detail: null });

    // reconciliation 记录恰好一条（cause 对）；binding 一字节不动（旧 id 保留待修因/显式放弃）
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['capability-missing']);
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual(['stale-session-x']);
  }, 15_000);

 it('：阻断计 acp.resume.degraded(cause=capability-missing)', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'minimal-caps');
    const sessionId = SessionId('resume-metrics-blocked');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'stale-session-metrics',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(harness.loop.acpMetrics.snapshot().counters).toContainEqual({
      name: 'acp.resume.degraded',
      labels: { cause: 'capability-missing' },
      value: 1,
    });
    expect(turnEndReasons(handle.agent).at(-1)?.reason.kind).toBe('error');
  }, 15_000);

  it('阻断态经重启可再现：dispose 后再 resume，对账重走仍 capability-missing（闩锁不是进程内意外）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'minimal-caps');
    const sessionId = SessionId('resume-cap-missing-restart');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'stale-session-y',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();
    expect((handle.agent as AcpAgent).continuityState.status).toBe('blocked');

    // re-seed 模拟真实持久化写回后的宿主重启（内存 fake 不回写 append；meta.cwd 一并带回）
    const persisted = [...handle.agent.session.events];
    await handle.dispose();
    harness.persistence.seed(sessionId, persisted, { cwd: harness.logDir });
    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);

    // 重启后闩锁由 binding + 日志重新推导：同一 cause 再次阻断（无状态侥幸）
    second.agent.followup(userText('keep going'));
    await second.agent.whenIdle();
    expect((second.agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'capability-missing', detail: null });
    // The durable recovery gate prevents the second prompt from re-running
    // blockError or appending a duplicate reconciliation record.
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['capability-missing']);
  }, 15_000);
});

describe('阻断：id-not-found / load-failed 与 list 抛错的分岔', () => {
  it('list 分页翻完仍查无 → id-not-found 阻断（确定 miss 不再试 load，更不 session/new）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-a', 'preset-b', 'preset-c']),
      MOCK_LIST_PAGE_SIZE: '1',
    });
    const sessionId = SessionId('resume-id-missing');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-missing',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // 页大小 1 × 预置 3 条 → 恰好三次 list 才翻完；确定 miss → 阻断（无 load/new/prompt）
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/list', 'session/list']);
    expectBlocked(agent, 'id-not-found');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['id-not-found']);
    expect((await bindingEntries(harness, sessionId)).map((entry) => entry.data.agentSessionId))
      .toEqual(['preset-missing']);
  }, 15_000);

  it('list 调用抛错 → 不据此阻断，继续试 load（load 才是权威）；恢复成功且回放零落盘', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'list-fail', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-beta']),
    });
    const sessionId = SessionId('resume-list-fail');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-beta',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // list 抛错不权威：照试 load 并成功；全程无 session/new
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load', 'session/prompt']);
    expect(readLog(profile.logPath)).toContain('session/load preset-beta: replaying 6 updates');

 // 对账通过：无 reconciliation 记录；回放零落盘（事件计数钉死；：
    // 新 turn 两条 segment message + seed 一条 = 3）
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect(eventsOf(agent, 'user/message')).toHaveLength(2);
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(4);
    expect(eventsOf(agent, 'tool/call').map((event) => ({ turn: event.data.turn, callId: event.data.callId })))
      .toEqual([
        { turn: 1, callId: 'mock-load-tool-1' },
        { turn: 2, callId: 'mock-tool-1' },
      ]);

    // binding 续代重写同 id（fixture + 建立重写 + turn 收束锚点刷新共 3 行）；turn 2 正常完成
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual(['preset-beta', 'preset-beta', 'preset-beta']);
    expect(turnEndReasons(agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });
  }, 15_000);

  it('load 抛错 → load-failed 阻断：无 session/new、 binding 不重写、记录落盘', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'load-fail', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-gamma']),
    });
    const sessionId = SessionId('resume-load-fail');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-gamma',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // list 命中 → 试 load → 抛错 → 阻断（无 session/new）
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load']);
    expectBlocked(agent, 'load-failed');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['load-failed']);
    expect((await bindingEntries(harness, sessionId)).map((entry) => entry.data.agentSessionId))
      .toEqual(['preset-gamma']);
  }, 15_000);
});

describe('fork 防御', () => {
  it('draft prepare 先于首条 prompt 时仍按 seed 边界 fork，并在首个 turn 提交正确锚点', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_ADVERTISE_FORK: '1',
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    await registerAcpAgents(harness, [profile]);
    const parentId = SessionId('fork-parent-draft');
    const childId = SessionId('fork-child-draft');
    const seed = seedLogWithHeader(routeOf(profile), 'mock-model-a');
    await presetBinding(harness, parentId, bindingFixture(profile, {
      agentSessionId: 'preset-parent',
      overrides: { historyBaseSeq: 2, dshCommittedSeq: seed.length },
    }));

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: childId,
      seed,
      meta: { cwd: harness.logDir, parentSession: parentId, seedLength: seed.length },
      agentOptions: { provider: routeOf(profile), model: 'mock-model-a' },
    });
    harness.handles.push(handle);
    const agent = handle.agent as AcpAgent;

    // The live picker prepares the ACP session before the child has a real
    // turn, so turnBaseSeq is still zero here.  This must use seedLength,
    // not the draft turn boundary, and must not persist a zero anchor.
    await agent.prepare();
    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/fork',
    ]);
    expect(assistantTexts(agent)).not.toContain(ACP_FORK_BLANK_NOTE);

    agent.followup(userText('continue in the prepared fork'));
    await agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/fork', 'session/prompt',
    ]);
    const childBindings = await bindingEntries(harness, childId);
    expect(childBindings.at(-1)?.data).toMatchObject({
      provider: routeOf(profile),
      agentSessionId: 'mock-session-1',
      generation: 1,
      historyBaseSeq: 2,
    });
    const firstPromptTurnStart = agent.session.events
      .filter((event) => event.type === 'turn/start')
      .at(-1);
    expect(childBindings[0]?.data.dshCommittedSeq).toBe(firstPromptTurnStart?.seq);
    expect(childBindings[0]?.data.dshCommittedSeq).toBeGreaterThan(0);
    expect(childBindings.at(-1)?.data.dshCommittedSeq).toBeGreaterThanOrEqual(seed.length);
    expect((await forkEntries(harness, childId)).map((entry) => entry.data)).toContainEqual(expect.objectContaining({
      outcome: 'inherited',
      reason: 'inherited',
      parentAgentSessionId: 'preset-parent',
      agentSessionId: 'mock-session-1',
    }));
  }, 15_000);

  it('最新语义边界 + Agent 广告 fork：继承原 ACP 上下文，子会话使用独立 binding', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_ADVERTISE_FORK: '1',
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    await registerAcpAgents(harness, [profile]);
    const parentId = SessionId('fork-parent-latest');
    const childId = SessionId('fork-child-latest');
    const seed = seedLogWithHeader(routeOf(profile), 'mock-model-a');
    await presetBinding(harness, parentId, bindingFixture(profile, {
      agentSessionId: 'preset-parent',
      overrides: { historyBaseSeq: 2, dshCommittedSeq: seed.length },
    }));

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: childId,
      seed,
      meta: { cwd: harness.logDir, parentSession: parentId, seedLength: seed.length },
      // A changed transient default must not steal the fork from its seed route.
      agentOptions: { provider: 'openai', model: 'unrelated-default' },
    });
    harness.handles.push(handle);
    handle.agent.followup(userText('continue in the fork'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/fork', 'session/prompt',
    ]);
    expect(readLog(profile.logPath)).toContain('session/fork parent=preset-parent child=mock-session-1');
    expect(assistantTexts(handle.agent)).not.toContain(ACP_FORK_BLANK_NOTE);
    const childBindings = await bindingEntries(harness, childId);
    expect(childBindings.at(-1)?.data).toMatchObject({
      provider: routeOf(profile),
      agentSessionId: 'mock-session-1',
      generation: 1,
      historyBaseSeq: 2,
    });
    expect((await bindingEntries(harness, parentId)).at(-1)?.data.agentSessionId).toBe('preset-parent');
    expect((await forkEntries(harness, childId)).map((entry) => entry.data)).toContainEqual(expect.objectContaining({
      outcome: 'inherited',
      reason: 'inherited',
      parentSessionId: String(parentId),
      parentAgentSessionId: 'preset-parent',
      agentSessionId: 'mock-session-1',
    }));
  }, 15_000);

  it('Agent 未广告 fork：显式空白降级并记录原因，不伪装为上下文继承', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    await registerAcpAgents(harness, [profile]);
    const parentId = SessionId('fork-parent-unsupported');
    const childId = SessionId('fork-child-unsupported');
    const seed = seedLogWithHeader(routeOf(profile), 'mock-model-a');
    await presetBinding(harness, parentId, bindingFixture(profile, {
      agentSessionId: 'preset-parent',
      overrides: { dshCommittedSeq: seed.length },
    }));

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: childId,
      seed,
      meta: { cwd: harness.logDir, parentSession: parentId, seedLength: seed.length },
      agentOptions: { provider: routeOf(profile), model: 'mock-model-a' },
    });
    harness.handles.push(handle);
    handle.agent.followup(userText('continue without native fork'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/new', 'session/prompt',
    ]);
    expect(assistantTexts(handle.agent).filter((text) => text === ACP_FORK_BLANK_NOTE)).toHaveLength(1);
    expect((await forkEntries(harness, childId)).map((entry) => entry.data)).toContainEqual(expect.objectContaining({
      outcome: 'blank',
      reason: 'agent-does-not-advertise-fork',
      parentAgentSessionId: 'preset-parent',
    }));
  }, 15_000);

  it('Agent 广告 fork 但 RPC 失败：首条消息失败且不静默创建空白 ACP 会话', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_ADVERTISE_FORK: '1',
      MOCK_FORK_FAIL: '1',
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    await registerAcpAgents(harness, [profile]);
    const parentId = SessionId('fork-parent-rpc-fail');
    const childId = SessionId('fork-child-rpc-fail');
    const seed = seedLogWithHeader(routeOf(profile), 'mock-model-a');
    await presetBinding(harness, parentId, bindingFixture(profile, {
      agentSessionId: 'preset-parent',
      overrides: { dshCommittedSeq: seed.length },
    }));

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: childId,
      seed,
      meta: { cwd: harness.logDir, parentSession: parentId, seedLength: seed.length },
      agentOptions: { provider: routeOf(profile), model: 'mock-model-a' },
    });
    harness.handles.push(handle);
    handle.agent.followup(userText('do not silently lose the parent context'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual([
      'initialize', 'session/new', 'session/delete',
      'initialize', 'session/fork',
    ]);
    expect(turnEndReasons(handle.agent).at(-1)?.reason.kind).toBe('error');
    expect(await bindingEntries(harness, childId)).toEqual([]);
    expect(assistantTexts(handle.agent)).not.toContain(ACP_FORK_BLANK_NOTE);
  }, 15_000);

  it('fork id 异常命中既有 binding 时 fail-closed，不自动覆盖恢复证据', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    const sessionId = SessionId('resume-fork');
    // fork 会话：日志带 parentSession 谱系；sidecar 里残留一条（id 碰撞的）父会话 binding
    harness.persistence.seed(sessionId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), {
      cwd: harness.logDir,
      parentSession: SessionId('parent-session-x'),
    });
    await presetBinding(harness, sessionId, bindingFixture(profile, { agentSessionId: 'preset-parent' }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'backend-conflict', detail: null });

 // fork 诚实提示：首个 turn 前已落一条说明（turn 字段 = fork 源日志末个
    // turn 号 1），如实告知「agent 侧上下文不继承、从空白开始」
    const notesBefore = eventsOf(agent, 'assistant/message').filter((event) => messageText(event) === ACP_FORK_BLANK_NOTE);
    expect(notesBefore).toHaveLength(1);
    expect(notesBefore[0]!.data.turn).toBe(1);

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // 不恢复 parent，也不覆盖碰撞 binding：在 spawn 前即阻断。
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['backend-conflict']);
    expect(assistantTexts(agent)).not.toContain(ACP_RESUME_RESIDUE_NOTE);
    expect(assistantTexts(agent).filter((text) => text === ACP_FORK_BLANK_NOTE)).toHaveLength(1);
    expectBlocked(agent, 'backend-conflict');

    // 唯一 binding 保持字节级语义不变；用户可显式 rebindBlank 进入下一代。
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.map((entry) => entry.data.agentSessionId)).toEqual(['preset-parent']);
  }, 15_000);

  it('fork 提示幂等：dispose 后重 resume（宿主重启等价）不重复追加；非 fork 的 resume 不多发', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-parent']),
    });
    const sessionId = SessionId('resume-fork-twice');
    harness.persistence.seed(sessionId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), {
      cwd: harness.logDir,
      parentSession: SessionId('parent-session-y'),
    });

    const first = await resumeImplicit(harness, profile, sessionId);
    expect(assistantTexts(first.agent).filter((text) => text === ACP_FORK_BLANK_NOTE)).toHaveLength(1);

    // re-seed 模拟宿主重启（内存 fake 不回写 append；parentSession 谱系一并带回）
    const persisted = [...first.agent.session.events];
    await first.dispose();
    harness.persistence.seed(sessionId, persisted, {
      cwd: harness.logDir,
      parentSession: SessionId('parent-session-y'),
    });
    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);

    // 文本查重闸挡住第二次构造的重复追加
    expect(assistantTexts(second.agent).filter((text) => text === ACP_FORK_BLANK_NOTE)).toHaveLength(1);

    // 对照组：同 harness 里普通（非 fork）ACP 会话的 resume 不带 fork 说明
    const plainId = SessionId('resume-plain-after-fork');
    harness.persistence.seed(plainId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    const plain = await harness.loop.resume(harness.ctx, { resumeSessionId: plainId });
    harness.handles.push(plain);
    expect(assistantTexts(plain.agent)).not.toContain(ACP_FORK_BLANK_NOTE);
  }, 15_000);
});

describe('崩溃中途恢复（outcome-unknown）', () => {
  it('interrupted 尾巴 → 说明消息（turn 号正确、文案常量）；不自动重试（零 spawn / 零 prompt）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('resume-crash');
    harness.persistence.seed(sessionId, seedLogWithInterruptedTail(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, { agentSessionId: 'preset-crashed' }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);

    // 事件尾：[turn/end{interrupted}, session/end-seed（构造自动补种）, 说明消息]
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'request/header', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed', 'assistant/message',
    ]);
    const note = eventsOf(agent, 'assistant/message').at(-1)!;
    expect(messageText(note)).toBe(ACP_RESUME_OUTCOME_UNKNOWN_NOTE);
    expect(note.data.turn).toBe(2); // 被中断的 turn 号（非硬编码 1）
    expect(note.data.step).toBe(ACP_NOTE_STEP); // 说明消息走 step 0 专用泳道
    expect(note.surfaceOp).toBe('append');
    expect(note.data.message.source).toMatchObject({ provider: routeOf(profile) });
    // 说明消息省略 sourceEventSeqs（对账期望序列据此排除它）
    expect(note.sourceEventSeqs).toBeUndefined();

    // 不自动重试：无用户输入就无任何 prompt——懒启动甚至不 spawn
    await agent.whenIdle();
    expect(agent.status).toBe('idle');
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expect((agent as AcpAgent).recoveryState.kind).toBe('outcome-unknown');

    // A restart with an interrupted turn is an outcome-unknown blocker, not
    // just a note. A later user message must be rejected before the lazy ACP
    // start path, so neither a process nor a prompt can be produced.
    agent.followup(userText('do not retry automatically'));
    await agent.whenIdle();
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expect(mockRequests(profile.logPath)).toEqual([]);
    expect((agent as AcpAgent).recoveryState.kind).toBe('outcome-unknown');
    expectBlocked(agent, 'load-failed');
  }, 15_000);

  it('幂等闩锁：说明消息落盘后二次构造不重复追加（前提：带说明消息的日志可再恢复）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('resume-crash-again');
    harness.persistence.seed(sessionId, seedLogWithInterruptedTail(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, { agentSessionId: 'preset-crashed-2' }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(
      eventsOf(agent, 'assistant/message').filter(
        (event) => messageText(event) === ACP_RESUME_OUTCOME_UNKNOWN_NOTE,
      ),
    ).toHaveLength(1);

    // 「落盘后」的二次构造：内存 fake 不回写 append，此处以 re-seed 模拟真实
    // 持久化的写回——即真实宿主重启后 persistence 后端所见的日志（含说明消息）。
    const persisted = [...agent.session.events];
    await handle.dispose();
    harness.persistence.seed(sessionId, persisted);
    const second = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(second);

    // 闩锁：日志末尾（跳过 end-seed）已是说明消息，不再是被中断的 turn/end
    const notes = eventsOf(second.agent, 'assistant/message').filter(
      (event) => messageText(event) === ACP_RESUME_OUTCOME_UNKNOWN_NOTE,
    );
    expect(notes).toHaveLength(1); // 不重复追加
    expect(notes[0]?.data.turn).toBe(2);
    // 第二实例同样不自动重试
    await second.agent.whenIdle();
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);
});

describe('marker-first 路由', () => {
  it('binding 与日志 provider 冲突：进入 backend-conflict，零 spawn、零覆盖', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-delta']),
    });
    const sessionId = SessionId('resume-marker-priority');
    // 两个持久事实相互矛盾，不能猜哪一边正确。
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay('deepseek', 'deepseek-chat'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-delta',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);
    expect(agent.options.provider).toBe(routeOf(profile));

    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'backend-conflict', detail: null });
    const bindingBefore = await harness.loop.acpSidecar?.readLatestBinding(sessionId);

    agent.followup(userText('continue'));
    await agent.whenIdle();

    expect(fs.existsSync(profile.logPath)).toBe(false);
    expectBlocked(agent, 'backend-conflict');
    expect(await harness.loop.acpSidecar?.readLatestBinding(sessionId)).toEqual(bindingBefore);
  }, 15_000);

  it('显式 provider 与 binding 不同：binding-first 恢复原 backend，不启动瞬时 provider', async () => {
    const harness = await boot();
    const profileA = mockProfile(harness.logDir, 'happy');
    const profileB = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-b']),
    });
    await registerAcpAgents(harness, [profileA, profileB]);
    const sessionId = SessionId('resume-binding-mismatch');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profileB), 'mock-model-a'), { cwd: harness.logDir });
    // binding 属于 B；显式以 A resume
    await presetBinding(harness, sessionId, bindingFixture(profileB, {
      agentSessionId: 'preset-b',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await harness.loop.resume(harness.ctx, {
      resumeSessionId: sessionId,
      agentOptions: { provider: routeOf(profileA), model: 'transient-default-model' },
    });
    harness.handles.push(handle);
    expect(handle.agent).toBeInstanceOf(AcpAgent);
    expect(handle.agent.options.provider).toBe(routeOf(profileB));
    expect(handle.agent.options.model).toBe('mock-model-a');
    expect(harness.persistence.inspectCalls).toEqual([sessionId]);

    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    // A 从未 spawn；B 按原 binding load，不能被默认/显式选择覆盖。
    expect(fs.existsSync(profileA.logPath)).toBe(false);
    expect(mockRequests(profileB.logPath)).toEqual(['initialize', 'session/list', 'session/load', 'session/prompt']);
    expect((handle.agent as AcpAgent).continuityState.status).toBe('ok');
    // binding 仍属于 B。
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.at(-1)?.data.provider).toBe(routeOf(profileB));
    expect(bindings.at(-1)?.data.agentSessionId).toBe('preset-b');
  }, 15_000);

 it('无 sidecar binding：日志有本路由 ACP 史 → binding-missing 阻断（不再沉默 session/new）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('resume-fallback');
    harness.persistence.seed(sessionId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    // 不写 binding

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    expect(agent).toBeInstanceOf(AcpAgent);
    // 窥测确实发生（无 binding 时的回退依据）
    expect(harness.persistence.inspectCalls).toEqual([sessionId]);
    // 构造期即预置闩锁（无需 spawn 即可判定）
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'binding-missing', detail: null });

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // 闩锁在懒启动之前：零 spawn、无 session/new、无新 request/header
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expectBlocked(agent, 'binding-missing');
    expect(eventsOf(agent, 'request/header')).toHaveLength(1);
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['binding-missing']);
    // binding 从未建立（阻断不写新 binding）
    expect(await bindingEntries(harness, sessionId)).toEqual([]);
  }, 15_000);
});

describe('双绑守卫（同一 ACP session 不得同时绑定两个活动 dsh session）', () => {
  it('另一 dsh 会话（仍在宿主会话列表）已绑定同一 ACP session：binding-in-use 阻断，零 spawn，双方 binding 不动', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['shared-acp-x']),
    });
    // holder：持久列表在场的另一会话，sidecar 指向 shared-acp-x
    const holderId = SessionId('holder-a');
    harness.persistence.seed(holderId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, holderId, bindingFixture(profile, { agentSessionId: 'shared-acp-x' }));
    const sessionId = SessionId('resume-double-bind');
    harness.persistence.seed(sessionId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, { agentSessionId: 'shared-acp-x' }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    // 守卫在路由层判定 → 构造期预置闩锁
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'binding-in-use', detail: null });

    agent.followup(userText('continue past the guard'));
    await agent.whenIdle();

    // 守卫阻断：零 spawn（mock 日志从未创建），holder 的 ACP 上下文不被共享
    expect(fs.existsSync(profile.logPath)).toBe(false);
    expectBlocked(agent, 'binding-in-use');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['binding-in-use']);
    // 双方 binding 都一字节不动（冲突留待显式处置，不悄悄改绑）
    expect((await bindingEntries(harness, sessionId)).map((entry) => entry.data.agentSessionId))
      .toEqual(['shared-acp-x']);
    expect((await bindingEntries(harness, holderId)).map((entry) => entry.data.agentSessionId))
      .toEqual(['shared-acp-x']);
  }, 15_000);

  it('幽灵残档（宿主会话列表已无该 session）：放行复用，照常 list → load', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    });
    // 幽灵：只剩 sidecar 残档（会话日志已整体清走，persistence 从未见过该 id）
    await presetBinding(harness, SessionId('ghost-c'), bindingFixture(profile, { agentSessionId: 'preset-alpha' }));
    const sessionId = SessionId('resume-past-ghost');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-alpha',
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('continue'));
    await agent.whenIdle();

    // 放行：正常恢复序列（list 命中 → load），无阻断、无 reconciliation 记录
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load', 'session/prompt']);
    expect((agent as AcpAgent).continuityState.status).toBe('ok');
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect(turnEndReasons(agent).at(-1)).toEqual({ turn: 2, reason: { kind: 'completed' } });
  }, 15_000);

  it('另一活体 agent 正持有该 ACP session：binding-in-use 阻断（在册活体 = 最强冲突证据）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    // 活体 holder：跑完一个 turn（绑定 mock-session-1），仍留在注册表
    const holder = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('holder-live'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(holder);
    holder.agent.followup(userText('holder turn'));
    await holder.agent.whenIdle();

    // 另一 session 的 sidecar 残档指向同一 provider 的同一 ACP session
    const sessionId = SessionId('resume-vs-live');
    harness.persistence.seed(sessionId, seedLogWithHeader(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, { agentSessionId: 'mock-session-1' }));

    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(handle);
    handle.agent.followup(userText('resume attempt'));
    await handle.agent.whenIdle();

 // 守卫阻断：holder 的门内 probe（initialize/session/new + 清理
    // session/delete）+ holder 会话（initialize/new/prompt）之外零新帧——
    // resume 侧连 initialize 都没有
    expect(mockRequests(profile.logPath)).toEqual([
      'initialize',
      'session/new',
      'session/delete',
      'initialize',
      'session/new',
      'session/prompt',
    ]);
    expect(readLog(profile.logPath)).not.toContain('--> session/load');
    expectBlocked(handle.agent, 'binding-in-use');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['binding-in-use']);
    // holder 的绑定不受影响（建立 + 锚点刷新两行，仍指 mock-session-1）
    expect((await bindingEntries(harness, SessionId('holder-live'))).map((entry) => entry.data.agentSessionId))
      .toEqual(['mock-session-1', 'mock-session-1']);
  }, 15_000);
});

describe('重连残留警告（无法证明去重时显示恢复警告，不静默合并）', () => {
  it('load 响应后迟到的 turn 外内容类残留：无损落盘 + 一次性警告；状态槽更新不触发', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'load-late-replay', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-late']),
 // 确定性触发（flake 根治）：残留由一笔 turn 外的 set_config_option 显式触发
      // ——AcpAgent.setConfigOption 仅 idle 放行，mock 收到该请求即确知 client 无
      // 活动 turn 括号，先发残留再响应。旧方案「end_turn 响应后立即发残留」会把
      // 响应与残留合并进同一次管道读取：client 的 turn 收口微任务链（promptOnce
      // → translator.endTurn）尚未跑完，残留被 inTurn 判定归属触发 turn，一次性
      // 警告恒不触发（恰是被测行为的正确面，但测试因此抢跑失败）。
      MOCK_LATE_REPLAY_ON_COMMAND: '1',
    });
    const sessionId = SessionId('resume-residue');
    // 头部-only 种子（零可见事件）：staging 在 load 响应时关闭，迟到残留不进
    // 对账——期望可见历史为空 = staging 空缓冲，对账通过、观察窗 arm
    harness.persistence.seed(sessionId, seedLogHeaderOnly(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await presetBinding(harness, sessionId, bindingFixture(profile, {
      agentSessionId: 'preset-late',
      overrides: { dshCommittedSeq: 4 },
    }));

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('continue after resume'));
    await agent.whenIdle();

    // 恢复本身成功（load 正常走通、对账通过）：无 reconciliation 记录；残留到达前无警告
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load', 'session/prompt']);
    expect(await reconciliationCauses(harness, sessionId)).toEqual([]);
    expect(assistantTexts(agent)).not.toContain(ACP_RESUME_RESIDUE_NOTE);

    // 残留到达（由 turn 外的 set_config_option 触发：mock 先发残留再响应——client
    // 无活动 turn 括号由该 RPC 的 idle 前置条件保证）：config_option_update 状态槽
    // 不触发，两条内容 chunk 触发恰好一条一次性警告
    await (agent as AcpAgent).setConfigOption('model', 'mock-model-b');
 // 两条残留 chunk 间隔一个 STEP_DELAY：等 part 2 落盘再断言（flake 加固同方向）；
    // 说明消息在首条内容残留路由时同步 append，但显式等它出现使断言与落盘顺序解耦
    await waitFor(() => JSON.stringify(agent.session.events).includes(' + part 2'));
    await waitFor(() => assistantTexts(agent).includes(ACP_RESUME_RESIDUE_NOTE));
    const texts = assistantTexts(agent);
    expect(texts.filter((text) => text === ACP_RESUME_RESIDUE_NOTE)).toHaveLength(1);

    // 内容无损保留：两条迟到 chunk 照常进翻译层落盘（turn 外 chunk 序列原样在日志里）
    const deltas = eventsOf(agent, 'assistant/chunk')
      .map((event) => event.data.chunk)
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []));
    expect(deltas).toContain('Late replay residue, part 1');
    expect(deltas).toContain(' + part 2');
  }, 15_000);
});
