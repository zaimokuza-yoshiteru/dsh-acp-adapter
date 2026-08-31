// llm-stub.spec.ts — 随附测试：AcpStubAdapter 的 stream 门禁错误、providerInfo
// 分组标签、probe 缓存（命中/失效/失败缓存/手动失效/并发去重）与三类失败文案；
// probe 指标（acp.probe timer 的 ok/AcpErrorKind 标签、缓存命中不计、probe
// 内 crash 加计 acp.crash）。
//
// probe 一律打真 mock agent（node test/mock-agent/mock-agent.mjs，MOCK_SCENARIO
// happy|minimal-caps|slow-response）或不存在命令；auth_required 用内联 node -e
// agent（mock 无此 scenario，沿用 acp-client.spec.ts 先例）。
//
// 孤儿进程防线：所有 spawn 的 argv 带 SPEC_TAG（含本 worker pid），afterAll 用
// `ps` 全量扫描无残留。probe 次数经 MOCK_LOG 的 `started pid=` 行数计数。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { AcpStubAdapter, acpProbeConfigKey } from '../../../src/host/composition/llm-stub.ts';
import type { AcpStubAgentConfig } from '../../../src/domain/session/agent-config.ts';
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs');
const SPEC_TAG = `--dsh-acp-stub-spec-${process.pid}`;

const ROUTE = 'acp-test';
const PROBE_OPTIONS = { timeoutMs: 5_000, eofGraceMs: 100, termGraceMs: 400 };

let logDir = '';
let subprocess: SubprocessSeam;
let spawnSeq = 0;

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-stub-spec-'));
 // probe 的 spawn 走共享的真实 subprocess-local 服务
  subprocess = (await sharedTestSubprocess()).seam;
});

afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

function probeCount(logPath: string): number {
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('started pid=')).length;
}

interface MockAgentHandle {
  config: AcpStubAgentConfig;
  logPath: string;
}

/** mock agent 的 stub 配置：argv[0] 为绝对路径的 process.execPath，env 全权自带。 */
function mockAgent(scenario: string, extraEnv: Record<string, string> = {}): MockAgentHandle {
  const seq = ++spawnSeq;
  const logPath = path.join(logDir, `stub-${String(seq)}.log`);
  return {
    logPath,
    config: {
      name: 'Mock Agent',
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `${SPEC_TAG}-m${String(seq)}`],
      env: { MOCK_SCENARIO: scenario, MOCK_LOG: logPath, ...extraEnv },
    },
  };
}

/** 可变 agents 源的 adapter：测试经 `set` 改配置验证缓存 hash 失效。 */
function makeAdapter(initial: Record<string, AcpStubAgentConfig>) {
  let current = initial;
  const adapter = new AcpStubAdapter({
    agents: () => new Map(Object.entries(current)),
    probeOptions: PROBE_OPTIONS,
    subprocess: { ok: true, seam: subprocess },
  });
  return { adapter, set: (next: Record<string, AcpStubAgentConfig>) => (current = next) };
}

async function expectListModelsError(adapter: AcpStubAdapter, provider: string): Promise<unknown> {
  try {
    await adapter.listModels(provider);
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected listModels to reject, but it resolved');
}

describe('stream 门禁与 providerInfo', () => {
  it('stream() 直接抛指引错误：默认模型设为该 ACP 模型后新建会话', () => {
    const { adapter } = makeAdapter({ [ROUTE]: mockAgent('happy').config });
    let thrown: unknown;
    try {
      adapter.stream({} as GenerateOptions);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    const error = thrown as LlmError;
    expect(error.code).toBe('ACP_STUB_ROUTE');
    expect(error.message).toContain('native model-call path');
    expect(error.message).toContain('new session');
  });

  it('providerInfo 的选择器分组标签是 `<Name> · ACP`；未知路由回退路由 id', () => {
    const { adapter, set } = makeAdapter({ [ROUTE]: mockAgent('happy').config });
    expect(adapter.providerInfo(ROUTE)).toEqual({ id: ROUTE, name: 'Mock Agent · ACP' });
    expect(adapter.providerInfo('acp-ghost')).toEqual({ id: 'acp-ghost', name: 'acp-ghost' });
    const renamed = mockAgent('happy').config;
    set({ [ROUTE]: { ...renamed, name: 'Renamed' } });
    expect(adapter.providerInfo(ROUTE).name).toBe('Renamed · ACP');
  });

  it('已移除的 provider listModels 抛 ACP_UNKNOWN_PROVIDER', async () => {
    const { adapter } = makeAdapter({});
    const error = (await expectListModelsError(adapter, ROUTE)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('ACP_UNKNOWN_PROVIDER');
  });
});

describe('probe 模型目录与缓存', () => {
  it('happy：listModels 返回 model 类 configOptions 的选项列表；握手原值随 ok 缓存保留', async () => {
    const { config } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    const models = await adapter.listModels(ROUTE);
    expect(models.map((model) => model.id)).toEqual(['mock-model-a', 'mock-model-b', 'mock-model-c']);
    expect(models[0]).toEqual({ provider: ROUTE, id: 'mock-model-a', name: 'Mock Model A' });
 // initialize 握手的 agentInfo/agentCapabilities 随 ok 缓存保留（健康诊断与审计的事实源）
    const snapshot = adapter.probeSnapshot(ROUTE);
    expect(snapshot?.result.kind).toBe('ok');
    if (snapshot?.result.kind === 'ok') {
      expect(snapshot.result.agentInfo).toEqual({ name: 'dsh-mock-acp-agent', title: 'DSH Mock ACP Agent', version: '1.0.0' });
      expect(snapshot.result.agentCapabilities?.loadSession).toBe(true);
      expect(snapshot.result.agentCapabilities?.promptCapabilities).toEqual({ image: true, audio: false, embeddedContext: true });
      expect(snapshot.result.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    }
  });

  it('Kimi 路由保留每个模型自己确认的推理目录和默认值', async () => {
    const handle = mockAgent('happy', {
      MOCK_MODEL_THOUGHT_LEVELS: JSON.stringify({
        'mock-model-a': ['high'],
        'mock-model-b': ['low', 'high', 'max'],
        'mock-model-c': ['on'],
      }),
    });
    const route = 'acp-kimi';
    const { adapter } = makeAdapter({ [route]: { ...handle.config, runtime: 'kimi' } });
    await adapter.listModels(route);
    expect(adapter.configOptionsForModel(route, 'mock-model-a')?.find(option => option.id === 'thought_level')).toMatchObject({ currentValue: 'high' });
    expect(adapter.configOptionsForModel(route, 'mock-model-b')?.find(option => option.id === 'thought_level')).toMatchObject({ currentValue: 'low' });
    expect(adapter.configOptionsForModel(route, 'mock-model-c')?.find(option => option.id === 'thought_level')).toMatchObject({ currentValue: 'on' });
  });

  it('失败隔离：一路 probe 失败进缓存不重 spawn，另一路照常返回模型', async () => {
    // 宿主 modelCatalog 语义（DSH 0.1.2-alpha.2 session-controller/catalog.ts 同款）：
    // 单 provider 探测失败只进 failures，不拖垮整个目录。adapter 粒度钉：失败只落在
    // 自己的路由缓存里，其余路由的 probe 与结果互不传染。
    const happy = mockAgent('happy');
    const MISSING_ROUTE = 'acp-missing';
    const missing: AcpStubAgentConfig = { name: 'Missing', command: '/nonexistent/dsh-acp-missing-bin', args: ['acp'], env: {} };
    const { adapter } = makeAdapter({ [ROUTE]: happy.config, [MISSING_ROUTE]: missing });
    const error = (await expectListModelsError(adapter, MISSING_ROUTE)) as LlmError;
    expect(error.code).toBe('ACP_PROBE_FAILED');
    // 健康路不受牵连
    await expect(adapter.listModels(ROUTE)).resolves.toHaveLength(3);
    // 失败路重调：同一 error 实例（缓存重抛），不重 spawn
    const again = await expectListModelsError(adapter, MISSING_ROUTE);
    expect(again).toBe(error);
    // spawn 失败发生在 initialize 阶段之前/之中：阶段标记为 initialize
    const snapshot = adapter.probeSnapshot(MISSING_ROUTE);
    if (snapshot?.result.kind === 'error') expect(snapshot.result.probePhase).toBe('initialize');
  });

  it('缓存命中：相同配置第二次 listModels 不再 probe', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    const first = await adapter.listModels(ROUTE);
    const second = await adapter.listModels(ROUTE);
    expect(second).toBe(first);
    expect(probeCount(logPath)).toBe(1);
    expect(adapter.probeSnapshot(ROUTE)?.result.kind).toBe('ok');
  });

  it('hash 失效：command/args/env 变化后重新 probe', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter, set } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(1);
    // env 键增删 → hash 变 → 重新 probe
    set({ [ROUTE]: { ...config, env: { ...config.env, EXTRA: '1' } } });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(2);
  });

 it(' 键口径 secret-free：env 值变化（键名集合不变）也会 bust 缓存', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter, set } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(1);
    // 同键不同值（MOCK_SCENARIO happy → rich-content，目录形状相同）：值只以 hash
    // 进入 key，明文不落，但仍须重新探测。
    set({ [ROUTE]: { ...config, env: { ...config.env, MOCK_SCENARIO: 'rich-content' } } });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(2);
    // 键名集合变化（增键）仍 bust
    set({ [ROUTE]: { ...config, env: { ...config.env, NEW_KEY: 'x' } } });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(3);
  });

 it('ok 条目带 cleanup 事实与 capability hash（agent version 经 agentInfo 保留）', async () => {
    const { config } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    const snapshot = adapter.probeSnapshot(ROUTE);
    if (snapshot?.result.kind !== 'ok') throw new Error('expected ok probe snapshot');
    expect(snapshot.result.cleanup).toEqual({ close: 'not-advertised', delete: 'done' });
    expect(snapshot.result.capabilityHash).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshot.result.agentInfo?.version).toBe('1.0.0');
    // configOptions-only 目录事实随 ok 条目保留（mock happy 有 model 类 configOption）。
    expect(snapshot.result.hasModelConfigOption).toBe(true);
  });

  it('name/loginHint 变化不失效缓存（probe 结果与它们无关）', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter, set } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    set({ [ROUTE]: { ...config, name: 'Renamed', loginHint: 'mock login' } });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(1);
  });

  it('并发 listModels 共享同一次 probe', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    const [a, b] = await Promise.all([adapter.listModels(ROUTE), adapter.listModels(ROUTE)]);
    expect(a).toBe(b);
    expect(probeCount(logPath)).toBe(1);
  });

  it('minimal-caps：agent 不提供 configOptions → 空目录（选择器 ACP 区块自然隐藏）', async () => {
    const { config } = mockAgent('minimal-caps');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    await expect(adapter.listModels(ROUTE)).resolves.toEqual([]);
  });

  it('invalidateProbe 后重新 probe（面板手动刷新通道）', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    adapter.invalidateProbe(ROUTE);
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(2);
    adapter.invalidateProbe();
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(3);
  });
});

describe(' 缓存 TTL（acpProbeFresh；ok 10min / error 30s）', () => {
  // 只 fake Date（不碰 setTimeout——真实子进程 IO 依赖真定时器）；用例间恢复真实时钟
  function fakeClock() {
    vi.useFakeTimers({ toFake: ['Date'] });
    return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
  }

  it('ok 条目：TTL 内命中不重探，过 10 分钟按 miss 重 probe', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    // 先 fake 再首探：条目 at 落在假时钟上，TTL 边界判定与真实进程耗时无关
    const clock = fakeClock();
    try {
      await adapter.listModels(ROUTE);
      expect(probeCount(logPath)).toBe(1);
      clock.advance(10 * 60_000 - 1); // TTL 内
      await adapter.listModels(ROUTE);
      expect(probeCount(logPath)).toBe(1);
      clock.advance(2); // 越过 10 分钟
      await adapter.listModels(ROUTE);
      expect(probeCount(logPath)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败条目（负缓存）：30s 内重抛不重探，过 30s 重 probe', async () => {
    const missing: AcpStubAgentConfig = { name: 'Missing', command: '/nonexistent/dsh-acp-missing-bin', args: ['acp'], env: {} };
    const { adapter } = makeAdapter({ [ROUTE]: missing });
    const clock = fakeClock(); // 同上：先 fake 再首探，at 落在假时钟上
    try {
      await expectListModelsError(adapter, ROUTE);
      const firstAt = adapter.probeSnapshot(ROUTE)?.at;
      clock.advance(30_000 - 1); // TTL 内：重抛缓存错误（spawn-failure 不产生进程，以 at 判重探）
      await expectListModelsError(adapter, ROUTE);
      expect(adapter.probeSnapshot(ROUTE)?.at).toBe(firstAt);
      clock.advance(2); // 越过 30s
      await expectListModelsError(adapter, ROUTE);
      expect(adapter.probeSnapshot(ROUTE)?.at).toBeGreaterThan(firstAt ?? 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateProbe 绕过 TTL：「重新检查」不受新鲜度影响', async () => {
    const { config, logPath } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    try {
      await adapter.listModels(ROUTE);
      const clock = fakeClock();
      clock.advance(60_000); // ok TTL 内
      adapter.invalidateProbe(ROUTE);
      await adapter.listModels(ROUTE);
      expect(probeCount(logPath)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('probe 失败文案（AcpClientError.kind → 面向用户 message）', () => {
  it('command 不存在：message 含命令名与配置指引，缓存失败不重 probe', async () => {
    const config: AcpStubAgentConfig = {
      name: 'Missing',
      command: '/nonexistent/dsh-acp-missing-bin',
      args: ['acp'],
      env: {},
    };
    const { adapter } = makeAdapter({ [ROUTE]: config });
    const first = (await expectListModelsError(adapter, ROUTE)) as LlmError;
    expect(first).toBeInstanceOf(LlmError);
    expect(first.code).toBe('ACP_PROBE_FAILED');
    expect(first.message).toContain('/nonexistent/dsh-acp-missing-bin');
    expect(first.message).toContain('command and arguments');
    // 失败也进缓存：重抛同一 error 实例，不会每次打开选择器都重 spawn
    const second = await expectListModelsError(adapter, ROUTE);
    expect(second).toBe(first);
    const snapshot = adapter.probeSnapshot(ROUTE);
    expect(snapshot?.result.kind).toBe('error');
    if (snapshot?.result.kind === 'error') expect(snapshot.result.failureKind).toBe('spawn-failure');
  });

  it('auth_required：message 含 loginHint 登录指引', async () => {
    // initialize 一律回 -32000 auth_required（acp-client.spec.ts 同款内联 agent）
    const script = `
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
    const config: AcpStubAgentConfig = {
      name: 'NeedsLogin',
      command: process.execPath,
      args: ['-e', script],
      env: {},
      loginHint: 'devin auth login',
    };
    const { adapter } = makeAdapter({ [ROUTE]: config });
    const error = (await expectListModelsError(adapter, ROUTE)) as LlmError;
    expect(error.code).toBe('ACP_PROBE_FAILED');
    expect(error.message).toContain('requires authentication');
    expect(error.message).toContain('devin auth login');
    const snapshot = adapter.probeSnapshot(ROUTE);
    if (snapshot?.result.kind === 'error') expect(snapshot.result.failureKind).toBe('auth_required');
  });

  it('超时：message 含超时指引；失败缓存使第二次调用不再 spawn', async () => {
    const { config, logPath } = mockAgent('slow-response', { MOCK_SLOW_INIT_MS: '1500' });
    const adapter = new AcpStubAdapter({
      agents: () => new Map(Object.entries({ [ROUTE]: config })),
      probeOptions: { timeoutMs: 200, eofGraceMs: 100, termGraceMs: 300 },
      subprocess: { ok: true, seam: subprocess },
    });
    const error = (await expectListModelsError(adapter, ROUTE)) as LlmError;
    expect(error.code).toBe('ACP_PROBE_FAILED');
    expect(error.message).toContain('probe timeout');
    await expectListModelsError(adapter, ROUTE);
    expect(probeCount(logPath)).toBe(1);
    const snapshot = adapter.probeSnapshot(ROUTE);
    if (snapshot?.result.kind === 'error') expect(snapshot.result.failureKind).toBe('timeout');
  });
});

describe('acpProbeConfigKey 与 stub 配置的协作', () => {
  it('缓存 key 即 acpProbeConfigKey 的输出', async () => {
    const { config } = mockAgent('happy');
    const { adapter } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    expect(adapter.probeSnapshot(ROUTE)?.key).toBe(acpProbeConfigKey(config));
  });

  it('env value rotation invalidates the probe cache without exposing the value', async () => {
    const { config, logPath } = mockAgent('happy', { ACP_TEST_SECRET: 'secret-before' });
    const { adapter, set } = makeAdapter({ [ROUTE]: config });
    await adapter.listModels(ROUTE);
    const rotated = { ...config, env: { ...config.env, ACP_TEST_SECRET: 'secret-after' } };
    set({ [ROUTE]: rotated });
    await adapter.listModels(ROUTE);
    expect(probeCount(logPath)).toBe(2);
    expect(adapter.probeSnapshot(ROUTE)?.key).toBe(acpProbeConfigKey(rotated));
    expect(adapter.probeSnapshot(ROUTE)?.key).not.toContain('secret-before');
    expect(adapter.probeSnapshot(ROUTE)?.key).not.toContain('secret-after');
  });
});
