// Production wiring integration tests: Cordis runtime plus a mock ACP process.
// They cover native-access and subprocess seams, options and command bridges,
// permission/elicitation handling, profile health, recovery, and rich tool
// content. Assertions keep native access, fail-closed errors, audit records,
// and process cleanup observable at the host boundary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
import { AcpRemoteService } from '../../../src/remote/service.ts';
import {
  FakeApproval,
  FakeCommands,
  createHarness,
  eventsOf,
  inlineProfile,
  mockProfile,
  readLog,
  registerAcpAgents,
  routeOf,
  sleep,
  userText,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness, CreateHarnessOptions, MockProfile } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

async function boot(options?: CreateHarnessOptions): Promise<AgentHarness> {
  const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const harness = await createHarness(logDir, { sandboxMode: 'danger-full-access', ...(options ?? {}) });
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

/** 注册一个 warn 捕获 exporter（cordis LoggerService.exporter 是公开 API；默认阈值只放 error/info，须显式放宽到 warn）。 */
function captureWarns(harness: AgentHarness): string[] {
  const warns: string[] = [];
  harness.ctx.logger.exporter({
    levels: { default: 2 },
    export(message) {
      if (message.type === 'warn') warns.push(message.args.map(String).join(' '));
    },
  });
  return warns;
}

/** fs-probe turn 回传的 assistant 文本（JSON：{fsProbeResults, envEcho}）。 */
function fsProbeEcho(agent: AcpAgent): { envEcho: Record<string, string | null> } {
  const messages = eventsOf(agent, 'assistant/message');
  const text = messages.flatMap((event) =>
    event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
  )[0];
  return JSON.parse(text ?? '{}') as { envEcho: Record<string, string | null> };
}

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-wiring-spec-'));
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

describe('生产接线：原生访问启动计划', () => {
  it.each(['read-only', 'workspace-write'] as const)('%s：选择阶段若未切换原生访问，域层在 spawn 前拒绝', async (sandboxMode) => {
    const harness = await boot({ sandboxMode });
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId(`wiring-native-gate-${sandboxMode}`);
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('must not reach the ACP process'));
    await handle.agent.whenIdle();

    const reason = eventsOf(handle.agent as AcpAgent, 'turn/end').at(-1)?.data.reason;
    expect(reason?.kind).toBe('error');
    expect(reason?.kind === 'error' ? reason.error.code : undefined).toBe('ACP_SPAWN_CONFIG');
    expect(reason?.kind === 'error' ? reason.error.message : '').toContain('Native Agent Access');
    // Native Agent semantics: neither the probe nor the formal session is wrapped by the adapter.
    expect(((await harness.loop.acpSidecar?.list(sessionId)) ?? []).some((entry) => entry.kind === 'binding')).toBe(false);
    expect(fs.existsSync(path.join(harness.dshHome, 'dsh-acp', 'agent-data'))).toBe(false);
  }, 15_000);

  it('danger-full-access：不 confine + 一次性 warn + permission-scope/agent-mode 分轴审计落条', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const warns = captureWarns(harness);
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('wiring-spawn-danger');
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    // Native Agent semantics: formal sessions and readiness probes are unconfined.
    const notice = warns.filter((message) => message.includes('danger-full-access'));
    expect(notice).toHaveLength(1); // 一次性闩锁（每实例）
 // 分轴审计（权限与模式双轴展示）：权限范围轴落一条 permission-scope（Native 准入事实
    // 如实记录：confined null）；agent mode 轴落一条 agent-mode（session-setup 种子）
    const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const scopes = entries.filter((entry) => entry.kind === 'permission-scope');
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.data).toEqual({ mode: 'danger-full-access', confined: null, platform: process.platform });
    const modes = entries.filter((entry) => entry.kind === 'agent-mode');
    expect(modes).toHaveLength(1);
    expect(modes[0]?.data).toEqual({ modeId: 'accept-edits', via: 'session-setup' });
  }, 15_000);

  it('danger-full-access native：不创建/重定向 runtime data home，并原样透传宿主显式 data-home/XDG env', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const profile = mockProfile(harness.logDir, 'fs-probe');
    profile.id = 'codex';
    profile.config = { ...profile.config, runtime: 'codex' };
    const nativeHome = fs.mkdtempSync(path.join(suiteDir, 'native-home-'));
    const previous = new Map<string, string | undefined>([
      ['CODEX_HOME', process.env.CODEX_HOME],
      ['XDG_DATA_HOME', process.env.XDG_DATA_HOME],
      ['XDG_CONFIG_HOME', process.env.XDG_CONFIG_HOME],
    ]);
    process.env.CODEX_HOME = path.join(nativeHome, 'codex');
    process.env.XDG_DATA_HOME = path.join(nativeHome, 'data');
    process.env.XDG_CONFIG_HOME = path.join(nativeHome, 'config');
    try {
      const handle = await createAcpAgent(harness, profile, SessionId('wiring-native-runtime'));
      handle.agent.followup(userText('probe native environment'));
      await handle.agent.whenIdle();
      const echo = fsProbeEcho(handle.agent as AcpAgent);
      expect(echo.envEcho.CODEX_HOME).toBe(path.join(nativeHome, 'codex'));
      expect(echo.envEcho.XDG_DATA_HOME).toBe(path.join(nativeHome, 'data'));
      expect(echo.envEcho.XDG_CONFIG_HOME).toBe(path.join(nativeHome, 'config'));
      expect(fs.existsSync(path.join(harness.dshHome, 'dsh-acp', 'agent-data'))).toBe(false);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);

  it('probe 使用用户原生配置：不复制或重定向 data home', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    profile.id = 'codex';
    profile.config = { ...profile.config, runtime: 'codex', env: { ...profile.config.env, CODEX_HOME: 'relative-codex-home' } };
    await registerAcpAgents(harness, [profile]);
    await expect(harness.loop.installedProfileRegistry.adapter.listModels(routeOf(profile))).resolves.toHaveLength(3);
    const probeBase = path.join(harness.dshHome, 'dsh-acp', 'probe', 'codex');
    expect(fs.existsSync(probeBase) ? fs.readdirSync(probeBase) : []).toEqual([]);
  }, 15_000);

  it('native stale options：重算 fingerprint 使用 binding 记录的 native strategy', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('wiring-native-stale-fingerprint');
    const handle = await createAcpAgent(harness, profile, sessionId);
    handle.agent.followup(userText('native stale fingerprint'));
    await handle.agent.whenIdle();
    const remote = harness.ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
    await handle.dispose();
    const stale = await remote.liveOptions(sessionId);
    expect(stale.freshness).toBe('stale');
    expect(stale.fingerprintChanged).toBe(false);
  }, 15_000);

  it('native state env 漂移：CODEX_HOME/XDG_STATE_HOME 变化使 stale fingerprintChanged', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const profile = mockProfile(harness.logDir, 'happy');
    profile.id = 'codex';
    profile.config = { ...profile.config, runtime: 'codex' };
    const previous = new Map<string, string | undefined>([
      ['CODEX_HOME', process.env.CODEX_HOME],
      ['XDG_STATE_HOME', process.env.XDG_STATE_HOME],
    ]);
    process.env.CODEX_HOME = path.join(suiteDir, 'native-fingerprint-a');
    process.env.XDG_STATE_HOME = path.join(suiteDir, 'native-state-a');
    const sessionId = SessionId('wiring-native-state-env-fingerprint');
    try {
      const handle = await createAcpAgent(harness, profile, sessionId);
      handle.agent.followup(userText('native state fingerprint'));
      await handle.agent.whenIdle();
      const remote = harness.ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
      await handle.dispose();
      process.env.CODEX_HOME = path.join(suiteDir, 'native-fingerprint-b');
      process.env.XDG_STATE_HOME = path.join(suiteDir, 'native-state-b');
      const stale = await remote.liveOptions(sessionId);
      expect(stale.freshness).toBe('stale');
      expect(stale.fingerprintChanged).toBe(true);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);

 it(' tool result fidelity：非文本内容按占位/摘要落 log + meta，sidecar 恰一条 degradation', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'rich-content');
    const sessionId = SessionId('wiring-rich-content');
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('produce rich tool results'));
    await handle.agent.whenIdle();

    const results = eventsOf(handle.agent, 'tool/result');
    expect(results).toHaveLength(1);
    const block = results[0]?.data.message.content[0];
    if (block?.type !== 'tool-result') throw new Error('wiring fixture: expected a tool-result block');
    const texts = block.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`));
    // 每种 ACP content type 在 export 中都有事实（text 原样，其余占位/摘要/引用记录）
    expect(texts).toHaveLength(7);
    expect(texts[0]).toBe('visible text part');
    expect(texts[1]).toContain('[diff 摘要]');
    expect(texts[1]).toContain('README.md（修改）');
    expect(texts[2]).toContain('[terminal 占位] terminalId=mock-term-1');
    expect(texts[3]).toContain('[图片占位] image/png');
    expect(texts[4]).toContain('[资源 file:///mock/cwd/notes.txt（text/plain）]');
    expect(texts[5]).toContain('[二进制资源占位] file:///mock/cwd/bin.dat');
    expect(texts[6]).toContain('[资源引用] report.pdf（报表） → file:///mock/cwd/report.pdf');
    // meta 携带逐项结构化事实；字节不落盘（序列化不含 base64 载荷）
    const meta = results[0]?.data.meta as { acpToolContent: { items: { type: string }[]; truncated: boolean; originalItems: number } } | undefined;
    expect(meta?.acpToolContent.originalItems).toBe(7);
    expect(meta?.acpToolContent.truncated).toBe(false);
    expect(meta?.acpToolContent.items.map((item) => item.type)).toEqual([
      'text', 'diff', 'terminal', 'image', 'resource', 'blob', 'resource_link',
    ]);
    const serialized = JSON.stringify(results[0]?.data);
    expect(serialized).not.toContain('aGVsbG8taW1hZ2U=');
    expect(serialized).not.toContain('AAECAwQ=');

    // sidecar：一次终态 update 的降级恰一条（fire-and-forget 写，轮询等落盘）
    let entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const deadline = Date.now() + 5_000;
    while (!entries.some((entry) => entry.kind === 'degradation')) {
      if (Date.now() > deadline) throw new Error('degradation audit was not persisted within timeout');
      await sleep(5);
      entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    }
    const degradations = entries.filter((entry) => entry.kind === 'degradation');
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.data).toMatchObject({
      code: 'unsupported-tool-content',
      toolCallId: 'mock-tool-1',
      truncated: false,
    });
  }, 15_000);

  it('sandboxPolicy 缺席：回退 read-only 后被 Native-only 纵深门拒绝 + 一次性 warn', async () => {
    const harness = await boot({ sandboxPolicy: false });
    const warns = captureWarns(harness);
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-spawn-nopolicy'));

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    // Missing policy does not cause a synthetic confined probe; Native Agent
    // startup remains responsible for its own configuration and access mode.
    expect(warns.filter((message) => message.includes('sandboxPolicy service'))).toHaveLength(1);
    const reason = eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason;
    expect(reason?.kind === 'error' ? reason.error.code : undefined).toBe('ACP_SPAWN_CONFIG');
    expect(reason?.kind === 'error' ? reason.error.message : '').toContain('Native Agent Access');
  }, 15_000);

 it('subprocess 缺席：门内 probe fail closed（spawn-failure）→ 创建门拒绝 createAgent，零 spawn', async () => {
    const harness = await boot({ subprocess: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

 // seam 缺席时 probe 以 spawn-failure 进缓存，创建门以同 kind 拒绝
    // No turn-level ACP_SPAWN_FAILURE window exists when the host seam is absent.
    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('wiring-spawn-nosubprocess'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('spawn-failure');
    const snapshot = harness.loop.installedProfileRegistry.adapter.probeSnapshot(routeOf(profile));
    if (snapshot?.result.kind === 'error') expect(snapshot.result.failureKind).toBe('spawn-failure');
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

});

describe('生产接线：options-sync 每 turn 前同步', () => {
  it('无原生选择：每 turn 恰好一次 assemble，两个 turn 均正常完成', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-sync-noop'));

    handle.agent.followup(userText('first'));
    await handle.agent.whenIdle();
    handle.agent.followup(userText('second'));
    await handle.agent.whenIdle();

    expect(eventsOf(handle.agent, 'turn/end').map((event) => event.data.turn)).toEqual([1, 2]);
    expect(harness.assembleCalls).toHaveLength(2);
    // 无监听器：零 set_config_option（seed 透出即 no-op）
    expect(readLog(profile.logPath)).not.toContain('set_config_option');
  }, 15_000);

 it('agent/request 监听器改模型： 不再重申（零 set_config_option），turn 按 ACP 当前模型完成', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-sync-model'));
    // 原生选择器等价物：waterfall 把模型改为 mock-model-b（provider 不变）
    harness.ctx.on('agent/request', async (payload, next) => {
      if (payload.agent !== handle.agent) return next();
      return { ...(await next()), provider: routeOf(profile), model: 'mock-model-b' };
    });

    handle.agent.followup(userText('first'));
    await handle.agent.whenIdle();
    handle.agent.followup(userText('second'));
    await handle.agent.whenIdle();

    const log = readLog(profile.logPath);
    // 模型写已移出原生路径：MOCK_LOG 零 set_config_option（分叉仅一次性 warn）
    expect(log).not.toContain('set_config_option');
    const headers = eventsOf(handle.agent, 'request/header');
    expect(headers).toHaveLength(1); // 模型未变：无 change header
    expect(headers[0]?.data.header.config).toEqual({ provider: routeOf(profile), model: 'mock-model-a' });
    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
  }, 15_000);

 it('：原生选择器指向 foreign provider → turn 响亮失败（ACP_PROTOCOL_ERROR，消息含两端 backend），prompt 帧零发出；撤掉 foreign 选择后恢复正常', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-sync-foreign'));
    // 原生选择器等价物：waterfall 把 provider 改成另一个 backend（跨 backend 热切换）
    const off = harness.ctx.on('agent/request', async (payload, next) => {
      if (payload.agent !== handle.agent) return next();
      return { ...(await next()), provider: 'native-anthropic', model: 'claude-x' };
    });

    handle.agent.followup(userText('first'));
    await handle.agent.whenIdle();

    // turn 响亮失败：error code = ACP_PROTOCOL_ERROR，消息明说两端 backend 与出路
    const lastEnd = eventsOf(handle.agent, 'turn/end').at(-1);
    expect(lastEnd?.data.reason.kind).toBe('error');
    const failure = lastEnd?.data.reason.kind === 'error' ? lastEnd.data.reason.error : undefined;
    expect(failure?.code).toBe('ACP_PROTOCOL_ERROR');
    expect(failure?.message).toContain(routeOf(profile));
    expect(failure?.message).toContain('native-anthropic');
    expect(failure?.message).toContain('new session');
    // 失败点在 prompt 之前：session/new 已建立（懒启动在 sync 之前），prompt 零发出
    const mockLog = readLog(profile.logPath);
    expect(mockLog).toContain('session/new');
    expect(mockLog).not.toContain('session/prompt');

    // 不是闩锁：撤掉 foreign 选择后下一 turn 正常完成
    off();
    handle.agent.followup(userText('second'));
    await handle.agent.whenIdle();
    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
  }, 15_000);
});

describe('生产接线：commands 桥', () => {
  it('available_commands_update 种子补种注册；handler 把 `/name args` 原文作为下一 turn prompt', async () => {
    const commands = new FakeCommands();
    const harness = await boot({ commands });
    const profile = mockProfile(harness.logDir, 'commands');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-commands'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    // session/new 响应前的推送经 pendingAvailableCommands 种子补种注册
    expect([...commands.registered.keys()].sort()).toEqual(['another-cmd', 'mock-cmd']);
    expect(commands.registered.get('mock-cmd')?.description).toBe('Mock slash command');
    expect(agent.availableCommands?.map((command) => command.name).sort()).toEqual(['another-cmd', 'mock-cmd']);

    // 执行命令：原文重放为下一 turn 的 prompt（plugin 来源 user/message 落盘见证）
    const definition = commands.registered.get('mock-cmd');
    const result = await definition?.handler({ rawInput: ' --flag' });
    expect(result).toEqual({ kind: 'success' });
    await agent.whenIdle();

    const texts = eventsOf(agent, 'user/message').map((event) => event.data.content);
    expect(texts).toContainEqual([{ type: 'text', text: '/mock-cmd --flag' }]);
    expect(eventsOf(agent, 'turn/end').map((event) => event.data.turn)).toEqual([1, 2]);
  }, 15_000);
});

describe('生产接线：permissions 桥', () => {
  it('permission-flow + fake approval（allowed-once）：mock 收到 allow_once；sidecar 落 asked/decided 审计对', async () => {
    const approval = new FakeApproval();
    const harness = await boot({ approval });
    const profile = mockProfile(harness.logDir, 'permission-flow');
    const sessionId = SessionId('wiring-permission');
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('run the command'));
    await handle.agent.whenIdle();

    // 桥 → approval 服务：toolName/signal/reason 齐备
    expect(approval.requests).toHaveLength(1);
    const request = approval.requests[0];
    expect(request?.toolName).toBe('Run: echo hello');
    expect(request?.reason).toContain('工具：Run: echo hello');
    // Native DSH fallback has no separate ACP details panel, so it retains
    // the redacted command summary in its reason.
    expect(request?.reason).toContain('命令：echo hello');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.agent).toBe(handle.agent);
    // mock 侧收到 allow_once 并继续执行
    expect(readLog(profile.logPath)).toContain('permission outcome=selected optionId=allow_once');
    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    // sidecar 审计对（sidecar 持久化规则 通道）：asked 在咨询前、decided 在应答前，requestId 配对
    const sidecar = harness.loop.acpSidecar;
    expect(sidecar).toBeDefined();
    const entries = (await sidecar?.list(sessionId)) ?? [];
    const audits = entries.filter((entry) => entry.kind === 'permission');
    expect(audits.map((entry) => entry.data.phase)).toEqual(['asked', 'decided']);
    const [asked, decided] = audits;
    expect(asked?.data.phase === 'asked' ? asked.data.toolCall.toolCallId : undefined).toBe('mock-tool-perm-1');
    expect(decided?.data).toMatchObject({
      phase: 'decided',
      outcome: 'selected',
      optionId: 'allow_once',
      approvalOutcome: 'allowed-once',
    });
    expect(asked?.data.requestId).toBe(decided?.data.requestId);
  }, 15_000);
});

describe('生产接线：dshAcp Remote service 注册 + resolveLiveAgent', () => {
  it('loop 注册 dshAcp；首次读取 options 预建真实 ACP 会话，首条 prompt 前即可控制选项', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('wiring-health');
    const handle = await createAcpAgent(harness, profile, sessionId);
    // Non-zero pre-existing DSH history proves the draft candidate is rebased
    // at the first-turn boundary, not persisted with prepare-time seq=0.
    handle.agent.session.append('user/message', userText('prior'), { surfaceOp: 'append' });
    const firstTurnBoundarySeq = handle.agent.session.seq;

 // webServer 旁路路由删除；接线点是 cordis 服务注册（gateway 经 strict
    // descriptor 按名取实例）。ctx.get 返回 traceable proxy，方法调用落到同一实例。
    const remote = harness.ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
    expect(remote).toBeInstanceOf(AcpRemoteService);

    // 零 turn 读取 options 会建立 draft ACP session（不是 probe），但不写正式
    // binding，也不会发送 session/prompt；第一条用户消息前 mode/thinking/model 已可用。
    const prepared = await remote.liveOptions(sessionId);
    expect(prepared.configOptions).toHaveLength(2);
    expect(prepared.currentModeId).toBe('accept-edits');
    expect(prepared.capabilities?.loadSession).toBe(true);
    expect(prepared.continuity).toEqual({ status: 'ok', cause: null, detail: null });
    expect(prepared.contextUsage).toBeNull();
    expect(readLog(profile.logPath)).toContain('--> session/new');
    expect(readLog(profile.logPath)).not.toContain('--> session/prompt');
    expect((await harness.loop.acpSidecar?.readLatestBinding(sessionId))).toBeUndefined();

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();
    const committed = await harness.loop.acpSidecar?.readLatestBinding(sessionId);
    expect(committed?.status).toBe('ok');
    if (committed?.status === 'ok') {
      expect(firstTurnBoundarySeq).toBeGreaterThan(0);
      expect(committed.binding.historyBaseSeq).toBeGreaterThan(0);
      // The turn-end anchor is intentionally advanced after the prompt; the
      // important invariant is that the immutable history base was not the
      // prepare-time placeholder (0).
      expect(committed.binding.dshCommittedSeq).toBeGreaterThanOrEqual(firstTurnBoundarySeq);
    }

    const live = await remote.liveOptions(sessionId);
    expect(live.configOptions).toHaveLength(2);
    expect(live.currentModeId).toBe('accept-edits');
 // e2e：mock-agent 的 usage_update（used=1234/size=1048576）经
    // translator → AcpAgent → Remote 快照带出 contextUsage（cost 未提供归 null）；
    // 且 turn 末 assistant/message 不落伪 usage（tokenUsage projection 零汇总）
    expect(live.contextUsage).toEqual({ used: 1234, size: 1048576, percent: 0.1, cost: null });
    for (const message of eventsOf(handle.agent, 'assistant/message')) {
      expect(message.data).not.toHaveProperty('usage');
    }

    // 无活体（且无 last-known 快照）：throw（HTTP 时代 404 not-found 的继任；message 逐字由 health.spec.ts 钉）
    await expect(remote.liveOptions('ghost')).rejects.toThrow(
      'no live ACP agent for session "ghost" (not an ACP session, or already disposed)',
    );

    const health = await remote.health();
    const row = health.providers.find((candidate) => candidate.id === profile.id);
    expect(row?.executable).toBe(true);
  }, 15_000);
});

describe('生产接线：probe 使用原生 Agent 配置 + authMethods 透传', () => {
 it('listModels 的临时 ACP probe 不 confine、不复制凭证；authMethods 随缓存透传', async () => {
    const harness = await boot();
    const authMethods = [{ id: 'oauth', name: 'OAuth login' }];
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_AUTH_METHODS: JSON.stringify(authMethods) });
    await registerAcpAgents(harness, [profile]);

    const models = await harness.loop.installedProfileRegistry.adapter.listModels(routeOf(profile));
    expect(models.map((model) => model.id)).toEqual(['mock-model-a', 'mock-model-b', 'mock-model-c']);

    // Probe owns only a temporary ACP session and process. It does not create
    // adapter-owned Agent data-home staging roots.
    // The sidecar may retain its probe bookkeeping directory; no credential or
    // Agent data is staged there.
    expect(fs.existsSync(path.join(harness.dshHome, 'dsh-acp', 'agent-data'))).toBe(false);
    const probeBase = path.join(harness.dshHome, 'dsh-acp', 'probe', profile.id);
    expect(fs.existsSync(probeBase)).toBe(true);
    expect(fs.readdirSync(probeBase)).toEqual([]); // disposable run cwd is removed in finally

    // A crash can leave a prior run directory behind. The next probe owns and
    // sweeps only this profile's probe root before creating its new run cwd.
    const staleRun = path.join(probeBase, 'run-stale');
    fs.mkdirSync(staleRun, { recursive: true });
    fs.writeFileSync(path.join(staleRun, 'marker'), 'stale');
    harness.loop.installedProfileRegistry.adapter.invalidateProbe(routeOf(profile));
    await harness.loop.installedProfileRegistry.adapter.listModels(routeOf(profile));
    expect(fs.readdirSync(probeBase)).toEqual([]);

 // authMethods 自 缺口补齐后随缓存保留（health 端点透传面）
    const snapshot = harness.loop.installedProfileRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind).toBe('ok');
    expect(snapshot?.result.kind === 'ok' ? snapshot.result.authMethods : undefined).toEqual(authMethods);
  }, 15_000);

});

describe('生产接线：agent 配置改动审计落 sidecar 专档', () => {
  it('settings write 触发 added 审计摘要落 agent-config.jsonl（env 只记键名，值不落盘）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy', { DEVIN_API_KEY: 'sk-wiring-secret' });
    await registerAcpAgents(harness, [profile]);

 // 审计是 fire-and-forget 落盘（裁决：不阻断设置同步；agent-config
    // 走 sidecar 有界队列）：轮询公开读取面（list 内部先落齐队列）等专档行出现
    const sidecar = harness.loop.acpSidecar;
    expect(sidecar).toBeDefined();
    let entries = (await sidecar?.list(SessionId('agent-config'))) ?? [];
    const deadline = Date.now() + 5_000;
    while (entries.length === 0) {
      if (Date.now() > deadline) throw new Error('agent-config audit did not land in the sidecar within timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
      entries = (await sidecar?.list(SessionId('agent-config'))) ?? [];
    }
    // 密钥纪律：导出原文只含 env 键名级 diff，值永不落盘
    const raw = (await sidecar?.exportAudit({ sessionId: SessionId('agent-config'), format: 'jsonl' })) ?? '';
    expect(raw).toContain('"kind":"agent-config"');
    expect(raw).toContain('"change":"added"');
    expect(raw).toContain(`"agentId":"${profile.id}"`);
    expect(raw).toContain('DEVIN_API_KEY'); // 键名级 diff 在
    expect(raw).not.toContain('sk-wiring-secret'); // 值永不落盘
    // sidecar 公开读取面同样读得回（伪 sessionId 专档，binding 索引无感由 sidecar.spec 钉）
    expect(entries.map((entry) => entry.kind)).toEqual(['agent-config']);
  }, 15_000);
});

// ---------- 生产接线：会话创建门与运行时登录失效 ----------

/** initialize 即回 auth_required（ACP -32000）的 inline agent：建模「未登录」状态。 */
const AUTH_REQUIRED_AT_INIT_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim(); if (!t) return;
  const m = JSON.parse(t); if (m.id === undefined) return;
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth_required: login first' } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unreachable' } }) + '\\n');
  }
});`;

/** 握手正常、prompt 才回 auth_required 的 inline agent：建模「运行中凭据失效」。 */
const AUTH_REQUIRED_AT_PROMPT_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim(); if (!t) return;
  const m = JSON.parse(t); if (m.id === undefined) return;
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n');
  } else if (m.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } }) + '\\n');
  } else if (m.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth_required: token expired' } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');
  }
});`;

describe('生产接线：会话创建门与运行时登录失效', () => {
  it('ready 放行：新鲜 probe 缓存命中时门不重 probe（Native session 不 confine）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    // 先经 adapter 探测一次落缓存（ready 事实）
    await harness.loop.installedProfileRegistry.adapter.listModels(routeOf(profile));

    const handle = await createAcpAgent(harness, profile, SessionId('wiring-gate-ready'));
    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    // 门命中新鲜缓存；正式 Native session 与 probe 均不 confine。
  }, 15_000);

  it('auth_required probe（未登录）→ 门以 ACP_AUTH_REQUIRED 拒绝，消息带 loginHint，零 spawn', async () => {
    const harness = await boot();
    const profile = inlineProfile(harness.logDir, AUTH_REQUIRED_AT_INIT_SCRIPT, 'inline-cli auth login');
    await registerAcpAgents(harness, [profile]);

    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('wiring-gate-auth'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('auth_required');
    expect((error as AcpClientError).code).toBe('ACP_AUTH_REQUIRED');
    // external-login-only：指引到 agent 自家 CLI 的 loginHint
    expect((error as Error).message).toContain('inline-cli auth login');
    // 失败事实落缓存（health 行据此显示 auth-required）
    const snapshot = harness.loop.installedProfileRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind === 'error' ? snapshot.result.failureKind : undefined).toBe('auth_required');
    expect(fs.existsSync(profile.logPath)).toBe(false); // inline agent 无 MOCK_LOG；零会话 spawn
  }, 15_000);

  it('spawn-failure probe → 门以同 kind 拒绝（unavailable 语义带 probe 诊断），零 spawn', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    profile.config.command = 'dsh-acp-definitely-not-a-real-binary';
    await registerAcpAgents(harness, [profile]);

    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('wiring-gate-spawnfail'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('spawn-failure');
    expect((error as Error).message).toContain('is unavailable');
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

  it('运行时 auth_required（prompt 阶段凭据失效）→ turn 失败且 probe 缓存失效（下次过门重 probe）', async () => {
    const harness = await boot();
    const profile = inlineProfile(harness.logDir, AUTH_REQUIRED_AT_PROMPT_SCRIPT, 'inline-cli auth login');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-runtime-auth'));
    // 门已过：握手 ok，probe 缓存在场
    expect(harness.loop.installedProfileRegistry.adapter.probeSnapshot(routeOf(profile))?.result.kind).toBe('ok');

    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    const reason = eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason;
    expect(reason?.kind).toBe('error');
    expect(reason?.kind === 'error' ? reason.error.code : undefined).toBe('ACP_AUTH_REQUIRED');
    // agent.ts 的 turn catch：auth_required → invalidateProbeCache → 缓存清空
    expect(harness.loop.installedProfileRegistry.adapter.probeSnapshot(routeOf(profile))).toBeUndefined();
  }, 15_000);
});

// ---------- 边界：elicitation 标准交互 + 未知扩展免疫 ----------

describe('边界：elicitation/create form 交互 + 未知 _meta/扩展变体免疫', () => {
  it('elicitation/create → 显式 decline 应答；turn 完成并保留结构化 sidecar 审计', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'elicitation');
    const sessionId = SessionId('wiring-elicitation');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('hello'));
    const broker = (harness.loop as unknown as { acpPendingElicitations: { list(sessionId?: string): readonly { requestId: string }[]; answer(sessionId: string, answer: { requestId: string; action: 'decline' }): Promise<void> } }).acpPendingElicitations
    const deadline = Date.now() + 5_000
    while (broker.list(String(sessionId)).length === 0) {
      if (Date.now() > deadline) throw new Error('elicitation request was not surfaced')
      await sleep(5)
    }
    await broker.answer(String(sessionId), { requestId: broker.list(String(sessionId))[0]!.requestId, action: 'decline' })
    await agent.whenIdle();

    // decline 是协议内应答而非失败：turn 正常完成，mock 收到 decline 后继续文本输出
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    // mock 见证：client 应答恰为协议标准变体 {action:'decline'}
    expect(readLog(profile.logPath)).toContain('elicitation response {"action":"decline"}');
    // turn 文本照常聚合落盘（含 decline 后的续写）
    const texts = eventsOf(agent, 'assistant/message').flatMap((event) =>
      event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    );
    expect(texts).toContain('I need structured input. Elicitation answered with action=decline; continuing in plain text.');
    // sidecar requested/decided 审计均存在，且不记录用户值。
    let entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const auditDeadline = Date.now() + 5_000;
    while (!entries.some((entry) => entry.kind === 'elicitation')) {
      if (Date.now() > auditDeadline) throw new Error('elicitation audit was not persisted within timeout');
      await sleep(5);
      entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    }
    const audits = entries.filter((entry) => entry.kind === 'elicitation');
    expect(audits.map((entry) => entry.data.phase)).toEqual(['requested', 'decided']);
    expect(JSON.stringify(audits)).not.toContain('deployment target name');
  }, 15_000);  it('未知 _meta（session/new 响应 + 每条 update）与未知 sessionUpdate 变体：SDK 丢弃，turn 完成、文本照常落盘', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'unknown-meta');
    const sessionId = SessionId('wiring-unknown-meta');
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    const texts = eventsOf(handle.agent, 'assistant/message').flatMap((event) =>
      event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    );
    expect(texts).toContain('Hello, mock world.');
    // 未知变体不污染审计面：零 degradation（_meta 与 _future/thing 被 SDK 校验层静默丢弃）
    const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    expect(entries.filter((entry) => entry.kind === 'degradation')).toHaveLength(0);
  }, 15_000);
});

// ----------：codex-acp 1.6.2 事件形态 fixture（codex-shape scenario） ----------

describe('：codex 事件形态经 translate 投影——tool kind/locations、reasoning、plan 不降级；terminal/diff 降级现状钉死', () => {
  it('codex-shape turn：kind/locations/reasoning/plan/消息文本无损落盘；terminal 与 diff 各落恰一条 degradation 审计', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'codex-shape');
    const sessionId = SessionId('wiring-codex-shape');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('run a codex-shaped turn'));
    await agent.whenIdle();

    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });

 // tool/call： name 恒为稳定名（keyed toolview 分发）；kind 与
    // locations 摘要随 meta.acpToolCall 落盘（对账对称事实源），首帧 title
    // 同键落 meta，三个 codex 形态 kind（search/execute/edit）原样透传，无降级
    const calls = eventsOf(agent, 'tool/call');
    expect(calls.map((event) => String(event.data.callId))).toEqual([
      'codex-tool-search-1', 'codex-tool-exec-1', 'codex-tool-edit-1',
    ]);
    const callMeta = (index: number): { acpToolCall: { title?: string; kind?: string; locations?: { path: string }[] } } | undefined =>
      (calls[index]?.data as { meta?: { acpToolCall: { title?: string; kind?: string; locations?: { path: string }[] } } }).meta;
    for (const call of calls) expect(call.data.name).toBe('dsh_acp_external_tool');
    expect(callMeta(0)?.acpToolCall.title).toContain("Search for 'needle'");
    expect(callMeta(0)?.acpToolCall.kind).toBe('search');
    expect(callMeta(0)?.acpToolCall.locations?.map((loc) => loc.path)).toEqual([
      path.join(harness.logDir, 'src/a.ts'),
      path.join(harness.logDir, 'src/b.ts'),
    ]);
    expect(callMeta(1)?.acpToolCall.title).toBe('echo codex-shape');
    expect(callMeta(1)?.acpToolCall.kind).toBe('execute');
    expect(calls[1]?.data.arguments).toBe(JSON.stringify({ command: 'echo codex-shape', cwd: harness.logDir }));
    expect(callMeta(2)?.acpToolCall.title).toBe('Editing files');
    expect(callMeta(2)?.acpToolCall.kind).toBe('edit');

    // tool/result：search 无内容（空结果不降级）；execute 的 terminal 内容项 →
    // 占位（当前 UI 未提供 terminal 实时 seam）；edit 的 diff 内容项 → 摘要（完整 patch
    // 字节不入日志）——两种降级形态如实钉版
    const results = eventsOf(agent, 'tool/result');
    expect(results).toHaveLength(3);
 // tool/result 的 message.content 是 tool-result 块，文本在块内嵌套 content 里（同款形状）
    const resultTexts = results.map((event) =>
      event.data.message.content.flatMap((block) =>
        block.type === 'tool-result'
          ? block.content.flatMap((nested) => (nested.type === 'text' ? [nested.text] : []))
          : []));
    expect(resultTexts[0]).toEqual([]);
    expect(resultTexts[1]?.[0]).toContain('[terminal 占位] terminalId=codex-tool-exec-1');
    expect(resultTexts[2]?.[0]).toContain('[diff 摘要]');
    expect(resultTexts[2]?.[0]).toContain('notes.txt（修改）');
    // codex 的终端 stdout 走 _meta.terminal_output（未知 _meta 忽略）：输出字节不进日志
    expect(JSON.stringify(results.map((event) => event.data))).not.toContain('codex-shape\n');

    // reasoning/thought chunk 与 plan 全快照折叠均不降级：进 assistant/message 的
    // reasoning 块；最终答复文本原样（_meta.codex.phase 忽略）
    const messages = eventsOf(agent, 'assistant/message');
    const reasoning = messages.flatMap((event) =>
      event.data.message.content.flatMap((block) => (block.type === 'reasoning' ? [block.text] : [])));
    expect(reasoning).toContain('Reasoning about the codex request.');
    const planText = reasoning.find((text) => text.startsWith('Agent 计划：'));
    expect(planText).toContain('- [completed] Search for the needle');
    expect(planText).toContain('- [completed] Apply the edit');
    const texts = messages.flatMap((event) =>
      event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])));
    expect(texts).toContain('Done: applied the codex-shaped edit.');

    // sidecar：恰两条 degradation 审计（execute 的 terminal + edit 的 diff，
    // 每终态 tool_call_update 恰一条）；search/thought/plan/session_info_update
    // 均不产生降级（fire-and-forget 写，轮询等落盘）
    let entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const deadline = Date.now() + 5_000;
    while (entries.filter((entry) => entry.kind === 'degradation').length < 2) {
      if (Date.now() > deadline) throw new Error('codex-shape degradation audits were not persisted within timeout');
      await sleep(5);
      entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    }
    const degradations = entries.filter((entry) => entry.kind === 'degradation');
    expect(degradations).toHaveLength(2);
    const degradationByCallId = new Map(degradations.map((entry) => [entry.data.toolCallId, entry.data]));
    expect(degradationByCallId.get('codex-tool-exec-1')).toMatchObject({
      code: 'unsupported-tool-content',
      items: [{ type: 'terminal' }],
    });
    expect(degradationByCallId.get('codex-tool-edit-1')).toMatchObject({
      code: 'unsupported-tool-content',
      items: [{ type: 'diff' }],
    });
  }, 15_000);
});
