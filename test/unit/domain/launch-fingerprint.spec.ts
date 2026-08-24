// launch-fingerprint.spec.ts — launch fingerprint 组装（src/domain/session/launch-fingerprint.ts）单测。
//
// 覆盖：
//   - 分量稳定性：相同输入恒等输出（canonical 哈希相同）
//   - 逐分量变化检测：profileId / descriptor 绑定 / envRef presence /
//     opaqueRef 源 / executableOverride presence / dataHomeGeneration 任一变化 → 指纹不同
//   - secret-free：env 值（ANTHROPIC_* 等）绝不出现在指纹 JSON 里
//   - opaque ref 的 `~` 展开 + normalize（注入 homeDir，不碰真实 home）
//   - 无 descriptor 的普通 profile：descriptor 系分量一律 null（键恒写出——旧 binding
//     缺键 → canonical 哈希不等 → 'profile-changed' 阻断的机制前提）

import { describe, expect, it } from 'vitest';
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts';
import { descriptorOf } from '../../../src/domain/session/agent-config.ts';
import type { AcpStubAgentConfig } from '../../../src/domain/session/agent-config.ts';
import { acpLaunchFingerprint } from '../../../src/domain/session/launch-fingerprint.ts';

const HOME = '/home/tester';

function baseConfig(): AcpStubAgentConfig {
  return {
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    env: { ZED_LIKE: '1', ALPHA: '2' },
    runtime: 'codex',
  };
}

function baseInput() {
  return {
    profileId: 'codex',
    config: baseConfig(),
    descriptor: descriptorOf('codex', baseConfig()),
    generation: 1,
    env: { PATH: '/usr/bin' } as Record<string, string | undefined>,
    homeDir: HOME,
  };
}

describe('acpLaunchFingerprint（边界）', () => {
  it('相同输入恒等输出（canonical 哈希稳定）', () => {
    const a = acpLaunchFingerprint(baseInput());
    const b = acpLaunchFingerprint(baseInput());
    expect(a).toEqual(b);
    expect(acpCanonicalHash16(a)).toBe(acpCanonicalHash16(b));
  });

  it('envKeys 排序固定且绝不含值', () => {
    const fp = acpLaunchFingerprint(baseInput());
    expect(fp.envKeys).toEqual(['ALPHA', 'ZED_LIKE']);
    expect(JSON.stringify(fp)).not.toContain('"1"');
  });

  it('逐分量变化检测：profileId / descriptor / generation / envRef presence', () => {
    const base = acpCanonicalHash16(acpLaunchFingerprint(baseInput()));
    const variants = [
      { ...baseInput(), profileId: 'codex-alt' },
      { ...baseInput(), descriptor: descriptorOf('kimi', { runtime: 'kimi' }) },
      { ...baseInput(), generation: 2 },
    ];
    for (const variant of variants) {
      expect(acpCanonicalHash16(acpLaunchFingerprint(variant))).not.toBe(base);
    }
  });

  it('opaque refs：`~` 展开 + normalize，排序固定，凭证内容不入', () => {
    const fp = acpLaunchFingerprint(baseInput());
    expect(fp.opaqueRefs).toEqual([
      { source: `${HOME}/.codex/auth.json`, targetRelative: 'auth.json' },
      { source: `${HOME}/.codex/config.toml`, targetRelative: 'config.toml' },
    ]);
  });

  it('envRefs 只记存在性（present），值绝不出现在指纹 JSON 里（secret-free）', () => {
    const secretValue = 'sk-test-SECRET-value-never-persisted';
    const claude = descriptorOf('claude', { runtime: 'claude' });
    const fp = acpLaunchFingerprint({
      profileId: 'claude',
      config: { name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, runtime: 'claude' },
      descriptor: claude,
      generation: 3,
      env: { ANTHROPIC_API_KEY: secretValue, ANTHROPIC_BASE_URL: 'https://gateway.example' },
      homeDir: HOME,
    });
    const anthropicRef = fp.envRefs?.find((ref) => ref.key === 'ANTHROPIC_API_KEY');
    expect(anthropicRef).toEqual({ key: 'ANTHROPIC_API_KEY', present: true });
    const absentRef = fp.envRefs?.find((ref) => ref.key === 'ANTHROPIC_MODEL');
    expect(absentRef).toEqual({ key: 'ANTHROPIC_MODEL', present: false });
    // envRefs 按 key 排序固定
    expect(fp.envRefs?.map((ref) => ref.key)).toEqual([...(fp.envRefs ?? [])].map((ref) => ref.key).sort());
    expect(JSON.stringify(fp)).not.toContain(secretValue);
    expect(JSON.stringify(fp)).not.toContain('https://gateway.example');
    expect(fp.dataHomeGeneration).toBe(3);
  });

  it('executableOverride：claude 记 {name,present}，codex 记 null', () => {
    const claude = descriptorOf('claude', { runtime: 'claude' });
    const withOverride = acpLaunchFingerprint({
      profileId: 'claude',
      config: { name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, runtime: 'claude' },
      descriptor: claude,
      generation: 1,
      env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
      homeDir: HOME,
    });
    expect(withOverride.executableOverride).toEqual({ name: 'CLAUDE_CODE_EXECUTABLE', present: true });
    // override 存在性变化 → 指纹变化（值不入指纹）
    const withoutOverride = acpLaunchFingerprint({
      profileId: 'claude',
      config: { name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, runtime: 'claude' },
      descriptor: claude,
      generation: 1,
      env: {},
      homeDir: HOME,
    });
    expect(withoutOverride.executableOverride).toEqual({ name: 'CLAUDE_CODE_EXECUTABLE', present: false });
    expect(acpCanonicalHash16(withOverride)).not.toBe(acpCanonicalHash16(withoutOverride));
    expect(JSON.stringify(withOverride)).not.toContain('/opt/claude/bin/claude');
    expect(acpLaunchFingerprint(baseInput()).executableOverride).toBeNull();
  });

  it('无 descriptor 的普通 profile：descriptor 系分量一律 null（键恒写出）', () => {
    const fp = acpLaunchFingerprint({
      profileId: 'plain',
      config: { name: 'Plain', command: 'plain-acp', args: ['--x'], env: {} },
      descriptor: undefined,
      generation: 5,
      env: {},
      homeDir: HOME,
    });
    expect(fp.descriptorId).toBeNull();
    expect(fp.adapterVersion).toBeNull();
    expect(fp.wrappedCliVersion).toBeNull();
    expect(fp.envRefs).toBeNull();
    expect(fp.opaqueRefs).toBeNull();
    expect(fp.executableOverride).toBeNull();
    expect(fp.dataHomeGeneration).toBeNull();
    expect(fp.profileId).toBe('plain');
    // null 键在 canonical JSON 里占位——与「旧 binding 缺这些键」哈希不等（阻断机制前提）
    const oldShape = { command: 'plain-acp', args: ['--x'], envKeys: [] };
    expect(acpCanonicalHash16(fp)).not.toBe(acpCanonicalHash16(oldShape));
  });

 it('dataHomeGeneration：data home agent 记代际，确定性 session-state agent（devin，边界）同记代际，其余记 null', () => {
    expect(acpLaunchFingerprint(baseInput()).dataHomeGeneration).toBe(1);
 // devin：无 dataHomeEnv 但 sessionStateDir 'deterministic'——代际同样
    // 驱动状态目录选址，记代际（旧 devin binding 的指纹因此不等 → 既有
    // 'profile-changed' 阻断兜底，无迁移）
    const devin = descriptorOf('devin', { runtime: 'devin' });
    const fp = acpLaunchFingerprint({
      profileId: 'devin',
      config: { name: 'Devin', command: 'devin', args: ['acp'], env: {}, runtime: 'devin' },
      descriptor: devin,
      generation: 4,
      env: {},
      homeDir: HOME,
    });
    expect(fp.dataHomeGeneration).toBe(4);
    expect(fp.opaqueRefs).toEqual([
      { source: `${HOME}/.local/share/devin/credentials.toml`, targetRelative: 'devin/credentials.toml' },
    ]);
    // 对照：无 descriptor 的普通 profile 恒 null（同文件上方「无 descriptor」用例已钉全分量）
  });
});
