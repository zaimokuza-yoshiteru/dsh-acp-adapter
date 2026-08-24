// opaque-staging.spec.ts — 确定性 data home stageOpaqueRefsOn（src/domain/policy/platform/staging.ts）单测。
//
// 覆盖：
//   - 落点正确：<dataHome>/<targetRelative> 的 symlink 指向真实宿主源（零字节复制）
//   - optional 源缺失静默跳过（无 warn）；非 optional 源缺失 warn 后跳过
//   - symlink 源 / 目录源 fail loud（lstat 防线，不跟随）
//   - targetRelative 逃逸（绝对路径 / `..` 上爬）fail loud
//   - 幂等：同目标 symlink 原样保留；异目标既有落点解除重建
//   - data home 入口建目录并收紧 0700

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AcpSpawnPlanError } from '../../../src/domain/policy/errors.ts';
import { createDefaultSandboxPlatform } from '../../../src/domain/policy/platform/index.ts';
import { stageOpaqueRefsOn } from '../../../src/domain/policy/platform/staging.ts';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-opaque-staging-'));
  tmpDirs.push(dir);
  return dir;
}

interface Fixture {
  home: string;
  dataHome: string;
  warns: string[];
  stage: (refs: readonly { source: string; targetRelative: string; optional: boolean }[]) => void;
}

function fixture(): Fixture {
  const root = makeTmp();
  const home = path.join(root, 'home');
  const dataHome = path.join(root, 'data-home');
  fs.mkdirSync(home, { recursive: true });
  const warns: string[] = [];
  return {
    home,
    dataHome,
    warns,
    stage: (refs) => {
      stageOpaqueRefsOn({
        refs,
        dataHome,
        homeDir: home,
        onWarn: (message) => { warns.push(message); },
        platform: createDefaultSandboxPlatform(),
      });
    },
  };
}

function seedFile(dir: string, relative: string, content = 'secret-bytes'): string {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('stageOpaqueRefsOn（确定性 data home opaque refs → data home）', () => {
  it('落点正确：symlink 指向真实宿主源，凭证字节零复制', () => {
    const f = fixture();
    const source = seedFile(f.home, '.codex/auth.json');
    f.stage([{ source: '~/.codex/auth.json', targetRelative: 'auth.json', optional: false }]);
    const target = path.join(f.dataHome, 'auth.json');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);
    expect(fs.readFileSync(target, 'utf8')).toBe('secret-bytes');
    // data home 收紧 0700
    expect((fs.statSync(f.dataHome).mode & 0o777)).toBe(0o700);
    expect(f.warns).toEqual([]);
  });

  it('嵌套 targetRelative：父链逐层建并收紧 0700', () => {
    const f = fixture();
    seedFile(f.home, '.kimi-code/credentials/kimi-code.json');
    f.stage([{ source: '~/.kimi-code/credentials/kimi-code.json', targetRelative: 'credentials/kimi-code.json', optional: false }]);
    const target = path.join(f.dataHome, 'credentials', 'kimi-code.json');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect((fs.statSync(path.join(f.dataHome, 'credentials')).mode & 0o777)).toBe(0o700);
  });

  it('optional 源缺失静默跳过（无 warn）；非 optional 源缺失 warn 后跳过', () => {
    const f = fixture();
    f.stage([
      { source: '~/.codex/config.toml', targetRelative: 'config.toml', optional: true },
      { source: '~/.codex/auth.json', targetRelative: 'auth.json', optional: false },
    ]);
    expect(fs.existsSync(path.join(f.dataHome, 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(f.dataHome, 'auth.json'))).toBe(false);
    expect(f.warns.length).toBe(1);
    expect(f.warns[0]).toContain('opaqueRefs entry #2');
    // 纪律：warn 不含路径本身
    expect(f.warns[0]).not.toContain('.codex');
  });

  it('symlink 源 fail loud（lstat 防线：不跟随）', () => {
    const f = fixture();
    const real = seedFile(f.home, '.codex/real-auth.json');
    const link = path.join(f.home, '.codex/auth.json');
    fs.symlinkSync(real, link);
    expect(() => {
      f.stage([{ source: '~/.codex/auth.json', targetRelative: 'auth.json', optional: false }]);
    }).toThrow(AcpSpawnPlanError);
  });

  it('目录源 fail loud（v1 不做目录递归映射）', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, '.codex/authdir'), { recursive: true });
    expect(() => {
      f.stage([{ source: '~/.codex/authdir', targetRelative: 'authdir', optional: false }]);
    }).toThrow(AcpSpawnPlanError);
  });

  it('targetRelative 逃逸 fail loud（`..` 上爬 / 绝对路径）', () => {
    const f = fixture();
    seedFile(f.home, '.codex/auth.json');
    for (const targetRelative of ['../escape', '../../x', '/abs/path']) {
      expect(() => {
        f.stage([{ source: '~/.codex/auth.json', targetRelative, optional: false }]);
      }).toThrow(AcpSpawnPlanError);
    }
  });

  it('幂等：同目标 symlink 原样保留；异目标既有落点解除重建', () => {
    const f = fixture();
    const sourceA = seedFile(f.home, '.codex/auth.json', 'A');
    const ref = { source: '~/.codex/auth.json', targetRelative: 'auth.json', optional: false };
    f.stage([ref]);
    const target = path.join(f.dataHome, 'auth.json');
    const first = fs.lstatSync(target).ino;
    f.stage([ref]); // 同目标：幂等保留（inode 不变 = 未重建）
    expect(fs.lstatSync(target).ino).toBe(first);
    // 异目标：解除重建
    const sourceB = seedFile(f.home, '.codex/auth-rotated.json', 'B');
    f.stage([{ source: '~/.codex/auth-rotated.json', targetRelative: 'auth.json', optional: false }]);
    expect(fs.readlinkSync(target)).toBe(sourceB);
    expect(fs.readFileSync(target, 'utf8')).toBe('B');
    expect(fs.lstatSync(target).ino).not.toBe(first);
    void sourceA;
  });
});
