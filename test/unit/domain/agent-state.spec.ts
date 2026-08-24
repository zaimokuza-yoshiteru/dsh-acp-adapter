// agent-state.spec.ts — 随附测试：deriveAcpAgentState 五态状态机全分支矩阵。
//
// 被测模块（src/domain/session/agent-state.ts）是零 import 叶子，直接 vitest 可测。
// 新鲜度判定（agent-config.ts acpProbeFresh = key 相等 + TTL）在调用方完成，
// 本测试钉纯函数本身（判定顺序即词表优先级，逐分支钉死）与 acpProbeFresh 的
// TTL/键边界。

import { describe, expect, it } from 'vitest';
import { deriveAcpAgentState, type AcpAgentStateInput } from '../../../src/domain/session/agent-state.ts';
import { ACP_PROBE_CACHE_ERROR_TTL_MS, ACP_PROBE_CACHE_OK_TTL_MS, acpProbeFresh } from '../../../src/domain/session/agent-config.ts';

/** 全绿基准输入（逐项覆盖出分支）。 */
const BASE: AcpAgentStateInput = {
  hostCompatible: true,
  configValid: true,
  probe: { result: { kind: 'ok', modelCount: 3, hasModelConfigOption: true } },
  declaresAuthRefs: true,
};

describe('deriveAcpAgentState（五态）', () => {
  it('宿主不兼容 → incompatible（其余事实一律不消费）', () => {
    expect(deriveAcpAgentState({ ...BASE, hostCompatible: false })).toBe('incompatible');
    // 优先级钉：即使 probe 报错/配置无效，结构门先裁决
    expect(
      deriveAcpAgentState({ hostCompatible: false, configValid: false, probe: { result: { kind: 'error', failureKind: 'crash' } }, declaresAuthRefs: true }),
    ).toBe('incompatible');
  });

  it('配置无效 → unavailable（无独立 invalid 桶；配置问题与 probe 故障同桶）', () => {
    expect(deriveAcpAgentState({ ...BASE, configValid: false })).toBe('unavailable');
    // 即使 probe 新鲜 ok，配置无效仍不可用
    expect(deriveAcpAgentState({ ...BASE, configValid: false, probe: { result: { kind: 'ok', modelCount: 5, hasModelConfigOption: true } } })).toBe('unavailable');
  });

  it('无新鲜 probe（undefined）→ saved-unverified（与声明与否无关）', () => {
    expect(deriveAcpAgentState({ ...BASE, probe: undefined })).toBe('saved-unverified');
    expect(deriveAcpAgentState({ ...BASE, probe: undefined, declaresAuthRefs: false })).toBe('saved-unverified');
  });

  it('probe error + auth_required → auth-required（与声明、模型数无关）', () => {
    const probe = { result: { kind: 'error', failureKind: 'auth_required' } } as const;
    expect(deriveAcpAgentState({ ...BASE, probe })).toBe('auth-required');
    expect(deriveAcpAgentState({ ...BASE, probe, declaresAuthRefs: false })).toBe('auth-required');
  });

  it('probe error + 其余 kind → unavailable（spawn-failure/timeout/crash/protocol-error/sandbox-unavailable 同桶）', () => {
    for (const failureKind of ['spawn-failure', 'timeout', 'crash', 'protocol-error', 'sandbox-unavailable']) {
      expect(deriveAcpAgentState({ ...BASE, probe: { result: { kind: 'error', failureKind } } }), failureKind).toBe('unavailable');
    }
  });

  it('probe ok + descriptor 声明 auth refs：模型目录非空 → ready；空目录 → auth-required（认证状态注入 形态）', () => {
    expect(deriveAcpAgentState(BASE)).toBe('ready');
    expect(deriveAcpAgentState({ ...BASE, probe: { result: { kind: 'ok', modelCount: 1, hasModelConfigOption: false } } })).toBe('ready');
    expect(deriveAcpAgentState({ ...BASE, probe: { result: { kind: 'ok', modelCount: 0, hasModelConfigOption: false } } })).toBe('auth-required');
  });

  it(' 目录口径：probe ok 零 models 但 configOptions 含 category=model 项 → ready（kimi 形态：目录只经 configOptions 提供）', () => {
    // kimi 形态（、实际 ACP 行为）：legacy models 恒空，目录在 configOptions——
    // 旧口径会把 declaresAuthRefs 的 kimi 误判成 auth-required
    expect(deriveAcpAgentState({ ...BASE, probe: { result: { kind: 'ok', modelCount: 0, hasModelConfigOption: true } } })).toBe('ready');
    // 反例：无 model 类 configOption 的零 models 仍按原口径折 auth-required（devin 认证状态注入 检出不变）
    expect(deriveAcpAgentState({ ...BASE, probe: { result: { kind: 'ok', modelCount: 0, hasModelConfigOption: false } } })).toBe('auth-required');
  });

  it('probe ok + 未声明 auth refs（无 descriptor）→ ready（不看模型数）', () => {
    expect(deriveAcpAgentState({ ...BASE, declaresAuthRefs: false })).toBe('ready');
    expect(deriveAcpAgentState({ ...BASE, declaresAuthRefs: false, probe: { result: { kind: 'ok', modelCount: 0, hasModelConfigOption: false } } })).toBe('ready');
  });
});

// ----------：probe 缓存新鲜度（key 相等 + TTL；全仓唯一判定落点） ----------

describe('acpProbeFresh（新鲜度集中判定）', () => {
  const OK_ENTRY = { key: 'k1', at: 1_000_000, result: { kind: 'ok' as const } };
  const ERROR_ENTRY = { key: 'k1', at: 1_000_000, result: { kind: 'error' as const } };

  it('key 不相等一律不新鲜（配置漂移口径不变）', () => {
    expect(acpProbeFresh(OK_ENTRY, 'other-key', 1_000_000)).toBe(false);
    expect(acpProbeFresh(ERROR_ENTRY, 'other-key', 1_000_000)).toBe(false);
  });

  it('ok 条目 TTL 10 分钟：边界内新鲜、恰过界过期', () => {
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000)).toBe(true);
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_OK_TTL_MS - 1)).toBe(true);
    expect(acpProbeFresh(OK_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_OK_TTL_MS)).toBe(false);
    expect(ACP_PROBE_CACHE_OK_TTL_MS).toBe(10 * 60_000);
  });

  it('error 条目 TTL 30 秒（负缓存短窗口）：边界内新鲜、恰过界过期', () => {
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000)).toBe(true);
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_ERROR_TTL_MS - 1)).toBe(true);
    expect(acpProbeFresh(ERROR_ENTRY, 'k1', 1_000_000 + ACP_PROBE_CACHE_ERROR_TTL_MS)).toBe(false);
    expect(ACP_PROBE_CACHE_ERROR_TTL_MS).toBe(30_000);
  });
});
