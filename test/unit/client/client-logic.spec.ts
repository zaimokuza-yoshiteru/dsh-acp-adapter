// client-logic.spec.ts — 随附测试：设置面板 client 半纯逻辑（src/client/data/logic.ts）黑盒契约测试。
//
// 被测模块零 import（无 DOM/fetch/React），直接 vitest 可测。契约值交叉核对自宿主侧
// src/host/composition/registry.ts（settings 形状与 DEVIN_ACP_TEMPLATE）、src/contract/remote.ts（dshAcp
// Remote wire 形状）、src/protocol/v1/types.ts（AcpErrorKind 的 'auth_required'），此处以字面值
// 钉死——client 半禁止 import host 模块，本测试同样只 import 被测模块。
//
// 覆盖：
//   - 常量：命名空间 / id·env 键两类正则 / DEVIN_ACP_TEMPLATE 逐字段 / 健康与失败分类常量
//   - decodeAcpSettings：缺席 → 零 agents；非法整体 → undefined；逐条校验失败传染
//     整个 section；args/env 默认值补齐、loginHint 保留、未知键剥离、防御性拷贝
//   - parseArgsText/formatArgsText：逐行 trim、空行丢弃、行内空白保留、往返归一
//   - parseEnvText/formatEnvText：KEY=VALUE 首个 '=' 切分、key trim + 标识符校验、
// 重复 key、行号 1-based、往返； $credential: 形状值一律字面值（无引用分支）
//   - validateAgentDraft：id 必填/模式/唯一（editingId 豁免）、name/command 必填、
//     env 两分支错误映射（locale key + 行号 params）、多错并发、成功出 config；
// 内置 runtime singleton 冲突（显式 runtime 与 id 回退同口径、点名已有
//     profile、editingId 豁免、generic profile 不受影响）
//   - decodeBoundSessions：boundSessions 应答严格解码（合法往返；畸形/错型整体拒绝）
//   - 草稿种子：emptyDraft / draftFromTemplate / draftFromAgent（含 config 校验往返）
//   - agents map 纯操作：sortedAgentIds / withAgent 增·改 / withoutAgent 删·删缺席
//     （均返回新对象、不改输入）
//   - commandLineOf、panelSettingsOf 四态投影（ready/unavailable/loading/invalid）
// - decodeHealthResponse：三种 probe 分支逐字段、 state 五态词表强制、
//     畸形 body/行/probe 整体拒绝（传染）
// - decodeSandboxFact：合法事实透传；缺席/畸形容忍归 null（不传染健康数据）
// - loginStateOf（none/methods/unknown）、probeNeedsLogin、rowNeedsLogin、
//     showsLoginHint、healthRowOf
// - errorMessageOf（起旁路 HTTP 词汇 ACP_HEALTH_PATH/acpAuthenticatePath/
//     parseHttpErrorMessage 已随 dshAcp Remote 迁移删除）

import { describe, expect, it } from 'vitest';
import {
  ACP_AGENT_ID_PATTERN,
  ACP_BUILTIN_AGENT_TEMPLATES,
  ACP_ENV_KEY_PATTERN,
  ACP_FAILURE_AUTH_REQUIRED,
  ACP_SECRET_ENV_KEY_PATTERN,
  ACP_SETTINGS_NS,
  CLAUDE_ACP_TEMPLATE,
  CODEX_ACP_TEMPLATE,
  DEVIN_ACP_TEMPLATE,
  KIMI_ACP_TEMPLATE,
  commandLineOf,
  decodeAcpSettings,
  decodeBoundSessions,
  decodeHealthResponse,
  decodeSandboxFact,
  draftFromAgent,
  draftFromTemplate,
  dropMaskedEnvKey,
  effectiveRuntimeOf,
  emptyDraft,
  errorMessageOf,
  formatArgsText,
  formatEnvText,
  healthRowOf,
  healthLayersOf,
  loginStateOf,
  panelSettingsOf,
  parseArgsText,
  parseEnvText,
  probeNeedsLogin,
  rowNeedsLogin,
  showsLoginHint,
  sortedAgentIds,
  validateAgentDraft,
  withAgent,
  withoutAgent,
  type AcpAgentConfig,
  type AcpProviderHealth,
  type AgentDraft,
} from '../../../src/client/data/logic.ts';

// ---------- 夹具 ----------

const devinConfig: AcpAgentConfig = {
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  env: {},
  loginHint: 'devin auth login',
};

const fooConfig: AcpAgentConfig = {
  name: 'Foo Agent',
  command: 'foo-cli',
  args: ['serve', '--acp'],
  env: { FOO_HOME: '/opt/foo' },
};

/** 九键齐备的能力事实夹具（okRow 与 decode 专项用例的缺键/错型变体共用）。 */
function fullCaps() {
  return {
    loadSession: true,
    sessionList: true,
    sessionClose: false,
    sessionDelete: true,
    promptImage: true,
    promptAudio: false,
    promptEmbeddedContext: true,
    mcpHttp: false,
    mcpSse: false,
  };
}

/** 清理事实夹具（okRow 用；decode 专项另造三态变体）。 */
const okCleanup = { close: 'not-advertised' as const, delete: 'done' as const, message: null };

/** 端到端能力矩阵夹具（okRow 与各 ok probe 字面量共用；两行覆盖 supported/unsupported + note）。 */
const okMatrix = [
  { id: 'loadSession', advertised: true, adapterPath: 'resume-staging', hostSeam: null, status: 'supported' as const },
  { id: 'promptImage', advertised: true, adapterPath: 'text-only-block', hostSeam: null, status: 'unsupported' as const, note: 'agent advertises image but adapter v1 is text-only' },
];

const okRow: AcpProviderHealth = {
  id: 'devin',
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  loginHint: 'devin auth login',
  executable: true,
  version: '1.2.3',
  state: 'ready',
  probe: {
    status: 'ok',
    at: 1_700_000_000_000,
    modelCount: 2,
    authMethods: [{ id: 'oauth', name: 'OAuth 登录' }],
    agentInfo: { name: 'devin-acp', version: '1.2.3' },
    capabilities: fullCaps(),
    cleanup: okCleanup,
    capabilityHash: '0123456789abcdef',
    protocolVersion: 1,
    versionPolicy: { adapter: null, wrappedCli: null },
    versionCompatibility: 'unpinned',
    matrix: okMatrix,
  },
};

const neverRow: AcpProviderHealth = {
  id: 'foo',
  name: 'Foo Agent',
  command: 'foo-cli',
  args: ['serve', '--acp'],
  loginHint: null,
  executable: false,
  version: null,
  state: 'saved-unverified',
  probe: { status: 'never', at: null },
};

const authErrorRow: AcpProviderHealth = {
  id: 'bar',
  name: 'Bar',
  command: 'bar-cli',
  args: [],
  loginHint: 'bar login',
  executable: true,
  version: null,
  state: 'auth-required',
  probe: { status: 'error', at: 1_700_000_000_001, failureKind: 'auth_required', message: 'sign in first', phase: 'session' },
};

const timeoutRow: AcpProviderHealth = {
  ...authErrorRow,
  state: 'unavailable',
  probe: { status: 'error', at: 1_700_000_000_002, failureKind: 'timeout', message: 'probe timed out', phase: null },
};

function validDraft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    id: 'devin',
    name: 'Devin',
    command: 'devin',
    argsText: 'acp',
    envText: 'A=1',
    loginHint: 'devin auth login',
    ...overrides,
  };
}

// ---------- 常量 ----------

describe('常量：与宿主侧契约逐字对齐', () => {
  it('命名空间 / 失败分类', () => {
    expect(ACP_SETTINGS_NS).toBe('dsh-acp');
    expect(ACP_FAILURE_AUTH_REQUIRED).toBe('auth_required');
  });

  it('ACP_AGENT_ID_PATTERN：小写字母开头 + 小写字母/数字/连字符', () => {
    expect(ACP_AGENT_ID_PATTERN.source).toBe('^[a-z][a-z0-9-]*$');
    for (const ok of ['a', 'devin', 'a1', 'a-b', 'z-9-x']) {
      expect(ACP_AGENT_ID_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['', 'A', 'Devin', '1a', '-a', 'a_b', 'a b', 'a.b', 'a/b']) {
      expect(ACP_AGENT_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('ACP_ENV_KEY_PATTERN 是 POSIX 标识符字母表', () => {
    expect(ACP_ENV_KEY_PATTERN.source).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
    for (const ok of ['A', '_', '_1', 'DEEPSEEK_API_KEY', 'a9_Z']) {
      expect(ACP_ENV_KEY_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['', '1A', 'A-B', 'A B', 'A.B']) {
      expect(ACP_ENV_KEY_PATTERN.test(bad), bad).toBe(false);
    }
  });

 it('DEVIN_ACP_TEMPLATE 逐字段对齐宿主模板（边界：auth 数据面收进 runtime descriptor，不进面板副本；：runtime 显式绑定），且自身过得了 decodeAcpSettings', () => {
    expect(DEVIN_ACP_TEMPLATE).toEqual({
      id: 'devin',
      name: 'Devin',
      command: 'devin',
      args: ['acp'],
      env: {},
      loginHint: 'devin auth login',
      runtime: 'devin',
    });
    expect(ACP_AGENT_ID_PATTERN.test(DEVIN_ACP_TEMPLATE.id)).toBe(true);
    const { id, ...value } = DEVIN_ACP_TEMPLATE;
    expect(decodeAcpSettings({ agents: { [id]: value } })).toEqual({ agents: { devin: { ...devinConfig, runtime: 'devin' } } });
  });

  it('ACP_BUILTIN_AGENT_TEMPLATES 一键模板列表钉版（devin + claude 预设 + codex 预设 + kimi 预设）', () => {
    expect(ACP_BUILTIN_AGENT_TEMPLATES.map((template) => template.id)).toEqual(['devin', 'claude', 'codex', 'kimi']);
    // 模板 id 即 profile id 预填值，均合法
    for (const template of ACP_BUILTIN_AGENT_TEMPLATES) {
      expect(ACP_AGENT_ID_PATTERN.test(template.id), template.id).toBe(true);
      const { id, ...value } = template;
      expect(decodeAcpSettings({ agents: { [id]: value } }), template.id).not.toBeUndefined();
    }
  });

  it('CLAUDE_ACP_TEMPLATE 逐字段钉版：runtime=claude、不假设推理提供方（env 空）', () => {
    expect(CLAUDE_ACP_TEMPLATE).toEqual({
      id: 'claude',
      name: 'Claude',
      command: 'claude-agent-acp',
      args: [],
      env: {},
      loginHint: 'claude 外部登录，或经 ANTHROPIC_* 环境变量配置路由（external-login-only）',
      runtime: 'claude',
    });
  });

  it('CODEX_ACP_TEMPLATE 逐字段钉版（与 host 侧真源对齐）：runtime=codex、env 空', () => {
    expect(CODEX_ACP_TEMPLATE).toEqual({
      id: 'codex',
      name: 'Codex',
      command: 'codex-acp',
      args: [],
      env: {},
      loginHint: 'codex login',
      runtime: 'codex',
    });
  });

  it('KIMI_ACP_TEMPLATE 逐字段钉版（与 host 侧真源对齐）：runtime=kimi、env 空', () => {
    expect(KIMI_ACP_TEMPLATE).toEqual({
      id: 'kimi',
      name: 'Kimi',
      command: 'kimi',
      args: ['acp'],
      env: {},
      loginHint: 'kimi login',
      runtime: 'kimi',
    });
  });

  it('模板 secret 纪律钉：所有一键模板的 env 不含疑似 secret 键，绝不预填 token', () => {
    // ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY 只经 host 侧 descriptor envRefs 从
    // DSH 进程环境注入；模板（会持久化进 settings 文档）不得出现疑似 secret 键。
    for (const template of ACP_BUILTIN_AGENT_TEMPLATES) {
      for (const key of Object.keys(template.env)) {
        expect(ACP_SECRET_ENV_KEY_PATTERN.test(key), `${template.id}.${key}`).toBe(false);
      }
      // 纪律针对 env 键值（loginHint 指引文本点名 env 键名是合法的用户指引）
      const envWire = JSON.stringify(template.env);
      expect(envWire).not.toContain('ANTHROPIC_AUTH_TOKEN');
      expect(envWire).not.toContain('ANTHROPIC_API_KEY');
    }
  });
});

// ---------- settings 解码 ----------

describe('decodeAcpSettings', () => {
  it('缺席/空 section 解析为零 agents', () => {
    expect(decodeAcpSettings(undefined)).toEqual({ agents: {} });
    expect(decodeAcpSettings({})).toEqual({ agents: {} });
    expect(decodeAcpSettings({ agents: {} })).toEqual({ agents: {} });
    // 宿主 schema 同款 ?? 默认：agents 为 null/undefined 按缺席处理
    expect(decodeAcpSettings({ agents: null })).toEqual({ agents: {} });
    expect(decodeAcpSettings({ agents: undefined })).toEqual({ agents: {} });
  });

  it('非法整体拒绝为 undefined', () => {
    for (const bad of [null, 'nope', 42, true, [], ['devin']]) {
      expect(decodeAcpSettings(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(decodeAcpSettings({ agents: [] })).toBeUndefined();
    expect(decodeAcpSettings({ agents: 'x' })).toBeUndefined();
    expect(decodeAcpSettings({ agents: 1 })).toBeUndefined();
  });

 it('解码合法条目：args/env 缺席补默认（null 同缺席）、loginHint 保留、未知键剥离（credentialReadPaths 已废，按未知键剥离）', () => {
    const decoded = decodeAcpSettings({
      agents: {
        devin: {
          name: 'Devin',
          command: 'devin',
          args: ['acp'],
          env: { A: '1' },
          loginHint: 'devin auth login',
          credentialReadPaths: ['~/.local/share/devin/credentials.toml'],
          stray: true,
        },
        foo: { name: 'Foo', command: 'foo-cli' },
        bar: { name: 'Bar', command: 'bar-cli', args: null, env: null },
      },
      strayTop: 1,
    });
    expect(decoded).toEqual({
      agents: {
        devin: {
          name: 'Devin',
          command: 'devin',
          args: ['acp'],
          env: { A: '1' },
          loginHint: 'devin auth login',
        },
        foo: { name: 'Foo', command: 'foo-cli', args: [], env: {} },
        bar: { name: 'Bar', command: 'bar-cli', args: [], env: {} },
      },
    });
  });

 it('边界：runtime 绑定解码——四个合法值保留，非法值/非 string 整体拒绝', () => {
    for (const runtime of ['devin', 'codex', 'kimi', 'claude'] as const) {
      expect(decodeAcpSettings({ agents: { my: { name: 'M', command: 'm', runtime } } })).toEqual({
        agents: { my: { name: 'M', command: 'm', args: [], env: {}, runtime } },
      });
    }
    for (const bad of ['gpt', '', 'DEVIN', 42, null, true]) {
      expect(decodeAcpSettings({ agents: { my: { name: 'M', command: 'm', runtime: bad } } }), JSON.stringify(bad)).toBeUndefined();
    }
  });

 it(' singleton 镜像：同一内置 runtime 被两个 profile 生效绑定（显式或 id 回退）→ 整 section 拒绝为 undefined', () => {
    // 显式 runtime 相撞
    expect(
      decodeAcpSettings({
        agents: {
          alpha: { name: 'A', command: 'a', runtime: 'codex' },
          beta: { name: 'B', command: 'b', runtime: 'codex' },
        },
      }),
    ).toBeUndefined();
    // 显式与 id 回退相撞（beta 无 runtime 但 id 恰为内置 runtime id）
    expect(
      decodeAcpSettings({
        agents: {
          alpha: { name: 'A', command: 'a', runtime: 'kimi' },
          kimi: { name: 'K', command: 'kimi' },
        },
      }),
    ).toBeUndefined();
    // 各自一个 runtime 的四内置共存合法；generic profile（无 runtime 且非内置 id）不受约束
    expect(
      decodeAcpSettings({
        agents: {
          devin: { name: 'D', command: 'devin' },
          claude: { name: 'C', command: 'claude-agent-acp', runtime: 'claude' },
          codex: { name: 'X', command: 'codex-acp' },
          kimi2: { name: 'K2', command: 'kimi', runtime: 'kimi' },
          foo: { name: 'F', command: 'foo-cli' },
          bar: { name: 'B', command: 'bar-cli' },
        },
      }),
    ).not.toBeUndefined();
  });

  it('逐条校验失败传染整个 section（任意一条非法 → undefined）', () => {
    const good = { name: 'D', command: 'devin' };
    const badAgents: Array<[string, unknown]> = [
      ['坏 id（大写）', { Devin: good }],
      ['坏 id（前导连字符）', { '-devin': good }],
      ['坏 id（下划线）', { de_vin: good }],
      ['空 id', { '': good }],
      ['条目非 object', { devin: 'x' }],
      ['条目为数组', { devin: [] }],
      ['缺 name', { devin: { command: 'devin' } }],
      ['空 name', { devin: { name: '', command: 'devin' } }],
      ['name 非 string', { devin: { name: 42, command: 'devin' } }],
      ['缺 command', { devin: { name: 'D' } }],
      ['空 command', { devin: { name: 'D', command: '' } }],
      ['args 非数组', { devin: { ...good, args: 'acp' } }],
      ['args 元素非 string', { devin: { ...good, args: ['acp', 1] } }],
      ['env 非 object', { devin: { ...good, env: [] } }],
      ['env 值非 string', { devin: { ...good, env: { A: 1 } } }],
      ['loginHint 为 null', { devin: { ...good, loginHint: null } }],
      ['loginHint 非 string', { devin: { ...good, loginHint: 42 } }],
    ];
    for (const [label, agents] of badAgents) {
      expect(decodeAcpSettings({ agents }), label).toBeUndefined();
    }
    // 合法条目与非法条目并存同样整体拒绝
    expect(decodeAcpSettings({ agents: { devin: good, Broken: good } })).toBeUndefined();
  });

  it('解码产物是防御性拷贝（改输入不影响产物）', () => {
    const args = ['acp'];
    const env: Record<string, string> = { A: '1' };
    const decoded = decodeAcpSettings({ agents: { devin: { name: 'D', command: 'devin', args, env } } });
    args.push('--mutated');
    env['B'] = '2';
    expect(decoded?.agents['devin']).toEqual({ name: 'D', command: 'devin', args: ['acp'], env: { A: '1' } });
  });
});

// ---------- args 文本 ----------

describe('parseArgsText / formatArgsText', () => {
  it('逐行 trim、空行丢弃、行内空白保留', () => {
    expect(parseArgsText('')).toEqual([]);
    expect(parseArgsText('\n  \n\t\n')).toEqual([]);
    expect(parseArgsText('acp')).toEqual(['acp']);
    expect(parseArgsText('  acp  \n\t--verbose\t')).toEqual(['acp', '--verbose']);
    expect(parseArgsText('acp\n\n\n--verbose')).toEqual(['acp', '--verbose']);
    expect(parseArgsText('--config a  b')).toEqual(['--config a  b']);
    expect(parseArgsText('a\r\nb')).toEqual(['a', 'b']);
  });

  it('formatArgsText 一行一个参数；与 parse 往返/归一', () => {
    expect(formatArgsText([])).toBe('');
    expect(formatArgsText(['acp'])).toBe('acp');
    expect(formatArgsText(['acp', '--verbose'])).toBe('acp\n--verbose');
    expect(parseArgsText(formatArgsText(['acp', '--config a  b']))).toEqual(['acp', '--config a  b']);
    // parse 后再 format 是归一化：前导/尾随空白与空行消失
    expect(formatArgsText(parseArgsText('  acp \n\n --verbose '))).toBe('acp\n--verbose');
  });
});

// ---------- env 文本 ----------

describe('parseEnvText / formatEnvText', () => {
  it('逐行 KEY=VALUE：首个 = 切分、key trim、行 trim 后值原样、空行忽略', () => {
    expect(parseEnvText('')).toEqual({ ok: true, env: {} });
    expect(parseEnvText('\n  \n')).toEqual({ ok: true, env: {} });
    expect(parseEnvText('A=1\nB=2')).toEqual({ ok: true, env: { A: '1', B: '2' } });
    expect(parseEnvText('_=1')).toEqual({ ok: true, env: { _: '1' } });
    // 值内的 = 保留（首个 = 切分）
    expect(parseEnvText('A=a=b=c')).toEqual({ ok: true, env: { A: 'a=b=c' } });
    // 无 = 行：key 为整行，值空串
    expect(parseEnvText('A')).toEqual({ ok: true, env: { A: '' } });
    expect(parseEnvText('A=')).toEqual({ ok: true, env: { A: '' } });
    // 行整体 trim；key 另行 trim；= 之后的值原样（含前导空白）
    expect(parseEnvText('  A=1  ')).toEqual({ ok: true, env: { A: '1' } });
    expect(parseEnvText('A= 1')).toEqual({ ok: true, env: { A: ' 1' } });
    expect(parseEnvText(' A = 1 ')).toEqual({ ok: true, env: { A: ' 1' } });
    expect(parseEnvText('A=1\n\n\nB=2')).toEqual({ ok: true, env: { A: '1', B: '2' } });
  });

  it('key 非法 → key 失败（行号 1-based 且计入空行）', () => {
    expect(parseEnvText('1A=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } });
    expect(parseEnvText('A-B=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } });
    expect(parseEnvText('=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } });
    expect(parseEnvText('A B=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } });
    expect(parseEnvText('A=1\n\n1B=x')).toEqual({ ok: false, failure: { line: 3, reason: 'key' } });
  });

  it('重复 key → duplicate 失败（key trim 后判重，且先于值校验）', () => {
    expect(parseEnvText('A=1\nA=2')).toEqual({ ok: false, failure: { line: 2, reason: 'duplicate' } });
    expect(parseEnvText('A=1\n A =2')).toEqual({ ok: false, failure: { line: 2, reason: 'duplicate' } });
  });

 it('：$credential: 形状的值一律按字面值入 env（引用语法已随宿主侧删除）', () => {
    expect(parseEnvText('A=$credential:DEEPSEEK_API_KEY')).toEqual({
      ok: true,
      env: { A: '$credential:DEEPSEEK_API_KEY' },
    });
    // 空名 / 数字开头 / 连字符 / 含空格 也都不再特殊——没有 credential 失败分支了
    expect(parseEnvText('A=$credential:')).toEqual({ ok: true, env: { A: '$credential:' } });
    expect(parseEnvText('A=$credential:1BAD')).toEqual({ ok: true, env: { A: '$credential:1BAD' } });
    expect(parseEnvText('A=$credential:BAD-NAME')).toEqual({ ok: true, env: { A: '$credential:BAD-NAME' } });
    expect(parseEnvText('A=$credential:OK extra')).toEqual({ ok: true, env: { A: '$credential:OK extra' } });
  });

  it('formatEnvText 与 parse 往返（含 = 值、空值与 $ 前缀字面值）', () => {
    expect(formatEnvText({})).toBe('');
    expect(formatEnvText({ A: '1', B: '2' })).toBe('A=1\nB=2');
    expect(formatEnvText({ A: 'a=b', B: '$credential:KEY' })).toBe('A=a=b\nB=$credential:KEY');
    const env = { A: '1', B: 'a=b', C: '$credential:DEEPSEEK_API_KEY', D: '' };
    expect(parseEnvText(formatEnvText(env))).toEqual({ ok: true, env });
  });
});

// ---------- 草稿校验 ----------

describe('validateAgentDraft', () => {
  it('全合法 → 仅出 config：name/command/loginHint 保留，args/env 解析', () => {
    expect(validateAgentDraft(validDraft(), {}, undefined)).toEqual({
      config: {
        name: 'Devin',
        command: 'devin',
        args: ['acp'],
        env: { A: '1' },
        loginHint: 'devin auth login',
      },
    });
  });

  it('字段 trim 后入 config；loginHint 空白则不出现在 config', () => {
    const result = validateAgentDraft(
      validDraft({ id: '  devin  ', name: ' Devin ', command: ' devin ', argsText: '', envText: '', loginHint: '   ' }),
      {},
      undefined,
    );
    expect(result).toEqual({ config: { name: 'Devin', command: 'devin', args: [], env: {} } });
  });

  it('id 三分支：必填 / 模式 / 唯一（trim 先于一切检查）', () => {
    expect(validateAgentDraft(validDraft({ id: '' }), {}, undefined).id).toEqual({ key: 'errorIdRequired' });
    expect(validateAgentDraft(validDraft({ id: '   ' }), {}, undefined).id).toEqual({ key: 'errorIdRequired' });
    for (const bad of ['Devin', '1devin', '-devin', 'de_vin', 'de vin']) {
      expect(validateAgentDraft(validDraft({ id: bad }), {}, undefined).id, bad).toEqual({ key: 'errorIdInvalid' });
    }
    expect(validateAgentDraft(validDraft({ id: ' devin ' }), { devin: devinConfig }, undefined).id).toEqual({ key: 'errorIdTaken' });
    expect(validateAgentDraft(validDraft(), { devin: devinConfig, foo: fooConfig }, undefined).id).toEqual({ key: 'errorIdTaken' });
  });

  it('编辑豁免：editingId 与自身 id 相同不撞 taken；改成别人的 id 仍撞', () => {
    expect(validateAgentDraft(validDraft(), { devin: devinConfig }, 'devin').id).toBeUndefined();
    expect(validateAgentDraft(validDraft(), { devin: devinConfig, foo: fooConfig }, 'foo').id).toEqual({ key: 'errorIdTaken' });
    // editingId 缺席（新增流程）不豁免
    expect(validateAgentDraft(validDraft(), { devin: devinConfig }, undefined).id).toEqual({ key: 'errorIdTaken' });
  });

 it(' singleton：草稿生效 runtime 撞存量 profile → runtime 错误点名已有 profile，config 缺席', () => {
    // 显式 runtime 相撞（草稿带模板播种的 runtime）
    const seeded = { ...validDraft({ id: 'devin2' }), runtime: 'devin' as const };
    const conflict = validateAgentDraft(seeded, { devin: { ...devinConfig, runtime: 'devin' } }, undefined);
    expect(conflict.runtime).toEqual({
      key: 'errorRuntimeTaken',
      params: { runtime: 'devin', id: 'devin', name: 'Devin' },
    });
    expect(conflict.config).toBeUndefined();
    // id 回退相撞：草稿无 runtime 但 id 恰为内置 id，存量条目也无 runtime 按 id 回退
    const kimiConfig: AcpAgentConfig = { name: 'K', command: 'kimi', args: [], env: {} };
    const fallback = validateAgentDraft(validDraft(), { kimi: kimiConfig }, undefined);
    // validDraft 的 id=devin 与存量 kimi 不撞 → 无 runtime 错误
    expect(fallback.runtime).toBeUndefined();
    const fallbackHit = validateAgentDraft(
      validDraft({ id: 'kimi' }),
      { kimi: kimiConfig },
      undefined,
    );
    expect(fallbackHit.runtime).toEqual({
      key: 'errorRuntimeTaken',
      params: { runtime: 'kimi', id: 'kimi', name: 'K' },
    });
  });

 it(' singleton 豁免：编辑自身不撞；generic profile（无 runtime 且非内置 id）永不受约束', () => {
    const boundDevin = { ...devinConfig, runtime: 'devin' as const };
    const editSelf = { ...validDraft(), runtime: 'devin' as const };
    expect(validateAgentDraft(editSelf, { devin: boundDevin }, 'devin').runtime).toBeUndefined();
    // generic 草稿对 generic 存量：双方都无 runtime 身份，多实例合法
    const generic = validDraft({ id: 'foo' });
    expect(validateAgentDraft(generic, { foo: fooConfig }, 'foo').config).not.toBeUndefined();
    expect(validateAgentDraft(generic, { bar: fooConfig }, undefined).config).not.toBeUndefined();
  });

  it('effectiveRuntimeOf：显式 runtime 优先，内置 id 回退，generic 归 undefined（与 host descriptorOf 同口径）', () => {
    expect(effectiveRuntimeOf('foo', { runtime: 'codex' })).toBe('codex');
    expect(effectiveRuntimeOf('kimi', {})).toBe('kimi');
    expect(effectiveRuntimeOf('foo', {})).toBeUndefined();
  });

  it('name / command 必填（空白视同空）', () => {
    expect(validateAgentDraft(validDraft({ name: '' }), {}, undefined).name).toEqual({ key: 'errorNameRequired' });
    expect(validateAgentDraft(validDraft({ name: '  ' }), {}, undefined).name).toEqual({ key: 'errorNameRequired' });
    expect(validateAgentDraft(validDraft({ command: '' }), {}, undefined).command).toEqual({ key: 'errorCommandRequired' });
    expect(validateAgentDraft(validDraft({ command: '\t' }), {}, undefined).command).toEqual({ key: 'errorCommandRequired' });
  });

 it('env 两分支映射：key/duplicate → locale key + 行号 params（credential 分支已删）', () => {
    expect(validateAgentDraft(validDraft({ envText: '1A=x' }), {}, undefined).env).toEqual({
      key: 'errorEnvKey',
      params: { line: 1 },
    });
    expect(validateAgentDraft(validDraft({ envText: 'A=1\nA=2' }), {}, undefined).env).toEqual({
      key: 'errorEnvDuplicate',
      params: { line: 2 },
    });
  });

  it('任一错误存在即无 config；多字段错误并发报告', () => {
    expect(validateAgentDraft(validDraft({ envText: '1A=x' }), {}, undefined).config).toBeUndefined();
    const all = validateAgentDraft(
      { id: '', name: '', command: '', argsText: '', envText: 'A=1\nA=2', loginHint: '' },
      {},
      undefined,
    );
    expect(all).toEqual({
      id: { key: 'errorIdRequired' },
      name: { key: 'errorNameRequired' },
      command: { key: 'errorCommandRequired' },
      env: { key: 'errorEnvDuplicate', params: { line: 2 } },
    });
  });

  it('成功 config 的 args/env 来自 argsText/envText 的解析结果', () => {
    const result = validateAgentDraft(
      validDraft({ argsText: 'acp\n--verbose', envText: 'A=1\nB=$credential:KEY', loginHint: '' }),
      {},
      undefined,
    );
    expect(result.config).toEqual({
      name: 'Devin',
      command: 'devin',
      args: ['acp', '--verbose'],
      env: { A: '1', B: '$credential:KEY' },
    });
  });
});

// ---------- 草稿种子 ----------

describe('草稿种子：emptyDraft / draftFromTemplate / draftFromAgent', () => {
  it('emptyDraft 全空串', () => {
    expect(emptyDraft()).toEqual({ id: '', name: '', command: '', argsText: '', envText: '', loginHint: '' });
  });

  it('draftFromTemplate 按模板 id 播种：devin / claude / codex / kimi 各回其编辑态', () => {
    expect(draftFromTemplate('devin')).toEqual({
      id: 'devin',
      name: 'Devin',
      command: 'devin',
      argsText: 'acp',
      envText: '',
      loginHint: 'devin auth login',
      runtime: 'devin',
    });
    const { id: _dvId, ...devinValue } = DEVIN_ACP_TEMPLATE;
    expect(validateAgentDraft(draftFromTemplate('devin') as AgentDraft, {}, undefined).config).toEqual(devinValue);

    // claude 通用预设：env 空（不假设推理提供方）
    const claudeDraft = draftFromTemplate('claude');
    expect(claudeDraft).toEqual({
      id: 'claude',
      name: 'Claude',
      command: 'claude-agent-acp',
      argsText: '',
      envText: '',
      loginHint: CLAUDE_ACP_TEMPLATE.loginHint,
      runtime: 'claude',
    });

    // codex 预设：env 空，runtime 绑定随草稿过站
    const codexDraft = draftFromTemplate('codex');
    expect(codexDraft).toEqual({
      id: 'codex',
      name: 'Codex',
      command: 'codex-acp',
      argsText: '',
      envText: '',
      loginHint: 'codex login',
      runtime: 'codex',
    });
    const { id: _cxId, ...codexValue } = CODEX_ACP_TEMPLATE;
    expect(validateAgentDraft(codexDraft as AgentDraft, {}, undefined).config).toEqual(codexValue);

    // kimi 预设：env 空，runtime 绑定随草稿过站
    const kimiDraft = draftFromTemplate('kimi');
    expect(kimiDraft).toEqual({
      id: 'kimi',
      name: 'Kimi',
      command: 'kimi',
      argsText: 'acp',
      envText: '',
      loginHint: 'kimi login',
      runtime: 'kimi',
    });
    const { id: _kmId, ...kimiValue } = KIMI_ACP_TEMPLATE;
    expect(validateAgentDraft(kimiDraft as AgentDraft, {}, undefined).config).toEqual(kimiValue);

    // 未知模板 id → undefined（按钮只从模板列表渲染，正常不可达）
    expect(draftFromTemplate('no-such-template')).toBeUndefined();
  });

  it('draftFromAgent：args/env 渲染成逐行文本，loginHint 缺席补空串', () => {
    expect(draftFromAgent('foo', fooConfig)).toEqual({
      id: 'foo',
      name: 'Foo Agent',
      command: 'foo-cli',
      argsText: 'serve\n--acp',
      envText: 'FOO_HOME=/opt/foo',
      loginHint: '',
    });
    expect(draftFromAgent('devin', devinConfig).loginHint).toBe('devin auth login');
  });

  it('draftFromAgent 与 validateAgentDraft 往返：存出的 config 原样回得来', () => {
    for (const [id, config] of [['devin', devinConfig], ['foo', fooConfig]] as const) {
      expect(validateAgentDraft(draftFromAgent(id, config), { [id]: config }, id)).toEqual({ config });
    }
  });

 it('边界：runtime 绑定随草稿过站——编辑器不暴露，保存不静默解除', () => {
    const bound: AcpAgentConfig = { ...fooConfig, runtime: 'claude' };
    const draft = draftFromAgent('foo', bound);
    expect(draft.runtime).toBe('claude');
    expect(validateAgentDraft(draft, { foo: bound }, 'foo')).toEqual({ config: bound });
    // 无绑定的 config 不带 runtime 字段（保持「无绑定 = 字段缺席」单一形态）
    expect('runtime' in draftFromAgent('foo', fooConfig)).toBe(false);
  });
});

// ----------：疑似 secret env 键的掩码过站 ----------

describe(' env 密钥掩码（draftFromAgent / validateAgentDraft / dropMaskedEnvKey）', () => {
  const secretConfig: AcpAgentConfig = {
    name: 'Secretive',
    command: 'secretive-cli',
    args: [],
    env: { DEVIN_API_KEY: 'sk-live-9f8e7d', ANTHROPIC_TOKEN: 'tok-abc', FOO_HOME: '/opt/foo' },
  };

  it('draftFromAgent：疑似 secret 的键不进 envText（值不回显），原值进 maskedEnv 过站', () => {
    const draft = draftFromAgent('secretive', secretConfig);
    expect(draft.envText).toBe('FOO_HOME=/opt/foo');
    expect(draft.maskedEnv).toEqual({ DEVIN_API_KEY: 'sk-live-9f8e7d', ANTHROPIC_TOKEN: 'tok-abc' });
    // 文本框（用户可见面）序列化后不含任何疑似键的值
    expect(draft.envText).not.toContain('sk-live-9f8e7d');
    expect(draft.envText).not.toContain('DEVIN_API_KEY');
    // 无疑似键的 config 不带 maskedEnv 字段（单一形态：无掩码 = 字段不在）
    expect('maskedEnv' in draftFromAgent('foo', fooConfig)).toBe(false);
  });

  it('validateAgentDraft：掩码键原样合回 config.env；同名显式重填优先（轮换值）', () => {
    const draft = draftFromAgent('secretive', secretConfig);
    // 不动文本框：掩码值原样保留
    expect(validateAgentDraft(draft, { secretive: secretConfig }, 'secretive').config?.env).toEqual(secretConfig.env);
    // 同名重填 = 轮换；新增疑似键经文本框显式录入也照存（用户亲手输入即所见即所存）
    const rotated: AgentDraft = { ...draft, envText: `${draft.envText}\nDEVIN_API_KEY=sk-rotated-123` };
    expect(validateAgentDraft(rotated, { secretive: secretConfig }, 'secretive').config?.env).toEqual({
      DEVIN_API_KEY: 'sk-rotated-123',
      ANTHROPIC_TOKEN: 'tok-abc',
      FOO_HOME: '/opt/foo',
    });
  });

  it('dropMaskedEnvKey：移除指定键；删空后 maskedEnv 字段整体缺席；未知键原样返回', () => {
    const draft = draftFromAgent('secretive', secretConfig);
    const dropped = dropMaskedEnvKey(draft, 'DEVIN_API_KEY');
    expect(dropped.maskedEnv).toEqual({ ANTHROPIC_TOKEN: 'tok-abc' });
    // 保存后该键即从 config.env 消失（UI 移除行 = 删除该键）
    expect(validateAgentDraft(dropped, { secretive: secretConfig }, 'secretive').config?.env).toEqual({
      ANTHROPIC_TOKEN: 'tok-abc',
      FOO_HOME: '/opt/foo',
    });
    const emptied = dropMaskedEnvKey(dropMaskedEnvKey(draft, 'DEVIN_API_KEY'), 'ANTHROPIC_TOKEN');
    expect('maskedEnv' in emptied).toBe(false);
    const untouched = dropMaskedEnvKey(draft, 'NO_SUCH_KEY');
    expect(untouched).toBe(draft);
  });
});

// ---------- agents map 纯操作 ----------

describe('agents map 纯操作：sortedAgentIds / withAgent / withoutAgent', () => {
  it('sortedAgentIds 按 localeCompare 序返回全部 id', () => {
    expect(sortedAgentIds({})).toEqual([]);
    expect(sortedAgentIds({ devin: devinConfig })).toEqual(['devin']);
    expect(sortedAgentIds({ gamma: devinConfig, alpha: devinConfig, beta: devinConfig })).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('withAgent 新增：返回含新条目的新 map，输入不变', () => {
    const before = { devin: devinConfig };
    const after = withAgent(before, 'foo', fooConfig);
    expect(after).toEqual({ devin: devinConfig, foo: fooConfig });
    expect(after).not.toBe(before);
    expect(before).toEqual({ devin: devinConfig });
  });

  it('withAgent 改写：同 id 替换整条 config，其余键保留', () => {
    const replacement: AcpAgentConfig = { name: 'Devin Pro', command: 'devin2', args: [], env: {} };
    const after = withAgent({ devin: devinConfig, foo: fooConfig }, 'devin', replacement);
    expect(after).toEqual({ devin: replacement, foo: fooConfig });
    expect(after['devin']).toBe(replacement);
  });

  it('withoutAgent 删除：返回缺该键的新 map，输入不变；删缺席 id 得等值拷贝', () => {
    const before = { devin: devinConfig, foo: fooConfig };
    const after = withoutAgent(before, 'devin');
    expect(after).toEqual({ foo: fooConfig });
    expect(after).not.toBe(before);
    expect(before).toEqual({ devin: devinConfig, foo: fooConfig });
    const same = withoutAgent(before, 'ghost');
    expect(same).toEqual(before);
    expect(same).not.toBe(before);
  });
});

describe('commandLineOf', () => {
  it('command + args 空格拼接；无 args 仅 command', () => {
    expect(commandLineOf({ command: 'devin', args: [] })).toBe('devin');
    expect(commandLineOf({ command: 'devin', args: ['acp'] })).toBe('devin acp');
    expect(commandLineOf({ command: 'foo-cli', args: ['serve', '--acp'] })).toBe('foo-cli serve --acp');
  });
});

// ---------- settings 快照投影 ----------

describe('panelSettingsOf', () => {
  it('ready → ready，agents/writable/revision 透传；value 缺席时 agents 归零', () => {
    expect(
      panelSettingsOf({ status: 'ready', value: { agents: { devin: devinConfig } }, revision: 3, writable: true }),
    ).toEqual({ status: 'ready', writable: true, agents: { devin: devinConfig }, revision: 3 });
    expect(panelSettingsOf({ status: 'ready', value: undefined, revision: 3, writable: false }).agents).toEqual({});
  });

  it('unavailable → unavailable；loading 按 revision 分 loading/invalid', () => {
    expect(panelSettingsOf({ status: 'unavailable', value: undefined, revision: undefined, writable: false })).toEqual({
      status: 'unavailable',
      writable: false,
      agents: {},
      revision: undefined,
    });
    expect(panelSettingsOf({ status: 'loading', value: undefined, revision: undefined, writable: true }).status).toBe('loading');
    // decode miss：scope 停在 loading 但 revision 证明读到过 → invalid
    expect(panelSettingsOf({ status: 'loading', value: undefined, revision: 7, writable: false })).toEqual({
      status: 'invalid',
      writable: false,
      agents: {},
      revision: 7,
    });
  });
});

// ---------- 健康响应解码 ----------

describe('decodeHealthResponse', () => {
  it('合法响应：三种 probe 分支逐字段解出；未知顶层/行键剥离', () => {
    const body = { providers: [okRow, neverRow, authErrorRow] };
    expect(decodeHealthResponse(body)).toEqual([okRow, neverRow, authErrorRow]);
    expect(decodeHealthResponse({ providers: [] })).toEqual([]);
    expect(decodeHealthResponse({ providers: [{ ...okRow, extra: 1 }], extra: true })).toEqual([okRow]);
  });

  it('authMethods：null（宿主未透传）与空数组均合法；description 可缺/为 null', () => {
    const withNull = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 0, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    const withEmpty = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 0, authMethods: [], agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    const withDesc = {
      ...okRow,
      probe: { status: 'ok', at: 1, modelCount: 1, authMethods: [{ id: 'oauth', name: 'OAuth', description: null }], agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix },
    };
    expect(decodeHealthResponse({ providers: [withNull] })).toEqual([withNull]);
    expect(decodeHealthResponse({ providers: [withEmpty] })).toEqual([withEmpty]);
    expect(decodeHealthResponse({ providers: [withDesc] })).toEqual([withDesc]);
  });

 it('readiness 三键：null 词表与三态合法值解出；词表外/畸形整行拒', () => {
    const probe = okRow.probe;
    if (probe.status !== 'ok') throw new Error('fixture: okRow.probe must be the ok branch');
    // 合法：versionCompatibility 三态 + null；versionPolicy 双 null 词表或带值；protocolVersion number|null
    for (const versionCompatibility of ['pinned', 'drifted', 'unpinned', null] as const) {
      const row = { ...okRow, probe: { ...probe, protocolVersion: 1, versionPolicy: { adapter: '1.6.2', wrappedCli: null }, versionCompatibility } };
      expect(decodeHealthResponse({ providers: [row] }), String(versionCompatibility)).toEqual([row]);
    }
    const nullTriple = { ...okRow, probe: { ...probe, protocolVersion: null, versionPolicy: null, versionCompatibility: null } };
    expect(decodeHealthResponse({ providers: [nullTriple] })).toEqual([nullTriple]);
    // 词表外/畸形：strict codec 边界整行拒绝
    for (const patch of [
      { protocolVersion: '1' },
      { versionPolicy: { adapter: 1, wrappedCli: null } },
      { versionPolicy: 'none' },
      { versionCompatibility: 'unknown' },
      { versionCompatibility: 42 },
    ]) {
      const row = { ...okRow, probe: { ...probe, ...patch } };
      expect(decodeHealthResponse({ providers: [row] }), JSON.stringify(patch)).toBeUndefined();
    }
  });

 it('matrix：空数组/note 缺席/未知行 id 均合法解出（向前兼容 host 新增行）', () => {
    const empty = { ...okRow, probe: { ...okRow.probe, matrix: [] } };
    expect(decodeHealthResponse({ providers: [empty] })).toEqual([empty]);
    const noNote = {
      ...okRow,
      probe: { ...okRow.probe, matrix: [{ id: 'futureRow', advertised: null, adapterPath: 'x', hostSeam: null, status: 'degraded' }] },
    };
    expect(decodeHealthResponse({ providers: [noNote] })).toEqual([noNote]);
  });

  it('畸形整体拒绝：body 非 object / providers 非数组', () => {
    for (const bad of [null, 'x', 42, [], {}]) {
      expect(decodeHealthResponse(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(decodeHealthResponse({ providers: {} })).toBeUndefined();
    expect(decodeHealthResponse({ providers: 'rows' })).toBeUndefined();
  });

  it('行字段违规逐一拒绝（且传染整个响应）', () => {
    const badRows: Array<[string, unknown]> = [
      ['行非 object', 'devin'],
      ['id 非 string', { ...okRow, id: 1 }],
      ['name 非 string', { ...okRow, name: null }],
      ['command 非 string', { ...okRow, command: undefined }],
      ['args 非数组', { ...okRow, args: 'acp' }],
      ['args 元素非 string', { ...okRow, args: ['acp', 1] }],
      ['loginHint 缺席（宿主恒发 string|null）', { ...okRow, loginHint: undefined }],
      ['loginHint 数字', { ...okRow, loginHint: 42 }],
      ['executable 非 boolean', { ...okRow, executable: 'yes' }],
      ['version 缺席', { ...okRow, version: undefined }],
      ['version 数字', { ...okRow, version: 1 }],
 // state 为五态词表强制字段
      ['state 缺席', { ...okRow, state: undefined }],
      ['state 未知值', { ...okRow, state: 'half-ready' }],
      ['state 非 string', { ...okRow, state: 1 }],
    ];
    for (const [label, row] of badRows) {
      expect(decodeHealthResponse({ providers: [row] }), label).toBeUndefined();
      // 传染：好行与坏行并存同样整体拒绝
      expect(decodeHealthResponse({ providers: [neverRow, row] }), `${label}（传染）`).toBeUndefined();
    }
  });

 it(' state 词表：五态全部合法解出（行其余字段不动）', () => {
    for (const state of ['saved-unverified', 'ready', 'auth-required', 'unavailable', 'incompatible'] as const) {
      const row = { ...okRow, state };
      expect(decodeHealthResponse({ providers: [row] }), state).toEqual([row]);
    }
  });

  it('probe 分支违规逐一拒绝', () => {
    const okBase = { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, matrix: okMatrix };
    const errBase = { status: 'error', at: 1, failureKind: 'timeout', message: 'boom', phase: null };
    const badProbes: Array<[string, unknown]> = [
      ['probe 非 object', 'ok'],
      ['probe status 未知', { status: 'pending', at: 1 }],
      ['never 的 at 非 null', { status: 'never', at: 1 }],
      ['never 缺 at', { status: 'never' }],
      ['ok 缺 at', { ...okBase, at: undefined }],
      ['ok 的 modelCount 非 number', { ...okBase, modelCount: '2' }],
      ['ok 的 authMethods 非 null/数组', { ...okBase, authMethods: 'oauth' }],
      ['authMethods 元素缺 name', { ...okBase, authMethods: [{ id: 'oauth' }] }],
      ['authMethods 元素 id 非 string', { ...okBase, authMethods: [{ id: 1, name: 'OAuth' }] }],
      ['ok 缺 agentInfo（宿主恒发 string|null 词表）', { status: 'ok', at: 1, modelCount: 1, authMethods: null, capabilities: null, cleanup: null, capabilityHash: null, matrix: okMatrix }],
      ['ok 缺 capabilities', { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, cleanup: null, capabilityHash: null, matrix: okMatrix }],
      ['agentInfo 缺 version', { ...okBase, agentInfo: { name: 'devin-acp' } }],
      ['agentInfo name 非 string', { ...okBase, agentInfo: { name: 1, version: '1' } }],
      ['capabilities 缺键', { ...okBase, capabilities: { loadSession: true } }],
      ['capabilities 值非 boolean', { ...okBase, capabilities: { ...fullCaps(), promptImage: 'yes' } }],
 // cleanup/capabilityHash 为宿主恒发键（null 词表或合法事实）
      ['ok 缺 cleanup', { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, capabilityHash: null, matrix: okMatrix }],
      ['ok 缺 capabilityHash', { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, matrix: okMatrix }],
      ['cleanup 步骤词表外', { ...okBase, cleanup: { close: 'maybe', delete: 'done', message: null } }],
      ['cleanup 缺 delete', { ...okBase, cleanup: { close: 'done', message: null } }],
      ['cleanup message 非 string/null', { ...okBase, cleanup: { close: 'done', delete: 'failed', message: 7 } }],
      ['capabilityHash 非 string/null', { ...okBase, capabilityHash: 16 }],
 // matrix 为 probe-ok 宿主恒发键（逐行严检，畸形整包拒）
      ['ok 缺 matrix', { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null }],
      ['matrix 非数组', { ...okBase, matrix: {} }],
      ['matrix 行非 object', { ...okBase, matrix: ['loadSession'] }],
      ['matrix 行缺 id', { ...okBase, matrix: [{ advertised: true, adapterPath: 'resume-staging', hostSeam: null, status: 'supported' }] }],
      ['matrix advertised 非 boolean/null', { ...okBase, matrix: [{ id: 'loadSession', advertised: 'yes', adapterPath: 'resume-staging', hostSeam: null, status: 'supported' }] }],
      ['matrix hostSeam 非 string/null', { ...okBase, matrix: [{ id: 'sandbox', advertised: null, adapterPath: 'confined-spawn', hostSeam: 1, status: 'supported' }] }],
      ['matrix status 词表外', { ...okBase, matrix: [{ id: 'loadSession', advertised: true, adapterPath: 'resume-staging', hostSeam: null, status: 'half' }] }],
      ['matrix note 非 string', { ...okBase, matrix: [{ id: 'mcpHttp', advertised: false, adapterPath: 'mcpServers-empty', hostSeam: null, status: 'unsupported', note: 10 }] }],
      ['error 缺 failureKind', { ...errBase, failureKind: undefined }],
      ['error 的 message 非 string', { ...errBase, message: 42 }],
      ['error 的 at 非 number', { ...errBase, at: 'now' }],
      ['error 缺 phase（宿主恒发 phase|null 词表）', { status: 'error', at: 1, failureKind: 'timeout', message: 'boom' }],
      ['error phase 非法值', { ...errBase, phase: 'prompt' }],
    ];
    for (const [label, probe] of badProbes) {
      expect(decodeHealthResponse({ providers: [{ ...okRow, probe }] }), label).toBeUndefined();
    }
  });
});

// ---------- 健康四层（executable / initialize / session / prompt-auth） ----------

describe('healthLayersOf', () => {
  it('行缺席 → 四层全 unknown（端点未覆盖该 agent）', () => {
    expect(healthLayersOf(undefined)).toEqual({
      executable: { state: 'unknown' },
      initialize: { state: 'unknown' },
      session: { state: 'unknown' },
      promptAuth: { state: 'unknown' },
    });
  });

  it('never：只 executable 有事实，其余三层 unknown（未探测不猜测）', () => {
    expect(healthLayersOf(neverRow)).toEqual({
      executable: { state: 'failed' },
      initialize: { state: 'unknown' },
      session: { state: 'unknown' },
      promptAuth: { state: 'unknown' },
    });
    const executableNever: AcpProviderHealth = { ...neverRow, executable: true, version: '0.1.0' };
    expect(healthLayersOf(executableNever).executable).toEqual({ state: 'ok' });
  });

  it('ok：executable/initialize/session 全 ok（session 带模型数），promptAuth 诚实标 unverified', () => {
    expect(healthLayersOf(okRow)).toEqual({
      executable: { state: 'ok' },
      initialize: { state: 'ok' },
      session: { state: 'ok', modelCount: 2 },
      promptAuth: { state: 'unverified' },
    });
    // 模型数 0 如实透传（agent 未广告模型选项）
    const zeroModels: AcpProviderHealth = {
      ...okRow,
      probe: { status: 'ok', at: 1, modelCount: 0, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix },
    };
    expect(healthLayersOf(zeroModels).session).toEqual({ state: 'ok', modelCount: 0 });
  });

  it('error + phase=session：initialize 已证 ok，session failed 带 failureKind', () => {
    expect(healthLayersOf(authErrorRow)).toEqual({
      executable: { state: 'ok' },
      initialize: { state: 'ok' },
      session: { state: 'failed', failureKind: 'auth_required' },
      promptAuth: { state: 'needsLogin' },
    });
  });

  it('error + phase=initialize：initialize failed，session blocked（未到达）', () => {
    const initFailRow: AcpProviderHealth = {
      ...authErrorRow,
      probe: { status: 'error', at: 2, failureKind: 'protocol-error', message: 'bad handshake', phase: 'initialize' },
    };
    expect(healthLayersOf(initFailRow)).toEqual({
      executable: { state: 'ok' },
      initialize: { state: 'failed', failureKind: 'protocol-error' },
      session: { state: 'blocked' },
      promptAuth: { state: 'blocked' },
    });
  });

  it('error + phase=null：不猜测到达点——initialize failed、session unknown', () => {
    expect(healthLayersOf(timeoutRow)).toEqual({
      executable: { state: 'ok' },
      initialize: { state: 'failed', failureKind: 'timeout' },
      session: { state: 'unknown' },
      promptAuth: { state: 'blocked' },
    });
  });

  it('promptAuth：auth_required → needsLogin（可行动），其余 failureKind → blocked', () => {
    // auth_required 即使发生在 initialize 阶段也给 needsLogin（登录是唯一的下一步）
    const earlyAuth: AcpProviderHealth = {
      ...authErrorRow,
      probe: { status: 'error', at: 3, failureKind: 'auth_required', message: 'sign in', phase: 'initialize' },
    };
    expect(healthLayersOf(earlyAuth).promptAuth).toEqual({ state: 'needsLogin' });
    expect(healthLayersOf(timeoutRow).promptAuth).toEqual({ state: 'blocked' });
  });
});

// ---------- 沙箱 enforcement 事实解码（容忍式，与 decodeHealthResponse 的整体拒绝不同） ----------

describe('decodeSandboxFact', () => {
  it('合法事实逐字段透传：full/note=null 与 partial/note=文案 两态', () => {
    expect(decodeSandboxFact({ providers: [], sandbox: { platform: 'darwin', enforcement: 'full', note: null } })).toEqual({
      platform: 'darwin',
      enforcement: 'full',
      note: null,
    });
    const partial = { platform: 'win32', enforcement: 'partial', note: 'ACL 加固为尽力而为' };
    expect(decodeSandboxFact({ providers: [], sandbox: partial })).toEqual(partial);
  });

  it('容忍缺席/畸形一律归 null：面板少一行标注，绝不让健康数据失格', () => {
    const bads: Array<[string, unknown]> = [
      ['body 非 object（null）', null],
      ['body 非 object（数组）', []],
      ['sandbox 键缺席（旧版 host 半）', { providers: [] }],
      ['sandbox 为 null', { sandbox: null }],
      ['sandbox 非 object', { sandbox: 'partial' }],
      ['platform 缺席', { sandbox: { enforcement: 'full', note: null } }],
      ['platform 空串', { sandbox: { platform: '', enforcement: 'full', note: null } }],
      ['platform 非 string', { sandbox: { platform: 42, enforcement: 'full', note: null } }],
      ['enforcement 非法值', { sandbox: { platform: 'darwin', enforcement: 'enforced', note: null } }],
      ['enforcement 缺席', { sandbox: { platform: 'darwin', note: null } }],
      ['note 非 string/null', { sandbox: { platform: 'darwin', enforcement: 'full', note: 0 } }],
      ['note 缺席', { sandbox: { platform: 'darwin', enforcement: 'full' } }],
    ];
    for (const [label, body] of bads) {
      expect(decodeSandboxFact(body), label).toBeNull();
    }
  });
});

// ---------- boundSessions 应答解码（删除确认提示的 binding 计数） ----------

describe('decodeBoundSessions', () => {
  it('合法应答原样往返（count=0 也是合法计数）', () => {
    expect(decodeBoundSessions({ agentId: 'devin', count: 3 })).toEqual({ agentId: 'devin', count: 3 });
    expect(decodeBoundSessions({ agentId: 'kimi', count: 0 })).toEqual({ agentId: 'kimi', count: 0 });
  });

  it('畸形/错型整体拒绝为 undefined（绝不拿解码失败冒充 0）', () => {
    const bads: Array<[string, unknown]> = [
      ['整体非 object', 'nope'],
      ['整体为数组', []],
      ['整体为 null', null],
      ['agentId 缺席', { count: 1 }],
      ['agentId 非法 id', { agentId: 'Devin Agent', count: 1 }],
      ['agentId 非 string', { agentId: 42, count: 1 }],
      ['count 缺席', { agentId: 'devin' }],
      ['count 非 number', { agentId: 'devin', count: '3' }],
      ['count 非整数', { agentId: 'devin', count: 1.5 }],
      ['count 负数', { agentId: 'devin', count: -1 }],
    ];
    for (const [label, body] of bads) {
      expect(decodeBoundSessions(body), label).toBeUndefined();
    }
  });
});

// ---------- 登录态派生 ----------

describe('loginStateOf', () => {
  it('ok + authMethods [] → 无需认证；非空 → N 种方式（原样透传）', () => {
    const noMethods: AcpProviderHealth = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 1, authMethods: [], agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    expect(loginStateOf(noMethods)).toEqual({ kind: 'none' });
    const methods = [
      { id: 'oauth', name: 'OAuth' },
      { id: 'token', name: 'Token' },
    ];
    const withMethods: AcpProviderHealth = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 1, authMethods: methods, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    const state = loginStateOf(withMethods);
    expect(state).toEqual({ kind: 'methods', methods });
    if (state.kind === 'methods') expect(state.methods).toBe(methods);
  });

  it('unknown：行缺席 / never / error / authMethods null', () => {
    expect(loginStateOf(undefined)).toEqual({ kind: 'unknown' });
    expect(loginStateOf(neverRow)).toEqual({ kind: 'unknown' });
    expect(loginStateOf(authErrorRow)).toEqual({ kind: 'unknown' });
    const nullMethods: AcpProviderHealth = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    expect(loginStateOf(nullMethods)).toEqual({ kind: 'unknown' });
  });
});

describe('probeNeedsLogin / rowNeedsLogin / showsLoginHint / healthRowOf', () => {
  it('probeNeedsLogin：仅 error + auth_required 为真', () => {
    expect(probeNeedsLogin(authErrorRow)).toBe(true);
    expect(probeNeedsLogin(timeoutRow)).toBe(false);
    expect(probeNeedsLogin(okRow)).toBe(false);
    expect(probeNeedsLogin(neverRow)).toBe(false);
    expect(probeNeedsLogin(undefined)).toBe(false);
  });

 it('rowNeedsLogin：probe auth_required 或 state=auth-required 任一成立即为真', () => {
    expect(rowNeedsLogin(authErrorRow)).toBe(true); // 两者皆真
    // state 单源：probe 是 timeout 但宿主判 state=auth-required（如 ok 零模型行）
    expect(rowNeedsLogin({ ...timeoutRow, state: 'auth-required' })).toBe(true);
    // probe 单源：state 未跟上但 probe 已报 auth_required
    expect(rowNeedsLogin({ ...authErrorRow, state: 'unavailable' })).toBe(true);
    expect(rowNeedsLogin(timeoutRow)).toBe(false);
    expect(rowNeedsLogin(okRow)).toBe(false);
    expect(rowNeedsLogin(undefined)).toBe(false);
  });

  it('showsLoginHint：要登录（rowNeedsLogin）或广告了 auth 方式才显示', () => {
    expect(showsLoginHint(authErrorRow)).toBe(true); // auth_required error
    expect(showsLoginHint({ ...timeoutRow, state: 'auth-required' })).toBe(true); // state 单源
    expect(showsLoginHint(okRow)).toBe(true); // methods advertised
    const noMethods: AcpProviderHealth = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 1, authMethods: [], agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    expect(showsLoginHint(noMethods)).toBe(false); // 无需认证
    const nullMethods: AcpProviderHealth = { ...okRow, probe: { status: 'ok', at: 1, modelCount: 1, authMethods: null, agentInfo: null, capabilities: null, cleanup: null, capabilityHash: null, protocolVersion: null, versionPolicy: null, versionCompatibility: null, matrix: okMatrix } };
    expect(showsLoginHint(nullMethods)).toBe(false); // 未知
    expect(showsLoginHint(timeoutRow)).toBe(false); // 非登录类失败
    expect(showsLoginHint(neverRow)).toBe(false);
    expect(showsLoginHint(undefined)).toBe(false);
  });

  it('healthRowOf 按 id 匹配；未覆盖/空列表 → undefined', () => {
    const rows = [okRow, neverRow, authErrorRow];
    expect(healthRowOf(rows, 'devin')).toBe(okRow);
    expect(healthRowOf(rows, 'foo')).toBe(neverRow);
    expect(healthRowOf(rows, 'ghost')).toBeUndefined();
    expect(healthRowOf([], 'devin')).toBeUndefined();
  });
});

// ---------- 错误文本整形 ----------

describe('错误文本整形：errorMessageOf', () => {
  it('errorMessageOf：Error 取 message，其余 String()', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf(new TypeError('bad'))).toBe('bad');
    expect(errorMessageOf('plain')).toBe('plain');
    expect(errorMessageOf(42)).toBe('42');
    expect(errorMessageOf(null)).toBe('null');
    expect(errorMessageOf(undefined)).toBe('undefined');
    expect(errorMessageOf({ a: 1 })).toBe('[object Object]');
  });
});
