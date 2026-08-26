// stores.spec.ts — store 引擎与四个 store 模块的行为钉。
//
// 引擎（data/stores/engine.ts）是 client-runtime defineStore 的本地结构化复刻
// （真身 lib/client.js 是 window.__ModuleLoader__ 包装，node 下不可加载；本层
// 零外部 import 纪律也禁止值级引用）。本文件把契约要点钉成可执行断言：
//   - init 每实例播种新鲜状态（create 两次互不串扰）
//   - actions 烘焙：draft 参数被剥除，调用即发布
//   - 已发布引用绝不被原地改写（draft 是克隆，旧快照保持原值）
//   - subscribe/unsubscribe 语义
// 面板/选择器 store 的语义动作表（settingsMirrored/healthReady/liveSwitchStarted
// 乐观写/disclosureUpdated 等）也在此钉一轮纯转换行为；glue 级的编排钉留在
// selector-controller.spec.ts（驱动方式改为 glue + 真 store 实例）。

import { describe, expect, it, vi } from 'vitest';
import { defineSnapshotStore } from '../../../src/client/data/stores/engine.ts';
import { createAcpPanelStore } from '../../../src/client/data/stores/panel-store.ts';
import { createModelPickerStore } from '../../../src/client/data/stores/picker-store.ts';
import { INITIAL_DIRECTORY_STATE } from '../../../src/client/data/selector-logic.ts';
import type { LiveOptionsSnapshot } from '../../../src/client/data/selector-logic.ts';

// ---------- 引擎契约 ----------

describe('defineSnapshotStore 引擎契约（ui-slots StoreHandle 结构化复刻）', () => {
  const handle = defineSnapshotStore({
    init: () => ({ count: 0, note: 'fresh' }),
    actions: {
      bumped(draft: { count: number; note: string }, by: number): void {
        draft.count += by;
      },
      noted(draft: { count: number; note: string }, note: string): void {
        draft.note = note;
      },
    },
  });

  it('create 播种新鲜状态；两个实例互不串扰', () => {
    const a = handle.create();
    const b = handle.create();
    a.actions.bumped(2);
    expect(a.getSnapshot()).toEqual({ count: 2, note: 'fresh' });
    expect(b.getSnapshot()).toEqual({ count: 0, note: 'fresh' });
  });

  it('actions 烘焙剥除 draft；已发布引用不被原地改写', () => {
    const inst = handle.create();
    const before = inst.getSnapshot();
    inst.actions.bumped(3);
    const after = inst.getSnapshot();
    expect(before.count).toBe(0);
    expect(after.count).toBe(3);
    expect(after).not.toBe(before);
  });

  it('subscribe 在每次 action 后同步收到通知；unsubscribe 后静默', () => {
    const inst = handle.create();
    const listener = vi.fn();
    const unsub = inst.subscribe(listener);
    inst.actions.noted('x');
    inst.actions.bumped(1);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    inst.actions.bumped(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clearPersisted 是无操作（本引擎无 persist 轴）', () => {
    const inst = handle.create();
    expect(() => { inst.clearPersisted(); }).not.toThrow();
    expect(inst.getSnapshot()).toEqual({ count: 0, note: 'fresh' });
  });
});

// ---------- 面板 store ----------

describe('createAcpPanelStore（settings.section 独占工厂）', () => {
  it('init 播种 loading 投影；attach 前 glue 未写入时面板读中性态', () => {
    const inst = createAcpPanelStore().create();
    const snap = inst.getSnapshot();
    expect(snap.settings.status).toBe('loading');
    expect(snap.health.status).toBe('idle');
  });

  it('语义动作表：settingsMirrored / health 生命周期', () => {
    const inst = createAcpPanelStore().create();
    const { actions } = inst;
    actions.settingsMirrored({ status: 'ready', writable: true, agents: {}, revision: 3 });
    expect(inst.getSnapshot().settings).toEqual({ status: 'ready', writable: true, agents: {}, revision: 3 });

    actions.healthLoading();
    expect(inst.getSnapshot().health.status).toBe('loading');
    actions.healthReady([], null, 1234);
    expect(inst.getSnapshot().health).toEqual({
      status: 'ready', rows: [], sandbox: null, fetchedAt: 1234, message: undefined,
      checkingAgentIds: [], agentErrors: {},
    });
    actions.healthUnreachable('boom');
    const health = inst.getSnapshot().health;
    expect(health.status).toBe('unreachable');
    expect(health.message).toBe('boom');
    expect(health.fetchedAt).toBe(1234); // 失败保留上一份成功行
  });

  it('卡片级健康状态按 agent 隔离，并只合并对应健康行', () => {
    const inst = createAcpPanelStore().create();
    const row = (id: string, version: string) => ({
      id, name: id, command: id, args: [], loginHint: null,
      executable: true, version, state: 'saved-unverified' as const,
      probe: { status: 'never' as const, at: null },
    });
    inst.actions.healthReady([row('devin', 'old'), row('kimi', 'old')], null, 1);
    inst.actions.agentHealthLoading('devin');
    inst.actions.agentHealthLoading('kimi');
    expect(inst.getSnapshot().health.checkingAgentIds).toEqual(['devin', 'kimi']);

    inst.actions.agentHealthReady('kimi', row('kimi', 'new'), null, 2);
    expect(inst.getSnapshot().health.checkingAgentIds).toEqual(['devin']);
    expect(inst.getSnapshot().health.rows.map((entry) => [entry.id, entry.version])).toEqual([
      ['devin', 'old'], ['kimi', 'new'],
    ]);

    inst.actions.agentHealthFailed('devin', 'probe failed');
    expect(inst.getSnapshot().health.checkingAgentIds).toEqual([]);
    expect(inst.getSnapshot().health.agentErrors).toEqual({ devin: 'probe failed' });
  });

  it('resync 一次性灌入全量投影（attach 路径）', () => {
    const inst = createAcpPanelStore().create();
    inst.actions.settingsMirrored({ status: 'ready', writable: true, agents: {}, revision: 7 });
    const fresh = createAcpPanelStore().create();
    fresh.actions.resync(inst.getSnapshot());
    expect(fresh.getSnapshot()).toEqual(inst.getSnapshot());
  });
});

// ---------- 选择器复合 store ----------

const LIVE_SNAPSHOT: LiveOptionsSnapshot = {
  sessionId: 'sess-1',
  configOptions: [
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
    { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false },
  ],
  currentModeId: null,
  capabilities: null,
  continuity: { status: 'ok', cause: null, detail: null },
  contextUsage: null,
  freshness: 'live',
  editable: true,
  fingerprintChanged: false,
  modelSwitch: { status: 'idle' },
};

describe('createModelPickerStore（conversation.input.model 三 slice 复合）', () => {
  it('init 播种三 slice 中性态', () => {
    const inst = createModelPickerStore().create();
    const snap = inst.getSnapshot();
    expect(snap.directory).toEqual(INITIAL_DIRECTORY_STATE);
    expect(snap.live.status).toBe('idle');
    expect(snap.disclosure).toEqual({ provider: '', preset: undefined });
  });

  it('目录 slice：load → loaded → selectStarted/selected → reset', () => {
    const inst = createModelPickerStore().create();
    const { actions } = inst;
    const view = {
      current: { provider: 'acp-dev', model: 'm1' },
      routable: true,
      groups: [{ id: 'acp-dev', name: 'Dev', models: [{ id: 'm1', name: 'M1' }] }],
      failures: [],
    };
    actions.directoryLoadStarted();
    expect(inst.getSnapshot().directory.status).toBe('loading');
    actions.directoryLoaded(view);
    expect(inst.getSnapshot().directory.current).toEqual({ provider: 'acp-dev', model: 'm1' });
    actions.directorySelectStarted();
    expect(inst.getSnapshot().directory.status).toBe('selecting');
    actions.directorySelected({ provider: 'acp-dev', model: 'm2' });
    expect(inst.getSnapshot().directory.status).toBe('ready');
    expect(inst.getSnapshot().directory.current?.model).toBe('m2');
    actions.directorySelectFailed('refused');
    expect(inst.getSnapshot().directory.error).toBe('refused');
    actions.directoryReset();
    expect(inst.getSnapshot().directory).toEqual(INITIAL_DIRECTORY_STATE);
  });

  it('活体 slice：乐观切换（withLiveOptionValue）→ 响应采纳 / 失败回滚', () => {
    const inst = createModelPickerStore().create();
    const { actions } = inst;
    actions.liveLoaded(LIVE_SNAPSHOT);
    actions.liveSwitchStarted('model', 'm2');
    const optimistic = inst.getSnapshot().live;
    expect(optimistic.switching).toBe('model');
    expect(optimistic.snapshot?.configOptions?.[0]).toMatchObject({ currentValue: 'm2' });
    actions.liveSwitchSettled({ ...LIVE_SNAPSHOT, configOptions: [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'm2', options: [] }], });
    actions.liveSwitchFinished();
    expect(inst.getSnapshot().live.switching).toBeNull();
    expect(inst.getSnapshot().live.snapshot?.configOptions?.[0]).toMatchObject({ currentValue: 'm2' });

    // 失败路径：回滚到切换前基线并落错误
    actions.liveSwitchStarted('fast', true);
    actions.liveSwitchFailed(inst.getSnapshot().live.snapshot ?? LIVE_SNAPSHOT, 'busy');
    const failed = inst.getSnapshot().live;
    expect(failed.switching).toBeNull();
    expect(failed.error).toBe('busy');
    expect(failed.errorSource).toBe('switch');
  });

  it('活体 slice：rebind 在飞闩锁 → 响应采纳（continuity 归 ok）/ 失败落 rebind 文案位且快照不动', () => {
    const inst = createModelPickerStore().create();
    const { actions } = inst;
    const blocked: LiveOptionsSnapshot = { ...LIVE_SNAPSHOT, continuity: { status: 'blocked', cause: 'cwd-changed', detail: 'canonical cwd mismatch' } };
    actions.liveLoaded(blocked);
    actions.liveRebindStarted();
    expect(inst.getSnapshot().live.rebinding).toBe(true);
    expect(inst.getSnapshot().live.error).toBeNull();
    actions.liveRebindSettled(LIVE_SNAPSHOT);
    expect(inst.getSnapshot().live.rebinding).toBe(false);
    expect(inst.getSnapshot().live.snapshot?.continuity.status).toBe('ok');
    // 失败路径：闩锁解除、快照不动、错误落 rebind 位（UI 文案与 load/switch 三分流）
    actions.liveLoaded(blocked);
    actions.liveRebindStarted();
    actions.liveRebindFailed('only allowed while idle');
    const failed = inst.getSnapshot().live;
    expect(failed.rebinding).toBe(false);
    expect(failed.error).toBe('only allowed while idle');
    expect(failed.errorSource).toBe('rebind');
    expect(failed.snapshot).toEqual(blocked);
  });

  it('披露 slice：disclosureUpdated 如实透传 provider/preset（含 undefined 未知档）', () => {
    const inst = createModelPickerStore().create();
    inst.actions.disclosureUpdated('acp-dev', 'danger-full-access');
    expect(inst.getSnapshot().disclosure).toEqual({ provider: 'acp-dev', preset: 'danger-full-access' });
    inst.actions.disclosureUpdated('acp-dev', undefined);
    expect(inst.getSnapshot().disclosure.preset).toBeUndefined();
  });

  it('slice 互不染指：目录转换不动 live/disclosure 的值', () => {
    const inst = createModelPickerStore().create();
    inst.actions.liveLoaded(LIVE_SNAPSHOT);
    inst.actions.disclosureUpdated('acp-dev', 'read-only');
    const before = inst.getSnapshot();
    inst.actions.directoryLoadStarted();
    expect(inst.getSnapshot().live).toEqual(before.live);
    expect(inst.getSnapshot().disclosure).toEqual(before.disclosure);
  });
});
