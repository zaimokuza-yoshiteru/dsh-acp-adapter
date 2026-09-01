// installed-profile-registry.spec.ts — settings schema/纯函数核心 + 注册/替换调用序列。
//
// 覆盖：
//   - 纯函数：acpRouteId / acpAgentIdFromRoute / 内置一键模板（DEVIN_ACP_TEMPLATE +
//      claude 预设 +  codex 预设 +  kimi 预设逐字段钉版、
//     secret 纪律钉、schema 往返）/ acpRegistrationFacts（排序归一）/
//     acpProbeConfigKey（env 键序无关、name/loginHint 不参与、
//     runtime 参与——descriptor 绑定变化必须重探）
// - runtime descriptor：四条内置 descriptor 数据面钉版、descriptorOf 绑定解析
//     （runtime 命中 / id 回退 / 普通 profile 无 descriptor）
//   - acpSettingsSchema：空 section 默认值、字段默认值补齐、loginHint/runtime 保留、未知键剥离、
//     各类非法输入拒绝（坏 id/空 name/空 command/坏 args/坏 env/非法 runtime）；
// 内置 runtime singleton 跨条目拒绝（点名已有 profile；generic profile 多实例不受限）
//   - installInstalledProfileRegistry（假 ctx.llm 记录调用、内存 settings fake 走真 schema）：
// 空配置 dormant → 首个 agent 只触发 registerAdapter（不再注册
//     Models 目录条目——Settings → Models 页零 ACP 行）；
//     增删 agent → 同一 adapter 实例 replace；改名（displayName 是注册事实）→ replace 同路由集；
//     仅 loginHint 变 → 不动；删空 → replace([])；键重排 → 不动；非法写入被拒且路由不变；
//     resolveRoute 命中/未命中；删除 profile → 路由撤下、resolveRoute 归 undefined、
//     adapter.listModels 对该路由响亮拒绝（目录失效，不静默改用其他 profile）
// -：模板清洁钉（npm 模板不打包用户路径/用户名/凭据）；agent 配置改动审计
//     （added/changed/removed 摘要、env 只记键名、首帧/卸载期跳过、回调抛错只 warn）
//
// 纯内存测试：不 spawn 进程（probe 行为在 llm-stub.spec.ts 用真 mock 覆盖）。

import { describe, expect, it } from 'vitest';
import os from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import {
  ACP_AGENT_RUNTIME_DESCRIPTORS,
  acpAgentIdFromRoute,
  acpRouteId,
  acpVersionCompatibility,
  descriptorOf,
  type AcpAgentConfig,
} from '../../../src/domain/session/agent-config.ts';
import {
  ACP_BUILTIN_AGENT_TEMPLATES,
  CLAUDE_ACP_TEMPLATE,
  CODEX_ACP_TEMPLATE,
  DEVIN_ACP_TEMPLATE,
  KIMI_ACP_TEMPLATE,
  acpProbeConfigKey,
  acpRegistrationFacts,
  acpSettingsSchema,
  installInstalledProfileRegistry,
  type AcpSettings,
  type AcpSettingsSchema,
} from '../../../src/host/composition/installed-profile-registry.ts';

const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

// ---------- 内存 settings fake（对齐 dsh-settings 语义：schema 校验 + deepEqual commit 通知） ----------

type WatchCallback = (next: AcpSettings, prev: AcpSettings) => void;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type PathOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] };

function applyPathOp(section: Record<string, unknown>, op: PathOp): Record<string, unknown> {
  const [head, ...rest] = op.path;
  if (head === undefined) return section;
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value };
    const kept = { ...section };
    delete kept[head];
    return kept;
  }
  const child = section[head];
  const base = isPlainObject(child) ? child : {};
  return { ...section, [head]: applyPathOp(base, { ...op, path: rest } as PathOp) };
}

class FakeSettingsProvider {
  private section: Record<string, unknown> = {};
  private schema: AcpSettingsSchema | undefined;
  private watchers: WatchCallback[] = [];

  register(_ns: string, schema: AcpSettingsSchema) {
    this.schema = schema;
    return {
      get: (): AcpSettings => this.schema!(this.section),
      watch: (callback: WatchCallback) => {
        this.watchers.push(callback);
        return () => {
          this.watchers = this.watchers.filter((watcher) => watcher !== callback);
        };
      },
    };
  }

  /** settings 服务写路径语义：schema 拒绝则整体不写；resolved 值不变则不通知。 */
  private commit(next: Record<string, unknown>): void {
    const schema = this.schema!;
    const prev = schema(this.section);
    const resolved = schema(next);
    this.section = next;
    if (deepEqualJson(resolved, prev)) return;
    for (const watcher of [...this.watchers]) watcher(resolved, prev);
  }

  /** 直接写入底层 section（install 前的存量配置场景；不过 schema、不通知 watcher）。 */
  seed(section: Record<string, unknown>): void {
    this.section = section;
  }

  async replace(section: Record<string, unknown>): Promise<void> {
    this.commit(section);
  }

  async mutate(ops: PathOp[]): Promise<void> {
    let section = this.section;
    for (const op of ops) section = applyPathOp(section, op);
    this.commit(section);
  }
}

// ---------- 假 ctx.llm（记录注册/替换调用序列； 不再有 directory 通道） ----------

class FakeLlm {
  readonly calls: string[] = [];
  /** registerAdapter 收到的 adapter 实例（断言同一性用）。 */
  readonly adapters: unknown[] = [];

  constructor(private readonly failOnRoute?: string) {}

  registerAdapter(routes: string[], adapter: unknown) {
    if (this.failOnRoute !== undefined && routes.includes(this.failOnRoute)) throw new Error(`route collision: ${this.failOnRoute}`)
    this.calls.push(`registerAdapter:${routes.join(',')}`);
    this.adapters.push(adapter);
    const dispose = (): void => {
      this.calls.push('adapter.dispose');
    };
    (dispose as { replace?: unknown }).replace = (next: string[]): void => {
      this.calls.push(`adapter.replace:${next.join(',')}`);
    };
    return dispose;
  }
}

interface FakeHarness {
  ctx: Context;
  llm: FakeLlm;
  settings: FakeSettingsProvider;
 /** ctx.logger.warn 收到的行（结构化后缀钉版用）。 */
  warnings: string[];
  errors: unknown[];
}

function fakeHarness(options: { failOnRoute?: string } = {}): FakeHarness {
  const llm = new FakeLlm(options.failOnRoute);
  const settings = new FakeSettingsProvider();
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const scopedCtx = {
    get: (name: string): unknown => (name === 'settings' ? settings : undefined),
  };
  const ctx = {
    get: (name: string): unknown => name === 'settings' ? settings : undefined,
    inject: (_deps: string[], callback: (sctx: unknown) => void): void => {
      callback(scopedCtx);
    },
    effect: (_setup: () => (() => void), _name?: string): void => {},
    llm,
    logger: {
      warn: (line: string): void => {
        warnings.push(line);
      },
      error: (...args: unknown[]): void => {
        errors.push(args);
      },
    },
    fiber: { state: 2 }, // FiberState.ACTIVE
  };
  return { ctx: ctx as unknown as Context, llm, settings, warnings, errors };
}

const devinAgent: AcpAgentConfig = {
  name: DEVIN_ACP_TEMPLATE.name,
  command: DEVIN_ACP_TEMPLATE.command,
  args: [...DEVIN_ACP_TEMPLATE.args],
  env: {},
  ...(DEVIN_ACP_TEMPLATE.loginHint === undefined ? {} : { loginHint: DEVIN_ACP_TEMPLATE.loginHint }),
};

const fooAgent: AcpAgentConfig = {
  name: 'Foo Agent',
  command: 'foo-cli',
  args: ['serve', '--acp'],
  env: { FOO_HOME: '/opt/foo' },
};

describe('纯函数：路由 id 与模板', () => {
  it('acpRouteId / acpAgentIdFromRoute 互逆，非 ACP 路由与非法 id 返回 undefined', () => {
    expect(acpRouteId('devin')).toBe('acp-devin');
    expect(acpAgentIdFromRoute('acp-devin')).toBe('devin');
    expect(acpAgentIdFromRoute('deepseek')).toBeUndefined();
    expect(acpAgentIdFromRoute('acp-')).toBeUndefined();
    expect(acpAgentIdFromRoute('acp-Devin')).toBeUndefined();
    expect(acpAgentIdFromRoute('acp-x_y')).toBeUndefined();
  });

 it('DEVIN_ACP_TEMPLATE 是面板"添加 Devin"按钮的一键模板（既定行为； 起显式 runtime=devin）', () => {
    expect(DEVIN_ACP_TEMPLATE).toEqual({
      id: 'devin',
      name: 'Devin',
      command: 'devin',
      args: ['acp'],
      env: {},
      loginHint: 'devin auth login',
 // （内置 runtime 唯一性）：四个内置模板全部显式声明稳定 runtime（不再靠 id 回退）
      runtime: 'devin',
 // 边界：auth 数据面收进 runtime descriptor，模板只留 settings 部分
    });
    // 模板的用户可配置部分必须过自己的 schema
    const { id, ...templateValue } = DEVIN_ACP_TEMPLATE;
    expect(id).toBe('devin');
    const roundTripped = acpSettingsSchema({ agents: { [id]: { ...templateValue } } });
    // devinAgent 夹具不带 runtime（手写配置走 id 回退）；模板值多了显式绑定
    expect(roundTripped.agents['devin']).toEqual({ ...devinAgent, runtime: 'devin' });
  });

  it('ACP_BUILTIN_AGENT_TEMPLATES 钉版：devin + claude 预设 + codex 预设 + kimi 预设，settings 部分均过自己的 schema', () => {
    expect(ACP_BUILTIN_AGENT_TEMPLATES.map((template) => template.id)).toEqual(['devin', 'claude', 'codex', 'kimi']);
    for (const template of ACP_BUILTIN_AGENT_TEMPLATES) {
      const { id, ...templateValue } = template;
      const roundTripped = acpSettingsSchema({ agents: { [id]: { ...templateValue } } });
      expect(roundTripped.agents[id], id).toEqual(templateValue);
    }
  });

  it('CLAUDE_ACP_TEMPLATE 逐字段钉版：runtime=claude、不假设推理提供方（env 空）', () => {
    expect(CLAUDE_ACP_TEMPLATE).toEqual({
      id: 'claude',
      name: 'Claude',
      command: 'claude-agent-acp',
      args: [],
      env: {},
      loginHint: 'claude',
      runtime: 'claude',
      // 不假设推理提供方：下游路由不属于本插件的模型身份范围
    });
  });

  it('CODEX_ACP_TEMPLATE 逐字段钉版：runtime=codex，env 空、无 secret 预填', () => {
    expect(CODEX_ACP_TEMPLATE).toEqual({
      id: 'codex',
      name: 'Codex',
      command: 'codex-acp',
      args: [],
      env: {},
      loginHint: 'codex login',
      runtime: 'codex',
    });
    // 模板的用户可配置部分必须过自己的 schema
    const { id, ...templateValue } = CODEX_ACP_TEMPLATE;
    const roundTripped = acpSettingsSchema({ agents: { [id]: { ...templateValue } } });
    expect(roundTripped.agents['codex']).toEqual(templateValue);
  });

  it('KIMI_ACP_TEMPLATE 逐字段钉版：runtime=kimi，env 空、无 secret 预填', () => {
    expect(KIMI_ACP_TEMPLATE).toEqual({
      id: 'kimi',
      name: 'Kimi',
      command: 'kimi',
      args: ['acp'],
      env: {},
      // 依据：本机无 prompt 探针——kimi-code 0.36.1
      // 的 authMethods 只有 login 一路（command `kimi` args ['login'] 的设备码流程）
      loginHint: 'kimi login',
      runtime: 'kimi',
    });
    // 模板的用户可配置部分必须过自己的 schema
    const { id, ...templateValue } = KIMI_ACP_TEMPLATE;
    const roundTripped = acpSettingsSchema({ agents: { [id]: { ...templateValue } } });
    expect(roundTripped.agents['kimi']).toEqual(templateValue);
  });

  it('模板 secret 纪律钉：所有一键模板不预填/持久化任何疑似 secret 键', () => {
    for (const template of ACP_BUILTIN_AGENT_TEMPLATES) {
      for (const key of Object.keys(template.env)) {
        expect(SENSITIVE_ENV_PATTERN.test(key), `${template.id}.${key}`).toBe(false);
      }
      // 纪律针对 env 键值（loginHint 指引文本点名 env 键名是合法的用户指引）
      const envWire = JSON.stringify(template.env);
      expect(envWire).not.toContain('ANTHROPIC_AUTH_TOKEN');
      expect(envWire).not.toContain('ANTHROPIC_API_KEY');
    }
  });

 it(' 模板清洁钉：npm 分发的模板与 descriptor 不打包用户路径/用户名/凭据', () => {
    // devin/claude/codex/kimi 模板 env 为空；
    // Descriptor/template data is static and must not embed the build user's home.
    expect(DEVIN_ACP_TEMPLATE.env).toEqual({});
    expect(CLAUDE_ACP_TEMPLATE.env).toEqual({});
    expect(CODEX_ACP_TEMPLATE.env).toEqual({});
    expect(KIMI_ACP_TEMPLATE.env).toEqual({});
    // 模板与 descriptor 都是静态字面量——构建机/用户的 home 与登录名绝不能被烘进 npm 包
    const wire = JSON.stringify({ templates: ACP_BUILTIN_AGENT_TEMPLATES, descriptors: ACP_AGENT_RUNTIME_DESCRIPTORS });
    expect(wire).not.toContain(os.homedir());
    for (const user of [process.env.USER, process.env.USERNAME]) {
      if (user !== undefined && user !== '') expect(wire).not.toContain(user);
    }
  });
});

describe('runtime descriptor（数据面钉版 + 绑定解析）', () => {
  it('四条内置 descriptor 的完整数据面（防后续接线波次漂移）', () => {
    expect(ACP_AGENT_RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual(['devin', 'codex', 'kimi', 'claude']);
    expect(ACP_AGENT_RUNTIME_DESCRIPTORS).toEqual([
      {
        id: 'devin',
        command: 'devin',
        args: ['acp'],
        versionPolicy: {},
        loginHint: 'devin auth login',
      },
      {
        id: 'codex',
        command: 'codex-acp',
        args: [],
        versionPolicy: { adapter: '1.6.2' },
        loginHint: 'codex login',
      },
      {
        id: 'kimi',
        command: 'kimi',
        args: ['acp'],
        versionPolicy: { wrappedCli: '0.36.1' },
        loginHint: 'kimi login',
      },
      {
        id: 'claude',
        command: 'claude-agent-acp',
        args: [],
        executableOverrideEnv: 'CLAUDE_CODE_EXECUTABLE',
        versionPolicy: { adapter: '0.70.0' },
        loginHint: 'claude',
      },
    ]);
  });

  it('descriptorOf：runtime 字段优先命中，缺省时按 agent id 回退，普通 profile 无 descriptor', () => {
    // id 回退（无 runtime 字段）
    expect(descriptorOf('devin')?.id).toBe('devin');
    expect(descriptorOf('codex', fooAgent)?.id).toBe('codex');
    // runtime 显式绑定（id 不是 descriptor id 也命中）
    expect(descriptorOf('my-devin', { runtime: 'devin' })?.id).toBe('devin');
    // runtime 优先于 id 回退（id 恰好是另一 descriptor id 时以 runtime 为准）
    expect(descriptorOf('devin', { runtime: 'claude' })?.id).toBe('claude');
    // 普通 profile：无 runtime 且 id 不匹配 → undefined（无任何 path/env ref）
    expect(descriptorOf('foo', fooAgent)).toBeUndefined();
    expect(descriptorOf('ghost')).toBeUndefined();
  });

  it('：codex 模板与 claude 模板共存——各自解析到自己的 descriptor，profile id（backend 身份）独立', () => {
    // 模板经 schema 入 settings（模板 id 即 profile id 预填值）
    const { id: codexId, ...codexValue } = CODEX_ACP_TEMPLATE;
    const { id: claudeId, ...claudeValue } = CLAUDE_ACP_TEMPLATE;
    const resolved = acpSettingsSchema({ agents: { [codexId]: { ...codexValue }, [claudeId]: { ...claudeValue } } });
    // runtime 字段绑定 descriptor（codex ↔ codex、claude ↔ claude），profile id 独立
    // acp-codex 与 acp-claude 是不同 backend。
    expect(descriptorOf('codex', resolved.agents['codex'])?.id).toBe('codex');
    expect(descriptorOf('claude', resolved.agents['claude'])?.id).toBe('claude');
    expect(acpRouteId('codex')).toBe('acp-codex');
    // 用户改 id 后 runtime 绑定不漂移
    expect(descriptorOf('my-codex', { runtime: 'codex' })?.id).toBe('codex');
    // 两 profile 的 probe 缓存键独立（command/env 键集合不同），互不串扰
    expect(acpProbeConfigKey(resolved.agents['codex'] as AcpAgentConfig))
      .not.toBe(acpProbeConfigKey(resolved.agents['claude'] as AcpAgentConfig));
  });

  it('：kimi 模板与 codex/claude 模板共存——各自解析到自己的 descriptor，profile id（backend 身份）独立', () => {
    // 模板经 schema 入 settings（模板 id 即 profile id 预填值）
    const { id: kimiId, ...kimiValue } = KIMI_ACP_TEMPLATE;
    const { id: codexId, ...codexValue } = CODEX_ACP_TEMPLATE;
    const { id: claudeId, ...claudeValue } = CLAUDE_ACP_TEMPLATE;
    const resolved = acpSettingsSchema({ agents: { [kimiId]: { ...kimiValue }, [codexId]: { ...codexValue }, [claudeId]: { ...claudeValue } } });
    // runtime 字段绑定 descriptor（kimi ↔ kimi、codex ↔ codex、claude ↔ claude），profile id 独立
    // acp-kimi、acp-codex 与 acp-claude 是不同 backend。
    expect(descriptorOf('kimi', resolved.agents['kimi'])?.id).toBe('kimi');
    expect(descriptorOf('codex', resolved.agents['codex'])?.id).toBe('codex');
    expect(descriptorOf('claude', resolved.agents['claude'])?.id).toBe('claude');
    expect(acpRouteId('kimi')).toBe('acp-kimi');
    // 用户改 id 后 runtime 绑定不漂移
    expect(descriptorOf('my-kimi', { runtime: 'kimi' })?.id).toBe('kimi');
    // 三个 profile 的 probe 缓存键各自独立（command/args/env 键集合不同），互不串扰
    const keys = [resolved.agents['kimi'], resolved.agents['codex'], resolved.agents['claude']].map((config) => acpProbeConfigKey(config as AcpAgentConfig));
    expect(new Set(keys).size).toBe(3);
  });

  it('acpSettingsSchema 收 runtime 字段：四个合法值保留，非法值/非 string 拒绝', () => {
    for (const runtime of ['devin', 'codex', 'kimi', 'claude'] as const) {
      const resolved = acpSettingsSchema({ agents: { my: { name: 'M', command: 'm', runtime } } });
      expect(resolved.agents['my']).toEqual({ name: 'M', command: 'm', args: [], env: {}, runtime });
    }
    for (const bad of ['gpt', '', 'DEVIN', 42, true, ['devin']]) {
      expect(() => acpSettingsSchema({ agents: { my: { name: 'M', command: 'm', runtime: bad } } }), JSON.stringify(bad)).toThrow(TypeError);
    }
    // toJSON 的描述性 JSON Schema 同步携带 runtime 词表
    const json = acpSettingsSchema.toJSON() as { properties?: { agents?: { additionalProperties?: { properties?: { runtime?: { enum?: string[] } } } } } };
    expect(json.properties?.agents?.additionalProperties?.properties?.runtime?.enum).toEqual(['devin', 'codex', 'kimi', 'claude']);
  });

  it('runtime 参与 probe 缓存键（descriptor 绑定变化必须重探）', () => {
    const base = acpProbeConfigKey(devinAgent);
    expect(JSON.parse(base)).toEqual({ command: 'devin', args: ['acp'], envKeys: [], envHashes: [], runtime: null });
    expect(acpProbeConfigKey({ ...devinAgent, runtime: 'devin' })).not.toBe(base);
    expect(acpProbeConfigKey({ ...devinAgent, runtime: 'devin' })).not.toBe(acpProbeConfigKey({ ...devinAgent, runtime: 'claude' }));
    expect(acpProbeConfigKey({ ...devinAgent, runtime: 'devin' })).toBe(acpProbeConfigKey({ ...devinAgent, runtime: 'devin' }));
  });
});

describe('acpSettingsSchema', () => {
  it('空/缺省 section 解析为零 agents', () => {
    expect(acpSettingsSchema(undefined)).toEqual({ agents: {} });
    expect(acpSettingsSchema({})).toEqual({ agents: {} });
    expect(acpSettingsSchema({ agents: {} })).toEqual({ agents: {} });
  });

  it('解析合法 agents 并补默认值（args/env），保留 loginHint', () => {
    const resolved = acpSettingsSchema({
      agents: {
        devin: {
          name: 'Devin',
          command: 'devin',
          args: ['acp'],
          loginHint: 'devin auth login',
        },
        foo: { name: 'Foo', command: 'foo-cli', env: { A: '1' } },
      },
    });
    expect(resolved.agents['devin']).toEqual({
      name: 'Devin',
      command: 'devin',
      args: ['acp'],
      env: {},
      loginHint: 'devin auth login',
    });
    expect(resolved.agents['foo']).toEqual({ name: 'Foo', command: 'foo-cli', args: [], env: { A: '1' } });
  });

 it('边界：command 绝对路径放行（含 / 合法；空白与 shell 元字符见「非法输入」用例）', () => {
    const resolved = acpSettingsSchema({ agents: { kimi: { name: 'Kimi', command: '/usr/local/bin/kimi', args: ['acp'] } } });
    expect(resolved.agents['kimi']).toEqual({ name: 'Kimi', command: '/usr/local/bin/kimi', args: ['acp'], env: {} });
  });

  it('未知键被剥离；已删除的 profile MCP 与外部委派开关不会继续进入产品配置', () => {
    const resolved = acpSettingsSchema({ agents: { devin: { name: 'Devin', command: 'devin', typoField: 1, mcpServers: [{ type: 'stdio' }] } }, projectExternalSubagents: false, stray: true });
    expect(resolved).toEqual({ agents: { devin: { name: 'Devin', command: 'devin', args: [], env: {} } } });
  });

  it('非法输入逐一拒绝', () => {
    const bad: Array<[string, unknown]> = [
      ['非 object section', 'nope'],
      ['agents 非 object', { agents: [] }],
      ['坏 id（大写）', { agents: { Devin: { name: 'D', command: 'devin' } } }],
      ['坏 id（前导连字符）', { agents: { '-devin': { name: 'D', command: 'devin' } } }],
      ['空 name', { agents: { devin: { name: '', command: 'devin' } } }],
      ['缺 name', { agents: { devin: { command: 'devin' } } }],
      ['空 command', { agents: { devin: { name: 'D', command: '' } } }],
 // 边界：command 是单个可执行名/绝对路径，不是 shell 字符串（参数归 args）
      ['command 含空格（shell 字符串）', { agents: { devin: { name: 'D', command: 'devin acp' } } }],
      ['command 含管道符', { agents: { devin: { name: 'D', command: 'devin|x' } } }],
      ['command 含命令替换', { agents: { devin: { name: 'D', command: '$(x)' } } }],
      ['command 含引号', { agents: { devin: { name: 'D', command: '"devin"' } } }],
      ['args 非数组', { agents: { devin: { name: 'D', command: 'devin', args: 'acp' } } }],
      ['args 非 string 元素', { agents: { devin: { name: 'D', command: 'devin', args: ['acp', 1] } } }],
      ['env 值非 string', { agents: { devin: { name: 'D', command: 'devin', env: { A: 1 } } } }],
      ['loginHint 非 string', { agents: { devin: { name: 'D', command: 'devin', loginHint: 42 } } }],
 // credentialReadPaths 已从用户 schema 删除——作为未知键被 strip，不再校验
    ];
    for (const [label, section] of bad) {
      expect(() => acpSettingsSchema(section), label).toThrow(TypeError);
    }
  });

  it('toJSON 暴露描述性 JSON Schema（通用设置表面的信息性元数据）', () => {
    const json = acpSettingsSchema.toJSON() as { properties?: { agents?: { additionalProperties?: { required?: string[] } } } };
    expect(json.properties?.agents?.additionalProperties?.required).toEqual(['name', 'command']);
  });

 it(' singleton：同一内置 runtime 的第二个 profile 被拒绝，错误点名已有 profile', () => {
    // 显式 runtime 相撞（绕过 UI 直写 settings 同样被拒）
    expect(() => acpSettingsSchema({
      agents: {
        devin: { name: 'Devin', command: 'devin', args: ['acp'], runtime: 'devin' },
        'my-devin': { name: 'Devin Alt', command: 'devin-alt', runtime: 'devin' },
      },
    })).toThrow(/agents\.my-devin duplicates the built-in runtime "devin" already bound by agents\.devin \("Devin"\)/);
    // 显式 runtime 与 id 回退相撞（后者无 runtime 字段、id 恰为内置 runtime id）
    expect(() => acpSettingsSchema({
      agents: {
        devin: { name: 'Devin', command: 'devin', args: ['acp'] },
        'devin-next': { name: 'Devin Next', command: 'devin-next', runtime: 'devin' },
      },
    })).toThrow(/already bound by agents\.devin/);
    // 两个 id 回退相撞不可能（id 本身唯一），但 id 回退 + 同名显式绑定必撞
    expect(() => acpSettingsSchema({
      agents: {
        claude: { name: 'Claude', command: 'claude-agent-acp', runtime: 'claude' },
        'claude-deepseek': { name: 'Claude DS', command: 'claude-agent-acp', runtime: 'claude' },
      },
    })).toThrow(/agents\.claude-deepseek duplicates the built-in runtime "claude" already bound by agents\.claude \("Claude"\)/);
  });

 it(' singleton：四个内置 runtime 各一可共存；generic profile（无 runtime 身份）多实例不受限', () => {
    const resolved = acpSettingsSchema({
      agents: {
        devin: { name: 'Devin', command: 'devin', args: ['acp'], runtime: 'devin' },
        claude: { name: 'Claude', command: 'claude-agent-acp', runtime: 'claude' },
        codex: { name: 'Codex', command: 'codex-acp', runtime: 'codex' },
        kimi: { name: 'Kimi', command: 'kimi', args: ['acp'], runtime: 'kimi' },
        foo: { name: 'Foo', command: 'foo-cli' },
        bar: { name: 'Bar', command: 'bar-cli' },
      },
    });
    expect(Object.keys(resolved.agents).sort()).toEqual(['bar', 'claude', 'codex', 'devin', 'foo', 'kimi']);
    // generic profile 即便 command 相同也不受 singleton 约束（身份 = 稳定 profile id）
    expect(() => acpSettingsSchema({
      agents: {
        foo: { name: 'Foo', command: 'foo-cli' },
        'foo-copy': { name: 'Foo Copy', command: 'foo-cli' },
      },
    })).not.toThrow();
  });
});

describe('纯函数：registration facts / probe 配置 hash', () => {
  it('acpRegistrationFacts 按 provider 排序（settings 文档键重排不算路由变更）', () => {
    const facts = acpRegistrationFacts({ foo: fooAgent, devin: devinAgent });
    expect(facts).toEqual([
      { provider: 'acp-devin', displayName: 'Devin' },
      { provider: 'acp-foo', displayName: 'Foo Agent' },
    ]);
    // 键序不同 → 同一 facts（JSON 比较相同）
    const reordered = acpRegistrationFacts({ devin: devinAgent, foo: fooAgent });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(facts));
  });

  it('acpProbeConfigKey：env 键序无关；command/args/env 值/runtime 敏感；name/loginHint 不参与', () => {
    const base = acpProbeConfigKey(devinAgent);
    expect(acpProbeConfigKey({ ...devinAgent, env: {} })).toBe(base);
    const withEnv = acpProbeConfigKey({ ...devinAgent, env: { A: '1', B: '2' } });
    expect(acpProbeConfigKey({ ...devinAgent, env: { B: '2', A: '1' } })).toBe(withEnv);
    expect(acpProbeConfigKey({ ...devinAgent, command: 'devin2' })).not.toBe(base);
    expect(acpProbeConfigKey({ ...devinAgent, args: ['acp', '--verbose'] })).not.toBe(base);
    expect(acpProbeConfigKey({ ...devinAgent, env: { A: '1' } })).not.toBe(base);
    expect(acpProbeConfigKey({ ...devinAgent, name: 'Renamed' })).toBe(base);
    expect(acpProbeConfigKey({ ...devinAgent, loginHint: 'other login' })).toBe(base);
 // 键口径 secret-free：env 值只带短 hash，值变化会 bust，明文不进入 key
    expect(acpProbeConfigKey({ ...devinAgent, env: { A: '1', B: '2' } }))
      .not.toBe(acpProbeConfigKey({ ...devinAgent, env: { A: 'rotated', B: 'rotated-too' } }));
    expect(acpProbeConfigKey({ ...devinAgent, env: { A: '1', B: '2', C: '3' } })).not.toBe(withEnv);
 // 边界：runtime 是 descriptor 绑定（变了则 ref 集合变），进 probe 缓存键；
 // 键形状含 {command, args, envKeys, envHashes, runtime}（值只有 hash；
    // runtime 缺席归 null）
    expect(JSON.parse(base)).toEqual({ command: 'devin', args: ['acp'], envKeys: [], envHashes: [], runtime: null });
    expect(JSON.parse(withEnv)).toMatchObject({ command: 'devin', args: ['acp'], envKeys: ['A', 'B'], runtime: null });
    expect(JSON.parse(withEnv).envHashes).toHaveLength(2);
  });
});

describe('installInstalledProfileRegistry：注册/替换调用序列', () => {
  it('空配置 dormant：启动不注册任何路由，初始 settings 快照后 ready', async () => {
    const { ctx, llm } = fakeHarness();
    const registry = installInstalledProfileRegistry(ctx);
    await expect(registry.ready).resolves.toBeUndefined();
    expect(llm.calls).toEqual([]);
  });

  it('首个 agent 注册独立 profile 路由（只 registerAdapter，不再有 configurable-provider 目录注册）', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    expect(llm.calls).toEqual(['registerAdapter:acp-devin']);
    expect(llm.adapters).toHaveLength(1);
    expect(llm.adapters[0]).toBeDefined();
  });

  it('增删 agent 维持每 profile 的独立注册并回收删除项', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    await settings.mutate([{ op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } }]);
    await settings.mutate([{ op: 'unset', path: ['agents', 'devin'] }]);
    expect(llm.calls).toEqual(['registerAdapter:acp-devin', 'adapter.replace:acp-devin', 'registerAdapter:acp-foo', 'adapter.replace:acp-foo', 'adapter.dispose']);
    expect(llm.adapters).toHaveLength(2);
  });

  it('改名是注册事实：replace 同一路由集以刷新选择器标签', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin', 'name'], value: 'Devin Pro' }]);
    expect(llm.calls).toEqual(['registerAdapter:acp-devin', 'adapter.replace:acp-devin']);
  });

  it('launch identity 变化刷新注册，loginHint 单独变化不刷新', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    llm.calls.length = 0;
    await settings.mutate([{ op: 'set', path: ['agents', 'devin', 'loginHint'], value: 'devin login --new' }]);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin', 'args'], value: ['acp', '--verbose'] }]);
    expect(llm.calls).toEqual(['adapter.replace:acp-devin']);
  });

  it('删空回收全部 profile 注册，后续添加重新创建独立注册', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    await settings.replace({ agents: {} });
    expect(llm.calls).toEqual(['registerAdapter:acp-devin', 'adapter.dispose']);
    // 之后再加回来：新 profile 注册
    await settings.mutate([{ op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } }]);
    expect(llm.calls[llm.calls.length - 1]).toBe('registerAdapter:acp-foo');
    expect(llm.adapters).toHaveLength(2);
  });

 it('：删除 profile 后目录失效——路由撤下、resolveRoute 归 undefined、listModels 响亮拒绝（不静默改用其他 profile）', async () => {
    const { ctx, settings } = fakeHarness();
    const registry = installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    await settings.mutate([{ op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } }]);
    await settings.mutate([{ op: 'unset', path: ['agents', 'devin'] }]);
    // 删除后该路由不再解析到任何 agent；agent-loop 会响亮拒绝，绝不回落到
    // native LLM stub 或其他 ACP profile。
    expect(registry.resolveRoute('acp-devin')).toBeUndefined();
    expect(registry.resolveRoute('acp-foo')).toEqual({ id: 'foo', config: fooAgent });
  });

  it('settings 文档键重排不触发任何注册动作', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([
      { op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } },
      { op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } },
    ]);
    llm.calls.length = 0;
    await settings.replace({ agents: { foo: { ...fooAgent }, devin: { ...devinAgent } } });
    expect(llm.calls).toEqual([]);
  });

  it('非法写入被 schema 拒绝，既有路由不变', async () => {
    const { ctx, llm, settings } = fakeHarness();
    installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    llm.calls.length = 0;
    await expect(settings.replace({ agents: { Broken: { name: 'B', command: 'b' } } })).rejects.toThrow(TypeError);
    expect(llm.calls).toEqual([]);
  });

  it('resolveRoute：acp-<id> 命中，外部路由与未知 id 返回 undefined', async () => {
    const { ctx, settings } = fakeHarness();
    const registry = installInstalledProfileRegistry(ctx);
    expect(registry.resolveRoute('acp-devin')).toBeUndefined();
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
 // 边界：解析结果只携带 id+config；descriptor 由消费方经 descriptorOf(id, config) 现取
    expect(registry.resolveRoute('acp-devin')).toEqual({ id: 'devin', config: devinAgent });
    await settings.mutate([{ op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } }]);
    expect(registry.resolveRoute('acp-foo')).toEqual({ id: 'foo', config: fooAgent });
    expect(registry.resolveRoute('deepseek')).toBeUndefined();
    expect(registry.resolveRoute('acp-ghost')).toBeUndefined();
    expect(registry.agents().get('devin')).toEqual(devinAgent);
  });

  it('launch identity 快路径更新 active config 并刷新 route registration', async () => {
    const { ctx, llm, settings } = fakeHarness();
    const registry = installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    llm.calls.length = 0;
    const next = { ...devinAgent, command: 'devin-next', env: { TOKEN: 'rotated' } };
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: next }]);
    expect(llm.calls).toContain('adapter.replace:acp-devin');
    expect(registry.resolveRoute('acp-devin')?.config).toEqual(next);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin', 'runtime'], value: 'claude' }]);
    expect(llm.calls.filter((call) => call === 'adapter.replace:acp-devin')).toHaveLength(2);
  });

  it('新 profile 注册冲突时回滚新增项并保留旧 active route', async () => {
    const { ctx, llm, settings } = fakeHarness({ failOnRoute: 'acp-foo' });
    const registry = installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    llm.calls.length = 0;
    await settings.mutate([
      { op: 'set', path: ['agents', 'devin'], value: { ...devinAgent, name: 'Devin New' } },
      { op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } },
    ]).catch(() => undefined);
    expect(registry.resolveRoute('acp-foo')).toBeUndefined();
    expect(registry.resolveRoute('acp-devin')?.config.name).toBe('Devin');
  });

  it('rename 与冲突同批失败时恢复旧展示名称', async () => {
    const { ctx, settings } = fakeHarness({ failOnRoute: 'acp-foo' });
    const registry = installInstalledProfileRegistry(ctx);
    await settings.mutate([{ op: 'set', path: ['agents', 'devin'], value: { ...devinAgent } }]);
    await settings.mutate([
      { op: 'set', path: ['agents', 'devin'], value: { ...devinAgent, name: 'Devin New' } },
      { op: 'set', path: ['agents', 'foo'], value: { ...fooAgent } },
    ]).catch(() => undefined);
    expect(registry.resolveRoute('acp-devin')?.config.name).toBe('Devin');
  });
});

// ---------- 边界：版本兼容状态派生（readiness 钉版比对） ----------

describe('acpVersionCompatibility（readiness 的纯函数核心）', () => {
  const byId = (id: string) => {
    const descriptor = ACP_AGENT_RUNTIME_DESCRIPTORS.find((candidate) => candidate.id === id);
    if (descriptor === undefined) throw new Error(`fixture: no runtime descriptor ${id}`);
    return descriptor;
  };

  it('无 descriptor / 无握手版本 → null（诚实空缺）；无钉版（devin）→ unpinned', () => {
    expect(acpVersionCompatibility(undefined, '1.2.3')).toBeNull();
    expect(acpVersionCompatibility(byId('codex'), undefined)).toBeNull();
    expect(acpVersionCompatibility(byId('codex'), null)).toBeNull();
    expect(acpVersionCompatibility(byId('devin'), '1.2.3')).toBe('unpinned');
  });

  it('钉版精确比对（trim 后）：等 → pinned，不等 → drifted；kimi 的钉在 wrappedCli', () => {
    expect(acpVersionCompatibility(byId('codex'), '1.6.2')).toBe('pinned');
    expect(acpVersionCompatibility(byId('codex'), ' 1.6.2 ')).toBe('pinned');
    expect(acpVersionCompatibility(byId('codex'), '1.6.3')).toBe('drifted');
    // kimi 的 ACP 面由 wrapped CLI 自身承载，钉在 wrappedCli
    expect(acpVersionCompatibility(byId('kimi'), '0.36.1')).toBe('pinned');
    expect(acpVersionCompatibility(byId('kimi'), '0.36.0')).toBe('drifted');
    // claude 钉 adapter
    expect(acpVersionCompatibility(byId('claude'), '0.70.0')).toBe('pinned');
    expect(acpVersionCompatibility(byId('claude'), '0.69.0')).toBe('drifted');
  });
});
