// agent-data-home.spec.ts —   黑盒测试：确定性 agent data home
// （codex/kimi/claude）+ launch fingerprint 预检 + profile identity 字段。
//
// 矩阵：
//   1. codex runtime（read-only 档）：确定性 data home 选址
//      <dshHome>/dsh-acp/agent-data/<profileId>/<sessionId>/<generation>；confine
//      root = canonical data home；CODEX_HOME 经 spawnPlan 到达子进程（fs-probe
//      envEcho 见证）；binding 载荷携带 agentDataHome/agentDataGeneration 与
// 指纹分量（descriptorId/dataHomeGeneration）。
//   2. rebindBlank 新代际：generation 2 用新目录，两代目录并存，gen1 marker 保留
//      （绝不覆盖旧代际）；binding 重写为 generation 2 + 新数据根。
//   3. resume 复用 binding.agentDataHome：预置 binding（真实指纹）+ 匹配种子日志
//      → 走 session/load，confine root = binding 记录的数据根，不新建代际目录。
// 4. 旧形状指纹（三分量）的 binding：resume 预检② canonical 哈希不等 →
//      既有 'profile-changed' 阻断（无第二套机制）。
//   5. claude runtime：envRef 取值注入（ANTHROPIC_BASE_URL 到达子进程）、
//      CLAUDE_CONFIG_DIR 指向 data home、指纹 envRefs 只记 presence（值不落盘）。
// 6. fail-closed 创建门：workspace-write 档 + 本地状态 runtime →
//      ACP_SPAWN_CONFIG（turn/end error），零目录创建、零会话 confine。
// 7. executableOverride 注入：CLAUDE_CODE_EXECUTABLE 在场时取值到达
//      子进程（mock watch 见证 present），指纹仍只记 presence。
//
// 组装层见 test/agent-test-helpers.ts。孤儿进程防线与各 spec 同款：argv 带
// SPEC_TAG，afterEach 兜底 dispose 全部 handle，afterAll `ps` 全量扫描。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import { ACP_RECONCILIATION_GUIDANCE } from '../../../src/domain/session/resume.ts';
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts';
import type { AcpBindingData, AcpReconciliationCause, AcpSidecarEntry } from '../../../src/persistence/sidecar.ts';
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
function withRuntime(profile: MockProfile, runtime: NonNullable<AcpAgentConfig['runtime']>, extra: Partial<AcpAgentConfig> = {}): MockProfile {
  profile.config = { ...profile.config, ...extra, runtime };
  return profile;
}

/** 该 profile+session+代际的确定性 data home 预期路径（未 canonicalize）。 */
function expectedDataHome(harness: AgentHarness, profile: MockProfile, sessionId: string, generation: number): string {
  return path.join(harness.dshHome, 'dsh-acp', 'agent-data', profile.id, sessionId, String(generation));
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

/** 该会话 sidecar 里的全部 reconciliation 记录的 cause（落盘顺序）。 */
async function reconciliationCauses(harness: AgentHarness, sessionId: SessionId): Promise<AcpReconciliationCause[]> {
  const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
  return entries.filter((entry) => entry.kind === 'reconciliation').map((entry) => entry.data.cause);
}

/** 阻断断言组：continuity 闩锁（status+cause）+ 末个 turn/end 的错误码 + 出路文案。 */
function expectBlocked(agent: Agent, cause: AcpReconciliationCause): void {
  const continuity = (agent as AcpAgent).continuityState;
  expect(continuity.status).toBe('blocked');
  expect(continuity.cause).toBe(cause);
  const ends = eventsOf(agent, 'turn/end');
  const lastEnd = ends.at(-1);
  expect(lastEnd?.data.reason.kind).toBe('error');
  expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.code : undefined).toBe('ACP_RECONCILIATION_REQUIRED');
  expect(lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error.message : '').toContain(ACP_RECONCILIATION_GUIDANCE);
}

/** 会话 spawn 的 confine 调用（policy.sessionId 在场；门内 probe 的调用无 sessionId）。 */
function sessionConfineCalls(harness: AgentHarness, sessionId: string) {
  return (harness.sandbox?.confineCalls ?? []).filter((call) => call.policy.sessionId === sessionId);
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-agent-data-home-spec-'));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
});

afterAll(() => {
  const pidScan = psLinesWithTag(SPEC_TAG);
  expect(pidScan).toEqual([]);
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('确定性 agent data home', () => {
 it('codex runtime（read-only 档）：data home 选址/注入/confine root + binding 新载荷与 指纹分量', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('datahome-codex-1');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe', {
      MOCK_ENV_WATCH: 'CLAUDE_CODE_EXECUTABLE',
    }), 'codex');
    const gen1 = expectedDataHome(harness, profile, String(sessionId), 1);
    const marker = path.join(gen1, 'marker.txt');
    profile.config.env['MOCK_FS_PROBE_WRITES'] = JSON.stringify([marker]);

    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;
    agent.followup(userText('probe the filesystem'));
    await agent.whenIdle();

    const canonicalDataHome = fs.realpathSync(gen1);
    // confine root = canonical data home（read-only 档；权限映射 重映射后 policy.mode 记录为 workspace-write）
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy.workspaceRoot).toBe(canonicalDataHome);
    // CODEX_HOME 经 spawnPlan 到达子进程；marker 经 /bin/sh 写进 data home
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.CODEX_HOME).toBe(canonicalDataHome);
    expect(echo.fsProbeResults?.[0]).toMatchObject({ path: marker, ok: true });
    expect(fs.readFileSync(marker, 'utf8').length).toBeGreaterThan(0);
    // data home 权限收紧 0700
    expect((fs.statSync(gen1).mode & 0o777)).toBe(0o700);
    // MOCK_ENV_WATCH：claude 专属 override 键在 codex profile 下缺席（存在性回显格式实测）
    expect(readLog(profile.logPath)).toContain('watch:CLAUDE_CODE_EXECUTABLE=absent');

 // binding 载荷：新字段 + 指纹分量（建立 + turn 收束锚点刷新各
    // 落一条，取最新一条断言）
    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(1);
    expect(data.agentDataHome).toBe(canonicalDataHome);
    expect(data.agentDataGeneration).toBe(1);
    expect(data.launchFingerprint.profileId).toBe(profile.id);
    expect(data.launchFingerprint.descriptorId).toBe('codex');
    expect(data.launchFingerprint.dataHomeGeneration).toBe(1);
    expect(data.launchFingerprint.opaqueRefs).toEqual([
      { source: path.normalize(path.join(os.homedir(), '.codex/auth.json')), targetRelative: 'auth.json' },
      { source: path.normalize(path.join(os.homedir(), '.codex/config.toml')), targetRelative: 'config.toml' },
    ]);
  }, 20_000);

  it('rebindBlank 新代际：generation 2 用新目录，两代并存，gen1 marker 保留', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('datahome-codex-rebind');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe'), 'codex');
    const gen1 = expectedDataHome(harness, profile, String(sessionId), 1);
    const gen2 = expectedDataHome(harness, profile, String(sessionId), 2);
    const marker = path.join(gen1, 'marker.txt');
    profile.config.env['MOCK_FS_PROBE_WRITES'] = JSON.stringify([marker]);

    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent as AcpAgent;
    agent.followup(userText('first generation'));
    await agent.whenIdle();
    expect(fs.existsSync(marker)).toBe(true);

    await agent.rebindBlank();
    agent.followup(userText('second generation'));
    await agent.whenIdle();

    // 两代目录并存；gen1 marker 未被覆盖删除；gen2 成为新 confine root
    expect(fs.existsSync(gen1)).toBe(true);
    expect(fs.existsSync(gen2)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls.map((call) => call.policy.workspaceRoot)).toEqual([fs.realpathSync(gen1), fs.realpathSync(gen2)]);
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.CODEX_HOME).toBe(fs.realpathSync(gen2));

    const bindings = await bindingEntries(harness, sessionId);
    expect(bindings.length).toBeGreaterThanOrEqual(2);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(2);
    expect(data.agentDataHome).toBe(fs.realpathSync(gen2));
    expect(data.agentDataGeneration).toBe(2);
    expect(data.launchFingerprint.dataHomeGeneration).toBe(2);
  }, 20_000);

  it('resume 复用 binding.agentDataHome：走 session/load，confine root = binding 数据根，不新建代际目录', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('datahome-codex-resume');
    const profile = withRuntime(mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    }), 'codex');
    // 预造「上次建立」的数据根（含 marker 文件），binding 记录它
    const gen1 = expectedDataHome(harness, profile, String(sessionId), 1);
    fs.mkdirSync(gen1, { recursive: true });
    fs.writeFileSync(path.join(gen1, 'marker.txt'), 'from-generation-1');
    const canonicalDataHome = fs.realpathSync(gen1);

    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    const sidecar = harness.loop.acpSidecar;
    expect(sidecar).toBeDefined();
    await sidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-alpha',
        overrides: {
          dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
          agentDataHome: canonicalDataHome,
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
    // confine root = binding 记录的数据根；目录内容（marker）原样保留
    const calls = sessionConfineCalls(harness, String(sessionId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy.workspaceRoot).toBe(canonicalDataHome);
    expect(fs.readFileSync(path.join(gen1, 'marker.txt'), 'utf8')).toBe('from-generation-1');
    // 不新建任何其他代际目录
    expect(fs.readdirSync(path.dirname(gen1))).toEqual(['1']);
    // binding 续代重写：generation 不变，agentDataHome 不变
    const bindings = await bindingEntries(harness, sessionId);
    const data = bindings.at(-1)?.data as AcpBindingData;
    expect(data.generation).toBe(1);
    expect(data.agentDataHome).toBe(canonicalDataHome);
  }, 20_000);

 it('旧形状指纹（三分量）的 binding：预检② canonical 哈希不等 → 既有 profile-changed 阻断', async () => {
    const harness = await boot();
    const sessionId = SessionId('datahome-old-fingerprint');
    const profile = mockProfile(harness.logDir, 'happy', {
      MOCK_PRESET_SESSIONS: JSON.stringify(['preset-alpha']),
    });
    harness.persistence.seed(sessionId, seedLogMatchingLoadReplay(routeOf(profile), 'mock-model-a'), { cwd: harness.logDir });
    const sidecar = harness.loop.acpSidecar;
    await sidecar?.append(sessionId, {
      kind: 'binding',
      data: bindingFixture(profile, {
        agentSessionId: 'preset-alpha',
        overrides: {
          dshCommittedSeq: LOAD_REPLAY_MATCHED_COMMITTED_SEQ,
    // 旧版本写出的指纹形状：只有 command/args/envKeys，不含新增键。
          launchFingerprint: {
            command: profile.config.command,
            args: [...profile.config.args],
            envKeys: Object.keys(profile.config.env).sort(),
          },
        },
      }),
    });

    await registerAcpAgents(harness, [profile]);
    const handle = await harness.loop.resume(harness.ctx, { resumeSessionId: sessionId });
    harness.handles.push(handle);
    const agent = handle.agent;
    agent.followup(userText('continue after resume'));
    await agent.whenIdle();

    expectBlocked(agent, 'profile-changed');
    expect(await reconciliationCauses(harness, sessionId)).toEqual(['profile-changed']);
    // 阻断即终态：不走 session/load
    expect(readLog(profile.logPath)).not.toContain('session/load');
  }, 20_000);

  it('claude runtime：envRef 取值注入子进程、CLAUDE_CONFIG_DIR 指向 data home、指纹 envRefs 只记 presence（值不落盘）', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('datahome-claude-1');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe'), 'claude');
    const gen1 = expectedDataHome(harness, profile, String(sessionId), 1);
    const gateway = 'https://gateway.test.invalid';
    const realBaseUrl = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = gateway;
    try {
      const handle = await createAcpAgent(harness, profile, sessionId);
      const agent = handle.agent;
      agent.followup(userText('probe the filesystem'));
      await agent.whenIdle();

      const canonicalDataHome = fs.realpathSync(gen1);
      const echo = fsProbeEcho(agent);
 // 边界：descriptor envRef 按声明键名从 DSH 进程环境取值注入
      expect(echo.envEcho.ANTHROPIC_BASE_URL).toBe(gateway);
 // 边界：data home 经 CLAUDE_CONFIG_DIR 指给子进程
      expect(echo.envEcho.CLAUDE_CONFIG_DIR).toBe(canonicalDataHome);

      const bindings = await bindingEntries(harness, sessionId);
      const data = bindings.at(-1)?.data as AcpBindingData;
      expect(data.agentDataHome).toBe(canonicalDataHome);
      expect(data.agentDataGeneration).toBe(1);
      expect(data.launchFingerprint.descriptorId).toBe('claude');
      // envRefs 九条全在、只记 presence；值绝不进 binding（密钥纪律钉版）
      expect(data.launchFingerprint.envRefs).toHaveLength(9);
      expect(data.launchFingerprint.envRefs?.find((ref) => ref.key === 'ANTHROPIC_BASE_URL')).toEqual({ key: 'ANTHROPIC_BASE_URL', present: true });
      expect(data.launchFingerprint.envRefs?.find((ref) => ref.key === 'ANTHROPIC_API_KEY')?.present).toBe(process.env['ANTHROPIC_API_KEY'] !== undefined && process.env['ANTHROPIC_API_KEY'] !== '');
      expect(data.launchFingerprint.executableOverride).toEqual({ name: 'CLAUDE_CODE_EXECUTABLE', present: process.env['CLAUDE_CODE_EXECUTABLE'] !== undefined && process.env['CLAUDE_CODE_EXECUTABLE'] !== '' });
      expect(JSON.stringify(data.launchFingerprint)).not.toContain(gateway);
    } finally {
      if (realBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = realBaseUrl;
    }
  }, 20_000);

 it('fail-closed 创建门：workspace-write 档 + 本地状态 runtime（codex）→ ACP_SPAWN_CONFIG，零目录零 confine', async () => {
    const harness = await boot(); // 默认 workspace-write 档
    const sessionId = SessionId('datahome-ww-gate');
    const profile = withRuntime(mockProfile(harness.logDir, 'happy'), 'codex');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    const reason = eventsOf(agent, 'turn/end').at(-1)?.data.reason;
    expect(reason?.kind).toBe('error');
    expect(reason?.kind === 'error' ? reason.error.code : undefined).toBe('ACP_SPAWN_CONFIG');
    const message = reason?.kind === 'error' ? reason.error.message : '';
    expect(message).toContain('workspace-write');
    expect(message).toContain('read-only or danger-full-access');
    // 门在 resolveAgentDataHome 的 fs 副作用之前：agent-data 目录未创建、会话 confine 零调用
    expect(fs.existsSync(path.join(harness.dshHome, 'dsh-acp', 'agent-data', profile.id))).toBe(false);
    expect(sessionConfineCalls(harness, String(sessionId))).toHaveLength(0);
  }, 20_000);

 it('边界：executableOverrideEnv 取值注入子进程（CLAUDE_CODE_EXECUTABLE 在场 → mock 见证 present；指纹仍只记 presence）', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const sessionId = SessionId('datahome-claude-override');
    const profile = withRuntime(mockProfile(harness.logDir, 'fs-probe', {
      MOCK_ENV_WATCH: 'CLAUDE_CODE_EXECUTABLE',
    }), 'claude');
    const realOverride = process.env['CLAUDE_CODE_EXECUTABLE'];
    process.env['CLAUDE_CODE_EXECUTABLE'] = '/tmp/dsh-acp-spec-fake-claude';
    try {
      const handle = await createAcpAgent(harness, profile, sessionId);
      handle.agent.followup(userText('probe the filesystem'));
      await handle.agent.whenIdle();

      //  缺口修复钉：指纹记了 present，值必须真的到达子进程
      expect(readLog(profile.logPath)).toContain('watch:CLAUDE_CODE_EXECUTABLE=present');
      const bindings = await bindingEntries(harness, sessionId);
      const data = bindings.at(-1)?.data as AcpBindingData;
      expect(data.launchFingerprint.executableOverride).toEqual({ name: 'CLAUDE_CODE_EXECUTABLE', present: true });
      // 值绝不进 binding（密钥纪律同 envRefs）
      expect(JSON.stringify(data.launchFingerprint)).not.toContain('/tmp/dsh-acp-spec-fake-claude');
    } finally {
      if (realOverride === undefined) delete process.env['CLAUDE_CODE_EXECUTABLE'];
      else process.env['CLAUDE_CODE_EXECUTABLE'] = realOverride;
    }
  }, 20_000);
});
