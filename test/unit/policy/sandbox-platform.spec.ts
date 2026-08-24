// sandbox-platform.spec.ts — 平台 adapter 随附测试：sandbox 与凭据的平台化拆分。
//
// 覆盖：
//   - createDefaultSandboxPlatform：win32 → Windows adapter（partial + 残余风险文案）；
//     darwin/linux/缺省 → XDG adapter（platformId 如实携带）；本目录是 domain/policy
//     层 process.platform 唯一读取点
//   - macOS（XDG）adapter：状态目录 env 布局（XDG 三件套 + TMPDIR，顺序钉死）、
//     authPathRef 规则表（.local/share/.config/.cache → xdg-*）、enforcement 预期 full、
//     createSessionStateDir 落 os.tmpdir 且 canonicalized
//   - Windows adapter：env 布局为 APPDATA 系且有意不注
//     TMP/TEMP（runner 重写为准）、authPathRef 规则表为 AppData 两根、大小写不敏感匹配；
//     路径规则经 resolveAuthPathRefTarget 做离台纯映射测试；fs 物化不在非 Windows
//     主机上演练。
//   - authPathRefs 前缀判定：~ 展开、前缀命中/不命中 fail loud（消息只带条目序号）、
//     win32 下 XDG 声明被拒（前缀表不同——不硬编码 Unix 路径）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AcpSpawnPlanError } from '../../../src/domain/policy/errors.ts';
import { createDefaultSandboxPlatform } from '../../../src/domain/policy/platform/index.ts';
import { createXdgSandboxPlatform } from '../../../src/domain/policy/platform/macos.ts';
import { createWindowsSandboxPlatform } from '../../../src/domain/policy/platform/windows.ts';
import { resolveAuthPathRefTarget } from '../../../src/domain/policy/platform/staging.ts';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const WIN_HOME = 'C:\\Users\\tester';
const WIN_STATE = 'C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-acp-xyz';

/** win32 纯映射解析的便捷包装（纯字符串运算，无 fs 副作用——离台单测成立的前提）。 */
function winResolve(declared: string): { source: string; target: string } {
  return resolveAuthPathRefTarget({
    platform: createWindowsSandboxPlatform(),
    declared,
    label: 'authPathRefs entry #1',
    homeDir: WIN_HOME,
    stateDir: WIN_STATE,
  });
}

describe('createDefaultSandboxPlatform（domain/policy 层平台分支唯一读取点）', () => {
  it('darwin/linux/缺省 → XDG adapter（platformId 如实携带实际平台值）', () => {
    expect(createDefaultSandboxPlatform('darwin').platformId).toBe('darwin');
    expect(createDefaultSandboxPlatform('linux').platformId).toBe('linux');
    expect(createDefaultSandboxPlatform().platformId).toBe(process.platform);
    expect(createDefaultSandboxPlatform('darwin').enforcementExpectation).toBe('full');
  });

  it('win32 → Windows adapter：enforcement 恒 partial + 已知残余风险文案', () => {
    const platform = createDefaultSandboxPlatform('win32');
    expect(platform.platformId).toBe('win32');
    // 实证事实（dsh sandbox-local STATIC_ENFORCEMENT 钉版）：windows-acl 恒报 partial
    expect(platform.enforcementExpectation).toBe('partial');
    expect(typeof platform.enforcementNote).toBe('string');
    expect(platform.enforcementNote).toContain('partial');
  });
});

describe('macOS（XDG/POSIX）adapter：拆分前行为原样保留（实证形态）', () => {
  it('状态目录 env 布局 = XDG 三件套 + TMPDIR（顺序钉死——旧 injectStateDir 建目录序）', () => {
    expect(createXdgSandboxPlatform().stateDirEnvLayout).toEqual([
      ['XDG_DATA_HOME', 'xdg-data'],
      ['XDG_CONFIG_HOME', 'xdg-config'],
      ['XDG_CACHE_HOME', 'xdg-cache'],
      ['TMPDIR', 'tmp'],
    ]);
  });

  it('authPathRef 规则表 = XDG home 三前缀（互不含摄）→ xdg-data/xdg-config/xdg-cache', () => {
    const platform = createXdgSandboxPlatform();
    expect(platform.authPathRefRules).toEqual([
      { homeRelativePrefix: '.local/share', mirrorSubdir: 'xdg-data' },
      { homeRelativePrefix: '.config', mirrorSubdir: 'xdg-config' },
      { homeRelativePrefix: '.cache', mirrorSubdir: 'xdg-cache' },
    ]);
    expect(platform.pathsCaseInsensitive).toBe(false);
    expect(platform.authPathRefHomeDescription).toContain('XDG home equivalents');
    expect(platform.enforcementNote).toBeNull();
  });

  it('createSessionStateDir：os.tmpdir() 下 dsh-acp- 前缀、已建且 canonicalized', () => {
    const dir = createXdgSandboxPlatform().createSessionStateDir();
    tmpDirs.push(dir);
    expect(path.basename(dir).startsWith('dsh-acp-')).toBe(true);
    expect(dir.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    // mkdtemp 0700 + 显式 chmod 兜底（POSIX 口径；不代表 Windows 真机行为）。
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('Windows adapter（仅验证纯映射，不代表 Windows 真机支持）', () => {
  it('状态目录 env 布局 = APPDATA/LOCALAPPDATA；有意不注 TMP/TEMP（windows-acl runner 重写为准）', () => {
    const layout = createWindowsSandboxPlatform().stateDirEnvLayout;
    expect(layout).toEqual([
      ['APPDATA', 'appdata-roaming'],
      ['LOCALAPPDATA', 'appdata-local'],
    ]);
    // runner 以 SetEnvironmentVariableW 重写 TMP/TEMP 到 per-session 私有目录——本层不铺第二层真源
    expect(layout.map(([key]) => key)).not.toContain('TEMP');
    expect(layout.map(([key]) => key)).not.toContain('TMP');
    expect(layout.map(([key]) => key)).not.toContain('TMPDIR');
  });

  it('authPathRef 规则表 = AppData 两根（%APPDATA%/%LOCALAPPDATA%；Devin 凭据落点未实测）', () => {
    expect(createWindowsSandboxPlatform().authPathRefRules).toEqual([
      { homeRelativePrefix: 'AppData/Roaming', mirrorSubdir: 'appdata-roaming' },
      { homeRelativePrefix: 'AppData/Local', mirrorSubdir: 'appdata-local' },
    ]);
    expect(createWindowsSandboxPlatform().pathsCaseInsensitive).toBe(true);
  });

  it('纯映射：~ 展开 + AppData 前缀命中 → 落点位（win32 路径语义离台实测）', () => {
    expect(winResolve('~/AppData/Roaming/devin/credentials.toml')).toEqual({
      source: 'C:\\Users\\tester\\AppData\\Roaming\\devin\\credentials.toml',
      target: 'C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-acp-xyz\\appdata-roaming\\devin\\credentials.toml',
    });
    expect(winResolve('~/AppData/Local/devin/session.json').target).toBe(
      'C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-acp-xyz\\appdata-local\\devin\\session.json',
    );
  });

  it('纯映射：NTFS 大小写不敏感匹配（不代表 Windows 真机验证）', () => {
    expect(winResolve('~/appdata/roaming/devin/credentials.toml').target).toContain('appdata-roaming\\devin\\credentials.toml');
    expect(winResolve('~/APPDATA/ROAMING/devin/credentials.toml').target).toContain('appdata-roaming\\devin\\credentials.toml');
  });

  it('纯映射：XDG 声明在 win32 下前缀不命中 → fail loud（不硬编码 Unix 路径；消息只带条目序号）', () => {
    for (const declared of ['~/.local/share/devin/credentials.toml', '~/.config/foo/config.json', '~', '~/AppData/x']) {
      let thrown: unknown;
      try {
        winResolve(declared);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, declared).toBeInstanceOf(AcpSpawnPlanError);
      const message = (thrown as Error).message;
      expect(message).toContain('authPathRefs entry #1');
      expect(message).toContain('%APPDATA%');
      // 纪律钉死：声明路径永不进错误消息（'~' 展开说明里的符号本身不算泄露）
      const stripped = declared.replace(/^~\/?/, '');
      if (stripped !== '') expect(message).not.toContain(stripped);
    }
  });
});
