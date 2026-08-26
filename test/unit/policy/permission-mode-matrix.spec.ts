// permission-mode-matrix.spec.ts — （权限与模式双轴展示）随附测试：DSH 权限范围与 ACP
// agent mode 两个**独立**维度的组合矩阵 + spawn 前重解析钉。
//
// 裁决口径（README.md「权限范围与 Agent mode 是两条轴」）：
//   - 权限范围（DSH sandbox 三档）= 唯一安全边界：宿主 OS 级强制，ACP mode
//     任何值都不能放宽它（"ACP Bypass + DSH read-only 仍不能写工作区"）；
//   - ACP agent mode（Devin 的 Ask/Plan/Accept Edits/Bypass…）= agent 侧行为
//     配置：切换不触碰 sandbox（"ACP Plan + DSH Full Access 仍拥有 OS 写权限"）；
//   - 两轴各自独立审计：permission-scope 每次 spawn 落一条（该次 spawn 实际
//     应用的 confine 事实），agent-mode 在建立与每次经本插件 seam 下发时落一条；
//     agent 自发 current_mode_update push v1 不落条（mock 双发正好钉死不多落）。
//
// 覆盖：
//   1. 3 权限档 × mode 切换矩阵：每档 boot + turn 1 spawn；经 dshAcp Remote
//      service setOption 切 mode（plan → bypass，happy 形态走 set_config_option）
//      ——每步钉 confineCalls/spawnedPids 不变；终态 permission-scope 恰 1 条、
//      agent-mode 恰 3 条（via：session-setup / set_config_option ×2）。
//   2. spawn 前每次重新解析 sandboxPolicy：confine 注入失败 → fail closed
//      （ACP_SANDBOX_UNAVAILABLE、零 spawn、零审计）；同会话档位翻为
//      danger-full-access 后 followup 重 spawn 用新档（resolveCalls=2，
//      permission-scope 落 danger 一条）——不重启宿主、不重建会话。
//   3. legacy set_mode 路径（no-config-options 形态）：setOption mode 走
//      session/set_mode，agent-mode 落 via='set_mode'。
//
// HTTP 旁路端点删除，mode 写入直驱 loop 构造时注册的 dshAcp Remote
// service（harness.ctx.get('dshAcp')）；接线钉见 wiring.spec.ts 生产接线。
// 组装层与孤儿进程防线同 wiring.spec.ts（SPEC_TAG + afterEach dispose + afterAll ps）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  SPEC_TAG,
  createHarness,
  eventsOf,
  mockProfile,
  psLinesWithTag,
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
  const pidScan = psLinesWithTag(SPEC_TAG);
  expect(pidScan).toEqual([]);
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

      // 只有设置 probe 受 confine；正式 ACP session 是原生访问。
      expect(harness.sandbox?.confineCalls).toHaveLength(1);
      expect(harness.sandbox?.confineCalls[0]?.policy.sessionId).toBeUndefined(); // 门内 probe
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
        // mode 不是安全边界：不触发重 confine、不重 spawn
        expect(harness.sandbox?.confineCalls).toHaveLength(1);
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
      expect(harness.sandbox?.confineCalls).toHaveLength(1);
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
    expect(harness.sandbox?.confineCalls).toHaveLength(1); // 仅门内 probe
    expect(harness.sandboxPolicy?.resolveCalls).toHaveLength(1);
    const sidecar = harness.loop.acpSidecar;
    expect(((await sidecar?.list(sessionId)) ?? []).filter((entry) => entry.kind === 'permission-scope')).toHaveLength(0);

    // 同会话档位切为 danger-full-access（不重启宿主、不重建会话）→ followup 触发
    // 重 spawn：policy 重新解析（resolveCalls=2）、新档不 confine、spawn 成功
    if (harness.sandboxPolicy !== undefined) harness.sandboxPolicy.mode = 'danger-full-access';
    agent.followup(userText('retry'));
    await agent.whenIdle();
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    expect(harness.sandboxPolicy?.resolveCalls).toHaveLength(2);
    expect(harness.sandbox?.confineCalls).toHaveLength(1); // 仍仅门内 probe；danger 档不 confine
    expect(spawnedPids(profile.logPath)).toHaveLength(2); // probe + 会话

    // 权限轴审计补落一条 danger（如实反映第二次 spawn 的 confine 事实）
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
    // mode 切换不碰 sandbox：只有门内 probe 的一次 confine。
    expect(harness.sandbox?.confineCalls).toHaveLength(1);
    expect(spawnedPids(profile.logPath)).toHaveLength(2);
  }, 20_000);
});
