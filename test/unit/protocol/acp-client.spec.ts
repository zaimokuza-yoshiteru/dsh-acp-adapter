// acp-client.spec.ts — 随附测试：AcpClientConnection 对 mock ACP agent 全 scenario 矩阵。
//
// 覆盖：
//   - 握手：happy / minimal-caps / no-config-options（initialize 幂等、能力记录）
//   - typed 方法面：newSession / loadSession / listSessions / setConfigOption / setMode /
//     prompt / cancel / authenticate（间接）/ close
//   - prompt 的 session/update 回调流；permission 默认 fail closed 与自定义 handler
//   - 错误分类：timeout（slow-response）、crash（crash-mid-turn，exit code+signal 且已流
//     chunk 不丢）、spawn-failure（ENOENT）、auth_required（-32000，内联 agent）、
//     protocol-error（-32601）、garbage-stdout 按 SDK 实测跳行
//   - 拆除梯子：EOF 不退 → SIGTERM（devin 口径）；eof-exit 对照纯 EOF；SIGTERM 不退 →
//     SIGKILL；重复 close 幂等；close 后调用被拒
// - ：never-resolve 矩阵（每个 RPC 在预算内 timeout → connection poison →
//     拒绝复用 → 后台拆除无孤儿）；abort 矩阵（在飞中止 = aborted/user-rejected +
//     poison；进场前已中止不 poison）；prompt 正常 cancel 不 poison；预算常量钉版
//   - stderr 环形缓冲（行数/字节上限）与默认/自定义脱敏
//   - probe：configOptions 收集、临时 cwd、超时/spawn-failure 分类、拆除无残留；
//     权限分离钉（probe 全程只发 initialize/session/new，绝不触发 authenticate）
//
// 孤儿进程防线：本文件所有 spawn 的 argv 都带 SPEC_TAG（含本 worker pid），
// afterEach 兜底 close 全部连接，afterAll 逐 pid 断言已死 + `ps` 全量扫描 SPEC_TAG。
// 内联 node -e agent 的脚本体内嵌 SPEC_TAG 注释，同样可被 ps 扫描命中。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import { AcpClientConnection, DEFAULT_INITIALIZE_TIMEOUT_MS, DEFAULT_SESSION_SETUP_TIMEOUT_MS, DEFAULT_SESSION_WRITE_TIMEOUT_MS } from '../../../src/protocol/v1/connection.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
import type { AcpConnectionOptions } from '../../../src/protocol/v1/types.ts';
import type { AcpConnectionSpec } from '../../../src/runtime/process/types.ts';
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';
import { createAcpTerminalHandlers } from '../../../src/runtime/client-capabilities/terminal.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs');
const SPEC_TAG = `--dsh-acp-client-spec-${process.pid}`;

const PROMPT_BLOCKS: acp.ContentBlock[] = [{ type: 'text', text: 'Say hello to the mock world.' }];

// happy turn 的 8 条 turn 内 update（preamble 2 条在 session/new 响应前，不经 prompt 回调）
const HAPPY_TURN_KINDS = [
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

async function expectReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected promise to reject, but it resolved');
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

let logDir = '';
let subprocess: SubprocessSeam;
let spawnSeq = 0;
const liveConns = new Set<AcpClientConnection>();
const spawnedPids = new Set<number>();

function track(conn: AcpClientConnection): AcpClientConnection {
  liveConns.add(conn);
  if (conn.pid !== undefined) spawnedPids.add(conn.pid);
  return conn;
}

interface MockHandle {
  conn: AcpClientConnection;
  logPath: string;
}

// spawn mock agent：env 全权由 spec 携带（本模块不做环境继承），argv 带 SPEC_TAG 供 ps 断言
function connectMock(scenario: string, opts: { env?: Record<string, string>; conn?: AcpConnectionOptions } = {}): MockHandle {
  const seq = ++spawnSeq;
  const logPath = path.join(logDir, `mock-${String(seq)}.log`);
  const conn = track(
    new AcpClientConnection(
      {
        argv: [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-m${String(seq)}`],
        cwd: logDir,
        env: { MOCK_SCENARIO: scenario, MOCK_LOG: logPath, ...opts.env },
        subprocess,
      },
      { eofGraceMs: 150, termGraceMs: 500, ...opts.conn },
    ),
  );
  return { conn, logPath };
}

// spawn 内联 node -e agent（脚本内嵌 SPEC_TAG 注释），用于 mock 覆盖不到的场景
function connectInline(script: string, opts: AcpConnectionOptions = {}): AcpClientConnection {
  return track(
    new AcpClientConnection(
      { argv: [process.execPath, '-e', script], cwd: logDir, env: {}, subprocess },
      { eofGraceMs: 120, termGraceMs: 400, ...opts },
    ),
  );
}

// initialize 一律回 -32000 auth_required
const AUTH_REFUSING_AGENT = `
// ${SPEC_TAG}-inline-auth
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

// 不吃 stdin EOF、忽略 SIGTERM：逼出 SIGKILL 级
const SIGTERM_IGNORING_AGENT = `
// ${SPEC_TAG}-inline-stubborn
process.on('SIGTERM', () => { process.stderr.write('ignored SIGTERM\\n'); });
process.stderr.write('stubborn ready\\n');
setInterval(() => {}, 1 << 30);
`;

const STDERR_SECRETS_AGENT = `
// ${SPEC_TAG}-inline-stderr
process.stderr.write('boot api_key="sk-proj-abcdef1234567890abcdef" done\\n');
process.stderr.write('Authorization: Bearer abcdef1234567890abcdef\\n');
process.stderr.write('token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c\\n');
process.stderr.write('plain line stays\\n');
setInterval(() => {}, 1 << 30);
`;

const STDERR_SPAM_AGENT = `
// ${SPEC_TAG}-inline-spam
for (let i = 0; i < 50; i++) process.stderr.write('spam-' + String(i).padStart(2, '0') + '\\n');
setInterval(() => {}, 1 << 30);
`;

// 钉版用：stderr 先写一行 token 形秘密，initialize 应答后立即 exit(1)——
// 逼 newSession 走 crash 分类（crashMessage 内嵌 stderr 尾部的路径）。
const STDERR_THEN_CRASH_AGENT = `
// ${SPEC_TAG}-inline-stderr-crash
process.stderr.write('boot api_key="sk-proj-abcdef1234567890abcdef" done\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} }, authMethods: [], agentInfo: { name: 'crashy', title: null, version: '0.0.0' } } }) + '\\n');
      setTimeout(() => { process.exit(1); }, 20);
    }
    // 其余方法（session/new 等）故意不应答：挂起到进程退出，逼出 crash 分类
  }
});
`;

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-client-spec-'));
 // 全部 spawn 走共享的真实 subprocess-local 服务（模块级单例，文件级一次性 dispose）
  subprocess = (await sharedTestSubprocess()).seam;
});

afterEach(async () => {
  // 兜底拆除：测试自身已 close 的连接靠幂等快速返回
  for (const conn of [...liveConns]) {
    await conn.close().catch(() => {});
    liveConns.delete(conn);
  }
});

afterAll(async () => {
  for (const pid of spawnedPids) {
    await waitFor(() => isDead(pid), 3000).catch(() => {});
  }
  expect([...spawnedPids].filter((pid) => !isDead(pid))).toEqual([]);
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('握手（happy / minimal-caps / no-config-options）', () => {
  it('terminal capability is advertised and dispatches all five methods through the real JSON-RPC connection', async () => {
    const command = JSON.stringify(process.execPath)
    const normalScript = JSON.stringify("process.stdout.write('normal-out');process.stderr.write('normal-err')")
    const longScript = JSON.stringify('setInterval(() => {}, 1000)')
    const script = `let b='';let sid='terminal-session';let normalId='';let killedId='';const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize'){process.stderr.write(JSON.stringify(m.params.clientCapabilities)+'\\n');send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'terminal-agent',version:'1'},agentCapabilities:{}}})}else if(m.method==='session/new'){send({jsonrpc:'2.0',id:m.id,result:{sessionId:sid}});setTimeout(()=>send({jsonrpc:'2.0',id:10,method:'terminal/create',params:{sessionId:sid,command:${command},args:['-e',${normalScript}],outputByteLimit:128}}),5)}else if(m.id===10&&!m.error){normalId=m.result.terminalId;send({jsonrpc:'2.0',id:11,method:'terminal/output',params:{sessionId:'wrong-session',terminalId:normalId}})}else if(m.id===11){if(!m.error)throw new Error('terminal ownership request unexpectedly succeeded');process.stderr.write('terminal-ownership-rejected\\n');send({jsonrpc:'2.0',id:12,method:'terminal/output',params:{sessionId:sid,terminalId:normalId}})}else if(m.id===12){send({jsonrpc:'2.0',id:13,method:'terminal/wait_for_exit',params:{sessionId:sid,terminalId:normalId}})}else if(m.id===13){send({jsonrpc:'2.0',id:14,method:'terminal/release',params:{sessionId:sid,terminalId:normalId}})}else if(m.id===14){send({jsonrpc:'2.0',id:15,method:'terminal/create',params:{sessionId:sid,command:${command},args:['-e',${longScript}],outputByteLimit:128}})}else if(m.id===15&&!m.error){killedId=m.result.terminalId;send({jsonrpc:'2.0',id:16,method:'terminal/kill',params:{sessionId:sid,terminalId:killedId}})}else if(m.id===16){send({jsonrpc:'2.0',id:17,method:'terminal/wait_for_exit',params:{sessionId:sid,terminalId:killedId}})}else if(m.id===17){send({jsonrpc:'2.0',id:18,method:'terminal/output',params:{sessionId:sid,terminalId:killedId}})}else if(m.id===18){send({jsonrpc:'2.0',id:19,method:'terminal/release',params:{sessionId:sid,terminalId:killedId}})}else if(m.id===19){process.stderr.write('terminal-cycle-complete\\n')}}});setInterval(()=>{},1<<30);`
    const terminals = createAcpTerminalHandlers({ subprocess, profileId: 'terminal-profile', dshSessionId: 'dsh-terminal', cwd: logDir, env: {} })
    const conn = connectInline(script, { terminalHandlers: terminals })
    await conn.initialize()
    await conn.newSession()
    await waitFor(() => conn.stderrLines().some((line) => line.includes('"terminal":true')))
    await waitFor(() => conn.stderrLines().some((line) => line.includes('terminal-ownership-rejected')))
    await waitFor(() => conn.stderrLines().some((line) => line.includes('terminal-cycle-complete')))
    expect(conn.stderrLines().join('\n')).toContain('"terminal":true')
    await conn.close()
  }, 10_000)

  it('fs handlers are advertised together and dispatch real ACP file requests', async () => {
    const file = path.join(logDir, 'fs-dispatch.txt'); fs.writeFileSync(file, 'native-fs')
    const script = `let b='';let sid='fs-session';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize'){process.stderr.write(JSON.stringify(m.params.clientCapabilities)+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fs-agent',version:'1'},agentCapabilities:{}}})+'\\n')}else if(m.method==='session/new'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:sid}})+'\\n');setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'fs/read_text_file',params:{sessionId:sid,path:${JSON.stringify(file)}}})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:100,method:'fs/read_text_file',params:{sessionId:'not-owned',path:${JSON.stringify(file)}}})+'\\n')},5)}else if(m.id===99||m.id===100){process.stderr.write(JSON.stringify(m)+'\\n')}}});setInterval(()=>{},1<<30);`
    const conn = connectInline(script, { fileSystemHandlers: {
      readTextFile: async (params) => ({ content: fs.readFileSync(params.path, 'utf8') }),
      writeTextFile: async () => ({}),
    } })
    await conn.initialize(); expect(conn.agentInfo?.name).toBe('fs-agent'); await conn.newSession()
    await waitFor(() => conn.stderrLines().some((line) => line.includes('native-fs')), 2000)
    expect(conn.stderrLines().some((line) => line.includes('"readTextFile":true') && line.includes('"writeTextFile":true'))).toBe(true)
    await waitFor(() => conn.stderrLines().some((line) => line.includes('not-owned') || line.includes('owned by this connection')), 2000)
    expect(conn.stderrLines().some((line) => line.includes('"error"') && line.includes('not-owned'))).toBe(true)
    await conn.close(); fs.rmSync(file, { force: true })
  }, 10_000)

  it('reconnect creates a fresh FS lifecycle lease after the previous connection closes', async () => {
    const file = path.join(logDir, 'fs-reconnect.txt'); fs.writeFileSync(file, 'reconnected')
    const script = `let b='';let sid='reconnect-session';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fs-reconnect',version:'1'},agentCapabilities:{}}})+'\\n')}else if(m.method==='session/new'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:sid}})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'fs/read_text_file',params:{sessionId:sid,path:${JSON.stringify(file)}}})+'\\n'),5)}else if(m.id===99){process.stderr.write(JSON.stringify(m)+'\\n')}}});setInterval(()=>{},1<<30);`
    const handlers = () => ({
      readTextFile: async (params: { path: string }) => ({ content: fs.readFileSync(params.path, 'utf8') }),
      writeTextFile: async () => ({}),
    })
    const first = connectInline(script, { fileSystemHandlers: handlers() })
    await first.initialize(); await first.newSession(); await first.close()
    const second = connectInline(script, { fileSystemHandlers: handlers() })
    await second.initialize(); await second.newSession()
    await waitFor(() => second.stderrLines().some((line) => line.includes('reconnected')))
    expect(second.stderrLines().some((line) => line.includes('"content":"reconnected"'))).toBe(true)
    await second.close(); fs.rmSync(file, { force: true })
  }, 10_000)
  it('仅在接线 elicitation handler 时广告 form/url 能力', async () => {
    const script = `let b=''; process.stdin.on('data', d => { b += d; let i; while ((i=b.indexOf('\\n')) >= 0) { const line=b.slice(0,i); b=b.slice(i+1); if (!line.trim()) continue; const m=JSON.parse(line); if (m.method === 'initialize') { process.stderr.write(JSON.stringify(m.params.clientCapabilities)+'\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'cap-test',version:'1'},agentCapabilities:{}}})+'\\n'); } } }); setInterval(()=>{}, 1<<30);`
    const withHandler = connectInline(script, { onElicitationRequest: () => ({ action: 'cancel' }) })
    await withHandler.initialize()
    expect(withHandler.stderrLines().join('')).toContain('elicitation')
    await withHandler.close()
    const withoutHandler = connectInline(script)
    await withoutHandler.initialize()
    expect(withoutHandler.stderrLines().join('')).not.toContain('elicitation')
    await withoutHandler.close()
  }, 10_000)

  it('elicitation/create 的 sessionId 必须属于当前连接；wrong-session fail closed', async () => {
    const script = `let b=''; process.stdin.on('data', d => { b += d; let i; while ((i=b.indexOf('\\n')) >= 0) { const line=b.slice(0,i); b=b.slice(i+1); if (!line.trim()) continue; const m=JSON.parse(line); if (m.method === 'initialize') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'elicitation-owner',version:'1'},agentCapabilities:{}}})+'\\n'); } else if (m.method === 'session/new') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'owned-session'}})+'\\n'); setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'elicitation/create',params:{sessionId:'other-session',elicitationId:'wrong-1',message:'wrong owner',mode:'url',url:'https://example.com/continue'}})+'\\n'), 5); } else if (m.id === 99) process.stderr.write(JSON.stringify(m)+'\\n'); } }); setInterval(()=>{}, 1<<30);`
    const handler = vi.fn(() => ({ action: 'accept' as const, content: {} }))
    const conn = connectInline(script, { onElicitationRequest: handler })
    await conn.initialize()
    await conn.newSession()
    await waitFor(() => conn.stderrLines().some((line) => line.includes('"action":"decline"')), 2_000)
    expect(handler).not.toHaveBeenCalled()
    await conn.close()
  }, 10_000)
  it('happy：initialize 记录 agentInfo/capabilities/authMethods，重复调用幂等', async () => {
    const { conn } = connectMock('happy');
    const init = await conn.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(conn.agentInfo?.name).toBe('dsh-mock-acp-agent');
    expect(conn.agentCapabilities?.loadSession).toBe(true);
    expect(conn.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(conn.authMethods).toEqual([]);
    await expect(conn.initialize()).resolves.toBe(init);
  });

  it('happy：newSession 返回 modes + configOptions', async () => {
    const { conn } = connectMock('happy');
    await conn.initialize();
    const session = await conn.newSession();
    expect(session.sessionId).toBe('mock-session-1');
    expect(session.modes?.availableModes.map((m) => m.id)).toEqual(['accept-edits', 'smart', 'ask', 'plan', 'bypass']);
    expect(session.configOptions?.map((o) => o.id)).toEqual(['mode', 'model']);
  });

  it('minimal-caps：最小能力握手正常；未声明的 loadSession 分类为 protocol-error，连接仍可用', async () => {
    const { conn } = connectMock('minimal-caps');
    const init = await conn.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(false);
    const session = await conn.newSession();
    expect(session.modes).toBeUndefined();
    expect(session.configOptions).toBeUndefined();

    const err = await expectReject(conn.loadSession('mock-session-1'));
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('protocol-error');
    expect(acpErr.message).toContain('-32601');

    const resp = await conn.prompt(session.sessionId, PROMPT_BLOCKS);
    expect(resp.stopReason).toBe('end_turn');
  });

  it('no-config-options：握手正常，session/new 无 configOptions（有 modes）', async () => {
    const { conn } = connectMock('no-config-options');
    await conn.initialize();
    const session = await conn.newSession();
    expect(session.modes?.currentModeId).toBe('accept-edits');
    expect(session.configOptions).toBeUndefined();
  });
});

describe('prompt 流与 typed 方法', () => {
  it('happy：prompt 经 onUpdate 回调流出完整 turn 序列，stopReason=end_turn', async () => {
    const { conn } = connectMock('happy');
    await conn.initialize();
    const session = await conn.newSession();
    const updates: acp.SessionNotification[] = [];
    const resp = await conn.prompt(session.sessionId, PROMPT_BLOCKS, (n) => updates.push(n));
    expect(resp.stopReason).toBe('end_turn');
    // 通知分发可能略滞后于响应，先等齐再断言顺序
    await waitFor(() => updates.length === HAPPY_TURN_KINDS.length);
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(HAPPY_TURN_KINDS);
    const texts = updates.flatMap((n) => {
      const u = n.update;
      return u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : [];
    });
    expect(texts.join('')).toBe('Hello, mock world.');
  });

  it('happy：setConfigOption / setMode / listSessions / loadSession typed 方法', async () => {
    const all: acp.SessionNotification[] = [];
    const { conn } = connectMock('happy', { conn: { onSessionUpdate: (n) => all.push(n) } });
    await conn.initialize();
    const session = await conn.newSession();
    // 响应前的 preamble 推送（config_option_update + current_mode_update，对齐 devin 实测）
    await waitFor(() => all.length >= 2);
    expect(all.slice(0, 2).map((n) => n.update.sessionUpdate)).toEqual(['config_option_update', 'current_mode_update']);

    const setResp = await conn.setConfigOption(session.sessionId, 'model', 'mock-model-b');
    expect(setResp.configOptions.find((o) => o.id === 'model')?.currentValue).toBe('mock-model-b');

    await conn.setMode(session.sessionId, 'plan');
    await waitFor(() => all.some((n) => n.update.sessionUpdate === 'current_mode_update' && n.update.currentModeId === 'plan'));

    const list = await conn.listSessions({ cwd: logDir });
    expect(list.sessions.map((s) => s.sessionId)).toEqual(['mock-session-1']);

    const before = all.length;
    await conn.loadSession(session.sessionId);
    await waitFor(() => all.length >= before + 6);
    expect(all.slice(before, before + 6).map((n) => n.update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
    ]);
  });

  it('cancel：turn 中途取消 → stopReason=cancelled，mock 侧确认收到', async () => {
    const { conn, logPath } = connectMock('happy', { env: { MOCK_STEP_DELAY_MS: '50' } });
    await conn.initialize();
    const session = await conn.newSession();
    const updates: acp.SessionNotification[] = [];
    const promptPromise = conn.prompt(session.sessionId, PROMPT_BLOCKS, (n) => updates.push(n));
    await waitFor(() => updates.length >= 2);
    await conn.cancel(session.sessionId);
    const resp = await promptPromise;
    expect(resp.stopReason).toBe('cancelled');
    expect(updates.length).toBeLessThan(HAPPY_TURN_KINDS.length);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('session/cancel sessionId=mock-session-1 turnActive=true');
  });

  it('permission-flow：未接审批桥时默认 fail closed（回 cancelled）', async () => {
    const { conn, logPath } = connectMock('permission-flow');
    await conn.initialize();
    const session = await conn.newSession();
    const resp = await conn.prompt(session.sessionId, PROMPT_BLOCKS);
    expect(resp.stopReason).toBe('cancelled');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('permission outcome=cancelled');
  });

  it('permission-flow：onPermissionRequest 选择 allow_once → turn 完成', async () => {
    const { conn, logPath } = connectMock('permission-flow', {
      conn: {
        onPermissionRequest: (params) => {
          const allow = params.options.find((o) => o.kind === 'allow_once');
          return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? '' } };
        },
      },
    });
    await conn.initialize();
    const session = await conn.newSession();
    const resp = await conn.prompt(session.sessionId, PROMPT_BLOCKS);
    expect(resp.stopReason).toBe('end_turn');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('permission outcome=selected optionId=allow_once');
  });
});

describe('错误分类', () => {
  it('slow-response：initialize 超时 → timeout 分类，且进程已被拆除', async () => {
    const { conn } = connectMock('slow-response', {
      env: { MOCK_SLOW_INIT_MS: '1500' },
      conn: { initializeTimeoutMs: 150, eofGraceMs: 100, termGraceMs: 300 },
    });
    const err = await expectReject(conn.initialize());
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('timeout');
    expect(acpErr.message).toContain('150ms');
    expect(conn.isClosed).toBe(true);
    const pid = conn.pid;
    expect(pid).toBeDefined();
    if (pid !== undefined) await waitFor(() => isDead(pid));
  });

  it('crash-mid-turn：prompt 以 crash 分类 reject（exit code 1），已流出 chunk 不丢', async () => {
    const { conn } = connectMock('crash-mid-turn');
    await conn.initialize();
    const session = await conn.newSession();
    const chunks: string[] = [];
    const promptPromise = conn.prompt(session.sessionId, PROMPT_BLOCKS, (n) => {
      const u = n.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') chunks.push(u.content.text);
    });
    // 崩溃可能先于断言发生：立即挂上观察，避免 rejection 先于 handler 被记为 unhandled
    const observed = promptPromise.then(
      () => {
        throw new Error('expected prompt to reject, but it resolved');
      },
      (error: unknown) => error,
    );
    await waitFor(() => chunks.length >= 2);
    const err = await observed;
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('crash');
    expect(acpErr.exit?.code).toBe(1);
    expect(acpErr.message).toContain('session/prompt');
    expect(chunks).toEqual(['Partial', ' output']);
    // 已死进程的 close 立即返回
    await conn.close();
    expect(conn.exited?.code).toBe(1);
  });

  it('garbage-stdout：非 JSON 行被 console.error 记录后跳过，协议流不受影响（SDK 实测行为）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { conn } = connectMock('garbage-stdout');
      await conn.initialize();
      const session = await conn.newSession();
      const resp = await conn.prompt(session.sessionId, PROMPT_BLOCKS);
      expect(resp.stopReason).toBe('end_turn');
      expect(errSpy).toHaveBeenCalledWith(
        'Failed to parse JSON message:',
        expect.stringContaining('intentionally not valid JSON'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('spawn-failure：命令不存在（ENOENT）分类正确，message 含命令名，无进程残留', async () => {
    const conn = track(
      new AcpClientConnection(
        { argv: ['/nonexistent/dsh-acp-missing-bin', 'acp'], cwd: logDir, env: {}, subprocess },
        { initializeTimeoutMs: 3000 },
      ),
    );
    const err = await expectReject(conn.initialize());
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('spawn-failure');
    expect(acpErr.message).toContain('/nonexistent/dsh-acp-missing-bin');
    expect(acpErr.message).toContain('ENOENT');
    expect(conn.pid).toBeUndefined();
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('auth_required：initialize 收到 JSON-RPC -32000 → auth_required 分类', async () => {
    const conn = connectInline(AUTH_REFUSING_AGENT);
    const err = await expectReject(conn.initialize());
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('auth_required');
    expect(acpErr.message).toContain('requires authentication');
  });

  it('spec 校验：空 argv 或 wrapArgv 返回空 → 构造即抛 spawn-failure', () => {
    expect(() => new AcpClientConnection({ argv: [], cwd: logDir, env: {}, subprocess })).toThrow(AcpClientError);
    expect(
      () =>
        new AcpClientConnection({
          argv: [process.execPath, '-e', ''],
          cwd: logDir,
          env: {},
          subprocess,
          wrapArgv: () => [],
        }),
    ).toThrow(AcpClientError);
  });

 it('wrapArgv：包装钩子收到原 argv 且返回值生效（沙箱插口）', async () => {
    const original = [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-wrap`];
    let seen: string[] = [];
    const conn = track(
      new AcpClientConnection(
        {
          argv: original,
          cwd: logDir,
          env: { MOCK_SCENARIO: 'happy', MOCK_LOG: path.join(logDir, 'wrap.log') },
          subprocess,
          wrapArgv: (argv) => {
            seen = argv;
            return argv;
          },
        },
        { eofGraceMs: 150, termGraceMs: 500 },
      ),
    );
    expect(seen).toEqual(original);
    const init = await conn.initialize();
    expect(init.protocolVersion).toBe(1);
  });
});

describe('拆除梯子', () => {
  it('EOF 不退出（devin 口径）：EOF 窗口耗尽后 SIGTERM 生效', async () => {
    const { conn, logPath } = connectMock('happy', { conn: { eofGraceMs: 200, termGraceMs: 600 } });
    await conn.initialize();
    const t0 = Date.now();
    await conn.close();
    // 第 1 级 EOF 等满了才升级到 SIGTERM（留 50ms 计时抖动）
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('stdin EOF; staying alive until SIGTERM');
    expect(log).toContain('SIGTERM received, exit(0)');
    expect(conn.exited).toEqual({ code: 0, signal: null });
  });

  it('eof-exit 对照：stdin EOF 即退出，不触发 SIGTERM', async () => {
    const { conn, logPath } = connectMock('eof-exit', { conn: { eofGraceMs: 400, termGraceMs: 600 } });
    await conn.initialize();
    const t0 = Date.now();
    await conn.close();
    expect(Date.now() - t0).toBeLessThan(400);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('stdin EOF -> exit(0) (eof-exit)');
    expect(log).not.toContain('SIGTERM received');
  });

  it('SIGTERM 不退出 → SIGKILL 兜底', async () => {
    const conn = connectInline(SIGTERM_IGNORING_AGENT, { eofGraceMs: 100, termGraceMs: 300 });
    const t0 = Date.now();
    await conn.close();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(conn.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('重复 close 幂等：返回同一 Promise', async () => {
    const { conn } = connectMock('happy');
    await conn.initialize();
    const p1 = conn.close();
    const p2 = conn.close();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    const pid = conn.pid;
    if (pid !== undefined) await waitFor(() => isDead(pid));
  });

  it('close 后的调用被拒绝', async () => {
    const { conn } = connectMock('happy');
    await conn.initialize();
    await conn.close();
    await expect(conn.newSession()).rejects.toThrow('closed');
  });
});

describe(' 全 RPC deadline 与 connection poison（never-resolve 矩阵）', () => {
  // 测试用小预算（生产默认 30s/15s 太慢）；mock 的 never-resolve 对指定方法永不应答
  const NEVER_BUDGET_MS = 150;

  function connectNever(neverMethods: string[], conn: AcpConnectionOptions = {}): MockHandle {
    return connectMock('never-resolve', { env: { MOCK_NEVER_METHODS: JSON.stringify(neverMethods) }, conn });
  }

  function expectTimeoutKind(error: unknown, method: string): void {
    expect(error).toBeInstanceOf(AcpClientError);
    const acpErr = error as AcpClientError;
    expect(acpErr.kind).toBe('timeout');
    expect(acpErr.message).toContain(method);
    expect(acpErr.message).toContain(`${String(NEVER_BUDGET_MS)}ms`);
  }

  // poison 断言：触发 op 记录 + 下一次调用立即拒（protocol-error）+ 后台拆除进程死亡
  async function expectPoisoned(conn: AcpClientConnection, op: string): Promise<void> {
    expect(conn.poisonedBy).toBe(op);
    const t0 = Date.now();
    const error = await expectReject(conn.listSessions());
    expect(Date.now() - t0).toBeLessThan(100);
    expect(error).toBeInstanceOf(AcpClientError);
    const acpErr = error as AcpClientError;
    expect(acpErr.kind).toBe('protocol-error');
    expect(acpErr.message).toContain('poisoned');
    expect(acpErr.message).toContain(op);
    const pid = conn.pid;
    if (pid !== undefined) await waitFor(() => isDead(pid));
  }

  it('预算常量钉版：initialize 15s / 会话建立类（new/load/list）30s / 会话写类（set-option/set-mode）15s', () => {
    expect(DEFAULT_INITIALIZE_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_SESSION_SETUP_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_SESSION_WRITE_TIMEOUT_MS).toBe(15_000);
  });

  it('session/new 永不应答 → 预算内 timeout → poison → 拒绝复用 → 后台拆除无孤儿', async () => {
    const { conn } = connectNever(['session/new']);
    await conn.initialize();
    const error = await expectReject(conn.newSession({}, { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/new');
    await expectPoisoned(conn, 'session/new');
  });

  it('session/load 永不应答 → 预算内 timeout → poison', async () => {
    const { conn } = connectNever(['session/load']);
    await conn.initialize();
    const error = await expectReject(conn.loadSession('mock-session-1', {}, { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/load');
    await expectPoisoned(conn, 'session/load');
  });

  it('session/list 永不应答 → 预算内 timeout → poison', async () => {
    const { conn } = connectNever(['session/list']);
    await conn.initialize();
    const error = await expectReject(conn.listSessions({}, { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/list');
    await expectPoisoned(conn, 'session/list');
  });

  it('session/set_config_option 永不应答 → 预算内 timeout → poison', async () => {
    const { conn } = connectNever(['session/set_config_option']);
    await conn.initialize();
    const session = await conn.newSession();
    const error = await expectReject(conn.setConfigOption(session.sessionId, 'model', 'mock-model-b', { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/set_config_option');
    await expectPoisoned(conn, 'session/set_config_option');
  });

  it('session/set_mode 永不应答 → 预算内 timeout → poison', async () => {
    const { conn } = connectNever(['session/set_mode']);
    await conn.initialize();
    const session = await conn.newSession();
    const error = await expectReject(conn.setMode(session.sessionId, 'plan', { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/set_mode');
    await expectPoisoned(conn, 'session/set_mode');
  });

  it('session/prompt 无默认预算，但显式 timeoutMs 生效：永不应答 → timeout → poison', async () => {
    const { conn } = connectNever(['session/prompt']);
    await conn.initialize();
    const session = await conn.newSession();
    const error = await expectReject(conn.prompt(session.sessionId, PROMPT_BLOCKS, undefined, { timeoutMs: NEVER_BUDGET_MS }));
    expectTimeoutKind(error, 'session/prompt');
    await expectPoisoned(conn, 'session/prompt');
  });

  it('initialize 永不应答 → initializeTimeoutMs 预算内 timeout，启动回滚拆除无孤儿', async () => {
    const { conn } = connectNever(['initialize'], { initializeTimeoutMs: NEVER_BUDGET_MS });
    const error = await expectReject(conn.initialize());
    expectTimeoutKind(error, 'initialize');
    expect(conn.isClosed).toBe(true);
    const pid = conn.pid;
    expect(pid).toBeDefined();
    if (pid !== undefined) await waitFor(() => isDead(pid));
  });
});

describe(' abort 语义', () => {
  it('RPC 在飞时 caller abort → aborted 分类（taxonomy user-rejected）+ poison + 后台拆除', async () => {
    const { conn } = connectMock('never-resolve', { env: { MOCK_NEVER_METHODS: '["session/list"]' } });
    await conn.initialize();
    const controller = new AbortController();
    const pending = conn.listSessions({}, { signal: controller.signal });
    // 先挂观察再 abort，避免 rejection 先于 handler
    const observed = expectReject(pending);
    await sleep(30); // 让帧确实发出（在飞状态）
    controller.abort(new Error('caller gave up'));
    const error = await observed;
    expect(error).toBeInstanceOf(AcpClientError);
    const acpErr = error as AcpClientError;
    expect(acpErr.kind).toBe('aborted');
    expect(acpErr.category).toBe('user-rejected');
    expect(acpErr.message).toContain('session/list');
    expect(conn.poisonedBy).toBe('session/list');
    const pid = conn.pid;
    if (pid !== undefined) await waitFor(() => isDead(pid));
  });

  it('进场前已中止：不发帧直接拒（aborted），连接不 poison、仍可继续用', async () => {
    const { conn, logPath } = connectMock('never-resolve', { env: { MOCK_NEVER_METHODS: '["session/list"]' } });
    await conn.initialize();
    const controller = new AbortController();
    controller.abort(new Error('already done'));
    const error = await expectReject(conn.listSessions({}, { signal: controller.signal }));
    expect(error).toBeInstanceOf(AcpClientError);
    expect((error as AcpClientError).kind).toBe('aborted');
    expect(conn.poisonedBy).toBeUndefined();
    // 帧未发出
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('--> session/list');
    // 连接未污染：never 列表只挂 session/list，session/new 照常
    const session = await conn.newSession();
    expect(session.sessionId).toBe('mock-session-1');
  });

  it('prompt 的正常取消（session/cancel → cancelled settle）不 poison，连接可复用', async () => {
    const { conn } = connectMock('happy', { env: { MOCK_STEP_DELAY_MS: '50' } });
    await conn.initialize();
    const session = await conn.newSession();
    const pending = conn.prompt(session.sessionId, PROMPT_BLOCKS);
    await sleep(30); // turn 起跑
    await conn.cancel(session.sessionId);
    const resp = await pending;
    expect(resp.stopReason).toBe('cancelled');
    expect(conn.poisonedBy).toBeUndefined();
    const again = await conn.prompt(session.sessionId, PROMPT_BLOCKS);
    expect(again.stopReason).toBe('end_turn');
  });
});

describe('stderr 环形缓冲与脱敏', () => {
  it('默认脱敏：sk-/Bearer/JWT/key=value 形状被滤除，普通行保留', async () => {
    const conn = connectInline(STDERR_SECRETS_AGENT);
    await waitFor(() => conn.stderrLines().length >= 4);
    const text = conn.stderrLines().join('\n');
    expect(text).not.toContain('abcdef1234567890abcdef');
    expect(text).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
    expect(text).toContain('<redacted');
    expect(text).toContain('plain line stays');
    await conn.close();
  });

  it('环形缓冲：行数上限保留最新 N 行', async () => {
    const conn = connectInline(STDERR_SPAM_AGENT, { stderrMaxLines: 10 });
    await waitFor(() => conn.stderrLines().some((l) => l.includes('spam-49')));
    const lines = conn.stderrLines();
    expect(lines.length).toBe(10);
    expect(lines[0]).toBe('spam-40');
    expect(lines[lines.length - 1]).toBe('spam-49');
    await conn.close();
  });

  it('环形缓冲：总字节上限', async () => {
    const conn = connectInline(STDERR_SPAM_AGENT, { stderrMaxLines: 100, stderrMaxBytes: 40 });
    await waitFor(() => conn.stderrLines().some((l) => l.includes('spam-49')));
    const lines = conn.stderrLines();
    expect(lines.join('\n').length).toBeLessThanOrEqual(48);
    expect(lines[lines.length - 1]).toBe('spam-49');
    await conn.close();
  });

  it('自定义脱敏钩子生效', async () => {
    const conn = connectInline(STDERR_SPAM_AGENT, {
      stderrMaxLines: 5,
      redactStderrLine: (line) => line.replace('spam', 'MASKED'),
    });
    await waitFor(() => conn.stderrLines().length >= 5);
    expect(conn.stderrLines().every((l) => l.startsWith('MASKED-'))).toBe(true);
    await conn.close();
  });

 it('：crash 错误消息内嵌的 stderr 尾部同样脱敏（token 形字符串不落原文进 message）', async () => {
    const conn = connectInline(STDERR_THEN_CRASH_AGENT);
    await conn.initialize();
    const err = await conn.newSession().then(
      () => {
        throw new Error('expected newSession to reject with crash, but it resolved');
      },
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(AcpClientError);
    const acpErr = err as AcpClientError;
    expect(acpErr.kind).toBe('crash');
    // crashMessage 内嵌 stderr 尾部：脱敏发生在环形缓冲入口，message 只带滤后行
    expect(acpErr.message).toContain('agent stderr');
    expect(acpErr.message).not.toContain('sk-proj-abcdef1234567890abcdef');
    expect(acpErr.message).toContain('<redacted');
    await conn.close();
  });
});

describe('probe', () => {
  const probeSpec = (scenario: string, extraEnv: Record<string, string> = {}): { spec: AcpConnectionSpec; tag: string } => {
    const seq = ++spawnSeq;
    return {
      tag: `${SPEC_TAG}-probe${String(seq)}`,
      spec: {
        argv: [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-probe${String(seq)}`],
        cwd: logDir,
        env: { MOCK_SCENARIO: scenario, MOCK_LOG: path.join(logDir, `probe-${String(seq)}.log`), ...extraEnv },
        subprocess,
      },
    };
  };

  it('happy：独立短生命周期收集 configOptions/modes/agentInfo，结束后无进程残留', async () => {
    const { spec } = probeSpec('happy');
    const result = await AcpClientConnection.probe(spec, { timeoutMs: 5000, eofGraceMs: 100, termGraceMs: 300 });
    expect(result.sessionId).toBe('mock-session-1');
    expect(result.agentInfo?.name).toBe('dsh-mock-acp-agent');
    expect(result.authMethods).toEqual([]);
    expect(result.modes?.currentModeId).toBe('accept-edits');
    expect(result.configOptions?.map((o) => o.id)).toEqual(['mode', 'model']);
    expect(result.configOptions?.find((o) => o.category === 'model')?.currentValue).toBe('mock-model-a');
    // probe 返回前已完成连接的有界拆除；进程树级事实由共享 subprocess seam 与 install-gate 验证。
  });

  it('no-config-options：configOptions 为 undefined（降级信号），modes 仍在', async () => {
    const { spec } = probeSpec('no-config-options');
    const result = await AcpClientConnection.probe(spec, { timeoutMs: 5000, eofGraceMs: 100, termGraceMs: 300 });
    expect(result.configOptions).toBeUndefined();
    expect(result.modes?.currentModeId).toBe('accept-edits');
  });

  it('slow-response：probe 超时分类为 timeout 且拆除无残留', async () => {
    const { spec } = probeSpec('slow-response', { MOCK_SLOW_INIT_MS: '1500' });
    const err = await expectReject(AcpClientConnection.probe(spec, { timeoutMs: 200, eofGraceMs: 100, termGraceMs: 300 }));
    expect(err).toBeInstanceOf(AcpClientError);
    expect((err as AcpClientError).kind).toBe('timeout');
  });

  it('spawn-failure：probe 命令不存在 → spawn-failure 分类', async () => {
    const err = await expectReject(
      AcpClientConnection.probe({ argv: ['/nonexistent/dsh-acp-missing-bin'], cwd: logDir, env: {}, subprocess }, { timeoutMs: 3000 }),
    );
    expect(err).toBeInstanceOf(AcpClientError);
    expect((err as AcpClientError).kind).toBe('spawn-failure');
  });

 it('权限分离钉：probe 全程只发 initialize/session/new + 清理帧，绝不触发 authenticate', async () => {
 // 钉死 权限分离口径：模型列表探测（probe 路径）不得要求任何认证态——
    // authenticate 是会话路径的显式用户动作，probe 若暗中触发会把"看模型列表"
    // 与"授权凭据"两个权限域混为一谈。以 mock 的请求日志逐方法断言，而非只断言
 // "不含 authenticate"：方法序列收窄到恰为握手两帧 + 清理帧（happy 广告
    // delete 不广告 close，故恰一帧 session/delete），未来新增帧必须显式改本钉。
    const { spec } = probeSpec('happy');
    await AcpClientConnection.probe(spec, { timeoutMs: 5000, eofGraceMs: 100, termGraceMs: 300 });
    const log = fs.readFileSync(spec.env['MOCK_LOG'] as string, 'utf8');
    const methods = log
      .split('\n')
      .filter((line) => line.includes('--> '))
      .map((line) => (line.split('--> ')[1] ?? '').split(' ')[0]);
    expect(methods).toEqual(['initialize', 'session/new', 'session/delete']);
    expect(methods).not.toContain('authenticate');
  });
});
