#!/usr/bin/env node
// selftest.mjs — mock-agent 契约自测：spawn 真实子进程逐 scenario 跑关键路径并断言帧序列。
//
// 零依赖、不经过 vitest：`node test/mock-agent/selftest.mjs` 直接运行。
// 任一断言失败则以 exit(1) 结束；结束时回收所有子进程，不留孤儿。
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-agent.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-agent-selftest-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0;
let failures = 0;
function assert(cond, label, detail) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`  FAIL: ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

// ---------- 最小 ACP client（NDJSON JSON-RPC） ----------
class MockClient {
  constructor(scenario, env = {}) {
    this.child = spawn(process.execPath, [MOCK], {
      env: { ...process.env, MOCK_SCENARIO: scenario, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += String(d); });
    this.exited = null;
    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exited = { code, signal };
        resolve(this.exited);
      });
    });
    this.stdoutClosed = new Promise((r) => this.child.stdout.on('close', r));
    this.rawStdout = '';
    this.frames = []; // 已解析的 JSON 帧，按到达顺序
    this.nonJsonLines = [];
    this.pending = new Map();
    this.nextId = 1;
    this.waiters = []; // { predicate, fromIndex, resolve, timer }
    this.onAgentRequest = null; // (msg) => result 对象
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      this.rawStdout += line + '\n';
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.nonJsonLines.push(line);
        return;
      }
      this.frames.push(msg);
      this.dispatch(msg);
    });
  }

  dispatch(msg) {
    // 任何帧都先过等待者（id=null 的 parse error 响应帧也是合法等待目标）
    this.waiters = this.waiters.filter((w) => {
      let hit = false;
      try { hit = w.predicate(msg); } catch { /* 谓词不适配此帧 */ }
      if (hit) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
      return !hit;
    });
    if (msg.id !== undefined && msg.method !== undefined) {
      // agent → client 请求（session/request_permission 等）
      let result;
      try {
        result = this.onAgentRequest ? this.onAgentRequest(msg) : {};
      } catch (e) {
        result = {};
        assert(false, `onAgentRequest threw: ${e.message}`);
      }
      this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  }

  write(frame) {
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  // 等待满足条件的帧；fromIndex 之前的历史帧不参与匹配
  waitFor(predicate, label, timeoutMs = 5000, fromIndex = 0) {
    const hit = this.frames.slice(fromIndex).find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  waitUpdate(sessionUpdate, fromIndex = 0, timeoutMs = 5000) {
    return this.waitFor(
      (m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === sessionUpdate,
      `session/update ${sessionUpdate}`,
      timeoutMs,
      fromIndex,
    );
  }

  async close() {
    if (!this.exited) {
      this.child.kill('SIGTERM');
      await this.exitPromise;
    }
    await this.stdoutClosed;
  }
}

// ---------- 公共脚本片段 ----------
function initParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'mock-agent-selftest', title: 'Mock Agent Selftest', version: '0.0.1' },
  };
}

async function handshake(client, cwd = '/mock/cwd') {
  const init = await client.send('initialize', initParams());
  const nw = await client.send('session/new', { cwd, mcpServers: [] });
  return { init, nw, sessionId: nw.result?.sessionId };
}

// 发送 prompt 并收集本 turn 内的全部 session/update（按发送顺序）
async function runPromptAndCollect(client, sessionId, text = 'hi') {
  const start = client.frames.length;
  const resp = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const updates = client.frames
    .slice(start)
    .filter((m) => m.method === 'session/update' && m.params?.sessionId === sessionId)
    .map((m) => m.params.update);
  return { resp, updates };
}

const HAPPY_SEQUENCE = [
  'agent_thought_chunk',
  'agent_message_chunk',
  'agent_message_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
];

// ---------- 用例 ----------
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('happy: 全生命周期 + 帧序列 + EOF 不退出', async () => {
  const client = new MockClient('happy', { MOCK_STEP_DELAY_MS: '25' });
  try {
    // initialize：全能力矩阵
    const init = await client.send('initialize', initParams());
    assert(init.result?.protocolVersion === 1, 'happy initialize protocolVersion=1', init.result?.protocolVersion);
    const caps = init.result?.agentCapabilities ?? {};
    assert(caps.loadSession === true, 'happy caps loadSession=true', caps.loadSession);
    assert(caps.promptCapabilities?.image === true, 'happy caps promptCapabilities.image=true');
    assert(typeof caps.sessionCapabilities?.list === 'object', 'happy caps sessionCapabilities.list');
    assert(typeof caps.sessionCapabilities?.delete === 'object', 'happy caps sessionCapabilities.delete');
    // 固定 Devin 3000.4.25 历史实测：additionalDirectories 在场、close 不在广告面
    assert(typeof caps.sessionCapabilities?.additionalDirectories === 'object', 'happy caps sessionCapabilities.additionalDirectories');
    assert(!('close' in (caps.sessionCapabilities ?? {})), 'happy caps 无 sessionCapabilities.close（对齐真机）');
    assert(Array.isArray(init.result?.authMethods) && init.result.authMethods.length === 0, 'happy authMethods=[]');

    // session/new：configOptions = mode(5) + model(3)（真机只有这两类，全 select）
    const nw = await client.send('session/new', { cwd: '/mock/cwd', mcpServers: [] });
    const sessionId = nw.result?.sessionId;
    assert(sessionId === 'mock-session-1', 'happy sessionId 固定为 mock-session-1', sessionId);
    const configOptions = nw.result?.configOptions ?? [];
    assert(configOptions.length === 2, 'happy configOptions 共 2 项', configOptions.length);
    assert(
      JSON.stringify(configOptions.map((o) => o.category)) === JSON.stringify(['mode', 'model']),
      'happy configOptions 类别顺序 mode/model',
      configOptions.map((o) => o.category),
    );
    assert(configOptions[0]?.options?.length === 5, 'mode 选项 5 个（accept-edits/smart/ask/plan/bypass）', configOptions[0]?.options?.length);
    assert(configOptions[0]?.currentValue === 'accept-edits', 'mode 当前值 accept-edits（真机实测）', configOptions[0]?.currentValue);
    assert(configOptions[1]?.options?.length === 3, 'model 选项 3 个', configOptions[1]?.options?.length);
    assert(nw.result?.modes?.availableModes?.length === 5, 'modes.availableModes 5 个');
    assert(nw.result?.modes?.currentModeId === 'accept-edits', 'currentModeId=accept-edits');

    // 建会话后的主动推送（对齐 devin 流量）：厂商扩展通知 + 配置/模式快照
    const vendor = await client.waitFor((m) => m.method === '_cognition.ai/mcp/serversChanged', 'vendor notify');
    assert(vendor.method === '_cognition.ai/mcp/serversChanged', '收到 _cognition.ai/* 厂商通知');
    const cfgUpdate = await client.waitUpdate('config_option_update');
    assert(cfgUpdate.params.update.configOptions.length === 2, 'config_option_update 携带完整快照');
    const modeUpdate = await client.waitUpdate('current_mode_update');
    assert(modeUpdate.params.update.currentModeId === 'accept-edits', 'current_mode_update=accept-edits');

    // session/list
    const list = await client.send('session/list', { cwd: '/mock/cwd' });
    assert(list.result?.sessions?.length === 1, 'session/list 返回 1 个会话', list.result?.sessions?.length);
    assert(list.result.sessions[0].updatedAt === '2026-01-01T00:00:00.000Z', 'updatedAt 用固定时间戳', list.result.sessions[0].updatedAt);

    // prompt：完整更新流
    const { resp, updates } = await runPromptAndCollect(client, sessionId);
    assert(
      JSON.stringify(updates.map((u) => u.sessionUpdate)) === JSON.stringify(HAPPY_SEQUENCE),
      'happy prompt 更新序列 thought→message×3→tool→tool_update→plan→usage',
      updates.map((u) => u.sessionUpdate),
    );
    assert(updates[1].messageId === 'mock-msg-1' && updates[3].messageId === 'mock-msg-1', 'message chunk 共享 messageId');
    assert(updates[4].toolCallId === 'mock-tool-1' && updates[4].status === 'in_progress', 'tool_call in_progress');
    assert(updates[5].status === 'completed', 'tool_call_update 到达终态 completed', updates[5].status);
    assert(updates[6].entries?.length === 3, 'plan 含 3 个 entry');
    assert(updates[7].used === 1234 && updates[7].size === 1048576, 'usage_update used/size 固定值');
    assert(resp.result?.stopReason === 'end_turn', 'happy prompt stopReason=end_turn', resp.result?.stopReason);

    // session/cancel：turn 中途取消，按规范回 stopReason=cancelled
    const start2 = client.frames.length;
    const prompt2 = client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'cancel me' }] });
    await client.waitFor((m) => m.method === 'session/update', 'turn2 首条 update', 5000, start2);
    client.notify('session/cancel', { sessionId });
    const resp2 = await prompt2;
    const updates2 = client.frames
      .slice(start2)
      .filter((m) => m.method === 'session/update')
      .map((m) => m.params.update);
    assert(resp2.result?.stopReason === 'cancelled', 'cancel 后 stopReason=cancelled', resp2.result?.stopReason);
    assert(updates2.length >= 1 && updates2.length < HAPPY_SEQUENCE.length, 'cancel 截断更新流', updates2.length);

    // session/set_config_option：回完整快照
    const setCfg = await client.send('session/set_config_option', { sessionId, configId: 'model', value: 'mock-model-b' });
    const snapshot = setCfg.result?.configOptions ?? [];
    assert(snapshot.length === 2, 'set_config_option 回完整快照', snapshot.length);
    assert(snapshot.find((o) => o.id === 'model')?.currentValue === 'mock-model-b', 'model currentValue 已切换');

    // set_config_option 写 mode 项：modes 一面同步并补推 current_mode_update（双发保持一致）
    const startCfgMode = client.frames.length;
    const setCfgMode = await client.send('session/set_config_option', { sessionId, configId: 'mode', value: 'ask' });
    assert(
      setCfgMode.result?.configOptions?.find((o) => o.id === 'mode')?.currentValue === 'ask',
      'set_config_option 写 mode 后快照收敛 ask',
    );
    const modeUpdateCfg = await client.waitUpdate('current_mode_update', startCfgMode);
    assert(modeUpdateCfg.params.update.currentModeId === 'ask', 'set_config_option 写 mode 补推 current_mode_update=ask');

    // session/set_mode：空响应 + current_mode_update 通知
    const startMode = client.frames.length;
    const setMode = await client.send('session/set_mode', { sessionId, modeId: 'plan' });
    assert(setMode.result && Object.keys(setMode.result).length === 0, 'set_mode 响应为空对象', setMode.result);
    const modeUpdate2 = await client.waitUpdate('current_mode_update', startMode);
    assert(modeUpdate2.params.update.currentModeId === 'plan', 'set_mode 后 current_mode_update=plan');

    // authenticate / 未知方法 / 非法 JSON 行
    const auth = await client.send('authenticate', { methodId: 'none' });
    assert(auth.result && Object.keys(auth.result).length === 0, 'authenticate 返回 {}');
    const bogus = await client.send('bogus/method', {});
    assert(bogus.error?.code === -32601, '未知方法回 -32601', bogus.error);
    client.child.stdin.write('this is not json\n');
    const parseErr = await client.waitFor((m) => m.error?.code === -32700, 'parse error frame');
    assert(parseErr.id === null, 'parse error 帧 id=null', parseErr.id);

    // session/load：回放固定 messageId/toolCallId，供恢复归并去重测试
    const startLoad = client.frames.length;
    const load = await client.send('session/load', { sessionId: 'mock-loaded-1', cwd: '/mock/cwd', mcpServers: [] });
    assert(load.result?.modes?.availableModes?.length === 5, 'load 响应含 modes');
    assert(load.result?.configOptions?.length === 2, 'load 响应含 configOptions');
    const loadUpdates = client.frames
      .slice(startLoad)
      .filter((m) => m.method === 'session/update' && m.params?.sessionId === 'mock-loaded-1')
      .map((m) => m.params.update);
    assert(
      JSON.stringify(loadUpdates.map((u) => u.sessionUpdate)) === JSON.stringify([
        'user_message_chunk', 'agent_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'plan',
      ]),
      'load 回放序列 user→agent×2→tool→tool_update→plan',
      loadUpdates.map((u) => u.sessionUpdate),
    );
    assert(
      loadUpdates[1].messageId === 'mock-load-msg-agent-1' && loadUpdates[2].messageId === 'mock-load-msg-agent-1',
      'load 回放两条 agent chunk 共享固定 messageId',
    );
    assert(
      loadUpdates[3].toolCallId === 'mock-load-tool-1' && loadUpdates[4].toolCallId === 'mock-load-tool-1',
      'load 回放 tool_call/update 共享固定 toolCallId',
    );

    // session/delete + session/close
    const del = await client.send('session/delete', { sessionId: 'mock-loaded-1' });
    assert(del.result && Object.keys(del.result).length === 0, 'session/delete 返回 {}');
    const list2 = await client.send('session/list', {});
    assert(list2.result?.sessions?.length === 1, 'delete 后 list 剩 1 个会话', list2.result?.sessions?.length);
    const nw2 = await client.send('session/new', { cwd: '/mock/cwd', mcpServers: [] });
    const close = await client.send('session/close', { sessionId: nw2.result.sessionId });
    assert(close.result && Object.keys(close.result).length === 0, 'session/close 返回 {}');
    const promptClosed = await client.send('session/prompt', { sessionId: nw2.result.sessionId, prompt: [{ type: 'text', text: 'x' }] });
    assert(promptClosed.error?.code === -32602, '对已 close 会话 prompt 回 -32602', promptClosed.error);

    // 默认 scenario：stdin EOF 不退出，等 SIGTERM
    client.child.stdin.end();
    await sleep(400);
    assert(client.exited === null, '默认 scenario 下 stdin EOF 不退出', client.exited);
    await client.close();
    assert(client.exited?.code === 0, 'SIGTERM 后 exit(0)', client.exited);
  } finally {
    await client.close();
  }
});

test('minimal-caps: 最小能力 + 未声明方法 -32601 + 只发 message chunk', async () => {
  const client = new MockClient('minimal-caps');
  try {
    const { init, nw, sessionId } = await handshake(client);
    const caps = init.result?.agentCapabilities ?? {};
    assert(caps.loadSession === false, 'minimal-caps loadSession=false', caps.loadSession);
    assert(!('list' in (caps.sessionCapabilities ?? {})), 'minimal-caps 无 sessionCapabilities.list');
    assert(caps.promptCapabilities?.image === false, 'minimal-caps image=false');
    assert(!('configOptions' in (nw.result ?? {})), 'minimal-caps session/new 无 configOptions');
    assert(!('modes' in (nw.result ?? {})), 'minimal-caps session/new 无 modes');

    const { resp, updates } = await runPromptAndCollect(client, sessionId);
    assert(
      JSON.stringify(updates.map((u) => u.sessionUpdate)) === JSON.stringify(['agent_message_chunk', 'agent_message_chunk']),
      'minimal-caps 只发 message chunk',
      updates.map((u) => u.sessionUpdate),
    );
    assert(resp.result?.stopReason === 'end_turn', 'minimal-caps stopReason=end_turn');

    for (const method of ['session/load', 'session/list', 'session/delete', 'session/close']) {
      const r = await client.send(method, { sessionId, cwd: '/mock/cwd' });
      assert(r.error?.code === -32601, `minimal-caps ${method} 回 -32601`, r.error?.code);
    }
  } finally {
    await client.close();
  }
});

test('no-config-options: 能力正常但 session/new 不含 configOptions', async () => {
  const client = new MockClient('no-config-options');
  try {
    const { init, nw, sessionId } = await handshake(client);
    assert(init.result?.agentCapabilities?.loadSession === true, 'no-config-options loadSession=true');
    assert(!('configOptions' in (nw.result ?? {})), 'session/new 无 configOptions 键');
    assert(nw.result?.modes?.availableModes?.length === 5, 'session/new 仍含 modes');

    const { resp, updates } = await runPromptAndCollect(client, sessionId);
    assert(
      JSON.stringify(updates.map((u) => u.sessionUpdate)) === JSON.stringify(HAPPY_SEQUENCE),
      'no-config-options prompt 仍是完整更新流',
      updates.map((u) => u.sessionUpdate),
    );
    assert(resp.result?.stopReason === 'end_turn', 'no-config-options stopReason=end_turn');

    const setCfg = await client.send('session/set_config_option', { sessionId, configId: 'model', value: 'mock-model-b' });
    assert(setCfg.error?.code === -32602, '无 configOptions 时 set_config_option 回 -32602', setCfg.error?.code);
  } finally {
    await client.close();
  }
});

test('config-options-only: session/new 无 modes 键，set_mode 回 -32602，set_config_option 照常', async () => {
  const client = new MockClient('config-options-only');
  try {
    const { init, nw, sessionId } = await handshake(client);
    assert(init.result?.agentCapabilities?.loadSession === true, 'config-options-only loadSession=true');
    assert(!('modes' in (nw.result ?? {})), 'session/new 无 modes 键');
    const configOptions = nw.result?.configOptions ?? [];
    assert(configOptions.length === 2, 'config-options-only 仍含 mode+model 两项', configOptions.map((o) => o.id));

    const { resp } = await runPromptAndCollect(client, sessionId);
    assert(resp.result?.stopReason === 'end_turn', 'config-options-only prompt 正常结束');

    // 无 modes 面：set_mode 回 -32602；mode 只能走 set_config_option
    const setMode = await client.send('session/set_mode', { sessionId, modeId: 'plan' });
    assert(setMode.error?.code === -32602, '无 modes 时 set_mode 回 -32602', setMode.error?.code);
    const setCfg = await client.send('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
    assert(
      setCfg.result?.configOptions?.find((o) => o.id === 'mode')?.currentValue === 'plan',
      'set_config_option 写 mode 正常收敛',
    );
    // 无 modes 面 → 不补推 current_mode_update
    assert(
      !client.frames.some((m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'current_mode_update'),
      'config-options-only 全程无 current_mode_update',
    );
  } finally {
    await client.close();
  }
});

test('exotic-options: boolean + 未知 category + 未知 type 原样上线', async () => {
  const client = new MockClient('exotic-options');
  try {
    const { nw, sessionId } = await handshake(client);
    const configOptions = nw.result?.configOptions ?? [];
    assert(
      JSON.stringify(configOptions.map((o) => o.id)) === JSON.stringify(['mode', 'model', 'auto_compact', 'telemetry', 'temperature']),
      'exotic-options configOptions 共 5 项（happy 2 项 + 追加 3 项）',
      configOptions.map((o) => o.id),
    );
    const boolOpt = configOptions.find((o) => o.id === 'auto_compact');
    assert(boolOpt?.type === 'boolean' && boolOpt.currentValue === false, 'boolean 项原生 false 上线', boolOpt);
    assert(boolOpt?.category === 'model_config', 'boolean 项 category=model_config', boolOpt?.category);
    const telemetry = configOptions.find((o) => o.id === 'telemetry');
    assert(telemetry?.type === 'select' && telemetry.category === 'telemetry', '未知 category 的 select 原样上线', telemetry);
    const slider = configOptions.find((o) => o.id === 'temperature');
    assert(slider?.type === 'slider' && slider.currentValue === 'medium', '未知 type（slider）原样上线', slider);
    // 双发面仍在（modes 5 项）
    assert(nw.result?.modes?.availableModes?.length === 5, 'exotic-options 仍双发 modes');

    // boolean 原生值写路径：value 是 JSON boolean，不是字符串
    const setBool = await client.send('session/set_config_option', { sessionId, configId: 'auto_compact', value: true });
    assert(
      setBool.result?.configOptions?.find((o) => o.id === 'auto_compact')?.currentValue === true,
      'boolean 写原生 true 收敛',
    );
    // 未知 category 的 select 照常可写
    const setTel = await client.send('session/set_config_option', { sessionId, configId: 'telemetry', value: 'on' });
    assert(
      setTel.result?.configOptions?.find((o) => o.id === 'telemetry')?.currentValue === 'on',
      '未知 category 的 select 写 on 收敛',
    );
  } finally {
    await client.close();
  }
});

test('thought-level-env: MOCK_THOUGHT_LEVEL=1 追加 thought_level 三项（默认关闭的对照）', async () => {
  const client = new MockClient('happy', { MOCK_THOUGHT_LEVEL: '1' });
  try {
    const { nw } = await handshake(client);
    const configOptions = nw.result?.configOptions ?? [];
    assert(
      JSON.stringify(configOptions.map((o) => o.id)) === JSON.stringify(['mode', 'model', 'thought_level']),
      'MOCK_THOUGHT_LEVEL=1 时追加第三项 thought_level',
      configOptions.map((o) => o.id),
    );
    const effort = configOptions[2];
    assert(effort?.category === 'thought_level' && effort.currentValue === 'medium', 'thought_level 当前值 medium', effort);
    assert(effort?.options?.length === 3, 'thought_level 选项 3 个（low/medium/high）', effort?.options?.length);
  } finally {
    await client.close();
  }
});

test('permission-flow: request_permission 四选项 + outcome 分流 + optionId 落日志', async () => {
  const logFile = path.join(TMP, 'permission.log');
  const client = new MockClient('permission-flow', { MOCK_LOG: logFile });
  try {
    const { sessionId } = await handshake(client);

    // allow_once → tool 完成 + end_turn
    let sawRequest1 = false;
    client.onAgentRequest = (msg) => {
      sawRequest1 = true;
      assert(msg.method === 'session/request_permission', 'agent 请求为 session/request_permission', msg.method);
      assert(
        JSON.stringify(msg.params?.options?.map((o) => o.kind)) === JSON.stringify(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
        'permission 选项含 allow_once/allow_always/reject_once/reject_always',
        msg.params?.options?.map((o) => o.kind),
      );
      assert(msg.params?.toolCall?.toolCallId === 'mock-tool-perm-1', 'permission 携带 toolCall 信息');
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    };
    const { resp, updates } = await runPromptAndCollect(client, sessionId);
    assert(sawRequest1, 'turn 1 收到 permission 请求');
    assert(updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'), 'allow 后 tool_call_update completed');
    assert(resp.result?.stopReason === 'end_turn', 'allow 后 stopReason=end_turn', resp.result?.stopReason);

    // reject_once → tool 失败 + end_turn
    client.onAgentRequest = () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    const turn2 = await runPromptAndCollect(client, sessionId);
    assert(turn2.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed'), 'reject 后 tool_call_update failed');
    assert(turn2.resp.result?.stopReason === 'end_turn', 'reject 后 stopReason=end_turn');

    // cancel：cancel 通知 + cancelled outcome（规范要求两者都发）
    client.onAgentRequest = (msg) => {
      setTimeout(() => client.notify('session/cancel', { sessionId }), 0);
      return { outcome: { outcome: 'cancelled' } };
    };
    const turn3 = await runPromptAndCollect(client, sessionId);
    assert(turn3.resp.result?.stopReason === 'cancelled', 'cancel 后 stopReason=cancelled', turn3.resp.result?.stopReason);

    // 回传 optionId 必须落到 MOCK_LOG
    await sleep(100);
    const logText = fs.readFileSync(logFile, 'utf8');
    assert(logText.includes('optionId=allow_once'), 'MOCK_LOG 记录 optionId=allow_once');
    assert(logText.includes('optionId=reject_once'), 'MOCK_LOG 记录 optionId=reject_once');
    assert(logText.includes('outcome=cancelled'), 'MOCK_LOG 记录 cancelled outcome');
  } finally {
    await client.close();
  }
});

test('crash-mid-turn: 2 个 chunk 后 exit(1)，无 prompt 响应', async () => {
  const client = new MockClient('crash-mid-turn');
  try {
    const { sessionId } = await handshake(client);
    const start = client.frames.length;
    const promptId = client.nextId;
    const prompt = client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'boom' }] }, 3000);
    const outcome = await Promise.race([
      prompt.then((m) => ({ responded: m }), (e) => ({ error: e })),
      client.exitPromise.then((e) => ({ exit: e })),
    ]);
    assert(outcome.exit?.code === 1, 'crash-mid-turn 以 exit(1) 退出', outcome.exit ?? outcome);
    const updates = client.frames
      .slice(start)
      .filter((m) => m.method === 'session/update')
      .map((m) => m.params.update);
    assert(
      JSON.stringify(updates.map((u) => u.sessionUpdate)) === JSON.stringify(['agent_message_chunk', 'agent_message_chunk']),
      '崩溃前恰好 2 个 message chunk',
      updates.map((u) => u.sessionUpdate),
    );
    assert(!client.frames.some((m) => m.id === promptId), '崩溃后无 prompt 响应帧');
  } finally {
    await client.close();
  }
});

test('garbage-stdout: 首行非 JSON，协议仍正常', async () => {
  const client = new MockClient('garbage-stdout');
  try {
    const { init, sessionId } = await handshake(client);
    assert(client.nonJsonLines.length === 1, '恰好 1 行非 JSON', client.nonJsonLines.length);
    assert(client.nonJsonLines[0]?.includes('intentionally'), '非 JSON 行为启动 banner', client.nonJsonLines[0]);
    assert(client.rawStdout.split('\n')[0] === client.nonJsonLines[0], 'banner 是 stdout 第一行');
    assert(init.result?.agentCapabilities?.loadSession === true, 'garbage-stdout 行为同 happy');
    const { resp } = await runPromptAndCollect(client, sessionId);
    assert(resp.result?.stopReason === 'end_turn', 'garbage-stdout prompt 正常结束');
  } finally {
    await client.close();
  }
});

test('slow-response: initialize 延迟后仍正常', async () => {
  const client = new MockClient('slow-response', { MOCK_SLOW_INIT_MS: '1200' });
  try {
    const t0 = Date.now();
    const init = await client.send('initialize', initParams(), 8000);
    const elapsed = Date.now() - t0;
    assert(init.result?.protocolVersion === 1, 'slow-response initialize 最终响应');
    assert(elapsed >= 1100, 'initialize 延迟约 1200ms', elapsed);
    const { sessionId } = await handshake2(client);
    const { resp } = await runPromptAndCollect(client, sessionId);
    assert(resp.result?.stopReason === 'end_turn', 'slow-response 后续请求不延迟');
  } finally {
    await client.close();
  }
});

// slow-response 已 initialize 过，仅补 session/new
async function handshake2(client) {
  const nw = await client.send('session/new', { cwd: '/mock/cwd', mcpServers: [] });
  return { nw, sessionId: nw.result?.sessionId };
}

test('eof-exit: stdin EOF 后立即退出（对照组）', async () => {
  const client = new MockClient('eof-exit');
  try {
    const init = await client.send('initialize', initParams());
    assert(init.result?.protocolVersion === 1, 'eof-exit initialize 正常');
    client.child.stdin.end();
    const exit = await Promise.race([client.exitPromise, sleep(2000).then(() => null)]);
    assert(exit !== null && exit.code === 0, 'eof-exit 在 stdin EOF 后 exit(0)', exit);
  } finally {
    await client.close();
  }
});

test('determinism: 同 scenario 同脚本两次运行 stdout 字节级一致', async () => {
  async function scriptedRun() {
    const client = new MockClient('happy');
    await client.send('initialize', initParams());
    const nw = await client.send('session/new', { cwd: '/mock/cwd', mcpServers: [] });
    await client.send('session/prompt', { sessionId: nw.result.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await client.close();
    return client.rawStdout;
  }
  const [a, b] = await Promise.all([scriptedRun(), scriptedRun()]);
  assert(a.length > 500, '脚本运行产出足够帧', a.length);
  assert(a === b, '两次 happy 运行 stdout 字节级一致');
});

test('preset-sessions: fresh spawn 的 list 即含预置会话；MOCK_LIST_PAGE_SIZE 分页逐页翻完；load 预置 id 正常回放', async () => {
  const client = new MockClient('happy', {
    MOCK_PRESET_SESSIONS: JSON.stringify(['preset-a', 'preset-b', 'preset-c']),
    MOCK_LIST_PAGE_SIZE: '1',
  });
  try {
    const init = await client.send('initialize', initParams());
    assert(init.result?.agentCapabilities?.loadSession === true, 'preset 进程仍广告 loadSession');

    // 分页：每页 1 条，三页翻完才穷尽
    const p0 = await client.send('session/list', {});
    assert(p0.result?.sessions?.length === 1, 'page0 恰好 1 条', p0.result?.sessions?.length);
    assert(p0.result?.sessions?.[0]?.sessionId === 'preset-a', 'page0 = preset-a', p0.result?.sessions?.[0]?.sessionId);
    assert(p0.result?.nextCursor === '1', 'page0 携带 nextCursor=1', p0.result?.nextCursor);
    const p1 = await client.send('session/list', { cursor: '1' });
    assert(p1.result?.sessions?.[0]?.sessionId === 'preset-b', 'page1 = preset-b', p1.result?.sessions?.[0]?.sessionId);
    assert(p1.result?.nextCursor === '2', 'page1 携带 nextCursor=2', p1.result?.nextCursor);
    const p2 = await client.send('session/list', { cursor: '2' });
    assert(p2.result?.sessions?.[0]?.sessionId === 'preset-c', 'page2 = preset-c', p2.result?.sessions?.[0]?.sessionId);
    assert(p2.result?.nextCursor === undefined, 'page2 为末页（无 nextCursor）', p2.result?.nextCursor);

    // load 预置 id：正常回放（恢复矩阵的「正常恢复」流量）
    const startLoad = client.frames.length;
    const load = await client.send('session/load', { sessionId: 'preset-b', cwd: '/mock/cwd', mcpServers: [] });
    assert(load.result?.modes?.availableModes?.length === 5, 'load 预置 id 响应含 modes');
    assert(load.result?.configOptions?.length === 2, 'load 预置 id 响应含 configOptions');
    const loadUpdates = client.frames
      .slice(startLoad)
      .filter((m) => m.method === 'session/update' && m.params?.sessionId === 'preset-b')
      .map((m) => m.params.update);
    assert(loadUpdates.length === 6, 'load 预置 id 回放 6 条 update', loadUpdates.length);
  } finally {
    await client.close();
  }
});

test('preset-sessions 默认单页：MOCK_LIST_PAGE_SIZE 缺省时 list 一次返回全部且无 nextCursor', async () => {
  const client = new MockClient('happy', { MOCK_PRESET_SESSIONS: JSON.stringify(['preset-a', 'preset-b']) });
  try {
    await client.send('initialize', initParams());
    const list = await client.send('session/list', {});
    assert(list.result?.sessions?.length === 2, '单页返回全部 2 个预置会话', list.result?.sessions?.length);
    assert(list.result?.nextCursor === undefined, '单页模式无 nextCursor 键', list.result?.nextCursor);
  } finally {
    await client.close();
  }
});

test('list-fail: session/list 回 -32603，能力广告与 load 行为同 happy', async () => {
  const client = new MockClient('list-fail', { MOCK_PRESET_SESSIONS: JSON.stringify(['preset-x']) });
  try {
    const init = await client.send('initialize', initParams());
    const caps = init.result?.agentCapabilities ?? {};
    assert(caps.loadSession === true, 'list-fail 仍广告 loadSession=true');
    assert(typeof caps.sessionCapabilities?.list === 'object', 'list-fail 仍广告 list 能力');

    const list = await client.send('session/list', {});
    assert(list.error?.code === -32603, 'list-fail 的 session/list 回 -32603', list.error);

    // load 不受影响：预置 id 照常回放
    const start = client.frames.length;
    const load = await client.send('session/load', { sessionId: 'preset-x', cwd: '/mock/cwd', mcpServers: [] });
    assert(load.result && !load.error, 'list-fail 的 session/load 正常', load.error);
    const updates = client.frames
      .slice(start)
      .filter((m) => m.method === 'session/update' && m.params?.sessionId === 'preset-x');
    assert(updates.length === 6, 'list-fail 的 load 回放 6 条 update', updates.length);
  } finally {
    await client.close();
  }
});

test('load-fail: session/load 回 -32603，list 正常返回预置会话', async () => {
  const client = new MockClient('load-fail', { MOCK_PRESET_SESSIONS: JSON.stringify(['preset-y']) });
  try {
    await client.send('initialize', initParams());
    const list = await client.send('session/list', {});
    assert(list.result?.sessions?.some((s) => s.sessionId === 'preset-y'), 'load-fail 的 list 含预置 id');

    const load = await client.send('session/load', { sessionId: 'preset-y', cwd: '/mock/cwd', mcpServers: [] });
    assert(load.error?.code === -32603, 'load-fail 的 session/load 回 -32603', load.error);
    assert(
      !client.frames.some((m) => m.method === 'session/update' && m.params?.sessionId === 'preset-y'),
      'load 失败时不发任何回放 update',
    );

    // session/new 不受影响（降级路径的落脚）
    const nw = await client.send('session/new', { cwd: '/mock/cwd', mcpServers: [] });
    assert(nw.result?.sessionId === 'mock-session-1', 'load-fail 的 session/new 正常', nw.result);
  } finally {
    await client.close();
  }
});

// ---------- runner（各用例 finally 内已 close 子进程，不留孤儿） ----------
for (const [name, fn] of tests) {
  process.stdout.write(`• ${name} ... `);
  const before = failures;
  try {
    await fn();
    console.log(failures === before ? 'ok' : 'FAILED');
  } catch (e) {
    failures++;
    console.log('ERROR');
    console.error(`  ${e.stack ?? e}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nselftest: ${passes} assertions passed, ${failures} failed (${tests.length} scenarios/cases)`);
process.exit(failures ? 1 : 0);
