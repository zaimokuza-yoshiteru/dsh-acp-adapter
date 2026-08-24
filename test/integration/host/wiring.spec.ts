// wiring.spec.ts — 集成接线的随附测试（端到端：真 cordis 运行时 + mock ACP 子进程）。
//
// 覆盖关键生产接线：
//   1. spawn plan 三档（生产接线，agent.ts 懒启动）：
//      - workspace-write（默认档）→ confine policy {workspace-write, canonical(session cwd),
//        sessionId}；XDG/TMPDIR 经 spawnPlan 到达子进程（fs-probe envEcho 见证）
//      - read-only → confine policy workspaceRoot = canonical(dshHomePath('dsh-acp','state',<id>))，
//        stateRoot 实建且 XDG 指入其中（状态目录规则的 stateRoot 选址）
//      - danger-full-access → 不 confine + 一次性 warn + sidecar 落 permission-scope
// 分轴审计（/模式展示：full-access-spawn 事件与 spawn 标记位已删除）
//      - sandboxPolicy 缺席 → 回退 read-only fail-safe（confine root = stateRoot）+ 一次性 warn
//      - sandbox/subprocess/dshHomePath 缺席 → 门内 probe fail closed（错误进缓存），
// 创建门据此在 createAgent 即拒（sandbox-unavailable/spawn-failure/
//        protocol-error），零 spawn
// - read-only + devin descriptor 的 XDG 镜像 opaque ref → symlink 物化进 stateRoot（会话链路）
//   2. options-sync 每 turn 前同步（生产接线）：
//      - 无原生选择：每 turn 恰好一次 systemPrompt.assemble，turn 正常完成
// - agent/request 监听器改模型：原生路径不再重申模型（零 set_config_option），
//        turn 按 ACP 当前模型正常完成（分叉仅一次性 warn，coordinator 是唯一模型写入口）
//   3. commands 桥（生产接线）：session/new 响应前的 available_commands_update 经种子补种
//      注册进 agent 作用域 commands；handler 把 `/name args` 原文作为下一 turn prompt
//   4. permissions 桥（生产接线）：permission-flow + fake approval（allowed-once）→ mock 收到
//      allow_once；approval.request 收到 toolName/signal；sidecar 落 asked/decided 审计对
//      （requestId 配对）
// 5. dshAcp Remote service（生产接线，取代 webServer 旁路路由）：loop 构造即注册
//      cordis 服务 dshAcp；options 未启动 → null 快照 / 跑过 turn → 活体快照 / 无活体 throw；
//      health 行齐备（strict codec 边界由 health.spec.ts 直驱钉，此处钉组装层接线）
//   6. probe confine（生产接线，orchestrator 裁决 read-only 档）：listModels 经注册表组装的
//      confiner 触发 confined probe（policy workspaceRoot = canonical probeRoot，无 sessionId）；
// probeRoot 实建；authMethods 随缓存透传（缺口补齐）；
// devin descriptor 的 opaque ref 同档注入 probeRoot（probe 链路）
// 7. agent 配置改动审计：settings write → sidecar `agent-config.jsonl` 专档
//      （added 摘要，env 只记键名——值不落盘）
// 8. 会话创建门与运行时登录失效（生产接线）：ready 放行（缓存命中不重 probe）/
//      auth_required probe → ACP_AUTH_REQUIRED + loginHint/spawn-failure → 同 kind 拒绝/
//      prompt 阶段 auth_required → turn 失败且 probe 缓存失效
// 9. tool result fidelity（rich-content scenario）：非文本内容按占位/摘要落
//      session log（字节不落盘）+ tool/result meta 结构化事实 + sidecar 恰一条
//      degradation 审计
// 10. 边界：elicitation/create → 协议标准 decline 应答（一次性说明 + sidecar
//      degradation）；未知 _meta 与未知 sessionUpdate 变体被 SDK 丢弃、turn 完成
//  11.：codex-shape scenario（codex-acp 1.6.2 事件形态 fixture）——
//      kind=search/execute/edit 与 locations、reasoning chunk、plan 全快照经
//      translate 投影不降级；execute 的 terminal 内容项与 edit 的 diff 内容项
//      各落恰一条 sidecar degradation 审计（降级现状如实钉版）
//
// 组装层见 test/agent-test-helpers.ts。孤儿进程防线与 agent.spec 同款：argv 带
// SPEC_TAG，afterEach 兜底 dispose 全部 handle，afterAll `ps` 全量扫描。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import { ACP_ELICITATION_DECLINED_NOTE } from '../../../src/domain/session/resume.ts';
import { createDefaultSandboxPlatform } from '../../../src/domain/policy/platform/index.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
import { AcpRemoteService } from '../../../src/remote/service.ts';
import {
  FakeApproval,
  FakeCommands,
  SPEC_TAG,
  createHarness,
  eventsOf,
  inlineProfile,
  mockProfile,
  psLinesWithTag,
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
  const pidScan = psLinesWithTag(SPEC_TAG);
  expect(pidScan).toEqual([]);
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('生产接线：sandbox spawn 计划注入懒启动', () => {
  it('workspace-write（默认档）：confine 以 canonical 会话 cwd 为 root，XDG/TMPDIR 指入 per-session tmp', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'fs-probe');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-spawn-ww'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('probe the filesystem'));
    await agent.whenIdle();

 // 创建门：createAgent 前先补一次 confined probe（call[0]），会话 spawn 是 call[1]
    expect(harness.sandbox?.confineCalls).toHaveLength(2);
    expect(harness.sandbox?.confineCalls[0]?.policy.sessionId).toBeUndefined(); // 门内 probe（agentless）
    const call = harness.sandbox?.confineCalls[1];
    expect(call?.policy.mode).toBe('workspace-write');
    expect(call?.policy.workspaceRoot).toBe(fs.realpathSync(harness.logDir));
    expect(call?.policy.sessionId).toBe('wiring-spawn-ww');
    expect(call?.argv).toEqual([profile.config.command, ...profile.config.args]);
    // XDG 注入经 spawnPlan.env 整体替换到达子进程（workspace-write 档 = os.tmpdir 下 per-session 目录）
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.XDG_DATA_HOME).toContain('dsh-acp-');
    expect(echo.envEcho.TMPDIR).toContain('dsh-acp-');
  }, 15_000);

  it('read-only：confine 以 canonical stateRoot 为 root（裁决②选址 dshHome/dsh-acp/state/<id>），目录实建', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const profile = mockProfile(harness.logDir, 'fs-probe');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-spawn-ro'));
    const agent = handle.agent as AcpAgent;

    agent.followup(userText('probe the filesystem'));
    await agent.whenIdle();

    const stateRoot = fs.realpathSync(path.join(harness.dshHome, 'dsh-acp', 'state', profile.id));
 // 创建门：call[0] 是门内 probe（read-only 档 confine 到 probeRoot），会话 spawn 是 call[1]
    expect(harness.sandbox?.confineCalls).toHaveLength(2);
    const call = harness.sandbox?.confineCalls[1];
    expect(call?.policy.mode).toBe('workspace-write'); // 权限映射 重映射：read-only 以 stateRoot 为可写 root
    expect(call?.policy.workspaceRoot).toBe(stateRoot);
    const echo = fsProbeEcho(agent);
    expect(echo.envEcho.XDG_DATA_HOME).toBe(path.join(stateRoot, 'xdg-data'));
    expect(echo.envEcho.TMPDIR).toBe(path.join(stateRoot, 'tmp'));
  }, 15_000);

 it('read-only + devin descriptor 的 XDG 镜像 opaque ref：symlink 经 agent.ts 接线物化进 stateRoot（会话链路）', async () => {
    const harness = await boot({ sandboxMode: 'read-only' });
    const profile = mockProfile(harness.logDir, 'fs-probe');
 // 边界：auth refs 只按 descriptor 绑定命中（runtime 字段或 id 回退）——把 profile 挂到 devin id 上
    profile.id = 'devin';
    // agent.ts 走生产默认 os.homedir()（POSIX 下取 $HOME）：测试以 $HOME 注入假 home，结束即恢复
    const fakeHome = fs.mkdtempSync(path.join(suiteDir, 'home-'));
    fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'devin'), { recursive: true });
    const realCredential = path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml');
    fs.writeFileSync(realCredential, 'wiring-token');
    const realHome = process.env['HOME'];
    let handle: AgentHandle | undefined;
    process.env['HOME'] = fakeHome;
    try {
      handle = await createAcpAgent(harness, profile, SessionId('wiring-cred-mirror'));
      handle.agent.followup(userText('probe the filesystem'));
      await handle.agent.whenIdle();
    } finally {
      if (realHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = realHome;
    }

    expect(handle).toBeDefined();
    expect(eventsOf(handle?.agent as AcpAgent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    const stateRoot = fs.realpathSync(path.join(harness.dshHome, 'dsh-acp', 'state', profile.id));
    const link = path.join(stateRoot, 'xdg-data', 'devin', 'credentials.toml');
    // 零字节复制钉：落点是指向真实凭证的 symlink（无 0600 副本）
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(realCredential);
    expect(fs.readFileSync(link, 'utf8')).toBe('wiring-token');
  }, 15_000);

  it('danger-full-access：不 confine + 一次性 warn + permission-scope/agent-mode 分轴审计落条', async () => {
    const harness = await boot({ sandboxMode: 'danger-full-access' });
    const warns = captureWarns(harness);
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('wiring-spawn-danger');
    const handle = await createAcpAgent(harness, profile, sessionId);

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

 // 创建门：唯一一次 confine 是门内 probe（固定 read-only 档，agentless）；
    // 会话 spawn 本身在 danger 档零规则、不 confine
    expect(harness.sandbox?.confineCalls).toHaveLength(1);
    expect(harness.sandbox?.confineCalls[0]?.policy.sessionId).toBeUndefined();
    expect(harness.sandbox?.confineCalls[0]?.policy.workspaceRoot).toContain('probe');
    const notice = warns.filter((message) => message.includes('danger-full-access'));
    expect(notice).toHaveLength(1); // 一次性闩锁（每实例）
 // 分轴审计（权限与模式双轴展示）：权限范围轴落一条 permission-scope（未 confine 事实
    // 如实记录：confined null）；agent mode 轴落一条 agent-mode（session-setup 种子）
    const entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const scopes = entries.filter((entry) => entry.kind === 'permission-scope');
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.data).toEqual({ mode: 'danger-full-access', confined: null, platform: process.platform });
    const modes = entries.filter((entry) => entry.kind === 'agent-mode');
    expect(modes).toHaveLength(1);
    expect(modes[0]?.data).toEqual({ modeId: 'accept-edits', via: 'session-setup' });
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

  it('sandboxPolicy 缺席：回退 read-only fail-safe（confine root = stateRoot）+ 一次性 warn', async () => {
    const harness = await boot({ sandboxPolicy: false });
    const warns = captureWarns(harness);
    const profile = mockProfile(harness.logDir, 'happy');
    const handle = await createAcpAgent(harness, profile, SessionId('wiring-spawn-nopolicy'));

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    const stateRoot = fs.realpathSync(path.join(harness.dshHome, 'dsh-acp', 'state', profile.id));
 // 创建门：call[0] 是门内 probe，会话 spawn（回退档）是 call[1]
    expect(harness.sandbox?.confineCalls).toHaveLength(2);
    expect(harness.sandbox?.confineCalls[1]?.policy.workspaceRoot).toBe(stateRoot);
    expect(warns.filter((message) => message.includes('sandboxPolicy service'))).toHaveLength(1);
    // 回退档下 turn 照常完成
    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
  }, 15_000);

 it('sandbox 缺席：confined probe fail closed → 创建门以 sandbox-unavailable 拒绝 createAgent，零 spawn', async () => {
    const harness = await boot({ sandbox: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

 // sandbox 缺席使门内 probe 以 sandbox-unavailable 落缓存，创建门据此拒绝
    // （比旧行为更早失败：不再有「会话建起、turn 才报错」的窗口）
    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('wiring-spawn-nosandbox'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('sandbox-unavailable');
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind === 'error' ? snapshot.result.failureKind : undefined).toBe('sandbox-unavailable');
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

 it('subprocess 缺席：门内 probe fail closed（spawn-failure）→ 创建门拒绝 createAgent，零 spawn', async () => {
    const harness = await boot({ subprocess: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

 // seam 缺席时 probe 以 spawn-failure 进缓存，创建门以同 kind 拒绝
    // （旧行为的 turn 级 ACP_SPAWN_FAILURE 窗口随之消失——会话根本建不起来）
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
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    if (snapshot?.result.kind === 'error') expect(snapshot.result.failureKind).toBe('spawn-failure');
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

  it('dshHomePath 缺席：门内 probe 的 confiner 响亮失败（ACP_SPAWN_CONFIG → protocol-error）→ 创建门拒绝，零 spawn', async () => {
    const harness = await boot({ dshHomePath: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

 // 创建门先于 sidecar/binding 失败点触发——confiner 的 ACP_SPAWN_CONFIG
    // 经 probe 失败分类归 protocol-error 落缓存，门以 unavailable 语义拒绝
    const error: unknown = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('wiring-spawn-nodshhome'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
    }).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('protocol-error');
    expect((error as Error).message).toContain('dshHomePath slot is absent');
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind).toBe('error');
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
  it('loop 构造即注册 cordis 服务 dshAcp；options 未启动 → null 快照 / 跑过 turn → 活体快照；无活体 throw；health 行齐备', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    const sessionId = SessionId('wiring-health');
    const handle = await createAcpAgent(harness, profile, sessionId);

 // webServer 旁路路由删除；接线点是 cordis 服务注册（gateway 经 strict
    // descriptor 按名取实例）。ctx.get 返回 traceable proxy，方法调用落到同一实例。
    const remote = harness.ctx.get('dshAcp' as never) as unknown as AcpRemoteService;
    expect(remote).toBeInstanceOf(AcpRemoteService);

    // 未启动（零 turn）：活体已注册（publish 即入 agents），快照槽为 null；
 // capabilities 未握手归 null，sandbox 随接线透传本平台 enforcement 事实；
 // 未收到过 usage_update，contextUsage 诚实归 null
    const platform = createDefaultSandboxPlatform();
    expect(await remote.liveOptions(sessionId)).toEqual({
      sessionId,
      configOptions: null,
      currentModeId: null,
      capabilities: null,
      sandbox: {
        platform: platform.platformId,
        enforcement: platform.enforcementExpectation,
        note: platform.enforcementNote,
      },
 // 全新会话（无 ACP 史）连续性 ok，null 词表
      continuity: { status: 'ok', cause: null, detail: null },
      workspaceWrite: 'supported',
      contextUsage: null,
 // live 快照的固定四键
      freshness: 'live',
      editable: true,
      fingerprintChanged: false,
      modelSwitch: { status: 'idle' },
    });

    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

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

describe('生产接线：probe confine（read-only 档）+ authMethods 透传', () => {
 it('listModels 经注册表 confiner 触发 confined probe：workspaceRoot=disposable run 目录（边界：mkdtemp 于持久 probeBase 下，probe 结束必删）、无 sessionId；authMethods 随缓存透传', async () => {
    const harness = await boot();
    const authMethods = [{ id: 'oauth', name: 'OAuth login' }];
    const profile = mockProfile(harness.logDir, 'happy', { MOCK_AUTH_METHODS: JSON.stringify(authMethods) });
    await registerAcpAgents(harness, [profile]);

    const models = await harness.loop.acpRegistry.adapter.listModels(routeOf(profile));
    expect(models.map((model) => model.id)).toEqual(['mock-model-a', 'mock-model-b', 'mock-model-c']);

    // probe 同档 confine（read-only → 以 disposable run 目录为唯一可写 root；agentless → 无 sessionId）
    expect(harness.sandbox?.confineCalls).toHaveLength(1);
    const call = harness.sandbox?.confineCalls[0];
    const probeBase = fs.realpathSync(path.join(harness.dshHome, 'dsh-acp', 'probe', profile.id));
    const runRoot = call?.policy.workspaceRoot;
    expect(call?.policy.mode).toBe('workspace-write');
    expect(runRoot).toMatch(/[/\\]run-[^/\\]+$/);
    expect(runRoot?.startsWith(probeBase + path.sep)).toBe(true);
    expect(call?.policy.sessionId).toBeUndefined();
 // disposable：probe 结束（finally cleanup）run 目录必删，probeBase 复空
    expect(runRoot === undefined ? true : fs.existsSync(runRoot)).toBe(false);
    expect(fs.readdirSync(probeBase)).toEqual([]);

 // authMethods 自 缺口补齐后随缓存保留（health 端点透传面）
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind).toBe('ok');
    expect(snapshot?.result.kind === 'ok' ? snapshot.result.authMethods : undefined).toEqual(authMethods);
  }, 15_000);

 it('崩溃残留清扫（边界）：probe 前遗留的旧 run 目录被整棵移除，当前发布 run 目录结束后同样删除', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

    // 预造一个「上次 probe 崩溃残留」的 run 目录（含 marker 文件）
    const probeBase = path.join(harness.dshHome, 'dsh-acp', 'probe', profile.id);
    const stale = path.join(probeBase, 'run-staleold');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'marker'), 'x');

    await harness.loop.acpRegistry.adapter.listModels(routeOf(profile));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(fs.realpathSync(probeBase))).toEqual([]);
  }, 15_000);

 it('devin descriptor 的 XDG 镜像 opaque ref 同档注入 probe：slow-response 窗口内 symlink 物化进 disposable run 目录，probe 结束整删（data home 代际 probe 链路）', async () => {
    const harness = await boot();
    // slow-response：initialize 延迟 1500ms，给「probe 进行中」一个确定性观测窗口
    const profile = mockProfile(harness.logDir, 'slow-response', { MOCK_SLOW_INIT_MS: '1500' });
 // 边界：descriptor 按 id 回退绑定——挂到 devin id
    profile.id = 'devin';
    // confiner 走生产默认 os.homedir()（POSIX 下取 $HOME）：测试以 $HOME 注入假 home，结束即恢复
    const fakeHome = fs.mkdtempSync(path.join(suiteDir, 'home-'));
    fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'devin'), { recursive: true });
    const realCredential = path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml');
    fs.writeFileSync(realCredential, 'probe-token');
    const realHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    let observed: { link: string; target: string; content: string } | undefined;
    let runRoot: string | undefined;
    try {
      await registerAcpAgents(harness, [profile]);
      const pending = harness.loop.acpRegistry.adapter.listModels(routeOf(profile));
      // 轮询窗口：symlink 在 spawn 前由 confiner 物化，init 延迟期内必然可见
      const probeBase = path.join(harness.dshHome, 'dsh-acp', 'probe', 'devin');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && observed === undefined) {
        for (const entry of fs.existsSync(probeBase) ? fs.readdirSync(probeBase) : []) {
          const link = path.join(probeBase, entry, 'xdg-data', 'devin', 'credentials.toml');
          if (fs.existsSync(link)) {
            observed = { link, target: fs.readlinkSync(link), content: fs.readFileSync(link, 'utf8') };
            runRoot = path.join(probeBase, entry);
            break;
          }
        }
        if (observed === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const models = await pending;
      expect(models.length).toBeGreaterThan(0); // probe 正常完成（symlink 不破坏既有链路）
    } finally {
      if (realHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = realHome;
    }
    expect(observed).toBeDefined();
    expect(observed?.target).toBe(realCredential);
    expect(observed?.content).toBe('probe-token');
 // disposable：probe 结束后 run 目录（连同 symlink）整棵删除
    expect(runRoot === undefined ? true : fs.existsSync(runRoot)).toBe(false);
  }, 15_000);

  it('dshHomePath 缺席：confiner 响亮失败（ACP_SPAWN_CONFIG）进 probe 缓存', async () => {
    const harness = await boot({ dshHomePath: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

    await expect(harness.loop.acpRegistry.adapter.listModels(routeOf(profile))).rejects.toThrow('dshHomePath slot is absent');
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind).toBe('error');
    // 失败即缓存：进程未 spawn（MOCK_LOG 不存在）
    expect(fs.existsSync(profile.logPath)).toBe(false);
  }, 15_000);

  it('sandbox 缺席：probe fail closed（sandbox-unavailable）进缓存，零 spawn', async () => {
    const harness = await boot({ sandbox: false });
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

    await expect(harness.loop.acpRegistry.adapter.listModels(routeOf(profile))).rejects.toThrow(/no sandbox capability|confine refused/);
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
    expect(snapshot?.result.kind === 'error' ? snapshot.result.failureKind : undefined).toBe('sandbox-unavailable');
    expect(fs.existsSync(profile.logPath)).toBe(false);
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
  it('ready 放行：新鲜 probe 缓存命中时门不重 probe（confine 计数只多会话一次）', async () => {
    const harness = await boot();
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);
    // 先经 adapter 探测一次落缓存（ready 事实）
    await harness.loop.acpRegistry.adapter.listModels(routeOf(profile));
    expect(harness.sandbox?.confineCalls).toHaveLength(1); // probe

    const handle = await createAcpAgent(harness, profile, SessionId('wiring-gate-ready'));
    handle.agent.followup(userText('hello'));
    await handle.agent.whenIdle();

    expect(eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    // 门命中新鲜缓存 → 只多一次会话 confine，无第二次 probe
    expect(harness.sandbox?.confineCalls).toHaveLength(2);
    expect(harness.sandbox?.confineCalls[1]?.policy.sessionId).toBe('wiring-gate-ready');
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
    const snapshot = harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile));
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
    expect(harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile))?.result.kind).toBe('ok');

    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    const reason = eventsOf(handle.agent, 'turn/end').at(-1)?.data.reason;
    expect(reason?.kind).toBe('error');
    expect(reason?.kind === 'error' ? reason.error.code : undefined).toBe('ACP_AUTH_REQUIRED');
    // agent.ts 的 turn catch：auth_required → invalidateProbeCache → 缓存清空
    expect(harness.loop.acpRegistry.adapter.probeSnapshot(routeOf(profile))).toBeUndefined();
  }, 15_000);
});

// ---------- 边界：elicitation 标准能力降级 + 未知扩展免疫 ----------

describe('边界：elicitation/create 协议标准 decline + 未知 _meta/扩展变体免疫', () => {
  it('elicitation/create → decline 应答；turn 完成，一次性用户说明 + sidecar degradation 审计', async () => {
    const harness = await boot();
    const warns = captureWarns(harness);
    const profile = mockProfile(harness.logDir, 'elicitation');
    const sessionId = SessionId('wiring-elicitation');
    const handle = await createAcpAgent(harness, profile, sessionId);
    const agent = handle.agent;

    agent.followup(userText('hello'));
    await agent.whenIdle();

    // decline 是协议内应答而非失败：turn 正常完成，mock 收到 decline 后继续文本输出
    expect(eventsOf(agent, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' });
    // mock 见证：client 应答恰为协议标准变体 {action:'decline'}
    expect(readLog(profile.logPath)).toContain('elicitation response {"action":"decline"}');
    // 会话日志：一次性用户可见说明（闩锁：恰一条，即使 agent 反复请求）；
    // turn 文本照常聚合落盘（含 decline 后的续写）
    const texts = eventsOf(agent, 'assistant/message').flatMap((event) =>
      event.data.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    );
    expect(texts.filter((text) => text === ACP_ELICITATION_DECLINED_NOTE)).toHaveLength(1);
    expect(texts).toContain('I need structured input. Elicitation answered with action=decline; continuing in plain text.');
    // sidecar degradation 审计恰一条（fire-and-forget 写，轮询等落盘）
    let entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    const deadline = Date.now() + 5_000;
    while (!entries.some((entry) => entry.kind === 'degradation')) {
      if (Date.now() > deadline) throw new Error('elicitation degradation audit was not persisted within timeout');
      await sleep(5);
      entries = (await harness.loop.acpSidecar?.list(sessionId)) ?? [];
    }
    const degradations = entries.filter((entry) => entry.kind === 'degradation');
    expect(degradations.map((entry) => entry.data.code)).toEqual(['elicitation-declined']);
    expect(warns.some((message) => message.includes('declined an elicitation/create request'))).toBe(true);
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
    // 占位（DSH 未广告 terminal 能力）；edit 的 diff 内容项 → 摘要（完整 patch
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
