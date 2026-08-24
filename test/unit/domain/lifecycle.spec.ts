// lifecycle.spec.ts — 会话生命周期显式状态机套件：
// src/domain/session/lifecycle.ts 的转换表钉版、合法转换链、非法转换 fail loud、
// settling 守卫。AcpAgent 侧的接线（各转换驱动点）由 test/integration/host/agent.spec.ts 的
// 「生命周期状态机」集成块覆盖。

import { describe, expect, it } from 'vitest';
import {
  ACP_LIFECYCLE_TRANSITIONS,
  AcpLifecycle,
  AcpLifecycleError,
} from '../../../src/domain/session/lifecycle.ts';
import type { AcpLifecycleKind } from '../../../src/domain/session/lifecycle.ts';

const ALL_STATES: readonly AcpLifecycleKind[] = ['cold', 'starting', 'live', 'closing', 'disposed'];

describe(' 会话生命周期状态机', () => {
  it('转换表钉版（agent.ts 驱动点所依赖的合法边）', () => {
    expect(ACP_LIFECYCLE_TRANSITIONS).toEqual({
      cold: ['starting', 'closing'],
      starting: ['live', 'cold', 'closing'],
      live: ['closing', 'cold'],
      closing: ['disposed'],
      disposed: [],
    });
    expect(Object.keys(ACP_LIFECYCLE_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it('初始为 cold；主链 cold → starting → live → closing → disposed 全部合法', () => {
    const lifecycle = new AcpLifecycle();
    expect(lifecycle.kind).toBe('cold');
    lifecycle.transition('starting');
    expect(lifecycle.kind).toBe('starting');
    lifecycle.transition('live');
    expect(lifecycle.kind).toBe('live');
    lifecycle.transition('closing');
    expect(lifecycle.kind).toBe('closing');
    lifecycle.transition('disposed');
    expect(lifecycle.kind).toBe('disposed');
  });

  it('懒启动失败回 cold 后可重试（starting → cold → starting → live）', () => {
    const lifecycle = new AcpLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('cold');
    lifecycle.transition('starting');
    lifecycle.transition('live');
    expect(lifecycle.kind).toBe('live');
  });

  it('启动在飞时拆除进场（starting → closing → disposed）合法', () => {
    const lifecycle = new AcpLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('closing');
    lifecycle.transition('disposed');
    expect(lifecycle.kind).toBe('disposed');
  });

  it('从未启动即拆除（cold → closing → disposed）合法', () => {
    const lifecycle = new AcpLifecycle();
    lifecycle.transition('closing');
    lifecycle.transition('disposed');
    expect(lifecycle.kind).toBe('disposed');
  });

 it('rebindBlank 回 cold 后可用新代际重建（live → cold → starting → live）', () => {
    const lifecycle = new AcpLifecycle();
    lifecycle.transition('starting');
    lifecycle.transition('live');
    lifecycle.transition('cold');
    expect(lifecycle.kind).toBe('cold');
    lifecycle.transition('starting');
    lifecycle.transition('live');
    expect(lifecycle.kind).toBe('live');
  });

  it('非法转换 fail loud：抛 AcpLifecycleError 且携带 from/to', () => {
    const lifecycle = new AcpLifecycle();
    expect(() => lifecycle.transition('live')).toThrow(AcpLifecycleError);
    expect(() => lifecycle.transition('live')).toThrow('illegal ACP session lifecycle transition: cold -> live');
    // 抛错后状态不漂移
    expect(lifecycle.kind).toBe('cold');

    lifecycle.transition('starting');
    lifecycle.transition('live');
    expect(() => lifecycle.transition('starting')).toThrow(AcpLifecycleError);
    expect(() => lifecycle.transition('disposed')).toThrow(AcpLifecycleError);
    expect(lifecycle.kind).toBe('live');

    lifecycle.transition('closing');
    expect(() => lifecycle.transition('live')).toThrow(AcpLifecycleError);
    lifecycle.transition('disposed');
    for (const to of ALL_STATES) {
      expect(() => lifecycle.transition(to)).toThrow(AcpLifecycleError);
    }
    expect(lifecycle.kind).toBe('disposed');
  });

  it('settling 守卫：closing/disposed 为 true（幂等重入短路用），其余为 false', () => {
    const lifecycle = new AcpLifecycle();
    expect(lifecycle.settling).toBe(false);
    lifecycle.transition('starting');
    expect(lifecycle.settling).toBe(false);
    lifecycle.transition('live');
    expect(lifecycle.settling).toBe(false);
    lifecycle.transition('closing');
    expect(lifecycle.settling).toBe(true);
    lifecycle.transition('disposed');
    expect(lifecycle.settling).toBe(true);
  });

  it('AcpLifecycleError 的 from/to 字段可供日志分流', () => {
    const lifecycle = new AcpLifecycle();
    try {
      lifecycle.transition('disposed');
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AcpLifecycleError);
      expect((error as AcpLifecycleError).from).toBe('cold');
      expect((error as AcpLifecycleError).to).toBe('disposed');
    }
  });
});
