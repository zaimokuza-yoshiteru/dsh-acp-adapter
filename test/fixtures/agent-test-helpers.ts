// agent-test-helpers.ts — 黑盒 黑盒测试的组装层：在没有完整 dsh 的情况下
// bootstrap cordis ctx + 真实 SessionStore/AgentRegistry/LlmRuntime + AcpAgentLoop。
//
// 组装先例：reference/deepseek-harness/packages/core/agent-loop/tests/agent.spec.ts
// （ctx.plugin(SessionStore/AgentRegistry/LlmRuntime/AgentLoop)），差异：
//   - dsh-tools / dsh-system-prompt 不在本包依赖面（pnpm 严格隔离，无法按名解析），
//     AgentLoop 的 static inject 要求它们存在 → ctx.provide 最小 fake
//     （systemPrompt 仅需 variable()/assemble()；tools 仅需存在，纯文本响应不触达）。
//   - settings 服务用内存 fake（dsh-settings 语义：schema 校验 + watch 通知），
//     ACP 注册表经它写入 agent 配置（registry.spec.ts 先例）。
//   - sessionPersistence 用内存 fake（host/factory/agent-loop.ts 的 AcpResumePersistence 结构窄化只有
//     inspect/prepare 两个成员；父类 resumeWith 也只消费 prepare/session/dispose）。
//
// 孤儿进程防线：所有经注册表下发的 mock profile argv 都带 SPEC_TAG（含本 worker
// pid），afterAll 用 `ps` 全量扫描；mock 的 MOCK_LOG 同时承担 spawn 计数
// （`started pid=` 行）与 session/cancel、SIGTERM 阶梯断言。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import LlmRuntime, { LlmAdapter, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import AcpAgentLoop from '../../src/index.ts';
import type { AcpCommandDefinition } from '../../src/protocol/v1/commands.ts';
import type { AcpApprovalOutcome, AcpApprovalRequest } from '../../src/domain/policy/permissions.ts';
import type { AcpAgentConfig } from '../../src/domain/session/agent-config.ts';
import type { AcpSandboxMode, AcpSandboxPolicyLike } from '../../src/domain/policy/sandbox.ts';
import { acpCanonicalHash16 } from '../../src/persistence/sidecar.ts';
import type { AcpBindingData } from '../../src/persistence/sidecar.ts';
import { descriptorOf } from '../../src/domain/session/agent-config.ts';
import { acpLaunchFingerprint } from '../../src/domain/session/launch-fingerprint.ts';
import { sharedTestSubprocess } from './subprocess-seam-testing.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', 'mock-agent', 'mock-agent.mjs');

/** 本 spec 文件全部 spawn 的 argv 标记（ps 扫描用）；每个 vitest worker 唯一。 */
export const SPEC_TAG = `--dsh-acp-agent-spec-${process.pid}`;

// ---------- 通用工具 ----------

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await sleep(5);
  }
}

export function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** `ps` 全量扫描本 spec 的 SPEC_TAG（验收：无孤儿 mock/内联进程）。 */
export function psLinesWithTag(tag: string): string[] {
  const ps = execFileSync('ps', ['-axo', 'pid,args'], { encoding: 'utf8' });
  return ps.split('\n').filter((line) => line.includes(tag));
}

export function readLog(logPath: string): string {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

/** MOCK_LOG 的 `started pid=N` 行 = spawn 次数；同时给出 pid 列表。 */
export function spawnedPids(logPath: string): number[] {
  return [...readLog(logPath).matchAll(/started pid=(\d+)/g)].map((match) => Number(match[1]));
}

export function userText(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

// ---------- settings 内存 fake（dsh-settings 语义子集：按 ns 注册 + schema 校验 + watch 通知） ----------

type SettingsSchema = (value: unknown) => unknown;
type SettingsWatcher = (next: never, prev: never) => void | Promise<void>;

interface SettingsEntry {
  schema: SettingsSchema;
  value: unknown;
  base: unknown;
  watchers: SettingsWatcher[];
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqualJson(entry, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}

/**
 * 结构对齐 dsh-settings 的 SettingsProvider.register 返回面（get/watch）。
 * register 的第三个参数（dsh-settings 的 base/validate）按真实语义实现 base：
 * 未写入时 get 返回 base（agent-loop 的 installSettingsSection 依赖这一点）。
 */
export class FakeSettingsProvider {
  private readonly entries = new Map<string, SettingsEntry>();

  register(ns: string, schema: SettingsSchema, options?: { base?: unknown }) {
    const entry: SettingsEntry = {
      schema,
      value: undefined,
      base: options?.base,
      watchers: [],
    };
    this.entries.set(ns, entry);
    return {
      get: (): unknown => {
        if (entry.value !== undefined) return entry.schema(entry.value);
        return entry.base !== undefined ? entry.base : entry.schema(undefined);
      },
      watch: (callback: SettingsWatcher): (() => void) => {
        entry.watchers.push(callback);
        return () => {
          entry.watchers = entry.watchers.filter((watcher) => watcher !== callback);
        };
      },
    };
  }

  /** 写一个命名空间：schema 拒绝则整体不写（抛错）；resolved 值不变则不通知。 */
  async write(ns: string, value: unknown): Promise<void> {
    const entry = this.entries.get(ns);
    if (entry === undefined) throw new Error(`fake settings: namespace "${ns}" was never registered`);
    const prev = entry.value === undefined
      ? (entry.base !== undefined ? entry.base : entry.schema(undefined))
      : entry.schema(entry.value);
    const next = entry.schema(value);
    entry.value = value;
    if (deepEqualJson(next, prev)) return;
    for (const watcher of [...entry.watchers]) {
      await watcher(next as never, prev as never);
    }
  }
}

// ---------- sessionPersistence 内存 fake（AcpResumePersistence 结构窄化 + 父类 resumeWith 面） ----------

interface StoredSession {
  meta: SessionHeader;
  events: SessionEvent[];
}

export class FakeSessionPersistence {
  readonly inspectCalls: SessionId[] = [];
  readonly prepareCalls: SessionId[] = [];
  private readonly store = new Map<string, StoredSession>();

  /** 预置一段"已持久化"日志；meta 可补 cwd 等字段。 */
  seed(id: SessionId, events: SessionEvent[], meta: Partial<SessionHeader> = {}): void {
    this.store.set(id, {
      meta: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, ...meta },
      events,
    });
  }

  async inspect(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    this.inspectCalls.push(id);
    const entry = this.store.get(id);
    if (entry === undefined) throw new Error(`fake persistence: unknown session "${id}"`);
    return { meta: entry.meta, events: entry.events };
  }

  async prepare(id: SessionId): Promise<SessionPreparation> {
    this.prepareCalls.push(id);
    const entry = this.store.get(id);
    if (entry === undefined) throw new Error(`fake persistence: unknown session "${id}"`);
    // fromRestore 取走新鲜值的所有权并原地冻结：每次 prepare 都给独立克隆
    const session = Session.fromRestore(id, structuredClone(entry.events), structuredClone(entry.meta));
    return SessionPreparation.create(session);
  }

 /** 宿主会话列表（双绑守卫的活动性判定数据源：列出即「存在且未删除」）。 */
  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map((entry) => entry.meta);
  }
}

/** 一段合法的持久化日志：一个完整 turn + request/header + end-seed 边界。 */
export function seedLogWithHeader(provider: string, model: string): SessionEvent[] {
  const prompt = createUserMessage({ content: [{ type: 'text', text: 'seeded question' }], source: { kind: 'user' } });
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: prompt, surfaceOp: 'append' },
    {
      type: 'request/header',
      seq: 2,
      time: 3,
      data: { header: { config: { provider, model } }, reason: 'initial' },
    },
    {
      type: 'assistant/chunk',
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    },
    {
      type: 'assistant/chunk',
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'seeded answer' } },
    },
    {
      type: 'assistant/chunk',
      seq: 5,
      time: 6,
      data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'seeded answer' } } },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: 7,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'seed-msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'seeded answer' }],
          source: { kind: 'model', provider, model },
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [3, 4, 5],
    },
    { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 8, time: 9, data: {} },
  ] as unknown as SessionEvent[];
}

/** 无 request/header 的持久化日志（peek 未命中一路）。 */
export function seedLogWithoutHeader(): SessionEvent[] {
  const prompt = createUserMessage({ content: [{ type: 'text', text: 'seeded question' }], source: { kind: 'user' } });
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: prompt, surfaceOp: 'append' },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 3, time: 4, data: {} },
  ] as unknown as SessionEvent[];
}

// ---------- binding / 对账夹具 ----------

/**
 * mock agent（happy 系 scenario）initialize 回报的 AgentCapabilities 逐字复本
 * （mock-agent.mjs handleInitialize）——binding 夹具的 capabilityHash 输入；
 * acpCanonicalHash16 走 canonical JSON（键排序），与 mock 的键序无关。
 * minimal-caps 形态不同，但 capabilityHash 漂移只是 advisory warn，不阻断。
 */
const MOCK_HAPPY_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },
  sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {} },
  auth: {},
};

/**
 * happy 系 session/load（或 new）响应的 configHash 输入复本
 * （src/domain/session/agent.ts configHashInput：configOptions 折 id+当前值 +
 * currentModeId）：mode=accept-edits、model=mock-model-a、currentModeId=accept-edits。
 */
const MOCK_HAPPY_CONFIG_HASH_INPUT = {
  configOptions: [
    { id: 'mode', value: 'accept-edits' },
    { id: 'model', value: 'mock-model-a' },
  ],
  currentModeId: 'accept-edits',
};

export interface BindingFixtureOptions {
  /** ACP 侧会话 id（session/load 的目标）。 */
  agentSessionId: string;
  /**
   * 建立时会话 cwd（canonical 化 = realpath）。默认取 profile.logPath 的目录
   * （harness.logDir）——resume 用例应把同一目录写进持久化 meta.cwd。
   */
  cwd?: string;
  /** 字段级覆盖（对账矩阵注入漂移/代际/锚点用）。 */
  overrides?: Partial<AcpBindingData>;
}

/**
 * 一份能通过 语义门槛的 binding 载荷：预检比对字段（canonicalCwd/
 * launchFingerprint/agent/protocolVersion）全部按 mock agent 的真实行为预填，
 * 恢复时逐项命中、不阻断；capabilityHash/configHash 按 mock happy 形态的真值
 * 预算（连 advisory warn 都不产生）。launchFingerprint 经真组装函数
 * （src/domain/session/launch-fingerprint.ts）预填——与 startSession 的预检②
 * canonical 哈希同源同算法；`agentDataHome`/`agentDataGeneration` 默认 null
 * （非 data home profile 的新写形态）。generation/historyBaseSeq/establishedAt/
 * dshCommittedSeq 是锚点字段，按用例经 overrides 钉。
 */
export function bindingFixture(profile: MockProfile, options: BindingFixtureOptions): AcpBindingData {
  const cwd = options.cwd ?? path.dirname(profile.logPath);
  return {
    provider: routeOf(profile),
    agentSessionId: options.agentSessionId,
    profileId: profile.id,
    canonicalCwd: fs.realpathSync(cwd),
    launchFingerprint: acpLaunchFingerprint({
      profileId: profile.id,
      config: profile.config,
      descriptor: descriptorOf(profile.id, profile.config),
      generation: 1,
    }),
    agent: { name: 'dsh-mock-acp-agent', version: '1.0.0' },
    protocolVersion: 1,
    capabilityHash: acpCanonicalHash16(MOCK_HAPPY_CAPABILITIES),
    configHash: acpCanonicalHash16(MOCK_HAPPY_CONFIG_HASH_INPUT),
    generation: 1,
    historyBaseSeq: 0,
    establishedAt: 1,
    dshCommittedSeq: 0,
    agentDataHome: null,
    agentDataGeneration: null,
    ...options.overrides,
  };
}

/**
 * 与 mock LOAD_REPLAY 逐条对应的持久化日志（对账的「匹配」种子）：
 * 可见历史折出 [user "Earlier user question", assistant "Earlier answer,
 * part 1 + part 2", tool "Read notes.txt"(completed)]——分段对账下与回放
 * 侧折出结果同段同层 digest 相等（tool 条目还覆盖 kind/locations/
 * raw input/result——tool/call 的 `meta.acpToolCall` 与 `arguments` 对应回放帧
 * 的 kind/locations/rawInput，tool/result 内容对应终态 tool_call_update 的
 * content）。
 * 事件顺序按 **live 真实落盘序** 排布（修正）：tool/call 到达前先把当前
 * assistant segment flush 成 block-end + assistant/message（seq 先于
 * tool/call——「正文在 tool 卡片上方」的钉版）；tool/call/tool/result 携带该
 * call 的 presentation step 2（文本段是 step 1）。LOAD_REPLAY 尾部的 plan 更新
 * 在两侧都只产生 reasoning-only 内容（不进 assistant 文本 digest），本种子从略。
 * assistant/message 必须带 sourceEventSeqs 字段（无该字段 = 说明消息，
 * 不进期望序列；src/domain/session/resume.ts expectedVisibleHistory）。
 * 配合 binding 锚点：historyBaseSeq=0、dshCommittedSeq=返回数组长度（含 end-seed）。
 */
export function seedLogMatchingLoadReplay(provider: string, model: string): SessionEvent[] {
  const prompt = createUserMessage({ content: [{ type: 'text', text: 'Earlier user question' }], source: { kind: 'user' } });
  const answer = 'Earlier answer, part 1 + part 2';
  const assistant = createAssistantMessage({
    content: [{ type: 'text', text: answer }],
    source: { provider, model },
  });
  const toolResult = createToolResultMessage({
    callId: 'mock-load-tool-1' as never,
    content: [{ type: 'text', text: 'notes contents' }],
    isError: false,
  });
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: prompt, surfaceOp: 'append' },
    {
      type: 'request/header',
      seq: 2,
      time: 3,
      data: { header: { config: { provider, model } }, reason: 'initial' },
    },
    {
      type: 'assistant/chunk',
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    },
    {
      type: 'assistant/chunk',
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: answer } },
    },
    {
      type: 'assistant/chunk',
      seq: 5,
      time: 6,
      data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: answer } } },
    },
    {
 // tool/call 到达前的 segment flush——assistant/message 先于 tool 事件落盘
      type: 'assistant/message',
      seq: 6,
      time: 7,
      data: { turn: 1, step: 1, message: assistant },
      surfaceOp: 'append',
      sourceEventSeqs: [3, 4, 5],
    },
    {
      type: 'tool/call',
      seq: 7,
      time: 8,
      data: {
        turn: 1,
        step: 2,
        callId: 'mock-load-tool-1',
        name: 'Read notes.txt',
        arguments: '{"path":"notes.txt"}',
        // kind/locations 摘要与 mock LOAD_REPLAY 的 tool_call 帧对应
        meta: { acpToolCall: { kind: 'read', locations: [{ path: '/mock/cwd/notes.txt' }] } },
      },
    },
    { type: 'tool/result', seq: 8, time: 9, data: { turn: 1, step: 2, message: toolResult }, surfaceOp: 'append', sourceEventSeqs: [7] },
    { type: 'turn/end', seq: 9, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 10, time: 11, data: {} },
  ] as unknown as SessionEvent[];
}

/** {@link seedLogMatchingLoadReplay} 的日志长度 = 配套 binding 的 dshCommittedSeq。 */
export const LOAD_REPLAY_MATCHED_COMMITTED_SEQ = 11;

// ---------- 最小 services fake（AgentLoop static inject 的 tools / systemPrompt） ----------

/**
 * systemPrompt fake：AgentLoop 构造器注册 3 个 variable；ReactLoopAgent 的 preStep
 * 与 AcpAgent 的 options-sync 调用 assemble()。返回空 assembly
 * （renderPrompt/renderContextSections 对空输入产出 ''/[]，runtimeContext.project
 * 随后返回 undefined，消息原样进入请求）。assemble 调用记录在 `calls`（wiring
 * 测试断言每 turn 前同步用）。
 */
function fakeSystemPrompt(calls?: unknown[]) {
  return {
    variable: (_name: string, _provider: (context: unknown) => string | undefined): (() => void) => () => {},
    assemble: (context?: unknown): Promise<{ sections: []; contexts: []; tools: []; variables: Record<string, never> }> => {
      calls?.push(context);
      return Promise.resolve({ sections: [], contexts: [], tools: [], variables: {} });
    },
  };
}

/** tools fake：纯文本响应的 turn 不触达任何方法，存在即可（inject 满足）。 */
function fakeTools() {
  return {};
}

// ---------- 接线 fakes（sandbox / sandboxPolicy / approval / commands） ----------

/**
 * sandbox fake（pass-through）：记录每次 confine 的 argv+policy，返回不包装的
 * argv（enforcement 'full'）。confined 两档因此照常 spawn，policy 断言由测试读
 * `confineCalls` 完成。
 */
export class FakeSandbox {
  readonly confineCalls: { argv: string[]; policy: AcpSandboxPolicyLike }[] = [];
  /** 置 true 时下一次 confine 不记录直接抛错（注入 sandbox 能力失败，钉 fail-closed/重解析行为）。 */
  failNextConfine = false;

  confine(argv: readonly string[], policy: AcpSandboxPolicyLike) {
    if (this.failNextConfine) {
      this.failNextConfine = false;
      throw new Error('confine boom (injected)');
    }
    this.confineCalls.push({ argv: [...argv], policy });
    return { argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] };
  }
}

/**
 * sandboxPolicy fake（既定规则的模式来源）：`resolve({session})` 返回可变 slot
 * `mode`（默认 workspace-write）+ `session.header.cwd ?? process.cwd()`。
 */
export class FakeSandboxPolicy {
  readonly resolveCalls: number[] = [];

  constructor(public mode: AcpSandboxMode = 'workspace-write') {}

  resolve(request: { session: Session }): { mode: AcpSandboxMode; workspaceRoot: string } {
    this.resolveCalls.push(1);
    return { mode: this.mode, workspaceRoot: request.session.header.cwd ?? process.cwd() };
  }
}

/** approval fake：记录请求，固定回 `outcome`（默认 allowed-once）。 */
export class FakeApproval {
  readonly requests: AcpApprovalRequest[] = [];
  outcome: AcpApprovalOutcome = 'allowed-once';

  request(req: AcpApprovalRequest): Promise<AcpApprovalOutcome> {
    this.requests.push(req);
    return Promise.resolve(this.outcome);
  }
}

/** commands fake：记录当前注册集（name → definition），register 返回注销器。 */
export class FakeCommands {
  readonly registered = new Map<string, AcpCommandDefinition>();

  register(definition: AcpCommandDefinition): () => void {
    this.registered.set(definition.name, definition);
    return () => {
      this.registered.delete(definition.name);
    };
  }
}

// ---------- mock LLM adapter（非 ACP 委派路：对齐 reference agent-loop tests/mock-adapter.ts） ----------

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export class MockLlmAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly script: StreamChunk[][]) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const entry = this.script.shift();
    if (entry === undefined) throw new Error('MockLlmAdapter: script exhausted');
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted');
      yield chunk;
    }
  }
}

// ---------- mock ACP profile（经 settings 进入注册表） ----------

export interface MockProfile {
  /** 注册表 agent id（路由 `acp-<id>`）。 */
  id: string;
  /** 写入 settings 的 config（command/args/env/loginHint）。 */
  config: AcpAgentConfig;
  /** MOCK_LOG 路径：spawn 计数 / session/cancel / SIGTERM 阶梯断言都读它。 */
  logPath: string;
}

let profileSeq = 0;

/**
 * mock agent 的注册表条目：command=当前 node，args=[mock-agent.mjs, SPEC_TAG-x]，
 * env 自带 MOCK_SCENARIO/MOCK_LOG（AcpAgent 的子进程环境=最小继承集+profile env）。
 */
export function mockProfile(logDir: string, scenario: string, extraEnv: Record<string, string> = {}): MockProfile {
  const seq = ++profileSeq;
  const id = `mock${seq}`;
  const logPath = path.join(logDir, `mock-${String(seq)}.log`);
  return {
    id,
    logPath,
    config: {
      name: `Mock Agent ${String(seq)}`,
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `${SPEC_TAG}-m${String(seq)}`],
      env: { MOCK_SCENARIO: scenario, MOCK_LOG: logPath, ...extraEnv },
    },
  };
}

/** 内联 node -e agent 的注册表条目（mock 覆盖不到的场景，如 auth_required）。 */
export function inlineProfile(logDir: string, script: string, loginHint?: string): MockProfile {
  const seq = ++profileSeq;
  const id = `inline${seq}`;
  return {
    id,
    logPath: path.join(logDir, `inline-${String(seq)}.log`),
    config: {
      name: `Inline Agent ${String(seq)}`,
      command: process.execPath,
      args: ['-e', script],
      env: {},
      ...(loginHint === undefined ? {} : { loginHint }),
    },
  };
}

// ---------- harness ----------

export interface AgentHarness {
  ctx: Context;
  /** AcpAgentLoop 服务实例（ctx.agentLoop 的具体类型）。 */
  loop: AcpAgentLoop;
  settings: FakeSettingsProvider;
  persistence: FakeSessionPersistence;
  llm: LlmRuntime;
  /** 本测试的私有目录（mock cwd / MOCK_LOG 落点）。 */
  logDir: string;
  /** 待拆除的 AgentHandle；afterEach 统一 dispose。 */
  handles: AgentHandle[];
  /** sandbox fake（pass-through；confine 调用记录）。options.sandbox === false 时为 undefined。 */
  sandbox: FakeSandbox | undefined;
  /** sandboxPolicy fake（模式 slot 可变）。options.sandboxPolicy === false 时为 undefined。 */
  sandboxPolicy: FakeSandboxPolicy | undefined;
  /** fake harness-home 根（dshHomePath 的落点：`<logDir>/dsh-home`）。 */
  dshHome: string;
  /** fake systemPrompt 的 assemble 调用记录（options-sync 每 turn 前同步的断言点）。 */
  assembleCalls: unknown[];
}

export interface CreateHarnessOptions {
  /** 是否提供 sessionPersistence 服务（默认提供；resume 拒绝路径测试关它）。 */
  persistence?: boolean;
  /** sandboxPolicy fake 的初始模式（默认 'workspace-write'——pass-through confine 下行为最接近接线前）。 */
  sandboxMode?: AcpSandboxMode;
  /** false = 不提供 sandboxPolicy 服务（AcpAgent 回退 read-only + 一次性 warn）。 */
  sandboxPolicy?: boolean;
  /** false = 不提供 sandbox 服务（confined 档 fail closed：ACP_SANDBOX_UNAVAILABLE）。 */
  sandbox?: boolean;
 /** false = 不提供 ctx.subprocess 服务（fail closed：各 ACP spawn 点 ACP_SPAWN_FAILURE，native 路由不受影响）。 */
  subprocess?: boolean;
  /** false = 不提供 dshHomePath slot（sidecar 禁用；read-only 档 stateRoot 不可解析 → fail loud）。 */
  dshHomePath?: boolean;
  /** 提供则注入 ctx.approval（permissions 桥 e2e）。 */
  approval?: FakeApproval;
  /** 提供则注入 ctx.commands（slash 命令桥 e2e）。 */
  commands?: FakeCommands;
}

/**
 * 组装真实 cordis 运行时：SessionStore + AgentRegistry + LlmRuntime（真插件）
 * + settings/systemPrompt/tools/sessionPersistence（provide fake）+ AcpAgentLoop。
 * 先 provide 再 plugin：AgentLoop 的 static inject 五项齐备才能激活。
 *
 * 默认还提供：sandbox（pass-through fake）+ sandboxPolicy（workspace-write
 * fake）+ dshHomePath（`<logDir>/dsh-home`）——否则所有 ACP spawn 在 read-only
 * 无沙箱下 fail closed。
 *
 * 默认提供 ctx.subprocess（共享的真实 subprocess-local 服务单例，
 * test/subprocess-seam-testing.ts；必须先于 AcpAgentLoop 挂载——seam 在构造期
 * 解析一次）：缺席时 ACP 各 spawn 点 fail closed（spawn-failure）。
 */
export async function createHarness(logDir: string, options: CreateHarnessOptions = {}): Promise<AgentHarness> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LlmRuntime);
  const settings = new FakeSettingsProvider();
  const persistence = new FakeSessionPersistence();
  const assembleCalls: unknown[] = [];
  const sandbox = options.sandbox === false ? undefined : new FakeSandbox();
  const sandboxPolicy = options.sandboxPolicy === false ? undefined : new FakeSandboxPolicy(options.sandboxMode ?? 'workspace-write');
  const dshHome = path.join(logDir, 'dsh-home');
  ctx.provide('settings', settings);
  ctx.provide('systemPrompt', fakeSystemPrompt(assembleCalls));
  ctx.provide('tools', fakeTools());
  if (options.persistence !== false) ctx.provide('sessionPersistence', persistence);
  if (sandbox !== undefined) ctx.provide('sandbox', sandbox);
  if (sandboxPolicy !== undefined) ctx.provide('sandboxPolicy', sandboxPolicy);
  if (options.subprocess !== false) ctx.provide('subprocess', (await sharedTestSubprocess()).raw);
  if (options.dshHomePath !== false) ctx.provide('dshHomePath', (...segments: string[]) => path.join(dshHome, ...segments));
  if (options.approval !== undefined) ctx.provide('approval', options.approval);
  if (options.commands !== undefined) ctx.provide('commands', options.commands);
  await ctx.plugin(AcpAgentLoop, { agents: [] });
  const loop = ctx.agentLoop as AcpAgentLoop;
  return { ctx, loop, settings, persistence, llm: ctx.llm, logDir, handles: [], sandbox, sandboxPolicy, dshHome, assembleCalls };
}

/** 把若干 ACP agent 写进 settings（触发注册表路由注册），并等路由可见。 */
export async function registerAcpAgents(harness: AgentHarness, profiles: readonly MockProfile[]): Promise<void> {
  const agents: Record<string, AcpAgentConfig> = {};
  for (const profile of profiles) agents[profile.id] = profile.config;
  await harness.settings.write('dsh-acp', { agents });
  for (const profile of profiles) {
    await waitFor(() => harness.loop.acpRegistry.resolveRoute(`acp-${profile.id}`) !== undefined);
  }
}

export function routeOf(profile: MockProfile): string {
  return `acp-${profile.id}`;
}

// ---------- session 事件读取助手 ----------

/** 去掉 inbox 簿记事件后的事件类型序列（turn 驱动契约断言用）。 */
export function contractEventTypes(agent: Agent): string[] {
  return agent.session.events.filter((event) => event.type !== 'agent/inbox/spliced').map((event) => event.type);
}

export function eventsOf<T extends SessionEvent['type']>(agent: Agent, type: T): Extract<SessionEvent, { type: T }>[] {
  return agent.session.events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}
