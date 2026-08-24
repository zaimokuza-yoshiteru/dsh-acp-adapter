// sdk-contract.spec.ts — ：用官方 @agentclientprotocol/sdk（1.3.0）的
// `client()` API + `ndJsonStream` 对脚本化 mock ACP server（test/mock-agent/）
// 跑 initialize → session/new → prompt → cancel 全生命周期契约自测，
// 并专项验证 SDK 对以下情况的实际行为：
//   1. 未知厂商通知（`_cognition.ai/mcp/serversChanged`、`_vendor/foo`）
//   2. stdout 混入非 JSON 行（garbage-stdout）
//   3. agent 中途崩溃（crash-mid-turn）
//
// 代码走读依据（research/acp-sdk/package/dist/ 快照）：
//   - jsonrpc.js processIncomingMessage：无 handler 的「通知」走完全部 handler 链后静默丢弃，
//     不抛错不断流；无 handler 的「请求」回 -32601 methodNotFound，同样不断流。
//   - stream.js ndJsonStream：单行 JSON.parse 失败仅 console.error('Failed to parse JSON message:', …)
//     后跳过该行，流继续。
//   - jsonrpc.js Connection.receive：对端 stdout EOF 后连接关闭，
//     挂起请求统一以 Error('ACP connection closed') 拒绝。
// 本文件用真实子进程 stdio 流量逐一断言上述行为，作为「SDK 可用、无需降级自实现 transport」的证据。
//
// 注：SDK 1.3.0 中 ClientSideConnection 已标记 @deprecated；本套件与
// src/protocol/v1/connection.ts 统一改用官方推荐的 client 新 API（handler 按方法名经
// onRequest/onNotification 注册，向外调用走 conn.agent.request/notify）。新旧 API
// 共用同一 Connection/jsonrpc 核心，本文件的容忍性断言因此直接钉住生产代码所用路径。
//
// spawn/终止改经共享的真实 subprocess-local 服务（terminate 树级升级 +
// waitForExit 整树证明）；env 由「全量继承 process.env」收敛为白名单 + tombstone
// （envSpecWithTombstones——本套件只消费 MOCK_LOG/MOCK_SCENARIO，收缩无影响）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import { envSpecWithTombstones } from '../../src/runtime/process/subprocess.ts';
import type { AcpSubprocessHandle, SubprocessSeam } from '../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../fixtures/subprocess-seam-testing.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', 'mock-agent', 'mock-agent.mjs');
const VENDOR_FIXTURE_PATH = path.join(TEST_DIR, '..', 'fixtures', 'unknown-notify-agent.mjs');

const INIT_PARAMS: acp.InitializeRequest = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: '@zaimokuza/dsh-acp-adapter-contract-test', version: '0.0.0' },
};
const NEW_SESSION_PARAMS: acp.NewSessionRequest = { cwd: '/mock/cwd', mcpServers: [] };
const PROMPT_BLOCKS: acp.ContentBlock[] = [{ type: 'text', text: 'Say hello to the mock world.' }];

// happy turn 的完整 session/update 序列：preamble 2 条（session/new 响应前）+ turn 内 8 条
const HAPPY_UPDATE_KINDS = [
  'config_option_update',
  'current_mode_update',
  'agent_thought_chunk',
  'agent_message_chunk',
  'agent_message_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await sleep(5);
  }
}

type AgentHandle = {
  child: AcpSubprocessHandle;
  conn: acp.ClientConnection;
  updates: acp.SessionNotification[];
  logPath: string;
  exited: Promise<{ code: number | null; signal: string | null }>;
};

let logDir = '';
let subprocess: SubprocessSeam;
let spawnSeq = 0;
const liveHandles = new Set<AgentHandle>();

function makeClientApp(updates: acp.SessionNotification[]): acp.ClientApp {
  return acp
    .client()
    // 本套件不覆盖 permission-flow；若意外收到权限请求，按规范回 cancelled 结局
    .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    });
}

// Node 的 toWeb 与 SDK 期望的 lib.dom 流类型在 BYOB reader 签名上有结构性出入，
// 仅在接缝处做一次显式收窄（运行时是同一套 Node web stream 实现）。
const toWebOut = (w: Writable) => Writable.toWeb(w) as unknown as WritableStream<Uint8Array>;
const toWebIn = (r: Readable) => Readable.toWeb(r) as unknown as ReadableStream<Uint8Array>;

// spawn 一个协议对端（mock 或 fixture），接好 SDK 连接；统一登记以便 teardown 梯子拆除
function spawnAgent(scriptPath: string, env: Record<string, string>): AgentHandle {
  const logPath = path.join(logDir, `${path.basename(scriptPath, '.mjs')}-${++spawnSeq}.log`);
  const child = subprocess.spawn({
    argv: [process.execPath, scriptPath],
    cwd: logDir,
    // 白名单语义（envSpecWithTombstones）：子进程所见恰为显式集合，不再有全量继承
    env: envSpecWithTombstones({ MOCK_LOG: logPath, ...env }, process.env),
    graceMs: 2_000,
  });
  const { stdin, stdout, stderr } = child;
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    child.terminate();
    throw new Error('sdk-contract spawn: subprocess service dropped a piped stream');
  }
  const exited = child.done.then((outcome) => ({ code: outcome.exitCode, signal: outcome.signal }));
  exited.catch(() => {}); // 兜底：teardown 之前无人 await 时不触发 unhandledRejection
  stderr.resume(); // 对端日志走 MOCK_LOG；stderr 仅兜底消费，防管道写满
  const updates: acp.SessionNotification[] = [];
  const stream = acp.ndJsonStream(toWebOut(stdin), toWebIn(stdout));
  const conn = makeClientApp(updates).connect(stream);
  const handle: AgentHandle = { child, conn, updates, logPath, exited };
  liveHandles.add(handle);
  return handle;
}

function spawnMock(scenario: string, env: Record<string, string> = {}): AgentHandle {
  return spawnAgent(MOCK_AGENT_PATH, { MOCK_SCENARIO: scenario, ...env });
}

// seam 终止动词：terminate()（SIGTERM → graceMs → SIGKILL 树级升级）+ waitForExit
// 整树退出证明，保证测试结束无孤儿进程（terminate 幂等：树已死 = no-op）
async function stopHandle(handle: AgentHandle): Promise<void> {
  const { child, conn, exited } = handle;
  child.terminate();
  await child.waitForExit();
  await exited.catch(() => {});
  // 子进程退出 → stdout EOF → SDK 连接应自行关闭；给 1s 上限防悬挂
  await Promise.race([conn.closed, sleep(1000)]);
}

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-contract-'));
 // 全部 spawn 走共享的真实 subprocess-local 服务
  subprocess = (await sharedTestSubprocess()).seam;
});

afterEach(async () => {
  for (const handle of [...liveHandles]) {
    await stopHandle(handle);
    liveHandles.delete(handle);
  }
});

afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

const updateKinds = (updates: acp.SessionNotification[]) => updates.map((u) => u.update.sessionUpdate);

function messageTexts(updates: acp.SessionNotification[]): string[] {
  return updates.flatMap((n) => {
    const u = n.update;
    if (u.sessionUpdate !== 'agent_message_chunk') return [];
    return [u.content.type === 'text' ? u.content.text : `<${u.content.type}>`];
  });
}

describe('happy scenario：全生命周期契约', () => {
  it('initialize → session/new → prompt，响应形状与 update 序列符合预期', async () => {
    const h = spawnMock('happy');

    const init = await h.conn.agent.request('initialize', INIT_PARAMS);
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(init.agentInfo?.name).toBe('dsh-mock-acp-agent');
    expect(init.authMethods).toEqual([]);

    const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);
    expect(session.sessionId).toBe('mock-session-1');
    expect(session.modes?.currentModeId).toBe('accept-edits');
    expect(session.modes?.availableModes.map((m) => m.id)).toEqual(['accept-edits', 'smart', 'ask', 'plan', 'bypass']);
    expect(session.configOptions?.map((o) => o.id)).toEqual(['mode', 'model']);

    const prompt = await h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
    expect(prompt.stopReason).toBe('end_turn');

    await waitFor(() => h.updates.length === HAPPY_UPDATE_KINDS.length);
    expect(updateKinds(h.updates)).toEqual(HAPPY_UPDATE_KINDS);

    // 同一 messageId 的 3 个 chunk 拼成完整消息
    expect(messageTexts(h.updates).join('')).toBe('Hello, mock world.');

    const thought = h.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'agent_thought_chunk');
    if (thought?.sessionUpdate !== 'agent_thought_chunk') throw new Error('missing agent_thought_chunk');
    expect(thought.content.type).toBe('text');
    if (thought.content.type === 'text') expect(thought.content.text).toBe('Thinking about the mock request.');

    const toolCall = h.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'tool_call');
    if (toolCall?.sessionUpdate !== 'tool_call') throw new Error('missing tool_call');
    expect(toolCall.toolCallId).toBe('mock-tool-1');
    expect(toolCall.kind).toBe('read');
    expect(toolCall.status).toBe('in_progress');
    expect(toolCall.locations?.[0]?.path).toBe('/mock/cwd/README.md');

    const toolUpdate = h.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'tool_call_update');
    if (toolUpdate?.sessionUpdate !== 'tool_call_update') throw new Error('missing tool_call_update');
    expect(toolUpdate.toolCallId).toBe('mock-tool-1');
    expect(toolUpdate.status).toBe('completed');

    const plan = h.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'plan');
    if (plan?.sessionUpdate !== 'plan') throw new Error('missing plan');
    expect(plan.entries.map((e) => e.content)).toEqual([
      'Inspect the request',
      'Produce a reply',
      'Report usage',
    ]);

    const usage = h.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'usage_update');
    if (usage?.sessionUpdate !== 'usage_update') throw new Error('missing usage_update');
    expect(usage.used).toBe(1234);
    expect(usage.size).toBe(1048576);
  });

  it('prompt turn 中途 cancel → stopReason=cancelled，mock 侧确认收到', async () => {
    // 50ms/步 的 update 间隔给 cancel 留足插入窗口
    const h = spawnMock('happy', { MOCK_STEP_DELAY_MS: '50' });
    await h.conn.agent.request('initialize', INIT_PARAMS);
    const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);

    const promptPromise = h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
    // preamble 2 条 + turn 第 1 条到达后发出取消
    await waitFor(() => h.updates.length >= 3);
    await h.conn.agent.notify('session/cancel', { sessionId: session.sessionId });

    const resp = await promptPromise;
    expect(resp.stopReason).toBe('cancelled');
    // turn 未跑完：update 总数少于完整序列
    expect(h.updates.length).toBeLessThan(HAPPY_UPDATE_KINDS.length);
    // mock 日志确认 cancel 落在活动 turn 上
    const log = fs.readFileSync(h.logPath, 'utf8');
    expect(log).toContain('session/cancel sessionId=mock-session-1 turnActive=true');
  });
});

describe('SDK 容忍性专项：未知厂商通知', () => {
  it('`_cognition.ai/mcp/serversChanged`（happy 内建，对齐 devin 实测流量）：不抛错、不断流、静默丢弃', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = spawnMock('happy');
      await h.conn.agent.request('initialize', INIT_PARAMS);

      // mock 的 session/new 处理顺序：先写 `_cognition.ai/mcp/serversChanged` 未知通知，
      // 再写 config_option_update / current_mode_update 两个 session/update，最后才回响应。
      // 若 SDK 在未知通知上抛错或断流，后续两个 update 与响应都不可能到达。
      const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);
      expect(session.sessionId).toBe('mock-session-1');
      await waitFor(() => h.updates.length >= 2);
      expect(updateKinds(h.updates).slice(0, 2)).toEqual(['config_option_update', 'current_mode_update']);

      // 连接在收到未知通知后仍完全可用：完整跑一个 prompt turn
      const resp = await h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
      expect(resp.stopReason).toBe('end_turn');

      // 未知通知被静默丢弃：无 parse 失败、无 handler 错误日志
      const logged = errSpy.mock.calls.map((c) => String(c[0]));
      expect(logged.filter((m) => m.includes('Failed to parse JSON message'))).toEqual([]);
      expect(logged.filter((m) => m.includes('Error handling notification'))).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('`_vendor/foo`（fixture agent，响应前 + turn 中途各一条）：不抛错、不断流', async () => {
    const h = spawnAgent(VENDOR_FIXTURE_PATH, {});
    const init = await h.conn.agent.request('initialize', INIT_PARAMS);
    expect(init.protocolVersion).toBe(1);

    // session/new 响应前的 `_vendor/foo` 不断流：响应正常到达
    const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);
    expect(session.sessionId).toBe('vendor-session-1');

    // turn 中途的 `_vendor/foo` 不影响 update 投递与 prompt 响应
    const resp = await h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
    expect(resp.stopReason).toBe('end_turn');
    await waitFor(() => h.updates.length === 1);
    expect(messageTexts(h.updates)).toEqual(['vendor-ok']);
  });
});

describe('其余 scenario 契约', () => {
  it('minimal-caps：最小能力握手正常，未声明的 session/load 回 -32601', async () => {
    const h = spawnMock('minimal-caps');

    const init = await h.conn.agent.request('initialize', INIT_PARAMS);
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(false);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false);

    const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);
    expect(session.sessionId).toBe('mock-session-1');
    expect(session.modes).toBeUndefined();
    expect(session.configOptions).toBeUndefined();

    const resp = await h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
    expect(resp.stopReason).toBe('end_turn');
    await waitFor(() => h.updates.length === 2);
    expect(messageTexts(h.updates)).toEqual(['Minimal reply.', ' Done.']);

    // 未声明的可选方法：SDK 把 -32601 透传为 RequestError
    const err: unknown = await h.conn.agent
      .request('session/load', { sessionId: 'mock-session-1', cwd: '/mock/cwd', mcpServers: [] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(acp.RequestError);
    expect((err as acp.RequestError).code).toBe(-32601);
  });

  it('crash-mid-turn：prompt 挂起请求被拒绝、连接关闭、进程 exit(1)，已流出的 chunk 不丢', async () => {
    const h = spawnMock('crash-mid-turn');
    await h.conn.agent.request('initialize', INIT_PARAMS);
    const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);

    const promptPromise = h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
    // 崩溃前两帧已写盘（mock 在第二帧写盘回调里 exit），客户端能收到 'Partial' + ' output'
    await waitFor(() => messageTexts(h.updates).length >= 2);

    // 进程 exit(1) → stdout EOF → SDK 关闭连接并拒绝挂起的 prompt
    await expect(promptPromise).rejects.toThrow(/closed/i);
    const { code } = await h.exited;
    expect(code).toBe(1);
    expect(h.conn.signal.aborted).toBe(true);
    expect(messageTexts(h.updates)).toEqual(['Partial', ' output']);
  });

  it('garbage-stdout：非 JSON 行被 console.error 记录后跳过，协议流不受影响', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = spawnMock('garbage-stdout');
      await h.conn.agent.request('initialize', INIT_PARAMS);
      const session = await h.conn.agent.request('session/new', NEW_SESSION_PARAMS);
      const resp = await h.conn.agent.request('session/prompt', { sessionId: session.sessionId, prompt: PROMPT_BLOCKS });
      expect(resp.stopReason).toBe('end_turn');
      await waitFor(() => h.updates.length === HAPPY_UPDATE_KINDS.length);
      expect(updateKinds(h.updates)).toEqual(HAPPY_UPDATE_KINDS);

      // 实际行为记录：ndJsonStream 对非 JSON 行仅 console.error('Failed to parse JSON message:', …)
      // 并跳过该行，不抛错、不断流（stream.js 逐行 try/catch）
      expect(errSpy).toHaveBeenCalledWith(
        'Failed to parse JSON message:',
        expect.stringContaining('intentionally not valid JSON'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
