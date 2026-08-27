// Native Agent Access is a fixed prerequisite for ACP sessions. Agent mode is
// an independent ACP option: changing it must not respawn the process or alter
// the host access fact recorded for the session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  createHarness,
  eventsOf,
  mockProfile,
  registerAcpAgents,
  routeOf,
  spawnedPids,
  userText,
  waitFor,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, CreateHarnessOptions, MockProfile } from '../../fixtures/agent-test-helpers.ts';
import type { AcpRemoteService } from '../../../src/remote/service.ts';

/** loop 构造时注册的 dshAcp Remote service（ctx.get 返回 traceable proxy，方法调用落到同一实例）。 */
function acpRemote(harness: AgentHarness): AcpRemoteService {
  return harness.ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
}

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(options?: CreateHarnessOptions): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, options ?? {});
  harnesses.push(harness);
  return harness;
}

/** 创建并登记一个 ACP agent（经 loop 路由），返回 handle（wiring.spec.ts 同款）。 */
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

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-matrix-spec-'));
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

describe('原生 Agent 访问 × Agent mode（两轴独立）', () => {
    it('Agent mode 热切换全程不改变 DSH 原生访问权限、不重启进程', async () => {
      const harness = await boot({ sandboxMode: 'danger-full-access' });
      const profile = mockProfile(harness.logDir, 'happy');
      const sessionId = SessionId('matrix-native');
      const handle = await createAcpAgent(harness, profile, sessionId);
      const agent = handle.agent as AcpAgent;

      agent.followup(userText('hello'));
      await agent.whenIdle();
      expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });

      // 健康探测与正式会话都使用 Agent 原生环境。
      expect(spawnedPids(profile.logPath)).toHaveLength(2); // probe + 会话

      // 建立时两轴各落一条
      const sidecar = harness.loop.acpSidecar;
      expect(sidecar).toBeDefined();
      const initial = (await sidecar?.list(sessionId)) ?? [];
      expect(initial.filter((entry) => entry.kind === 'permission-scope').map((entry) => entry.data)).toEqual([
        { mode: 'danger-full-access', confined: null, platform: process.platform },
      ]);
      expect(initial.filter((entry) => entry.kind === 'agent-mode').map((entry) => entry.data)).toEqual([
        { modeId: 'accept-edits', via: 'session-setup' },
      ]);

      // mode 轴切换 ×2（plan → bypass）：全程权限轴零变化（每步都钉）
      for (const mode of ['plan', 'bypass']) {
        await acpRemote(harness).setOption(sessionId, { configId: 'mode', value: mode });
        // mode 不是安全边界：不重启 Agent 进程。
        expect(spawnedPids(profile.logPath)).toHaveLength(2);
        // mock 补推 current_mode_update → 状态槽最终一致（响应快照的 currentModeId
        // 可能是推送前的旧值，不断言它）
        await waitFor(() => agent.currentModeId === mode);
      }

      // 切换后再跑一个 turn：会话照常工作，权限轴仍零变化
      agent.followup(userText('after mode switches'));
      await agent.whenIdle();
      expect(eventsOf(agent, 'turn/end').map((event) => event.data.turn)).toEqual([1, 2]);
      expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
      expect(spawnedPids(profile.logPath)).toHaveLength(2);

      // 终态审计：权限轴仍恰 1 条（spawn 一次）；mode 轴恰 3 条——mock 双发的
      // current_mode_update push 不多落（v1 口径：只记录本插件建立/下发的事实）
      const entries = (await sidecar?.list(sessionId)) ?? [];
      expect(entries.filter((entry) => entry.kind === 'permission-scope')).toHaveLength(1);
      expect(entries.filter((entry) => entry.kind === 'agent-mode').map((entry) => entry.data)).toEqual([
        { modeId: 'accept-edits', via: 'session-setup' },
        { modeId: 'plan', via: 'set_config_option' },
        { modeId: 'bypass', via: 'set_config_option' },
      ]);
    }, 20_000);
});

describe('spawn 前每次重新解析 sandboxPolicy（钉）', () => {
  it('受限档在 spawn 前拒绝；同会话明确切到原生访问后可重试', async () => {
    const harness = await boot({ sandboxMode: 'workspace-write' });
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('matrix-repolicy');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent as AcpAgent;

    // turn 1：还是 workspace-write，域层在正式进程 spawn 前拒绝。
    agent.followup(userText('hello'));
    await agent.whenIdle();
    const failed = eventsOf(agent, 'turn/end').at(-1)?.data.reason;
    expect(failed?.kind).toBe('error');
    expect(failed?.kind === 'error' ? failed.error.code : undefined).toBe('ACP_SPAWN_CONFIG');
    expect(failed?.kind === 'error' ? failed.error.message : '').toContain('Native Agent Access');
    expect(spawnedPids(profile.logPath)).toHaveLength(1); // 仅门内 probe，零会话 spawn
    expect(harness.sandboxPolicy?.resolveCalls).toHaveLength(1);
    const sidecar = harness.loop.acpSidecar;
    expect(((await sidecar?.list(sessionId)) ?? []).filter((entry) => entry.kind === 'permission-scope')).toHaveLength(0);

    // 同会话档位切为 danger-full-access（不重启宿主、不重建会话）→ followup 触发
    // 重 spawn：startSession 与 prompt 前各校验一次、新档不 confine、spawn 成功
    if (harness.sandboxPolicy !== undefined) harness.sandboxPolicy.mode = 'danger-full-access';
    agent.followup(userText('retry'));
    await agent.whenIdle();
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    expect(harness.sandboxPolicy?.resolveCalls).toHaveLength(3);
    expect(spawnedPids(profile.logPath)).toHaveLength(2); // probe + 会话

    // 进程已经启动后再降档也必须在下一次 session/prompt 前拒绝；Full Access
    // 是每 turn 不变量，不是只在 spawn 时检查一次。
    if (harness.sandboxPolicy !== undefined) harness.sandboxPolicy.mode = 'workspace-write';
    agent.followup(userText('must not reach the Agent'));
    await agent.whenIdle();
    const downgraded = eventsOf(agent, 'turn/end').at(-1)?.data.reason;
    expect(downgraded?.kind).toBe('error');
    expect(downgraded?.kind === 'error' ? downgraded.error.code : undefined).toBe('ACP_SPAWN_CONFIG');
    expect(harness.sandboxPolicy?.resolveCalls).toHaveLength(4);
    expect(spawnedPids(profile.logPath)).toHaveLength(2);

    // 权限轴审计补落一条 Native Agent Access 事实。
    const entries = (await sidecar?.list(sessionId)) ?? [];
    expect(entries.filter((entry) => entry.kind === 'permission-scope').map((entry) => entry.data)).toEqual([
      { mode: 'danger-full-access', confined: null, platform: process.platform },
    ]);
    expect(entries.filter((entry) => entry.kind === 'agent-mode').map((entry) => entry.data)).toEqual([
      { modeId: 'accept-edits', via: 'session-setup' },
    ]);
  }, 20_000);
});

describe('legacy set_mode 路径的 mode 审计', () => {
  it('no-config-options 形态：setOption mode → session/set_mode，agent-mode 落 via=set_mode', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const profile = mockProfile(harness.logDir, 'no-config-options');
    const sessionId = SessionId('matrix-legacy-mode');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('hello'));
    await agent.whenIdle();
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });

    // 无 mode 类 config option + legacy modes 已知 → Remote service 走 set_mode 降级路径
    const snapshot = await acpRemote(harness).setOption(sessionId, { configId: 'mode', value: 'plan' });
    // set_mode 成功后 seam 同步喂状态槽（不依赖推送），返回快照即新值
    expect(snapshot.currentModeId).toBe('plan');

    const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    expect(entries.filter((entry) => entry.kind === 'agent-mode').map((entry) => entry.data)).toEqual([
      { modeId: 'accept-edits', via: 'session-setup' },
      { modeId: 'plan', via: 'set_mode' },
    ]);
    // mode 切换不触碰宿主访问模式。
    expect(spawnedPids(profile.logPath)).toHaveLength(2);
  }, 20_000);
});
