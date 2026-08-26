// sandbox.spec.ts — 随附测试：权限映射 三档映射 + env allowlist + fail closed + 真实 macOS seatbelt 集成。
//
// 覆盖：
//   - buildAcpAgentEnv：默认白名单继承（credential 形状键不泄漏）、自定义 inherit、
// 字面值透传/覆盖； $credential: 形状字面值原样透传（resolver 概念删除）
//   - buildAcpSpawnPlan 三档矩阵：read-only（stateRoot 即 root + XDG/TMPDIR 注入）、
//     workspace-write（项目即 root + tmpdir per-session 目录——默认 volatile mkdtemp；
// workspace-write 可经 sessionStateDir 传确定性目录）、danger-full-access
//     （不 confine + 首启强提示标记位）；配置错误（相对路径/根缺失/空 argv）
// - 确定性会话状态目录原语（create/ensure/remove）：固定名 sanitize、0700、
//     幂等复用、形态校验 fail loud（ensure）/ fail closed（remove）
// - stageAuthPathRefs（authPathRefs symlink 物化，零字节复制）：~ 展开、
//     三种 XDG 前缀映射、同目标幂等/异目标或字节副本落点替换、非 XDG 前缀与目录
// fail loud（消息不含路径）、源缺失 warn+跳过；：状态树目录逐层 0700；
// 收紧钉：声明 symlink 源（lstat 不跟随）fail loud、落点父链种链接越界
//     拒绝建链；
//     三档行为：confined 两档注入、danger 档零规则、未声明字段逐字节同前
//   - fail closed：无 sandbox 能力 / confine 抛错 → AcpClientError(sandbox-unavailable)
//   - acp-client seam：spawnPlan 应用（argv/env 生效）、与 wrapArgv 互斥
//   - 真实 seatbelt（经真 AcpClientConnection spawn mock-agent fs-probe scenario）：
//     workspace-write 档工作区内写成功/工作区外（$HOME 临时目标）写失败；
//     read-only 档写项目工作区被阻止/写 stateRoot 成功；confine 不可用不 spawn；
//     认证状态注入 集成：confined 进程经 XDG 落点 symlink 读到真实凭证、经 symlink 写
//     真实凭证被 seatbelt 拒、未声明 home 文件不入状态目录
//
// 真实沙箱能力取自 reference 构建产物（harness 方法）：built lib 的
// LocalSandboxProvider 挂到本包 devDep 的 cordis Context 上（cordis 生命周期符号
// Symbol.for 全局注册，跨模块实例有效， 已实证 instanceof/符号两条通路）。
// $HOME 下建测试目录是有意的：workspace-write 语义下 /tmp 与 os.tmpdir 整体可写，
// 只有 $HOME 下的目标才能证明 workspace root 授予本身（dsh seatbelt.e2e.ts 同款理由）。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type * as acp from '@agentclientprotocol/sdk';
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';
import {
  ACP_ENV_INHERIT_DEFAULT,
  nativeAgentEnvironmentKeys,
  AcpSpawnPlanError,
  buildAcpAgentEnv,
  buildAcpSpawnPlan,
  createDeterministicSessionStateDir,
  ensureDeterministicSessionStateDir,
  removeDeterministicSessionStateDir,
  stageAuthPathRefs,
  type AcpConfinedArgv,
  type AcpSandboxPolicyLike,
  type AcpSandboxProviderLike,
  type AcpSpawnPlan,
} from '../../../src/domain/policy/sandbox.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs');
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const SANDBOX_LOCAL_LIB = path.join(REPO_ROOT, 'reference', 'deepseek-harness', 'packages', 'sandbox', 'sandbox-local', 'lib', 'index.js');
const SPEC_TAG = `--dsh-acp-sandbox-spec-${process.pid}`;

/** dsh seatbelt 只读 profile（探针用；与 sandbox-local profiles.ts 逐字节同形）。 */
const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))';
const seatbeltProbe = spawnSync('sandbox-exec', ['-p', SEATBELT_RO_PROFILE, '--', 'true'], { timeout: 5_000, stdio: 'ignore' });
const seatbeltUsable = process.platform === 'darwin' && seatbeltProbe.status === 0 && fs.existsSync(SANDBOX_LOCAL_LIB);

// ---------- 通用工具 ----------

const tmpDirs: string[] = [];
function tmpDir(prefix: string, base: string = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(base, prefix));
  tmpDirs.push(dir);
  return dir;
}
const canonical = (dir: string): string => fs.realpathSync.native(dir);

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 本文件全部 spawn 走共享的真实 subprocess-local 服务（模块级单例，文件级一次性 dispose）
let subprocess: SubprocessSeam;
beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam;
});

/** confine 行为可控的假 provider：记录调用；可配置为抛 SANDBOX_UNAVAILABLE 形错误。 */
class FakeSandbox implements AcpSandboxProviderLike {
  readonly calls: Array<{ argv: readonly string[]; policy: AcpSandboxPolicyLike }> = [];
  constructor(private readonly failure?: { message: string; code: string }) {}
  confine(argv: readonly string[], policy: AcpSandboxPolicyLike): AcpConfinedArgv {
    this.calls.push({ argv: [...argv], policy });
    if (this.failure !== undefined) {
      throw Object.assign(new Error(this.failure.message), { name: 'SandboxUnavailableError', code: this.failure.code });
    }
    return {
      argv: ['sandbox-exec', '-p', 'FAKE-PROFILE', '--', ...argv],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    };
  }
}

const BASE_ARGV = ['devin', 'acp'] as const;
const BASE_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/test' };

// ---------- buildAcpAgentEnv ----------

describe('buildAcpAgentEnv（env allowlist）', () => {
  it('默认白名单：仅白名单键继承；credential 形状键与随机键一律不泄漏', async () => {
    const env = await buildAcpAgentEnv({
      source: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
        LANG: 'en_US.UTF-8',
        DEEPSEEK_API_KEY: 'sk-host-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-host-secret',
        GITHUB_TOKEN: 'ghp_host_secret',
        RANDOM_HOST_FACT: 'host-only',
      },
    });
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/test', LANG: 'en_US.UTF-8' });
    expect(Object.keys(env)).not.toContain('DEEPSEEK_API_KEY');
    expect(Object.values(env)).not.toContain('sk-host-secret');
    expect(Object.values(env)).not.toContain('host-only');
  });

  it('默认白名单内容固定（原 agent.ts MINIMAL_ENV_KEYS 清单， 起由本模块统一供给）', () => {
    expect(ACP_ENV_INHERIT_DEFAULT).toEqual([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'TMPDIR', 'TEMP', 'TMP', 'TERM', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'USERPROFILE',
    ]);
  });

  it('native 环境键：保留显式 data-home 与所有显式 XDG_*，不读取其值以外的宿主键', async () => {
    const source = {
      CODEX_HOME: '/home/user/.codex',
      KIMI_CODE_HOME: '/home/user/.kimi-code',
      XDG_DATA_HOME: '/home/user/.local/share',
      XDG_STATE_HOME: '/home/user/.local/state',
      XDG_CURRENT_DESKTOP: 'test-desktop',
      RANDOM_HOST_FACT: 'must-not-pass',
    };
    const env = await buildAcpAgentEnv({ inherit: [...new Set([...ACP_ENV_INHERIT_DEFAULT, ...nativeAgentEnvironmentKeys(source)])], source: { ...source, PATH: '/usr/bin', HOME: '/home/user' } });
    expect(env).toMatchObject({
      CODEX_HOME: source.CODEX_HOME,
      KIMI_CODE_HOME: source.KIMI_CODE_HOME,
      XDG_DATA_HOME: source.XDG_DATA_HOME,
      XDG_STATE_HOME: source.XDG_STATE_HOME,
    });
    expect(env.RANDOM_HOST_FACT).toBeUndefined();
    expect(env.XDG_CURRENT_DESKTOP).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(nativeAgentEnvironmentKeys({}).sort()).toEqual([...['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME']].sort());
  });

  it('自定义 inherit 覆盖默认集（部署相关键须显式放行）', async () => {
    const env = await buildAcpAgentEnv({
      inherit: ['PATH', 'HTTPS_PROXY'],
      source: { PATH: '/bin', HOME: '/should/not/pass', HTTPS_PROXY: 'http://proxy:3128' },
    });
    expect(env).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:3128' });
  });

  it('entries 字面值透传，且显式层覆盖继承键', async () => {
    const env = await buildAcpAgentEnv({
      source: { PATH: '/host/path', HOME: '/home/test' },
      entries: { PATH: '/explicit/path', MOCK_SCENARIO: 'fs-probe' },
    });
    expect(env['PATH']).toBe('/explicit/path');
    expect(env['MOCK_SCENARIO']).toBe('fs-probe');
    expect(env['HOME']).toBe('/home/test');
  });

 it('：$credential: 形状的字面值不再展开，原样透传（无 resolver 概念）', async () => {
    const env = await buildAcpAgentEnv({
      source: { SOME_API_KEY: 'ambient-secret-must-not-leak' },
      entries: { CHILD_API_KEY: '$credential:SOME_API_KEY' },
    });
    expect(env).toEqual({ CHILD_API_KEY: '$credential:SOME_API_KEY' });
    expect(env['SOME_API_KEY']).toBeUndefined();
  });
});

// ---------- buildAcpSpawnPlan 三档映射 ----------

describe('buildAcpSpawnPlan（权限映射 三档映射）', () => {
  it('read-only 档：confine 以 canonical stateRoot 为 workspaceRoot，XDG/TMPDIR 指入 stateRoot', () => {
    const sandbox = new FakeSandbox();
    const stateRoot = path.join(tmpDir('dsh-acp-sbx-ro-'), 'state'); // 尚不存在：计划负责创建
    const project = tmpDir('dsh-acp-sbx-proj-');
    const env: Record<string, string> = { ...BASE_ENV };
    const plan = buildAcpSpawnPlan({
      mode: 'read-only',
      workspaceRoot: project,
      stateRoot,
      argv: BASE_ARGV,
      env,
      sessionId: 'session-1',
      sandbox,
    });
    const canonicalState = canonical(stateRoot);
    expect(sandbox.calls).toEqual([
      { argv: BASE_ARGV, policy: { mode: 'workspace-write', workspaceRoot: canonicalState, sessionId: 'session-1' } },
    ]);
    expect(plan.argv).toEqual(['sandbox-exec', '-p', 'FAKE-PROFILE', '--', 'devin', 'acp']);
    expect(plan.mode).toBe('read-only');
    expect(plan.platformId).toBe(process.platform); // 平台事实随计划携带（审计透传）
    expect(plan.stateDir).toBe(canonicalState);
    expect(plan.confinedRoot).toBe(canonicalState);
    expect(plan.confined?.enforcement).toBe('full');
    // env 注入：XDG 三件套 + TMPDIR 落入 stateRoot，且目录实建
    expect(plan.env['XDG_DATA_HOME']).toBe(path.join(canonicalState, 'xdg-data'));
    expect(plan.env['XDG_CONFIG_HOME']).toBe(path.join(canonicalState, 'xdg-config'));
    expect(plan.env['XDG_CACHE_HOME']).toBe(path.join(canonicalState, 'xdg-cache'));
    expect(plan.env['TMPDIR']).toBe(path.join(canonicalState, 'tmp'));
    for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
      expect(fs.statSync(plan.env[key] ?? '').isDirectory()).toBe(true);
    }
    // 基础 env 保留；输入对象不被原地改
    expect(plan.env['PATH']).toBe(BASE_ENV['PATH']);
    expect(env).toEqual(BASE_ENV);
    expect(env['XDG_DATA_HOME']).toBeUndefined();
  });

  it('read-only 档：stateRoot 相对路径 → ACP_SPAWN_CONFIG', () => {
    expect(() =>
      buildAcpSpawnPlan({ mode: 'read-only', workspaceRoot: '/tmp', stateRoot: 'relative/state', argv: BASE_ARGV, env: {}, sandbox: new FakeSandbox() }),
    ).toThrow(AcpSpawnPlanError);
  });

  it('workspace-write 档：confine 以 canonical 项目为 root，状态入 os.tmpdir() 下 per-session 目录', () => {
    const sandbox = new FakeSandbox();
    const project = tmpDir('dsh-acp-sbx-ww-');
    const marker = path.join(project, 'pre-existing.txt');
    fs.writeFileSync(marker, 'untouched');
    const stateRoot = tmpDir('dsh-acp-sbx-profile-'); // 本档不消费
    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: project,
      stateRoot,
      argv: BASE_ARGV,
      env: { ...BASE_ENV, TMPDIR: '/host/tmpdir' },
      sandbox,
    });
    const canonicalProject = canonical(project);
    expect(sandbox.calls).toEqual([{ argv: BASE_ARGV, policy: { mode: 'workspace-write', workspaceRoot: canonicalProject } }]);
    // per-session 状态目录：os.tmpdir 下、已建、volatile（恢复连续性规则 降级路径在恢复侧，此处只管注入）
    const stateDir = plan.stateDir ?? '';
    expect(stateDir.startsWith(canonical(os.tmpdir()) + path.sep)).toBe(true);
    expect(fs.statSync(stateDir).isDirectory()).toBe(true);
    expect(plan.env['XDG_DATA_HOME']).toBe(path.join(stateDir, 'xdg-data'));
    expect(plan.env['TMPDIR']).toBe(path.join(stateDir, 'tmp'));
    expect(plan.env['TMPDIR']).not.toBe('/host/tmpdir'); // 注入覆盖继承值
    // 项目目录零改动（我们只读它做 canonicalize）
    expect(fs.readdirSync(project)).toEqual(['pre-existing.txt']);
    expect(plan.confinedRoot).toBe(canonical(project));
  });

  it('workspace-write 档：workspaceRoot 不存在 → ACP_SPAWN_CONFIG（授予落空即配置错误）', () => {
    const missing = path.join(tmpDir('dsh-acp-sbx-missing-'), 'no-such-dir');
    expect(() =>
      buildAcpSpawnPlan({ mode: 'workspace-write', workspaceRoot: missing, stateRoot: '/tmp', argv: BASE_ARGV, env: {}, sandbox: new FakeSandbox() }),
    ).toThrow(AcpSpawnPlanError);
    expect(() =>
      buildAcpSpawnPlan({ mode: 'workspace-write', workspaceRoot: missing, stateRoot: '/tmp', argv: BASE_ARGV, env: {}, sandbox: new FakeSandbox() }),
    ).toThrow(/does not exist/);
  });

 it('workspace-write 档 + sessionStateDir（边界）：用调用方给定的确定性目录（canonical 化），confine root 仍是项目', () => {
    const sandbox = new FakeSandbox();
    const project = tmpDir('dsh-acp-sbx-ww-det-');
    // 调用方选址产物（agent.ts resolveSessionStateDir 经 createDeterministicSessionStateDir）
    const given = createDeterministicSessionStateDir('devin-session-x-1');
    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: project,
      argv: BASE_ARGV,
      env: { ...BASE_ENV, TMPDIR: '/host/tmpdir' },
      sandbox,
      sessionStateDir: given,
    });
    expect(plan.stateDir).toBe(given); // 已是 canonical，逐字节复用
    expect(sandbox.calls).toEqual([{ argv: BASE_ARGV, policy: { mode: 'workspace-write', workspaceRoot: canonical(project) } }]);
    expect(plan.confinedRoot).toBe(canonical(project));
    // 状态目录 env 布局指入给定目录（与 mkdtemp 路径同款注入纪律）
    expect(plan.env['XDG_DATA_HOME']).toBe(path.join(given, 'xdg-data'));
    expect(plan.env['TMPDIR']).toBe(path.join(given, 'tmp'));
    expect(plan.env['TMPDIR']).not.toBe('/host/tmpdir');
    expect(fs.statSync(plan.env['XDG_DATA_HOME'] ?? '').isDirectory()).toBe(true);
    expect(fs.statSync(given).mode & 0o777).toBe(0o700);
    expect(removeDeterministicSessionStateDir(given)).toBe(true);
  });

  it('workspace-write 档 + sessionStateDir 相对路径 → ACP_SPAWN_CONFIG（fail loud，不静默 mkdtemp）', () => {
    expect(() =>
      buildAcpSpawnPlan({ mode: 'workspace-write', workspaceRoot: tmpDir('dsh-acp-sbx-ww-rel-'), argv: BASE_ARGV, env: {}, sandbox: new FakeSandbox(), sessionStateDir: 'relative/state' }),
    ).toThrow(AcpSpawnPlanError);
  });

  it('danger-full-access 档：不 confine、不注入、产出首启强提示标记位', () => {
    const sandbox = new FakeSandbox({ message: 'must not be consulted', code: 'SANDBOX_UNAVAILABLE' });
    const env = { ...BASE_ENV, TMPDIR: '/host/tmpdir' };
    const plan = buildAcpSpawnPlan({
      mode: 'danger-full-access',
      workspaceRoot: '/nonexistent-is-fine-here',
      stateRoot: '/also-unchecked',
      argv: BASE_ARGV,
      env,
      sandbox,
    });
    expect(sandbox.calls).toEqual([]); // 本档不咨询 sandbox 能力
    expect(plan.argv).toEqual([...BASE_ARGV]);
    expect(plan.env).toEqual(env); // 原样（含继承来的 TMPDIR）
    expect(plan.confined).toBeNull();
    expect(plan.confinedRoot).toBeNull();
    expect(plan.stateDir).toBeNull();
    expect(plan.platformId).toBe(process.platform); // danger 档同样携带平台事实（审计归属）
    // 计划是拷贝：改计划不回污输入
    plan.env['PATH'] = '/mutated';
    expect(env['PATH']).toBe(BASE_ENV['PATH']);
  });

  it('空 argv → ACP_SPAWN_CONFIG', () => {
    expect(() =>
      buildAcpSpawnPlan({ mode: 'danger-full-access', workspaceRoot: '/tmp', stateRoot: '/tmp', argv: [], env: {} }),
    ).toThrow(AcpSpawnPlanError);
  });
});

// ---------- 确定性会话状态目录原语 ----------

describe('确定性会话状态目录原语（create/ensure/remove）', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const canonicalTmp = canonical(os.tmpdir());

  it('create：tmp 下固定名 dsh-acp-state-<identity>（sanitize 非常规字符）、0700、canonical、幂等复用', () => {
    const dir = createDeterministicSessionStateDir('devin-session:odd/id-1');
    created.push(dir);
    // 非 [a-zA-Z0-9-] 字符 sanitize 为下划线；落点是 canonical tmp 的直系子目录
    expect(dir).toBe(path.join(canonicalTmp, 'dsh-acp-state-devin-session_odd_id-1'));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // 幂等：同 identity 再建得同一路径，既有内容保留（resume 复用语义）
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'gen-1');
    expect(createDeterministicSessionStateDir('devin-session:odd/id-1')).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8')).toBe('gen-1');
  });

  it('ensure：合法形态幂等建/复用；非本机制形态（外位置/无前缀）→ ACP_SPAWN_CONFIG fail loud', () => {
    const dir = path.join(canonicalTmp, 'dsh-acp-state-ensure-me-1');
    created.push(dir);
    expect(ensureDeterministicSessionStateDir(dir)).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // 前缀对、位置不对（嵌套在别处）→ 拒绝
    expect(() => ensureDeterministicSessionStateDir(path.join(tmpDir('dsh-acp-sbx-foreign-'), 'dsh-acp-state-x-1'))).toThrow(AcpSpawnPlanError);
    // 位置对、前缀不对 → 拒绝（普通 mkdtemp 目录不得被本机制认领）
    expect(() => ensureDeterministicSessionStateDir(tmpDir('dsh-acp-sbx-noprefix-'))).toThrow(AcpSpawnPlanError);
  });

  it('remove：本机制目录整删（true）；形态不符返回 false 且零 fs 副作用', () => {
    const dir = createDeterministicSessionStateDir('devin-session-y-1');
    expect(removeDeterministicSessionStateDir(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // 不存在 = 幂等 true（force）；形态不符 = false 且目录原样保留
    expect(removeDeterministicSessionStateDir(dir)).toBe(true);
    const foreign = tmpDir('dsh-acp-sbx-keep-');
    expect(removeDeterministicSessionStateDir(foreign)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});

// ---------- stageAuthPathRefs（authPathRefs symlink 物化，零字节复制） ----------

describe('stageAuthPathRefs（authPathRefs symlink 物化）', () => {
  /** 假 home：三个 XDG 前缀下各一份文件 + 一个前缀外文件（后者绝不进状态目录）。 */
  function fakeHome(): string {
    const home = tmpDir('dsh-acp-sbx-home-');
    fs.mkdirSync(path.join(home, '.local', 'share', 'devin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'share', 'devin', 'credentials.toml'), 'token = "data"');
    fs.mkdirSync(path.join(home, '.config', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'foo', 'config.json'), '{"a":1}');
    fs.mkdirSync(path.join(home, '.cache', 'bar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache', 'bar', 'blob.bin'), 'cache-bytes');
    fs.writeFileSync(path.join(home, 'outside.txt'), 'not-xdg');
    return home;
  }

  const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

  it('~ 展开 + 三种 XDG 前缀映射到 xdg-data/xdg-config/xdg-cache：落点是直指真文件的 symlink（零字节复制）', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    stageAuthPathRefs({
      paths: ['~/.local/share/devin/credentials.toml', '~/.config/foo/config.json', '~/.cache/bar/blob.bin'],
      stateDir,
      homeDir: home,
    });
    const cases: Array<[string, string]> = [
      [path.join(stateDir, 'xdg-data', 'devin', 'credentials.toml'), path.join(home, '.local', 'share', 'devin', 'credentials.toml')],
      [path.join(stateDir, 'xdg-config', 'foo', 'config.json'), path.join(home, '.config', 'foo', 'config.json')],
      [path.join(stateDir, 'xdg-cache', 'bar', 'blob.bin'), path.join(home, '.cache', 'bar', 'blob.bin')],
    ];
    for (const [link, source] of cases) {
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(source);
      // 经链接读到真实字节（同一文件，无副本）
      expect(fs.readFileSync(link, 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
    }
    // 前缀外的 home 文件不进状态目录
    expect(fs.existsSync(path.join(stateDir, 'outside.txt'))).toBe(false);
  });

 it('：stateDir 与落点父链目录逐层收紧到 0700（recursive mkdir 中间层吃 umask 的兜底）', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    stageAuthPathRefs({ paths: ['~/.local/share/devin/credentials.toml'], stateDir, homeDir: home });
    // POSIX mode 位断言；不代表 Windows 真机语义。
    expect(modeOf(stateDir)).toBe(0o700);
    expect(modeOf(path.join(stateDir, 'xdg-data'))).toBe(0o700);
    expect(modeOf(path.join(stateDir, 'xdg-data', 'devin'))).toBe(0o700);
  });

  it('绝对路径（无 ~ 前缀）落在 XDG 等价前缀下同样建链', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    stageAuthPathRefs({ paths: [path.join(home, '.config', 'foo', 'config.json')], stateDir, homeDir: home });
    const link = path.join(stateDir, 'xdg-config', 'foo', 'config.json');
    expect(fs.readlinkSync(link)).toBe(path.join(home, '.config', 'foo', 'config.json'));
  });

  it('重复物化幂等：同目标 symlink 原样保留（token 轮换经链接即时可见，无需刷新）', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    const declared = ['~/.local/share/devin/credentials.toml'];
    stageAuthPathRefs({ paths: declared, stateDir, homeDir: home });
    const link = path.join(stateDir, 'xdg-data', 'devin', 'credentials.toml');
    const ino = fs.lstatSync(link).ino;
    stageAuthPathRefs({ paths: declared, stateDir, homeDir: home });
    expect(fs.lstatSync(link).ino).toBe(ino); // 幂等：未重建
    // symlink 语义：源文件轮换后，经链接读到新值（旧字节复制实现需重新物化）
    fs.writeFileSync(path.join(home, '.local', 'share', 'devin', 'credentials.toml'), 'token = "rotated"');
    expect(fs.readFileSync(link, 'utf8')).toBe('token = "rotated"');
  });

 it('旧字节副本/异目标 symlink 落点被替换为指向真文件的 symlink（迁移语义）', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    const link = path.join(stateDir, 'xdg-data', 'devin', 'credentials.toml');
    const source = path.join(home, '.local', 'share', 'devin', 'credentials.toml');
    const declared = ['~/.local/share/devin/credentials.toml'];
 // 遗留 字节副本
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(link, 'stale-copy');
    stageAuthPathRefs({ paths: declared, stateDir, homeDir: home });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(source);
    // 异目标 symlink（指向状态目录外哨兵）：先解除再重建，哨兵不被写穿
    const sentinel = path.join(tmpDir('dsh-acp-sbx-sentinel-'), 'sentinel.txt');
    fs.writeFileSync(sentinel, 'do-not-overwrite');
    fs.rmSync(link);
    fs.symlinkSync(sentinel, link);
    stageAuthPathRefs({ paths: declared, stateDir, homeDir: home });
    expect(fs.readlinkSync(link)).toBe(source);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-overwrite');
  });

  it('非 XDG 前缀/相对路径/~ 本身 → ACP_SPAWN_CONFIG fail loud，消息只带条目序号不带路径', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    for (const declared of ['~/outside.txt', '~/.local/state/x', '~/.ssh/id_rsa', '/etc/passwd', 'relative/path', '~', '~user/x']) {
      expect(() => stageAuthPathRefs({ paths: [declared], stateDir, homeDir: home }), declared).toThrow(AcpSpawnPlanError);
      expect(() => stageAuthPathRefs({ paths: [declared], stateDir, homeDir: home }), declared).toThrow(/XDG home equivalents/);
    }
    // 纪律钉死：凭证路径永不进错误/日志（消息不含声明路径与 home 任何片段）
    try {
      stageAuthPathRefs({ paths: ['~/.ssh/id_rsa'], stateDir, homeDir: home });
      expect.unreachable();
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain('authPathRefs entry #1');
      expect(message).not.toContain('.ssh');
      expect(message).not.toContain(home);
    }
  });

  it('目录（含 XDG 前缀目录本身）→ ACP_SPAWN_CONFIG fail loud（v1 只链接单文件）', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    for (const declared of ['~/.local/share/devin', '~/.config']) {
      expect(() => stageAuthPathRefs({ paths: [declared], stateDir, homeDir: home }), declared).toThrow(AcpSpawnPlanError);
      expect(() => stageAuthPathRefs({ paths: [declared], stateDir, homeDir: home }), declared).toThrow(/regular file/);
    }
  });

 it(' 收紧：声明 symlink 源（lstat 判定，不跟随）→ ACP_SPAWN_CONFIG fail loud，消息不含路径', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    // 声明条目本体是 symlink（指向同前缀下的真实文件）：拒绝二跳间接，口径=声明必须直指真文件
    fs.symlinkSync(path.join(home, '.config', 'foo', 'config.json'), path.join(home, '.config', 'foo', 'link.json'));
    let thrown: unknown;
    try {
      stageAuthPathRefs({ paths: ['~/.config/foo/link.json'], stateDir, homeDir: home });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpSpawnPlanError);
    const message = (thrown as Error).message;
    expect(message).toContain('authPathRefs entry #1');
    expect(message).toMatch(/symlink\/junction/);
    // 纪律钉死：凭证路径永不进错误消息
    expect(message).not.toContain('link.json');
    expect(message).not.toContain(home);
    expect(fs.existsSync(path.join(stateDir, 'xdg-config', 'foo', 'link.json'))).toBe(false);
  });

 it(' 收紧：落点父链被种入指向真实 home 的 symlink → 拒绝建链（状态树逃逸防线），真实文件不动', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    // confined agent 可写状态目录：把落点子树换成指向真实 home 的链接
    fs.symlinkSync(path.join(home, '.local', 'share'), path.join(stateDir, 'xdg-data'));
    const realCredential = path.join(home, '.local', 'share', 'devin', 'credentials.toml');
    const before = fs.readFileSync(realCredential, 'utf8');
    let thrown: unknown;
    try {
      stageAuthPathRefs({ paths: ['~/.local/share/devin/credentials.toml'], stateDir, homeDir: home });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpSpawnPlanError);
    const message = (thrown as Error).message;
    expect(message).toContain('authPathRefs entry #1');
    expect(message).toMatch(/escapes the session state directory/);
    expect(message).not.toContain(home);
    // 拒绝发生在任何写入之前：真实 home 凭证字节不动
    expect(fs.readFileSync(realCredential, 'utf8')).toBe(before);
  });

  it('源缺失 → warn 后跳过该条（spawn 继续），其余条目照常建链；warn 不含路径', () => {
    const home = fakeHome();
    const stateDir = tmpDir('dsh-acp-sbx-state-');
    const warns: string[] = [];
    stageAuthPathRefs({
      paths: ['~/.local/share/devin/absent.toml', '~/.config/foo/config.json'],
      stateDir,
      homeDir: home,
      onWarn: (message) => warns.push(message),
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('authPathRefs entry #1');
    expect(warns[0]).toContain('does not exist');
    // 纪律钉死：warn 不含声明路径、home、文件名
    expect(warns[0]).not.toContain('absent.toml');
    expect(warns[0]).not.toContain(home);
    expect(fs.existsSync(path.join(stateDir, 'xdg-data', 'devin', 'absent.toml'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'xdg-config', 'foo', 'config.json'))).toBe(true);
  });
});

// ---------- buildAcpSpawnPlan 的 authPathRefs 消费（三档行为） ----------

describe('buildAcpSpawnPlan authPathRefs（三档行为）', () => {
  const CRED = '~/.local/share/devin/credentials.toml';

  function homeWithCredential(): string {
    const home = tmpDir('dsh-acp-sbx-home-');
    fs.mkdirSync(path.join(home, '.local', 'share', 'devin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'share', 'devin', 'credentials.toml'), 'token = "plan"');
    return home;
  }

  it('read-only 档：symlink 落持久 stateRoot 的 xdg-data 位（直指真文件，无副本无 0600）', () => {
    const home = homeWithCredential();
    const plan = buildAcpSpawnPlan({
      mode: 'read-only',
      workspaceRoot: tmpDir('dsh-acp-sbx-proj-'),
      stateRoot: path.join(tmpDir('dsh-acp-sbx-ro-'), 'state'),
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
      authPathRefs: [CRED],
      homeDir: home,
    });
    const linked = path.join(plan.stateDir ?? '', 'xdg-data', 'devin', 'credentials.toml');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linked)).toBe(path.join(home, '.local', 'share', 'devin', 'credentials.toml'));
    expect(fs.readFileSync(linked, 'utf8')).toBe('token = "plan"');
 // 持久 stateRoot 的状态目录本身收紧到 0700
    expect(fs.statSync(plan.stateDir ?? '').mode & 0o777).toBe(0o700);
  });

  it('workspace-write 档：symlink 落 per-session stateDir（mkdtemp 随机目录 spawn 前注入——认证状态注入 的修复点）', () => {
    const home = homeWithCredential();
    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: tmpDir('dsh-acp-sbx-ww-'),
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
      authPathRefs: [CRED],
      homeDir: home,
    });
    const stateDir = plan.stateDir ?? '';
    expect(stateDir.startsWith(canonical(os.tmpdir()) + path.sep)).toBe(true);
    const linked = path.join(stateDir, 'xdg-data', 'devin', 'credentials.toml');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toBe('token = "plan"');
 // per-session 状态树逐层 0700（mkdtemp 根 + env 布局目录 + 落点父链）
    for (const sub of ['', 'xdg-data', path.join('xdg-data', 'devin'), 'xdg-config', 'xdg-cache', 'tmp']) {
      expect(fs.statSync(path.join(stateDir, sub)).mode & 0o777, sub).toBe(0o700);
    }
  });

 it('workspace-write 档 + sessionStateDir（边界）：symlink 落调用方给定的确定性目录，逐层 0700', () => {
    const home = homeWithCredential();
    const given = createDeterministicSessionStateDir('devin-session-auth-1');
    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: tmpDir('dsh-acp-sbx-ww-'),
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
      authPathRefs: [CRED],
      homeDir: home,
      sessionStateDir: given,
    });
    expect(plan.stateDir).toBe(given);
    const linked = path.join(given, 'xdg-data', 'devin', 'credentials.toml');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toBe('token = "plan"');
    for (const sub of ['', 'xdg-data', path.join('xdg-data', 'devin'), 'xdg-config', 'xdg-cache', 'tmp']) {
      expect(fs.statSync(path.join(given, sub)).mode & 0o777, sub).toBe(0o700);
    }
    expect(removeDeterministicSessionStateDir(given)).toBe(true);
  });

  it('danger-full-access 档：零规则——不建链不 warn，计划与不携带该字段逐字节一致', () => {
    const home = homeWithCredential();
    const warns: string[] = [];
    const base = {
      mode: 'danger-full-access',
      workspaceRoot: '/nonexistent-is-fine-here',
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
    } as const;
    const without = buildAcpSpawnPlan(base);
    const withPaths = buildAcpSpawnPlan({
      ...base,
      authPathRefs: [CRED],
      homeDir: home,
      onWarn: (message) => warns.push(message),
    });
    expect(withPaths).toEqual(without);
    expect(withPaths.stateDir).toBeNull();
    expect(withPaths.confined).toBeNull();
    expect(warns).toEqual([]);
  });

  it('未声明字段 = 与现状逐字节一致：空数组与缺席同形，计划键集不变', () => {
    const base = {
      mode: 'read-only',
      workspaceRoot: tmpDir('dsh-acp-sbx-proj-'),
      stateRoot: path.join(tmpDir('dsh-acp-sbx-ro-'), 'state'),
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
    } as const;
    const baseline = buildAcpSpawnPlan(base);
    const emptyList = buildAcpSpawnPlan({ ...base, authPathRefs: [] });
    expect(emptyList).toEqual(baseline);
 // 计划新增 platformId 事实键（permission-scope 审计透传用），其余键集不变
    expect(Object.keys(baseline)).toEqual(['argv', 'env', 'mode', 'confined', 'confinedRoot', 'stateDir', 'platformId']);
  });

  it('配置错误经计划路径 fail loud（目录条目）；源缺失经 onWarn 跳过、计划照常产出', () => {
    const home = homeWithCredential();
    expect(() =>
      buildAcpSpawnPlan({
        mode: 'read-only',
        workspaceRoot: tmpDir('dsh-acp-sbx-proj-'),
        stateRoot: path.join(tmpDir('dsh-acp-sbx-ro2-'), 'state'),
        argv: BASE_ARGV,
        env: { ...BASE_ENV },
        sandbox: new FakeSandbox(),
        authPathRefs: ['~/.local/share/devin'], // 目录 → fail loud
        homeDir: home,
      }),
    ).toThrow(AcpSpawnPlanError);
    const warns: string[] = [];
    const plan = buildAcpSpawnPlan({
      mode: 'read-only',
      workspaceRoot: tmpDir('dsh-acp-sbx-proj-'),
      stateRoot: path.join(tmpDir('dsh-acp-sbx-ro3-'), 'state'),
      argv: BASE_ARGV,
      env: { ...BASE_ENV },
      sandbox: new FakeSandbox(),
      authPathRefs: ['~/.local/share/devin/absent.toml'], // 缺失 → warn + 跳过
      homeDir: home,
      onWarn: (message) => warns.push(message),
    });
    expect(warns).toHaveLength(1);
    expect(plan.argv[0]).toBe('sandbox-exec'); // spawn 继续（FakeSandbox 包装形态）
    expect(fs.existsSync(path.join(plan.stateDir ?? '', 'xdg-data', 'devin', 'absent.toml'))).toBe(false);
  });
});

// ---------- fail closed ----------

describe('fail closed（SANDBOX_UNAVAILABLE 语义，不静默放行）', () => {
  it('read-only 档无 sandbox 能力 → AcpClientError(sandbox-unavailable)', () => {
    let thrown: unknown;
    try {
      buildAcpSpawnPlan({ mode: 'read-only', workspaceRoot: '/tmp', stateRoot: tmpDir('dsh-acp-sbx-fc-'), argv: BASE_ARGV, env: {} });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    expect((thrown as AcpClientError).kind).toBe('sandbox-unavailable');
    expect((thrown as AcpClientError).message).toMatch(/refusing to spawn the ACP agent unconfined/);
  });

  it('workspace-write 档无 sandbox 能力 → AcpClientError(sandbox-unavailable)', () => {
    expect(() =>
      buildAcpSpawnPlan({ mode: 'workspace-write', workspaceRoot: os.tmpdir(), stateRoot: '/tmp', argv: BASE_ARGV, env: {} }),
    ).toThrow(AcpClientError);
    expect(() =>
      buildAcpSpawnPlan({ mode: 'workspace-write', workspaceRoot: os.tmpdir(), stateRoot: '/tmp', argv: BASE_ARGV, env: {} }),
    ).toThrow(/no sandbox capability/);
  });

  it('confine 抛错（provider fail closed）→ 包装为 sandbox-unavailable 且保留 cause', () => {
    const sandbox = new FakeSandbox({ message: 'no sandbox backend is usable on this host', code: 'SANDBOX_UNAVAILABLE' });
    let thrown: unknown;
    try {
      buildAcpSpawnPlan({ mode: 'read-only', workspaceRoot: '/tmp', stateRoot: tmpDir('dsh-acp-sbx-fc2-'), argv: BASE_ARGV, env: {}, sandbox });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    expect((thrown as AcpClientError).kind).toBe('sandbox-unavailable');
    expect((thrown as AcpClientError).message).toContain('no sandbox backend is usable on this host');
    expect(((thrown as AcpClientError).cause as { code?: string } | undefined)?.code).toBe('SANDBOX_UNAVAILABLE');
  });
});

// ---------- acp-client seam（无真实沙箱） ----------

describe('AcpClientConnection spawnPlan seam', () => {
  const liveConns = new Set<AcpClientConnection>();
  afterEach(async () => {
    for (const conn of [...liveConns]) {
      await conn.close().catch(() => {});
      liveConns.delete(conn);
    }
  });

  it('spawnPlan 与 wrapArgv 互斥：同给 → 构造即抛 spawn-failure（不 spawn）', () => {
    expect(
      () =>
        new AcpClientConnection({
          argv: [process.execPath, MOCK_AGENT_PATH],
          cwd: os.tmpdir(),
          env: {},
          subprocess,
          wrapArgv: (argv) => argv,
          spawnPlan: { argv: [process.execPath, MOCK_AGENT_PATH], env: {} },
        }),
    ).toThrow(AcpClientError);
    expect(
      () =>
        new AcpClientConnection({
          argv: [process.execPath, MOCK_AGENT_PATH],
          cwd: os.tmpdir(),
          env: {},
          subprocess,
          wrapArgv: (argv) => argv,
          spawnPlan: { argv: [process.execPath, MOCK_AGENT_PATH], env: {} },
        }),
    ).toThrow(/mutually exclusive/);
  });

  it('spawnPlan 的 argv/env 是 spawn 事实：plan.env 整体替换 spec.env', async () => {
    // plan.env 给 minimal-caps，spec.env 给 happy：握手回最小能力即证明 plan.env 生效
    const conn = new AcpClientConnection(
      {
        argv: [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-seam`],
        cwd: os.tmpdir(),
        env: { MOCK_SCENARIO: 'happy' },
        subprocess,
        spawnPlan: {
          argv: [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-seam`],
          env: { MOCK_SCENARIO: 'minimal-caps', PATH: process.env['PATH'] ?? '' },
        },
      },
      { eofGraceMs: 150, termGraceMs: 500 },
    );
    liveConns.add(conn);
    const init = await conn.initialize();
    expect(init.agentCapabilities?.loadSession).toBe(false); // minimal-caps 特征
    await conn.close();
    liveConns.delete(conn);
  });
});

// ---------- 真实 macOS seatbelt 集成（harness 方法） ----------

interface FsProbeResult {
  path: string;
  ok: boolean;
  exitCode: number | null;
  stderr: string;
}

interface FsProbeFrame {
  results: FsProbeResult[];
  envEcho: { XDG_DATA_HOME: string | null; XDG_CONFIG_HOME: string | null; XDG_CACHE_HOME: string | null; TMPDIR: string | null };
}

/** 从 prompt 的 update 流里提取 fs-probe 结果帧（结果 + 子进程 env 回显）。 */
function extractFsProbeFrame(notifications: acp.SessionNotification[]): FsProbeFrame {
  for (const notification of notifications) {
    if (notification.update.sessionUpdate !== 'agent_message_chunk') continue;
    const content = notification.update.content;
    if (content.type !== 'text') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.text);
    } catch {
      continue; // 非 fs-probe 文本帧
    }
    const frame = parsed as { fsProbeResults?: unknown; envEcho?: FsProbeFrame['envEcho'] };
    if (Array.isArray(frame.fsProbeResults) && frame.envEcho !== undefined) {
      return { results: frame.fsProbeResults as FsProbeResult[], envEcho: frame.envEcho };
    }
  }
  throw new Error('fs-probe result frame not found in prompt updates');
}

describe.skipIf(!seatbeltUsable)('真实 macOS seatbelt 集成（经真 AcpClientConnection + fs-probe mock agent）', () => {
  let ctx: Context | undefined;
  let sandbox: AcpSandboxProviderLike;
  const liveConns = new Set<AcpClientConnection>();
  const spawnedPids = new Set<number>();

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(SANDBOX_LOCAL_LIB).href)) as { LocalSandboxProvider: unknown };
    ctx = new Context();
 // 跨 cordis 副本挂类插件：生命周期符号 Symbol.for 全局注册（实证）；
    // cordis 的 plugin 泛型签名对本包不可见的类插件不可表达，经 unknown 窄化
    const plugin = ctx.plugin as unknown as (plugin: unknown, config: unknown) => PromiseLike<unknown>;
    await plugin(mod.LocalSandboxProvider, {
      runnerCommand: [],
      runnerFailureSignatures: [],
      probeTimeoutMs: 5_000,
    });
    sandbox = (ctx as unknown as { sandbox: AcpSandboxProviderLike }).sandbox;
  });

  afterEach(async () => {
    for (const conn of [...liveConns]) {
      await conn.close().catch(() => {});
      liveConns.delete(conn);
    }
  });

  afterAll(async () => {
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect([...spawnedPids].filter(isAlive)).toEqual([]);
    const ps = execFileSync('ps', ['-axo', 'pid,args'], { encoding: 'utf8' });
    expect(ps.split('\n').filter((line) => line.includes(SPEC_TAG))).toEqual([]);
    if (ctx !== undefined) await ctx.fiber.dispose();
  });

  /** 已有计划 → 真连接 → initialize/session/new/prompt(fs-probe) → 关梯子；返回探针帧。 */
  async function runFsProbeWithPlan(plan: AcpSpawnPlan, workspaceRoot: string): Promise<FsProbeFrame> {
    const conn = new AcpClientConnection(
      // spec.argv/env 是计划前基线；spawn 事实由 spawnPlan 接管（seam 语义）
      { argv: [process.execPath, MOCK_AGENT_PATH, SPEC_TAG], cwd: workspaceRoot, env: {}, subprocess, spawnPlan: plan },
      { eofGraceMs: 150, termGraceMs: 500 },
    );
    liveConns.add(conn);
    if (conn.pid !== undefined) spawnedPids.add(conn.pid);
    try {
      await conn.initialize();
      const session = await conn.newSession({ cwd: workspaceRoot });
      const updates: acp.SessionNotification[] = [];
      const response = await conn.prompt(
        session.sessionId,
        [{ type: 'text', text: 'probe the filesystem' }],
        (notification) => updates.push(notification),
      );
      expect(response.stopReason).toBe('end_turn');
      return extractFsProbeFrame(updates);
    } finally {
      await conn.close();
      liveConns.delete(conn);
    }
  }

  /** 组装 fs-probe 连接计划：env 走真 buildAcpAgentEnv，计划走真 buildAcpSpawnPlan。 */
  async function fsProbePlan(options: {
    mode: 'read-only' | 'workspace-write';
    workspaceRoot: string;
    stateRoot: string;
    targets: string[];
  }): Promise<AcpSpawnPlan> {
    const env = await buildAcpAgentEnv({
      entries: { MOCK_SCENARIO: 'fs-probe', MOCK_FS_PROBE_WRITES: JSON.stringify(options.targets) },
    });
    return buildAcpSpawnPlan({
      mode: options.mode,
      workspaceRoot: options.workspaceRoot,
      stateRoot: options.stateRoot,
      argv: [process.execPath, MOCK_AGENT_PATH, SPEC_TAG],
      env,
      sandbox,
    });
  }

  /** 拒绝凭证：写失败 + 文件不在 + stderr 命中本 backend 的 denialSignatures 方言。 */
  function expectDenied(result: FsProbeResult | undefined, target: string, plan: AcpSpawnPlan): void {
    expect(result, `fs-probe result for ${target}`).toBeDefined();
    expect(result?.ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    const signatures = plan.confined?.denialSignatures ?? [];
    expect(signatures.length).toBeGreaterThan(0);
    expect(
      signatures.some((signature) => (result?.stderr ?? '').toLowerCase().includes(signature.toLowerCase())),
      `stderr ${JSON.stringify(result?.stderr)} must hit the backend denial dialect ${JSON.stringify(signatures)}`,
    ).toBe(true);
  }

  function expectAllowed(result: FsProbeResult | undefined, target: string): void {
    expect(result, `fs-probe result for ${target}`).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('dsh-acp-fs-probe');
  }

  it('workspace-write 档：工作区内写成功、工作区外（$HOME 目标）写失败、env 注入到达子进程', async () => {
    // workspace 与 outside 都放在 $HOME 下：/tmp 与 os.tmpdir 在 workspace-write 语义下
    // 整体可写，只有 $HOME 目标能证明 root 授予本身（dsh seatbelt.e2e.ts 同款布局）
    const workspace = tmpDir('dsh-acp-sbx-ws-', os.homedir());
    const outside = tmpDir('dsh-acp-sbx-out-', os.homedir());
    const stateRoot = tmpDir('dsh-acp-sbx-profile-', os.homedir());
    const insideTarget = path.join(workspace, 'inside.txt');
    const outsideTarget = path.join(outside, 'denied.txt');

    const plan = await fsProbePlan({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      stateRoot,
      targets: [insideTarget, outsideTarget],
    });
    expect(plan.confined?.enforcement).toBe('full');
    expect(plan.argv[0]).toBe('sandbox-exec');

    const frame = await runFsProbeWithPlan(plan, workspace);
    expectAllowed(frame.results.find((r) => r.path === insideTarget), insideTarget);
    expectDenied(frame.results.find((r) => r.path === outsideTarget), outsideTarget, plan);
    // envEcho：XDG/TMPDIR 注入经 spawnPlan seam 真到达受限子进程，指入 per-session stateDir
    const stateDir = plan.stateDir ?? '';
    expect(stateDir.startsWith(canonical(os.tmpdir()) + path.sep)).toBe(true);
    expect(frame.envEcho.XDG_DATA_HOME).toBe(path.join(stateDir, 'xdg-data'));
    expect(frame.envEcho.XDG_CONFIG_HOME).toBe(path.join(stateDir, 'xdg-config'));
    expect(frame.envEcho.XDG_CACHE_HOME).toBe(path.join(stateDir, 'xdg-cache'));
    expect(frame.envEcho.TMPDIR).toBe(path.join(stateDir, 'tmp'));
  });

  it('read-only 档：写项目工作区被阻止、写 stateRoot 成功（沙箱写边界）', async () => {
    const workspace = tmpDir('dsh-acp-sbx-ro-ws-', os.homedir());
    const stateRoot = tmpDir('dsh-acp-sbx-ro-state-', os.homedir());
    const workspaceTarget = path.join(workspace, 'denied.txt');
    const stateTarget = path.join(canonical(stateRoot), 'state.txt');

    const plan = await fsProbePlan({
      mode: 'read-only',
      workspaceRoot: workspace,
      stateRoot,
      targets: [workspaceTarget, stateTarget],
    });
    expect(plan.confined?.enforcement).toBe('full');
    expect(plan.argv[0]).toBe('sandbox-exec');
    const frame = await runFsProbeWithPlan(plan, workspace);
    expectDenied(frame.results.find((r) => r.path === workspaceTarget), workspaceTarget, plan);
    expectAllowed(frame.results.find((r) => r.path === stateTarget), stateTarget);
    expect(plan.stateDir).toBe(canonical(stateRoot));
    // envEcho：XDG/TMPDIR 指入持久 stateRoot（项目实质只读、状态可续接的 权限映射 形态）
    expect(frame.envEcho.XDG_DATA_HOME).toBe(path.join(canonical(stateRoot), 'xdg-data'));
    expect(frame.envEcho.TMPDIR).toBe(path.join(canonical(stateRoot), 'tmp'));
  });

  it('认证状态注入 authPathRefs：confined 进程经 XDG 落点 symlink 读到真实凭证；未声明的 home 文件不进状态目录', async () => {
    // 假 home：声明的凭证 + 未声明的邻居文件（后者绝不进状态目录）。
    // 读在 seatbelt 是 allow-default，本用例钉的是「XDG 重定向后的落点位有/没有
    // 什么」——confined agent 按 $XDG_*_HOME 找凭证时命中的正是这里。
    const fakeHome = tmpDir('dsh-acp-sbx-cred-home-');
    fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'devin'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml'), 'devin-token-simulated');
    fs.mkdirSync(path.join(fakeHome, '.config', 'other'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.config', 'other', 'private.txt'), 'do-not-mirror');
    const workspace = tmpDir('dsh-acp-sbx-cred-ws-');

    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      argv: [
        '/bin/sh',
        '-c',
        'cat "$XDG_DATA_HOME/devin/credentials.toml"; echo; if [ -e "$XDG_CONFIG_HOME/other/private.txt" ]; then echo LEAKED; else echo ABSENT; fi',
      ],
      env: await buildAcpAgentEnv(),
      sandbox,
      authPathRefs: ['~/.local/share/devin/credentials.toml'],
      homeDir: fakeHome,
    });
    expect(plan.argv[0]).toBe('sandbox-exec');
    const stateDir = plan.stateDir ?? '';
    // 宿主侧事实：落点是指向真实凭证的 symlink（零字节复制）；未声明的 home 文件不在状态目录
    const link = path.join(stateDir, 'xdg-data', 'devin', 'credentials.toml');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml'));
    expect(fs.existsSync(path.join(stateDir, 'xdg-config', 'other'))).toBe(false);
    // confined 实证：经真实 sandbox-exec 跑计划 argv/env——子进程按重定向后的
    // XDG_DATA_HOME 经 symlink 读到真实凭证；按 XDG_CONFIG_HOME 看不到未声明的邻居文件
    const run = spawnSync(plan.argv[0] ?? '', plan.argv.slice(1), { env: plan.env, encoding: 'utf8', timeout: 15_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual(['devin-token-simulated', 'ABSENT']);
  });

  it('认证状态注入 写向钉：confined 进程经 XDG 落点 symlink 写真实凭证被 seatbelt 拒（workspace-write 档，真文件字节不变）', async () => {
    // symlink 读侧是 allow-default 才成立；写侧必须钉死：seatbelt deny 落在解析后
    // 的真实路径上，confined agent 不能经落点链接改写 home 里的凭证。
    const fakeHome = tmpDir('dsh-acp-sbx-wcred-home-', os.homedir());
    fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'devin'), { recursive: true });
    const realCredential = path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml');
    fs.writeFileSync(realCredential, 'devin-token-original');
    const workspace = tmpDir('dsh-acp-sbx-wcred-ws-', os.homedir());

    const plan = buildAcpSpawnPlan({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      argv: ['/bin/sh', '-c', 'echo forged >> "$XDG_DATA_HOME/devin/credentials.toml"'],
      env: await buildAcpAgentEnv(),
      sandbox,
      authPathRefs: ['~/.local/share/devin/credentials.toml'],
      homeDir: fakeHome,
    });
    expect(plan.argv[0]).toBe('sandbox-exec');
    const run = spawnSync(plan.argv[0] ?? '', plan.argv.slice(1), { env: plan.env, encoding: 'utf8', timeout: 15_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0); // seatbelt 拒写
    expect(fs.readFileSync(realCredential, 'utf8')).toBe('devin-token-original');
  });

  it('confine 不可用 → SANDBOX_UNAVAILABLE 且进程未被 spawn', async () => {
    const workspace = tmpDir('dsh-acp-sbx-fc-ws-', os.homedir());
    const stateRoot = tmpDir('dsh-acp-sbx-fc-state-', os.homedir());
    const unavailable: AcpSandboxProviderLike = {
      confine: () => {
        throw Object.assign(new Error('no sandbox backend is usable on this host'), {
          name: 'SandboxUnavailableError',
          code: 'SANDBOX_UNAVAILABLE',
        });
      },
    };
    let thrown: unknown;
    try {
      buildAcpSpawnPlan({
        mode: 'read-only',
        workspaceRoot: workspace,
        stateRoot,
        argv: [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-failclosed`],
        env: {},
        sandbox: unavailable,
      });
    } catch (error: unknown) {
      thrown = error;
    }
    // fail closed：计划在构造连接之前抛出，spawn 根本无从发生
    expect(thrown).toBeInstanceOf(AcpClientError);
    expect((thrown as AcpClientError).kind).toBe('sandbox-unavailable');
    const ps = execFileSync('ps', ['-axo', 'pid,args'], { encoding: 'utf8' });
    expect(ps.split('\n').filter((line) => line.includes(`${SPEC_TAG}-failclosed`))).toEqual([]);
  });
});
