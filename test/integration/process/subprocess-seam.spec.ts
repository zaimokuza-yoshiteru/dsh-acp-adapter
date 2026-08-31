// subprocess-seam.spec.ts — 随附测试：ctx.subprocess seam 的结构窄化、
// 真 spawn 环境继承实证、fail-closed 分类与依赖面守卫。
//
// 钉版对象：
//   - narrowSubprocessSeam：形态判定 + spawn 调用点固定填入 pipe/pipe/pipe stdio
//   - 真 spawn 继承：污染父 env 后经 AcpAgentProcess 启动内联 agent，
//     DSH scrub 底座保留普通环境、删除父 credential/DSH_*，profile 显式
//     credential 仍作为用户 opt-in 穿透
//   - fail closed：spec.subprocess 缺席构造即抛 spawn-failure；seam 同步抛错 →
//     initialize 分类 spawn-failure 且文案同格
//   - 依赖面守卫：两包仅在 devDependencies（精确 0.1.2-alpha.3），src/** 零值级 import
//     （宿主模块实例一致性 纪律：值级 import dsh 包会让产物解析到第二实例）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACP_SUBPROCESS_UNAVAILABLE_MESSAGE,
  narrowSubprocessSeam,
} from '../../../src/runtime/process/subprocess.ts';
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';
import { AcpAgentProcess } from '../../../src/runtime/process/agent-process.ts';
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts';
import { AcpClientError } from '../../../src/protocol/v1/errors.ts';
import type { AcpConnectionSpec } from '../../../src/runtime/process/types.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(TEST_DIR, '..', '..', '..');

let subprocess: SubprocessSeam;

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam;
});

/** 临时污染 process.env（key 带 spec 前缀防撞真环境），fn 结束后逐键还原。 */
async function withPollutedEnv(entries: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(entries)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(entries)) process.env[key] = value;
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('narrowSubprocessSeam 结构化窄化', () => {
  it('缺 spawn/resolveExecutable 方法面的候选一律 undefined（调用方 fail closed）', () => {
    expect(narrowSubprocessSeam(undefined)).toBeUndefined();
    expect(narrowSubprocessSeam(null)).toBeUndefined();
    expect(narrowSubprocessSeam('subprocess')).toBeUndefined();
    expect(narrowSubprocessSeam({})).toBeUndefined();
    expect(narrowSubprocessSeam({ spawn: () => ({}) })).toBeUndefined();
    expect(narrowSubprocessSeam({ resolveExecutable: () => ({}) })).toBeUndefined();
  });

  it('适配产物在 spawn 调用点固定填入 pipe/pipe/pipe stdio（本包唯一 stdio 形态）', () => {
    let seen: unknown;
    const candidate = {
      spawn: (spec: unknown): never => {
        seen = spec;
        throw new Error('capture-only');
      },
      resolveExecutable: (): Promise<string> => Promise.reject(new Error('unused')),
    };
    const seam = narrowSubprocessSeam(candidate);
    expect(seam).toBeDefined();
    expect(() => seam?.spawn({ argv: ['cmd', '--flag'], cwd: '/tmp', graceMs: 100 })).toThrow('capture-only');
    expect(seen).toEqual({
      argv: ['cmd', '--flag'],
      cwd: '/tmp',
      graceMs: 100,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    });
  });

  it('真实服务（LocalSubprocessRuntime 实例）通过窄化', () => {
    // sharedTestSubprocess 挂载时已窄化一次；此处对原始实例再窄化证明形态吻合
    expect(narrowSubprocessSeam(subprocess)).toBeDefined();
  });
});

describe('真 spawn scrubbed-parent 实证（AcpAgentProcess 生产路径）', () => {
  it('保留 scrub 后的普通父环境、删除父凭证，并允许 profile 显式 credential', async () => {
    await withPollutedEnv(
      {
        HTTP_PROXY: 'http://127.0.0.1:9', // 普通父环境由 DSH 保留
        SSH_AUTH_SOCK: '/tmp/dsh-acp-seam-fake.sock', // Agent 原生登录可能依赖
        DSH_ACP_SEAM_API_KEY: 'sk-should-not-leak', // provider scrub 删除
        DSH_ACP_SEAM_MARKER: 'dsh-should-not-leak', // provider scrub 删除
      },
      async () => {
        const outPath = path.join(os.tmpdir(), `dsh-acp-seam-env-${String(process.pid)}.json`);
        try {
          const desired = { EXPOSED_API_KEY: 'explicit-credential-passthrough', PLAIN_VAR: 'plain-ok' };
          const proc = new AcpAgentProcess(
            {
              argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))', outPath],
              cwd: os.tmpdir(),
              env: desired,
              subprocess,
            },
            { eofGraceMs: 200, termGraceMs: 300 },
          );
          await proc.close();
          expect(proc.exited).toEqual({ code: 0, signal: null });
          const env = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, string>;
          // 显式条目（含 credential 形名）穿透
          expect(env['EXPOSED_API_KEY']).toBe('explicit-credential-passthrough');
          expect(env['PLAIN_VAR']).toBe('plain-ok');
          // DSH scrub 后的普通父环境继续存在，保证原生 CLI 行为。
          expect(env['HTTP_PROXY']).toBe('http://127.0.0.1:9');
          expect(env['SSH_AUTH_SOCK']).toBe('/tmp/dsh-acp-seam-fake.sock');
          expect(env['DSH_ACP_SEAM_API_KEY']).toBeUndefined();
          expect(env['DSH_ACP_SEAM_MARKER']).toBeUndefined();
          expect(env['PATH']).toBe(process.env.PATH);
          // 关键继承项与显式覆盖同时存在；其他普通父环境由 DSH 决定。
          if (process.platform === 'darwin') {
            expect(Object.keys(env).sort()).toEqual(expect.arrayContaining(['EXPOSED_API_KEY', 'PLAIN_VAR', 'HTTP_PROXY', 'SSH_AUTH_SOCK', 'PATH']));
          } else if (process.platform !== 'win32') {
            expect(Object.keys(env).sort()).toEqual(expect.arrayContaining(['EXPOSED_API_KEY', 'PLAIN_VAR', 'HTTP_PROXY', 'SSH_AUTH_SOCK', 'PATH']));
          }
        } finally {
          fs.rmSync(outPath, { force: true });
        }
      },
    );
  });
});

describe('fail closed（spawn-failure 分类）', () => {
  it('spec.subprocess 缺席（运行时裸 spec）→ 构造即抛 spawn-failure + 统一诊断文案', () => {
    const bare = { argv: [process.execPath, '-e', ''], cwd: os.tmpdir(), env: {} } as unknown as AcpConnectionSpec;
    let thrown: unknown;
    try {
      void new AcpClientConnection(bare);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    const acpErr = thrown as AcpClientError;
    expect(acpErr.kind).toBe('spawn-failure');
    expect(acpErr.message).toBe(ACP_SUBPROCESS_UNAVAILABLE_MESSAGE);
  });

  it('seam spawn 同步抛错 → initialize 分类 spawn-failure，文案含命令名与原始错误', async () => {
    const throwingSeam: SubprocessSeam = {
      spawn: () => {
        throw new Error('boom-sync-spawn');
      },
      resolveExecutable: () => Promise.reject(new Error('unused')),
    };
    const conn = new AcpClientConnection(
      { argv: ['/bin/dsh-acp-false-agent', 'acp'], cwd: os.tmpdir(), env: {}, subprocess: throwingSeam },
      { initializeTimeoutMs: 1000 },
    );
    let thrown: unknown;
    try {
      await conn.initialize();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    const acpErr = thrown as AcpClientError;
    expect(acpErr.kind).toBe('spawn-failure');
    expect(acpErr.message).toContain('/bin/dsh-acp-false-agent');
    expect(acpErr.message).toContain('boom-sync-spawn');
    await conn.close();
  });
});

describe('依赖面守卫（宿主模块实例一致性 纪律）', () => {
  it('package.json：两包只作为精确发布版开发依赖，不进入运行时依赖面', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of ['@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-subprocess-local']) {
      expect(pkg.dependencies?.[name]).toBeUndefined();
      expect(pkg.peerDependencies?.[name]).toBeUndefined();
      expect(pkg.devDependencies?.[name]).toBe('0.1.2-alpha.3');
    }
    expect(JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).scripts['setup:source-reference']).toBeDefined();
  });

  it('src/** 零 dsh-subprocess 值级 import（结构镜像全在 src/runtime/process/subprocess.ts）', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(path.join(PKG_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const importPattern = /(?:from|import)\s*\(?\s*['"]@deepseek-ai\/dsh-subprocess/;
    const offenders = files.filter((file) => importPattern.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
