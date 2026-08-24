// devin-state-dir.spec.ts — 黑盒测试：devin（descriptor sessionStateDir
// 'deterministic'）的确定性 per-session 状态目录。
//
// 背景与方向性说明（设计说明字面要求与落点的偏差）：设计说明原要求把 devin 的
// per-session staging root 挪到 `<dshHome>/dsh-acp/agent-data/devin/...`；实测
// 不可行——DSH 公开 confine policy 只有一个可写 workspaceRoot，workspace-write 档
// writableRoots = workspaceRoot + 平台 tmp 区（reference/deepseek-harness
// packages/sandbox/sandbox/src/roots.ts 与 sandbox-local/src/profiles.ts 的
// seatbelt profile 实证，且 seatbelt 按 realpath 后路径判写），dshHome 下的目录
// 对 confined 子进程只读——sessions.db 与重定向 TMPDIR 的写入会被拒（与 // 创建门同一堵墙）。因此落点是 `os.tmpdir()` 下的确定性固定名目录
// `dsh-acp-state-<profileId>-<sessionId>-<generation>`（0700 canonical）：修
// 跨重启恢复（宿主重启后 resume 经 binding 记录复用同一目录）与 确定性状态目录（不再每次 spawn
// 产生随机 mkdtemp litter），但「$TMPDIR 下零 per-session 目录」这条字面要求
// 未满足——本文件断言的是「无随机 mkdtemp 后缀目录、目录名确定且跨重启复用」。
//
// 矩阵：
//   1. workspace-write 档建立：确定性目录选址/0700/XDG+TMPDIR 注入（fs-probe
//      envEcho 见证）；confine root 仍是 canonical 项目（不变）；binding 复用
// 字段记录 agentDataHome/agentDataGeneration=1；指纹
//      dataHomeGeneration=1；tmp 下本会话只有确定性名目录、无随机后缀 litter。
//   2. resume 复用：预置 gen1 目录（含 marker）+ 匹配 binding/种子日志 → 走
//      session/load，目录复用（marker 保留）、不新建代际目录、confine root
//      仍是项目。
//   3. binding 记录的目录已被 OS 清掉：ensure 幂等重建空目录，会话缺失由
//      list 对账 fail-loud 阻断（id-not-found），不静默 session/new。
//   4. rebindBlank：新代际新目录；被放弃代际的目录整删（marker 随之消失）；
//      binding 重写 generation=2 + 新目录。
//   5. read-only 档回归钉：devin 状态目录仍是 profile 级持久 stateRoot
//      （`<dshHome>/dsh-acp/state/<profileId>`），tmp 下零 per-session 目录
// （只消费 workspace-write 档）。
//
// 组装层见 test/agent-test-helpers.ts。孤儿进程防线与各 spec 同款：argv 带
// SPEC_TAG，afterEach 兜底 dispose 全部 handle + 删除本用例创建的确定性
// 状态目录（它们在 os.tmpdir 下，不在 suiteDir 内），afterAll `ps` 全量扫描。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import { ACP_RECONCILIATION_GUIDANCE } from '../../../src/domain/session/resume.ts';
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts';
import type { AcpBindingData, AcpSidecarEntry } from '../../../src/persistence/sidecar.ts';
import {
  LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
  SPEC_TAG,
  bindingFixture,
  createHarness,
  eventsOf,
  mockProfile,
  psLinesWithTag,
  readLog,
  registerAcpAgents,
  routeOf,
  seedLogMatchingLoadReplay,
  userText,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, CreateHarnessOptions, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

/** 本文件在 os.tmpdir 下创建的确定性状态目录（afterEach 统一删除——它们不在 suiteDir 内）。 */
const createdStateDirs: string[] = [];

async function boot(options: CreateHarnessOptions = {}): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, options);
  harnesses.push(harness);
  return harness;
}

/** 创建并登记一个 ACP agent（经 loop 路由），返回 handle。 */
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

/** 给 mock profile 绑定 runtime descriptor（的 settings 面）。 */
function withRuntime(profile: MockProfile, runtime: NonNullable<AcpAgentConfig['runtime']>): MockProfile {
  profile.config = { ...profile.config, runtime };
  return profile;
}

/** canonical tmp 根（macOS 上 /var→/private/var；断言一律比对 canonical 形态）。 */
const CANONICAL_TMP = fs.realpathSync(os.tmpdir());

/** 该 profile+session+代际的确定性状态目录名（identity 字符全在安全集内，sanitize 是恒等）。 */
function stateDirName(profile: MockProfile, sessionId: string, generation: number): string {
  return `dsh-acp-state-${profile.id}-${sessionId}-${String(generation)}`;
}

/** tmp 下名字含本 sessionId 的目录（断言「本会话零随机 mkdtemp litter」用；mkdtemp 随机名绝不含 sessionId）。 */
function tmpEntriesOf(sessionId: string): string[] {
  return fs.readdirSync(CANONICAL_TMP).filter((name) => name.includes(sessionId));
}

/** fs-probe turn 回传的 assistant 文本（JSON：{fsProbeResults, envEcho}）。 */
function fsProbeEcho(agent: Agent): { fsProbeResults: { path: string; ok: boolean }[]; envEcho: Record<string, string | null> } {
  const messages = eventsOf(agent, 'assistant/message');
  const text = messages.flatMap((event) =>
    event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
  ).at(-1);
  return JSON.parse(text ?? '{}') as { fsProbeResults: { path: string; ok: boolean }[]; envEcho: Record<string, string | null> };
}

type BindingEntry = Extract<AcpSidecarEntry, { kind: 'binding' }>;

/** 该会话 sidecar 里的全部 binding entry（落盘顺序 = append 顺序）。 */
async function bindingEntries(harness: AgentHarness, sessionId: SessionId): Promise<BindingEntry[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry): entry is BindingEntry => entry.kind === 'binding');
}

/** 阻断断言组：continuity 闩锁（status+cause）+ 末个 turn/end 的错误码 + 出路文案。 */
function expectBlocked(agent: Agent, cause: string): void {
  const continuity = (agent as AcpAgent).continuityState;
  expect(continuity.status).toBe('blocked');
  expect(continuity.cause).toBe(cause);
  const lastEnd = eventsOf(agent, 'turn/end').at(-1);
  expect(lastEnd?.data.reason.kind).toBe('error');
  expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.code : undefined).toBe('ACP_RECONCILIATION_REQUIRED');
  expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.message : '').toContain(ACP_RECONCILIATION_GUIDANCE);
}

/** 会话 spawn 的 confine 调用（policy.sessionId 在场；门内 probe 的调用无 sessionId）。 */
function sessionConfineCalls(harness: AgentHarness, sessionId: string) {
  return (harness.sandbox?.confineCalls ?? []).filter((call) => call.policy.sessionId === sessionId);
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-devin-state-dir-spec-'));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
  for (const dir of createdStateDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  const pidScan = psLinesWithTag(SPEC_TAG);
  expect(pidScan).toEqual([]);
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('devin 确定性 per-session 状态目录', () => {
  it('workspace-write 档建立：确定性目录选址/0700/XDG+TMPDIR 注入；confine root 仍是项目；binding/指纹记代际；零随机 litter', async () => {
    const harness = await boot(); // 默认 workspace-write 档
    const sessionId = SessionId('devin-state-ww-1');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe'), 'devin');

    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;
    agent.followup(userText('probe the filesystem'));
    await agent.whenIdle();

    const name = stateDirName(profile, String(sessionId), 1);
    const canonicalDir = path.join(CANONICAL_TMP, name);
    createdStateDirs.push(canonicalDir);
 // 确定性目录已建、0700；confine root 仍是 canonical 项目（不改 workspaceRoot 语义）
    expect(fs.statSync(canonicalDir).mode & 0o777).toBe(0o700);
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy.mode).toBe('workspace-write');
    expect(calls[0]?.policy.workspaceRoot).toBe(fs.realpathSync(harness.logDir));
    // XDG/TMPDIR 注入经 spawnPlan seam 到达子进程（fs-probe envEcho 见证）
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.XDG_DATA_HOME).toBe(path.join(canonicalDir, 'xdg-data'));
    expect(echo.envEcho.TMPDIR).toBe(path.join(canonicalDir, 'tmp'));
 // binding 复用 字段记录状态目录与代际；指纹 dataHomeGeneration=1
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(1);
    expect(data.agentDataHome).toBe(canonicalDir);
    expect(data.agentDataGeneration).toBe(1);
    expect(data.launchFingerprint.profileId).toBe(profile.id);
    expect(data.launchFingerprint.descriptorId).toBe('devin');
    expect(data.launchFingerprint.dataHomeGeneration).toBe(1);
    // tmp 下本会话只有一个确定性状态目录，不产生随机后缀的残留目录。
    expect(tmpEntriesOf(String(sessionId))).toEqual([name]);
  }, 20_000);

  it('resume 复用 binding.agentDataHome：走 session/load，目录与 marker 原样保留，不新建代际目录', async () => {
    const harness = await boot(); // 默认 workspace-write 档
    const sessionId = SessionId('devin-state-resume');
    const profile = withRuntime(mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    }), 'devin');
    // 预造「上次建立」的确定性状态目录（含 marker 文件），binding 记录它
    const name = stateDirName(profile, String(sessionId), 1);
    const rawDir = path.join(os.tmpdir(), name);
    fs.mkdirSync(rawDir, { recursive: true });
    fs.chmodSync(rawDir, 0o700);
    fs.writeFileSync(path.join(rawDir, 'marker.txt'), 'from-generation-1');
    const canonicalDir = fs.realpathSync(rawDir);
    createdStateDirs.push(canonicalDir);

    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    const sidecar = harness.loop.acpSidecar;
    expect(sidecar).toBeDefined();
    await sidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-alpha',
        overrides: {
          dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
          agentDataHome: canonicalDir,
          agentDataGeneration: 1,
        },
      }),
    });

    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(handle);
    const agent = handle.agent;
    agent.followup(userText('continue after resume'));
    await agent.whenIdle();

    // 走了 session/load（预检全过：指纹 fixture 与 startSession 同源同算法）
    expect(readLog(profile.logPath)).toContain('session/load preset-alpha');
    // confine root 仍是项目（不是状态目录）；目录内容（marker）原样保留
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy.workspaceRoot).toBe(fs.realpathSync(harness.logDir));
    expect(fs.readFileSync(path.join(canonicalDir, 'marker.txt'), 'utf8')).toBe('from-generation-1');
    // 跨重启状态目录复用 钉：本会话仍只有这一个代际目录
    expect(tmpEntriesOf(String(sessionId))).toEqual([name]);
    // binding 续代重写：generation 不变，agentDataHome 不变
    const bindings = await bindingEntries(harness, sessionId);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(1);
    expect(data.agentDataHome).toBe(canonicalDir);
  }, 20_000);

  it('binding 记录的目录已被 OS 清掉：ensure 幂等重建空目录，会话缺失由 list 对账 fail-loud 阻断（id-not-found）', async () => {
    const harness = await boot(); // 默认 workspace-write 档
    const sessionId = SessionId('devin-state-swept');
    const profile = withRuntime(mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    }), 'devin');
    // binding 记一个形态合规但从未存在的目录（模拟 OS tmp 清理后）
    const name = stateDirName(profile, String(sessionId), 1);
    const canonicalDir = path.join(CANONICAL_TMP, name);
    createdStateDirs.push(canonicalDir);
    expect(fs.existsSync(canonicalDir)).toBe(false);

    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    await harness.loop.acpSidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-missing', // mock list 查无此会话
        overrides: {
          dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
          agentDataHome: canonicalDir,
          agentDataGeneration: 1,
        },
      }),
    });

    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(handle);
    const agent = handle.agent;
    agent.followup(userText('continue after resume'));
    await agent.whenIdle();

    // 目录被幂等重建（只有 spawn 计划注入的 env 布局子目录，无任何会话数据）；
    // 会话缺失由 list 对账诚实暴露——阻断，绝不静默 session/new
    expect(fs.existsSync(canonicalDir)).toBe(true);
    expect(fs.readdirSync(canonicalDir).sort()).toEqual(['tmp', 'xdg-cache', 'xdg-config', 'xdg-data']);
    expectBlocked(agent, 'id-not-found');
    expect(readLog(profile.logPath)).not.toContain('session/load');
    expect(readLog(profile.logPath)).not.toContain('session/new');
  }, 20_000);

  it('rebindBlank：新代际用新目录，被放弃代际的目录整删（marker 消失），binding 重写 generation=2', async () => {
    const harness = await boot(); // 默认 workspace-write 档
    const sessionId = SessionId('devin-state-rebind');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe'), 'devin');
    const name1 = stateDirName(profile, String(sessionId), 1);
    const marker = path.join(os.tmpdir(), name1, 'marker.txt');
    profile.config.env['MOCK_FS_PROBE_WRITES'] = JSON.stringify([marker]);

    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent as AcpAgent;
    agent.followup(userText('first generation'));
    await agent.whenIdle();

    const gen1 = path.join(CANONICAL_TMP, name1);
    createdStateDirs.push(gen1);
    expect(fs.existsSync(marker)).toBe(true);

    await agent.rebindBlank();
    // 显式放弃旧代际 → 其确定性状态目录整删（确定性状态目录：从此刻起它是 litter）
    expect(fs.existsSync(gen1)).toBe(false);

    agent.followup(userText('second generation'));
    await agent.whenIdle();

    const name2 = stateDirName(profile, String(sessionId), 2);
    const gen2 = path.join(CANONICAL_TMP, name2);
    createdStateDirs.push(gen2);
    expect(fs.statSync(gen2).mode & 0o777).toBe(0o700);
    // 新代际的 XDG 注入指向 gen2；confine root 两次都仍是项目
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.XDG_DATA_HOME).toBe(path.join(gen2, 'xdg-data'));
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls.map((call) => call.policy.workspaceRoot)).toEqual([fs.realpathSync(harness.logDir), fs.realpathSync(harness.logDir)]);
    // tmp 下本会话只剩 gen2
    expect(tmpEntriesOf(String(sessionId))).toEqual([name2]);
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.length).toBeGreaterThanOrEqual(2);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(2);
    expect(data.agentDataHome).toBe(gen2);
    expect(data.agentDataGeneration).toBe(2);
    expect(data.launchFingerprint.dataHomeGeneration).toBe(2);
  }, 20_000);

  it('read-only 档回归钉：状态目录仍是 profile 级持久 stateRoot，tmp 下零 per-session 目录', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('devin-state-ro');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe'), 'devin');

    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;
    agent.followup(userText('probe the filesystem'));
    await agent.whenIdle();

    const stateRoot = fs.realpathSync(path.join(harness.dshHome, 'dsh-acp', 'state', profile.id));
    // confine root = canonical stateRoot（read-only 档；权限映射 重映射后 policy.mode 记 workspace-write）
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy.workspaceRoot).toBe(stateRoot);
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.XDG_DATA_HOME).toBe(path.join(stateRoot, 'xdg-data'));
 // 只消费 workspace-write 档：tmp 下零 per-session 目录
    expect(tmpEntriesOf(String(sessionId))).toEqual([]);
    // binding 不记 per-session 状态目录（该档 stateDir = stateRoot，天然 durable）
    const bindings = await bindingEntries(harness, sessionId);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(1);
    expect(data.agentDataHome).toBeNull();
    expect(data.agentDataGeneration).toBeNull();
  }, 20_000);
});
