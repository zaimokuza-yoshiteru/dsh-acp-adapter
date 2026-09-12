// Deterministic ACP protocol fixture. Scenarios are selected by MOCK_SCENARIO
// (default happy); regression delegates product flows to regression-turn.mjs.
// Optional test inputs: MOCK_LOG, MOCK_STEP_DELAY_MS, MOCK_SLOW_INIT_MS,
// MOCK_ADVERTISE_RESUME, MOCK_ADVERTISE_FORK, MOCK_EMIT_NATIVE_SUBAGENT,
// MOCK_NEVER_METHODS, and MOCK_MODEL_THOUGHT_LEVELS.
import readline from 'node:readline';
import { regressionTurn } from './regression-turn.mjs';
import fs from 'node:fs';

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const KNOWN_SCENARIOS = new Set([
  'regression',
  'happy',
  'minimal-caps',
  'rich-content',
  'no-config-options',
  'permission-flow',
  'elicitation',
  'crash-mid-turn',
  'garbage-stdout',
  'slow-response',
  'eof-exit',
  'cleanup-close-delete',
  'delete-fail',
  'no-delete',
  'load-fail',
  'cancel-stuck',
  'never-resolve',
  'config-write-fail',
]);

const intEnv = (name, dflt) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const STEP_DELAY_MS = intEnv('MOCK_STEP_DELAY_MS', 10);
const SLOW_INIT_MS = intEnv('MOCK_SLOW_INIT_MS', 5000);
const ADVERTISE_RESUME = process.env.MOCK_ADVERTISE_RESUME === '1';
const ADVERTISE_FORK = process.env.MOCK_ADVERTISE_FORK === '1';
const EMIT_NATIVE_SUBAGENT = process.env.MOCK_EMIT_NATIVE_SUBAGENT === '1';
// never-resolve：永不响应的方法集合（RPC deadline 矩阵；默认只挂 session/new）
const NEVER_METHODS = (() => {
  try {
    const parsed = JSON.parse(process.env.MOCK_NEVER_METHODS ?? '["session/new"]');
    return new Set(Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
})();

const state = {
  scenario: process.env.MOCK_SCENARIO || 'happy',
  sessions: new Map(), // sessionId -> { id, cwd, modes, configOptions, turn }
  sessionSeq: 0,
  agentReqSeq: 0,
  pendingAgentRequests: new Map(), // agent 侧请求 id -> resolve(result)
};

if (!KNOWN_SCENARIOS.has(state.scenario)) {
  process.stderr.write(`[mock-agent] unknown MOCK_SCENARIO: ${state.scenario}\n`);
  process.exit(2);
}

// ---------- 日志 ----------
const MOCK_LOG = process.env.MOCK_LOG;
function log(msg) {
  const line = `[mock-agent scenario=${state.scenario}] ${msg}\n`;
  if (MOCK_LOG) fs.appendFileSync(MOCK_LOG, line);
  else process.stderr.write(line);
}

// ---------- 帧输出（stdout 只允许协议帧） ----------
function sendFrame(frame, cb) {
  process.stdout.write(JSON.stringify(frame) + '\n', cb);
}
function respond(id, result) {
  sendFrame({ jsonrpc: '2.0', id, result });
}
function respondError(id, code, message) {
  sendFrame({ jsonrpc: '2.0', id, error: { code, message } });
}
function sendUpdate(sessionId, update, cb) {
  sendFrame({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }, cb);
}
// agent → client 请求（session/request_permission），返回 client 响应的 result
function sendAgentRequest(method, params) {
  const id = `mock-agent-req-${++state.agentReqSeq}`;
  return new Promise((resolve) => {
    state.pendingAgentRequests.set(id, resolve);
    sendFrame({ jsonrpc: '2.0', id, method, params });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- scenario 行为谓词 ----------
const fullCaps = () => state.scenario !== 'minimal-caps';
const hasConfigOptions = () => state.scenario !== 'minimal-caps' && state.scenario !== 'no-config-options';
const MODEL_THOUGHT_LEVELS = (() => {
  try {
    const parsed = JSON.parse(process.env.MOCK_MODEL_THOUGHT_LEVELS ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
})();

function thoughtLevelsForModel(model) {
  const values = MODEL_THOUGHT_LEVELS[model];
  return Array.isArray(values) && values.every((value) => typeof value === 'string' && value.length > 0)
    ? values
    : undefined;
}
// 清理矩阵的广告旋钮（真机 devin：delete 有、close 无）：
//   no-delete 不广告 delete；cleanup-close-delete 额外广告 close。
const advertisesDelete = () => fullCaps() && state.scenario !== 'no-delete';
const advertisesClose = () => state.scenario === 'cleanup-close-delete';

// ---------- 固定脚本数据（对齐 reference/agent-client-protocol/schema/v1/schema.json） ----------
// mode 集合固定自 Devin 3000.4.25 的历史实测：id accept-edits（显示名 "Code"）等 5 项，
// modes 与 configOptions.mode 一一对应双发。
const MODE_ENTRIES = [
  { id: 'accept-edits', name: 'Code', description: 'Write and edit code' },
  { id: 'smart', name: 'Smart', description: 'Auto-approve actions the model judges safe' },
  { id: 'ask', name: 'Ask', description: 'Answer questions without code changes' },
  { id: 'plan', name: 'Plan', description: 'Plan changes before implementing' },
  { id: 'bypass', name: 'Bypass Permissions', description: 'Auto-approve all tool calls' },
];

function freshModes() {
  // SessionModeState
  return {
    currentModeId: 'accept-edits',
    availableModes: MODE_ENTRIES.map(({ id, name }) => ({ id, name })),
  };
}

function freshConfigOptions() {
  // SessionConfigOption[]：mode(5 项) + model(3 项)；真机只有这两类（全 select）
  const options = [
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'accept-edits',
      options: MODE_ENTRIES.map(({ id, name, description }) => ({ value: id, name, description })),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select',
      currentValue: 'mock-model-a',
      options: [
        { value: 'mock-model-a', name: 'Mock Model A' },
        { value: 'mock-model-b', name: 'Mock Model B' },
        { value: 'mock-model-c', name: 'Mock Model C' },
      ],
    },
  ];
  const initialThoughtLevels = thoughtLevelsForModel('mock-model-a');
  if (initialThoughtLevels !== undefined) {
    const levels = initialThoughtLevels;
    options.push({
      id: 'thought_level',
      name: 'Thought Level',
      category: 'thought_level',
      type: 'select',
      currentValue: levels[0],
      options: levels.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
    });
  }
  return options;
}

function happyTurnUpdates(cwd) {
  return [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about the mock request.' }, messageId: 'mock-thought-1' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'mock-msg-1' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ', mock' }, messageId: 'mock-msg-1' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world.' }, messageId: 'mock-msg-1' },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'mock-tool-1',
      title: 'Read README.md',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: `${cwd}/README.md` }],
      rawInput: { path: 'README.md' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-tool-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '# mock readme' } }],
      rawOutput: { bytes: 13 },
    },
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect the request', priority: 'high', status: 'completed' },
        { content: 'Produce a reply', priority: 'medium', status: 'completed' },
        { content: 'Report usage', priority: 'low', status: 'completed' },
      ],
    },
    { sessionUpdate: 'usage_update', used: 1234, size: 1048576 },
  ];
}

// .1t：同 happy 的 turn 骨架，tool_call_update 的 content 换成全非文本类型混合
// （diff/terminal/image/resource text/blob/resource_link + 一条 text）——tool result
// fidelity 的 e2e 夹具（占位/摘要落 log、meta、sidecar degradation 审计）。
function richContentTurnUpdates(cwd) {
  return happyTurnUpdates(cwd).map((update) => {
    if (update.sessionUpdate !== 'tool_call_update') return update;
    return {
      ...update,
      content: [
        { type: 'content', content: { type: 'text', text: 'visible text part' } },
        { type: 'diff', path: `${cwd}/README.md`, oldText: 'old title\n', newText: '# mock readme\n' },
        { type: 'terminal', terminalId: 'mock-term-1' },
        { type: 'content', content: { type: 'image', data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' } },
        { type: 'content', content: { type: 'resource', resource: { uri: 'file:///mock/cwd/notes.txt', mimeType: 'text/plain', text: 'notes body' } } },
        { type: 'content', content: { type: 'resource', resource: { uri: 'file:///mock/cwd/bin.dat', mimeType: 'application/octet-stream', blob: 'AAECAwQ=' } } },
        { type: 'content', content: { type: 'resource_link', name: 'report.pdf', title: '报表', uri: 'file:///mock/cwd/report.pdf', mimeType: 'application/pdf', size: 2048 } },
      ],
    };
  });
}

const MINIMAL_TURN_UPDATES = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Minimal reply.' }, messageId: 'mock-msg-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' }, messageId: 'mock-msg-1' },
];

// session/load 回放：固定 messageId/toolCallId，供恢复归并逻辑做去重测试
const LOAD_REPLAY = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier user question' }, messageId: 'mock-load-msg-user-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer, part 1' }, messageId: 'mock-load-msg-agent-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + part 2' }, messageId: 'mock-load-msg-agent-1' },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'mock-load-tool-1',
    title: 'Read notes.txt',
    kind: 'read',
    status: 'completed',
    locations: [{ path: '/mock/cwd/notes.txt' }],
    rawInput: { path: 'notes.txt' },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'mock-load-tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'notes contents' } }],
  },
  {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Revisit earlier question', priority: 'high', status: 'completed' },
      { content: 'Summarize history', priority: 'medium', status: 'completed' },
    ],
  },
];

const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
];

// ---------- 会话 ----------
function createSession(id, cwd) {
  const session = {
    id,
    cwd,
    modes: fullCaps() ? freshModes() : null,
    configOptions: hasConfigOptions() ? freshConfigOptions() : null,
    turn: null, // { cancelled, cancel(), cancelWait? }
    closed: false, // session/close 后置位：prompt 拒绝（-32602），delete 仍合法
  };
  state.sessions.set(id, session);
  return session;
}

function getSession(msg) {
  const sessionId = msg.params?.sessionId;
  const session = typeof sessionId === 'string' ? state.sessions.get(sessionId) : undefined;
  if (!session) respondError(msg.id, -32602, `Invalid params: unknown sessionId ${String(sessionId)}`);
  return session;
}

// ---------- 方法处理 ----------
async function handleInitialize(msg) {
  if (state.scenario === 'slow-response') {
    log(`initialize delayed ${SLOW_INIT_MS}ms (slow-response)`);
    await sleep(SLOW_INIT_MS);
  }
  const nativeSubagentCapabilities = msg.params?.clientCapabilities?._meta?.jetbrains?.air?.capabilities;
  log(`initialize nativeSubagentSessions=${String(Array.isArray(nativeSubagentCapabilities) && nativeSubagentCapabilities.includes('nativeSubagentSessions'))}`);
  // AgentCapabilities：happy 系全能力；minimal-caps 仅基线。
  // fixture 基线来自 Devin 3000.4.25 历史实测：{ list, delete, additionalDirectories }，无 close；
  // 清理矩阵的 scenario 旋钮（no-delete / cleanup-close-delete）改写 delete/close 两键。
  const sessionCapabilities = fullCaps()
    ? {
        list: {},
        ...(ADVERTISE_RESUME ? { resume: {} } : {}),
        ...(ADVERTISE_FORK ? { fork: {} } : {}),
        ...(advertisesDelete() ? { delete: {} } : {}),
        ...(advertisesClose() ? { close: {} } : {}),
        additionalDirectories: {},
      }
    : {};
  const agentCapabilities = fullCaps()
    ? {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: process.env.MOCK_MCP_HTTP === '1', sse: false },
        sessionCapabilities,
        auth: {},
      }
    : {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities,
        auth: {},
      };
  respond(msg.id, {
    protocolVersion: 1,
    agentCapabilities,
    authMethods: [],
    agentInfo: { name: 'dsh-mock-acp-agent', title: 'DSH Mock ACP Agent', version: '1.0.0' },
  });
}

function sessionMcpServers(msg) {
  if (process.env.MOCK_PROFILE === 'devin' && process.env.XDG_CONFIG_HOME?.includes('dsh-acp-team-')) {
    const config = JSON.parse(fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/devin/mcp_config.json`, 'utf8'));
    return Object.entries(config.mcpServers).filter(([name]) => name.startsWith('dshteam_')).map(([name, server]) => ({ name, type: 'http', url: server.url, headers: [] }));
  }
  return msg.params?.mcpServers ?? [];
}

function handleSessionNew(msg) {
  const session = createSession(`mock-session-${++state.sessionSeq}`, msg.params?.cwd ?? '/mock/cwd');
  session.mcpServers = sessionMcpServers(msg);
  // 对齐 devin 实测流量（research/probe-output.log L55-58 先于 session/new 响应）：
  // 先主动推厂商扩展通知 + config_option_update + current_mode_update 快照，再回响应
  if (fullCaps() && !process.env.MOCK_CONTROLS_DELIVERY) {
    sendFrame({ jsonrpc: '2.0', method: '_cognition.ai/mcp/serversChanged', params: {} });
    if (session.configOptions) {
      sendUpdate(session.id, { sessionUpdate: 'config_option_update', configOptions: session.configOptions });
    }
    if (session.modes) {
      sendUpdate(session.id, { sessionUpdate: 'current_mode_update', currentModeId: session.modes.currentModeId });
    }
  }
  const result = { sessionId: session.id };
  if (process.env.MOCK_CONTROLS_DELIVERY === 'deferred') {
    result.configOptions = session.configOptions.filter(option => option.category === 'model');
  } else {
    if (session.modes) result.modes = session.modes;
    if (session.configOptions) result.configOptions = session.configOptions;
  }
  respond(msg.id, result);
}

function handleSessionLoad(msg) {
  const sessionId = msg.params?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    return respondError(msg.id, -32602, 'Invalid params: sessionId required');
  }
  if (state.scenario === 'load-fail') {
    log(`session/load ${sessionId} fails by scenario (load-fail)`);
    return respondError(msg.id, -32603, 'mock: session/load failed (load-fail scenario)');
  }
  const session = state.sessions.get(sessionId) ?? createSession(sessionId, msg.params?.cwd ?? '/mock/cwd');
  session.mcpServers = sessionMcpServers(msg);
  const replay = session.recordedHistory?.length > 0 ? session.recordedHistory : LOAD_REPLAY;
  log(`session/load ${session.id}: replaying ${replay.length} updates`);
  for (const update of replay) sendUpdate(session.id, update);
  const result = {};
  if (session.modes) result.modes = session.modes;
  if (session.configOptions) result.configOptions = session.configOptions;
  respond(msg.id, result);
}

function handleSessionResume(msg) {
  if (!ADVERTISE_RESUME) {
    return respondError(msg.id, -32601, 'Method not found: session/resume');
  }
  const session = getSession(msg);
  if (!session) return;
  session.closed = false;
  session.mcpServers = sessionMcpServers(msg);
  log(`session/resume ${session.id}: no replay`);
  const result = {};
  if (session.modes) result.modes = session.modes;
  if (session.configOptions) result.configOptions = session.configOptions;
  respond(msg.id, result);
}

function handleSessionFork(msg) {
  const parent = getSession(msg);
  if (!parent) return;
  if (!ADVERTISE_FORK) return respondError(msg.id, -32601, 'Method not found: session/fork');
  const child = createSession(`mock-session-${++state.sessionSeq}`, msg.params?.cwd ?? parent.cwd);
  child.configOptions = parent.configOptions ? JSON.parse(JSON.stringify(parent.configOptions)) : null;
  child.modes = parent.modes ? JSON.parse(JSON.stringify(parent.modes)) : null;
  log(`session/fork parent=${parent.id} child=${child.id}`);
  const result = { sessionId: child.id };
  if (child.modes) result.modes = child.modes;
  if (child.configOptions) result.configOptions = child.configOptions;
  respond(msg.id, result);
}

function handleSessionList(msg) {
  const cwd = msg.params?.cwd;
  const all = [...state.sessions.values()]
    .filter((s) => !cwd || s.cwd === cwd)
    .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: `Mock session ${s.id}`, updatedAt: FIXED_TIMESTAMP }));
  respond(msg.id, { sessions: all });
}

function handleSessionDelete(msg) {
  if (state.scenario === 'delete-fail') {
    log('session/delete fails by scenario (delete-fail)');
    return respondError(msg.id, -32603, 'mock: session/delete failed (delete-fail scenario)');
  }
  if (state.scenario === 'no-delete') {
    // 未广告 delete 的 agent 视该方法为未实现（对齐 minimal-caps 的 -32601 口径）
    return respondError(msg.id, -32601, 'Method not found: session/delete');
  }
  const sessionId = msg.params?.sessionId;
  if (!state.sessions.has(sessionId)) {
    return respondError(msg.id, -32602, `Invalid params: unknown sessionId ${String(sessionId)}`);
  }
  state.sessions.delete(sessionId);
  log(`session/delete ${sessionId}`);
  respond(msg.id, {});
}

function handleSessionClose(msg) {
  const sessionId = msg.params?.sessionId;
  const session = state.sessions.get(sessionId);
  if (!session) {
    return respondError(msg.id, -32602, `Invalid params: unknown sessionId ${String(sessionId)}`);
  }
  // 规范：close 隐含 cancel 当前进行中的工作。会话条目保留在表内（标记
  // closed）——close 只结束活动会话，delete 才删除持久状态；真机 devin 的
  // list 在 close 后仍列出该会话，delete 对已 close 会话合法（清理
  // 次序 close→delete 依赖此语义）。
  session.turn?.cancel();
  session.closed = true;
  log(`session/close ${sessionId}`);
  respond(msg.id, {});
}

// ---------- prompt turns ----------
async function runUpdateTurn(session, msg, updates) {
  const turn = {
    cancelled: false,
    cancel() { this.cancelled = true; },
  };
  session.turn = turn;
  // recorded-replay 记录面：turn 开始时先把当前发布 prompt 的文本块合成为
  // user_message_chunk（ACP 回放语义含 user 消息），其后逐条记录实际发出的 update
  session.recordedHistory ??= [];
  for (const block of Array.isArray(msg.params?.prompt) ? msg.params.prompt : []) {
    if (block && typeof block.text === 'string') {
      session.recordedHistory.push({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: block.text },
        messageId: 'mock-recorded-user',
      });
    }
  }
  try {
    for (const update of updates) {
      if (turn.cancelled) return respond(msg.id, { stopReason: 'cancelled' });
      session.recordedHistory.push(update);
      sendUpdate(session.id, update);
      await sleep(STEP_DELAY_MS);
    }
    respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' });
  } finally {
    session.turn = null;
  }
}

async function runNativeSubagentTurn(session, msg) {
  const childSessionId = `${session.id}-child-1`;
  sendUpdate(session.id, {
    sessionUpdate: 'subagent_spawned', subagentSessionId: childSessionId,
    name: 'Research', task: 'Inspect source', capabilities: { cancel: true, close: true },
  });
  await sleep(STEP_DELAY_MS);
  sendUpdate(childSessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child result' }, messageId: 'mock-child-message-1',
  });
  await sleep(STEP_DELAY_MS);
  sendUpdate(session.id, {
    sessionUpdate: 'subagent_state_update', subagentSessionId: childSessionId, state: 'completed',
  });
  await sleep(STEP_DELAY_MS);
  sendUpdate(session.id, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root result' }, messageId: 'mock-root-message-1',
  });
  respond(msg.id, { stopReason: 'end_turn' });
}

async function runPermissionTurn(session, msg) {
  const turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      this.cancelWait?.();
    },
  };
  session.turn = turn;
  try {
    sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I need to run a shell command.' }, messageId: 'mock-msg-1' });
    await sleep(STEP_DELAY_MS);
    if (turn.cancelled) return respond(msg.id, { stopReason: 'cancelled' });
    sendUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'mock-tool-perm-1',
      title: 'Run: echo hello',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo hello' },
    });
    await sleep(STEP_DELAY_MS);
    if (turn.cancelled) return respond(msg.id, { stopReason: 'cancelled' });

    // 发出 session/request_permission，等待 client 决策或 cancel
    const permissionPromise = sendAgentRequest('session/request_permission', {
      sessionId: session.id,
      toolCall: {
        toolCallId: 'mock-tool-perm-1',
        title: 'Run: echo hello',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo hello' },
      },
      options: PERMISSION_OPTIONS,
    });
    const result = await new Promise((resolve) => {
      turn.cancelWait = () => resolve(null);
      permissionPromise.then(resolve);
    });

    if (turn.cancelled || !result || result.outcome?.outcome === 'cancelled') {
      log('permission outcome=cancelled');
      return respond(msg.id, { stopReason: 'cancelled' });
    }
    const optionId = result.outcome?.optionId ?? '<none>';
    log(`permission outcome=selected optionId=${optionId}`);
    await sleep(STEP_DELAY_MS);

    if (typeof optionId === 'string' && optionId.startsWith('allow')) {
      sendUpdate(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mock-tool-perm-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'hello\n' } }],
        rawOutput: { exitCode: 0 },
      });
      await sleep(STEP_DELAY_MS);
      sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Command finished.' }, messageId: 'mock-msg-1' });
    } else {
      sendUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId: 'mock-tool-perm-1', status: 'failed' });
      await sleep(STEP_DELAY_MS);
      sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Permission denied.' }, messageId: 'mock-msg-1' });
    }
    respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' });
  } finally {
    session.turn = null;
  }
}

// Turn 中途请求 form elicitation，记录 client 应答后继续输出；
// 协议测试分别验证默认 decline 和已注册 handler 的应答。
async function runElicitationTurn(session, msg) {
  const turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      this.cancelWait?.();
    },
  };
  session.turn = turn;
  try {
    sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I need structured input. ' }, messageId: 'mock-msg-1' });
    await sleep(STEP_DELAY_MS);
    if (turn.cancelled) return respond(msg.id, { stopReason: 'cancelled' });
    const elicitationPromise = sendAgentRequest('elicitation/create', {
      mode: 'form',
      sessionId: session.id,
      message: 'Provide the deployment target.',
      requestedSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Deployment target name' },
        },
        required: ['target'],
      },
    });
    const result = await new Promise((resolve) => {
      turn.cancelWait = () => resolve(null);
      elicitationPromise.then(resolve);
    });
    if (turn.cancelled || !result) {
      log('elicitation aborted (cancelled)');
      return respond(msg.id, { stopReason: 'cancelled' });
    }
    // 将 client 应答记入日志，供协议测试核对。
    log(`elicitation response ${JSON.stringify(result)}`);
    sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Elicitation answered with action=${String(result.action)}; continuing in plain text.` }, messageId: 'mock-msg-1' });
    await sleep(STEP_DELAY_MS);
    respond(msg.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' });
  } finally {
    session.turn = null;
  }
}

function runCrashTurn(session, msg) {
  const turn = {
    cancelled: false,
    cancel() { this.cancelled = true; },
  };
  session.turn = turn;
  sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial' }, messageId: 'mock-msg-1' });
  // 第二帧写盘回调里退出，避免管道缓冲截断；prompt 永远没有响应
  sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' output' }, messageId: 'mock-msg-1' }, () => {
    log('crash-mid-turn: exit(1) without prompt response');
    process.exit(1);
  });
}

// cancel-stuck：prompt 发一条 chunk 后永不响应；session/cancel 照常记录
// （handleNotification 的 turn.cancel 置位），但 turn 故意不停——client 侧的
// cancel 升级阶梯（限时等待 → 进程 terminate）只能走 SIGTERM 梯子收掉本进程
function runCancelStuckTurn(session, msg) {
  const turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      log('cancel-stuck: session/cancel received; turn intentionally NOT stopped (no prompt response)');
    },
  };
  session.turn = turn;
  sendUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Stuck turn working' }, messageId: 'mock-stuck-1' });
  log('cancel-stuck: prompt will never be answered');
  // 永不 respond；session.turn 保持悬挂，进程只可能被外部 terminate
}

function handlePrompt(msg) {
  const session = getSession(msg);
  if (!session) return;
  if (session.closed) {
    return respondError(msg.id, -32602, `Invalid params: session ${String(msg.params?.sessionId)} is closed`);
  }
  if (session.turn) return respondError(msg.id, -32603, 'turn already active on this session');
  if (EMIT_NATIVE_SUBAGENT) return void runNativeSubagentTurn(session, msg);
  switch (state.scenario) {
    case 'regression':
      return void regressionTurn(session, msg, { sendUpdate, sendAgentRequest, respond, log });
    case 'minimal-caps':
      return void runUpdateTurn(session, msg, MINIMAL_TURN_UPDATES);
    case 'rich-content':
      return void runUpdateTurn(session, msg, richContentTurnUpdates(session.cwd));
    case 'permission-flow':
      return void runPermissionTurn(session, msg);
    case 'elicitation':
      return void runElicitationTurn(session, msg);
    case 'crash-mid-turn':
      return void runCrashTurn(session, msg);
    case 'cancel-stuck':
      return void runCancelStuckTurn(session, msg);
    default:
      return void runUpdateTurn(session, msg, happyTurnUpdates(session.cwd));
  }
}

function handleSetConfigOption(msg) {
  const session = getSession(msg);
  if (!session) return;
  const { configId, value } = msg.params ?? {};
  const option = session.configOptions?.find((o) => o.id === configId);
  if (!option) {
    return respondError(msg.id, -32602, `Invalid params: unknown configId ${String(configId)}`);
  }
  if (state.scenario === 'config-write-fail') {
    // 拒绝写入且不应用值，验证 RPC 错误不会破坏连接。
    log(`set_config_option configId=${configId} value=${JSON.stringify(value)} (refused by scenario)`);
    return respondError(msg.id, -32603, 'config write refused by scenario (config-write-fail)');
  }
  option.currentValue = value;
  if ((option.category === 'model' || configId === 'model') && typeof value === 'string') {
    const levels = thoughtLevelsForModel(value);
    const thought = session.configOptions?.find((candidate) => candidate.id === 'thought_level');
    if (levels !== undefined && thought?.type === 'select') {
      thought.currentValue = levels[0];
      thought.options = levels.map((level) => ({ value: level, name: level[0].toUpperCase() + level.slice(1) }));
    }
  }
  log(`set_config_option configId=${configId} value=${JSON.stringify(value)}`);
  // 规范：回完整 configOptions 快照（切换可能连带改变其他选项）
  respond(msg.id, { configOptions: session.configOptions });
  // 双发保持一致（协议过渡期指引）：写 mode 类 config option 且 legacy modes 在场时，
  // 同步 modes 一面并补推 current_mode_update
  if ((option.category === 'mode' || configId === 'mode') && session.modes
    && session.modes.availableModes.some((m) => m.id === value)) {
    session.modes.currentModeId = value;
    sendUpdate(session.id, { sessionUpdate: 'current_mode_update', currentModeId: value });
  }
}

function handleSetMode(msg) {
  const session = getSession(msg);
  if (!session) return;
  const modeId = msg.params?.modeId;
  if (!session.modes || !session.modes.availableModes.some((m) => m.id === modeId)) {
    return respondError(msg.id, -32602, `Invalid params: unknown modeId ${String(modeId)}`);
  }
  session.modes.currentModeId = modeId;
  log(`set_mode modeId=${modeId}`);
  respond(msg.id, {});
  sendUpdate(session.id, { sessionUpdate: 'current_mode_update', currentModeId: modeId });
}

// minimal-caps 下未声明的可选方法视为未实现
const MINIMAL_CAPS_FORBIDDEN = new Set(['session/load', 'session/resume', 'session/list', 'session/delete', 'session/close']);

function handleRequest(msg) {
  const { id, method } = msg;
  log(`--> ${method} id=${JSON.stringify(id)}`);
  if (state.scenario === 'never-resolve' && NEVER_METHODS.has(method)) {
    // 永不响应——client 侧的 RPC deadline/poison 只能靠自己收束本请求
    log(`never-resolve: ${method} will never be answered`);
    return;
  }
  if (state.scenario === 'minimal-caps' && MINIMAL_CAPS_FORBIDDEN.has(method)) {
    return respondError(id, -32601, `Method not found: ${method}`);
  }
  switch (method) {
    case 'initialize':
      return void handleInitialize(msg);
    case 'authenticate':
      return respond(id, {});
    case 'session/new':
      return handleSessionNew(msg);
    case 'session/load':
      return handleSessionLoad(msg);
    case 'session/resume':
      return handleSessionResume(msg);
    case 'session/fork':
      return handleSessionFork(msg);
    case 'session/list':
      return handleSessionList(msg);
    case 'session/delete':
      return handleSessionDelete(msg);
    case 'session/close':
      return handleSessionClose(msg);
    case 'session/prompt':
      return handlePrompt(msg);
    case 'session/set_config_option':
      return handleSetConfigOption(msg);
    case 'session/set_mode':
      return handleSetMode(msg);
    default:
      return respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(msg) {
  switch (msg.method) {
    case 'session/cancel': {
      const session = state.sessions.get(msg.params?.sessionId);
      log(`session/cancel sessionId=${msg.params?.sessionId} turnActive=${Boolean(session?.turn)}`);
      session?.turn?.cancel();
      break;
    }
    default:
      log(`notification ignored: ${msg.method}`);
  }
}

// ---------- 主循环 ----------
if (state.scenario === 'garbage-stdout') {
  // 故意污染 stdout 一行，验证 client 的非 JSON 帧容忍性
  process.stdout.write('mock-agent startup banner: this line is intentionally not valid JSON\n');
}
log(`started pid=${process.pid} stepDelayMs=${STEP_DELAY_MS}`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`parse error: ${trimmed.slice(0, 120)}`);
    return respondError(null, -32700, 'Parse error');
  }
  if (msg.method !== undefined && msg.id !== undefined) {
    handleRequest(msg);
  } else if (msg.method !== undefined) {
    handleNotification(msg);
  } else if (msg.id !== undefined) {
    // client → agent 响应（如 session/request_permission 的答复）
    const resolve = state.pendingAgentRequests.get(msg.id);
    if (resolve) {
      state.pendingAgentRequests.delete(msg.id);
      resolve(msg.error ? { outcome: { outcome: 'cancelled' } } : msg.result);
    } else {
      log(`orphan response id=${JSON.stringify(msg.id)} ignored`);
    }
  } else {
    respondError(msg.id ?? null, -32600, 'Invalid Request');
  }
});

rl.on('close', () => {
  if (state.scenario === 'eof-exit') {
    log('stdin EOF -> exit(0) (eof-exit)');
    process.exit(0);
  }
  // 默认行为：对齐 devin——stdin EOF 不退出，等 SIGTERM 级拆除
  log('stdin EOF; staying alive until SIGTERM');
});

process.on('SIGTERM', () => {
  log('SIGTERM received, exit(0)');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('SIGINT received, exit(0)');
  process.exit(0);
});

// 保持事件循环存活：EOF 后进程不得自然退出（默认 scenario）
setInterval(() => {}, 1 << 30);
