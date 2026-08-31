// sdk-contract.spec.ts — 用官方 @agentclientprotocol/sdk 的 `client()` API +
// `ndJsonStream` 专项验证未知厂商通知（`_cognition.ai/mcp/serversChanged`、
// `_vendor/foo`）不会中断连接。完整生命周期与失败矩阵由生产
// AcpClientConnection 套件覆盖，这里不再重复。
//
// 代码走读依据（research/acp-sdk/package/dist/ 快照）：
//   - jsonrpc.js processIncomingMessage：无 handler 的「通知」走完全部 handler 链后静默丢弃，
//     不抛错不断流；无 handler 的「请求」回 -32601 methodNotFound，同样不断流。
// 本文件用真实子进程 stdio 流量钉住这一 SDK 兼容边界。
//
// 注：SDK 1.3.0 中 ClientSideConnection 已标记 @deprecated；本套件与
// src/protocol/v1/connection.ts 统一改用官方推荐的 client 新 API（handler 按方法名经
// onRequest/onNotification 注册，向外调用走 conn.agent.request/notify）。新旧 API
// 共用同一 Connection/jsonrpc 核心，本文件的容忍性断言因此直接钉住生产代码所用路径。
//
// spawn/终止改经共享的真实 subprocess-local 服务（terminate 树级升级 +
// waitForExit 整树证明）；env 由 DSH scrubbed parent 提供，测试仅追加显式 fixture 变量

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
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
    // The DSH subprocess service merges profile env into its scrubbed parent env.
    env: { MOCK_LOG: logPath, ...env },
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
