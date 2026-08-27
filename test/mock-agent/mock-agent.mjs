#!/usr/bin/env node
// mock-agent.mjs — 脚本化 mock ACP agent（ACP v1，stdio NDJSON JSON-RPC）。
//
// 零依赖纯 Node ESM：`node mock-agent.mjs` 直接运行。stdout 只出协议帧；
// 日志写 MOCK_LOG 指定的文件（append），未设置时走 stderr。
//
// scenario 选择：env MOCK_SCENARIO（默认 happy），或协议内控制帧
// {"jsonrpc":"2.0","id":N,"method":"mock/set_scenario","params":{"scenario":"..."}}。
//
// 已实现 scenario：
//   happy              全能力 + configOptions + 完整 prompt 更新流
//                      (thought→message×3→tool_call→tool_call_update→plan→usage_update→end_turn)。
//                      配置形态 = 「configOptions + legacy modes 双发」（真机 devin 3000.4.25
//                      实测形态，Devin ACP 真机验收）
//   minimal-caps       最小能力；未声明的可选方法（load/list/delete/close）一律 -32601；
//                      session/new 无 modes/configOptions；prompt 只发 message chunk
//   rich-content       同 happy 的 turn 骨架，tool_call_update 的 content 换成非文本
//                      类型混合（diff/terminal/image/resource text+ blob/resource_link）
// —— tool result fidelity e2e 用
//   mixed-turn         文本 + tool 交织的混合 turn：msg-1 → tool_call →
//                      tool_call_update → msg-2（不同 messageId）——分段对账的
//                      「live 混合 turn → dispose → resume 对账通过」真实闭环用
// empty-turn prompt 零更新直接 end_turn（ACP_EMPTY_RESPONSE 空响应
//                      说明消息的 e2e 夹具）
// terminal-merge-replay 混合 turn + claude 0.70.0 形态（非对称工具回放，
//                      Claude ACP 真机验收）：live 发**进行态占位**
//                      tool_call（占位标题、无 rawInput/locations/content），终态
//                      title/rawInput/locations/content 经进行中 tool_call_update
//                      帧到达，终态帧只带 status+rawOutput；session/load 回放时
//                      发**合并终态的单条 tool_call 帧**（终态事实全在帧上）——
//                      「live 占位帧 → resume 回放终态合并帧」对账一致的闭环回归用
//   no-config-options  能力正常，但 session/new 不携带 configOptions（仍有 modes）
//                      —— legacy-modes-only 形态：mode 只能走旧 session/set_mode
//   config-options-only 能力正常，session/new 只携带 configOptions、无 modes 字段
//                      —— 纯 configOptions 形态：session/set_mode 回 -32602，mode 只能走
//                      session/set_config_option
//   exotic-options     同 happy（双发），configOptions 追加三项：boolean（category
//                      model_config）+ 未知 category（telemetry）的 select + 未知 type
//                      （slider）——容错/分组路径用；实测官方 SDK 1.3.0 把未知 type 项
//                      原样保留上线（不丢弃），写路径由 options-sync 以 unsupported-type 拒
//   permission-flow    prompt 中途发 session/request_permission（4 个 option），按 outcome 继续，
//                      回传的 optionId 记录到 MOCK_LOG/stderr 供断言
//   elicitation        prompt 中途发 elicitation/create（form mode 合法请求），await
//                      client 响应并记录响应 JSON 到 MOCK_LOG（`elicitation response ...`），
// 再继续剩余 chunk 并 end_turn——decline 降级路径实测用
//   unknown-meta       同 happy，但 session/new 响应携带未知 `_meta`（unknownExt 嵌套对象），
//                      turn 内每条 update 携带未知 `_meta`，并追加一条未知 sessionUpdate
// 变体 `_future/thing`——边界「未知 _meta/extension 忽略且不使
//                      会话失败」的 e2e 钉版用
//   codex-shape        codex-acp 1.6.2（descriptor 钉版）事件形态 fixture：
//                      session/new 快照对齐 本机无 prompt 探针 留档（modes=read-only/agent/
//                      agent-full-access；configOptions=mode/collaboration_mode/model/
//                      reasoning_effort(category thought_level)/fast-mode(category
//                      model_config)）；turn 事件流对齐 1.6.2 dist 束——reasoning 走
//                      agent_thought_chunk、kind=search 带 locations、kind=execute
//                      挂 content[{type:'terminal'}]+_meta.terminal_info（终态帧带
//                      _meta.terminal_output/terminal_exit）、kind=edit 首帧带 diff
//                      内容项、标准 plan 全快照（priority 恒 medium）、
//                      session_info_update 带 _meta.codex、最终消息块带
//                      _meta.codex.phase='final_answer'、usage_update。翻译投影
//                      不降级/降级占位现状由 wiring.spec.ts 的  用例钉死
//   crash-mid-turn     prompt 发 2 个 message chunk 后 exit(1)，不给 prompt 响应
//   garbage-stdout     启动时先向 stdout 写一行非 JSON 文本，再正常跑协议（行为同 happy）
//   slow-response      initialize 延迟 MOCK_SLOW_INIT_MS（默认 5000ms）才回，其余同 happy
//   eof-exit           stdin EOF 后立即 exit(0)（与默认相反，对照用）
//   fs-probe           prompt 时经 /bin/sh 逐目标写文件（MOCK_FS_PROBE_WRITES，JSON 字符串
//                      数组），结果以一条 agent_message_chunk 回传
//                      {"fsProbeResults":[{path, ok, exitCode, stderr}], "envEcho":{XDG_*,TMPDIR,
//                      CODEX_HOME,KIMI_CODE_HOME,CLAUDE_CONFIG_DIR,ANTHROPIC_BASE_URL}}
// （沙箱实测用；经 shell 的子进程继承宿主 confinement）
//   commands           同 happy，另在 session/new 响应前推 available_commands_update
// （两条命令：mock-cmd / another-cmd； 命令桥 e2e 用）
//   list-fail          同 happy（广告 load/list 能力），但 session/list 一律回 -32603
// （恢复矩阵测试：list 调用失败不得据此降级，须继续试 load）
//   cleanup-close-delete 同 happy，但 sessionCapabilities 额外广告 close（{ list, close,
// delete, additionalDirectories }）—— probe 清理的
//                      close-then-delete 次序实测用（真机 devin 不广告 close）
//   delete-fail        同 happy（广告 delete），但 session/delete 一律回 -32603
// —— 清理失败路径：probe 仍成功、cleanup 记 'failed'、
//                      进程与临时目录照常回收
//   no-delete          同 happy，但 sessionCapabilities 不含 delete（{ list,
//                      additionalDirectories }），session/delete 回 -32601
// —— 「未广告 delete」降级路径
//   load-fail          同 happy，但 session/load 一律回 -32603
// （恢复矩阵测试：load 抛错 → load-failed 降级 session/new）
//   load-late-replay   同 happy，但 session/load 故意违反规范：先回响应，延迟
//                      MOCK_LATE_REPLAY_DELAY_MS 再发「回放残留」更新（规范要求回放完
// 全部 update 才回响应）——.5t 重连残留警告用
//   cancel-stuck       同 happy，但 prompt 发一条 chunk 后永不响应；session/cancel
// 照常记录但故意不停 turn——.6t cancel 升级阶梯（限时等待 →
//                      进程 terminate）实测用
//   never-resolve      同 happy，但 MOCK_NEVER_METHODS（JSON 字符串数组，默认
// ["session/new"]）列出的方法一律永不响应—— 全 RPC
//                      deadline/connection poison 矩阵用（每个 setup RPC 逐一挂起）
//   out-of-order-config 同 happy，但 set_config_option 乱序响应：第一笔挂起不回应，
//                      第二笔先回应（现状快照），再补第一笔的迟到响应（其当时快照）
// ——.6t config change generation 守卫实测用
//   config-write-fail  同 happy，但 session/set_config_option 恒回 -32603（值不应用）
// ——建立时模型收敛「写入未获确认 → 分叉说明 + turn 照常」用
//
// 真机对齐（devin 3000.4.25 实测，Devin ACP 真机验收）：
//   - sessionCapabilities 广告 { list, delete, additionalDirectories }（无 close；
//     session/close 处理器保留作测试便利，广告面对齐真机）；
//   - mode id 用 accept-edits（显示名 "Code"）等 5 项，modes 与 configOptions.mode
//     一一对应双发；set_config_option 写 mode 项时 mock 同步 modes 并补推
//     current_mode_update（协议过渡期「双发保持一致」指引；set_mode 只动 modes
//     一面——devin 写路径未实测，mock 取保守语义）；
//   - configOptions 默认只有 mode + model 两项 select（真机无 thought_level /
//     model_config / boolean）；thought_level 项改为显式开关 MOCK_THOUGHT_LEVEL=1
//     追加（真机的思考强度编码在模型值后缀 -low/-high/-max，不是独立选项）。
//
// 进程内存说明：session/list 只反映本进程生命周期内建立/预置的会话，fresh spawn 必为
// 空。恢复（resume）用例需要 fresh spawn 的 list 非空 → 用 MOCK_PRESET_SESSIONS 预置。
//
// 进程生命周期模拟：Devin 不响应 stdin EOF。
// 默认 scenario 下 stdin EOF 不退出，保持进程直到 SIGTERM/SIGINT；eof-exit 例外。
//
// 行为确定性：固定 sessionId 序号 / messageId / toolCallId / 时间戳（FIXED_TIMESTAMP），
// 同一 scenario + 同一请求序列 ⇒ stdout 字节级一致。
//
// 其他 env：
//   MOCK_STEP_DELAY_MS  turn 内每条 update 的间隔（默认 10ms），给 cancel 留插入窗口
//   MOCK_NEVER_METHODS  never-resolve 的永不响应方法集（JSON 字符串数组，默认
// ["session/new"]； RPC deadline/poison 矩阵用）
//   MOCK_SLOW_INIT_MS   slow-response 的 initialize 延迟（默认 5000ms）
//   MOCK_LOG            日志文件路径（append 模式）；缺省写 stderr
//   MOCK_AUTH_METHODS   initialize 响应的 authMethods（JSON 数组字符串，默认 []）
//   MOCK_PRESET_SESSIONS  启动时预置进内存会话表的 sessionId（JSON 字符串数组，默认 []），
//                      cwd 记为 '/mock/cwd'；modes/configOptions 按 scenario 能力照常
//   MOCK_LIST_PAGE_SIZE session/list 分页页大小（默认 0 = 单页全量，既有行为）；>0 时
//                      响应按 cursor（页号字符串）切片并在非末页携带 nextCursor
// MOCK_LOAD_REPLAY_VARIANT session/load 回放序列变换（默认 full； 对账矩阵用）：
//                      omit-assistant-tail（缺一条 assistant chunk）/ extra-user
//                      （尾部多一条 user chunk）/ empty（空回放）/
//                      omit-tool-call（Devin 被拒工具回放不对称 镜像：被拒 tool call 不进回放）/
//                      different-tool-args / different-tool-locations /
//                      different-tool-result（同 title 改参数/locations/结果——
//                      digest 对账的「必须判分叉」矩阵）
//   MOCK_LATE_REPLAY_DELAY_MS  load-late-replay 的残留发送延迟（默认 50ms）
//   MOCK_LATE_REPLAY_ON_COMMAND 置 '1' 时 load-late-replay 不用定时器：load 响应后
//                      残留挂起，直到 client 发来该会话的首笔 session/set_config_option
//                      ——mock 在响应之前先发残留。该 RPC 无 turn 括号（client 仅
//                      idle 时允许直发），mock 据此确知 client 处于 turn 外；而
//                      「end_turn 响应后立即发残留」会把响应与残留合并进同一次管道
//                      读取，client 的 turn 收口微任务链尚未跑完，残留被归属触发
// turn（inTurn 判定），一次性警告恒不触发（flake 根治）。
//   MOCK_THOUGHT_LEVEL 置 '1' 时 configOptions 追加 thought_level 三项（low/medium/high，
//                      current medium）——显式开关：真机 devin 无此选项（思考强度编码在
//                      模型值后缀），默认关闭以免给测试造成假印象
//   MOCK_RECORDINGS    recorded-replay 的持久化文件（JSON：{ [sessionId]: 更新流 }），
//                      默认 `${MOCK_LOG}.recordings.json`（无 MOCK_LOG 时禁用）。
//                      每个 prompt turn 实际发出的更新流（先合成 user_message_chunk，
//                      再按发送顺序记录全部 session update）在 turn 收束时落盘；
//                      session/load 对**有记录**的会话回放真实记录（跨进程恢复闭环），
//                      无记录（如 MOCK_PRESET_SESSIONS 预置会话）回退 LOAD_REPLAY 固定
//                      夹具（含 MOCK_LOAD_REPLAY_VARIANT 变换），旧用例行为不变。
import readline from 'node:readline';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const KNOWN_SCENARIOS = new Set([
  'happy',
  'minimal-caps',
  'rich-content',
  'mixed-turn',
  'empty-turn',
  'terminal-merge-replay',
  'no-config-options',
  'config-options-only',
  'exotic-options',
  'permission-flow',
  'elicitation',
  'unknown-meta',
  'codex-shape',
  'crash-mid-turn',
  'garbage-stdout',
  'slow-response',
  'eof-exit',
  'fs-probe',
  'commands',
  'list-fail',
  'cleanup-close-delete',
  'delete-fail',
  'no-delete',
  'load-fail',
  'load-late-replay',
  'cancel-stuck',
  'never-resolve',
  'out-of-order-config',
  'config-write-fail',
]);

const intEnv = (name, dflt) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const STEP_DELAY_MS = intEnv('MOCK_STEP_DELAY_MS', 10);
const SLOW_INIT_MS = intEnv('MOCK_SLOW_INIT_MS', 5000);
// initialize 响应的 authMethods（默认 []；probe 缓存透传测试用非空值）
const AUTH_METHODS = (() => {
  try {
    const parsed = JSON.parse(process.env.MOCK_AUTH_METHODS ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
// 启动时预置的会话 id（默认 []；恢复矩阵用——fresh spawn 的进程内存 list 必为空）
const PRESET_SESSIONS = (() => {
  try {
    const parsed = JSON.parse(process.env.MOCK_PRESET_SESSIONS ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
})();
const LIST_PAGE_SIZE = intEnv('MOCK_LIST_PAGE_SIZE', 0);
// never-resolve：永不响应的方法集合（RPC deadline 矩阵；默认只挂 session/new）
const NEVER_METHODS = (() => {
  try {
    const parsed = JSON.parse(process.env.MOCK_NEVER_METHODS ?? '["session/new"]');
    return new Set(Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
})();
// load-late-replay：load 响应后多久才发残留更新（默认 50ms——足以让 client 侧
// 完成 load 收束与 translator 建立，又短到不让测试干等）
const LATE_REPLAY_DELAY_MS = intEnv('MOCK_LATE_REPLAY_DELAY_MS', 50);
// 置 '1'：load-late-replay 残留改由魔法文本 prompt 触发（确定性，无定时器）
const LATE_REPLAY_ON_COMMAND = process.env.MOCK_LATE_REPLAY_ON_COMMAND === '1';

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
// legacy modes 字段：config-options-only 形态不发（纯 configOptions agent）
const hasModes = () => fullCaps() && state.scenario !== 'config-options-only';
// thought_level 显式开关（真机 devin 无此选项；MOCK_THOUGHT_LEVEL=1 才追加）
const THOUGHT_LEVEL = process.env.MOCK_THOUGHT_LEVEL === '1';
// 清理矩阵的广告旋钮（真机 devin：delete 有、close 无）：
//   no-delete 不广告 delete；cleanup-close-delete 额外广告 close。
const advertisesDelete = () => fullCaps() && state.scenario !== 'no-delete';
const advertisesClose = () => state.scenario === 'cleanup-close-delete';

// ---------- 固定脚本数据（对齐 reference/agent-client-protocol/schema/v1/schema.json） ----------
// mode 集合对齐 devin 3000.4.25 实测：id accept-edits（显示名 "Code"）等 5 项，
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
  if (THOUGHT_LEVEL) {
    options.push({
      id: 'thought_level',
      name: 'Thought Level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    });
  }
  if (state.scenario === 'exotic-options') {
    // 容错/分组路径：boolean（已知类型）+ 未知 category（已知类型）+ 未知 type。
    // 注意 boolean 需 client 广告 session.configOptions.boolean 才合规——本 scenario
    // 刻意扮演不严格 agent；实测官方 SDK 1.3.0 不丢弃未知 type 项（原样上线，写路径
    // 由 options-sync 以 unsupported-type 拒）。
    options.push(
      {
        id: 'auto_compact',
        name: 'Auto Compact',
        description: 'Compact context automatically when full',
        category: 'model_config',
        type: 'boolean',
        currentValue: false,
      },
      {
        id: 'telemetry',
        name: 'Telemetry',
        category: 'telemetry',
        type: 'select',
        currentValue: 'off',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'on', name: 'On' },
        ],
      },
      {
        id: 'temperature',
        name: 'Temperature',
        category: 'model_config',
        type: 'slider',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    );
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

// 文本 + tool 交织的混合 turn——wire 序是 msg-1 → tool_call →
// tool_call_update → msg-2（不同 messageId）。live 落盘时 tool/call 即时落盘、
// assistant/message 在 endTurn 聚合落盘，DSH 日志序因此与回放 wire 序不同
// （分段对账的真实闭环夹具）。
function mixedTurnUpdates(cwd) {
  return [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me read the file.' }, messageId: 'mock-msg-1' },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'mock-tool-mixed-1',
      title: 'Read notes.txt',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: `${cwd}/notes.txt` }],
      rawInput: { path: 'notes.txt' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-tool-mixed-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'notes body' } }],
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done reading.' }, messageId: 'mock-msg-2' },
  ];
}

// 非对称工具回放（claude-agent-acp 0.70.0 实证形态，Claude ACP 真机验收
// evidence/21-replay-updates.jsonl 的 live 对应面）：live 的 tool_call 首帧是进行态
// 占位（占位标题 `Preparing file…`、无 rawInput、locations 空、无 content）；终态
// title/rawInput/locations/content 经**进行中** tool_call_update 帧到达；终态帧只带
// status+rawOutput（无 content）。
function terminalMergeTurnUpdates(cwd) {
  return [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will write the file. ' }, messageId: 'mock-msg-1' },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'mock-tool-merge-1',
      title: 'Preparing file…',
      kind: 'edit',
      status: 'pending',
      locations: [],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-tool-merge-1',
      status: 'in_progress',
      title: `Write ${cwd}/merged.txt`,
      locations: [{ path: `${cwd}/merged.txt` }],
      rawInput: { file_path: `${cwd}/merged.txt`, content: 'merged-ok' },
      content: [{ type: 'diff', path: `${cwd}/merged.txt`, oldText: null, newText: 'merged-ok' }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-tool-merge-1',
      status: 'completed',
      rawOutput: `File created successfully at: ${cwd}/merged.txt`,
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'mock-msg-1' },
  ];
}

// terminal-merge-replay 的回放变换（学 claude session/load 的「终态合并」形态，
// evidence/21-replay-updates.jsonl）：每个 tool 的中间 update 帧事实 latest-wins 合并
// 进其 tool_call 帧（帧本身保留在原位置，status 保持首帧的 pending）；中间帧消失；
// 终态 update 帧保留但只带 status/rawOutput（content 已合并进 tool_call 帧）。
function terminalMergeReplay(updates) {
  const indexByCallId = new Map();
  const out = [];
  for (const update of updates) {
    if (update.sessionUpdate === 'tool_call') {
      indexByCallId.set(update.toolCallId, out.length);
      out.push({ ...update });
    } else if (update.sessionUpdate === 'tool_call_update' && indexByCallId.has(update.toolCallId)) {
      const frame = out[indexByCallId.get(update.toolCallId)];
      if (update.status === 'completed' || update.status === 'failed') {
        const terminal = { sessionUpdate: 'tool_call_update', toolCallId: update.toolCallId, status: update.status };
        if (update.rawOutput !== undefined) terminal.rawOutput = update.rawOutput;
        out.push(terminal);
      } else {
        for (const key of ['title', 'kind', 'locations', 'rawInput', 'content']) {
          if (update[key] !== undefined && update[key] !== null) frame[key] = update[key];
        }
      }
    } else {
      out.push(update);
    }
  }
  return out;
}

// ----------：codex-acp 1.6.2 事件形态 fixture ----------
// 依据：本机全局安装的 @agentclientprotocol/codex-acp@1.6.2 dist 束（只读参考：
// createTerminalCommandEvent / createPatchContent / createWebSearchStartUpdate /
// createCodexMessagePhaseMeta 等工厂）+ 本机无 prompt 探针/
// codex-20260823-024355.json（无 prompt 探针的 session/new 快照留档）。
// 与 devin/claude 的形态差异（wiring.spec.ts  用例逐一钉版）：
//   - execute 工具：终端输出挂 content[{type:'terminal', terminalId}] +
//     _meta.terminal_info；终态帧的 stdout 走 _meta.terminal_output/terminal_exit
//     （当前测试 UI 未提供 terminal 实时 seam → 翻译层落 terminal 占位 + degradation 审计）；
//   - edit 工具：patch 以 {type:'diff'} 内容项随 tool_call 首帧到达（→ diff 摘要
//     降级——完整 patch 字节不入日志）；
//   - 消息块带 _meta.codex.phase 标记（未知 _meta 忽略，文本原样不降级）；
//   - reasoning 走标准 agent_thought_chunk；plan 走标准 plan 变体全快照
//     （codex update_plan 的 entries priority 恒 medium——codex 不产 priority 事实）；
//   - session_info_update 带 _meta.codex（标准 v1 变体，翻译层现状：忽略不产生事件）。

// session/new 快照（codex-20260823-024355.json：modes 3 项、configOptions 5 项）
const CODEX_MODE_ENTRIES = [
  { id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and run commands.' },
  { id: 'agent', name: 'Agent', description: 'Read and edit files, and run commands.' },
  { id: 'agent-full-access', name: 'Agent (full access)', description: 'Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.' },
];

function codexModes() {
  return {
    currentModeId: 'agent',
    availableModes: CODEX_MODE_ENTRIES.map(({ id, name, description }) => ({ id, name, description })),
  };
}

function codexConfigOptions() {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Approval and sandboxing preset for the session',
      category: 'mode',
      type: 'select',
      currentValue: 'agent',
      options: CODEX_MODE_ENTRIES.map(({ id, name, description }) => ({ value: id, name, description })),
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      description: 'How Codex collaborates for subsequent turns',
      category: 'collaboration_mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      description: 'Model Codex uses for the session',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5.6-sol',
      options: [
        { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.' },
        { value: 'gpt-5.5', name: 'GPT-5.5', description: 'Frontier model for complex coding, research, and real-world work.' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      description: 'How much reasoning effort the model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: 'xhigh',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Xhigh' },
      ],
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      description: '1.5x speed, increased usage',
      category: 'model_config',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off', description: 'Default speed, normal usage' },
        { value: 'on', name: 'On', description: '1.5x speed, increased usage' },
      ],
    },
  ];
}

function codexShapeTurnUpdates(cwd) {
  return [
    // reasoning 摘要（标准 agent_thought_chunk；codex reasoning item → thought chunk）
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reasoning about the codex request.' }, messageId: 'codex-reasoning-1' },
    // 模糊文件搜索（kind search + locations + rawInput query——createSearchStartUpdate 形态）
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'codex-tool-search-1',
      title: `Search for 'needle' in ${cwd}`,
      kind: 'search',
      status: 'in_progress',
      locations: [{ path: `${cwd}/src/a.ts` }, { path: `${cwd}/src/b.ts` }],
      rawInput: { query: 'needle' },
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'codex-tool-search-1', status: 'completed' },
    // shell 命令（kind execute；createTerminalCommandEvent 形态：content 挂 terminal
    // 占位引用 + _meta.terminal_info；终态帧带 rawOutput + _meta.terminal_output/
    // terminal_exit——_meta 里的输出字节不进日志，terminal 内容项触发降级占位）
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'codex-tool-exec-1',
      title: 'echo codex-shape',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo codex-shape', cwd },
      content: [{ type: 'terminal', terminalId: 'codex-tool-exec-1' }],
      _meta: { terminal_info: { cwd, terminal_id: 'codex-tool-exec-1' } },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'codex-tool-exec-1',
      status: 'completed',
      rawOutput: { formatted_output: 'codex-shape\n', exit_code: 0 },
      _meta: {
        terminal_output: { data: 'codex-shape\n', terminal_id: 'codex-tool-exec-1' },
        terminal_exit: { exit_code: 0, signal: null, terminal_id: 'codex-tool-exec-1' },
      },
    },
    // 文件改动（kind edit；createFileChangeUpdate/createPatchContent 形态：diff 内容项
    // 随 tool_call 首帧到达，终态帧只带 status——diff 走摘要降级）
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'codex-tool-edit-1',
      title: 'Editing files',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: `${cwd}/notes.txt`, oldText: 'old notes\n', newText: 'new notes\n' }],
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'codex-tool-edit-1', status: 'completed' },
    // 标准 plan 全快照（codex update_plan → plan 变体；priority 恒 medium）
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Search for the needle', priority: 'medium', status: 'completed' },
        { content: 'Apply the edit', priority: 'medium', status: 'completed' },
      ],
    },
    // 会话元信息（标准 session_info_update + _meta.codex；翻译层忽略，不产生事件）
    { sessionUpdate: 'session_info_update', title: 'Codex session', _meta: { codex: { threadStatus: { type: 'idle' } } } },
    // 最终答复（createTextEvent 形态：messageId=itemId + _meta.codex.phase）
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: applied the codex-shaped edit.' }, messageId: 'codex-msg-final', _meta: { codex: { phase: 'final_answer' } } },
    { sessionUpdate: 'usage_update', used: 4321, size: 258400 },
  ];
}

const MINIMAL_TURN_UPDATES = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Minimal reply.' }, messageId: 'mock-msg-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' }, messageId: 'mock-msg-1' },
];

// happy 骨架 + 每条 update 携带未知 `_meta` + 末尾追加一条未知
// sessionUpdate 变体 `_future/thing`（SDK 校验层丢弃该变体——通知验证失败仅
// console.error，连接不断；translate.ts 的 default 分支是第二道兜底）。
function unknownMetaTurnUpdates(cwd) {
  return [
    ...happyTurnUpdates(cwd).map((update) => ({ ...update, _meta: { unknownExt: { flag: true } } })),
    { sessionUpdate: '_future/thing', note: 'session update variant unknown to this build' },
  ];
}

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

// MOCK_LOAD_REPLAY_VARIANT（对账矩阵）：对 LOAD_REPLAY 做确定性变换。
// 缺省 full = 原样全量回放。
const LOAD_REPLAY_VARIANT = process.env.MOCK_LOAD_REPLAY_VARIANT ?? 'full';
function loadReplayUpdates() {
  switch (LOAD_REPLAY_VARIANT) {
    case 'omit-assistant-tail':
      // 可见历史缺失：assistant 少一截 → 对账 replay-diverged
      return LOAD_REPLAY.filter((update) => update.content?.text !== ' + part 2');
    case 'extra-user':
      // 回放多于 DSH 期望 → 对账 dsh-log-truncated
      return [
        ...LOAD_REPLAY,
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Injected extra user message' }, messageId: 'mock-load-msg-extra-user' },
      ];
    case 'omit-tool-call':
      // Devin 被拒工具回放不对称 镜像：被拒 tool call 不进 agent 回放（devin 实证行为）→ 对账 replay-diverged
      return LOAD_REPLAY.filter((update) => update.toolCallId !== 'mock-load-tool-1');
    case 'different-tool-args':
      // 同 title 不同 raw input（前会被误判同一历史）→ digest 对账 replay-diverged
      return LOAD_REPLAY.map((update) =>
        update.toolCallId === 'mock-load-tool-1' && update.sessionUpdate === 'tool_call'
          ? { ...update, rawInput: { path: 'tampered.txt' } }
          : update);
    case 'different-tool-locations':
      // 同 title 不同 locations → digest 对账 replay-diverged
      return LOAD_REPLAY.map((update) =>
        update.toolCallId === 'mock-load-tool-1' && update.sessionUpdate === 'tool_call'
          ? { ...update, locations: [{ path: '/mock/cwd/tampered.txt' }] }
          : update);
    case 'different-tool-result':
      // 同 title 同参数、结果内容不同 → digest 对账 replay-diverged
      return LOAD_REPLAY.map((update) =>
        update.toolCallId === 'mock-load-tool-1' && update.sessionUpdate === 'tool_call_update'
          ? { ...update, content: [{ type: 'content', content: { type: 'text', text: 'tampered contents' } }] }
          : update);
    case 'empty':
      return [];
    default:
      return LOAD_REPLAY;
  }
}

// ---------- recorded-replay（真实闭环：session/load 回放该会话实际收到过的更新流） ----------
// 记录面在 runUpdateTurn：turn 开始时先把 prompt 的文本块合成 user_message_chunk
// 入记录，其后每条实际发出的 update 按序入记录，turn 收束（含 cancel 分支）时
// 落盘。落盘按 sessionId 键控——resume 的 fresh spawn 进程内存为空，靠文件跨
// 进程找回旧会话的更新流。写失败只记日志（mock 便利面，不翻转 turn 成败）。
const RECORDINGS_PATH = process.env.MOCK_RECORDINGS ?? (MOCK_LOG !== undefined ? `${MOCK_LOG}.recordings.json` : undefined);

function readRecordings() {
  if (RECORDINGS_PATH === undefined) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(RECORDINGS_PATH, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistRecording(session) {
  if (RECORDINGS_PATH === undefined) return;
  if (!Array.isArray(session.recordedHistory) || session.recordedHistory.length === 0) return;
  try {
    const all = readRecordings();
    all[session.id] = session.recordedHistory;
    fs.writeFileSync(RECORDINGS_PATH, `${JSON.stringify(all)}\n`);
  } catch (error) {
    log(`recorded-replay persist failed: ${String(error)}`);
  }
}

// load-late-replay 的「迟到回放残留」（spec 违规者的 post-response 流量）：
// 首条是幂等状态槽更新（config_option_update——client 侧不应触发残留警告），
// 其后两条是内容类更新（触发一次性警告，内容照常无损落盘）
const LATE_REPLAY_RESIDUE = (session) => [
  { sessionUpdate: 'config_option_update', configOptions: session.configOptions },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Late replay residue, part 1' }, messageId: 'mock-late-replay-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + part 2' }, messageId: 'mock-late-replay-1' },
];

const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
];

// ---------- 会话 ----------
function createSession(id, cwd) {
  // codex-shape：session 快照对齐 codex-acp 1.6.2 实证形态（见上  fixture）
  const codex = state.scenario === 'codex-shape';
  const session = {
    id,
    cwd,
    modes: hasModes() ? (codex ? codexModes() : freshModes()) : null,
    configOptions: hasConfigOptions() ? (codex ? codexConfigOptions() : freshConfigOptions()) : null,
    turn: null, // { cancelled, cancel(), cancelWait? }
    closed: false, // session/close 后置位：prompt 拒绝（-32602），delete 仍合法
  };
  state.sessions.set(id, session);
  return session;
}

// 预置会话落座（MOCK_PRESET_SESSIONS）：协议开始前填充进程内存表，session/list
// 首查即非空；modes/configOptions 随 scenario 能力（同 session/new 的构造路径）
for (const presetId of PRESET_SESSIONS) createSession(presetId, '/mock/cwd');
if (PRESET_SESSIONS.length > 0) log(`preset sessions: ${PRESET_SESSIONS.join(', ')}`);

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
  // AgentCapabilities：happy 系全能力；minimal-caps 仅基线。
  // sessionCapabilities 对齐 devin 3000.4.25 实测：{ list, delete, additionalDirectories }，无 close；
 // 清理矩阵的 scenario 旋钮（no-delete / cleanup-close-delete）改写 delete/close 两键。
  const sessionCapabilities = fullCaps()
    ? {
        list: {},
        ...(advertisesDelete() ? { delete: {} } : {}),
        ...(advertisesClose() ? { close: {} } : {}),
        additionalDirectories: {},
      }
    : {};
  const agentCapabilities = fullCaps()
    ? {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
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
    authMethods: AUTH_METHODS,
    agentInfo: { name: 'dsh-mock-acp-agent', title: 'DSH Mock ACP Agent', version: '1.0.0' },
  });
}

function handleSessionNew(msg) {
  const session = createSession(`mock-session-${++state.sessionSeq}`, msg.params?.cwd ?? '/mock/cwd');
  // 对齐 devin 实测流量（research/probe-output.log L55-58 先于 session/new 响应）：
  // 先主动推厂商扩展通知 + config_option_update + current_mode_update 快照，再回响应
  if (fullCaps()) {
    sendFrame({ jsonrpc: '2.0', method: '_cognition.ai/mcp/serversChanged', params: {} });
    if (session.configOptions) {
      sendUpdate(session.id, { sessionUpdate: 'config_option_update', configOptions: session.configOptions });
    }
    if (session.modes) {
      sendUpdate(session.id, { sessionUpdate: 'current_mode_update', currentModeId: session.modes.currentModeId });
    }
    if (state.scenario === 'commands') {
 // 命令桥 e2e：session/new 响应前推 available_commands_update（全量替换语义）
      sendUpdate(session.id, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'mock-cmd', description: 'Mock slash command' },
          { name: 'another-cmd', description: 'Another mock slash command' },
        ],
      });
    }
  }
  const result = { sessionId: session.id };
  if (session.modes) result.modes = session.modes;
  if (session.configOptions) result.configOptions = session.configOptions;
  if (state.scenario === 'unknown-meta') {
 // 边界：未知 _meta 扩展字段（client 必须忽略且不使会话失败）
    result._meta = { unknownExt: { nested: { value: 42 }, note: 'vendor extension unknown to this client' } };
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
  if (state.scenario === 'load-late-replay') {
    // spec 违规形态（session-setup.mdx 要求回放完全部 update 才回响应）：
    // 先回响应，延迟后再发残留回放——client 侧的重连残留警告据此实测
    log(`session/load ${session.id}: responding first; ${LATE_REPLAY_RESIDUE(session).length} late replay update(s) after ${LATE_REPLAY_DELAY_MS}ms (spec violation)`);
    const result = {};
    if (session.modes) result.modes = session.modes;
    if (session.configOptions) result.configOptions = session.configOptions;
    respond(msg.id, result);
    if (LATE_REPLAY_ON_COMMAND) {
      // 确定性变体：残留挂起，等该会话的首笔 set_config_option 再发
      // （见 handleSetConfigOption）；不用定时器，测试侧两阶段断言无墙钟竞态。
      session.lateReplayPending = true;
      log('session/load late replay residue armed (MOCK_LATE_REPLAY_ON_COMMAND; awaiting set_config_option trigger)');
      return;
    }
    setTimeout(() => {
      for (const update of LATE_REPLAY_RESIDUE(session)) sendUpdate(session.id, update);
      log('session/load late replay residue sent');
    }, LATE_REPLAY_DELAY_MS);
    return;
  }
  // recorded-replay 优先：该会话（本进程或此前进程的生命周期内）实际收到过的
  // 更新流原样重放；无记录（MOCK_PRESET_SESSIONS 预置等）回退 LOAD_REPLAY 夹具
  const inMemory = Array.isArray(session.recordedHistory) && session.recordedHistory.length > 0
    ? session.recordedHistory
    : undefined;
  const recorded = inMemory ?? readRecordings()[session.id];
  let replay = Array.isArray(recorded) && recorded.length > 0 ? recorded : loadReplayUpdates();
  let replayKind = replay === recorded ? 'recorded-replay' : `variant=${LOAD_REPLAY_VARIANT}`;
  if (state.scenario === 'terminal-merge-replay' && replay === recorded) {
    // 学 claude 的 session/load 行为：回放帧是终态合并形态（见 terminalMergeReplay）
    replay = terminalMergeReplay(recorded);
    replayKind = 'recorded-replay(terminal-merge)';
  }
  log(`session/load ${session.id}: replaying ${replay.length} updates (${replayKind})`);
  for (const update of replay) sendUpdate(session.id, update);
  const result = {};
  if (session.modes) result.modes = session.modes;
  if (session.configOptions) result.configOptions = session.configOptions;
  respond(msg.id, result);
}

function handleSessionList(msg) {
  if (state.scenario === 'list-fail') {
    log('session/list fails by scenario (list-fail)');
    return respondError(msg.id, -32603, 'mock: session/list failed (list-fail scenario)');
  }
  const cwd = msg.params?.cwd;
  const all = [...state.sessions.values()]
    .filter((s) => !cwd || s.cwd === cwd)
    .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: `Mock session ${s.id}`, updatedAt: FIXED_TIMESTAMP }));
  // 分页（MOCK_LIST_PAGE_SIZE > 0）：cursor 为页号字符串，非末页携带 nextCursor；
  // 缺省单页全量（既有行为，响应形状逐字节不变）
  if (LIST_PAGE_SIZE > 0) {
    const parsed = Number.parseInt(typeof msg.params?.cursor === 'string' ? msg.params.cursor : '0', 10);
    const page = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    const start = page * LIST_PAGE_SIZE;
    const result = { sessions: all.slice(start, start + LIST_PAGE_SIZE) };
    if (start + LIST_PAGE_SIZE < all.length) result.nextCursor = String(page + 1);
    return respond(msg.id, result);
  }
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
    persistRecording(session);
  }
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

// elicitation（decline 实测）：turn 中途发合法 form-mode elicitation/create，
// await client 响应并记录响应 JSON，然后继续剩余 chunk 并 end_turn。client 侧的
// 预期行为是协议标准 decline 变体（本适配器不接 interaction UI）。
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
    // 断言面：client 应答原样记日志（预期 {"action":"decline"}）
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

// fs-probe：prompt 时经 /bin/sh 逐目标写文件并回传结果（沙箱实测）。
// spawnSync 短暂阻塞事件循环换取逐目标确定性；写入内容固定，目标全在 env 给定。
const FS_PROBE_CONTENT = 'dsh-acp-fs-probe';
function runFsProbeTurn(session, msg) {
  let targets = [];
  try {
    const parsed = JSON.parse(process.env.MOCK_FS_PROBE_WRITES ?? '[]');
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) targets = parsed;
    else log('MOCK_FS_PROBE_WRITES is not a JSON string array; probing zero targets');
  } catch (error) {
    log(`MOCK_FS_PROBE_WRITES parse failed: ${String(error)}; probing zero targets`);
  }
  const results = [];
  for (const target of targets) {
 // 经 shell 写：seatbelt 对整个进程树生效（实证后代继承），被拦时 sh 报
    // "Operation not permitted"（命中 confined.denialSignatures 方言）
    const run = spawnSync('/bin/sh', ['-c', 'printf %s "$1" > "$2"', 'sh', FS_PROBE_CONTENT, target], {
      encoding: 'utf8',
      timeout: 10000,
    });
    results.push({ path: target, ok: run.status === 0, exitCode: run.status, stderr: (run.stderr ?? '').trim() });
  }
  log(`fs-probe results: ${JSON.stringify(results)}`);
  // envEcho：回显注入的 XDG/TMPDIR，供断言方验证 env 经 spawnPlan seam 到达子进程
 // （确定性 data home 会追加 data-home/envRef 键：值原样回显——这些是测试自造值，
  // 真实 secret 永远不会出现在测试 env 里）
  const envEcho = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
  };
  sendUpdate(session.id, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: JSON.stringify({ fsProbeResults: results, envEcho }) },
    messageId: 'mock-fs-probe-1',
  });
  respond(msg.id, { stopReason: 'end_turn' });
}

function handlePrompt(msg) {
  const session = getSession(msg);
  if (!session) return;
  if (session.closed) {
    return respondError(msg.id, -32602, `Invalid params: session ${String(msg.params?.sessionId)} is closed`);
  }
  if (session.turn) return respondError(msg.id, -32603, 'turn already active on this session');
  switch (state.scenario) {
    case 'minimal-caps':
      return void runUpdateTurn(session, msg, MINIMAL_TURN_UPDATES);
    case 'rich-content':
      return void runUpdateTurn(session, msg, richContentTurnUpdates(session.cwd));
    case 'mixed-turn':
      return void runUpdateTurn(session, msg, mixedTurnUpdates(session.cwd));
    case 'empty-turn':
      return void runUpdateTurn(session, msg, []);
    case 'terminal-merge-replay':
      return void runUpdateTurn(session, msg, terminalMergeTurnUpdates(session.cwd));
    case 'permission-flow':
      return void runPermissionTurn(session, msg);
    case 'elicitation':
      return void runElicitationTurn(session, msg);
    case 'unknown-meta':
      return void runUpdateTurn(session, msg, unknownMetaTurnUpdates(session.cwd));
    case 'codex-shape':
      return void runUpdateTurn(session, msg, codexShapeTurnUpdates(session.cwd));
    case 'crash-mid-turn':
      return void runCrashTurn(session, msg);
    case 'cancel-stuck':
      return void runCancelStuckTurn(session, msg);
    case 'fs-probe':
      return void runFsProbeTurn(session, msg);
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
 // 收敛失败臂：写入恒被拒（值不应用），client 应落分叉说明并照常 prompt
    log(`set_config_option configId=${configId} value=${JSON.stringify(value)} (refused by scenario)`);
    return respondError(msg.id, -32603, 'config write refused by scenario (config-write-fail)');
  }
  if (state.scenario === 'load-late-replay' && session.lateReplayPending) {
    // 确定性残留触发（MOCK_LATE_REPLAY_ON_COMMAND）：set_config_option 无 turn
    // 括号（client 的 AcpAgent.setConfigOption 仅 idle 时放行），mock 收到本请求
    // 即确知 client 处于 turn 外——先回残留再响应，消除「end_turn 响应与残留合并
 // 进同一次管道读取、client turn 收口微任务未跑完」的竞态（flake 根治）。
    session.lateReplayPending = false;
    for (const update of LATE_REPLAY_RESIDUE(session)) sendUpdate(session.id, update);
    log('session/load late replay residue sent (set_config_option trigger)');
  }
  if (state.scenario === 'out-of-order-config') {
 // .6t generation 守卫实测：乱序响应（JSON-RPC 允许对端并发处理后乱序回应）。
    // 第一笔挂起不回应（值已应用、当时快照留存）；第二笔先回（现状快照），再补
    // 第一笔的迟到响应（其当时快照）——client 不得以迟到的第一笔快照覆盖第二笔
    // 确立的更新状态。本分支短路 mode 双发补推（测试只用 model 类选项）。
    if (session.heldConfigRequest === undefined) {
      option.currentValue = value;
      session.heldConfigRequest = msg;
      session.heldConfigSnapshot = JSON.parse(JSON.stringify(session.configOptions));
      log(`set_config_option configId=${configId} value=${JSON.stringify(value)} (held for out-of-order release)`);
      return;
    }
    option.currentValue = value;
    log(`set_config_option configId=${configId} value=${JSON.stringify(value)} (answered first)`);
    respond(msg.id, { configOptions: session.configOptions });
    const held = session.heldConfigRequest;
    const heldSnapshot = session.heldConfigSnapshot;
    session.heldConfigRequest = undefined;
    session.heldConfigSnapshot = undefined;
    log(`set_config_option configId=${held.params?.configId} value=${JSON.stringify(held.params?.value)} (late response released)`);
    respond(held.id, { configOptions: heldSnapshot });
    return;
  }
  option.currentValue = value;
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

function handleSetScenario(msg) {
  const next = msg.params?.scenario;
  if (!KNOWN_SCENARIOS.has(next)) {
    return respondError(msg.id, -32602, `Invalid params: unknown scenario ${String(next)}`);
  }
  state.scenario = next;
  log(`scenario switched to ${next} via control frame`);
  respond(msg.id, {});
}

// minimal-caps 下未声明的可选方法视为未实现
const MINIMAL_CAPS_FORBIDDEN = new Set(['session/load', 'session/list', 'session/delete', 'session/close']);

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
    case 'mock/set_scenario':
      return handleSetScenario(msg);
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
// MOCK_ENV_WATCH（指纹/envRef presence 断言用）：逗号分隔的键名清单，
// 每个键只在 started 行回显 `watch:KEY=present|absent`——只记存在性，值永不落盘。
const ENV_WATCH = (process.env.MOCK_ENV_WATCH ?? '').split(',').map((key) => key.trim()).filter((key) => key.length > 0);
const envWatchSuffix = ENV_WATCH.map((key) => `watch:${key}=${process.env[key] !== undefined && process.env[key] !== '' ? 'present' : 'absent'}`).join(' ');
log(`started pid=${process.pid} stepDelayMs=${STEP_DELAY_MS}${envWatchSuffix === '' ? '' : ` ${envWatchSuffix}`}`);

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
