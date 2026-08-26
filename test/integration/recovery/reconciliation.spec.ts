// reconciliation.spec.ts — 对账矩阵黑盒测试 + 对账纯函数单元测试。
//
// 与 resume.spec.ts 的分工：resume.spec 钉「正常恢复 + 三大恢复失败阻断 + 路由/
// 守卫」的端到端形态；本文件钉其余 reconciliation cause（预检①-④ / 回放对账三类 /
// binding-outdated）、fail-closed binding 落盘、rebindBlank 全程，以及
// src/domain/session/resume.ts 四个对账纯函数的单元行为。
//
// 黑盒纪律同 resume.spec：只断言 session 日志事件 / MOCK_LOG 帧序 / sidecar 记录 /
// 文案常量 / continuityState，不触私有实现。
//
// 组装层见 test/agent-test-helpers.ts（bindingFixture / seedLogMatchingLoadReplay）。
// 孤儿进程防线与各 spec 同款。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  ACP_REBIND_BLANK_NOTE,
  ACP_TOOL_INPUT_SUMMARY_MAX_CHARS,
  acpToolHistoryDigest,
  acpVisibleTextDigest,
  expectedVisibleHistory,
  normalizeVisibleText,
  reconcileVisibleHistory,
  replayVisibleHistory,
  resolveExpectedRange,
} from '../../../src/domain/session/resume.ts';
import type {
  AcpToolHistoryFacts,
  AcpVisibleHistoryEntry,
} from '../../../src/domain/session/resume.ts';
import { ReplayTranslator, TurnTranslator } from '../../../src/protocol/v1/translate.ts';
import type { AcpBindingData, AcpReconciliationCause } from '../../../src/persistence/sidecar.ts';
import {
  LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
  SPEC_TAG,
  bindingFixture,
  createHarness,
  eventsOf,
  mockProfile,
  psLinesWithTag,
  registerAcpAgents,
  routeOf,
  seedLogMatchingLoadReplay,
  userText,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

const harnesses: AgentHarness[] = [];

async function boot(): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, {});
  harnesses.push(harness);
  return harness;
}

/** 与 LOAD_REPLAY 对账匹配的 resume 预置：种子日志（meta.cwd=logDir）+ 全字段 binding。 */
async function presetMatchedResume(
  harness: AgentHarness,
  profile: MockProfile,
  sessionId: SessionId,
  agentSessionId: string,
  overrides?: Partial<AcpBindingData>,
): Promise<void> {
  harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
  const sidecar = harness.loop.acpSidecar;
  expect(sidecar).toBeDefined();
  await sidecar?.append(sessionId, {
    kind: 'binding',
    data: bindingFixture(profile, {
      agentSessionId,
      overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ, ...overrides },
    }),
  });
}

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

function mockRequests(logPath: string): string[] {
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return [...text.matchAll(/--> (\S+) id=/g)].map((match) => match[1] ?? '');
}

/**
 * 回放共轨测试入口：回放更新流经 ReplayTranslator（与 live 同一个
 * TurnTranslator + PresentationSegmenter，staging sink 只记录不落盘）后折可见历史。
 */
function replayEntries(updates: readonly SessionUpdate[]): AcpVisibleHistoryEntry[] {
  const replay = new ReplayTranslator({ provider: 'acp-mock', model: 'mock-model-a' });
  for (const update of updates) replay.feed(update);
  return replayVisibleHistory(replay.finish());
}

async function reconciliationCauses(harness: AgentHarness, sessionId: SessionId): Promise<AcpReconciliationCause[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry) => entry.kind === 'reconciliation').map((entry) => entry.data.cause);
}

async function bindingRows(harness: AgentHarness, sessionId: SessionId): Promise<AcpBindingData[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry) => entry.kind === 'binding').map((entry) => entry.data);
}

/** 阻断断言：continuity 闩锁（status+cause）+ 末个 turn/end 的错误码。 */
function expectBlocked(agent: Agent, cause: AcpReconciliationCause): void {
  const continuity = (agent as AcpAgent).continuityState;
  expect(continuity.status).toBe('blocked');
  expect(continuity.cause).toBe(cause);
  const lastEnd = eventsOf(agent, 'turn/end').at(-1);
  expect(lastEnd?.data.reason.kind).toBe('error');
  expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.code : undefined)
    .toBe('ACP_RECONCILIATION_REQUIRED');
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-reconciliation-spec-'));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
});

afterAll(() => {
  expect(psLinesWithTag(SPEC_TAG)).toEqual([]);
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

// ---------- 预检阻断（①-④：initialize 后即阻断，零 list/load/new/prompt） ----------

describe('预检阻断（①-④）', () => {
  it('① cwd-changed：binding 的 canonicalCwd 与当前会话 cwd 不一致 → 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-p1']),
    });
    const sessionId = SessionId('recon-cwd');
    // binding 记录的 cwd 是 suiteDir（真实存在的另一目录），会话 cwd 是 logDir
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await harness.loop.acpSidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-p1',
        cwd: suiteDir,
        overrides: { dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ },
      }),
    });

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize']);
    expectBlocked(handle.agent, 'cwd-changed');
    expect((handle.agent as AcpAgent).continuityState.detail).toContain('binding=');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['cwd-changed']);
    expect((await bindingRows(harness, sessionId)).map((row) => row.agentSessionId)).toEqual(['preset-p1']);
  }, 15_000);

  it('② profile-changed：启动指纹（command/args/env 键名）漂移 → 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-p2']),
    });
    const sessionId = SessionId('recon-profile');
    await presetMatchedResume(harness, profile, sessionId, 'preset-p2', {
      launchFingerprint: {
        command: profile.config.command,
        args: ['tampered-agent.mjs'],
        envKeys: Object.keys(profile.config.env).sort(),
      },
    });

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize']);
    expectBlocked(handle.agent, 'profile-changed');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['profile-changed']);
  }, 15_000);

  it('③ agent-changed：对端回报的 agentInfo（name/version）漂移 → 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-p3']),
    });
    const sessionId = SessionId('recon-agent');
    await presetMatchedResume(harness, profile, sessionId, 'preset-p3', {
      agent: { name: 'dsh-mock-acp-agent', version: '9.9.9' },
    });

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize']);
    expectBlocked(handle.agent, 'agent-changed');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['agent-changed']);
  }, 15_000);

  it('④ protocol-changed：协商的 ACP 协议版本漂移 → 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-p4']),
    });
    const sessionId = SessionId('recon-protocol');
    await presetMatchedResume(harness, profile, sessionId, 'preset-p4', { protocolVersion: 2 });

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize']);
    expectBlocked(handle.agent, 'protocol-changed');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['protocol-changed']);
  }, 15_000);
});

// ---------- 回放对账阻断（staging 装载后比对失败；load 已发生，无 new/prompt） ----------

describe('回放对账阻断', () => {
  it('replay-diverged：回放少了结尾（MOCK_LOAD_REPLAY_VARIANT=omit-assistant-tail）→ 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-r1']),
      MOCK_LOAD_REPLAY_VARIANT: 'omit-assistant-tail',
    });
    const sessionId = SessionId('recon-replay-diverged');
    await presetMatchedResume(harness, profile, sessionId, 'preset-r1');

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    // load 确实试过了（回放 5 条 = 6 - 1），对账内容不符 → 阻断；无 session/new
    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load']);
    expect(fs.readFileSync(profile.logPath, 'utf8')).toContain('replaying 5 updates (variant=omit-assistant-tail)');
    expectBlocked(handle.agent, 'replay-diverged');
    // detail 带段级分叉位置（第几 turn 段、哪一层不符）与两侧摘要（有界、无秘密）
    expect((handle.agent as AcpAgent).continuityState.detail).toContain('turn segment 1');
    expect((handle.agent as AcpAgent).continuityState.detail).toContain('assistant text');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['replay-diverged']);
    expect((await bindingRows(harness, sessionId)).map((row) => row.agentSessionId)).toEqual(['preset-r1']);
  }, 15_000);

  it('dsh-log-truncated：回放多出尾部（MOCK_LOAD_REPLAY_VARIANT=extra-user）→ 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-r2']),
      MOCK_LOAD_REPLAY_VARIANT: 'extra-user',
    });
    const sessionId = SessionId('recon-log-truncated');
    await presetMatchedResume(harness, profile, sessionId, 'preset-r2');

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load']);
    expectBlocked(handle.agent, 'dsh-log-truncated');
    expect((handle.agent as AcpAgent).continuityState.detail).toContain('extra replay tail');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['dsh-log-truncated']);
  }, 15_000);

  it('dsh-log-diverged：担保前缀之后还有非崩溃尾巴的可见事件（完整 turn 2）→ 阻断', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-r3']),
    });
    const sessionId = SessionId('recon-log-diverged');
    // 匹配日志（seq 0..9，去掉 end-seed）+ 锚点（dshCommittedSeq=10）之后补一个
    // **完整收束**的 turn 2（completed，不是崩溃尾巴——不可解释）
    const base = seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a').slice(0, -1);
    const seeded = [
      ...base,
      { type: 'turn/start', seq: 10, time: 12, data: { turn: 2 } },
      { type: 'user/message', seq: 11, time: 13, data: userText('post-anchor message'), surfaceOp: 'append' },
      { type: 'turn/end', seq: 12, time: 14, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[];
    harness.persistence.seed(sessionId, seeded, { cwd: harness.logDir });
    await harness.loop.acpSidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, { agentSessionId: 'preset-r3', overrides: { dshCommittedSeq: 10 } }),
    });

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load']);
    expectBlocked(handle.agent, 'dsh-log-diverged');
    expect((handle.agent as AcpAgent).continuityState.detail).toContain('turn 2');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['dsh-log-diverged']);
  }, 15_000);
});

// ---------- digest 对账阻断（同 title/status 的隐性分叉现在必须判分叉） ----------

describe('digest 对账阻断', () => {
  /** 各 variant 的公共断言骨架：load 已发生、replay-diverged 阻断、detail 无篡改原文。 */
  async function expectDigestDivergence(
    variant: string,
    sessionKey: string,
    detailHints: { readonly contains: string; readonly notContains?: string },
  ): Promise<void> {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify([`preset-${sessionKey}`]),
      MOCK_LOAD_REPLAY_VARIANT: variant,
    });
    const sessionId = SessionId(`recon-${sessionKey}`);
    await presetMatchedResume(harness, profile, sessionId, `preset-${sessionKey}`);

    const handle = await resumeImplicit(harness, profile, sessionId);
    handle.agent.followup(userText('continue'));
    await handle.agent.whenIdle();

    expect(mockRequests(profile.logPath)).toEqual(['initialize', 'session/list', 'session/load']);
    expectBlocked(handle.agent, 'replay-diverged');
    const detail = (handle.agent as AcpAgent).continuityState.detail ?? '';
    expect(detail).toContain(detailHints.contains);
    if (detailHints.notContains !== undefined) expect(detail).not.toContain(detailHints.notContains);
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['replay-diverged']);
  }

  it('Devin 被拒工具回放不对称 回归镜像：被拒 tool call 不进回放（omit-tool-call）→ 仍按 replay-diverged 阻断', async () => {
    // /不得为绕过 Devin 被拒工具回放不对称 放宽对账：回放少了 tool 条目 = 段内 tool
    // 多重集回放缺项 → replay-diverged 阻断
    await expectDigestDivergence('omit-tool-call', 'rejected-tool', { contains: 'tool multiset' });
  }, 15_000);

  it('同 title 不同 raw input（different-tool-args）→ 阻断；detail 不泄露参数原文', async () => {
    await expectDigestDivergence('different-tool-args', 'args-diverge', {
      contains: 'tool multiset',
      notContains: 'tampered',
    });
  }, 15_000);

  it('同 title 不同 locations（different-tool-locations）→ 阻断', async () => {
    await expectDigestDivergence('different-tool-locations', 'locations-diverge', {
      contains: 'tool multiset',
      notContains: 'tampered',
    });
  }, 15_000);

  it('同 title 同参数不同结果内容（different-tool-result）→ 阻断；detail 不泄露结果原文', async () => {
    await expectDigestDivergence('different-tool-result', 'result-diverge', {
      contains: 'tool multiset',
      notContains: 'tampered',
    });
  }, 15_000);
});

// ---------- binding-outdated（语义门槛失败的不可用 binding） ----------

describe('binding-outdated', () => {
  it('旧形态 binding（只有 provider+agentSessionId）→ 语义门槛判 outdated → 预置闩锁，零 spawn', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('recon-outdated');
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
 // v1 旧形态：缺 全部必填字段（结构合法性过、语义门槛不过）
    await harness.loop.acpSidecar?.append(sessionId, {
      kind: 'binding',
      data: { provider: routeOf(profile), agentSessionId: 'old-format-id' } as unknown as AcpBindingData,
    });

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent;
    // 路由层判定 → 构造期预置闩锁（无需 spawn）
    expect((agent as AcpAgent).continuityState).toEqual({ status: 'blocked', cause: 'binding-outdated', detail: null });

    agent.followup(userText('continue'));
    await agent.whenIdle();

    expect(fs.existsSync(profile.logPath)).toBe(false);
    expectBlocked(agent, 'binding-outdated');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['binding-outdated']);
    // 旧 binding 行原样保留（不被回退消费，也不被悄悄改写）
    expect((await bindingRows(harness, sessionId)).map((row) => row.agentSessionId)).toEqual(['old-format-id']);
  }, 15_000);
});

// ---------- fail-closed binding 落盘 ----------

describe('fail-closed binding 落盘', () => {
  it('建立后写 binding 失败 → ACP_BINDING_PERSIST_FAILED 拒启（无 prompt 帧；binding 先于 prompt 的旁证）', async () => {
    const harness = await boot();
    // sidecar 库文件（此后为 <dshHome>/dsh-acp/sidecar.sqlite 单库）预置为一个
 // 目录 → open 必失败（fail loud），binding 写不进。不能把整个
    // <dshHome>/dsh-acp 落成文件：创建门 probe 的 probeRoot 也在其下，会先一步
    // ENOTDIR 把 createAgent 拒在门外，够不到 binding 落盘这一步。
    fs.mkdirSync(path.join(harness.dshHome, 'dsh-acp', 'sidecar.sqlite'), { recursive: true });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('recon-persist-fail'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

 // 门内 probe（initialize + session/new + 清理 session/delete）与会话
    // spawn（initialize + session/new）都成功，但 binding 写不进 → 拒启：prompt 从未发出
    expect(mockRequests(profile.logPath)).toEqual([
      'initialize',
      'session/new',
      'session/delete',
      'initialize',
      'session/new',
    ]);
    const lastEnd = eventsOf(handle.agent, 'turn/end').at(-1);
    expect(lastEnd?.data.reason.kind).toBe('error');
    expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.code : undefined)
      .toBe('ACP_BINDING_PERSIST_FAILED');
  }, 15_000);
});

// ---------- rebindBlank（显式放弃旧 ACP 上下文） ----------

describe('rebindBlank', () => {
  it('blocked（capability-missing）→ rebindBlank → 下一 turn session/new 新代际（generation=2 + 说明消息 + 旧历史不参与对账）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'minimal-caps');
    const sessionId = SessionId('recon-rebind');
    await presetMatchedResume(harness, profile, sessionId, 'stale-session-x');

    const handle = await resumeImplicit(harness, profile, sessionId);
    const agent = handle.agent as AcpAgent;
    agent.followup(userText('continue'));
    await agent.whenIdle();
    expectBlocked(agent, 'capability-missing');

    // 显式放弃：闩锁复位、旧连接摘除（本例已被拒启动作拆掉，无进程可杀）
    await agent.rebindBlank();
    expect(agent.continuityState).toEqual({ status: 'ok', cause: null, detail: null });

    agent.followup(userText('after rebind'));
    await agent.whenIdle();

    // 第二段 initialize 属于 rebind 后的全新连接：session/new（forceBlank 跳过
    // 预检/load——旧 binding 不再被消费），minimal-caps 的 prompt 照常完成
    expect(mockRequests(profile.logPath)).toEqual([
      'initialize',
      'initialize', 'session/new', 'session/prompt',
    ]);
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });

    // 说明消息逐字落盘，归入发起重开的 turn（3 = 种子 turn 1 + 被拒 turn 2 之后）
    const notes = eventsOf(agent, 'assistant/message').filter((event) =>
      event.data.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('') === ACP_REBIND_BLANK_NOTE);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.data.turn).toBe(3);
    expect(notes[0]?.sourceEventSeqs).toBeUndefined(); // 说明消息不参与对账

    // 新代际 binding：generation=2（旧代际 1 跟进）、新 ACP id、historyBaseSeq=建立
    // turn 起点（旧历史从此不参与对账）；rebind 本身不产生 reconciliation 记录
    const rows = await bindingRows(harness, sessionId);
    expect(rows.map((row) => row.agentSessionId)).toEqual(['stale-session-x', 'mock-session-1', 'mock-session-1']);
    const established = rows[1]!;
    expect(established.generation).toBe(2);
    expect(established.historyBaseSeq).toBeGreaterThan(LOAD_REPLAY_MATCHED_COMMITTED_SEQ);
    expect(established.historyBaseSeq).toBe(established.dshCommittedSeq);
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['capability-missing']);
  }, 15_000);

  it('仅 idle 可调：turn 执行中 rebindBlank 抛错（会话状态不动）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('recon-rebind-busy'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    });
    harness.handles.push(handle);
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('busy turn'));
    await expect(agent.rebindBlank()).rejects.toThrow('rebindBlank is only allowed while idle');
    await agent.whenIdle();
    // turn 正常完成，未被 rebind 尝试干扰；连续性始终 ok
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    expect(agent.continuityState).toEqual({ status: 'ok', cause: null, detail: null });
  }, 15_000);
});

// ---------- 对账纯函数（src/domain/session/resume.ts） ----------

describe('对账纯函数', () => {
  const userEvent = (seq: number, text: string, turn: number): SessionEvent[] => [
    { type: 'turn/start', seq, time: seq, data: { turn } },
    { type: 'user/message', seq: seq + 1, time: seq + 1, data: userText(text), surfaceOp: 'append' },
  ] as unknown as SessionEvent[];

  describe('resolveExpectedRange', () => {
    it('锚点后无可见事件 → 期望区间 = [historyBaseSeq, dshCommittedSeq)', () => {
      const events = [
        ...userEvent(0, 'q', 1),
        { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[];
      expect(resolveExpectedRange(events, 0, 3, 3)).toEqual({ ok: true, from: 0, to: 3 });
    });

    it('崩溃尾巴（interrupted turn 的可见事件）→ 区间扩展到 baselineSeq', () => {
      const events = [
        ...userEvent(0, 'q1', 1),
        { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ...userEvent(3, 'q2 crashed', 2),
        { type: 'turn/end', seq: 5, time: 5, data: { turn: 2, reason: { kind: 'interrupted' } } },
      ] as unknown as SessionEvent[];
      expect(resolveExpectedRange(events, 0, 3, 6)).toEqual({ ok: true, from: 0, to: 6 });
    });

    it('锚点后有 completed turn 的可见事件 → dsh-log-diverged（detail 点名 turn 号）', () => {
      const events = [
        ...userEvent(0, 'q1', 1),
        { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ...userEvent(3, 'q2 unexplained', 2),
        { type: 'turn/end', seq: 5, time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[];
      const result = resolveExpectedRange(events, 0, 3, 6);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('dsh-log-diverged');
        expect(result.detail).toContain('turn 2');
      }
    });
  });

  describe('expectedVisibleHistory', () => {
    const assistant = (seq: number, text: string, withSeqs: boolean): SessionEvent => ({
      type: 'assistant/message',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `m-${String(seq)}`,
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'acp-x', model: 'm' },
        },
      },
      surfaceOp: 'append',
      ...(withSeqs ? { sourceEventSeqs: [] } : {}),
    } as unknown as SessionEvent);
    const toolResult = (seq: number, callId: string, isError: boolean, text = 'out', meta?: unknown): SessionEvent => ({
      type: 'tool/result',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `tr-${String(seq)}`,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
          source: { kind: 'tool', callId },
        },
        ...(meta === undefined ? {} : { meta }),
      },
      surfaceOp: 'append',
    } as unknown as SessionEvent);
    const toolCall = (seq: number, callId: string, name: string, args = '{}', meta?: unknown): SessionEvent => ({
      type: 'tool/call',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        callId,
        name,
        arguments: args,
        ...(meta === undefined ? {} : { meta }),
      },
    } as unknown as SessionEvent);
    const digestOf = (entries: AcpVisibleHistoryEntry[], index = 0): string => entries[index]?.digest ?? '';

    it('说明消息（无 sourceEventSeqs）不进期望；tool 配对回填 status；孤儿 result 跳过；每条带 canonical digest', () => {
      const events = [
        { type: 'user/message', seq: 0, time: 0, data: userText('q'), surfaceOp: 'append' } as unknown as SessionEvent,
        assistant(1, 'real answer', true),
        assistant(2, 'adapter note', false), // 说明消息：省略 sourceEventSeqs
        toolCall(3, 'c1', 'Read'),
        toolResult(4, 'c1', false),
        toolCall(5, 'c2', 'Write'),
        toolResult(6, 'c2', true),
        toolCall(7, 'c3', 'Bash'), // 无配对 → pending
        toolResult(8, 'c9', false), // 孤儿 → 跳过
      ];
      const history = expectedVisibleHistory(events, 0, 9);
      expect(history.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool']);
      expect(history[0]).toMatchObject({ kind: 'user', text: 'q' });
      expect(history[1]).toMatchObject({ kind: 'assistant', text: 'real answer' });
      expect(history[2]).toMatchObject({ kind: 'tool', title: 'Read', status: 'completed' });
      expect(history[3]).toMatchObject({ kind: 'tool', title: 'Write', status: 'failed' });
      expect(history[4]).toMatchObject({ kind: 'tool', title: 'Bash', status: 'pending' });
      for (const entry of history) expect(entry.digest).toMatch(/^[0-9a-f]{16}$/);
    });

    it('tool digest 覆盖 raw input 与 kind/locations：同 title 的隐性分叉逐项可辨；键序/损坏输入有定义', () => {
      const baseMeta = { acpToolCall: { kind: 'read', locations: [{ path: '/repo/a.txt' }] } };
      const base = digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"path":"a.txt"}', baseMeta)], 0, 1));
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"path":"b.txt"}', baseMeta)], 0, 1))).not.toBe(base);
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"path":"a.txt"}', {
        acpToolCall: { kind: 'edit', locations: [{ path: '/repo/a.txt' }] },
      })], 0, 1))).not.toBe(base);
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"path":"a.txt"}', {
        acpToolCall: { kind: 'read', locations: [{ path: '/repo/b.txt' }] },
      })], 0, 1))).not.toBe(base);
      // meta 缺席（kind/locations 全缺）与在场不同
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"path":"a.txt"}')], 0, 1))).not.toBe(base);
      // arguments 键序不影响 digest（canonical stableStringify 排序）
      const reordered = digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"b":2,"a":1}', baseMeta)], 0, 1));
      const ordered = digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', '{"a":1,"b":2}', baseMeta)], 0, 1));
      expect(reordered).toBe(ordered);
      // 损坏的 arguments（非 JSON）不抛：按原串计 digest（与任何规范回放分叉，fail-closed）
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Read', 'not-json', baseMeta)], 0, 1))).not.toBe(base);
    });

    it('Devin 终态回放省略 edit.content：diff 结果已重复证明时同 digest；其余 input 仍严格比较', () => {
      const path = '/repo/replay-probe.txt';
      const resultMeta = {
        acpToolContent: {
          items: [{ type: 'diff', path, operation: '新建', linesAdded: 1, linesRemoved: 0, originalChars: 9, hash16: 'e98a95a745bcb2d5' }],
          truncated: false,
          originalItems: 1,
        },
      };
      const resultText = `[diff 摘要] ${path}（新建）：+1/−0 行；新内容预览（原始 9 字符）：\nREPLAY-OK`;
      const digest = (args: string, kind = 'edit', runtime = 'devin'): string => digestOf(expectedVisibleHistory([
        toolCall(0, 'c1', 'Write', args, { acpToolCall: { kind } }),
        toolResult(1, 'c1', false, resultText, resultMeta),
      ], 0, 2, { runtime }));

      expect(digest(JSON.stringify({ file_path: path, content: 'REPLAY-OK' })))
        .toBe(digest(JSON.stringify({ file_path: path })));
      // file_path 没有被投影掉；非 edit 也不享受该稳定化。
      expect(digest(JSON.stringify({ file_path: '/repo/other.txt', content: 'REPLAY-OK' })))
        .not.toBe(digest(JSON.stringify({ file_path: path })));
      // 路径必须逐字节相同；不接受分隔符或 dot-segment 的“看起来等价”。
      expect(digest(JSON.stringify({ file_path: '/repo/./replay-probe.txt', content: 'REPLAY-OK' })))
        .not.toBe(digest(JSON.stringify({ file_path: '/repo/./replay-probe.txt' })));
      expect(digest(JSON.stringify({ file_path: '\\repo\\replay-probe.txt', content: 'REPLAY-OK' })))
        .not.toBe(digest(JSON.stringify({ file_path: '\\repo\\replay-probe.txt' })));
      expect(digest(JSON.stringify({ file_path: path, content: 'REPLAY-OK' }), 'execute'))
        .not.toBe(digest(JSON.stringify({ file_path: path }), 'execute'));
      expect(digest(JSON.stringify({ file_path: path, content: 'REPLAY-OK' }), 'edit', 'codex'))
        .not.toBe(digest(JSON.stringify({ file_path: path }), 'edit', 'codex'));
      expect(digest(JSON.stringify({ file_path: '/repo/other.txt', content: 'REPLAY-OK' })))
        .not.toBe(digest(JSON.stringify({ file_path: path })));
      expect(digest(JSON.stringify({ file_path: path, content: 'WRONG' })))
        .not.toBe(digest(JSON.stringify({ file_path: path })));
      const wrongLengthMeta = {
        acpToolContent: {
          ...resultMeta.acpToolContent,
          items: [{ ...resultMeta.acpToolContent.items[0], originalChars: 8 }],
        },
      };
      const digestWithMeta = (args: string): string => digestOf(expectedVisibleHistory([
        toolCall(0, 'c1', 'Write', args, { acpToolCall: { kind: 'edit' } }),
        toolResult(1, 'c1', false, resultText, wrongLengthMeta),
      ], 0, 2, { runtime: 'devin' }));
      expect(digestWithMeta(JSON.stringify({ file_path: path, content: 'REPLAY-OK' })))
        .not.toBe(digestWithMeta(JSON.stringify({ file_path: path })));
    });

 it('title 不进 digest 事实集（被拒工具回放不对称）：同参数同结局、仅 name 不同 → 同 digest；其余身份事实逐项仍判异', () => {
 // 前 Claude 0.70.0 实证：tool/call.name 落盘的是进行态占位标题（'Preparing file…'），
 // session/load 回放帧带终态标题（'Write <path>'）； name 恒为稳定名
      // dsh_acp_external_tool，title 漂移改经 meta.acpToolCall.title 承载。两种形态下
      // title/name 都是 ACP 允许漂移的展示事实，不是跨侧稳定身份。
      // input/status/result/kind/locations 篡改仍由相邻用例钉死判异。
      const meta = { acpToolCall: { kind: 'write', locations: [{ path: '/repo/f.txt' }] } };
      const args = '{"path":"f.txt","content":"x"}';
      const withName = (name: string): string => digestOf(expectedVisibleHistory([
        toolCall(0, 'c1', name, args, meta),
        toolResult(1, 'c1', false),
      ], 0, 2));
      expect(withName('Write /repo/f.txt')).toBe(withName('Preparing file…'));
      // 但 title/name 仍保留在条目展示字段（分叉 detail 的人类可读摘要用）
      const entry = expectedVisibleHistory([toolCall(0, 'c1', 'Preparing file…', args, meta)], 0, 1)[0];
      expect(entry).toMatchObject({ kind: 'tool', title: 'Preparing file…' });
    });

    it('tool digest 覆盖 result/meta：同 title 同参数、结果或结局事实不同 → 不同 digest', () => {
      const call = toolCall(0, 'c1', 'Bash', '{"command":"ls"}');
      const withResult = (text: string, isError = false, meta?: unknown): string =>
        digestOf(expectedVisibleHistory([call, toolResult(1, 'c1', isError, text, meta)], 0, 2));
      const base = withResult('ok');
      expect(withResult('ok')).toBe(base);
      expect(withResult('different output')).not.toBe(base);
      // terminal 结局事实（meta.acpToolContent 条目）参与 digest
      expect(withResult('ok', false, {
        acpToolContent: { items: [{ type: 'terminal', terminalId: 'term-1' }], truncated: false, originalItems: 1 },
      })).not.toBe(base);
      // 失败与成功不同（status 分量）
      expect(withResult('ok', true)).not.toBe(base);
      // 无配对结果（pending）与 completed 不同
      expect(digestOf(expectedVisibleHistory([call], 0, 1))).not.toBe(base);
    });

    it('raw input 超界折叠：对称截断标记参与 digest，同值仍同 digest、异值异 digest', () => {
      const bigArgs = (ch: string): string => JSON.stringify({ payload: ch.repeat(ACP_TOOL_INPUT_SUMMARY_MAX_CHARS) });
      expect(bigArgs('x').length).toBeGreaterThan(ACP_TOOL_INPUT_SUMMARY_MAX_CHARS);
      const a = digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Write', bigArgs('x'))], 0, 1));
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Write', bigArgs('x'))], 0, 1))).toBe(a);
      expect(digestOf(expectedVisibleHistory([toolCall(0, 'c1', 'Write', bigArgs('y'))], 0, 1))).not.toBe(a);
    });

    it('文本规范化：CRLF vs LF、NFC 组合差异不产生假分叉；内容差异仍判不同', () => {
      const withText = (text: string): string => digestOf(expectedVisibleHistory([
        { type: 'user/message', seq: 0, time: 0, data: userText(text), surfaceOp: 'append' } as unknown as SessionEvent,
      ], 0, 1));
      expect(withText('line1\r\nline2')).toBe(withText('line1\nline2'));
      expect(withText('café')).toBe(withText('café'));
      expect(withText('line1\nline2')).not.toBe(withText('line1\nline3'));
    });

    it('同一 DSH turn 开头的宿主注入 + 用户输入合并为一个 ACP user 锚点；跨 turn 仍严格分开', () => {
      const approvalNotice = 'The approval policy changed from "ask" to "never" (changed by the user).';
      const prompt = 'Reply with exactly: ACP_SMOKE_OK';
      const events = [
        { type: 'turn/start', seq: 10, time: 10, data: { turn: 1 } },
        { type: 'user/message', seq: 11, time: 11, data: userText(approvalNotice), surfaceOp: 'append' },
        { type: 'user/message', seq: 12, time: 12, data: userText(prompt), surfaceOp: 'append' },
        { type: 'turn/end', seq: 13, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'turn/start', seq: 14, time: 14, data: { turn: 2 } },
        { type: 'user/message', seq: 15, time: 15, data: userText('second turn'), surfaceOp: 'append' },
        { type: 'turn/end', seq: 16, time: 16, data: { turn: 2, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[];

      // from 故意落在 turn/start 之后，钉死函数会从区间前恢复 turn 归属。
      const expected = expectedVisibleHistory(events, 11, 17);
      expect(expected).toHaveLength(2);
      expect(expected[0]).toMatchObject({ kind: 'user', text: approvalNotice + prompt });
      expect(expected[1]).toMatchObject({ kind: 'user', text: 'second turn' });

      const replay = replayEntries([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: approvalNotice + prompt }, messageId: 'u1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, messageId: 'separator' },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second turn' }, messageId: 'u2' },
      ] as unknown as SessionUpdate[]);
      expect(reconcileVisibleHistory(replay, expected)).toEqual({ ok: true });
    });
  });

 describe('replayVisibleHistory（回放共轨：ReplayTranslator → 同一提取函数）', () => {
    it('连续 user chunk 聚合成锚；assistant 段内多 messageId 聚合为一条；tool_call_update 回填终态与规范化结果；thought/plan（reasoning）不进 assistant 文本；每条带 digest', () => {
      const updates = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hel' }, messageId: 'u1' },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'lo' }, messageId: 'u1' },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' }, messageId: 't1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' }, messageId: 'm1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' }, messageId: 'm2' },
        { sessionUpdate: 'plan', entries: [{ content: 'p', priority: 'high', status: 'completed' }] },
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'in_progress' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
        },
      ] as unknown as SessionUpdate[];
      const entries = replayEntries(updates);
 // 粒度：同一段 assistant 的多 messageId 聚进一条 assistant/message
      // （分段对账段内拼接比较，粒度差异本就不影响 digest）
      expect(entries.map((entry: AcpVisibleHistoryEntry) => entry.kind)).toEqual(['user', 'assistant', 'tool']);
      expect(entries[0]).toMatchObject({ kind: 'user', text: 'Hello' });
      expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'abc' });
      expect(entries[2]).toMatchObject({ kind: 'tool', title: 'Read', status: 'completed' });
      for (const entry of entries) expect(entry.digest).toMatch(/^[0-9a-f]{16}$/);
 // tool digest 与手工构造的对称事实集一致（黑盒钉住事实集形状；title 不在事实集内——见 被拒工具回放不对称）
      expect(entries[2]?.digest).toBe(acpToolHistoryDigest({
        toolKind: 'read',
        locations: [],
        input: {},
        status: 'completed',
        result: { text: 'file body', meta: null },
      }));
    });

    it('tool_call 帧自带 content 是终态 update 无 content 时的 fallback（translate.ts stash 同一路径）；显式 null = 空结果', () => {
      const frame = {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'frame content' } }],
      };
      const fallbackUsed = replayEntries([
        frame,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      ] as unknown as SessionUpdate[]);
      expect(fallbackUsed[0]?.digest).toBe(acpToolHistoryDigest({
        toolKind: null,
        locations: [],
        input: {},
        status: 'completed',
        result: { text: 'frame content', meta: null },
      }));
      // content: null 是显式空结果（不回退 frame 内容）
      const explicitEmpty = replayEntries([
        frame,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: null },
      ] as unknown as SessionUpdate[]);
      expect(explicitEmpty[0]?.digest).toBe(acpToolHistoryDigest({
        toolKind: null,
        locations: [],
        input: {},
        status: 'completed',
        result: { text: '', meta: null },
      }));
      expect(explicitEmpty[0]?.digest).not.toBe(fallbackUsed[0]?.digest);
    });

    it('raw input/locations/kind 进摘要：同 title 不同参数或 locations → 不同 digest', () => {
      const replay = (over: Record<string, unknown>): string =>
        replayEntries([
          {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'Read',
            kind: 'read',
            locations: [{ path: '/repo/a.txt' }],
            rawInput: { path: 'a.txt' },
            ...over,
          },
        ] as unknown as SessionUpdate[])[0]?.digest ?? '';
      const base = replay({});
      expect(replay({ rawInput: { path: 'b.txt' } })).not.toBe(base);
      expect(replay({ locations: [{ path: '/repo/b.txt' }] })).not.toBe(base);
      expect(replay({ kind: 'edit' })).not.toBe(base);
      // rawInput 键序不影响（arguments JSON 解析后经 stableStringify 进 digest）
      expect(replay({ rawInput: { b: 2, a: 1 } })).toBe(replay({ rawInput: { a: 1, b: 2 } }));
    });

    it('规范化在聚合后执行：跨 chunk 组合字符与 CRLF 不产生假分叉', () => {
      const digestOfReplay = (texts: readonly string[]): string =>
        replayEntries(
          texts.map((text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'm1' })) as unknown as SessionUpdate[],
        )[0]?.digest ?? '';
      // 'e' + 组合符 跨 chunk 聚合后 NFC = 预组合单 chunk
      expect(digestOfReplay(['e', '́'])).toBe(digestOfReplay(['é']));
      expect(digestOfReplay(['a\r\nb'])).toBe(digestOfReplay(['a\n', 'b']));
    });
  });

  describe('reconcileVisibleHistory（分段语义：turn 间保序、turn 内分层）', () => {
    const userEntry = (text: string): AcpVisibleHistoryEntry => {
      const normalized = normalizeVisibleText(text);
      return { kind: 'user', text: normalized, digest: acpVisibleTextDigest('user', normalized) };
    };
    const assistantEntry = (text: string): AcpVisibleHistoryEntry => {
      const normalized = normalizeVisibleText(text);
      return { kind: 'assistant', text: normalized, digest: acpVisibleTextDigest('assistant', normalized) };
    };
    const toolEntry = (title: string, status: string, over?: Partial<AcpToolHistoryFacts>): AcpVisibleHistoryEntry => ({
      kind: 'tool',
      title,
      status,
 // title 只作展示摘要字段，不进 digest 事实集（被拒工具回放不对称：title 是允许漂移的展示事实）
      digest: acpToolHistoryDigest({ toolKind: null, locations: [], input: {}, status, result: null, ...over }),
    });
    const expected: AcpVisibleHistoryEntry[] = [userEntry('q'), assistantEntry('a'), toolEntry('Read', 'completed')];

    it('逐段同层 digest 相等 → ok（与条目顺序一致时的平凡形态）', () => {
      expect(reconcileVisibleHistory([...expected], expected)).toEqual({ ok: true });
    });

    it('混合 turn 免疫（本修复的核心）：回放 [user, assistant, tool] vs live 序 [user, tool, assistant] → ok', () => {
      const replay = [expected[0]!, expected[1]!, expected[2]!];
      const liveOrder = [expected[0]!, expected[2]!, expected[1]!];
      expect(reconcileVisibleHistory(replay, liveOrder)).toEqual({ ok: true });
      expect(reconcileVisibleHistory(liveOrder, replay)).toEqual({ ok: true });
    });

    it('段内 tool 乱序免疫：回放 [tool A, tool B] vs 期望 [tool B, tool A] → ok', () => {
      const toolA = toolEntry('Read', 'completed');
      const toolB = toolEntry('Write', 'failed');
      const expectedSide = [userEntry('q'), toolA, toolB];
      const replaySide = [userEntry('q'), toolB, toolA];
      expect(reconcileVisibleHistory(replaySide, expectedSide)).toEqual({ ok: true });
    });

    it('同 turn 多 messageId 聚合免疫：回放两条 assistant vs live 一条聚合 → ok', () => {
      const replaySide = [userEntry('q'), assistantEntry('Hello, '), assistantEntry('world.')];
      const expectedSide = [userEntry('q'), assistantEntry('Hello, world.')];
      expect(reconcileVisibleHistory(replaySide, expectedSide)).toEqual({ ok: true });
      expect(reconcileVisibleHistory(expectedSide, replaySide)).toEqual({ ok: true });
    });

    it('回放少一个 turn 段 → replay-diverged（detail 带缺失段描述）', () => {
      const full = [...expected, userEntry('q2'), toolEntry('Write', 'completed')];
      const result = reconcileVisibleHistory(expected, full);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).toContain('stopped at 2 turn segments');
        expect(result.detail).toContain('missing from replay');
        expect(result.detail).toContain('q2');
      }
    });

    it('回放多一个 turn 段 → dsh-log-truncated（detail 带多出尾部段描述）', () => {
      const result = reconcileVisibleHistory([...expected, userEntry('extra')], expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('dsh-log-truncated');
        expect(result.detail).toContain('extra replay tail');
        expect(result.detail).toContain('turn segment 2');
      }
    });

    it('段内 user 锚 digest 不符 → replay-diverged（detail 点 user anchor 层）', () => {
      const staged = [userEntry('DIFFERENT'), expected[1]!, expected[2]!];
      const result = reconcileVisibleHistory(staged, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).toContain('user anchor');
        expect(result.detail).toContain('DIFFERENT');
      }
    });

    it('段内 assistant 聚合文本不符 → replay-diverged（detail 点 assistant text 层与段号）', () => {
      const staged = [expected[0]!, assistantEntry('DIFFERENT'), expected[2]!];
      const result = reconcileVisibleHistory(staged, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).toContain('turn segment 1');
        expect(result.detail).toContain('assistant text');
        expect(result.detail).toContain('DIFFERENT');
      }
    });

    it('核心回归（分段版）：同 title 同 status、raw input 不同 → tool 多重集不符 → replay-diverged；detail 带 digest 不带输入原文', () => {
      const staged = [expected[0]!, expected[1]!, toolEntry('Read', 'completed', { input: { path: 'secret-other.txt' } })];
      const result = reconcileVisibleHistory(staged, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).toContain('tool multiset');
        expect(result.detail).toContain('tool:');
        expect(result.detail).not.toContain('secret-other.txt');
      }
    });

    it('（分段版）：同 title 同 status、result/meta 不同 → replay-diverged', () => {
      const staged = [expected[0]!, expected[1]!, toolEntry('Read', 'completed', {
        result: { text: 'tampered result', meta: null },
      })];
      const result = reconcileVisibleHistory(staged, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).not.toContain('tampered result');
      }
    });

 it('两侧仅 title 不同（其余事实集全同）→ ok：title 是允许漂移的展示事实，不判分叉（被拒工具回放不对称）', () => {
      const staged = [expected[0]!, expected[1]!, toolEntry('Completely different display title', 'completed')];
      expect(reconcileVisibleHistory(staged, expected)).toEqual({ ok: true });
      expect(reconcileVisibleHistory(expected, staged)).toEqual({ ok: true });
    });

    it('Devin 被拒工具回放不对称 防线（分段版）：回放缺 tool（被拒不进回放）→ 多重集回放缺项 → replay-diverged', () => {
      const result = reconcileVisibleHistory(expected.slice(0, 2), expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('replay-diverged');
        expect(result.detail).toContain('tool multiset');
        expect(result.detail).toContain('tool:');
      }
    });

    it('回放多出 tool（DSH 侧无记录）→ 多重集回放超集 → dsh-log-truncated', () => {
      const staged = [...expected, toolEntry('Bash', 'completed')];
      const result = reconcileVisibleHistory(staged, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('dsh-log-truncated');
        expect(result.detail).toContain('tool multiset');
      }
    });

    it('回放多出 assistant 文本而 DSH 侧为空 → dsh-log-truncated（同「多出尾部」语义）', () => {
      const staged = [userEntry('q'), assistantEntry('unsaved answer')];
      const expectedSide = [userEntry('q')];
      const result = reconcileVisibleHistory(staged, expectedSide);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe('dsh-log-truncated');
        expect(result.detail).toContain('assistant text');
      }
    });

    it('双侧空历史 → ok；带头段（user 前的内容）按同一分层规则参与比较', () => {
      expect(reconcileVisibleHistory([], [])).toEqual({ ok: true });
      // 带头段：回放与期望都是「assistant 先于首个 user」→ 段内分层相等 → ok
      const lead = [assistantEntry('orphan text'), toolEntry('Read', 'pending')];
      const leadReplay = [toolEntry('Read', 'pending'), assistantEntry('orphan text')];
      expect(reconcileVisibleHistory(leadReplay, lead)).toEqual({ ok: true });
      // 一侧有带头内容一侧没有 → 分叉
      const result = reconcileVisibleHistory(lead, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toContain('leading segment');
    });
  });

 describe('两侧同源性（live 落盘与回放 staging 共用同一 TurnTranslator 通道）', () => {
    it('同一 update 流经 TurnTranslator 落盘后的期望历史与回放 staging 分段对账通过（含混合 turn 与 diff meta 通道）', () => {
      // 混合 turn 覆盖：turn 1 纯消息、turn 2 纯工具、turn 3 文本+tool 交织
 // （msg-a → tool → msg-b，不同 messageId）。两侧同轨：live 侧
      // tool/call 到达前 flush assistant segment，回放侧经 ReplayTranslator 走
      // 同一分段器——两侧逐位形态相同，分段对账判一致。
      const turn1 = [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' }, messageId: 'm1' },
      ] as unknown as SessionUpdate[];
      const turn2 = [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Edit notes.txt',
          kind: 'edit',
          status: 'in_progress',
          locations: [{ path: '/repo/notes.txt' }],
          rawInput: { path: 'notes.txt', content: 'new' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'done' } },
            { type: 'diff', path: '/repo/notes.txt', oldText: 'old', newText: 'new' },
          ],
        },
      ] as unknown as SessionUpdate[];
      const turn3 = [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading it first. ' }, messageId: 'm3a' },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't2',
          title: 'Read notes.txt',
          kind: 'read',
          status: 'in_progress',
          locations: [{ path: '/repo/notes.txt' }],
          rawInput: { path: 'notes.txt' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't2',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'notes body' } }],
        },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done reading.' }, messageId: 'm3b' },
      ] as unknown as SessionUpdate[];
      // 经生产翻译通道落盘（recording sink 赋连续 seq）
      const events: SessionEvent[] = [];
      const sink = {
        append: (type: string, data: unknown, ...opts: unknown[]) => {
          const event = {
            type,
            seq: events.length,
            time: events.length + 1,
            data: structuredClone(data),
            ...((opts[0] as Record<string, unknown> | undefined) ?? {}),
          } as unknown as SessionEvent;
          events.push(event);
          return event;
        },
      } as unknown as ConstructorParameters<typeof TurnTranslator>[0]['sink'];
      const translator = new TurnTranslator({ sink, provider: 'acp-mock', model: 'mock-model-a' });
      for (const [turn, updates] of [turn1, turn2, turn3].entries()) {
        translator.beginTurn(turn + 1);
        for (const update of updates) translator.feed({ sessionId: 's', update });
        translator.endTurn();
      }

      const expected = expectedVisibleHistory(events, 0, events.length + 1);
      const staged = replayEntries([...turn1, ...turn2, ...turn3]);
 // 同轨钉版：两侧逐位形态相同——turn 3 的交织在两侧都是
      // assistant(msg-a) → tool → assistant(msg-b)（回放侧不再有结构性差异）
      expect(staged.map((entry) => entry.kind)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant']);
      expect(expected.map((entry) => entry.kind)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant']);
      expect(reconcileVisibleHistory(staged, expected)).toEqual({ ok: true });
      // 反向也判一致（分段对账对两侧对称）
      expect(reconcileVisibleHistory(expected, staged)).toEqual({ ok: true });
    });

 it('被拒工具回放不对称 回归（管线级）：DSH 侧落盘名是进行态占位标题、回放帧带终态标题 → 对账判一致', () => {
      // Claude Agent ACP 0.70.0 实证形态（Claude ACP 真机验收）：
 // tool_call 首个帧 title='Preparing file…'（前 live 时 translate.ts 落盘
 // tool/call.name 即此占位标题； name 恒为稳定名、占位标题落
      // meta.acpToolCall.title）；session/load 回放帧 title='Write <path>'（终态标题）。
      // title/name 已移出 digest 事实集，两侧其余身份事实（kind/locations/
      // input/status/result）全同时必须判 ok。
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: userText('write the file'), surfaceOp: 'append' },
        {
          type: 'tool/call',
          seq: 2,
          time: 3,
          data: {
            turn: 1,
            step: 1,
            callId: 'c1',
            name: 'Preparing file…', // live 期落盘形态；稳定名位于 meta.acpToolCall.title
            arguments: '{"path":"f.txt","content":"x"}',
            meta: { acpToolCall: { kind: 'write', locations: [{ path: '/repo/f.txt' }] } },
          },
        },
        {
          type: 'tool/result',
          seq: 3,
          time: 4,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'tr-1',
              role: 'user',
              content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
              source: { kind: 'tool', callId: 'c1' },
            },
          },
        },
        { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[];
      const staged = replayEntries([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'write the file' }, messageId: 'u1' },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Write /repo/f.txt', // 回放帧的终态标题
          kind: 'write',
          status: 'in_progress',
          locations: [{ path: '/repo/f.txt' }],
          rawInput: { path: 'f.txt', content: 'x' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      ] as unknown as SessionUpdate[]);
      const expected = expectedVisibleHistory(events, 0, 4);
      // title 展示字段各自保留（detail 摘要用），但 digest 相同 → 多重集相符
      expect(staged[1]).toMatchObject({ kind: 'tool', title: 'Write /repo/f.txt' });
      expect(expected[1]).toMatchObject({ kind: 'tool', title: 'Preparing file…' });
      expect(staged[1]?.digest).toBe(expected[1]?.digest);
      expect(reconcileVisibleHistory(staged, expected)).toEqual({ ok: true });
    });

 it('非对称工具回放（管线级）：live 占位首帧 + update 终态事实经 TurnTranslator 落盘（终态快照）vs 回放终态合并帧 → 判一致', () => {
      // claude-agent-acp 0.70.0 实证全形态（Claude ACP 真机验收
      // evidence/21-replay-updates.jsonl 与 live 侧 03 留档）：
      // live：tool_call 首帧占位（title='Preparing file…'、rawInput 缺席、locations
      // 空、无 content）→ 进行中 update 携带终态 title/rawInput/locations/
      // content=[diff] → 终态 update 仅 status+rawOutput。
      // 回放：终态全量事实合并进单条 tool_call 帧 + 终态 update 仅 status/rawOutput。
      const live = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'write the file' }, messageId: 'u1' },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Preparing file…',
          kind: 'edit',
          status: 'pending',
          locations: [],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'in_progress',
          title: 'Write /repo/fix-round.txt',
          locations: [{ path: '/repo/fix-round.txt' }],
          rawInput: { file_path: '/repo/fix-round.txt', content: 'resumed-ok' },
          content: [{ type: 'diff', path: '/repo/fix-round.txt', oldText: null, newText: 'resumed-ok' }],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          rawOutput: 'File created successfully at: /repo/fix-round.txt',
        },
      ] as unknown as SessionUpdate[];
      const replay = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'write the file' }, messageId: 'u1' },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Write /repo/fix-round.txt',
          kind: 'edit',
          status: 'pending',
          locations: [{ path: '/repo/fix-round.txt' }],
          rawInput: { file_path: '/repo/fix-round.txt', content: 'resumed-ok' },
          content: [{ type: 'diff', path: '/repo/fix-round.txt', oldText: null, newText: 'resumed-ok' }],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          rawOutput: 'File created successfully at: /repo/fix-round.txt',
        },
      ] as unknown as SessionUpdate[];

      // live 流经生产翻译通道落盘（recording sink 赋连续 seq；user/message 由
      // AcpAgent 落盘，此处手搭等价事件）
      const events: SessionEvent[] = [
        { type: 'user/message', seq: 0, time: 1, data: userText('write the file'), surfaceOp: 'append' },
      ] as unknown as SessionEvent[];
      const sink = {
        append: (type: string, data: unknown, ...opts: unknown[]) => {
          const event = {
            type,
            seq: events.length,
            time: events.length + 1,
            data: structuredClone(data),
            ...((opts[0] as Record<string, unknown> | undefined) ?? {}),
          } as unknown as SessionEvent;
          events.push(event);
          return event;
        },
      } as unknown as ConstructorParameters<typeof TurnTranslator>[0]['sink'];
      const translator = new TurnTranslator({ sink, provider: 'acp-mock', model: 'mock-model-a' });
      translator.beginTurn(1);
      for (const update of live.slice(1)) translator.feed({ sessionId: 's', update });
      translator.endTurn();

 // DSH 侧钉死占位落盘 + 终态快照回写共存的形态（name 恒稳定名，
      // 占位标题落 meta.acpToolCall.title）
      const callEvent = events.find((event) => event.type === 'tool/call');
      expect(callEvent?.data).toMatchObject({ name: 'dsh_acp_external_tool', arguments: '{}' });
      expect((callEvent?.data as { meta?: unknown }).meta).toMatchObject({
        acpToolCall: { title: 'Preparing file…' },
      });
      const resultEvent = events.find((event) => event.type === 'tool/result');
      expect((resultEvent?.data as { meta?: unknown }).meta).toMatchObject({
        acpToolCall: {
          terminal: {
            title: 'Write /repo/fix-round.txt',
            kind: 'edit',
            locations: [{ path: '/repo/fix-round.txt' }],
            input: { file_path: '/repo/fix-round.txt', content: 'resumed-ok' },
          },
        },
      });

      const expected = expectedVisibleHistory(events, 0, events.length + 1);
      const staged = replayEntries(replay);
      // 两侧 tool 条目 digest 相等（终态快照对称：kind/locations/input/status/result
      // 全是终态事实；result.meta 只计 acpToolContent 投影——终态快照键不污染 result
      // digest 由本相等性蕴含）
      expect(expected[1]).toMatchObject({ kind: 'tool', title: 'Write /repo/fix-round.txt' });
      expect(expected[1]?.digest).toBe(staged[1]?.digest);
      expect(reconcileVisibleHistory(staged, expected)).toEqual({ ok: true });
      expect(reconcileVisibleHistory(expected, staged)).toEqual({ ok: true });
    });

    it('终态快照逐项缺席语义：快照只带 input 时 kind/locations 保持首帧来源；篡改回放 input 仍判分叉（Devin 被拒工具回放不对称 防线在终态快照路径上不变）', () => {
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: userText('do it'), surfaceOp: 'append' },
        {
          type: 'tool/call',
          seq: 2,
          time: 3,
          data: {
            turn: 1,
            step: 1,
            callId: 'c1',
            name: 'Preparing file…',
            arguments: '{}',
            meta: { acpToolCall: { kind: 'edit', locations: [{ path: '/repo/f.txt' }] } },
          },
        },
        {
          type: 'tool/result',
          seq: 3,
          time: 4,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'tr-1',
              role: 'user',
              content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
              source: { kind: 'tool', callId: 'c1' },
            },
            // 快照只补 input（其余字段缺席 → 保持首帧 meta 的 kind/locations）
            meta: { acpToolCall: { terminal: { title: 'Write /repo/f.txt', input: { file_path: '/repo/f.txt' } } } },
          },
        },
        { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[];
      const replayOf = (rawInput: unknown): SessionUpdate[] => [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'do it' }, messageId: 'u1' },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Write /repo/f.txt',
          kind: 'edit',
          status: 'completed',
          locations: [{ path: '/repo/f.txt' }],
          rawInput,
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      ] as unknown as SessionUpdate[];
      const expected = expectedVisibleHistory(events, 0, 4);
      // 逐项合并后身份事实 = {kind:edit, locations:[/repo/f.txt], input:{file_path}} → 一致
      expect(reconcileVisibleHistory(replayEntries(replayOf({ file_path: '/repo/f.txt' })), expected))
        .toEqual({ ok: true });
      // 回放 input 篡改 → digest 相异 → replay-diverged（终态快照路径不放宽事实级防线）
      const tampered = reconcileVisibleHistory(replayEntries(replayOf({ file_path: '/repo/evil.txt' })), expected);
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.cause).toBe('replay-diverged');
    });

    it('终态快照路径的 result 篡改防线：回放结果内容与终态快照的 result 投影不符 → replay-diverged', () => {
      const live = [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Preparing file…',
          kind: 'edit',
          status: 'pending',
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'in_progress',
          rawInput: { file_path: '/repo/f.txt' },
          content: [{ type: 'diff', path: '/repo/f.txt', oldText: null, newText: 'real content' }],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
      ] as unknown as SessionUpdate[];
      const events: SessionEvent[] = [];
      const sink = {
        append: (type: string, data: unknown, ...opts: unknown[]) => {
          const event = {
            type,
            seq: events.length,
            time: events.length + 1,
            data: structuredClone(data),
            ...((opts[0] as Record<string, unknown> | undefined) ?? {}),
          } as unknown as SessionEvent;
          events.push(event);
          return event;
        },
      } as unknown as ConstructorParameters<typeof TurnTranslator>[0]['sink'];
      const translator = new TurnTranslator({ sink, provider: 'acp-mock', model: 'mock-model-a' });
      translator.beginTurn(1);
      for (const update of live) translator.feed({ sessionId: 's', update });
      translator.endTurn();
      const expected = expectedVisibleHistory(events, 0, events.length + 1);

      const replayOf = (newText: string): SessionUpdate[] => [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Write /repo/f.txt',
          kind: 'edit',
          status: 'completed',
          rawInput: { file_path: '/repo/f.txt' },
          content: [{ type: 'diff', path: '/repo/f.txt', oldText: null, newText }],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
      ] as unknown as SessionUpdate[];
      // 结果一致 → ok（终态快照路径的 result 对称：live 累积 [diff] 映射 == 回放帧
      // content=[diff] 的同一 mapToolContent 投影）
      expect(reconcileVisibleHistory(replayEntries(replayOf('real content')), expected)).toEqual({ ok: true });
      // 回放 result 篡改 → diverged（终态快照不改写 result 事实的检出语义）
      const tampered = reconcileVisibleHistory(replayEntries(replayOf('tampered content')), expected);
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.cause).toBe('replay-diverged');
    });
  });
});
